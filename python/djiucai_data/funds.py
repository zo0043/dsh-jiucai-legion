"""资金面（需求 #47 口径：两融 T+1 可得取最近可得 + asOf 标注；北向盘后口径）。

- 两融余额：``stock_margin_sse(start_date, end_date)``（上交所融资融券汇总，接口名与
  「信用交易日期/融资融券余额」列已按 akshare 1.20.34 源码确认）。两融 T+1 披露，
  取最近可得一条并在 asOf 标注实际交易日期。
- 北向：``stock_hsgt_fund_flow_summary_em()``（东财沪深港通资金流向，盘后披露口径）。
  需求 #47：上证→沪股通；沪深300→沪股通+深股通合计。绝不使用盘中北向估算。
  「板块」行值过滤已按 2026-11-06 真实冒烟核实；上游自 2024-08 停止披露每日北向
  净买额后接口返回 0 占位，此时置 null 并标注（见 _north_is_undisclosed）。
- 南向（v1.4 #59）：港股通(沪)+港股通(深) 合计作「资金分流」signals——日频真实披露，
  但**不得充当北向代理**；与北向共用同一次 summary_em 响应（get_funds 只拉一次，零重复出网）。
  任何结构意外都会安全降级为 null + degraded 标注。
"""

from __future__ import annotations

import math
from datetime import timedelta
from typing import Any, Optional

import akshare as ak
import pandas as pd

from ._common import fmt_ts, make_degraded, now_sh, today_sh
from .retry import with_retry

#: 业务指数 → 北向板块过滤（需求 #47 口径：一期不做成分过滤，取最贴近口径）
NORTH_BOARDS = {
    "SH000001": ["沪股通"],
    "CSI300": ["沪股通", "深股通"],
}

MARGIN_LOOKBACK_DAYS = 40  # 两融查询回看窗口，取最近可得一条


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_margin() -> pd.DataFrame:
    """上交所两融汇总（东财/上交所系，需求 #25 版本告警）。"""
    end = today_sh().replace("-", "")
    start = (pd.Timestamp(today_sh()) - timedelta(days=MARGIN_LOOKBACK_DAYS)).strftime("%Y%m%d")
    return ak.stock_margin_sse(start_date=start, end_date=end)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_hsgt_summary() -> pd.DataFrame:
    """东财沪深港通资金流向汇总（盘后口径）。"""
    return ak.stock_hsgt_fund_flow_summary_em()


def get_margin_balance() -> dict[str, Any]:
    """返回 ``{marginBalance, asOf, degraded}``；asOf 为两融数据实际交易日（T+1 标注 #47）。"""
    degraded: list[dict] = []
    try:
        df = _fetch_margin()
        if df is None or df.empty or "融资融券余额" not in df.columns:
            raise ValueError("两融数据为空或缺列")
        df = df.copy()
        df["_d"] = pd.to_datetime(df["信用交易日期"], errors="coerce")
        df["_v"] = pd.to_numeric(df["融资融券余额"], errors="coerce")
        df = df.dropna(subset=["_d", "_v"]).sort_values("_d")
        if df.empty:
            raise ValueError("两融数据无可解析行")
        last = df.iloc[-1]
        return {
            "marginBalance": float(last["_v"]),
            "asOf": last["_d"].strftime("%Y-%m-%d"),
            "degraded": degraded,
        }
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded("akshare:stock_margin_sse", asOf=None, note=f"两融余额获取失败（{err}）")
        )
        return {"marginBalance": None, "asOf": None, "degraded": degraded}


