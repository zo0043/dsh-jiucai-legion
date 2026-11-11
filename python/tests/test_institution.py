"""机构决策层五路径测试（v1.4 #58–#63）：CSV fixture 零网络，确定性断言。

覆盖（验收样例）：
- A 股股票型过滤与跨境排除正反例（563210 计入 / 513100、510900 排除进 crossBorderYi；
  名称含「港股通」「恒生（无 A股）」排除；债券/货币/其他只进分桶 signals）；
- 沪两融 元→亿（2.26e12→2.27e12 → +100.0 亿）；深汇总 亿元原值（30 → +30 亿不 ×1e8）；
- 新浪龙虎榜 万元→亿（5000 万 → +0.5 亿）；大宗「机构专用」元→亿（2301 万 → +0.2301 亿）；
- M4 五个子信号 netFlowYi 恒 null + 报告期滞后标注；
- M5 北向恒 null + 2024-08 停披露标注 + 南向零共享引用；institution 不调 summary_em；
- 全源抛异常 → 五路径 null、degraded 各含 note、函数不抛出。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

import pandas as pd
import pytest

import djiucai_data.institution as inst_mod
from djiucai_data.funds import get_funds
from djiucai_data.institution import (
    get_event_seat_path,
    get_etf_path,
    get_institution,
    get_margin_path,
    get_northbound_path,
    get_quarterly_path,
    get_stock_holder_announce,
    is_cross_border_etf,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "institution"

#: 冻结的业务日（与 fixture 日期对齐；2026-11-12 盘前 → 两融/ETF T+1 见 11-11）
TODAY = "2026-11-12"
TRADE_DATES = ["2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12"]


def load_csv(name: str, **kw: Any) -> pd.DataFrame:
    """读取 fixture CSV（列名与 akshare 1.20.34 真实返回一致）。"""
    return pd.read_csv(FIXTURES / name, **kw)


def boom(*args: Any, **kwargs: Any) -> Any:
    raise ConnectionError("真实网络不可用（测试桩）")


def patch_ak(
    monkeypatch: pytest.MonkeyPatch,
    overrides: dict[str, Callable[..., Any] | Exception],
) -> dict[str, int]:
    """把 institution/funds 用到的 akshare 接口按 overrides 打桩，返回调用计数器。

    值为 Exception 实例 → 每次调用抛出；值为可调用对象 → 透传返回。
    """
    import akshare

    counters = {name: 0 for name in overrides}

    def wrap(name: str, target: Any) -> Callable[..., Any]:
        def inner(*args: Any, **kwargs: Any) -> Any:
            counters[name] += 1
            if isinstance(target, Exception):
                raise target
            return target(*args, **kwargs)

        return inner

    for name, target in overrides.items():
        monkeypatch.setattr(akshare, name, wrap(name, target), raising=False)
    return counters


def patch_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """冻结业务日 + 交易日历（其余源由各用例自行打桩）。"""
    monkeypatch.setattr(inst_mod, "today_sh", lambda: TODAY)
    cal = pd.DataFrame({"trade_date": pd.to_datetime(TRADE_DATES).date})
    patch_ak(monkeypatch, {"tool_trade_date_hist_sina": lambda: cal})


# ---------------------------------------------------------------------------
# 跨境判定与分桶（宪法 #58 定死规则的正反例）
# ---------------------------------------------------------------------------


class TestCrossBorder:
    @pytest.mark.parametrize(
        "code,name,expected",
        [
            ("513100", "国泰纳斯达克100(QDII-ETF)", True),      # 513 段
            ("510900", "易方达恒生国企(QDII-ETF)", True),       # QDII 关键词（且恒生无 A股）
            ("517980", "华泰柏瑞中证港股通红利ETF", True),      # 港股通关键词（非 513 段）
            ("510638", "南方恒生ETF", True),                    # 恒生且名称不含 A股
            ("563210", "富国恒生A股专精特新企业ETF", False),    # 恒生 + A股 → 豁免
            ("510300", "华泰柏瑞沪深300ETF", False),            # 纯 A 股宽基
        ],
    )
    def test_rule_table(self, code: str, name: str, expected: bool) -> None:
        assert is_cross_border_etf(code, name) is expected


# ---------------------------------------------------------------------------
# M1 杠杆资金（两融）
# ---------------------------------------------------------------------------


class TestMarginPath:
    def _patch_common(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        monkeypatch.setattr(
            "akshare.stock_margin_sse",
            lambda start_date, end_date: load_csv("margin_sse.csv"),
            raising=False,
        )
        monkeypatch.setattr(
            "akshare.stock_margin_account_info",
            lambda: load_csv("margin_account.csv"),
            raising=False,
        )

    def test_sse_yuan_to_yi_with_szse_down(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """沪两融 2.26e12→2.27e12 元 → +100.0 亿；深市失败 → 仅沪腿 + 降级标注。"""
        self._patch_common(monkeypatch)
        counters = patch_ak(monkeypatch, {"stock_margin_szse": ConnectionError("深交所挂了")})
        path, degraded = get_margin_path()
        assert path["netFlowYi"] == pytest.approx(100.0)  # (2.27e12−2.26e12)/1e8，元→亿
        assert path["signals"]["sseFinDeltaYi"] == pytest.approx(100.0)
        assert path["signals"]["sseShortDeltaYi"] == 0.0
        assert path["signals"]["sseAsOf"] == "2026-11-10"
        assert any("深市" in d["note"] or "stock_margin_szse" in d["source"] for d in degraded)
        assert counters["stock_margin_szse"] > 0
        # 维持担保比例只进 signals（全市场口径，亿元原值）
        assert path["signals"]["maintenanceRatio"] == pytest.approx(260.8824)
        assert path["signals"]["maintenanceAsOf"] == "2026-11-10"
        assert path["asOf"] == "2026-11-10"

    def test_szse_yi_passthrough_no_1e8_division(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """沪+深合并：深汇总 30（亿元）→ 深腿 +30 亿不 ×1e8 误判；沪腿 +100 → 合计 130。"""
        self._patch_common(monkeypatch)
        szse_frames = {
            "20261110": load_csv("margin_szse_20261110.csv"),
            "20261109": load_csv("margin_szse_20261109.csv"),
        }

        def fake_szse(date: str) -> pd.DataFrame:
            return szse_frames.get(str(date), pd.DataFrame())

        patch_ak(monkeypatch, {"stock_margin_szse": fake_szse})
        path, _degraded = get_margin_path()
        assert path["netFlowYi"] == pytest.approx(130.0)  # 沪 +100 + 深 +30
        # 精确拆分：深腿 = 30.0 − 0.0（亿元原值差分，若误 /1e8 将缩成 3e-7）
        assert path["signals"]["szseFinDeltaYi"] == pytest.approx(30.0)
        assert path["signals"]["szseShortDeltaYi"] == 0.0
        assert path["signals"]["szseAsOf"] == "2026-11-10"

    def test_szse_only_leg_via_calendar_anchor(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """沪市失败 → 深市腿改用交易日历锚定；仅深腿可得时如实聚合 +30 亿（#24 单腿降级）。"""
        patch_env(monkeypatch)
        counters = patch_ak(monkeypatch, {"stock_margin_sse": ConnectionError("上交所挂了")})

        def fake_szse(date: str) -> pd.DataFrame:
            frames = {
                "20261112": load_csv("margin_szse_20261110.csv"),  # 日历锚定当日：融资余额 30.0
                "20261111": load_csv("margin_szse_20261109.csv"),  # 前值：0.0
            }
            return frames.get(str(date), pd.DataFrame())

        patch_ak(monkeypatch, {"stock_margin_szse": fake_szse})
        path, degraded = get_margin_path()
        assert path["netFlowYi"] == pytest.approx(30.0)  # 深汇总 30（亿元）→ +30 亿
        assert any("stock_margin_sse" in d["source"] for d in degraded)  # 沪腿失败有标注
        assert counters["stock_margin_sse"] > 0


