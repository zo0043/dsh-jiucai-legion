"""资金面测试（需求 #47：两融 T+1 最近可得 + asOf；北向盘后口径；失败 → null + 标注）。"""

from __future__ import annotations

from typing import Any

import pytest

from djiucai_data.funds import get_funds, get_margin_balance, get_northbound
from fakes import fake_hsgt_df, fake_margin_df


class TestMargin:
    def test_takes_latest_available_row(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        """两融 T+1 披露 → 取查询窗口内最近可得一条（需求 #47）。"""
        rows = [
            ("2026-11-03", 10000.0),
            ("2026-11-04", 10100.0),
            ("2026-11-05", 10200.0),  # 最近可得
        ]
        seen: dict[str, str] = {}

        def fake_margin(start_date: str, end_date: str) -> Any:
            seen["range"] = f"{start_date}-{end_date}"
            return fake_margin_df(rows)

        monkeypatch.setattr(fake_ak_module, "stock_margin_sse", fake_margin)
        # 冻结「今天」（end_date=今天 的断言依赖它；与 test_daily.py 的 frozen_today 同理，
        # 否则该用例在 2026-11-07 之后永久失败）
        import djiucai_data.funds as funds_mod

        monkeypatch.setattr(funds_mod, "today_sh", lambda: "2026-11-06")
        result = get_margin_balance()
        assert result["marginBalance"] == 10200.0
        assert result["asOf"] == "2026-11-05"  # asOf 标注实际交易日
        assert result["degraded"] == []
        assert seen["range"].endswith("20261106")  # end_date = 今天

    def test_failure_returns_null_with_degraded(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        def boom(start_date: str, end_date: str) -> Any:
            raise ConnectionError("上交所接口挂了")

        monkeypatch.setattr(fake_ak_module, "stock_margin_sse", boom)
        result = get_margin_balance()
        assert result["marginBalance"] is None
        assert result["asOf"] is None
        assert any("stock_margin_sse" in d["source"] for d in result["degraded"])


class TestNorthbound:
    def test_sh_index_uses_hugutong_only(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """上证 → 只取沪股通（需求 #47 口径）。"""
        rows = [
            ("2026-11-05", "沪股通", 50.0, 55.0),
            ("2026-11-05", "深股通", 70.0, 75.0),
            ("2026-11-05", "港股通（沪）", -30.0, -30.0),
        ]
        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", lambda: fake_hsgt_df(rows))
        result = get_northbound("SH000001")
        assert result["northboundNet"] == 50.0
        assert result["asOf"] == "2026-11-05"

    def test_csi300_sums_sh_and_sz(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """沪深300 → 沪股通+深股通合计（需求 #47）。"""
        rows = [
            ("2026-11-05", "沪股通", 50.0, 55.0),
            ("2026-11-05", "深股通", 70.0, 75.0),
        ]
        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", lambda: fake_hsgt_df(rows))
        result = get_northbound("CSI300")
        assert result["northboundNet"] == 120.0

    def test_prefers_net_buy_over_net_inflow(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """成交净买额优先，缺失（NaN）时回退资金净流入。"""
        rows = [
            ("2026-11-05", "沪股通", float("nan"), 42.0),
            ("2026-11-05", "深股通", 10.0, 12.0),
        ]
        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", lambda: fake_hsgt_df(rows))
        result = get_northbound("CSI300")
        assert result["northboundNet"] == 52.0  # NaN 回退 42.0 + 10.0

    def test_failure_returns_null_with_degraded(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        def boom() -> Any:
            raise ConnectionError("东财沪深港通接口挂了")

        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", boom)
        result = get_northbound("SH000001")
        assert result["northboundNet"] is None
        assert any("stock_hsgt_fund_flow_summary_em" in d["source"] for d in result["degraded"])

    def test_zero_placeholder_treated_as_undisclosed(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """上游 2024-08 起停止披露北向净买额，接口返回 0 占位（2026-11-06 实测）
        → 置 null 并标注，而不是误报「净流入为零」（需求 #47）。"""
        rows = [
            ("2026-11-05", "沪股通", 0.0, 0.0),
            ("2026-11-05", "深股通", 0.0, 0.0),
            ("2026-11-05", "港股通(沪)", -133.39, 420.0),  # 南向有真实值，不应影响北向判定
        ]
        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", lambda: fake_hsgt_df(rows))
        result = get_northbound("SH000001")
        assert result["northboundNet"] is None
        assert result["asOf"] == "2026-11-05"
        assert any("停止披露" in d["note"] for d in result["degraded"])

    def test_real_zero_with_nonzero_other_column_still_reported(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """仅成交净买额为 0 但资金净流入非 0 → 视为真实披露值，照常返回。"""
        rows = [("2026-11-05", "沪股通", 0.0, 55.0)]
        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", lambda: fake_hsgt_df(rows))
        result = get_northbound("SH000001")
        assert result["northboundNet"] == 0.0
        assert result["degraded"] == []

    def test_unknown_index_raises(self) -> None:
        with pytest.raises(ValueError, match="未知指数"):
            get_northbound("SZ399001")


class TestFundsAggregate:
    def test_aggregates_both_and_picks_newest_asof(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        monkeypatch.setattr(fake_ak_module, "stock_margin_sse", lambda start_date, end_date: fake_margin_df(
            [("2026-11-05", 10200.0)]
        ))
        # 港股通行：get_funds 同一次响应同时解析南向（v1.4 #59，零重复出网）
        monkeypatch.setattr(
            fake_ak_module,
            "stock_hsgt_fund_flow_summary_em",
            lambda: fake_hsgt_df([("2026-11-04", "沪股通", 50.0, 55.0), ("2026-11-04", "港股通(沪)", 30.0, 420.0)]),
        )
        result = get_funds("SH000001")
        assert result["marginBalance"] == 10200.0
        assert result["northboundNet"] == 50.0
        assert result["southboundNetYi"] == 30.0  # 南向（#59 资金分流 signals，不作北向代理）
        assert result["southboundAsOf"] == "2026-11-04"
        assert result["asOf"] == "2026-11-05"  # 取较新者
        assert result["marginAsOf"] == "2026-11-05"  # 数据流分析修复：按字段标注各自交易日
        assert result["northAsOf"] == "2026-11-04"
        assert result["degraded"] == []

    def test_partial_failure_keeps_other_field(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """北向失败 → northboundNet null，两融照常（#24 部分降级）。"""
        monkeypatch.setattr(
            fake_ak_module, "stock_margin_sse", lambda start_date, end_date: fake_margin_df([("2026-11-05", 1.0)])
        )

        def boom() -> Any:
            raise ConnectionError("北向挂")

        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", boom)
        result = get_funds("SH000001")
        assert result["marginBalance"] == 1.0
        assert result["northboundNet"] is None
        # v1.4 #59：summary_em 失败 → 北向/南向各自一条降级标注（共用同一失败源）
        assert len(result["degraded"]) == 2
        assert result["southboundNetYi"] is None
        # asOf 退化为可用一方的 asOf（字符串日期，非当前时刻）
        assert result["asOf"] == "2026-11-05"
