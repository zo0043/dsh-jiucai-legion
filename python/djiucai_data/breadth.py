"""市场宽度（需求 #22：涨停池 / 跌停池 / 炸板 / 连板高度 / 涨跌家数，全市场口径 #47）。

任一子源失败 → 该字段 null + degraded 标注，不整单失败（需求 #24）。
接口名与返回列已按 akshare 1.20.34 源码确认：
- ``stock_zt_pool_em(date)``：涨停股池，含「连板数」列 → 连板高度取最大值。
- ``stock_zt_pool_dtgc_em(date)``：跌停股池。
- ``stock_zt_pool_zbgc_em(date)``：炸板股池。
- ``stock_zh_a_spot_em()``：全市场快照，含「涨跌幅」列 → 涨跌家数聚合。
"""

from __future__ import annotations

from typing import Any, Optional

import akshare as ak
import pandas as pd

from ._common import make_degraded, today_sh
from .retry import with_retry


def _norm_date(date: Optional[str]) -> str:
    """'YYYY-MM-DD' → 'YYYYMMDD'；None → 今天（Asia/Shanghai）。"""
    if not date:
        return today_sh().replace("-", "")
    return str(date).replace("-", "")


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _zt_pool(date: str) -> pd.DataFrame:
    """涨停股池（东财系，需求 #25 版本告警）。"""
    return ak.stock_zt_pool_em(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _dt_pool(date: str) -> pd.DataFrame:
    """跌停股池（东财系）。"""
    return ak.stock_zt_pool_dtgc_em(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _zb_pool(date: str) -> pd.DataFrame:
    """炸板股池（东财系）。"""
    return ak.stock_zt_pool_zbgc_em(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _spot_all() -> pd.DataFrame:
    """全市场A股快照（东财系，涨跌家数的重备源；主源为乐咕活跃度单表，见下）。"""
    return ak.stock_zh_a_spot_em()


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _activity_legu() -> pd.DataFrame:
    """乐咕乐股赚钱效应分析：单次轻量调用含 上涨/下跌/涨停/跌停（getSnapshot 提速主路径）。"""
    return ak.stock_market_activity_legu()


def _legu_counts() -> Optional[dict[str, float]]:
    """从活跃度表提取 {上涨, 下跌, 涨停, 跌停}；结构异常返回 None。"""
    try:
        df = _activity_legu()
        m = dict(zip(df["item"].astype(str), pd.to_numeric(df["value"], errors="coerce")))
        if "上涨" in m and "下跌" in m:
            return m
    except Exception:  # noqa: BLE001 - 备源失败走全市场快照
        return None
    return None


def _safe_len(df: Optional[pd.DataFrame]) -> Optional[int]:
    return int(len(df)) if df is not None else None


def _safe_max_streak(df: Optional[pd.DataFrame]) -> Optional[int]:
    """连板高度 = 「连板数」列最大值；空池返回 0。"""
    if df is None:
        return None
    if df.empty or "连板数" not in df.columns:
        return 0
    values = pd.to_numeric(df["连板数"], errors="coerce").dropna()
    return int(values.max()) if not values.empty else 0


def get_breadth(date: Optional[str] = None) -> dict[str, Any]:
    """返回 ``{limitUp, limitDown, failedBoard, maxStreak, advancers, decliners, degraded}``。

    涨跌家数用全市场快照「涨跌幅」聚合（需求 #22 口径，全市场、不做成分过滤 #47）。
    """
    d8 = _norm_date(date)
    as_of = f"{d8[:4]}-{d8[4:6]}-{d8[6:]}"
    degraded: list[dict] = []
    result: dict[str, Any] = {
        "limitUp": None,
        "limitDown": None,
        "failedBoard": None,
        "maxStreak": None,
        "advancers": None,
        "decliners": None,
    }

    def _pool(name: str, fetcher, field: str) -> Optional[pd.DataFrame]:
        try:
            return fetcher()
        except Exception as err:  # noqa: BLE001 - 单源失败不整单失败（#24）
            degraded.append(
                make_degraded(name, asOf=as_of, note=f"{field} 获取失败（{err}）")
            )
            return None

    zt = _pool("akshare:stock_zt_pool_em", lambda: _zt_pool(d8), "涨停数")
    dt = _pool("akshare:stock_zt_pool_dtgc_em", lambda: _dt_pool(d8), "跌停数")
    zb = _pool("akshare:stock_zt_pool_zbgc_em", lambda: _zb_pool(d8), "炸板数")

    result["limitUp"] = _safe_len(zt)
    result["maxStreak"] = _safe_max_streak(zt)
    result["limitDown"] = _safe_len(dt)
    result["failedBoard"] = _safe_len(zb)

    # 涨跌家数：主源乐咕活跃度（单次轻量调用，getSnapshot 提速）；备源全市场快照聚合
    legu = None
    try:
        legu = _legu_counts()
    except Exception:  # noqa: BLE001
        legu = None
    if legu is not None:
        result["advancers"] = int(legu["上涨"])
        result["decliners"] = int(legu["下跌"])
        # 池接口失败时用活跃度表兜底涨停/跌停计数
        if result["limitUp"] is None and "涨停" in legu:
            result["limitUp"] = int(legu["涨停"])
            degraded.append(make_degraded("akshare:stock_zt_pool_em", asOf=as_of, note="涨停数改用活跃度表兜底"))
        if result["limitDown"] is None and "跌停" in legu:
            result["limitDown"] = int(legu["跌停"])
            degraded.append(make_degraded("akshare:stock_zt_pool_dtgc_em", asOf=as_of, note="跌停数改用活跃度表兜底"))
    else:
        try:
            spot = _spot_all()
            if spot is not None and not spot.empty and "涨跌幅" in spot.columns:
                pct = pd.to_numeric(spot["涨跌幅"], errors="coerce").dropna()
                result["advancers"] = int((pct > 0).sum())
                result["decliners"] = int((pct < 0).sum())
            else:
                result["advancers"] = None
                result["decliners"] = None
                degraded.append(
                    make_degraded("akshare:stock_zh_a_spot_em", asOf=as_of, note="涨跌家数：快照为空或缺涨跌幅列")
                )
        except Exception as err:  # noqa: BLE001
            degraded.append(
                make_degraded("akshare:stock_zh_a_spot_em", asOf=as_of, note=f"涨跌家数获取失败（{err}）")
            )

    result["degraded"] = degraded
    return result
