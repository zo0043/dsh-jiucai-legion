"""情绪热度双源（需求 #30：雪球 ↔ 东财人气榜互备，任一失效自动切换并标注 #33）。

- 主源雪球：``stock_hot_follow_xq(symbol="最热门")``（接口名与「关注」数值列已按
  akshare 1.20.34 源码确认）；雪球族内先试关注榜、再试讨论榜 ``stock_hot_tweet_xq``。
- 备源东财：``stock_hot_rank_em()``（人气榜）。
- 热度代理值 heatIndex：雪球=前 50 条「关注」均值；东财=榜单条目数（榜单规模代理）。
  两源量纲不同，TS 侧仅做展示/相对比较。
"""

from __future__ import annotations

from typing import Any

import akshare as ak
import pandas as pd

from ._common import fmt_ts, make_degraded, now_sh
from .retry import with_retry

TOP_N = 50  # 热度代理值取前 50 条（需求 #30）


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_follow_xq() -> pd.DataFrame:
    """雪球关注排行榜（主源）。"""
    return ak.stock_hot_follow_xq(symbol="最热门")


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_tweet_xq() -> pd.DataFrame:
    """雪球讨论排行榜（主源族内备选）。"""
    return ak.stock_hot_tweet_xq(symbol="最热门")


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_rank_em() -> pd.DataFrame:
    """东财人气榜（备源，需求 #30）。"""
    return ak.stock_hot_rank_em()


def _xq_heat(df: pd.DataFrame) -> float:
    """雪球热度代理：前 50 条「关注」均值；列异常时退化为条目数。"""
    if df is not None and not df.empty and "关注" in df.columns:
        values = pd.to_numeric(df["关注"], errors="coerce").dropna()
        if not values.empty:
            return float(values.head(TOP_N).mean())
    return float(len(df)) if df is not None else 0.0


def _em_heat(df: pd.DataFrame) -> float:
    """东财热度代理：榜单条目数（人气榜无数值热度列，用规模代理并在文档说明）。"""
    return float(len(df)) if df is not None else 0.0


def get_sentiment() -> dict[str, Any]:
    """返回 ``{source, heatIndex, asOf, degraded}``。

    source ∈ {'xueqiu', 'eastmoney'}；双源都挂 → source=None, heatIndex=None + degraded。
    """
    degraded: list[dict] = []
    now = fmt_ts(now_sh())

    for name, fetcher, heat_fn in (
        ("stock_hot_follow_xq", _fetch_follow_xq, _xq_heat),
        ("stock_hot_tweet_xq", _fetch_tweet_xq, _xq_heat),
    ):
        try:
            df = fetcher()
            if df is not None and not df.empty:
                return {
                    "source": "xueqiu",
                    "heatIndex": heat_fn(df),
                    "asOf": now,
                    "degraded": degraded,
                }
        except Exception as err:  # noqa: BLE001
            degraded.append(
                make_degraded(f"akshare:{name}", asOf=now, note=f"雪球情绪源失败（{err}）")
            )

    # 备源：东财人气榜（需求 #30 双源切换）
    try:
        df = _fetch_rank_em()
        if df is not None and not df.empty:
            degraded.append(
                make_degraded(
                    "akshare:stock_hot_rank_em",
                    asOf=now,
                    note="雪球情绪源不可用，已切换东财人气榜备源（heatIndex 量纲不同）",
                )
            )
            return {
                "source": "eastmoney",
                "heatIndex": _em_heat(df),
                "asOf": now,
                "degraded": degraded,
            }
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded("akshare:stock_hot_rank_em", asOf=now, note=f"东财备源也失败（{err}）")
        )

    return {"source": None, "heatIndex": None, "asOf": now, "degraded": degraded}
