"""快照聚合测试（技术设计 §4 MarketSnapshot 字段对齐、degraded 汇总、volatility20 数值正确性）。"""

from __future__ import annotations

import math
from typing import Any

import djiucai_data.snapshot as snapshot_mod
from djiucai_data.snapshot import get_snapshot, volatility20

SNAPSHOT_KEYS = {
    "index",
    "tradeDate",
    "bars",
    "breadth",
    "sentiment",
    "news",
    "funds",
    "inst",
    "volatility20",
    "legionBullPct",
    "degraded",
}


class TestVolatility20:
    def test_golden_value_alternating_returns(self) -> None:
        """构造已知对数收益序列（±1% 交替）：解析解 = 0.01·sqrt(20/19)·sqrt(250)。"""
        closes = [100.0]
        for i in range(20):
            r = 0.01 if i % 2 == 0 else -0.01
            closes.append(closes[-1] * math.exp(r))  # 对数收益恰为 ±0.01
        expected = 0.01 * math.sqrt(20 / 19) * math.sqrt(250)  # 样本标准差 ddof=1
        vol = volatility20(closes)
        assert vol is not None
        assert math.isclose(vol, expected, rel_tol=1e-12)

    def test_constant_closes_zero_vol(self) -> None:
        closes = [100.0] * 21
        assert volatility20(closes) == 0.0

    def test_uses_last_20_returns_only(self) -> None:
        """前段剧烈波动不应影响最近 20 日收益的波动率。"""
        calm = [100.0 * (1.0001 ** i) for i in range(21)]          # 末段平静
        wild_prefix = [100.0 * (1 + 0.05 * (1 if i % 2 else -1)) for i in range(10)]
        full = wild_prefix + calm
        vol_full = volatility20(full)
        vol_calm = volatility20(calm)
        assert vol_full is not None and vol_calm is not None
        assert math.isclose(vol_full, vol_calm, rel_tol=1e-9)

    def test_insufficient_returns_none(self) -> None:
        assert volatility20([100.0] * 20) is None  # 21 个点才够 20 个收益
        assert volatility20([]) is None


def _stub_all(monkeypatch: pytest.MonkeyPatch, bars: list[dict[str, Any]]) -> dict[str, Any]:
    """把 snapshot 依赖的五个子模块 get_* 全部打桩，返回各子源 degraded 标记。"""
    daily = {
        "bars": bars,
        "stale": False,
        "asOf": bars[-1]["date"] if bars else None,
        "degraded": [{"source": "daily-test", "asOf": None, "degraded": True, "note": "日线测试降级"}],
    }
    breadth = {
        "limitUp": 50,
        "limitDown": 3,
        "failedBoard": 12,
        "maxStreak": 5,
        "advancers": 3000,
        "decliners": 2000,
        "degraded": [{"source": "breadth-test", "asOf": None, "degraded": True, "note": "宽度测试降级"}],
    }
    sentiment = {
        "source": "xueqiu",
        "heatIndex": 42.0,
        "asOf": "2026-11-06 15:00:00",
        "degraded": [{"source": "sentiment-test", "asOf": None, "degraded": True, "note": "情绪测试降级"}],
    }
    news = {
        "items": [{"text": "n1", "ts": "2026-11-06 15:00:00", "source": "sina"}],
        "asOf": "2026-11-06 15:00:00",
        "degraded": [{"source": "news-test", "asOf": None, "degraded": True, "note": "新闻测试降级"}],
    }
    funds = {
        "marginBalance": 10200.0,
        "northboundNet": 50.0,
        "southboundNetYi": 45.72,
        "asOf": "2026-11-05",
        "marginAsOf": "2026-11-05",
        "northAsOf": "2026-11-04",
        "southboundAsOf": "2026-11-04",
        "degraded": [{"source": "funds-test", "asOf": None, "degraded": True, "note": "资金测试降级"}],
    }
    inst = {
        "asOf": "2026-11-05",
        "netFlowYi": 132.304,
        "paths": [{"pathId": "margin", "label": "M1 杠杆资金（两融）", "netFlowYi": 132.304, "signals": {}, "asOf": "2026-11-05"}],
        "degraded": [{"source": "inst-test", "asOf": None, "degraded": True, "note": "机构测试降级"}],
    }
    monkeypatch.setattr(snapshot_mod, "get_daily_bars", lambda index, days=250: daily)
    monkeypatch.setattr(snapshot_mod, "get_breadth", lambda date=None: breadth)
    monkeypatch.setattr(snapshot_mod, "get_sentiment", lambda: sentiment)
    monkeypatch.setattr(snapshot_mod, "get_news", lambda: news)
    monkeypatch.setattr(snapshot_mod, "get_funds", lambda index: funds)
    monkeypatch.setattr(snapshot_mod, "get_institution", lambda funds=None: inst)
    return {
        "daily": daily, "breadth": breadth, "sentiment": sentiment,
        "news": news, "funds": funds, "inst": inst,
    }


