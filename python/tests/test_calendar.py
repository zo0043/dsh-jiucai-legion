"""交易日历测试（需求 #37：进数据管道并缓存；#24 失败降级链路）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from djiucai_data import cache
from djiucai_data.calendar import get_calendar, latest_trade_date
from fakes import fake_calendar_df


class TestGetCalendar:
    def test_success_returns_sorted_and_caches(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path
    ) -> None:
        monkeypatch.setattr(
            fake_ak_module,
            "tool_trade_date_hist_sina",
            lambda: fake_calendar_df(["2026-11-06", "2026-11-05", "2026-11-10"]),
        )
        dates, degraded = get_calendar()
        assert dates == ["2026-11-05", "2026-11-06", "2026-11-10"]  # 升序去重
        assert degraded == []
        cached = cache.load_cache("calendar", "calendar")
        assert cached is not None and cached["dates"] == dates

    def test_failure_falls_back_to_cache(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path
    ) -> None:
        cache.save_cache("calendar", "calendar", {"dates": ["2026-11-05"], "asOf": "2026-11-05 16:00:00"})

        def boom() -> Any:
            raise ConnectionError("新浪接口挂了")

        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", boom)
        dates, degraded = get_calendar()
        assert dates == ["2026-11-05"]  # 缓存降级
        assert degraded and degraded[0]["degraded"] is True
        assert "tool_trade_date_hist_sina" in degraded[0]["source"]
        assert "缓存" in degraded[0]["note"]
        assert degraded[0]["asOf"] == "2026-11-05 16:00:00"  # 显著标注数据截至日（#24）

    def test_double_failure_returns_empty_with_degraded(
        self, monkeypatch: pytest.MonkeyPatch, fake_ak_module: Any, isolated_cache: Path
    ) -> None:
        def boom() -> Any:
            raise ConnectionError("双挂")

        monkeypatch.setattr(fake_ak_module, "tool_trade_date_hist_sina", boom)
        dates, degraded = get_calendar()
        assert dates == []
        assert degraded and "无缓存" in degraded[0]["note"]


class TestLatestTradeDate:
    def test_latest_on_or_before(self) -> None:
        dates = ["2026-11-03", "2026-11-05", "2026-11-06"]
        assert latest_trade_date(dates, "2026-11-05") == "2026-11-05"
        assert latest_trade_date(dates, "2026-11-04") == "2026-11-03"
        assert latest_trade_date(dates, "2026-12-31") == "2026-11-06"

    def test_empty_list(self) -> None:
        assert latest_trade_date([], "2026-11-05") is None