# ---------------------------------------------------------------------------
# M2 被动 ETF（仅沪市，仅 A 股股票型）
# ---------------------------------------------------------------------------


class TestEtfPath:
    def _patch_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        scale_frames = {
            "20261111": load_csv("etf_scale_d1.csv", dtype={"基金代码": str}),
            "20261110": load_csv("etf_scale_d0.csv", dtype={"基金代码": str}),
        }

        def fake_scale(date: str = "20250115") -> pd.DataFrame:
            df = scale_frames.get(str(date))
            if df is None:
                return pd.DataFrame(columns=["序号", "基金代码", "基金简称", "ETF类型", "统计日期", "基金份额"])
            return df.copy()

        patch_ak(
            monkeypatch,
            {
                "fund_etf_scale_sse": fake_scale,
                "fund_etf_spot_ths": lambda: load_csv("etf_ths.csv", dtype={"基金代码": str}),
            },
        )

    def test_a_share_filter_and_buckets(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A 股股票型口径：563210 计入；513100/510900/港股通/恒生(无 A股) 排除进 crossBorderYi；
        债券/货币/其他只进分桶金额（不计入净流口径）；新上市/join 未命中/净值缺失排除并计数。"""
        self._patch_ok(monkeypatch)
        path, degraded = get_etf_path()
        assert path["pathId"] == "etfSse"
        assert path["netFlowYi"] == pytest.approx(1.5739)  # 仅 563210：Δ1 亿份 × 1.5739 元
        sig = path["signals"]
        assert sig["aShareCount"] == 1
        assert sig["crossBorderYi"] == pytest.approx(3.431326)  # 3.711 − 0.414674 + 0.12 + 0.015
        assert sig["crossBorderCount"] == 4
        assert sig["bondYi"] == pytest.approx(-12.006)  # 短融 ETF −12 亿级 → 仅 signals.bondYi
        assert sig["moneyYi"] == pytest.approx(10.0)
        assert sig["otherYi"] == pytest.approx(2.1)
        assert sig["excludedNewListedCount"] == 1    # 588200 只在 D1（新上市缺省排除）
        assert sig["excludedJoinMissCount"] == 1     # 517999 分类表未命中
        assert sig["excludedNavUnknownCount"] == 1   # 511380 最新-单位净值缺失
        assert sig["statDate"] == "2026-11-11"
        assert sig["prevStatDate"] == "2026-11-10"
        assert path["asOf"] == "2026-11-11"
        # 分桶「不计入净流口径」语义必须随载荷（#58 note）
        assert "不计入净流口径" in path["note"]
        assert degraded == []

    def test_prev_scale_missing_degrades_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """前值截面按日期直拉失败 → 路径降级 null + 标注（#63：无「首跑无前值」分支，失败即降级）。"""
        patch_env(monkeypatch)
        # 只有 11-11 截面：11-10 前值无数据
        patch_ak(
            monkeypatch,
            {
                "fund_etf_scale_sse": lambda date="20250115": load_csv(
                    "etf_scale_d1.csv", dtype={"基金代码": str}
                )
                if str(date) == "20261111"
                else pd.DataFrame(),
                "fund_etf_spot_ths": lambda: load_csv("etf_ths.csv", dtype={"基金代码": str}),
            },
        )
        path, degraded = get_etf_path()
        assert path["netFlowYi"] is None
        assert any("前值截面" in d["note"] for d in degraded)

    def test_ths_down_degrades_path(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """同花顺分类表失败 → A 股口径无法判定 → 路径降级（不做无分类的毛估）。"""
        patch_env(monkeypatch)
        patch_ak(
            monkeypatch,
            {
                "fund_etf_scale_sse": lambda date="20250115": load_csv(
                    "etf_scale_d1.csv", dtype={"基金代码": str}
                ),
                "fund_etf_spot_ths": ConnectionError("同花顺挂了"),
            },
        )
        path, degraded = get_etf_path()
        assert path["netFlowYi"] is None
        assert any("fund_etf_spot_ths" in d["source"] for d in degraded)


# ---------------------------------------------------------------------------
# M3 事件席位（龙虎榜 + 大宗）
# ---------------------------------------------------------------------------


class TestEventSeatPath:
    def _patch_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        patch_ak(
            monkeypatch,
            {
                "stock_lhb_jgmx_sina": lambda: load_csv("lhb_jgmx_sina.csv"),
                "stock_dzjy_mrmx": lambda symbol, start_date, end_date: load_csv("dzjy_mrmx.csv"),
            },
        )

    def test_lhb_wan_to_yi_and_dzjy_inst_special(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """新浪机构净买 5000 万元 → lhb 子项 +0.5 亿；大宗买方机构专用 2301 万 → dzjy 子项 +0.2301 亿；
        旧日期行（11-10 巨额龙虎榜/大宗）必须被最新日过滤掉；折溢率只进 signals。"""
        self._patch_ok(monkeypatch)
        path, _degraded = get_event_seat_path()
        assert path["netFlowYi"] == pytest.approx(0.7301)  # 0.5 + 0.2301
        sig = path["signals"]
        assert sig["lhbYi"] == pytest.approx(0.5)          # (8000−3000) 万元 /1e4
        assert sig["lhbAsOf"] == "2026-11-11"
        assert sig["dzjyYi"] == pytest.approx(0.2301)      # 2301 万元 = 0.2301 亿
        assert sig["dzjyAsOf"] == "2026-11-11"
        assert sig["dzjyPremiumPct"] == pytest.approx(-0.058173784978)
        assert path["asOf"] == "2026-11-11"

    def test_lhb_down_keeps_dzjy(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """新浪龙虎榜失败 → lhb 子项 null + 标注，大宗子项照常（#24 部分降级）。"""
        patch_env(monkeypatch)
        patch_ak(
            monkeypatch,
            {
                "stock_lhb_jgmx_sina": ConnectionError("新浪挂了"),
                "stock_dzjy_mrmx": lambda symbol, start_date, end_date: load_csv("dzjy_mrmx.csv"),
            },
        )
        path, degraded = get_event_seat_path()
        assert path["signals"]["lhbYi"] is None
        assert path["netFlowYi"] == pytest.approx(0.2301)
        assert any("stock_lhb_jgmx_sina" in d["source"] for d in degraded)

    def test_both_down_returns_null(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        patch_ak(
            monkeypatch,
            {
                "stock_lhb_jgmx_sina": ConnectionError("新浪挂了"),
                "stock_dzjy_mrmx": ConnectionError("东财挂了"),
            },
        )
        path, degraded = get_event_seat_path()
        assert path["netFlowYi"] is None
        assert len(degraded) == 2


# ---------------------------------------------------------------------------
# M4 季频持仓结构（五子信号 netFlowYi 恒 null）
# ---------------------------------------------------------------------------


class TestQuarterlyPath:
    def _patch_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        patch_ak(
            monkeypatch,
            {
                "stock_gdfx_free_holding_change_em": lambda date: load_csv("gdfx_change.csv"),
                "stock_report_fund_hold": lambda symbol, date: load_csv("fund_hold.csv"),
                "stock_zh_a_gdhs": lambda symbol: load_csv("gdhs.csv"),
            },
        )

    def test_five_sub_signals_all_null_netflow(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """M4 五个子信号均 netFlowYi=null；香港中央结算=北向季度代理；报告期滞后标注。"""
        self._patch_ok(monkeypatch)
        path, _degraded = get_quarterly_path()
        assert path["pathId"] == "quarterlyStructure"
        assert path["netFlowYi"] is None
        sig = path["signals"]
        assert set(sig) == {"hkscHolding", "fundHoldCount", "holderNature", "holderCount", "preciseAnnounce"}
        for key, sub in sig.items():
            assert sub["netFlowYi"] is None, f"{key} 不得产 NF（#58 季频只产结构信号）"
        hksc = sig["hkscHolding"]
        assert hksc["totalStocks"] == 3040        # 实测 20260930 版首行：总持有 3040 只
        assert hksc["newIn"] == 342
        assert hksc["floatMvYi"] == pytest.approx(25948.0883962481)  # 元→亿
        assert "滞后" in hksc["note"]             # 东财 gdfx 系无公告日字段 → 滞后标注（#63）
        assert sig["holderNature"]["counts"] == {"其他": 1, "个人": 1, "保险": 1, "QFII": 1}
        fh = sig["fundHoldCount"]
        assert fh["stocksWithFunds"] == 3
        assert fh["increaseCount"] == 1 and fh["decreaseCount"] == 1 and fh["newInCount"] == 1
        gd = sig["holderCount"]
        assert gd["sampleCount"] == 2
        assert gd["medianChangePct"] == pytest.approx(-0.4077473579445)
        assert gd["asOf"] == "2026-11-10"          # 自带公告日期列 → 精确到公告日
        assert path["asOf"] == "2026-09-30"        # 报告期（非信息可得日，note 标注滞后）
        assert "报告期" in path["note"]

    def test_quarter_fallback_when_latest_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """最新报告期无数据 → 向前回探一个季末（#63 滞后 30–40 天边界）。"""
        patch_env(monkeypatch)

        def fake_gdfx(date: str) -> pd.DataFrame:
            if str(date) == "20260930":
                return pd.DataFrame()  # 未发布
            return load_csv("gdfx_change.csv")

        patch_ak(
            monkeypatch,
            {
                "stock_gdfx_free_holding_change_em": fake_gdfx,
                "stock_report_fund_hold": lambda symbol, date: pd.DataFrame(),
                "stock_zh_a_gdhs": lambda symbol: pd.DataFrame(),
            },
        )
        path, degraded = get_quarterly_path()
        assert path["signals"]["hkscHolding"]["totalStocks"] == 3040
        assert path["signals"]["hkscHolding"]["asOf"] == "2026-06-30"
        assert path["signals"]["fundHoldCount"]["asOf"] is None  # 基金持股全候选为空 → 置空
        assert any("基金持股统计" in d["note"] for d in degraded)


# ---------------------------------------------------------------------------
# M5 北向（不可观测）+ 南向零重复出网
# ---------------------------------------------------------------------------


class TestNorthboundPath:
    FUNDS_STUB = {
        "marginBalance": 1.19e12,
        "northboundNet": None,
        "southboundNetYi": 45.721036,
        "asOf": "2026-11-11",
        "marginAsOf": "2026-11-10",
        "northAsOf": "2026-11-11",
        "southboundAsOf": "2026-11-11",
        "degraded": [],
    }

    def test_north_invariant_and_southbound_copy(self) -> None:
        """北向 netFlowYi 恒 null、note 含「2024-08」；南向与 funds 载荷零共享引用。"""
        funds = dict(self.FUNDS_STUB)
        path, degraded = get_northbound_path(funds)
        assert path["pathId"] == "northbound"
        assert path["netFlowYi"] is None
        assert "2024-08" in path["note"]
        assert path["signals"]["southboundNetYi"] == pytest.approx(45.721036)
        # 零共享引用：signals 是独立 dict，事后改 funds 不影响已产出的载荷
        assert path["signals"] is not funds
        funds["southboundNetYi"] = 999.0
        assert path["signals"]["southboundNetYi"] == pytest.approx(45.721036)
        assert path["asOf"] == "2026-11-11"
        assert degraded == []

    def test_without_funds_payload_flags_degraded(self) -> None:
        """未传 funds 载荷 → 南向置空 + degraded 标注（不伪造、不出网）。"""
        path, degraded = get_northbound_path(None)
        assert path["signals"]["southboundNetYi"] is None
        assert any("funds 载荷" in d["note"] for d in degraded)

    def test_no_hsgt_call_from_institution(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """institution 侧绝不自行调用 stock_hsgt_fund_flow_summary_em（零重复出网，#59）。"""
        patch_env(monkeypatch)
        counters = patch_ak(
            monkeypatch,
            {
                "stock_hsgt_fund_flow_summary_em": ConnectionError("不该被调用"),
                "stock_margin_sse": ConnectionError("x"),
                "stock_margin_szse": ConnectionError("x"),
                "stock_margin_account_info": ConnectionError("x"),
                "fund_etf_scale_sse": ConnectionError("x"),
                "fund_etf_spot_ths": ConnectionError("x"),
                "stock_lhb_jgmx_sina": ConnectionError("x"),
                "stock_dzjy_mrmx": ConnectionError("x"),
                "stock_gdfx_free_holding_change_em": ConnectionError("x"),
                "stock_report_fund_hold": ConnectionError("x"),
                "stock_zh_a_gdhs": ConnectionError("x"),
            },
        )
        get_institution(funds=self.FUNDS_STUB)
        assert counters["stock_hsgt_fund_flow_summary_em"] == 0


# ---------------------------------------------------------------------------
# 聚合入口 get_institution
# ---------------------------------------------------------------------------


class TestGetInstitution:
    def _patch_all_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        scale_frames = {
            "20261111": load_csv("etf_scale_d1.csv", dtype={"基金代码": str}),
            "20261110": load_csv("etf_scale_d0.csv", dtype={"基金代码": str}),
        }

        def fake_scale(date: str = "20250115") -> pd.DataFrame:
            df = scale_frames.get(str(date))
            if df is None:
                return pd.DataFrame(columns=["序号", "基金代码", "基金简称", "ETF类型", "统计日期", "基金份额"])
            return df.copy()

        def fake_szse(date: str) -> pd.DataFrame:
            frames = {
                "20261110": load_csv("margin_szse_20261110.csv"),
                "20261109": load_csv("margin_szse_20261109.csv"),
            }
            return frames.get(str(date), pd.DataFrame())

        patch_ak(
            monkeypatch,
            {
                "stock_margin_sse": lambda start_date, end_date: load_csv("margin_sse.csv"),
                "stock_margin_szse": fake_szse,
                "stock_margin_account_info": lambda: load_csv("margin_account.csv"),
                "fund_etf_scale_sse": fake_scale,
                "fund_etf_spot_ths": lambda: load_csv("etf_ths.csv", dtype={"基金代码": str}),
                "stock_lhb_jgmx_sina": lambda: load_csv("lhb_jgmx_sina.csv"),
                "stock_dzjy_mrmx": lambda symbol, start_date, end_date: load_csv("dzjy_mrmx.csv"),
                "stock_gdfx_free_holding_change_em": lambda date: load_csv("gdfx_change.csv"),
                "stock_report_fund_hold": lambda symbol, date: load_csv("fund_hold.csv"),
                "stock_zh_a_gdhs": lambda symbol: load_csv("gdhs.csv"),
            },
        )

    def test_payload_shape_and_informational_sum(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """五路径齐备；顶层 netFlowYi = Σ(日频路径)（信息性、未折算，#60）；逐路径 asOf。"""
        self._patch_all_ok(monkeypatch)
        payload = get_institution(funds=TestNorthboundPath.FUNDS_STUB)
        assert set(payload) == {"asOf", "netFlowYi", "paths", "degraded"}
        assert [p["pathId"] for p in payload["paths"]] == [
            "margin", "etfSse", "eventSeat", "quarterlyStructure", "northbound",
        ]
        assert payload["netFlowYi"] == pytest.approx(132.304)  # 130 + 1.5739 + 0.7301
        by_id = {p["pathId"]: p for p in payload["paths"]}
        assert by_id["margin"]["netFlowYi"] == pytest.approx(130.0)
        assert by_id["etfSse"]["netFlowYi"] == pytest.approx(1.5739)
        assert by_id["eventSeat"]["netFlowYi"] == pytest.approx(0.7301)
        assert by_id["quarterlyStructure"]["netFlowYi"] is None
        assert by_id["northbound"]["netFlowYi"] is None
        assert payload["asOf"] == "2026-11-11"  # 逐路径 asOf 的最大者
        assert payload["degraded"] == []

    def test_all_sources_fail_no_raise(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """全源抛异常 → 五路径 netFlowYi=null、degraded 各含 note、函数不抛出（#24）。"""
        patch_env(monkeypatch)
        err = ConnectionError("全源不可用")
        counters = patch_ak(
            monkeypatch,
            {
                "stock_margin_sse": err,
                "stock_margin_szse": err,
                "stock_margin_account_info": err,
                "fund_etf_scale_sse": err,
                "fund_etf_spot_ths": err,
                "stock_lhb_jgmx_sina": err,
                "stock_dzjy_mrmx": err,
                "stock_gdfx_free_holding_change_em": err,
                "stock_report_fund_hold": err,
                "stock_zh_a_gdhs": err,
            },
        )
        payload = get_institution(funds=None)
        assert all(p["netFlowYi"] is None for p in payload["paths"])
        assert payload["netFlowYi"] is None
        assert len(payload["degraded"]) >= 5
        assert all(d.get("note") for d in payload["degraded"])  # 每条降级都有人话 note
        for d in payload["degraded"]:
            assert d["degraded"] is True and d["source"]

    def test_determinism_same_input_same_output(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """固定输入必得固定输出（#58 每条路径为纯函数、可单测）。"""
        self._patch_all_ok(monkeypatch)
        first = get_institution(funds=TestNorthboundPath.FUNDS_STUB)
        for _ in range(5):
            again = get_institution(funds=TestNorthboundPath.FUNDS_STUB)
            assert again == first


# ---------------------------------------------------------------------------
# funds.get_funds 南向扩展（同一次响应、零重复出网）
# ---------------------------------------------------------------------------


class TestFundsSouthbound:
    def test_single_summary_em_call_and_southbound(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """get_funds 只发一次 summary_em 请求；南向=港股通(沪)+港股通(深) 最新日合计。"""
        import djiucai_data.funds as funds_mod

        monkeypatch.setattr(funds_mod, "today_sh", lambda: TODAY)
        rows = [
            ("2026-11-11", "沪股通", 0.0, 0.0),
            ("2026-11-11", "港股通(沪)", 23.775887, 420.0),   # 资金净流入 420 为额度占位，不参与
            ("2026-11-11", "港股通(深)", 21.945149, 420.0),
            ("2026-11-10", "港股通(沪)", 999.0, 420.0),       # 旧日期行不得泄入
        ]
        df = pd.DataFrame(rows, columns=["交易日", "板块", "成交净买额", "资金净流入"])
        calls = {"n": 0}

        def counting_summary() -> pd.DataFrame:
            calls["n"] += 1
            return df.copy()

        monkeypatch.setattr(fake_ak_module, "stock_hsgt_fund_flow_summary_em", counting_summary)
        monkeypatch.setattr(
            fake_ak_module,
            "stock_margin_sse",
            lambda start_date, end_date: pd.DataFrame([("2026-11-05", 1.0)], columns=["信用交易日期", "融资融券余额"]),
        )
        result = get_funds("SH000001")
        assert calls["n"] == 1  # 零重复出网：北向 + 南向共用同一次响应
        assert result["northboundNet"] is None  # 北向 0 占位 → 未披露（#59 判定不动）
        assert result["southboundNetYi"] == pytest.approx(45.721036)  # 23.775887 + 21.945149
        assert result["southboundAsOf"] == "2026-11-11"
        assert result["northAsOf"] == "2026-11-11"

    def test_southbound_failure_degrades(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        """summary_em 失败 → 北向/南向各自 null + 各自 degraded（#24）。"""
        import djiucai_data.funds as funds_mod

        monkeypatch.setattr(funds_mod, "today_sh", lambda: TODAY)
        monkeypatch.setattr(
            fake_ak_module,
            "stock_hsgt_fund_flow_summary_em",
            boom,
        )
        monkeypatch.setattr(
            fake_ak_module,
            "stock_margin_sse",
            lambda start_date, end_date: pd.DataFrame([("2026-11-05", 1.0)], columns=["信用交易日期", "融资融券余额"]),
        )
        result = get_funds("SH000001")
        assert result["northboundNet"] is None
        assert result["southboundNetYi"] is None
        sources = [d["source"] for d in result["degraded"]]
        assert sources.count("akshare:stock_hsgt_fund_flow_summary_em") == 2  # 北向/南向各一条


# ---------------------------------------------------------------------------
# 预埋：个股精确公告日口径
# ---------------------------------------------------------------------------


class TestStockHolderAnnounce:
    def test_latest_announce_date(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        patch_ak(
            monkeypatch,
            {"stock_circulate_stock_holder": lambda symbol: load_csv("circulate_holder.csv")},
        )
        out = get_stock_holder_announce("600000")
        assert out["latestAnnounceDate"] == "2026-10-31"
        assert out["rows"] == 1
        assert out["degraded"] == []

    def test_failure_returns_null_with_degraded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        patch_env(monkeypatch)
        patch_ak(monkeypatch, {"stock_circulate_stock_holder": ConnectionError("新浪挂了")})
        out = get_stock_holder_announce("600000")
        assert out["latestAnnounceDate"] is None
        assert any("stock_circulate_stock_holder" in d["source"] for d in out["degraded"])
