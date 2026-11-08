/**
 * 日期/波动率工具（#38 时区、#21 波动率标定）。
 */
import type { Bar } from './types.js';

/** 交易日历中严格晚于 after 的下一个交易日 */
export function nextTradeDay(calendar: string[], after: string): string {
  for (const d of calendar) {
    if (d > after) return d;
  }
  // 日历耗尽：按自然日顺推（周末跳过），并标注非权威
  const d = new Date(`${after}T00:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** 取 calendar 中 start 之后第 i 个交易日（i=0 返回**严格晚于** start 的下一个交易日——当前唯一调用方 sandbox 依赖此 +1 语义；与 docstring 旧表述「或 start 本身」不符是历史笔误，此处已澄清，F8） */
export function tradeDayFrom(calendar: string[], start: string, i: number): string {
  let cur = start;
  for (let k = 0; k < i + 1; k += 1) {
    const idx = calendar.indexOf(cur);
    cur = idx >= 0 ? (calendar[idx + 1] ?? nextTradeDay(calendar, cur)) : nextTradeDay(calendar, cur);
  }
  return cur;
}

/** Shanghai 本地时间 HH:mm（#46 盘中判定） */
export function shanghaiHHmm(d: Date): string {
  const ms = d.getTime() + 8 * 3600 * 1000;
  const iso = new Date(ms).toISOString();
  return iso.slice(11, 16);
}

/** 是否盘中（09:15–15:05 之间，#46） */
export function isIntraday(d: Date): boolean {
  const t = shanghaiHHmm(d);
  return t >= '09:15' && t <= '15:05';
}

/**
 * 期望的最新已收盘交易日（#24 新鲜度判定的基准）：
 * 上海时间 16:00 后（当日 bar 已发布）→ 当日（若为交易日）；否则 → 上一个交易日。
 * 盘前/盘中/收盘未发布期间锚定昨收（与 #46 盘中语义一致）。
 */
export function expectedLatestCloseDate(calendar: string[], now: Date): string | null {
  if (calendar.length === 0) return null;
  const today = shanghaiDateOf(calendar, now);
  const t = shanghaiHHmm(now);
  const past = calendar.filter((d) => d < today);
  if (calendar.includes(today) && t >= '16:00') return today;
  return past.length > 0 ? past[past.length - 1]! : null;
}

/** Shanghai 本地日期字符串（独立于 ClockPort，供日历比对） */
function shanghaiDateOf(_calendar: string[], d: Date): string {
  const ms = d.getTime() + 8 * 3600 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 20 日年化波动率（小数，如 0.18；#21 标定输入） */
export function computeVol20(bars: Bar[]): number {
  if (bars.length < 21) return 0.2; // 数据不足时的保守默认
  const closes = bars.slice(-21).map((b) => b.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    rets.push(Math.log(closes[i]! / closes[i - 1]!));
  }
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const variance = rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance * 250);
}

/** 分位数（线性插值） */
export function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo]!;
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}
