"""行式 JSON 协议（技术设计 §6，需求 #42 技术默认：stdout JSON + 崩溃由 TS 侧重启恢复）。

请求（stdin 逐行）::

    {"id":1,"op":"getSnapshot","params":{"index":"SH000001"}}

响应（stdout 逐行）::

    {"id":1,"ok":true,"data":...,"asOf":"...","degraded":[...],"error":null}

- 响应固定六键：id / ok / data / asOf / degraded / error。
- 扩展键：行情类 op（getDailyBars / getSnapshot）额外带 ``"stale": true|false|null``
  （不新鲜判定，需求 #24/#46，TS 侧据此决定硬失败）；data 字段名保持对齐技术设计 §4。
- 坏的输入行（非法 JSON / 缺字段）回错误响应，不崩溃、进程继续。
- 支持的 op：ping / getCalendar / getDailyBars / getSnapshot。
"""

from __future__ import annotations

import json
import sys
from typing import IO, Any, Callable, Dict, Optional

from ._common import now_ts_sh, quiet_stdout
from .calendar import get_calendar
from .daily import get_daily_bars
from .snapshot import get_snapshot

__all__ = [
    "handle_line",
    "handle_request",
    "make_response",
    "serve",
    "OPS",
    "STOP_FLAG",
    "PROCESSING",
    "GracefulExit",
]


def _dispatch_daily(params: Dict[str, Any]) -> dict:
    """getDailyBars(index, days) → {bars, stale, asOf, degraded}。"""
    index = params.get("index")
    if not index:
        raise ValueError("缺少参数 index（'SH000001' | 'CSI300'）")
    days = params.get("days", 250)
    days = int(days) if days is not None else 250
    return get_daily_bars(str(index), days=days)


def _dispatch_snapshot(params: Dict[str, Any]) -> dict:
    """getSnapshot(index, date?) → MarketSnapshot 字段（技术设计 §4）。"""
    index = params.get("index")
    if not index:
        raise ValueError("缺少参数 index（'SH000001' | 'CSI300'）")
    date = params.get("date")
    days = int(params.get("days", 250))
    return get_snapshot(str(index), date=str(date) if date else None, days=days)


def _dispatch_calendar(params: Dict[str, Any]) -> dict:
    """getCalendar() → {dates, stale?不带}；无需参数。"""
    dates, degraded = get_calendar()
    return {"dates": dates, "degraded": degraded}


#: op 名 → 处理函数；params 从 req["params"] 读取（缺省 {}）
OPS: Dict[str, Callable[[Dict[str, Any]], dict]] = {
    "getCalendar": _dispatch_calendar,
    "getDailyBars": _dispatch_daily,
    "getSnapshot": _dispatch_snapshot,
}

#: SIGTERM 优雅退出标志（cli.py 的信号处理器置位）
STOP_FLAG: Dict[str, bool] = {"stop": False}

#: 是否正在处理请求（决定 SIGTERM 处理器是「立即退出」还是「处理完再退」）
PROCESSING: Dict[str, bool] = {"busy": False}


class GracefulExit(Exception):
    """SIGTERM 在空闲期到达时由信号处理器抛出，serve 捕获后优雅退出。"""


def make_response(
    req_id: Any,
    ok: bool,
    data: Any = None,
    degraded: Optional[list] = None,
    error: Optional[str] = None,
    stale: Any = None,
    include_stale: bool = False,
) -> dict:
    """构造标准响应。

    :param stale: 行情新鲜度（仅 include_stale=True 时写入响应，如 getDailyBars/getSnapshot）。
    """
    resp: Dict[str, Any] = {
        "id": req_id,
        "ok": ok,
        "data": data,
        "asOf": now_ts_sh(),
        "degraded": degraded or [],
        "error": error,
    }
    if include_stale:
        resp["stale"] = stale
    return resp


