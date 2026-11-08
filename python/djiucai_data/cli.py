"""子进程入口（技术设计 §6：启动握手 → stdin 循环 → SIGTERM 优雅退出）。

启动后先向 stdout 打印一行握手 ``{"ready":true,...}``，随后进入协议主循环。
TS 宿主以 ``.venv/bin/python -m djiucai_data.cli``（或 python/djiucai_data/cli.py）
拉起本进程（需求 #6）。
"""

from __future__ import annotations

import json
import os
import signal
import sys

from . import __version__, protocol


def _on_sigterm(signum: int, frame: object) -> None:
    """SIGTERM 优雅退出（需求 #42 崩溃恢复约定）。

    - 空闲期（阻塞在 readline）：PEP 475 会自动重试被信号打断的读，仅置标志退不出，
      因此抛 GracefulExit 让主循环立即优雅退出。
    - 正在处理请求：只置 STOP_FLAG，处理完当前请求并写出响应后退出。
    """
    protocol.STOP_FLAG["stop"] = True
    if not protocol.PROCESSING["busy"]:
        raise protocol.GracefulExit()


def main() -> None:
    """入口：握手 → 装信号 → serve 循环。"""
    try:
        signal.signal(signal.SIGTERM, _on_sigterm)
    except (ValueError, OSError):  # 非主线程等场景下装不上信号也不致命
        pass
    handshake = {
        "ready": True,
        "version": __version__,
        "pid": os.getpid(),
        "ops": ["ping", "getCalendar", "getDailyBars", "getSnapshot"],
    }
    sys.stdout.write(json.dumps(handshake, ensure_ascii=False) + "\n")
    sys.stdout.flush()
    protocol.serve()


if __name__ == "__main__":
    main()
