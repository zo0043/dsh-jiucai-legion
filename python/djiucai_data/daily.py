"""指数日线（需求 #42 交叉校验 / #45 首跑回补 250 日 / #46 盘中锚定最近收盘日）。

- 主源 akshare ``stock_zh_index_daily``（新浪，接口名与返回列 date/open/high/low/close/volume
  已按 akshare 1.20.34 源码确认）。
- 增量缓存 data/cache/daily/{index}.json：全量追加、按日期去重（新数据覆盖旧值）、升序排序。
- baostock 交叉校验最后 1 根 OHLC：偏差 > 0.1% 记入 degraded（数据仍以 akshare 为准，需求 #42）。
- 不新鲜判定（需求 #24/#46）：最新 bar 日期 < 最近交易日（Asia/Shanghai）→ 结果带 ``stale=True``，
  是否硬失败由 TS 侧决定。
"""

from __future__ import annotations

import contextlib
import io
import math
from typing import Any, Optional, TypedDict

import akshare as ak
import pandas as pd

from . import cache
from ._common import make_degraded, today_sh
from .calendar import get_calendar, latest_trade_date
from .retry import with_retry

OP = "daily"

#: 业务指数 → akshare 新浪符号（文档要求 SH000001→sh000001、CSI300→sh000300）。
INDEX_SYMBOLS = {"SH000001": "sh000001", "CSI300": "sh000300"}

#: 业务指数 → baostock 代码（交叉校验用）。
BAOSTOCK_CODES = {"SH000001": "sh.000001", "CSI300": "sh.000300"}


class Bar(TypedDict):
    """单根日线（对齐技术设计 §4 MarketSnapshot.bars 元素）。"""

    date: str
    open: float
    high: float
    low: float
    close: float
    volume: float


def _normalize_bars(df: pd.DataFrame) -> list[Bar]:
    """akshare 日线 DataFrame → Bar 列表（date 升序、数值化、非有限值行剔除）。

    NaN/Inf 防护（F33）：``float("nan")`` 可通过 float() 但会让 ``json.dumps`` 产出
    裸 NaN 毒化行式 JSON 协议（TS 侧 JSON.parse 直接失败），任一数值字段非有限值
    的行一律剔除，不让坏数据进协议与缓存。
    """
    if df is None or df.empty:
        return []
    out: list[Bar] = []
    for row in df.itertuples(index=False):
        try:
            d = str(pd.Timestamp(getattr(row, "date")).date())
            bar: Bar = {
                "date": d,
                "open": float(getattr(row, "open")),
                "high": float(getattr(row, "high")),
                "low": float(getattr(row, "low")),
                "close": float(getattr(row, "close")),
                "volume": float(getattr(row, "volume")),
            }
        except (TypeError, ValueError):
            continue
        if not all(
            math.isfinite(bar[k]) for k in ("open", "high", "low", "close", "volume")
        ):
            continue
        out.append(bar)
    out.sort(key=lambda b: b["date"])
    return out


def _merge_bars(cached: list[Bar], fresh: list[Bar]) -> list[Bar]:
    """合并缓存与新鲜数据：按日期去重（新鲜覆盖旧值）、按日期升序（增量缓存 #42）。"""
    by_date: dict[str, Bar] = {b["date"]: b for b in cached}
    for b in fresh:
        by_date[b["date"]] = b
    return [by_date[d] for d in sorted(by_date)]


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_index_daily(symbol: str) -> pd.DataFrame:
    """主源 akshare 新浪指数日线（全量历史，增量由本地缓存合并）。"""
    return ak.stock_zh_index_daily(symbol=symbol)


