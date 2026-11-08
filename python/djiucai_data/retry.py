"""重试装饰器（需求 #25：失败重试 2 次 + 东财系版本告警）。

- 失败后指数退避重试 2 次（0.5s / 1s），即总尝试 3 次。
- 东财系接口（akshare 内部请求东方财富的）每次失败额外向 stderr 输出版本告警日志，
  附带 ``akshare.__version__``，便于上游改版后定位失效原因（需求 #25）。
- 日志一律走 stderr，不污染 stdout JSON 协议通道（需求 #42）。
"""

from __future__ import annotations

import functools
import sys
import time
import traceback
from typing import Any, Callable, TypeVar

F = TypeVar("F", bound=Callable[..., Any])

DEFAULT_TIMES = 2          # 重试 2 次（共尝试 3 次），需求 #25
DEFAULT_BACKOFF = 0.5      # 首次退避 0.5s，之后 ×2 → 1s


def _sleep(seconds: float) -> None:
    """退避睡眠（模块级函数，便于测试替换为零延迟）。"""
    time.sleep(seconds)


def _log_eastmoney_version(fn_name: str, err: BaseException) -> None:
    """东财系失败 → 版本告警日志（stderr，需求 #25）。"""
    try:
        import akshare

        version = akshare.__version__
    except Exception:  # pragma: no cover - akshare 一定可用，防御性兜底
        version = "unknown"
    print(
        f"[djiucai_data][版本告警] 东财系接口失败 fn={fn_name} err={err!r} "
        f"akshare={version}",
        file=sys.stderr,
    )
    traceback.print_exc(file=sys.stderr)


def with_retry(
    times: int = DEFAULT_TIMES,
    backoff: float = DEFAULT_BACKOFF,
    eastmoney: bool = False,
) -> Callable[[F], F]:
    """装饰器：失败重试 ``times`` 次（指数退避 backoff, backoff*2, ...）。

    :param times: 重试次数（不含首次），默认 2（需求 #25）。
    :param backoff: 首次退避秒数，默认 0.5s；第 n 次重试前等待 backoff * 2**(n-1)。
    :param eastmoney: True 时每次失败输出 akshare 版本告警（东财系接口，需求 #25）。
    """

    def decorator(fn: F) -> F:
        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            last_err: BaseException | None = None
            for attempt in range(times + 1):
                try:
                    return fn(*args, **kwargs)
                except Exception as err:  # noqa: BLE001 - 数据源失败必须兜底
                    last_err = err
                    if eastmoney:
                        _log_eastmoney_version(fn.__name__, err)
                    if attempt >= times:
                        break
                    _sleep(backoff * (2**attempt))
            assert last_err is not None
            raise last_err

        return wrapper  # type: ignore[return-value]

    return decorator
