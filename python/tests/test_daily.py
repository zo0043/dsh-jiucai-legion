"""指数日线测试：缓存增量、去重排序、baostock 交叉校验降级、不新鲜判定（需求 #42/#45/#24）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import djiucai_data.daily as daily_mod
from djiucai_data import cache
from djiucai_data.daily import get_daily_bars
from fakes import fake_calendar_df, fake_index_daily_df


def _bar(d: str, close: float) -> dict[str, Any]:
    return {"date": d, "open": close - 1, "high": close + 2, "low": close - 2, "close": close, "volume": 100.0}


@pytest.fixture
def frozen_today(monkeypatch: pytest.MonkeyPatch) -> str:
    """冻结「今天」= 2026-11-06（Asia/Shanghai 业务日），使 stale 判定可测。"""
    import djiucai_data.calendar as cal_mod

    monkeypatch.setattr(cal_mod, "today_sh", lambda: "2026-11-06")
    return "2026-11-06"


def _stub_cross_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(daily_mod, "_cross_check_with_baostock", lambda index, bar: None)


class TestFetchAndCache:
    def test_first_fetch_returns_bars_and_writes_cache(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        bars = [_bar("2026-11-03", 3300.0), _bar("2026-11-04", 3310.0), _bar("2026-11-05", 3320.0)]
        monkeypatch.setattr(
            fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars)
        )
        monkeypatch.setattr(
            fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df(["2026-11-05", frozen_today])
        )
        _stub_cross_check(monkeypatch)

        result = get_daily_bars("SH000001", days=250)
        assert [b["date"] for b in result["bars"]] == ["2026-11-03", "2026-11-04", "2026-11-05"]
        assert result["stale"] is True  # 最新 bar(11-05) < 最近交易日(11-06)
        assert result["asOf"] == "2026-11-05"
        cached = cache.load_cache("daily", "SH000001")
        assert cached is not None and len(cached["bars"]) == 3

    def test_incremental_merge_dedup_and_sort(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        # 第一跑：写入 11-03 ~ 11-05
        first = [_bar("2026-11-03", 3300.0), _bar("2026-11-04", 3310.0), _bar("2026-11-05", 3320.0)]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(first))
        monkeypatch.setattr(
            fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today])
        )
        _stub_cross_check(monkeypatch)
        get_daily_bars("SH000001")

        # 第二跑：11-04 修正收盘价（同日期新值覆盖）、新增 11-06
        second = [
            _bar("2026-11-04", 9999.0),  # 与缓存同日，新值应胜
            _bar("2026-11-05", 3320.0),
            _bar("2026-11-06", 3330.0),
        ]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(second))
        result = get_daily_bars("SH000001")
        dates = [b["date"] for b in result["bars"]]
        assert dates == ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"]  # 去重、升序
        by_date = {b["date"]: b for b in result["bars"]}
        assert by_date["2026-11-04"]["close"] == 9999.0  # 新值覆盖
        assert by_date["2026-11-03"]["close"] == 3300.0  # 缓存条目保留（全量追加 #42）

    def test_days_returns_last_n(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        bars = [_bar(f"2026-11-0{i}", 3300.0 + i) for i in range(1, 6)]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars))
        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today]))
        _stub_cross_check(monkeypatch)
        result = get_daily_bars("SH000001", days=2)
        assert [b["date"] for b in result["bars"]] == ["2026-11-04", "2026-11-05"]

    def test_unknown_index_raises(self) -> None:
        with pytest.raises(ValueError, match="未知指数"):
            get_daily_bars("SZ399001")


class TestStale:
    def test_fresh_when_bar_equals_recent_trade_date(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        bars = [_bar("2026-11-06", 3330.0)]  # 今日 bar 已出 → 不算旧
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars))
        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today]))
        _stub_cross_check(monkeypatch)
        assert get_daily_bars("SH000001")["stale"] is False

    def test_stale_none_when_calendar_unavailable(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        bars = [_bar("2026-11-05", 3320.0)]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars))

        def boom() -> Any:
            raise ConnectionError("日历也挂")

        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", boom)
        _stub_cross_check(monkeypatch)
        result = get_daily_bars("SH000001")
        assert result["stale"] is None  # 无法判定 → None（TS 侧自行决定）
        assert any("新鲜度" in d["note"] for d in result["degraded"])


class TestFallback:
    def test_akshare_failure_falls_back_to_cache(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        cache.save_cache(
            "daily", "SH000001", {"bars": [_bar("2026-11-05", 3320.0)], "asOf": "2026-11-05"}
        )
        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today]))
        _stub_cross_check(monkeypatch)

        def boom(symbol: str) -> Any:
            raise ConnectionError("新浪封 IP")

        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", boom)
        result = get_daily_bars("SH000001")
        assert len(result["bars"]) == 1
        assert any("回退本地缓存" in d["note"] for d in result["degraded"])

    def test_akshare_failure_without_cache_raises(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path
    ) -> None:
        """行情主源失败且无缓存 → 抛异常（行情属硬失败类，#24）。"""

        def boom(symbol: str) -> Any:
            raise ConnectionError("彻底失败")

        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", boom)
        with pytest.raises(ConnectionError):
            get_daily_bars("SH000001")


