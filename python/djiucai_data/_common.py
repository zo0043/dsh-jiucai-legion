"""共享工具：时区、时间格式化、降级标注、数据目录、stdout 静音。

对应需求：#38（Asia/Shanghai 固定时区）、#24（分级降级标注）、#42（技术默认：stdout JSON 协议
必须纯净，第三方库（baostock 登录等）可能向 stdout 打印，故提供 :func:`quiet_stdout`
把 sys.stdout 重定向到 stderr，防止污染协议通道）。
"""

from __future__ import annotations

import contextlib
import io
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator, Optional
from zoneinfo import ZoneInfo

# 需求 #38：所有「盘后 / 次日 / 数据截至日」按 Asia/Shanghai 固定计算，不跟宿主机时区。
SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")

TS_FORMAT = "%Y-%m-%d %H:%M:%S"
DATE_FORMAT = "%Y-%m-%d"


def now_sh() -> datetime:
    """当前 Asia/Shanghai 时间。"""
    return datetime.now(SHANGHAI_TZ)


def fmt_ts(dt: Optional[datetime]) -> Optional[str]:
    """datetime → "YYYY-MM-DD HH:MM:SS"（Asia/Shanghai）；None 透传 None。"""
    if dt is None:
        return None
    return dt.astimezone(SHANGHAI_TZ).strftime(TS_FORMAT)


def now_ts_sh() -> str:
    """当前时刻字符串（响应 asOf 用）。"""
    return fmt_ts(now_sh()) or ""


def today_sh() -> str:
    """当前业务日 "YYYY-MM-DD"（Asia/Shanghai，需求 #38）。"""
    return now_sh().strftime(DATE_FORMAT)


def make_degraded(source: str, asOf: Optional[str] = None, note: str = "") -> dict:
    """构造 degraded 标注条目（需求 #24/#32：来源 + 数据截至日 + 说明）。"""
    entry: dict[str, Any] = {"source": source, "asOf": asOf, "degraded": True}
    if note:
        entry["note"] = note
    return entry


def data_root() -> Path:
    """缓存根目录：环境变量 ``DJIUCAI_DATA_DIR`` 优先，否则相对 cwd 的 ``data``。

    需求 #42：缓存全量保留、不做自动清理。
    """
    env = os.environ.get("DJIUCAI_DATA_DIR")
    if env:
        return Path(env)
    return Path.cwd() / "data"


@contextlib.contextmanager
def quiet_stdout() -> Iterator[None]:
    """把 sys.stdout 临时重定向到 sys.stderr（协议通道保护，需求 #42）。"""
    with contextlib.redirect_stdout(sys.stderr):
        yield
