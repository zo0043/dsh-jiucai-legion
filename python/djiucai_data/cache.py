"""本地缓存读写（data/cache/{op}/{key}.json）。

对应需求：#24（缓存降级）、#37（交易日历缓存）、#42（缓存全量保留、不做自动清理、
写入用临时文件 + rename 原子替换）。目录不存在时自动创建。
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any, Optional

from ._common import data_root


def cache_path(op: str, key: str) -> Any:
    """返回缓存文件绝对路径 data/cache/{op}/{key}.json（key 可含子目录分段）。"""
    safe_key = str(key).strip().replace("/", "_").replace("\\", "_")
    return data_root() / "cache" / op / f"{safe_key}.json"


def load_cache(op: str, key: str) -> Optional[Any]:
    """读缓存；不存在或解析失败返回 None（缓存损坏视为无缓存，不抛异常）。"""
    path = cache_path(op, key)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def save_cache(op: str, key: str, payload: Any) -> None:
    """写缓存（原子写：临时文件 + os.replace；全量覆盖，保留全部历史数据 #42）。

    序列化禁 NaN/Inf（allow_nan=False，F33）：含非有限值的载荷不入缓存——#42 全量
    保留不清理，一旦写入会反复毒化后续请求。写失败不致命：数据管道继续走内存结果。
    """
    path = cache_path(op, key)
    tmp_name: Optional[str] = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, allow_nan=False)
        os.replace(tmp_name, str(path))
    except (OSError, ValueError):
        if tmp_name is not None:
            try:
                os.unlink(tmp_name)
            except OSError:
                pass
        # 缓存写失败不致命：数据管道继续走内存结果，只把原因写到 stderr。
        import sys

        print(f"[djiucai_data] 缓存写入失败 op={op} key={key}", file=sys.stderr)
