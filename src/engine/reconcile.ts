/**
 * 对账与信任建设（需求 #35/#44）：预测自动对账、平局剔除、滚动命中率。
 */
import type { PredictionResult, ReconcileRecord } from './types.js';
import { classifyOutcome, directionOf, rollingHitRate } from './aggregate.js';

/**
 * 从一次预测运行生成 2 条对账记录：1 日 + 5 日（#20/#36 双 horizon）。
 * - 1d：第 1 日单日口径（offsetPct / 净流中位数符号）；
 * - 5d：累计口径（F5）——结算侧按「锚定日后第 5 个交易日收盘 vs 锚定收盘」算 5 日累计
 *   实际涨跌，预测侧因此也必须用累计值：(days[last].closeEstimate − anchorClose)/anchorClose，
 *   方向取 5 日累计偏移符号；不得拿第 5 日的单日递推偏移（K=1 净流符号）冒充 5 日预测。
 */
export function recordsFromPrediction(result: PredictionResult): ReconcileRecord[] {
  const mock = result.mock === true;
  const d1 = result.days[0];
  const rec1: ReconcileRecord | null = d1
    ? {
        anchorDate: result.anchorDate,
        horizon: '1d',
        index: result.index,
        predictedDirection: d1.direction,
        predictedMedianPct: d1.offsetPct,
        actualPct: null,
        outcome: null,
        settledAt: null,
        mock,
      }
    : null;
  const last = result.days[result.days.length - 1];
  let rec5: ReconcileRecord | null = null;
  if (d1 && last && result.days.length >= 2) {
    // anchorClose 由第 1 日估计值反解：closeEstimate_1 = anchorClose × (1 + offset_1/100)
    const anchorClose = d1.closeEstimate / (1 + d1.offsetPct / 100);
    const cumPct = ((last.closeEstimate - anchorClose) / anchorClose) * 100;
    rec5 = {
      anchorDate: result.anchorDate,
      horizon: '5d',
      index: result.index,
      predictedDirection: directionOf(cumPct),
      predictedMedianPct: cumPct,
      actualPct: null,
      outcome: null,
      settledAt: null,
      mock,
    };
  }
  return [rec1, rec5].filter((r): r is ReconcileRecord => r !== null);
}

/**
 * 结算：用日线序列找到锚定日之后第 h 个交易日的收盘。
 * barsMap: 日期 → 收盘价；daysSorted: 升序交易日列表。
 * 隔多日补跑容忍：数据不足的记录保持未结算，下次再试（#42 技术默认）。
 */
export function settleRecords(
  records: ReconcileRecord[],
  barsMap: Map<string, number>,
  daysSorted: string[],
  nowIso: string,
): { settled: ReconcileRecord[]; remaining: ReconcileRecord[] } {
  const settled: ReconcileRecord[] = [];
  const remaining: ReconcileRecord[] = [];
  for (const rec of records) {
    if (rec.outcome !== null) { settled.push(rec); continue; }
    const ai = daysSorted.indexOf(rec.anchorDate);
    const offset = rec.horizon === '1d' ? 1 : 5;
    const targetDate = ai >= 0 ? daysSorted[ai + offset] : undefined;
    const anchorClose = barsMap.get(rec.anchorDate);
    if (ai < 0 || targetDate === undefined || anchorClose === undefined) {
      remaining.push(rec);
      continue;
    }
    const targetClose = barsMap.get(targetDate);
    if (targetClose === undefined) { remaining.push(rec); continue; }
    const actualPct = ((targetClose - anchorClose) / anchorClose) * 100;
    settled.push({
      ...rec,
      actualPct,
      outcome: classifyOutcome(rec.predictedDirection, actualPct, 0.1),
      settledAt: nowIso,
    });
  }
  return { settled, remaining };
}

/** 滚动命中率（#35）：1 日与 5 日分开统计，平局剔除分母（#44）；mock 运行不计入（F21） */
export function reconcileSummary(records: ReconcileRecord[], window = 20): {
  d1: { hits: number; decided: number; rate: number; ties: number };
  d5: { hits: number; decided: number; rate: number; ties: number };
} {
  const settled = records.filter((r) => r.outcome !== null && r.mock !== true);
  const pick = (h: '1d' | '5d') =>
    settled
      .filter((r) => r.horizon === h)
      .sort((a, b) => a.anchorDate.localeCompare(b.anchorDate))
      .map((r) => r.outcome!) as ('hit' | 'miss' | 'tie')[];
  return { d1: rollingHitRate(pick('1d'), window), d5: rollingHitRate(pick('5d'), window) };
}

/** 命中率横幅文案（#35：「最近 20 次命中 12 次」） */
export function hitRateBanner(s: { hits: number; decided: number; rate: number; ties: number }): string {
  if (s.decided === 0) return '暂无已结算预测（平局不计入）';
  return `最近 ${s.decided} 次命中 ${s.hits} 次（另有 ${s.ties} 次平局未计入）`;
}
