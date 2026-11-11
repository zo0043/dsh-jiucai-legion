#!/usr/bin/env python3
"""机构决策层真实网络探针（v1.4 #58–#64）：复现宪法实测数字 + 端到端联测五路径。

两阶段：
- A（锚点复现，直连 akshare）：M1 沪市序列/全市场账户差分、M2 ETF A股股票型口径、
  M3 龙虎榜/大宗、南向；关键原始帧归档 /tmp/probe_inst_v14/（宪法 #64：实测数字须附
  复现命令与归档路径）。
- B（集成联测）：get_funds → get_institution(funds=...)，验证五路径载荷与零重复出网接线。

运行：.venv/bin/python scripts/institution_probe.py
输出：单行 JSON（stderr 有进度日志）；归档 CSV 于 /tmp/probe_inst_v14/。
"""

from __future__ import annotations

import json
import sys
import time
import traceback
from datetime import timedelta
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "python"))

import akshare as ak  # noqa: E402

from djiucai_data.funds import get_funds  # noqa: E402
from djiucai_data.institution import get_institution  # noqa: E402

OUT = Path("/tmp/probe_inst_v14")
OUT.mkdir(exist_ok=True)
RESULT: dict = {"phaseA": {}, "phaseB": {}}


def log(msg: str) -> None:
    print(f"[probe] {msg}", file=sys.stderr)


def rep(name: str, fn, out_name: str | None = None, **kw):
    """跑一个 akshare 调用：成功 → 归档 CSV 并返回 DataFrame；失败 → 记录并返回 None。"""
    t0 = time.time()
    try:
        df = fn(**kw)
    except Exception as err:  # noqa: BLE001
        RESULT["phaseA"][name] = {"ok": False, "error": f"{type(err).__name__}: {err}"}
        (OUT / f"{out_name or name}.err.txt").write_text(traceback.format_exc())
        log(f"{name}: FAIL {type(err).__name__}: {err}")
        return None
    if out_name and isinstance(df, pd.DataFrame) and not df.empty:
        df.to_csv(OUT / f"{out_name}.csv", index=False)
    RESULT["phaseA"][name] = {"ok": True, "rows": int(len(df)), "secs": round(time.time() - t0, 1)}
    log(f"{name}: OK {len(df)} rows in {time.time() - t0:.1f}s")
    return df


# ---------------- 阶段 A：锚点复现（宪法 #58/#59/#60 实测数字） ----------------

end = pd.Timestamp.now(tz="Asia/Shanghai").strftime("%Y%m%d")
start = (pd.Timestamp.now(tz="Asia/Shanghai") - timedelta(days=10)).strftime("%Y%m%d")

# M1：沪市汇总序列（元→亿，Δ融资−Δ融券）
ms = rep("stock_margin_sse", ak.stock_margin_sse, "stock_margin_sse", start_date=start, end_date=end)
if ms is not None and not ms.empty:
    ms = ms.copy()
    ms["_d"] = pd.to_datetime(ms["信用交易日期"].astype(str), format="%Y%m%d", errors="coerce")
    ms = ms.sort_values("_d")  # 先按时间升序再差分（与 probe11_verify.py 宪法口径一致）
    ms["m1_yi"] = (ms["融资余额"].diff() - ms["融券余量金额"].diff()) / 1e8
    RESULT["phaseA"]["m1_sse_series_yi"] = {
        str(r["_d"].date()): round(float(r["m1_yi"]), 2)
        for _, r in ms.iterrows()
        if pd.notna(r["m1_yi"])
    }