def _to_finite(x: Any) -> Optional[float]:
    """数值清洗：可解析且有限才返回 float（NaN/Inf → None，F33 协议红线）。"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _north_value(row: pd.Series) -> Optional[float]:
    """优先「成交净买额」，缺失时回退「资金净流入」（单位均为亿元，akshare 已换算）。"""
    for col in ("成交净买额", "资金净流入"):
        if col in row.index:
            val = pd.to_numeric(pd.Series([row[col]]), errors="coerce").iloc[0]
            if pd.notna(val):
                return float(val)
    return None


def _north_is_undisclosed(row: pd.Series) -> bool:
    """北向净买额是否属于「上游未再披露」的 0 占位值。

    2024-08 起交易所停止披露每日北向净买入，接口对北向板块返回 0.0 占位
    （2026-11-06 实测：沪股通/深股通 成交净买额=资金净流入=0.0，港股通行有真实值）。
    两列同时为 0 视为未披露——返回 null 比误报「净流入为零」更诚实（需求 #47 拒用估算）。
    """
    for col in ("成交净买额", "资金净流入"):
        if col not in row.index:
            return False
        val = pd.to_numeric(pd.Series([row[col]]), errors="coerce").iloc[0]
        if pd.isna(val) or float(val) != 0.0:
            return False
    return True


def get_northbound(index: str, df: Optional[pd.DataFrame] = None) -> dict[str, Any]:
    """返回 ``{northboundNet, asOf, degraded}``（盘后口径，亿元）。

    SH000001→沪股通；CSI300→沪股通+深股通合计（需求 #47）。失败 → null + 标注。
    :param df: 预取的 summary_em 响应（零重复出网：get_funds 同一次响应同时解析北向/南向，
        #59）；None 时自行拉取（独立调用入口，funds.py 原行为）。
    """
    degraded: list[dict] = []
    boards = NORTH_BOARDS.get(index)
    if boards is None:
        raise ValueError(f"未知指数 {index}，可选：{sorted(NORTH_BOARDS)}")
    try:
        if df is None:
            df = _fetch_hsgt_summary()
        if df is None or df.empty or "板块" not in df.columns:
            raise ValueError("沪深港通数据为空或缺板块列")
        # 行值过滤已按 2026-11-06 实测核实：板块 ∈ {沪股通, 深股通, 港股通(沪), 港股通(深)}
        sub = df[df["板块"].astype(str).str.contains("|".join(boards), na=False)]
        sub = sub.copy()
        sub["_d"] = pd.to_datetime(sub["交易日"], errors="coerce")
        sub = sub.dropna(subset=["_d"]).sort_values("_d")
        if sub.empty:
            raise ValueError("无匹配北向板块行")
        as_of = sub["_d"].max().strftime("%Y-%m-%d")
        latest = sub[sub["_d"] == sub["_d"].max()]
        total = 0.0
        matched = False
        undisclosed = True  # 所有板块行都为 0 占位 → 判定未披露
        for _, row in latest.iterrows():
            val = _north_value(row)
            if val is not None:
                total += val
                matched = True
                if not _north_is_undisclosed(row):
                    undisclosed = False
        if not matched:
            raise ValueError("北向净买额列均为空（上游可能未披露）")
        if undisclosed and total == 0.0:
            degraded.append(
                make_degraded(
                    "akshare:stock_hsgt_fund_flow_summary_em",
                    asOf=as_of,
                    note="上游自 2024-08 起停止披露每日北向净买额（0 为占位值），字段置空",
                )
            )
            return {"northboundNet": None, "asOf": as_of, "degraded": degraded}
        return {"northboundNet": total, "asOf": as_of, "degraded": degraded}
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded(
                "akshare:stock_hsgt_fund_flow_summary_em",
                asOf=None,
                note=f"北向盘后数据获取失败（{err}），字段置空",
            )
        )
        return {"northboundNet": None, "asOf": None, "degraded": degraded}


def get_southbound(df: Optional[pd.DataFrame] = None) -> dict[str, Any]:
    """南向资金（港股通(沪)+港股通(深) 合计，亿元）——「资金分流」signals（#59）。

    南向日频真实披露（2026-11-11 实测 +45.72 亿）；**只能作资金分流 signals，
    任何字段、任何文案不得充当北向代理**（#59）。取「成交净买额」列：南向行的
    「资金净流入」为 420.0 额度口径占位（2026-11-12 实测），不适用净买语义，故不做
    北向那样的双列回退。失败 → null + 标注。
    """
    degraded: list[dict] = []
    try:
        if df is None:
            df = _fetch_hsgt_summary()
        if df is None or df.empty or "板块" not in df.columns:
            raise ValueError("沪深港通数据为空或缺板块列")
        sub = df[df["板块"].astype(str).str.contains("港股通", na=False)].copy()
        sub["_d"] = pd.to_datetime(sub["交易日"], errors="coerce")
        sub = sub.dropna(subset=["_d"]).sort_values("_d")
        if sub.empty:
            raise ValueError("无港股通行")
        as_of = sub["_d"].max().strftime("%Y-%m-%d")
        latest = sub[sub["_d"] == sub["_d"].max()]
        if "成交净买额" not in latest.columns:
            raise ValueError("缺成交净买额列")
        total = pd.to_numeric(latest["成交净买额"], errors="coerce").sum()
        value = _to_finite(total)
        if value is None:
            raise ValueError("港股通成交净买额不可解析")
        return {"southboundNet": value, "asOf": as_of, "degraded": degraded}
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded(
                "akshare:stock_hsgt_fund_flow_summary_em",
                asOf=None,
                note=f"南向资金获取失败（{err}），字段置空",
            )
        )
        return {"southboundNet": None, "asOf": None, "degraded": degraded}


def get_funds(index: str) -> dict[str, Any]:
    """聚合资金面：``{marginBalance, northboundNet, southboundNetYi, asOf, marginAsOf,
    northAsOf, southboundAsOf, degraded}``。

    asOf = 两融/北向中较新者（块级口径，测试锁定）；marginAsOf/northAsOf 为各字段
    实际交易日（数据流分析修复：两融 T+1 与北向披露日不同，注入 Agent 的信息集
    必须按字段标注各自截至日，不得让 T+1 的两融冒用北向的新日期）。
    southboundNetYi/southboundAsOf：南向资金分流 signals（#59，不作北向代理）——与北向
    共用**同一次** stock_hsgt_fund_flow_summary_em 响应，零重复出网（#59/#63）。
    """
    margin = get_margin_balance()
    # 零重复出网：北向与南向共用同一次 summary_em 响应，只在此处拉取一次
    try:
        hsgt_df: Optional[pd.DataFrame] = _fetch_hsgt_summary()
    except Exception:  # noqa: BLE001 - 拉取失败 → 空表：北向/南向解析各自安全降级（#24）
        # 失败详情已由 with_retry 的东财系版本告警落 stderr（#25）
        hsgt_df = pd.DataFrame()
    north = get_northbound(index, df=hsgt_df)
    south = get_southbound(df=hsgt_df)
    degraded = margin["degraded"] + north["degraded"] + south["degraded"]
    # funds.asOf 取两者中较新者；都为空则取当前时刻
    candidates = [a for a in (margin["asOf"], north["asOf"]) if a]
    as_of = max(candidates) if candidates else fmt_ts(now_sh())
    return {
        "marginBalance": margin["marginBalance"],
        "northboundNet": north["northboundNet"],
        "southboundNetYi": south["southboundNet"],
        "asOf": as_of,
        "marginAsOf": margin["asOf"],
        "northAsOf": north["asOf"],
        "southboundAsOf": south["asOf"],
        "degraded": degraded,
    }
