"""情绪热度双源测试（需求 #30/#33：雪球 ↔ 东财互备、自动切换、degraded 标注）。"""

from __future__ import annotations

from typing import Any

import djiucai_data.sentiment as sentiment_mod
from djiucai_data.sentiment import get_sentiment
from fakes import fake_rank_em_df, fake_xq_df


class TestDualSource:
    def test_primary_xueqiu_follow(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """主源雪球关注榜：heatIndex = 前 50 条关注均值。"""
        values = [float(i + 1) for i in range(60)]  # 1..60
        monkeypatch.setattr(fake_ak_module, "stock_hot_follow_xq", lambda symbol="最热门": fake_xq_df(values))
        monkeypatch.setattr(fake_ak_module, "stock_hot_tweet_xq", lambda symbol="最热门": fake_xq_df(values))
        result = get_sentiment()
        assert result["source"] == "xueqiu"
        assert result["heatIndex"] == sum(values[:50]) / 50  # 前 50 条均值
        assert result["asOf"]
        assert result["degraded"] == []

    def test_xq_family_fallback_to_tweet(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """关注榜挂 → 讨论榜（雪球族内备选），不触发东财切换标注。"""

        def follow_boom(symbol: str = "最热门") -> Any:
            raise ConnectionError("雪球 token 失效")

        monkeypatch.setattr(fake_ak_module, "stock_hot_follow_xq", follow_boom)
        monkeypatch.setattr(
            fake_ak_module, "stock_hot_tweet_xq", lambda symbol="最热门": fake_xq_df([10.0, 20.0, 30.0])
        )
        result = get_sentiment()
        assert result["source"] == "xueqiu"
        assert result["heatIndex"] == 20.0
        # 族内切换也如实标注（雪球主源内部降级），但不出现东财切换标注
        assert not any("东财" in d["note"] for d in result["degraded"])

    def test_switch_to_eastmoney_with_degraded(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """双雪球接口都挂 → 切东财人气榜 + degraded 标注 source 切换（需求 #30）。"""

        def xq_boom(symbol: str = "最热门") -> Any:
            raise ConnectionError("雪球上游断供")

        monkeypatch.setattr(fake_ak_module, "stock_hot_follow_xq", xq_boom)
        monkeypatch.setattr(fake_ak_module, "stock_hot_tweet_xq", xq_boom)
        monkeypatch.setattr(fake_ak_module, "stock_hot_rank_em", lambda: fake_rank_em_df(100))
        result = get_sentiment()
        assert result["source"] == "eastmoney"
        assert result["heatIndex"] == 100.0  # 备源代理 = 榜单条目数
        assert any("切换" in d["note"] and "东财" in d["note"] for d in result["degraded"])

    def test_both_sources_fail(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        def boom(*args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("全挂")

        monkeypatch.setattr(fake_ak_module, "stock_hot_follow_xq", boom)
        monkeypatch.setattr(fake_ak_module, "stock_hot_tweet_xq", boom)
        monkeypatch.setattr(fake_ak_module, "stock_hot_rank_em", boom)
        result = get_sentiment()
        assert result["source"] is None
        assert result["heatIndex"] is None
        assert len(result["degraded"]) >= 3  # 每个失败源都有标注

    def test_module_level_wrappers_use_akshare(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        """带装饰器的模块内 fetcher 也走 monkeypatch 的 akshare（双重验证）。"""
        monkeypatch.setattr(
            fake_ak_module, "stock_hot_follow_xq", lambda symbol="最热门": fake_xq_df([5.0, 15.0])
        )
        result = sentiment_mod._fetch_follow_xq()
        assert result["关注"].tolist() == [5.0, 15.0]