# M1 全市场锚：account_info 尾两日差分（亿元原值，维持担保比例）
acc = rep("stock_margin_account_info", ak.stock_margin_account_info, "stock_margin_account_info")
if acc is not None and not acc.empty:
    tail, prev = acc.iloc[-1], acc.iloc[-2]
    RESULT["phaseA"]["m1_account_anchor"] = {
        "date": str(tail["日期"]),
        "dFinYi": round(float(tail["融资余额"] - prev["融资余额"]), 2),
        "dShortYi": round(float(tail["融券余额"] - prev["融券余额"]), 2),
        "m1AllMarketYi": round(float(tail["融资余额"] - prev["融资余额"] - (tail["融券余额"] - prev["融券余额"])), 2),
        "maintenanceRatio": round(float(tail["平均维持担保比例"]), 2),
    }

# M2：ETF 份额两截面差分 + 同花顺分类 → A股股票型口径
ths = rep("fund_etf_spot_ths", ak.fund_etf_spot_ths, "fund_etf_spot_ths")


def scale_frame(date: str):
    return ak.fund_etf_scale_sse(date=date)


d1 = rep("fund_etf_scale_sse_latest", lambda: scale_frame(end), f"fund_etf_scale_sse[{end}]")
if (d1 is None or d1.empty) and ths is not None:
    # 当日截面盘后才发布（T+1）：回探前一交易日
    for back in range(1, 4):
        cand = (pd.Timestamp(end) - pd.Timedelta(days=back)).strftime("%Y%m%d")
        d1 = rep(f"fund_etf_scale_sse_latest", lambda: scale_frame(cand), f"fund_etf_scale_sse[{cand}]")
        if d1 is not None and not d1.empty:
            end = cand
            break
if d1 is not None and not d1.empty and ths is not None:
    stat = pd.to_datetime(d1["统计日期"].iloc[0]).strftime("%Y%m%d")
    # 前值按日期参数直拉（#63）：从 stat 前一日历日起回探至最近有数据的交易日
    prev_frames = None
    for back in range(1, 6):
        cand = (pd.Timestamp(stat) - pd.Timedelta(days=back)).strftime("%Y%m%d")
        f = rep(f"fund_etf_scale_sse_prev_{cand}", lambda: scale_frame(cand), f"fund_etf_scale_sse[{cand}]")
        if f is not None and not f.empty:
            prev_frames = f
            break
    if prev_frames is not None:
        # 复算方法与宪法引用的 probe11_verify.py 逐字一致（outer + fillna(0)），锚点数字直接可比
        m = prev_frames[["基金代码", "基金份额"]].merge(
            d1[["基金代码", "基金份额"]], on="基金代码", suffixes=("_d0", "_d1"), how="outer"
        )
        m["delta"] = m["基金份额_d1"].fillna(0) - m["基金份额_d0"].fillna(0)
        m = m[m["delta"] != 0].merge(
            ths[["基金代码", "基金名称", "最新-单位净值", "基金类型"]].assign(
                基金代码=lambda x: x["基金代码"].astype(str).str.strip()
            ),
            on="基金代码",
            how="left",
        )
        m = m[pd.to_numeric(m["最新-单位净值"], errors="coerce").notna()].copy()
        m["flow_yi"] = m["delta"] * pd.to_numeric(m["最新-单位净值"], errors="coerce") / 1e8

        def is_cross(code: str, name: str) -> bool:
            code, name = str(code), str(name)
            kw = ("QDII", "港股通", "纳斯达克", "标普", "日经", "德国", "法国", "中概", "亚太", "海外", "韩交所")
            if code.startswith("513") or any(k in name for k in kw):
                return True
            return "恒生" in name and "A股" not in name

        def bucket(c: str, n: str, t: str) -> str:
            t = str(t)
            if t != "股票型":
                return {"债券型": "债券型", "货币型": "货币型"}.get(t, "其他")
            return "跨境股票型" if is_cross(c, n) else "股票型(A股口径)"

        m["bucket"] = [
            bucket(c, n, t) for c, n, t in zip(m["基金代码"], m["基金名称"], m["基金类型"])
        ]
        RESULT["phaseA"]["m2_etf_yi"] = {
            "statDate": stat,
            "flowsByBucket": {k: round(float(v), 2) for k, v in m.groupby("bucket")["flow_yi"].sum().items()},
            "countByBucket": {k: int(v) for k, v in m.groupby("bucket")["flow_yi"].size().items()},
            "flowAllYi": round(float(m["flow_yi"].sum()), 2),
        }