def handle_request(req: Any) -> dict:
    """处理一个已解析的请求对象，返回响应 dict。op 异常转为 ok:false 响应。"""
    if not isinstance(req, dict):
        return make_response(None, False, error="请求必须是 JSON 对象")
    req_id = req.get("id")
    op = req.get("op")
    if op is None:
        return make_response(req_id, False, error="请求缺少 op 字段")
    if op == "ping":
        return make_response(req_id, True, data={"pong": True})
    handler = OPS.get(str(op))
    if handler is None:
        return make_response(
            req_id, False, error=f"未知 op: {op}，可选：{sorted(set(OPS) | {'ping'})}"
        )
    params = req.get("params") or {}
    if not isinstance(params, dict):
        return make_response(req_id, False, error="params 必须是对象")
    try:
        result = handler(params)
    except Exception as err:  # noqa: BLE001 - op 内任何异常不得杀死进程（#42）
        return make_response(req_id, False, error=f"{type(err).__name__}: {err}")
    if not isinstance(result, dict):  # 防御：处理函数必须返回 dict
        return make_response(req_id, True, data={"value": result})
    degraded = result.pop("degraded", [])
    has_stale = "stale" in result
    stale = result.pop("stale", None)
    return make_response(
        req_id, True, data=result, degraded=degraded, stale=stale, include_stale=has_stale
    )


def _dumps(resp: dict) -> str:
    """序列化响应（allow_nan=False，F33）。

    data 含非有限值（NaN/Inf）时 fail-fast 为 ok:false 错误响应，而不是产出裸 NaN
    毒化行式 JSON 协议（TS 侧 JSON.parse 会直接失败并挂到超时）。
    """
    try:
        return json.dumps(resp, ensure_ascii=False, allow_nan=False)
    except ValueError as err:
        return json.dumps(
            make_response(
                resp.get("id"), False,
                error=f"响应包含非有限值（NaN/Inf），已拒绝序列化（{err}）",
            ),
            ensure_ascii=False,
            allow_nan=False,
        )


def handle_line(line: str) -> Optional[str]:
    """一行请求 → 一行响应 JSON 字符串（不含换行）；空行/纯空白返回 None（忽略）。

    坏行容错（需求 #42）：非法 JSON → ok:false + id:null 的错误响应，进程不崩溃。
    """
    stripped = line.strip()
    if not stripped:
        return None
    try:
        req = json.loads(stripped)
    except ValueError as err:
        return json.dumps(
            make_response(None, False, error=f"无法解析的请求行（{err}）"),
            ensure_ascii=False,
            allow_nan=False,
        )
    try:
        resp = handle_request(req)
    except Exception as err:  # noqa: BLE001 - 兜底：分发层自身异常也不杀进程
        resp = make_response(None, False, error=f"内部错误（{type(err).__name__}: {err}）")
    return _dumps(resp)


def serve(stdin: Optional[IO[str]] = None, stdout: Optional[IO[str]] = None) -> None:
    """主循环：逐行读 stdin → 处理 → 逐行写 stdout（每行 flush）。

    - op 执行期间 sys.stdout 静音重定向到 stderr（baostock 登录等会向 stdout 打印），
      响应只经由显式 ``out`` 对象写出，保证协议通道纯净（#42）。
    - SIGTERM 优雅退出（#42）：空闲期（阻塞在 readline）→ 信号处理器抛 GracefulExit
      立即退出；正在处理请求 → 只置 STOP_FLAG，处理完当前请求写出响应后退出。
    - 读到 EOF（stdin 关闭）也退出。
    """
    inp = stdin if stdin is not None else sys.stdin
    out = stdout if stdout is not None else sys.stdout
    try:
        while True:
            if STOP_FLAG.get("stop"):
                break
            line = inp.readline()
            if not line:  # EOF
                break
            PROCESSING["busy"] = True
            try:
                with quiet_stdout():
                    resp = handle_line(line)
            finally:
                PROCESSING["busy"] = False
            if resp is None:
                continue
            out.write(resp + "\n")
            out.flush()
            if STOP_FLAG.get("stop"):
                break
    except GracefulExit:
        pass  # 空闲期 SIGTERM：直接优雅退出
