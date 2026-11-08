"""交易日历（需求 #37：akshare tool_trade_date_hist_sina 进数据管道并缓存）。

失败链路（需求 #24 分级降级）：akshare 主源 → 本地缓存 → 空列表 + degraded 标注。
日期一律 "YYYY-MM-DD" 字符串，按 Asia/Shanghai 业务日（需求 #38）。
"""

from __future__ import annotations

from typing import Optional

import akshare as ak
import pandas as pd

from . import cache
from ._common import make_degraded, today_sh
from .retry import with_retry

OP = "calendar"


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_trade_dates() -> list[str]:
    """主源 akshare 新浪交易日历（接口名已按 akshare 1.20.34 源码确认）。"""
    df = ak.tool_trade_date_hist_sina()
    dates = {str(pd.Timestamp(d).date()) for d in df["trade_date"].tolist()}
    return sorted(dates)


def get_calendar() -> tuple[list[str], list[dict]]:
    """返回 ``(交易日列表, degraded 列表)``。

    交易日列表为 "YYYY-MM-DD" 字符串升序（含历史与未来已知交易日）。
    主源失败 → 读缓存（degraded 标注缓存截至日）；缓存也无 → 空列表 + degraded。
    """
    degraded: list[dict] = []
    try:
        dates = _fetch_trade_dates()
    except Exception as err:  # noqa: BLE001
        dates = []
        cached = cache.load_cache(OP, "calendar")
        if isinstance(cached, dict) and isinstance(cached.get("dates"), list):
            dates = [str(d) for d in cached["dates"]]
            degraded.append(
                make_degraded(
                    "akshare:tool_trade_date_hist_sina",
                    asOf=cached.get("asOf"),
                    note=f"交易日历主源失败（{err}），已回退本地缓存",
                )
            )
        else:
            degraded.append(
                make_degraded(
                    "akshare:tool_trade_date_hist_sina",
                    asOf=None,
                    note=f"交易日历主源失败且无缓存（{err}），返回空列表",
                )
            )
        return dates, degraded

    if dates:
        cache.save_cache(OP, "calendar", {"dates": dates, "asOf": today_sh()})
    return dates, degraded


def latest_trade_date(dates: list[str], on_or_before: Optional[str] = None) -> Optional[str]:
    """返回 <= 指定日（默认今天）的最近交易日；列表为空返回 None。"""
    if not dates:
        return None
    anchor = on_or_before or today_sh()
    prior = [d for d in dates if d <= anchor]
    return prior[-1] if prior else None
