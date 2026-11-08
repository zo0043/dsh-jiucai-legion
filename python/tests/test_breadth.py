"""市场宽度测试（需求 #22：任一子源失败 → 该字段 null + degraded，不整单失败）。"""

from __future__ import annotations

from typing import Any

import djiucai_data.breadth as breadth_mod
from djiucai_data.breadth import get_breadth
from fakes import fake_spot_df, fake_zt_pool_df


def _patch_all_ok(
    monkeypatch: pytest.MonkeyPatch, zt: Any = None, dt: Any = None, zb: Any = None, spot: Any = None
) -> None:
    monkeypatch.setattr(breadth_mod, "_zt_pool", lambda d8="": zt)
    monkeypatch.setattr(breadth_mod, "_dt_pool", lambda d8="": dt)
    monkeypatch.setattr(breadth_mod, "_zb_pool", lambda d8="": zb)
    monkeypatch.setattr(breadth_mod, "_spot_all", lambda: spot)
    monkeypatch.setattr(breadth_mod, "_legu_counts", lambda: None)


class TestBreadth:
    def test_all_sources_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """连板高度 = 连板数列最大值；涨跌家数 = 涨跌幅聚合。"""
        _patch_all_ok(
            monkeypatch,
            zt=fake_zt_pool_df([1, 2, 3, 2]),      # 4 只涨停，最高 3 连板
            dt=fake_zt_pool_df([1, 1]),            # 2 只跌停（列结构同款够用）
            zb=fake_zt_pool_df([1]),               # 1 只炸板
            spot=fake_spot_df([1.2, -0.5, 3.0, 0.0, -2.1, None]),
        )
        result = get_breadth("2026-11-06")
        assert result["limitUp"] == 4
        assert result["maxStreak"] == 3
        assert result["limitDown"] == 2
        assert result["failedBoard"] == 1
        assert result["advancers"] == 2   # >0
        assert result["decliners"] == 2   # <0（0.0 与 None 剔除）
        assert result["degraded"] == []

    def test_date_param_normalized(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """'YYYY-MM-DD' → 'YYYYMMDD' 传给东财接口。"""
        seen: dict[str, str] = {}

        def fake_zt(d8: str) -> Any:
            seen["date"] = d8
            return fake_zt_pool_df([1])

        monkeypatch.setattr(breadth_mod, "_zt_pool", fake_zt)
        monkeypatch.setattr(breadth_mod, "_dt_pool", lambda d8="": fake_zt_pool_df([]))
        monkeypatch.setattr(breadth_mod, "_zb_pool", lambda d8="": fake_zt_pool_df([]))
        monkeypatch.setattr(breadth_mod, "_spot_all", lambda: fake_spot_df([0.1]))
        monkeypatch.setattr(breadth_mod, "_legu_counts", lambda: None)
        get_breadth("2026-11-05")
        assert seen["date"] == "20261105"

    def test_single_source_failure_degrades_field_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """涨停池挂 → limitUp/maxStreak 为 null + degraded；其余字段照常返回。"""

        def boom(d8: str = "") -> Any:
            raise ConnectionError("东财涨停池接口改版")

        _patch_all_ok(
            monkeypatch,
            dt=fake_zt_pool_df([1]),
            zb=fake_zt_pool_df([1]),
            spot=fake_spot_df([1.0, -1.0]),
        )
        monkeypatch.setattr(breadth_mod, "_zt_pool", boom)
        result = get_breadth("2026-11-06")
        assert result["limitUp"] is None
        assert result["maxStreak"] is None
        assert result["limitDown"] == 1      # 其他子源不受影响
        assert result["failedBoard"] == 1
        assert result["advancers"] == 1
        assert result["decliners"] == 1
        assert any("stock_zt_pool_em" in d["source"] for d in result["degraded"])

    def test_spot_failure_degrades_advancers_only(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _patch_all_ok(
            monkeypatch,
            zt=fake_zt_pool_df([2]),
            dt=fake_zt_pool_df([]),
            zb=fake_zt_pool_df([]),
        )

        def spot_boom() -> Any:
            raise TimeoutError("全市场快照超时")

        monkeypatch.setattr(breadth_mod, "_spot_all", spot_boom)
        monkeypatch.setattr(breadth_mod, "_legu_counts", lambda: None)
        result = get_breadth()
        assert result["limitUp"] == 1
        assert result["advancers"] is None and result["decliners"] is None
        assert any("涨跌家数" in d["note"] for d in result["degraded"])

    def test_empty_zt_pool_max_streak_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """空涨停池 → 连板高度 0（合法值，非降级）。"""
        _patch_all_ok(
            monkeypatch,
            zt=fake_zt_pool_df([]),
            dt=fake_zt_pool_df([]),
            zb=fake_zt_pool_df([]),
            spot=fake_spot_df([0.0]),
        )
        result = get_breadth("2026-11-05")
        assert result["limitUp"] == 0
        assert result["maxStreak"] == 0
        assert result["degraded"] == []


class TestLeguPrimary:
    """主源乐咕活跃度（getSnapshot 提速路径）：上涨/下跌直取，池失败时兜底涨停/跌停。"""

    def test_legu_primary_counts(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(breadth_mod, "_legu_counts", lambda: {"上涨": 4538.0, "下跌": 604.0, "涨停": 85.0, "跌停": 0.0})
        monkeypatch.setattr(breadth_mod, "_zt_pool", lambda d8="": fake_zt_pool_df([]))
        monkeypatch.setattr(breadth_mod, "_dt_pool", lambda d8="": fake_zt_pool_df([]))
        monkeypatch.setattr(breadth_mod, "_zb_pool", lambda d8="": fake_zt_pool_df([]))
        result = breadth_mod.get_breadth()
        assert result["advancers"] == 4538
        assert result["decliners"] == 604
        # 池正常时不兜底
        assert result["limitUp"] == 0

    def test_legu_fallback_fills_limit_counts(self, monkeypatch: pytest.MonkeyPatch) -> None:
        def boom(d8: str = "") -> Any:
            raise ConnectionError("东财涨停池接口改版")
        monkeypatch.setattr(breadth_mod, "_legu_counts", lambda: {"上涨": 10.0, "下跌": 5.0, "涨停": 85.0, "跌停": 2.0})
        monkeypatch.setattr(breadth_mod, "_zt_pool", boom)
        monkeypatch.setattr(breadth_mod, "_dt_pool", boom)
        monkeypatch.setattr(breadth_mod, "_zb_pool", boom)
        result = breadth_mod.get_breadth()
        assert result["advancers"] == 10
        assert result["limitUp"] == 85  # 活跃度表兜底
        assert result["limitDown"] == 2
        assert any("兜底" in (g.get("note") or "") for g in result["degraded"])
