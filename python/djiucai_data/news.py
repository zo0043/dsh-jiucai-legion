"""新闻快讯双源（需求 #23：新浪快讯（稳）+ 财联社电报互备，2026-05 财联社断过 #34）。

- 主源新浪：``stock_info_global_sina()``（接口名与「时间/内容」列已按 akshare 1.20.34 源码确认）。
  注：akshare 1.20.34 中财联社电报的接口名是 ``stock_info_global_cls``，任务描述中的
  ``stock_telegraph_cls`` 在该版本不存在（已用 dir(akshare) 核实）。
- 备源财联社：``stock_info_global_cls(symbol="全部")``（列：标题/内容/发布日期/发布时间）。
- 双源都挂 → 空列表 + degraded；情绪/新闻为零回补点态快照（需求 #45）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import akshare as ak
import pandas as pd

from ._common import SHANGHAI_TZ, fmt_ts, make_degraded, now_sh
from .retry import with_retry

MAX_ITEMS = 30  # 最多返回 30 条（需求 #23）


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_sina() -> pd.DataFrame:
    """新浪全球财经快讯（主源）。"""
    return ak.stock_info_global_sina()


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_cls() -> pd.DataFrame:
    """财联社电报（备源，东财系封装走版本告警 #25）。"""
    return ak.stock_info_global_cls(symbol="全部")


def _parse_ts(raw: Any) -> str:
    """任意时间表达 → "YYYY-MM-DD HH:MM:SS"（Asia/Shanghai）；解析失败返回原字符串。"""
    try:
        ts = pd.Timestamp(raw)
        if ts.tzinfo is not None:
            ts = ts.tz_convert(SHANGHAI_TZ)
        return ts.strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return str(raw) if raw is not None else ""


def _sina_items(df: pd.DataFrame) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for _, row in df.iterrows():
        items.append(
            {"text": str(row.get("内容", "")), "ts": _parse_ts(row.get("时间")), "source": "sina"}
        )
    return items


def _cls_items(df: pd.DataFrame) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for _, row in df.iterrows():
        title = str(row.get("标题", "") or "")
        content = str(row.get("内容", "") or "")
        text = f"{title} {content}".strip() if title and title != "nan" else content.strip()
        # 财联社返回「发布日期」（date）+「发布时间」（time）两列，合并为完整时间戳
        ts_raw = None
        d, t = row.get("发布日期"), row.get("发布时间")
        if d is not None and t is not None:
            try:
                ts_raw = datetime.combine(
                    pd.Timestamp(d).date(), datetime.strptime(str(t), "%H:%M:%S").time()
                )
            except (TypeError, ValueError):
                ts_raw = f"{d} {t}"
        else:
            ts_raw = d
        items.append({"text": text, "ts": _parse_ts(ts_raw), "source": "cls"})
    return items


def _dedup_newest_first(items: list[dict[str, str]]) -> list[dict[str, str]]:
    """按时间倒序去重（文本相同视为同一条），取前 MAX_ITEMS 条。"""
    seen: set[str] = set()
    unique: list[dict[str, str]] = []
    for item in items:
        key = item["text"]
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    # ts 为 ISO 风格定宽字符串，字符串排序即时间排序；无法解析的排最后
    unique.sort(key=lambda x: x["ts"], reverse=True)
    return unique[:MAX_ITEMS]


def get_news() -> dict[str, Any]:
    """返回 ``{items: [{text, ts, source}], asOf, degraded}``。

    source ∈ {'sina', 'cls'}；新浪失败自动切财联社并标注（需求 #23/#34）。
    """
    degraded: list[dict] = []
    now = fmt_ts(now_sh())

    try:
        df = _fetch_sina()
        if df is not None and not df.empty:
            return {
                "items": _dedup_newest_first(_sina_items(df)),
                "asOf": now,
                "degraded": degraded,
            }
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded("akshare:stock_info_global_sina", asOf=now, note=f"新浪快讯失败（{err}）")
        )

    # 备源：财联社电报
    try:
        df = _fetch_cls()
        if df is not None and not df.empty:
            degraded.append(
                make_degraded(
                    "akshare:stock_info_global_cls",
                    asOf=now,
                    note="新浪快讯不可用，已切换财联社电报备源",
                )
            )
            return {
                "items": _dedup_newest_first(_cls_items(df)),
                "asOf": now,
                "degraded": degraded,
            }
    except Exception as err:  # noqa: BLE001
        degraded.append(
            make_degraded("akshare:stock_info_global_cls", asOf=now, note=f"财联社备源也失败（{err}）")
        )

    return {"items": [], "asOf": now, "degraded": degraded}