class TestSnapshotAggregation:
    def test_field_alignment_with_design_doc(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """字段名与 docs/技术设计.md §4 MarketSnapshot 对齐。"""
        bars = [
            {
                "date": f"2026-10-{d:02d}",
                "open": 1.0,
                "high": 2.0,
                "low": 0.5,
                "close": 100.0 + d,
                "volume": 10.0,
            }
            for d in range(1, 22)  # 21 根 → 足够算 volatility20
        ]
        _stub_all(monkeypatch, bars)
        snap = get_snapshot("SH000001")
        assert set(snap) == SNAPSHOT_KEYS
        assert snap["index"] == "SH000001"
        assert snap["tradeDate"] == "2026-10-21"
        assert len(snap["bars"]) == 21
        assert snap["breadth"] == {
            "limitUp": 50,
            "limitDown": 3,
            "failedBoard": 12,
            "maxStreak": 5,
            "advancers": 3000,
            "decliners": 2000,
        }
        assert snap["sentiment"] == {"source": "xueqiu", "heatIndex": 42.0, "asOf": "2026-11-06 15:00:00"}
        assert snap["news"]["items"][0]["source"] == "sina"
        assert snap["funds"] == {
        "marginBalance": 10200.0,
        "northboundNet": 50.0,
        "southboundNetYi": 45.72,
        "asOf": "2026-11-05",
        "marginAsOf": "2026-11-05",
        "northAsOf": "2026-11-04",
        "southboundAsOf": "2026-11-04",
    }
        # 机构决策层原始载荷随快照透传（v1.4 #58–#60；折算只在 TS 侧）
        assert snap["inst"]["netFlowYi"] == 132.304
        assert snap["inst"]["paths"][0]["pathId"] == "margin"
        assert snap["legionBullPct"] is None  # 由 TS 引擎回流计算
        assert snap["volatility20"] is not None

    def test_degraded_aggregated_from_all_subsources(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """degraded 汇总所有子源标注（需求 #24/#32）。"""
        bars = [
            {"date": f"2026-10-{d:02d}", "open": 1.0, "high": 2.0, "low": 0.5, "close": 100.0, "volume": 10.0}
            for d in range(1, 22)
        ]
        _stub_all(monkeypatch, bars)
        snap = get_snapshot("SH000001")
        sources = [d["source"] for d in snap["degraded"]]
        for expected in ("daily-test", "breadth-test", "sentiment-test", "news-test", "funds-test", "inst-test"):
            assert expected in sources

    def test_volatility20_insufficient_bars_adds_degraded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        bars = [{"date": "2026-11-05", "open": 1.0, "high": 2.0, "low": 0.5, "close": 100.0, "volume": 10.0}]
        _stub_all(monkeypatch, bars)
        snap = get_snapshot("SH000001")
        assert snap["volatility20"] is None
        assert any(d["source"] == "volatility20" for d in snap["degraded"])

    def test_old_cache_without_inst_is_regenerated(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """v1.4 自愈（#64 additive）：升级前缓存的同交易日快照无 inst 块 → 重算而非直接复用。"""
        from djiucai_data.cache import save_cache

        bars = [
            {"date": f"2026-10-{d:02d}", "open": 1.0, "high": 2.0, "low": 0.5, "close": 100.0 + d, "volume": 10.0}
            for d in range(1, 22)
        ]
        _stub_all(monkeypatch, bars)
        # 预置 v1.4 前形态的旧缓存（tradeDate 相同、无 inst 键）
        save_cache(
            "snapshot",
            "SH000001.json",
            {"index": "SH000001", "tradeDate": "2026-10-21", "bars": bars, "degraded": []},
        )
        snap = get_snapshot("SH000001")
        assert "inst" in snap  # 旧缓存被重算为新形态
        assert snap["tradeDate"] == "2026-10-21"

    def test_same_day_cache_hit_reuses_inst_payload(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """同交易日且缓存已含 inst → 直接命中（不走子源重拉）。"""
        from djiucai_data.cache import load_cache, save_cache

        bars = [
            {"date": f"2026-10-{d:02d}", "open": 1.0, "high": 2.0, "low": 0.5, "close": 100.0 + d, "volume": 10.0}
            for d in range(1, 22)
        ]
        _stub_all(monkeypatch, bars)
        stub_inst = {"asOf": "2026-10-21", "netFlowYi": 7.0, "paths": [], "degraded": []}
        save_cache(
            "snapshot",
            "SH000001.json",
            {"index": "SH000001", "tradeDate": "2026-10-21", "bars": bars, "inst": stub_inst, "degraded": []},
        )
        snap = get_snapshot("SH000001")
        assert load_cache("snapshot", "SH000001.json")["tradeDate"] == "2026-10-21"
        assert snap["inst"]["netFlowYi"] == 7.0  # 缓存命中原样返回

    def test_date_anchor_filters_bars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """指定 date 参数 → 只取 <= date 的 bars 作为锚（#46 盘中锚定最近收盘日）。"""
        bars = [
            {
                "date": f"2026-10-{d:02d}",
                "open": 1.0,
                "high": 2.0,
                "low": 0.5,
                "close": 100.0 + d,
                "volume": 10.0,
            }
            for d in range(1, 22)
        ]
        _stub_all(monkeypatch, bars)
        snap = get_snapshot("SH000001", date="2026-10-15")
        assert snap["tradeDate"] == "2026-10-15"
        assert all(b["date"] <= "2026-10-15" for b in snap["bars"])
        # 波动率只用锚定日前数据
        closes = [b["close"] for b in snap["bars"][-21:]]
        expected = volatility20(closes)
        assert snap["volatility20"] == expected

    def test_volatility20_value_from_real_bars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """端到端数值：closes=100..120（线性）→ 对数收益递减，期望值独立计算。"""
        bars = [
            {"date": f"2026-10-{d:02d}", "open": 1.0, "high": 2.0, "low": 0.5, "close": 100.0 + d, "volume": 10.0}
            for d in range(1, 22)
        ]
        _stub_all(monkeypatch, bars)
        snap = get_snapshot("SH000001")
        closes = [b["close"] for b in snap["bars"]]
        rets = [math.log(closes[i] / closes[i - 1]) for i in range(1, len(closes))][-20:]
        mean = sum(rets) / len(rets)
        var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
        assert math.isclose(snap["volatility20"], math.sqrt(var) * math.sqrt(250), rel_tol=1e-12)
