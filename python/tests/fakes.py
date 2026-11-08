"""伪造 akshare/baostock 返回值的 DataFrame 工厂（零网络）。

列名与 akshare 1.20.34 真实返回对齐（接口源码核实记录见 djiucai_data 各模块 docstring）。
"""

from __future__ import annotations

from datetime import date

import pandas as pd


def fake_calendar_df(dates: list[str]) -> pd.DataFrame:
    """tool_trade_date_hist_sina 返回：单列 trade_date（datetime.date）。"""
    return pd.DataFrame({"trade_date": [date.fromisoformat(d) for d in dates]})


def fake_index_daily_df(rows: list[dict]) -> pd.DataFrame:
    """stock_zh_index_daily 返回：date/open/high/low/close/volume。"""
    return pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])


def fake_zt_pool_df(streaks: list[int]) -> pd.DataFrame:
    """stock_zt_pool_em 返回（节选）：关键列 连板数。"""
    return pd.DataFrame(
        {"代码": [f"30000{i}" for i in range(len(streaks))], "连板数": streaks}
    )


def fake_spot_df(pcts: list[float]) -> pd.DataFrame:
    """stock_zh_a_spot_em 返回（节选）：关键列 涨跌幅。"""
    return pd.DataFrame({"代码": [f"60000{i}" for i in range(len(pcts))], "涨跌幅": pcts})


def fake_xq_df(values: list[float]) -> pd.DataFrame:
    """stock_hot_follow_xq / stock_hot_tweet_xq 返回（节选）：关注 列为数值。"""
    return pd.DataFrame({"股票简称": [f"股票{i}" for i in range(len(values))], "关注": values})


def fake_rank_em_df(n: int) -> pd.DataFrame:
    """stock_hot_rank_em 返回（节选）：无数值热度列。"""
    return pd.DataFrame(
        {"代码": [f"00000{i}" for i in range(n)], "股票名称": [f"股{i}" for i in range(n)]}
    )


def fake_sina_df(rows: list[tuple[str, str]]) -> pd.DataFrame:
    """stock_info_global_sina 返回：时间/内容。"""
    return pd.DataFrame(rows, columns=["时间", "内容"])


def fake_cls_df(rows: list[tuple[str, str, str, str]]) -> pd.DataFrame:
    """stock_info_global_cls 返回：标题/内容/发布日期/发布时间。"""
    return pd.DataFrame(rows, columns=["标题", "内容", "发布日期", "发布时间"])


def fake_margin_df(rows: list[tuple[str, float]]) -> pd.DataFrame:
    """stock_margin_sse 返回（节选）：信用交易日期/融资融券余额。"""
    return pd.DataFrame(rows, columns=["信用交易日期", "融资融券余额"])


def fake_hsgt_df(rows: list[tuple[str, str, float, float]]) -> pd.DataFrame:
    """stock_hsgt_fund_flow_summary_em 返回（节选）：交易日/板块/成交净买额/资金净流入。"""
    return pd.DataFrame(rows, columns=["交易日", "板块", "成交净买额", "资金净流入"])
