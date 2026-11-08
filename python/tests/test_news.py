"""新闻双源测试（需求 #23/#34：新浪快讯 ↔ 财联社电报互备）。"""

from __future__ import annotations

from typing import Any

import djiucai_data.news as news_mod
from djiucai_data.news import get_news
from fakes import fake_cls_df, fake_sina_df


class TestNewsDualSource:
    def test_primary_sina(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        rows = [
            ("2026-11-06 15:01:00", "新闻B"),
            ("2026-11-06 15:02:00", "新闻A"),
            ("2026-11-06 14:00:00", "新闻C"),
        ]
        monkeypatch.setattr(fake_ak_module, "stock_info_global_sina", lambda: fake_sina_df(rows))
        result = get_news()
        assert [i["source"] for i in result["items"]] == ["sina", "sina", "sina"]
        # 按时间倒序（最新在前）
        assert [i["text"] for i in result["items"]] == ["新闻A", "新闻B", "新闻C"]
        assert result["items"][0]["ts"] == "2026-11-06 15:02:00"
        assert result["degraded"] == []

    def test_sina_dedup_and_cap_30(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        rows = [(f"2026-11-06 10:{i:02d}:00", f"快讯{i}") for i in range(35)]
        rows.append(("2026-11-06 10:00:00", "快讯0"))  # 重复文本 → 去重
        monkeypatch.setattr(fake_ak_module, "stock_info_global_sina", lambda: fake_sina_df(rows))
        result = get_news()
        assert len(result["items"]) == 30  # 最多 30 条（需求 #23）
        texts = [i["text"] for i in result["items"]]
        assert len(texts) == len(set(texts))

    def test_fallback_to_cls(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        """新浪挂 → 财联社电报备源 + degraded 标注切换。"""

        def sina_boom() -> Any:
            raise ConnectionError("新浪 7x24 挂了")

        monkeypatch.setattr(fake_ak_module, "stock_info_global_sina", sina_boom)
        monkeypatch.setattr(
            fake_ak_module,
            "stock_info_global_cls",
            lambda symbol="全部": fake_cls_df(
                [("标题A", "内容A", "2026-11-06", "09:31:00"), ("", "仅内容B", "2026-11-06", "09:30:00")]
            ),
        )
        result = get_news()
        assert len(result["items"]) == 2
        assert all(i["source"] == "cls" for i in result["items"])
        assert result["items"][0]["text"] == "标题A 内容A"       # 标题+内容合并
        assert result["items"][1]["text"] == "仅内容B"           # 空标题只留内容
        assert result["items"][0]["ts"] == "2026-11-06 09:31:00"  # 日期+时间合并
        assert any("财联社" in d["note"] and "切换" in d["note"] for d in result["degraded"])

    def test_both_fail_returns_empty_with_degraded(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any
    ) -> None:
        def boom(*args: Any, **kwargs: Any) -> Any:
            raise ConnectionError("双源全挂")

        monkeypatch.setattr(fake_ak_module, "stock_info_global_sina", boom)
        monkeypatch.setattr(fake_ak_module, "stock_info_global_cls", boom)
        result = get_news()
        assert result["items"] == []
        assert len(result["degraded"]) >= 2

    def test_sina_unparseable_ts_kept_as_is(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        """时间解析失败时不丢条目，原样保留。"""
        monkeypatch.setattr(
            fake_ak_module, "stock_info_global_sina", lambda: fake_sina_df([("奇怪时间", "内容X")])
        )
        result = get_news()
        assert result["items"][0]["ts"] == "奇怪时间"
        assert result["items"][0]["text"] == "内容X"

    def test_cls_items_via_module_wrapper(self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any) -> None:
        """模块内带重试的 fetcher 走 monkeypatch 的 akshare。"""
        monkeypatch.setattr(
            fake_ak_module,
            "stock_info_global_cls",
            lambda symbol="全部": fake_cls_df([("T", "C", "2026-11-05", "15:00:00")]),
        )
        df = news_mod._fetch_cls()
        assert list(df.columns) == ["标题", "内容", "发布日期", "发布时间"]
