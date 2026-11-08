"""缓存读写与重试装饰器测试（需求 #25 重试+版本告警、#42 缓存全量保留）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from djiucai_data import cache, retry


class TestCache:
    def test_save_and_load_round_trip(self, isolated_cache: Path) -> None:
        cache.save_cache("daily", "SH000001", {"bars": [{"date": "2026-11-05"}]})
        assert cache.load_cache("daily", "SH000001") == {"bars": [{"date": "2026-11-05"}]}
        path = isolated_cache / "cache" / "daily" / "SH000001.json"
        assert path.exists()
        data = json.loads(path.read_text(encoding="utf-8"))
        assert data["bars"][0]["date"] == "2026-11-05"

    def test_load_missing_returns_none(self, isolated_cache: Path) -> None:
        assert cache.load_cache("daily", "NOPE") is None

    def test_load_corrupted_returns_none(self, isolated_cache: Path) -> None:
        path = cache.cache_path("daily", "BAD")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken json", encoding="utf-8")
        assert cache.load_cache("daily", "BAD") is None

    def test_key_is_sanitized(self, isolated_cache: Path) -> None:
        """key 带路径分隔符时不应逃出 op 目录。"""
        p = cache.cache_path("daily", "../../evil")
        assert p.parent == (isolated_cache / "cache" / "daily")
        assert "/" not in p.name.replace(".json", "").replace("\\", "")

    def test_overwrite_is_full_replacement(self, isolated_cache: Path) -> None:
        """全量覆盖写入（#42：全量保留指不清理历史数据，而非增量写盘）。"""
        cache.save_cache("op", "k", {"a": 1})
        cache.save_cache("op", "k", {"a": 1, "b": 2})
        assert cache.load_cache("op", "k") == {"a": 1, "b": 2}


class TestRetry:
    def test_succeeds_after_transient_failures(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        @retry.with_retry(times=2, backoff=0.5)
        def flaky() -> str:
            calls["n"] += 1
            if calls["n"] < 3:
                raise OSError("暂时失败")
            return "ok"

        assert flaky() == "ok"
        assert calls["n"] == 3  # 首次 + 重试 2 次（需求 #25）

    def test_raises_after_exhausted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        calls = {"n": 0}

        @retry.with_retry(times=2, backoff=0.5)
        def always_fails() -> None:
            calls["n"] += 1
            raise ValueError("彻底失败")

        with pytest.raises(ValueError, match="彻底失败"):
            always_fails()
        assert calls["n"] == 3

    def test_backoff_is_exponential(self, monkeypatch: pytest.MonkeyPatch) -> None:
        sleeps: list[float] = []
        monkeypatch.setattr(retry, "_sleep", sleeps.append)

        @retry.with_retry(times=2, backoff=0.5)
        def fails() -> None:
            raise RuntimeError("x")

        with pytest.raises(RuntimeError):
            fails()
        assert sleeps == [0.5, 1.0]  # 指数退避 0.5s / 1s（需求 #25）

    def test_eastmoney_failure_logs_version_alert(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """东财系失败额外记录版本告警日志（含 akshare 版本，需求 #25）。"""

        @retry.with_retry(times=0, backoff=0.1, eastmoney=True)
        def em_call() -> None:
            raise ConnectionError("东财改版了")

        with pytest.raises(ConnectionError):
            em_call()
        err = capsys.readouterr().err
        assert "版本告警" in err
        assert "em_call" in err
        assert "akshare=" in err

    def test_non_eastmoney_no_version_alert(
        self, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
    ) -> None:

        @retry.with_retry(times=0, backoff=0.1, eastmoney=False)
        def sina_call() -> None:
            raise ConnectionError("新浪挂了")

        with pytest.raises(ConnectionError):
            sina_call()
        err = capsys.readouterr().err
        assert "版本告警" not in err


class TestCacheNonFinite:
    """含非有限值的载荷不入缓存（allow_nan=False，F33）：不崩溃、不留半截文件。"""

    def test_nan_payload_rejected_without_poisoning(self, isolated_cache: Path, capsys: pytest.CaptureFixture[str]) -> None:
        cache.save_cache("daily", "SH000001", {"bars": [{"date": "2026-11-05", "close": float("nan")}]})
        assert cache.load_cache("daily", "SH000001") is None  # 未写入
        path = isolated_cache / "cache" / "daily" / "SH000001.json"
        assert not path.exists()
        leftovers = [p for p in path.parent.glob("*.tmp")] if path.parent.exists() else []
        assert leftovers == []  # 临时文件已清理
        assert "缓存写入失败" in capsys.readouterr().err

    def test_finite_payload_still_saves(self, isolated_cache: Path) -> None:
        cache.save_cache("daily", "CSI300", {"bars": [{"date": "2026-11-05", "close": 1.5}]})
        assert cache.load_cache("daily", "CSI300") is not None