# M3：龙虎榜机构席位（新浪，万元→亿，按日聚合）+ 大宗「机构专用」（东财，元→亿，近 10 日）
lhb = rep("stock_lhb_jgmx_sina", ak.stock_lhb_jgmx_sina, "stock_lhb_jgmx_sina")
if lhb is not None and not lhb.empty:
    net = pd.to_numeric(lhb["机构席位买入额"], errors="coerce").fillna(0) - pd.to_numeric(
        lhb["机构席位卖出额"], errors="coerce"
    ).fillna(0)
    g = (net.groupby(lhb["交易日期"]).sum() / 1e4).sort_index()
    RESULT["phaseA"]["m3_lhb_daily_yi"] = {str(k): round(float(v), 2) for k, v in g.tail(3).items()}
    RESULT["phaseA"]["m3_lhb_abs_range_yi"] = [round(float(g.abs().min()), 2), round(float(g.abs().max()), 2)]

dz = rep("stock_dzjy_mrmx", ak.stock_dzjy_mrmx, "stock_dzjy_mrmx", symbol="A股", start_date=start, end_date=end)
if dz is not None and not dz.empty:
    buy = dz[dz["买方营业部"].astype(str).str.contains("机构专用", na=False)]["成交额"].sum()
    sell = dz[dz["卖方营业部"].astype(str).str.contains("机构专用", na=False)]["成交额"].sum()
    RESULT["phaseA"]["m3_dzjy_inst_net_yi_10d"] = round(float(buy - sell) / 1e8, 2)

# 南向锚（#59：日频真实披露，只作资金分流 signals）
hsgt = rep("stock_hsgt_fund_flow_summary_em", ak.stock_hsgt_fund_flow_summary_em, "stock_hsgt_fund_flow_summary_em")
if hsgt is not None and not hsgt.empty:
    sub = hsgt[hsgt["板块"].astype(str).str.contains("港股通", na=False)].copy()
    sub["_d"] = pd.to_datetime(sub["交易日"], errors="coerce")
    latest = sub[sub["_d"] == sub["_d"].max()]
    RESULT["phaseA"]["southbound_anchor_yi"] = {
        "date": str(sub["_d"].max().date()),
        "netBuyYi": round(float(pd.to_numeric(latest["成交净买额"], errors="coerce").sum()), 2),
    }

# ---------------- 阶段 B：集成联测（funds → institution，零重复出网接线） ----------------

log("phase B: get_funds ...")
t0 = time.time()
funds = get_funds("SH000001")
log(f"get_funds done in {time.time() - t0:.1f}s")
log("phase B: get_institution ...")
t0 = time.time()
inst = get_institution(funds=funds)
log(f"get_institution done in {time.time() - t0:.1f}s")

RESULT["phaseB"]["funds"] = {
    "marginBalanceYi": funds["marginBalance"],
    "northboundNet": funds["northboundNet"],
    "southboundNetYi": funds["southboundNetYi"],
    "southboundAsOf": funds.get("southboundAsOf"),
}
RESULT["phaseB"]["inst"] = {
    "asOf": inst["asOf"],
    "netFlowYi_informational": inst["netFlowYi"],
    "paths": [
        {
            "pathId": p["pathId"],
            "netFlowYi": p["netFlowYi"],
            "asOf": p["asOf"],
            "note": p["note"],
            "signals": p["signals"],
        }
        for p in inst["paths"]
    ],
    "degradedCount": len(inst["degraded"]),
    "degradedNotes": [d.get("note") for d in inst["degraded"]],
}

(OUT / "probe_summary.json").write_text(json.dumps(RESULT, ensure_ascii=False, indent=1, default=str))
print(json.dumps(RESULT, ensure_ascii=False, indent=1, default=str))
