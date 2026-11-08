"""数据可得性探针（对抗审查工作流用）：真实拉取日历/日线/快照，输出 JSON 摘要。

成功 → exit 0；任何异常 → exit 1（traceback 走 stderr）。
缓存目录：仓库 data/（与 CLI 同一份），同日快照走日缓存。
"""
import json
import sys
import traceback

sys.path.insert(0, "python")


def main() -> int:
    from djiucai_data.calendar import get_calendar
    from djiucai_data.snapshot import get_snapshot

    cal, cal_deg = get_calendar()
    cal_summary = {
        "calendar_days": len(cal),
        "calendar_latest": cal[-1] if cal else None,
        "calendar_degraded": bool(cal_deg),
    }
    print(json.dumps(cal_summary, ensure_ascii=False))

    snap = get_snapshot("SH000001")
    snap_summary = {
        "tradeDate": snap["tradeDate"],
        "bars": len(snap["bars"]),
        "latest_close": snap["bars"][-1]["close"] if snap["bars"] else None,
        "volatility20": snap["volatility20"],
        "limitUp": snap["breadth"]["limitUp"],
        "advancers": snap["breadth"]["advancers"],
        "news_items": len(snap["news"]["items"]),
        "sentiment_source": snap["sentiment"]["source"],
        "margin_ok": snap["funds"]["marginBalance"] is not None,
        "degraded_sources": [d["source"] for d in snap["degraded"] if d.get("degraded")],
    }
    print(json.dumps(snap_summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(1)