class TestBaostockCrossCheck:
    """真实 _cross_check_with_baostock 逻辑（monkeypatch baostock 模块函数）。"""

    @staticmethod
    def _patch_baostock(monkeypatch: pytest.MonkeyPatch, row: list[str]) -> None:
        import baostock

        class FakeRS:
            error_code = "0"

            def __init__(self) -> None:
                self._used = False

            def next(self) -> bool:
                if self._used:
                    return False
                self._used = True
                return True

            def get_row_data(self) -> list[str]:
                return row

        class FakeLoginResult:
            error_code = "0"

        monkeypatch.setattr(baostock, "login", lambda: FakeLoginResult())
        monkeypatch.setattr(
            baostock,
            "query_history_k_data_plus",
            lambda code, fields, start_date=None, end_date=None, frequency="d", adjustflag="3": FakeRS(),
        )
        monkeypatch.setattr(baostock, "logout", lambda: None)

    def test_deviation_over_threshold_marks_degraded(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        bars = [_bar("2026-11-05", 3320.0)]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars))
        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today]))
        # baostock 返回 close=3200（akshare=3320 → 偏差 3.6% > 0.1%）
        self._patch_baostock(monkeypatch, ["2026-11-05", "3319.0", "3322.0", "3318.0", "3200.0", "100"])

        result = get_daily_bars("SH000001")
        flags = [d for d in result["degraded"] if d["source"] == "baostock:cross_check"]
        assert flags and "偏差" in flags[0]["note"]
        # 数据仍以 akshare 为准（#42）
        assert result["bars"][-1]["close"] == 3320.0

    def test_small_deviation_passes(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        bars = [_bar("2026-11-05", 3320.0)]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars))
        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today]))
        # 偏差 0.03% < 0.1% 阈值
        self._patch_baostock(monkeypatch, ["2026-11-05", "3319.0", "3322.0", "3318.0", "3321.0", "100"])

        result = get_daily_bars("SH000001")
        assert not [d for d in result["degraded"] if d["source"] == "baostock:cross_check"]

    def test_baostock_failure_is_degraded_not_fatal(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path, frozen_today: str
    ) -> None:
        import baostock

        bars = [_bar("2026-11-05", 3320.0)]
        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", lambda symbol: fake_index_daily_df(bars))
        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df([frozen_today]))

        def login_boom() -> Any:
            raise ConnectionError("baostock 服务器无响应")

        monkeypatch.setattr(baostock, "login", login_boom)
        result = get_daily_bars("SH000001")
        flags = [d for d in result["degraded"] if d["source"] == "baostock:cross_check"]
        assert flags and "失败" in flags[0]["note"]
        assert result["bars"][-1]["close"] == 3320.0  # 数据仍以 akshare 为准


class TestNormalizeNonFinite:
    """NaN/Inf 防护（F33）：非有限值行剔除，不进协议与缓存。"""

    def test_non_finite_rows_dropped(self) -> None:
        import math

        import pandas as pd

        from djiucai_data.daily import _normalize_bars

        df = pd.DataFrame(
            [
                {"date": "2026-11-03", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0},
                {"date": "2026-11-04", "open": float("nan"), "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0},
                {"date": "2026-11-05", "open": 1.0, "high": 2.0, "low": 0.5, "close": float("inf"), "volume": 10.0},
            ]
        )
        bars = _normalize_bars(df)
        assert [b["date"] for b in bars] == ["2026-11-03"]
        assert all(math.isfinite(v) for b in bars for k, v in b.items() if k != "date")
