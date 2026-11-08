/** 冲击映射（#21）与对账（#35/#44）单测 */
import { describe, it, expect } from 'vitest';
import { computeOffsetPct, applyOffset, IMPACT_UNCALIBRATED_NOTE } from '../src/engine/impact.js';
import { recordsFromPrediction, settleRecords, reconcileSummary, hitRateBanner } from '../src/engine/reconcile.js';
import { DEFAULT_CONFIG, type PredictionResult, type ReconcileRecord } from '../src/engine/types.js';

describe('impact（#21 一期未校准线性映射）', () => {
  it('offset = k × NF/总权重 × σ20×100', () => {
    expect(computeOffsetPct(10, 100, 0.18, 0.8)).toBeCloseTo(0.8 * 0.1 * 18);
  });
  it('零权重不出 NaN', () => {
    expect(computeOffsetPct(10, 0, 0.2, 0.8)).toBe(0);
  });
  it('applyOffset 线性外推（#40 无阻尼）', () => {
    expect(applyOffset(3000, 1)).toBeCloseTo(3030);
    expect(applyOffset(3000, -0.5)).toBeCloseTo(2985);
  });
  it('未校准标注常量存在（面板明示要求）', () => {
    expect(IMPACT_UNCALIBRATED_NOTE).toContain('未校准');
  });
});

function mkPrediction(days: Partial<{ direction: -1 | 0 | 1; offsetPct: number }>[]): PredictionResult {
  return {
    schemaVersion: 1, mode: 'prediction', index: 'SH000001', anchorDate: '2026-11-06',
    runAt: '2026-11-06T16:00:00Z', intradayNote: null,
    days: days.map((d, i) => ({
      tradeDate: `2026-11-${10 + i}`, netFlowMedian: 1, direction: d.direction ?? 1,
      offsetPct: d.offsetPct ?? 1, closeEstimate: 3000, band: { p10: 2950, p90: 3050 },
    })),
    terminal: { dist: [3000], median: 3000 }, multiBullPct: 0.6, multiBearPct: 0.2,
    dispersionNarrow: false, coldStartNote: null, representativeQuotes: [],
    report: { markdown: '', camps: [], dispersionNote: '', participationNote: null },
    rounds: [],
  };
}

describe('reconcile（#35/#44 双 horizon + 平局剔除）', () => {
  it('生成 1d + 5d 两条记录', () => {
    const recs = recordsFromPrediction(mkPrediction([{}, {}, {}, {}, {}]));
    expect(recs).toHaveLength(2);
    expect(recs[0]!.horizon).toBe('1d');
    expect(recs[1]!.horizon).toBe('5d');
  });
  it('结算：锚定日后第 h 个交易日收盘', () => {
    const barsMap = new Map([['2026-11-06', 3000], ['2026-11-09', 3090], ['2026-11-16', 3300]]);
    const days = [...barsMap.keys()].sort();
    const recs: ReconcileRecord[] = [
      { anchorDate: '2026-11-06', horizon: '1d', index: 'SH000001', predictedDirection: 1, predictedMedianPct: 1, actualPct: null, outcome: null, settledAt: null },
      { anchorDate: '2026-11-06', horizon: '5d', index: 'SH000001', predictedDirection: 1, predictedMedianPct: 1, actualPct: null, outcome: null, settledAt: null },
      { anchorDate: '2026-11-06', horizon: '1d', index: 'SH000001', predictedDirection: -1, predictedMedianPct: -1, actualPct: null, outcome: null, settledAt: null },
    ];
    const { settled, remaining } = settleRecords(recs, barsMap, days, 'now');
    // 1d：3090/3000 = +3% → 预测多命中、预测空失败；
    // 5d 需要 anchor 后第 5 个交易日，bars 只有 3 天 → 留在 remaining
    expect(settled).toHaveLength(2);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.horizon).toBe('5d');
    expect(settled[0]!.outcome).toBe('hit');
    expect(settled[1]!.outcome).toBe('miss');
  });
  it('数据不足保持未结算（隔多日补跑容忍）', () => {
    const barsMap = new Map([['2026-11-06', 3000]]);
    const recs: ReconcileRecord[] = [
      { anchorDate: '2026-11-06', horizon: '5d', index: 'SH000001', predictedDirection: 1, predictedMedianPct: 1, actualPct: null, outcome: null, settledAt: null },
    ];
    const { remaining } = settleRecords(recs, barsMap, ['2026-11-06'], 'now');
    expect(remaining).toHaveLength(1);
  });
  it('滚动命中率与横幅（#35「最近 20 次命中 12 次」）', () => {
    const recs: ReconcileRecord[] = Array.from({ length: 12 }, (_, i) => ({
      anchorDate: `2026-01-${String(i + 1).padStart(2, '0')}`, horizon: '1d' as const, index: 'SH000001' as const,
      predictedDirection: 1, predictedMedianPct: 1, actualPct: 1, outcome: 'hit' as const, settledAt: 'now',
    }));
    recs.push({
      anchorDate: '2026-01-20', horizon: '1d', index: 'SH000001', predictedDirection: 1, predictedMedianPct: 1,
      actualPct: 0.05, outcome: 'tie', settledAt: 'now',
    });
    const s = reconcileSummary(recs, 20).d1;
    expect(s.hits).toBe(12);
    expect(s.ties).toBe(1);
    expect(s.decided).toBe(12);
    expect(hitRateBanner(s)).toContain('命中 12 次');
    expect(hitRateBanner(s)).toContain('平局');
  });
  it('默认配置抽检（#28/#21/#38/#42）', () => {
    expect(DEFAULT_CONFIG.impactK).toBe(0.8);
    expect(DEFAULT_CONFIG.sandboxK).toBe(1);
    expect(DEFAULT_CONFIG.eventDecayDays).toBe(2);
    expect(DEFAULT_CONFIG.tieThresholdPct).toBe(0.1);
    expect(DEFAULT_CONFIG.quorumFloor).toBe(24);
    expect(DEFAULT_CONFIG.hotMoneyAmp).toBe(3);
    expect(DEFAULT_CONFIG.historyDays).toBe(250);
  });
});
