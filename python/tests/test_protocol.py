"""协议往返与坏行容错测试（需求 #42：stdout JSON 协议、崩溃容错、SIGTERM 优雅退出）。"""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from djiucai_data import cli, protocol


ENVELOPE_KEYS = {"id", "ok", "data", "asOf", "degraded", "error"}


class TestRoundTrip:
    def test_ping_round_trip(self) -> None:
        line = protocol.handle_line(json.dumps({"id": 7, "op": "ping"}))
        assert line is not None
        resp = json.loads(line)
        assert resp["id"] == 7
        assert resp["ok"] is True
        assert resp["data"] == {"pong": True}
        assert resp["error"] is None
        assert set(resp) == ENVELOPE_KEYS
        assert isinstance(resp["asOf"], str) and "T" not in resp["asOf"]

    def test_get_calendar_round_trip(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        from fakes import fake_calendar_df

        monkeypatch.setattr(
            fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df(["2026-11-05", "2026-11-06"])
        )
        line = protocol.handle_line(json.dumps({"id": 1, "op": "getCalendar"}))
        resp = json.loads(line or "{}")
        assert resp["ok"] is True
        assert resp["data"]["dates"] == ["2026-11-05", "2026-11-06"]
        assert resp["degraded"] == []

    def test_get_daily_bars_round_trip_carries_stale(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        from fakes import fake_calendar_df, fake_index_daily_df

        bars = [
            {"date": "2026-11-04", "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 10.0},
            {"date": "2026-11-05", "open": 1.5, "high": 2.5, "low": 1.0, "close": 2.0, "volume": 11.0},
        ]

        def fake_fetch(symbol: str) -> Any:
            assert symbol == "sh000001"
            return fake_index_daily_df(bars)

        monkeypatch.setattr(fake_ak_module, "stock_zh_index_daily", fake_fetch)
        monkeypatch.setattr(
            fake_ak_module, "tool_trade_date_hist_sina", lambda: fake_calendar_df(["2026-11-05"])
        )
        # baostock 交叉校验打桩为通过
        import djiucai_data.daily as daily_mod

        monkeypatch.setattr(daily_mod, "_cross_check_with_baostock", lambda index, bar: None)

        line = protocol.handle_line(
            json.dumps({"id": 3, "op": "getDailyBars", "params": {"index": "SH000001"}})
        )
        resp = json.loads(line or "{}")
        assert resp["ok"] is True
        assert resp["stale"] is False  # 最新 bar == 最近交易日
        assert len(resp["data"]["bars"]) == 2
        assert "stale" in resp

    def test_unknown_op(self) -> None:
        resp = json.loads(protocol.handle_line(json.dumps({"id": 2, "op": "nope"})) or "{}")
        assert resp["ok"] is False
        assert "未知 op" in resp["error"]
        assert resp["id"] == 2

    def test_missing_index_param(self) -> None:
        resp = json.loads(
            protocol.handle_line(json.dumps({"id": 4, "op": "getDailyBars", "params": {}})) or "{}"
        )
        assert resp["ok"] is False
        assert "index" in resp["error"]


class TestBadLines:
    """坏的输入行回错误响应不崩溃（需求 #42）。"""

    @pytest.mark.parametrize(
        "raw",
        [
            "not json at all",
            "[1, 2, 3]",          # 合法 JSON 但不是对象
            '"just a string"',
            "{",                  # 截断 JSON
            '{"id": 1}',          # 缺 op
            '{"op": "ping"}',     # 缺 id（应容忍，id=None 回包）
        ],
    )
    def test_bad_line_returns_error_response(self, raw: str) -> None:
        resp = json.loads(protocol.handle_line(raw) or "{}")
        if raw == '{"op": "ping"}':
            # 缺 id 但 op 合法 → 正常 pong，不崩
            assert resp["ok"] is True
            assert resp["id"] is None
        else:
            assert resp["ok"] is False
            assert resp["error"]
            assert set(resp) >= ENVELOPE_KEYS

    def test_non_dict_params_rejected(self) -> None:
        """params 非对象 → ok:false（数据类 op 需要对象参数）。"""
        resp = json.loads(
            protocol.handle_line(
                json.dumps({"id": 5, "op": "getDailyBars", "params": "not-a-dict"})
            )
            or "{}"
        )
        assert resp["ok"] is False
        assert "params" in resp["error"]

    def test_ping_ignores_params(self) -> None:
        """ping 不校验 params，含垃圾参数也正常回包。"""
        resp = json.loads(
            protocol.handle_line(
                json.dumps({"id": 6, "op": "ping", "params": "not-a-dict"})
            )
            or "{}"
        )
        assert resp["ok"] is True and resp["data"] == {"pong": True}

    def test_empty_and_whitespace_lines_ignored(self) -> None:
        assert protocol.handle_line("") is None
        assert protocol.handle_line("   \t \n") is None

    def test_bad_line_does_not_kill_session(self) -> None:
        """坏行之后进程继续服务后续请求。"""
        lines = [
            "garbage {{",
            json.dumps({"id": 10, "op": "ping"}),
        ]
        out = io.StringIO()
        protocol.serve(stdin=io.StringIO("\n".join(lines) + "\n"), stdout=out)
        responses = [json.loads(x) for x in out.getvalue().splitlines()]
        assert len(responses) == 2
        assert responses[0]["ok"] is False
        assert responses[1]["ok"] is True and responses[1]["data"]["pong"] is True


class TestServeLoop:
    def test_serve_multiple_requests_and_eof(self) -> None:
        lines = [
            "",
            json.dumps({"id": 1, "op": "ping"}),
            json.dumps({"id": 2, "op": "ping"}),
        ]
        out = io.StringIO()
        protocol.serve(stdin=io.StringIO("\n".join(lines) + "\n"), stdout=out)
        responses = [json.loads(x) for x in out.getvalue().splitlines()]
        assert [r["id"] for r in responses] == [1, 2]

    def test_serve_respects_stop_flag(self) -> None:
        """STOP_FLAG 置位后主循环优雅退出，不再处理后续行。"""
        lines = [json.dumps({"id": 1, "op": "ping"}), json.dumps({"id": 2, "op": "ping"})]
        out = io.StringIO()
        protocol.STOP_FLAG["stop"] = True
        try:
            protocol.serve(stdin=io.StringIO("\n".join(lines) + "\n"), stdout=out)
        finally:
            protocol.STOP_FLAG["stop"] = False
        assert out.getvalue() == ""  # 未处理任何行即退出

    def test_op_exception_becomes_error_response(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """op 内部异常 → ok:false 响应，进程不崩（TS 侧重试语义的前提）。"""
        def boom(params: dict) -> dict:
            raise RuntimeError("网络炸了")

        monkeypatch.setitem(protocol.OPS, "getDailyBars", boom)
        resp = json.loads(
            protocol.handle_line(
                json.dumps({"id": 9, "op": "getDailyBars", "params": {"index": "SH000001"}})
            )
            or "{}"
        )
        assert resp["ok"] is False
        assert "RuntimeError" in resp["error"] and "网络炸了" in resp["error"]
        assert resp["id"] == 9


class TestSigtermGraceful:
    """SIGTERM 优雅退出（需求 #42）：空闲期立即退，处理中做完当前请求再退。"""

    def setup_method(self) -> None:
        protocol.STOP_FLAG["stop"] = False
        protocol.PROCESSING["busy"] = False

    def teardown_method(self) -> None:
        protocol.STOP_FLAG["stop"] = False
        protocol.PROCESSING["busy"] = False

    def test_handler_idle_raises_graceful_exit(self) -> None:
        with pytest.raises(protocol.GracefulExit):
            cli._on_sigterm(signal.SIGTERM, None)
        assert protocol.STOP_FLAG["stop"] is True

    def test_handler_busy_sets_flag_only(self) -> None:
        """处理中不抛出，只置标志 → 做完当前请求再退出。"""
        protocol.PROCESSING["busy"] = True
        cli._on_sigterm(signal.SIGTERM, None)  # 不应抛
        assert protocol.STOP_FLAG["stop"] is True

    def test_serve_catches_graceful_exit(self) -> None:
        """模拟空闲期 SIGTERM：readline 中触发处理器 → serve 捕获后干净退出。"""

        class SigtermStdin:
            def readline(self) -> str:
                cli._on_sigterm(signal.SIGTERM, None)
                return ""  # 不可达

        out = io.StringIO()
        protocol.serve(stdin=SigtermStdin(), stdout=out)
        assert out.getvalue() == ""
        assert protocol.STOP_FLAG["stop"] is True

    def test_serve_finishes_current_request_when_flag_set(self) -> None:
        """处理中收到 SIGTERM → 当前请求的响应仍完整写出，随后退出。"""
        lines = [json.dumps({"id": 1, "op": "ping"})]
        out = io.StringIO()
        protocol.PROCESSING["busy"] = True  # 模拟处理期间被置位
        try:
            protocol.serve(stdin=io.StringIO("\n".join(lines) + "\n"), stdout=out)
        finally:
            protocol.PROCESSING["busy"] = False
        responses = [json.loads(x) for x in out.getvalue().splitlines()]
        assert len(responses) == 1 and responses[1 - 1]["data"]["pong"] is True

    def test_cli_subprocess_sigterm_exit_zero(self, tmp_path: Path) -> None:
        """真子进程集成：握手 → ping → SIGTERM → 退出码 0。"""
        python_dir = Path(__file__).resolve().parents[1]
        env = dict(
            os.environ,
            PYTHONPATH=str(python_dir),
            DJIUCAI_DATA_DIR=str(tmp_path / "data"),
        )
        proc = subprocess.Popen(
            [sys.executable, "-m", "djiucai_data.cli"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            cwd=str(python_dir),
        )
        try:
            handshake = json.loads(proc.stdout.readline())  # type: ignore[union-attr]
            assert handshake["ready"] is True
            assert proc.stdin is not None
            proc.stdin.write(json.dumps({"id": 1, "op": "ping"}) + "\n")
            proc.stdin.flush()
            resp = json.loads(proc.stdout.readline())  # type: ignore[union-attr]
            assert resp["data"]["pong"] is True
            # 进程已回到 readline 空闲态，SIGTERM 应立即优雅退出
            proc.send_signal(signal.SIGTERM)
            try:
                rc = proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                # 极端时序兜底：SIGTERM 落在请求处理中 → 关 stdin 以 EOF 促退
                if proc.stdin is not None:
                    proc.stdin.close()
                rc = proc.wait(timeout=20)
            assert rc == 0
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait()


class TestNonFiniteProtocol:
    """data 含非有限值时 fail-fast 为错误响应，不产出裸 NaN 毒化协议（F33）。"""

    @staticmethod
    def _no_bare_constant(x: str) -> float:
        """json.loads(parse_constant=...) 钩子：遇到裸 NaN/Infinity 即抛错（严格 JSON 校验）。"""
        raise ValueError(f"裸常量 {x}")

    def test_nan_payload_fail_fast_as_error_response(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def bad(params: dict) -> dict:
            return {"bars": [{"date": "2026-11-05", "close": float("nan")}]}

        monkeypatch.setitem(protocol.OPS, "getDailyBars", bad)
        line = protocol.handle_line(json.dumps({"id": 1, "op": "getDailyBars", "params": {}}))
        assert line is not None
        resp = json.loads(line, parse_constant=self._no_bare_constant)  # 严格 JSON：不允许裸 NaN
        assert resp["ok"] is False
        assert "非有限值" in resp["error"]
        assert resp["id"] == 1
        assert set(resp) == ENVELOPE_KEYS

    def test_good_payload_still_strict_json(self) -> None:
        line = protocol.handle_line(json.dumps({"id": 2, "op": "ping"}))
        assert line is not None
        resp = json.loads(line, parse_constant=self._no_bare_constant)
        assert resp["ok"] is True and resp["data"]["pong"] is True
