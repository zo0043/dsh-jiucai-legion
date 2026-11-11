"""机构决策层五路径数据接入（v1.4 #58–#63：mandate-driven，确定性、可单测、绝不伪造）。

机构不进 LLM 散户池（#16 修正），以公开数据 → 确定性规则的映射加入净流合成与信息集。
本模块只产**原始载荷**（单位统一到亿元）；折算（亿元→NF 单位）只发生在 TS 侧
``institutionNetFlow``（#60），本模块任何字段不得预折算。

五路径（宪法 #58）：
- M1 margin 杠杆资金（两融）：日频 T+1。netFlowYi = Δ融资余额 − Δ融券余额（沪+深汇总差分）。
  平均维持担保比例（stock_margin_account_info）只进 signals 文案与面板，不改 NF、不加阻尼（#40）。
- M2 etfSse 被动 ETF（仅沪市）：日频 T+1。netFlowYi = Σ Δ份额×单位净值，**仅计入「A股股票型」**：
  fund_etf_spot_ths 基金类型=='股票型' 且非跨境（排除 513 段与名称含 QDII/港股通/纳斯达克/标普/日经/
  德国/法国/中概/亚太/海外/韩交所；「恒生」仅当名称同含「A股」豁免）。债券/货币/其他/跨境只进
  signals 分桶金额（附「不计入净流口径」语义，见 path.note）；新上市/缺前值/join 未命中/净值缺失的
  变动只一律缺省排除并计数标注。深市份额不可观测（#59）。前值按日期参数直拉历史截面（#63），
  缓存仅限流/失败兜底——不存在「首跑无前值」降级分支。
- M3 eventSeat 事件席位（龙虎榜+大宗）：日频 T+0 盘后。netFlowYi = 新浪龙虎榜机构席位净买（万元→亿）
  + 东财大宗「机构专用」席位净买（元→亿）；折溢率只进 signals 文案不改 NF。
- M4 quarterlyStructure 季频持仓结构：香港中央结算（陆股通）季度持股（唯一合法北向季度代理，#59）+
  公募基金家数增减 + 股东性质 + 股东户数筹码集中度 + 个股精确公告日口径（新浪版，预埋）。
  **只产结构信号不产 NF**（netFlowYi 恒 null）；东财 gdfx/基金持股系无公告日字段 → 按
  「报告期+滞后 30–40 天」标注，不得把报告期当信息可得日（#63）。
- M5 northbound 北向：每日净买自 2024-08 起上游停披露 → 恒 null +「停披露」标注（#59，不可观测）。
  南向（港股通）日频真实披露，但只能作「资金分流」signals，任何字段不得充当北向代理；
  数据源复用 funds.get_funds 同一次 stock_hsgt_fund_flow_summary_em 响应（零重复出网，
  本模块不调用该接口）。

单位归一（#63，统一到亿元；实测口径）：
- 沪两融汇总 stock_margin_sse：元 → 亿（/1e8）；沪两融明细 stock_margin_detail_sse：元 → 亿。
- 深两融汇总 stock_margin_szse：亿元原值（实测 融资余额 10837.57 为全市场亿级）；深两融明细
  stock_margin_detail_szse：元 → 亿（实测平安银行融资余额 3.94e9 为元口径，明细与汇总口径不同）。
- 新浪龙虎榜 stock_lhb_jgmx_sina：万元 → 亿（/1e4）；东财龙虎榜/大宗：元 → 亿（/1e8）。
- ETF 净流 = Δ份额(份) × 单位净值(元) / 1e8（≡ Δ份额(亿份) × 净值）。
- 全市场账户统计 stock_margin_account_info：亿元原值（2012 年首行融资余额 704.53）。

每源独立 @with_retry fetcher + try/except 全兜底 null + DataSourceFlag（#24 分级降级，
funds.py 先例）；绝不写非空假设；所有数值经 :func:`_finite` 清洗（协议 allow_nan=False，F33）。
两融个股明细（预埋）：当前五路径无消费方（M1 用沪+深汇总差分），单页截断条款（SSE pageSize
封顶 2000、漏约 0.9%）预埋给未来个股拥挤度路径（#63），聚合路径不调用。
"""

from __future__ import annotations

import math
from datetime import timedelta
from typing import Any, Callable, Optional

import akshare as ak
import pandas as pd

from ._common import make_degraded, now_ts_sh, today_sh
from .calendar import get_calendar, latest_trade_date
from .retry import with_retry

YI = 1e8    # 元 → 亿元
WAN = 1e4   # 万元 → 亿元

MARGIN_LOOKBACK_DAYS = 40   # 沪市两融汇总查询回看窗口（足够差分最近两日，funds.py 同款）
DZJY_LOOKBACK_DAYS = 10     # 大宗交易明细回看窗口（取最新交易日）
ETF_DISCOVER_TRIES = 4      # 最新 ETF 份额截面：从最近交易日向前直探次数
SCALE_PREV_TRIES = 3        # 前值截面回探次数
QUARTER_TRIES = 2           # 季频报告期候选数（自最近完整季末向前）

#: 跨境 ETF 名称关键词（宪法 #58 定死；「恒生」单独按「同含 A股 豁免」处理）
CROSS_BORDER_KEYWORDS = (
    "QDII", "港股通", "纳斯达克", "标普", "日经", "德国", "法国", "中概", "亚太", "海外", "韩交所",
)

HKSC_NAME_KEY = "香港中央结算"   # 香港中央结算（陆股通）股东名称匹配键（#59 唯一合法北向季度代理）

QUARTER_LABEL = "netFlowYi 不可得（季频结构信号不产 NF，#58）"


