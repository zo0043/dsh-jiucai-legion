"""pytest 配置：包导入路径 + 零网络 fixture 环境。

- 把 ``python/`` 与本 tests 目录加入 sys.path，使 ``import djiucai_data`` 与
  ``import fakes`` 无需安装即可用。
- autouse fixture：
  * ``isolated_cache`` — DJIUCAI_DATA_DIR 指向 pytest tmp_path，测试互不污染真实缓存；
  * ``no_retry_sleep`` — 重试退避睡眠替换为零延迟，测试不被 0.5s/1s 拖慢。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

PKG_PARENT = Path(__file__).resolve().parents[1]   # python/
TESTS_DIR = Path(__file__).resolve().parent        # python/tests/
for p in (str(PKG_PARENT), str(TESTS_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture(autouse=True)
def isolated_cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """缓存目录隔离到本次测试的 tmp_path/data。"""
    root = tmp_path / "data"
    monkeypatch.setenv("DJIUCAI_DATA_DIR", str(root))
    return root


@pytest.fixture(autouse=True)
def no_retry_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    """重试退避零延迟（否则失败路径每个用例多睡 1.5s）。"""
    from djiucai_data import retry

    monkeypatch.setattr(retry, "_sleep", lambda seconds: None)


@pytest.fixture
def fake_ak_module():
    """返回 akshare 模块对象，便于 ``monkeypatch.setattr(akshare, 'name', fake)``。"""
    import akshare

    return akshare
