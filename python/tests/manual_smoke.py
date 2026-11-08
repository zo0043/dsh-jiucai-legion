"""真实网络冒烟脚本（手动运行，默认不进 pytest 收集——manual_ 前缀）。

用法::

    .venv/bin/python python/tests/manual_smoke.py            # 全量
    .venv/bin/python python/tests/manual_smoke.py calendar   # 单项：calendar/daily/breadth/sentiment/news/funds/snapshot/protocol

逐个真实调用 akshare/baostock，验证 djiucai_data.tested 接口名与返回结构在当前网络
环境下可用（「接口名待运行时冒烟验证」项以此脚本实测为准）。任何单项失败都会打印
原因并继续，最后汇总 PASS/FAIL。

注意：baostock 会在当前工作目录写 log/ 目录；建议在仓库根目录运行。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # python/

RESULTS: list[tuple[str, str, str]] = []  # (name, PASS/FAIL, detail)


def record(name: str, fn) -> None:  # type: ignore[no-untyped-def]
    try:
        detail = fn()
        RESULTS.append((name, "PASS", str(detail)))
        print(f"[PASS] {name}: {detail}")
    except Exception as err:  # noqa: BLE001 - 冒烟脚本必须跑完所有项
        RESULTS.append((name, "FAIL", f"{type(err).__name__}: {err}"))
        print(f"[FAIL] {name}: {type(err).__name__}: {err}")


def smoke_calendar() -> str:
    from djiucai_data.calendar import get_calendar

    dates, degraded = get_calendar()
    assert len(dates) > 200, f"交易日历条数异常: {len(dates)}"
    assert dates == sorted(dates)
    return f"{len(dates)} 个交易日，最新 {dates[-1]}，degraded={degraded}"


def smoke_daily() -> str:
    from djiucai_data.daily import get_daily_bars

    result = get_daily_bars("SH000001", days=10)
    bars = result["bars"]
    assert bars, "无日线数据"
    assert set(bars[0]) == {"date", "open", "high", "low", "close", "volume"}
    return (
        f"最近 bar {bars[-1]['date']} close={bars[-1]['close']} "
        f"stale={result['stale']} degraded={result['degraded']}"
    )


def smoke_breadth() -> str:
    from djiucai_data.breadth import get_breadth

    r = get_breadth()
    return json.dumps({k: v for k, v in r.items() if k != "degraded"}, ensure_ascii=False) + (
        f" degraded={[d['source'] for d in r['degraded']]}"
    )


def smoke_sentiment() -> str:
    from djiucai_data.sentiment import get_sentiment

    r = get_sentiment()
    return f"source={r['source']} heatIndex={r['heatIndex']} degraded={[d['source'] for d in r['degraded']]}"


def smoke_news() -> str:
    from djiucai_data.news import get_news

    r = get_news()
    head = r["items"][0]["text"][:24] if r["items"] else "(空)"
    return f"{len(r['items'])} 条，最新[{r['items'][0]['source'] if r['items'] else '-'}] {head}"


def smoke_funds() -> str:
    from djiucai_data.funds import get_funds

    r = get_funds("SH000001")
    return f"marginBalance={r['marginBalance']} northboundNet={r['northboundNet']} asOf={r['asOf']} degraded={[d['source'] for d in r['degraded']]}"


def smoke_snapshot() -> str:
    from djiucai_data.snapshot import get_snapshot

    snap = get_snapshot("SH000001", days=30)
    assert set(snap) == {
        "index", "tradeDate", "bars", "breadth", "sentiment", "news", "funds",
        "volatility20", "legionBullPct", "degraded",
    }
    return (
        f"tradeDate={snap['tradeDate']} volatility20={snap['volatility20']} "
        f"bars={len(snap['bars'])} news={len(snap['news']['items'])} "
        f"degraded={[d['source'] for d in snap['degraded']]}"
    )


def smoke_protocol() -> str:
    """协议层端到端：子进程内模拟 ping + getCalendar 往返。"""
    import io

    from djiucai_data import protocol

    out = io.StringIO()
    protocol.serve(
        stdin=io.StringIO(
            json.dumps({"id": 1, "op": "ping"}) + "\n"
            + json.dumps({"id": 2, "op": "getCalendar"}) + "\n"
        ),
        stdout=out,
    )
    lines = [json.loads(x) for x in out.getvalue().splitlines()]
    assert lines[0]["data"] == {"pong": True}
    assert lines[1]["ok"] is True and len(lines[1]["data"]["dates"]) > 200
    return f"ping+getCalendar 往返正常（dates={len(lines[1]['data']['dates'])}）"


SMOKES = {
    "calendar": smoke_calendar,
    "daily": smoke_daily,
    "breadth": smoke_breadth,
    "sentiment": smoke_sentiment,
    "news": smoke_news,
    "funds": smoke_funds,
    "snapshot": smoke_snapshot,
    "protocol": smoke_protocol,
}


def main() -> None:
    targets = sys.argv[1:] or list(SMOKES)
    for name in targets:
        if name not in SMOKES:
            print(f"未知冒烟项 {name}，可选：{sorted(SMOKES)}")
            continue
        print(f"--- 冒烟 {name} ---")
        record(name, SMOKES[name])
    failed = [r for r in RESULTS if r[1] == "FAIL"]
    print(f"\n汇总：{len(RESULTS) - len(failed)}/{len(RESULTS)} PASS")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
