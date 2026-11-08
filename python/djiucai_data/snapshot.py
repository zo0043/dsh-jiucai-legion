"""市场快照聚合（对齐技术设计 §4 的 MarketSnapshot Python 侧字段）。

聚合：日线（daily）+ 市场宽度（breadth #22）+ 情绪热度（sentiment #30）+
新闻（news #23）+ 资金面（funds #47），并计算 20 日年化波动率（impact 标定输入 #21）。
legionBullPct（军团看多比例）由 TS 引擎回流计算，Python 侧恒为 null。
degraded 汇总所有子源标注（需求 #24/#32 分级降级）。
"""

from __future__ import annotations

import math
from typing import Any, Optional

from .breadth import get_breadth
from .cache import load_cache, save_cache
from .daily import get_daily_bars
from .funds import get_funds
from .news import get_news
from .sentiment import get_sentiment

#: 年化系数 sqrt(250)（需求 #45：250 交易日口径）
ANNUALIZATION = math.sqrt(250.0)


def volatility20(closes: list[float]) -> Optional[float]:
    """最近 20 个日收益（对数）的样本标准差 × sqrt(250)。

    :param closes: 升序收盘价序列（至少 21 个点才能算 20 个收益）。
    :return: 年化波动率；样本不足或数据异常返回 None。
    """
    if len(closes) < 21:
        return None
    returns = [
        math.log(closes[i] / closes[i - 1])
        for i in range(len(closes) - 20, len(closes))
        if closes[i - 1] > 0 and closes[i] > 0
    ]
    if len(returns) < 20:
        return None
    mean = sum(returns) / len(returns)
    var = sum((r - mean) ** 2 for r in returns) / (len(returns) - 1)  # 样本方差 ddof=1
    return math.sqrt(var) * ANNUALIZATION


def get_snapshot(index: str, date: Optional[str] = None, days: int = 250) -> dict[str, Any]:
    """聚合一次完整快照，字段对齐 MarketSnapshot（§4）。

    :param index: 'SH000001' | 'CSI300'。
    :param date: 锚定交易日 'YYYY-MM-DD'；None=最近一根 bar 的日期（#46 盘中锚定最近收盘日）。
    :param days: 日线回补条数（首跑 250，需求 #45）。
    """
    # 聚合级日缓存：同一交易日内的快照直接复用（akshare 全市场聚合分钟级且上游限流，#42 缓存降级）
    daily = get_daily_bars(index, days=days)
    bars: list[dict[str, Any]] = daily["bars"]

    # 锚定交易日：指定 date 则截取 <= date 的 bars
    if date:
        bars = [b for b in bars if b["date"] <= str(date)]
    trade_date = bars[-1]["date"] if bars else date

    if not date:
        cached = load_cache("snapshot", f"{index}.json")
        if isinstance(cached, dict) and cached.get("tradeDate") == trade_date:
            return cached  # 同一交易日 → 命中

    # 波动率输入：锚定日前最近 21 个收盘
    closes = [b["close"] for b in bars[-21:]]
    vol = volatility20(closes)

    degraded: list[dict] = list(daily["degraded"])
    if vol is None:
        degraded.append(
            {
                "source": "volatility20",
                "asOf": trade_date,
                "degraded": True,
                "note": "收盘样本不足 21 个，无法计算 20 日年化波动率",
            }
        )

    # 市场宽度按锚定交易日取（涨跌停池为日度披露）
    breadth = get_breadth(trade_date)
    degraded.extend(breadth["degraded"])

    sentiment = get_sentiment()
    degraded.extend(sentiment["degraded"])

    news = get_news()
    degraded.extend(news["degraded"])

    funds = get_funds(index)
    degraded.extend(funds["degraded"])

    snapshot = {
        "index": index,
        "tradeDate": trade_date,
        "bars": bars,
        "breadth": {
            "limitUp": breadth["limitUp"],
            "limitDown": breadth["limitDown"],
            "failedBoard": breadth["failedBoard"],
            "maxStreak": breadth["maxStreak"],
            "advancers": breadth["advancers"],
            "decliners": breadth["decliners"],
        },
        "sentiment": {
            "source": sentiment["source"],
            "heatIndex": sentiment["heatIndex"],
            "asOf": sentiment["asOf"],
        },
        "news": {"items": news["items"], "asOf": news["asOf"]},
        "funds": {
            "marginBalance": funds["marginBalance"],
            "northboundNet": funds["northboundNet"],
            "asOf": funds["asOf"],
            "marginAsOf": funds.get("marginAsOf"),
            "northAsOf": funds.get("northAsOf"),
        },
        "volatility20": vol,
        "legionBullPct": None,  # 军团看多比例由 TS 引擎回流计算（#50）
        "degraded": degraded,
    }
    if not date:
        # 仅缓存「最近锚定」快照；指定历史日期的请求不落缓存
        save_cache("snapshot", f"{index}.json", snapshot)
    return snapshot