def _finite(x: Any) -> Optional[float]:
    """数值清洗：可解析且有限才返回 float，否则 None（NaN/Inf 一律置空，F33）。"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _compact(d: str) -> str:
    """'YYYY-MM-DD' → 'YYYYMMDD'（akshare 日期参数格式）。"""
    return str(d).replace("-", "")


def _norm_date(v: Any) -> Optional[str]:
    """任意日期值 → 'YYYY-MM-DD'；解析失败返回 None。"""
    ts = pd.to_datetime(v, errors="coerce")
    if pd.isna(ts):
        return None
    return str(pd.Timestamp(ts).date())


def is_cross_border_etf(code: str, name: str) -> bool:
    """跨境 ETF 判定（宪法 #58 定死规则，A 股股票型口径的排除项）。

    - 513 段一律跨境；
    - 名称含任一 CROSS_BORDER_KEYWORDS → 跨境；
    - 名称含「恒生」：仅当同含「A股」才豁免（563210 富国恒生A股专精特新=计入；
      510900 易方达恒生国企(QDII-ETF)=排除）。
    """
    code = str(code).strip()
    name = str(name).strip()
    if code.startswith("513"):
        return True
    if any(k in name for k in CROSS_BORDER_KEYWORDS):
        return True
    return "恒生" in name and "A股" not in name


def _classify_etf(code: str, name: str, etype: str) -> str:
    """ETF 资产分桶（#58）：'aShare' | 'crossBorder' | 'bond' | 'money' | 'other'。

    类型优先（债券/货币/其他不参与跨境判定——分桶互斥，跨境仅指股票型内的跨境申赎）。
    """
    etype = str(etype).strip()
    if etype == "债券型":
        return "bond"
    if etype == "货币型":
        return "money"
    if etype != "股票型":
        return "other"
    if is_cross_border_etf(code, name):
        return "crossBorder"
    return "aShare"


# ---------------------------------------------------------------------------
# fetchers（每源独立 @with_retry + 失败兜底；接口名与列名按 akshare 1.20.34 源码核实）
# ---------------------------------------------------------------------------


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_margin_sse_summary() -> pd.DataFrame:
    """沪市两融汇总序列（元口径，T+1 披露；列名与 funds.py 同源核实）。"""
    end = today_sh().replace("-", "")
    start = (pd.Timestamp(today_sh()) - timedelta(days=MARGIN_LOOKBACK_DAYS)).strftime("%Y%m%d")
    return ak.stock_margin_sse(start_date=start, end_date=end)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_margin_szse_summary(date: str) -> pd.DataFrame:
    """深市两融汇总单日截面（亿元口径，#63 单位表）；date='YYYYMMDD'。"""
    return ak.stock_margin_szse(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_margin_account() -> pd.DataFrame:
    """全市场两融账户统计（亿元口径；平均维持担保比例来源，#58 M1 signals）。"""
    return ak.stock_margin_account_info()


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_margin_detail_sse(date: str) -> pd.DataFrame:
    """沪市两融个股明细（元口径；预埋给未来个股拥挤度路径，#63 聚合路径不调用）。"""
    return ak.stock_margin_detail_sse(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_margin_detail_szse(date: str) -> pd.DataFrame:
    """深市两融个股明细（元口径，见模块 docstring 单位表；预埋，聚合路径不调用）。"""
    return ak.stock_margin_detail_szse(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_etf_scale_sse(date: str) -> pd.DataFrame:
    """上交所 ETF 份额单日截面（份口径）；date='YYYYMMDD' 必须显式传参。

    注意：akshare 该接口默认 date='20250115' 是写死的旧日期（源码核实），
    绝不能不带参调用（#63：前值按日期参数直拉历史截面）。
    SSE 对未发布统计日期返回空 result → akshare 选列 KeyError（2026-11-12 实测），
    归一为空截面：当日截面盘后才发布，盘中前探是 T+1 正常现象而非故障（#63）。
    """
    try:
        return ak.fund_etf_scale_sse(date=date)
    except KeyError:
        return pd.DataFrame(columns=["序号", "基金代码", "基金简称", "ETF类型", "统计日期", "基金份额"])


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_etf_spot_ths() -> pd.DataFrame:
    """同花顺 ETF 现货列表（基金类型/基金名称/最新-单位净值——A 股口径分类依据，#58 M2）。"""
    return ak.fund_etf_spot_ths()


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_lhb_jgmx_sina() -> pd.DataFrame:
    """新浪龙虎榜机构买卖明细（万元口径；多日窗口，取最新交易日，T+0 盘后）。"""
    return ak.stock_lhb_jgmx_sina()


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_dzjy_mrmx() -> pd.DataFrame:
    """东财大宗交易每日明细 A股（元口径；近 10 日窗口，取最新交易日）。"""
    end = today_sh().replace("-", "")
    start = (pd.Timestamp(today_sh()) - timedelta(days=DZJY_LOOKBACK_DAYS)).strftime("%Y%m%d")
    return ak.stock_dzjy_mrmx(symbol="A股", start_date=start, end_date=end)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_gdfx_holding_change(date: str) -> pd.DataFrame:
    """东财股东持股变动统计（自由流通，报告期截面；无公告日字段，#58/#63）。"""
    return ak.stock_gdfx_free_holding_change_em(date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_fund_hold(date: str) -> pd.DataFrame:
    """东财基金持股统计（持有基金家数/持股变化，报告期截面；无公告日字段）。"""
    return ak.stock_report_fund_hold(symbol="基金持仓", date=date)


@with_retry(times=2, backoff=0.5, eastmoney=True)
def _fetch_gdhs(date: str) -> pd.DataFrame:
    """东财股东户数统计（筹码集中度；自带公告日期列，asOf 可精确到公告日）。"""
    return ak.stock_zh_a_gdhs(symbol=date)


@with_retry(times=2, backoff=0.5, eastmoney=False)
def _fetch_circulate_holder(symbol: str) -> pd.DataFrame:
    """新浪十大流通股东（自带公告日期字段；个股级，M4 精确公告日口径预埋，#63）。"""
    return ak.stock_circulate_stock_holder(symbol=symbol)


# ---------------------------------------------------------------------------
# M1 杠杆资金（两融）
# ---------------------------------------------------------------------------


def _sse_margin_delta() -> tuple[Optional[float], Optional[float], Optional[str], Optional[str], list[dict]]:
    """沪市两融汇总差分（元→亿）。

    :returns: (Δ融资余额亿, Δ融券余额亿, 最新交易日, 次新交易日, degraded)
    """
    try:
        df = _fetch_margin_sse_summary()
        if df is None or df.empty or "融资余额" not in df.columns:
            raise ValueError("沪市两融汇总为空或缺列")
        df = df.copy()
        # 信用交易日期实测为 'YYYYMMDD' 字符串（2026-11-12 归档）；按 8 位数字走显式格式，
        # 否则 pd.to_datetime 会把整数当纳秒时间戳解析成 1970 年
        d_raw = df["信用交易日期"].astype(str).str.strip()
        if d_raw.str.fullmatch(r"\d{8}").all():
            df["_d"] = pd.to_datetime(d_raw, format="%Y%m%d", errors="coerce")
        else:
            df["_d"] = pd.to_datetime(d_raw, errors="coerce")
        # 融券余额口径：汇总列名「融券余量金额」（元）；缺列兜底「融券余额」
        short_col = "融券余量金额" if "融券余量金额" in df.columns else "融券余额"
        df["_fin"] = pd.to_numeric(df["融资余额"], errors="coerce")
        df["_short"] = pd.to_numeric(df[short_col], errors="coerce")
        df = df.dropna(subset=["_d", "_fin"]).drop_duplicates("_d").sort_values("_d")
        if len(df) < 2:
            raise ValueError("沪市两融汇总不足两个交易日，无法差分")
        last, prev = df.iloc[-1], df.iloc[-2]
        d_fin = _finite((last["_fin"] - prev["_fin"]) / YI)
        d_short = _finite((last["_short"] - prev["_short"]) / YI)
        if d_fin is None or d_short is None:
            raise ValueError("沪市两融汇总含不可解析数值")
        return (
            d_fin,
            d_short,
            last["_d"].strftime("%Y-%m-%d"),
            prev["_d"].strftime("%Y-%m-%d"),
            [],
        )
    except Exception as err:  # noqa: BLE001
        return None, None, None, None, [
            make_degraded(
                "akshare:stock_margin_sse",
                asOf=None,
                note=f"沪市两融汇总差分失败（{err}），M1 沪市腿不可得",
            )
        ]


def _szse_margin_day(d: str) -> tuple[Optional[tuple[float, float]], list[dict]]:
    """深市两融汇总单日（亿元原值，不 /1e8——#63 单位表，误除会缩小 1e8 倍）。"""
    try:
        df = _fetch_margin_szse_summary(_compact(d))
        if df is None or df.empty or "融资余额" not in df.columns:
            return None, [make_degraded(
                "akshare:stock_margin_szse", asOf=d, note=f"深市两融汇总 {d} 无数据行"
            )]
        fin = _finite(pd.to_numeric(df["融资余额"], errors="coerce").iloc[0])
        short = _finite(pd.to_numeric(df["融券余额"], errors="coerce").iloc[0])
        if fin is None or short is None:
            return None, [make_degraded(
                "akshare:stock_margin_szse", asOf=d, note=f"深市两融汇总 {d} 含不可解析数值"
            )]
        return (fin, short), []
    except Exception as err:  # noqa: BLE001
        return None, [make_degraded(
            "akshare:stock_margin_szse", asOf=None, note=f"深市两融汇总 {d} 获取失败（{err}）"
        )]


def get_margin_path() -> tuple[dict[str, Any], list[dict]]:
    """M1 杠杆资金（两融）路径。

    netFlowYi = Δ融资余额 − Δ融券余额（沪+深汇总差分，亿元）。单腿失败 → 只聚合可用腿并
    逐腿标注；双腿失败 → null。维持担保比例只进 signals（#58/#40）。
    """
    degraded: list[dict] = []
    sh_fin, sh_short, sh_asof, sh_prev, sh_deg = _sse_margin_delta()
    degraded.extend(sh_deg)

    # 深市锚定日期：优先沪市最近两日（两所同为 T+1 披露，口径一致）；沪市失败 → 日历最近两交易日
    dates, cal_deg = get_calendar()
    degraded.extend(cal_deg)
    if sh_asof and sh_prev:
        d1, d0 = sh_asof, sh_prev
    else:
        prior = [d for d in dates if d <= today_sh()]
        if len(prior) >= 2:
            d1, d0 = prior[-1], prior[-2]
            degraded.append(make_degraded(
                "djiucai:margin_anchor",
                asOf=None,
                note="沪市两融汇总不可得，深市腿改用交易日历锚定（当日截面可能未披露）",
            ))
        else:
            d1, d0 = None, None
            degraded.append(make_degraded(
                "djiucai:margin_anchor", asOf=None, note="交易日历不可用，深市两融腿无法锚定日期"
            ))

    sz_fin = sz_short = None
    sz_asof = None
    if d1 and d0:
        r1, deg1 = _szse_margin_day(d1)
        r0, deg0 = _szse_margin_day(d0)
        degraded.extend(deg1)
        degraded.extend(deg0)
        if r1 is not None and r0 is not None:
            sz_fin = r1[0] - r0[0]    # 亿元原值差分
            sz_short = r1[1] - r0[1]
            sz_asof = d1
        elif r1 is not None and r0 is None:
            degraded.append(make_degraded(
                "akshare:stock_margin_szse", asOf=d1,
                note=f"深市两融汇总 {d0} 截面不可得，深市差分无法计算",
            ))

    legs = [leg for leg in (
        (sh_fin - sh_short) if (sh_fin is not None and sh_short is not None) else None,
        (sz_fin - sz_short) if (sz_fin is not None and sz_short is not None) else None,
    ) if leg is not None]
    net = round(sum(legs), 6) if legs else None

    signals: dict[str, Any] = {
        "sseFinDeltaYi": sh_fin,
        "sseShortDeltaYi": sh_short,
        "sseAsOf": sh_asof,
        "szseFinDeltaYi": _finite(sz_fin),
        "szseShortDeltaYi": _finite(sz_short),
        "szseAsOf": sz_asof,
    }

    # 维持担保比例（全市场口径，亿元表）：只进 signals 文案与面板，不改 NF、不加阻尼（#58/#40）
    try:
        acc = _fetch_margin_account()
        if acc is None or acc.empty or "平均维持担保比例" not in acc.columns:
            raise ValueError("两融账户统计为空或缺列")
        acc = acc.copy()
        acc["_d"] = pd.to_datetime(acc["日期"], errors="coerce")
        acc = acc.dropna(subset=["_d"]).sort_values("_d")
        if acc.empty:
            raise ValueError("两融账户统计无可解析行")
        last = acc.iloc[-1]
        ratio = _finite(last["平均维持担保比例"])
        signals["maintenanceRatio"] = ratio
        signals["maintenanceAsOf"] = last["_d"].strftime("%Y-%m-%d")
        if ratio is None:
            degraded.append(make_degraded(
                "akshare:stock_margin_account_info",
                asOf=signals["maintenanceAsOf"],
                note="平均维持担保比例不可解析，字段置空",
            ))
    except Exception as err:  # noqa: BLE001
        signals["maintenanceRatio"] = None
        signals["maintenanceAsOf"] = None
        degraded.append(make_degraded(
            "akshare:stock_margin_account_info",
            asOf=None,
            note=f"维持担保比例获取失败（{err}），字段置空",
        ))

    asof_candidates = [a for a in (sh_asof, sz_asof) if a]
    path = {
        "pathId": "margin",
        "label": "M1 杠杆资金（两融）",
        "netFlowYi": net,
        "signals": signals,
        "asOf": max(asof_candidates) if asof_candidates else None,
        "note": "NF = Δ融资余额 − Δ融券余额（沪+深汇总差分，T+1 披露）；维持担保比例只进文案不改 NF（#58/#40）",
    }
    return path, degraded


# ---------------------------------------------------------------------------
# M2 被动 ETF（仅沪市，仅 A 股股票型）
# ---------------------------------------------------------------------------


def _latest_etf_scale(dates: list[str]) -> tuple[Optional[pd.DataFrame], Optional[str], list[dict]]:
    """最新可得份额截面：从最近交易日（含当日）向前按日期参数直拉（#63 无缓存前值分支）。

    当日截面盘后才发布，盘中前探为 T+1 正常现象，空截面静默跳过不标注；
    网络异常与最终失败才产 degraded（#24）。
    """
    degraded: list[dict] = []
    if not dates:
        return None, None, [make_degraded(
            "djiucai:calendar", asOf=None, note="交易日历不可用，ETF 份额截面无法定位统计日期"
        )]
    anchor = latest_trade_date(dates, today_sh())
    if anchor is None:
        return None, None, [make_degraded(
            "djiucai:calendar", asOf=None, note="交易日历中无 <= 今日的交易日，ETF 截面无法定位"
        )]
    prior = [d for d in dates if d <= anchor]
    for d in reversed(prior[-ETF_DISCOVER_TRIES:]):
        try:
            df = _fetch_etf_scale_sse(_compact(d))
        except Exception as err:  # noqa: BLE001
            degraded.append(make_degraded(
                "akshare:fund_etf_scale_sse", asOf=d, note=f"ETF 份额截面 {d} 获取失败（{err}）"
            ))
            continue
        if df is not None and not df.empty:
            return df, d, degraded
    degraded.append(make_degraded(
        "akshare:fund_etf_scale_sse", asOf=None,
        note=f"最近 {ETF_DISCOVER_TRIES} 个交易日均无 ETF 份额截面，路径降级",
    ))
    return None, None, degraded


def _prev_etf_scale(d1: str, dates: list[str]) -> tuple[Optional[pd.DataFrame], Optional[str], list[dict]]:
    """前值截面：d1 前最近交易日按日期参数直拉（#63：归档实测按 date 取回成功）。"""
    prior = [d for d in dates if d < d1]
    for d in reversed(prior[-SCALE_PREV_TRIES:]):
        try:
            df = _fetch_etf_scale_sse(_compact(d))
        except Exception as err:  # noqa: BLE001
            return None, None, [make_degraded(
                "akshare:fund_etf_scale_sse", asOf=d, note=f"ETF 前值截面 {d} 获取失败（{err}）"
            )]
        if df is not None and not df.empty:
            return df, d, []
    return None, None, [make_degraded(
        "akshare:fund_etf_scale_sse", asOf=None,
        note=f"ETF 前值截面不可得（{d1} 前最近交易日无数据），路径降级",
    )]


def _etf_signals_null() -> dict[str, Any]:
    return {
        "bondYi": None,
        "moneyYi": None,
        "otherYi": None,
        "crossBorderYi": None,
        "aShareCount": 0,
        "bondCount": 0,
        "moneyCount": 0,
        "otherCount": 0,
        "crossBorderCount": 0,
        "excludedNewListedCount": 0,
        "excludedJoinMissCount": 0,
        "excludedNavUnknownCount": 0,
        "statDate": None,
        "prevStatDate": None,
    }


def get_etf_path() -> tuple[dict[str, Any], list[dict]]:
    """M2 被动 ETF（仅沪市）路径（宪法 #58：仅计入 A 股股票型；分桶只进 signals）。

    深市份额不可观测（#59）；A 股口径过滤在本路径内完成，TS 侧不做二次资产过滤（#60）。
    """
    degraded: list[dict] = []
    dates, cal_deg = get_calendar()
    degraded.extend(cal_deg)

    df1, d1, deg = _latest_etf_scale(dates)
    degraded.extend(deg)
    if df1 is None or d1 is None:
        path = {
            "pathId": "etfSse", "label": "M2 被动 ETF（仅沪市）", "netFlowYi": None,
            "signals": _etf_signals_null(), "asOf": None,
            "note": "ETF 份额最新截面不可得（#58：仅沪市、仅 A 股股票型计入净流口径）",
        }
        return path, degraded

    df0, d0, deg0 = _prev_etf_scale(d1, dates)
    degraded.extend(deg0)
    if df0 is None or d0 is None:
        path = {
            "pathId": "etfSse", "label": "M2 被动 ETF（仅沪市）", "netFlowYi": None,
            "signals": _etf_signals_null(), "asOf": d1,
            "note": "ETF 前值截面不可得，份额差分无法计算（#63：前值按日期参数直拉，失败即降级）",
        }
        return path, degraded

    try:
        ths = _fetch_etf_spot_ths()
        if ths is None or ths.empty or "基金代码" not in ths.columns:
            raise ValueError("同花顺 ETF 现货列表为空或缺列")
    except Exception as err:  # noqa: BLE001
        degraded.append(make_degraded(
            "akshare:fund_etf_spot_ths", asOf=None,
            note=f"ETF 资产分类表获取失败（{err}），A 股口径无法判定，路径降级",
        ))
        path = {
            "pathId": "etfSse", "label": "M2 被动 ETF（仅沪市）", "netFlowYi": None,
            "signals": _etf_signals_null(), "asOf": d1,
            "note": "ETF 资产分类表（fund_etf_spot_ths）不可得，无法判定 A 股股票型口径",
        }
        return path, degraded

    def _scale_shares(df: pd.DataFrame) -> pd.DataFrame:
        s = df[["基金代码", "基金份额"]].copy()
        s["基金代码"] = s["基金代码"].astype(str).str.strip()
        s["基金份额"] = pd.to_numeric(s["基金份额"], errors="coerce")
        return s.dropna(subset=["基金份额"]).drop_duplicates("基金代码", keep="last")

    s1 = _scale_shares(df1)
    s0 = _scale_shares(df0)
    m = s0.merge(s1, on="基金代码", how="outer", suffixes=("_d0", "_d1"))
    m["delta"] = m["基金份额_d1"].fillna(0) - m["基金份额_d0"].fillna(0)
    changed = m[m["delta"] != 0].copy()

    info = ths[["基金代码", "基金名称", "最新-单位净值", "基金类型"]].copy()
    info["基金代码"] = info["基金代码"].astype(str).str.strip()
    info["最新-单位净值"] = pd.to_numeric(info["最新-单位净值"], errors="coerce")
    info = info.drop_duplicates("基金代码", keep="first")  # 同花顺全量沪深列表，防御性去重
    changed = changed.merge(info, on="基金代码", how="left")

    buckets = {"bondYi": 0.0, "moneyYi": 0.0, "otherYi": 0.0, "crossBorderYi": 0.0}
    counts = {"aShare": 0, "bond": 0, "money": 0, "other": 0, "crossBorder": 0}
    excl = {"newListed": 0, "joinMiss": 0, "navUnknown": 0}
    net = 0.0
    bucket_key = {"bond": "bondYi", "money": "moneyYi", "other": "otherYi", "crossBorder": "crossBorderYi"}
    for _, row in changed.iterrows():
        if pd.isna(row["基金份额_d0"]) or pd.isna(row["基金份额_d1"]):
            excl["newListed"] += 1  # 单侧截面（新上市/终止）：份额差分不可解释，缺省排除（#58 口径存疑）
            continue
        if pd.isna(row["基金名称"]):
            excl["joinMiss"] += 1  # 分类表未命中：类型/净值均未知，缺省排除
            continue
        nav = row["最新-单位净值"]
        etype = row["基金类型"]
        if pd.isna(nav) or pd.isna(etype):
            excl["navUnknown"] += 1  # 净值或类型缺失：口径存疑，缺省排除（#58）
            continue
        flow = float(row["delta"]) * float(nav) / YI  # Δ份额(份)×净值(元) → 亿元
        bucket = _classify_etf(str(row["基金代码"]), str(row["基金名称"]), str(etype))
        if bucket == "aShare":
            net += flow
            counts["aShare"] += 1
        else:
            buckets[bucket_key[bucket]] += flow
            counts[bucket] += 1

    signals: dict[str, Any] = {
        "bondYi": round(buckets["bondYi"], 6) if counts["bond"] else None,
        "moneyYi": round(buckets["moneyYi"], 6) if counts["money"] else None,
        "otherYi": round(buckets["otherYi"], 6) if counts["other"] else None,
        "crossBorderYi": round(buckets["crossBorderYi"], 6) if counts["crossBorder"] else None,
        "aShareCount": counts["aShare"],
        "bondCount": counts["bond"],
        "moneyCount": counts["money"],
        "otherCount": counts["other"],
        "crossBorderCount": counts["crossBorder"],
        "excludedNewListedCount": excl["newListed"],
        "excludedJoinMissCount": excl["joinMiss"],
        "excludedNavUnknownCount": excl["navUnknown"],
        "statDate": d1,
        "prevStatDate": d0,
    }
    path = {
        "pathId": "etfSse",
        "label": "M2 被动 ETF（仅沪市）",
        "netFlowYi": round(net, 6),
        "signals": signals,
        "asOf": d1,
        "note": (
            "净流口径=仅 A 股股票型（#58）；bondYi/moneyYi/otherYi/crossBorderYi 为分桶金额，"
            "不计入净流口径；定性为资金流代理（份额统计含申赎/拆分口径噪声）；深市份额不可观测（#59）"
        ),
    }
    return path, degraded


# ---------------------------------------------------------------------------
# M3 事件席位（龙虎榜 + 大宗）
# ---------------------------------------------------------------------------


def get_event_seat_path() -> tuple[dict[str, Any], list[dict]]:
    """M3 事件席位路径（#58）：netFlowYi = 龙虎榜机构席位净买（新浪）+ 大宗「机构专用」净买（东财）。

    两个子项各自独立降级；折溢率只进 signals 文案不改 NF。
    """
    degraded: list[dict] = []

    lhb_yi = None
    lhb_asof = None
    try:
        df = _fetch_lhb_jgmx_sina()
        if df is None or df.empty or "机构席位买入额" not in df.columns:
            raise ValueError("新浪龙虎榜机构买卖为空或缺列")
        df = df.copy()
        df["_d"] = pd.to_datetime(df["交易日期"], errors="coerce")
        df = df.dropna(subset=["_d"])
        if df.empty:
            raise ValueError("龙虎榜机构买卖无可解析日期行")
        latest = df["_d"].max()
        sub = df[df["_d"] == latest]
        buy = pd.to_numeric(sub["机构席位买入额"], errors="coerce").fillna(0).sum()
        sell = pd.to_numeric(sub["机构席位卖出额"], errors="coerce").fillna(0).sum()
        lhb_yi = _finite((buy - sell) / WAN)  # 万元 → 亿
        if lhb_yi is None:
            raise ValueError("机构席位买卖额不可解析")
        lhb_asof = latest.strftime("%Y-%m-%d")
    except Exception as err:  # noqa: BLE001
        degraded.append(make_degraded(
            "akshare:stock_lhb_jgmx_sina", asOf=None,
            note=f"龙虎榜机构席位净买获取失败（{err}），子项置空",
        ))

    dzjy_yi = None
    dzjy_asof = None
    premium = None
    try:
        df = _fetch_dzjy_mrmx()
        if df is None or df.empty or "成交额" not in df.columns:
            raise ValueError("大宗交易明细为空或缺列")
        df = df.copy()
        df["_d"] = pd.to_datetime(df["交易日期"], errors="coerce")
        df = df.dropna(subset=["_d"])
        if df.empty:
            raise ValueError("大宗交易明细无可解析日期行")
        latest = df["_d"].max()
        sub = df[df["_d"] == latest].copy()
        buyer = sub["买方营业部"].astype(str) if "买方营业部" in sub.columns else pd.Series([""] * len(sub), index=sub.index)
        seller = sub["卖方营业部"].astype(str) if "卖方营业部" in sub.columns else pd.Series([""] * len(sub), index=sub.index)
        amt = pd.to_numeric(sub["成交额"], errors="coerce").fillna(0)
        buy = amt[buyer.str.contains("机构专用", na=False)].sum()
        sell = amt[seller.str.contains("机构专用", na=False)].sum()
        dzjy_yi = _finite((buy - sell) / YI)  # 元 → 亿
        if dzjy_yi is None:
            raise ValueError("大宗成交额不可解析")
        dzjy_asof = latest.strftime("%Y-%m-%d")
        if "折溢率" in sub.columns:
            pre = pd.to_numeric(
                sub.loc[buyer.str.contains("机构专用", na=False) | seller.str.contains("机构专用", na=False), "折溢率"],
                errors="coerce",
            )
            premium = _finite(pre.mean()) if pre.notna().any() else None
    except Exception as err:  # noqa: BLE001
        degraded.append(make_degraded(
            "akshare:stock_dzjy_mrmx", asOf=None,
            note=f"大宗「机构专用」席位净买获取失败（{err}），子项置空",
        ))

    parts = [v for v in (lhb_yi, dzjy_yi) if v is not None]
    net = round(sum(parts), 6) if parts else None
    asof_candidates = [a for a in (lhb_asof, dzjy_asof) if a]
    path = {
        "pathId": "eventSeat",
        "label": "M3 事件席位（龙虎榜+大宗）",
        "netFlowYi": net,
        "signals": {
            "lhbYi": lhb_yi,
            "lhbAsOf": lhb_asof,
            "dzjyYi": dzjy_yi,
            "dzjyAsOf": dzjy_asof,
            "dzjyPremiumPct": premium,
        },
        "asOf": max(asof_candidates) if asof_candidates else None,
        "note": "NF = 龙虎榜机构席位净买（新浪，T+0 盘后）+ 大宗「机构专用」席位净买（东财）；折溢率只进文案（#58）",
    }
    return path, degraded


# ---------------------------------------------------------------------------
# M4 季频持仓结构（只产结构信号，netFlowYi 恒 null）
# ---------------------------------------------------------------------------


def _quarter_candidates(today: Optional[str] = None) -> list[str]:
    """报告期候选：<= 最近的完整季末，倒序最多 QUARTER_TRIES 个（'YYYY-MM-DD'）。"""
    d = pd.Timestamp(today or today_sh())
    cands: list[str] = []
    for y in (d.year, d.year - 1):
        for md in ("12-31", "09-30", "06-30", "03-31"):
            q = f"{y}-{md}"
            if pd.Timestamp(q) <= d:
                cands.append(q)
    return sorted(set(cands), reverse=True)[:QUARTER_TRIES]


def _fetch_quarter_frame(
    fetch: Callable[[str], pd.DataFrame], source: str, label: str
) -> tuple[Optional[pd.DataFrame], Optional[str], list[dict]]:
    """按报告期取截面：候选季末向前回探，首个非空即用（发布滞后 30–40 天，#63）。

    :returns: (DataFrame, 报告期 'YYYY-MM-DD', degraded)；全部候选为空 → (None, None, degraded)。
    """
    degraded: list[dict] = []
    for q in _quarter_candidates():
        try:
            df = fetch(_compact(q))
        except Exception as err:  # noqa: BLE001
            degraded.append(make_degraded(source, asOf=None, note=f"{label} 报告期 {q} 获取失败（{err}）"))
            continue
        if df is not None and not df.empty:
            return df, q, degraded
        degraded.append(make_degraded(source, asOf=q, note=f"{label} 报告期 {q} 无数据（可能未发布），继续前探"))
    degraded.append(make_degraded(source, asOf=None, note=f"{label} 最近候选报告期均无数据，子信号置空"))
    return None, None, degraded


def get_quarterly_path() -> tuple[dict[str, Any], list[dict]]:
    """M4 季频持仓结构路径（#58）：五个子信号均 netFlowYi=null，只产结构信号。

    香港中央结算（陆股通）季度持股 = 唯一合法北向季度代理（#59）；东财 gdfx/基金持股系
    无公告日字段 → 按「报告期+滞后 30–40 天」标注（#63），不得把报告期当信息可得日。
    """
    degraded: list[dict] = []

    # ① 香港中央结算季度持股（北向季度代理）+ ③ 股东性质分布（同源 gdfx，同次响应解析）
    gdfx, q_gdfx, deg = _fetch_quarter_frame(
        _fetch_gdfx_holding_change, "akshare:stock_gdfx_free_holding_change_em", "股东持股变动统计"
    )
    degraded.extend(deg)

    hksc: dict[str, Any] = {
        "netFlowYi": None,
        "label": "香港中央结算（陆股通）季度持股（北向季度代理，#59 唯一合法）",
        "asOf": q_gdfx,
        "note": "报告期截面；东财 gdfx 系无公告日字段，按「报告期+滞后 30–40 天」标注（#63）",
    }
    nature: dict[str, Any] = {
        "netFlowYi": None,
        "label": "股东性质分布（自由流通持股变动行数口径）",
        "asOf": q_gdfx,
        "note": "报告期截面；东财系无公告日字段，滞后标注同上",
    }
    if gdfx is not None and q_gdfx:
        sub = gdfx[gdfx["股东名称"].astype(str).str.contains(HKSC_NAME_KEY, na=False)]
        if sub.empty:
            hksc["note"] = f"报告期 {q_gdfx} 截面无香港中央结算行，字段置空"
        else:
            row = sub.sort_values(
                "期末持股只数统计-总持有", ascending=False
            ).iloc[0]  # 多名目（如有）取总持有最大行，确定性
            float_mv = _finite(row.get("流通市值统计"))
            hksc.update({
                "totalStocks": _finite(row.get("期末持股只数统计-总持有")),
                "newIn": _finite(row.get("期末持股只数统计-新进")),
                "increase": _finite(row.get("期末持股只数统计-增加")),
                "decrease": _finite(row.get("期末持股只数统计-减少")),
                "floatMvYi": _finite(float_mv / YI) if float_mv is not None else None,
            })
        vc = gdfx["股东类型"].value_counts()
        nature["counts"] = {str(k): int(v) for k, v in vc.items()}
    else:
        hksc["totalStocks"] = None
        nature["counts"] = None

    # ② 公募基金家数增减
    fund_hold_out: dict[str, Any] = {
        "netFlowYi": None,
        "label": "公募基金家数增减（基金持股统计）",
        "asOf": None,
        "note": "报告期截面；东财系无公告日字段，按「报告期+滞后 30–40 天」标注（#63）",
    }
    fh, q_fh, deg = _fetch_quarter_frame(
        _fetch_fund_hold, "akshare:stock_report_fund_hold", "基金持股统计"
    )
    degraded.extend(deg)
    if fh is not None and q_fh:
        chg = fh["持股变化"].astype(str)
        fund_hold_out.update({
            "asOf": q_fh,
            "stocksWithFunds": int(len(fh)),
            "increaseCount": int((chg == "增仓").sum()),
            "decreaseCount": int((chg == "减仓").sum()),
            "unchangedCount": int((chg == "不变").sum()),
            "newInCount": int((chg == "新进").sum()),
        })

    # ④ 股东户数筹码集中度（自带公告日期列 → asOf 可精确到公告日）
    gdhs_out: dict[str, Any] = {
        "netFlowYi": None,
        "label": "股东户数筹码集中度（户数增减比例中位数）",
        "asOf": None,
        "note": "户数增加=筹码分散、减少=集中；东财系但自带公告日期列，asOf 取最新公告日",
    }
    gd, q_gd, deg = _fetch_quarter_frame(_fetch_gdhs, "akshare:stock_zh_a_gdhs", "股东户数统计")
    degraded.extend(deg)
    if gd is not None and q_gd:
        ratio = pd.to_numeric(gd["股东户数-增减比例"], errors="coerce") if "股东户数-增减比例" in gd.columns else pd.Series(dtype=float)
        gdhs_out.update({
            "asOf": _norm_date(pd.to_datetime(gd["公告日期"], errors="coerce").max()) if "公告日期" in gd.columns else q_gd,
            "reportPeriod": q_gd,
            "sampleCount": int(ratio.notna().sum()),
            "medianChangePct": _finite(ratio.median()) if ratio.notna().any() else None,
        })

    # ⑤ 个股精确公告日口径（新浪版，预埋）：市场级聚合不逐股出网
    precise: dict[str, Any] = {
        "netFlowYi": None,
        "label": "个股精确公告日口径（新浪十大流通股东）",
        "asOf": None,
        "note": "预埋：需精确公告日时按个股调用 get_stock_holder_announce（新浪版自带公告日期字段，#63）；市场级聚合不逐股出网",
    }

    path = {
        "pathId": "quarterlyStructure",
        "label": "M4 季频持仓结构",
        "netFlowYi": None,
        "signals": {
            "hkscHolding": hksc,
            "fundHoldCount": fund_hold_out,
            "holderNature": nature,
            "holderCount": gdhs_out,
            "preciseAnnounce": precise,
        },
        "asOf": next((q for q in (q_gdfx, q_fh, q_gd) if q), None),
        "note": "季频结构信号：只产信号不产 NF（netFlowYi 恒 null，#58）；公告滞后按「报告期+30–40 天」标注（#63）",
    }
    return path, degraded


# ---------------------------------------------------------------------------
# M5 北向（不可观测）+ 南向 signals（零重复出网）
# ---------------------------------------------------------------------------


def get_northbound_path(funds: Optional[dict[str, Any]] = None) -> tuple[dict[str, Any], list[dict]]:
    """M5 北向路径（#59 恒不可观测）：netFlowYi 恒 null；南向只作资金分流 signals。

    南向数据**只**来自 funds.get_funds 同一次 stock_hsgt_fund_flow_summary_em 响应
    （零重复出网，#59/#63）：本函数不发起任何网络请求。
    """
    degraded: list[dict] = []
    signals: dict[str, Any] = {"southboundNetYi": None, "southboundAsOf": None}
    north_asof = None
    if funds is None:
        degraded.append(make_degraded(
            "djiucai:get_institution",
            asOf=None,
            note="未传入 funds 载荷，南向信号置空（契约：南向随 funds 同次响应解析，零重复出网）",
        ))
    else:
        # 数值拷贝：与 funds 载荷零共享引用（南向与北向字段零共享，#59）
        sb = funds.get("southboundNetYi")
        signals["southboundNetYi"] = float(sb) if isinstance(sb, (int, float)) and math.isfinite(float(sb)) else None
        signals["southboundAsOf"] = funds.get("southboundAsOf")
        north_asof = funds.get("northAsOf")
    path = {
        "pathId": "northbound",
        "label": "M5 北向资金",
        "netFlowYi": None,
        "signals": signals,
        "asOf": north_asof,
        "note": "北向每日净买额自 2024-08-16 起上游停披露（接口 0 占位），恒不可观测；"
                "南向（港股通）日频真实披露但只作资金分流 signals，不得充当北向代理（#59）",
    }
    return path, degraded


# ---------------------------------------------------------------------------
# 预埋：个股精确公告日口径（新浪十大流通股东）
# ---------------------------------------------------------------------------


def get_stock_holder_announce(symbol: str) -> dict[str, Any]:
    """个股十大流通股东（新浪版，自带公告日期字段；#63 精确公告日对齐口，预埋）。

    :returns: ``{"symbol", "latestAnnounceDate", "rows", "degraded"}``；失败 → None + 标注。
    市场级聚合（M4）不逐股调用本函数（成本边界 #64）。
    """
    degraded: list[dict] = []
    try:
        df = _fetch_circulate_holder(symbol)
        if df is None or df.empty:
            raise ValueError("十大流通股东为空")
        latest = pd.to_datetime(df["公告日期"], errors="coerce").max()
        if pd.isna(latest):
            raise ValueError("公告日期列不可解析")
        return {
            "symbol": symbol,
            "latestAnnounceDate": latest.strftime("%Y-%m-%d"),
            "rows": int(len(df)),
            "degraded": degraded,
        }
    except Exception as err:  # noqa: BLE001
        degraded.append(make_degraded(
            "akshare:stock_circulate_stock_holder", asOf=None,
            note=f"个股 {symbol} 十大流通股东获取失败（{err}）",
        ))
        return {"symbol": symbol, "latestAnnounceDate": None, "rows": None, "degraded": degraded}


# ---------------------------------------------------------------------------
# 聚合入口
# ---------------------------------------------------------------------------


def get_institution(funds: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    """机构决策层原始载荷（宪法 #58–#60）。

    :param funds: :func:`djiucai_data.funds.get_funds` 的返回值（南向零重复出网来源）。
    :returns: ``{"asOf", "netFlowYi", "paths", "degraded"}``——顶层 netFlowYi 为**信息性**
        Σ(非 null 日频流量路径亿元、未折算)，仅展示、非 NF（折算只发生在 TS 侧，#60）。
    """
    paths: list[dict[str, Any]] = []
    degraded: list[dict] = []
    for builder in (get_margin_path, get_etf_path, get_event_seat_path, get_quarterly_path):
        path, deg = builder()
        paths.append(path)
        degraded.extend(deg)
    m5, deg5 = get_northbound_path(funds)
    paths.append(m5)
    degraded.extend(deg5)

    flows = [p["netFlowYi"] for p in paths if p["netFlowYi"] is not None]
    net = round(sum(flows), 6) if flows else None
    asof_candidates = [p["asOf"] for p in paths if p["asOf"]]
    return {
        "asOf": max(asof_candidates) if asof_candidates else now_ts_sh(),
        "netFlowYi": net,
        "paths": paths,
        "degraded": degraded,
    }