def _cross_check_with_baostock(index: str, last_bar: Bar) -> Optional[str]:
    """baostock 交叉校验最后 1 根 OHLC（需求 #42）。

    :return: None=校验通过或未执行；str=degraded 说明（偏差超阈或 baostock 失败）。
    数据无论如何以 akshare 为准。
    """
    try:
        import baostock  # 延迟导入：登录/查询会向 stdout 打印，必须在静音包内

        code = BAOSTOCK_CODES.get(index)
        if code is None:
            return None
        # baostock login/query/logout 会 print 到 stdout，须静音保护协议通道（#42）
        with contextlib.redirect_stdout(io.StringIO()):
            login_result = baostock.login()
            if not getattr(login_result, "error_code", None) == "0":
                baostock.logout()
                return "baostock 交叉校验登录失败，跳过校验（数据以 akshare 为准）"
            field_order = "date,open,high,low,close,volume"
            rs = baostock.query_history_k_data_plus(
                code,
                field_order,
                start_date=last_bar["date"],
                end_date=last_bar["date"],
                frequency="d",
                adjustflag="3",
            )
            row_values: list[str] = []
            while (rs.error_code == "0") and rs.next():
                row_values = rs.get_row_data()
            baostock.logout()
        if not row_values:
            return "baostock 交叉校验无该日数据，跳过校验（数据以 akshare 为准）"
        # baostock get_row_data() 返回与请求字段同序的位置列表
        row = dict(zip(field_order.split(","), row_values))
        for field in ("open", "high", "low", "close"):
            try:
                bs_val = float(row[field])
            except (KeyError, TypeError, ValueError):
                return "baostock 交叉校验字段缺失，跳过校验（数据以 akshare 为准）"
            if bs_val <= 0:
                continue
            deviation = abs(last_bar[field] - bs_val) / bs_val
            if deviation > 0.001:  # 偏差 > 0.1%（需求 #42）
                return (
                    f"baostock 交叉校验 {field} 偏差 {deviation:.4%} 超过 0.1%"
                    f"（akshare={last_bar[field]}, baostock={bs_val}，数据以 akshare 为准）"
                )
        return None
    except Exception as err:  # noqa: BLE001 - 校验失败不影响主数据
        return f"baostock 交叉校验失败（{err}），数据以 akshare 为准"


def get_daily_bars(index: str, days: int = 250) -> dict[str, Any]:
    """返回 ``{bars, stale, asOf, degraded}``。

    - bars：最近 ``days`` 根 Bar（首跑回补 250 交易日，需求 #45）。
    - stale：True=最新 bar 落后最近交易日（TS 侧决定硬失败，需求 #24）；
      None=日历不可用无法判定。
    - akshare 主源失败 → 回退本地缓存 + degraded；缓存也为空 → 抛异常（行情属硬失败类，#24）。
    """
    if index not in INDEX_SYMBOLS:
        raise ValueError(f"未知指数 {index}，可选：{sorted(INDEX_SYMBOLS)}")
    degraded: list[dict] = []
    fresh_bars: list[Bar] = []
    try:
        fresh_bars = _normalize_bars(_fetch_index_daily(INDEX_SYMBOLS[index]))
    except Exception as err:  # noqa: BLE001
        cached_only = cache.load_cache(OP, index)
        if isinstance(cached_only, dict) and isinstance(cached_only.get("bars"), list):
            bars = [b for b in cached_only["bars"] if isinstance(b, dict)]
            degraded.append(
                make_degraded(
                    "akshare:stock_zh_index_daily",
                    asOf=(bars[-1]["date"] if bars else None),
                    note=f"日线主源失败（{err}），已回退本地缓存",
                )
            )
        else:
            raise
    else:
        cached = cache.load_cache(OP, index)
        cached_bars = cached.get("bars") if isinstance(cached, dict) else None
        bars = _merge_bars(
            [b for b in (cached_bars or []) if isinstance(b, dict)], fresh_bars
        )
        cache.save_cache(OP, index, {"bars": bars, "asOf": today_sh()})
        # 交叉校验仅对刚拉到的新鲜数据做（缓存回放无需重复校验）
        if bars and fresh_bars:
            note = _cross_check_with_baostock(index, bars[-1])
            if note:
                degraded.append(make_degraded("baostock:cross_check", asOf=bars[-1]["date"], note=note))

    # 不新鲜判定（需求 #24/#46）：最新 bar 日期 < 最近交易日 → stale
    stale: Optional[bool] = None
    try:
        trade_dates, cal_degraded = get_calendar()
        degraded.extend(cal_degraded)
        recent = latest_trade_date(trade_dates)
        if recent is None:
            stale = None
            degraded.append(
                make_degraded(
                    "calendar", asOf=None, note="交易日历不可用，无法判定行情新鲜度"
                )
            )
        else:
            stale = bool(bars and bars[-1]["date"] < recent)
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded("calendar", asOf=None, note=f"交易日历异常，无法判定新鲜度（{err}）")
        )

    return {
        "bars": bars[-days:] if days and days > 0 else bars,
        "stale": stale,
        "asOf": (bars[-1]["date"] if bars else None),
        "degraded": degraded,
    }
