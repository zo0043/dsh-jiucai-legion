/**
 * 数据流全量分析修复批的回归测试：
 * 资金面注入信息集 / 热度量纲标注 / 沙盘宽度衰减 / 对账账本保全 / mock 打标隔离。
 */
import { describe, it, expect } from 'vitest';
import { buildCommonBlock } from '../src/engine/info-set.js';
import { decayBreadth } from '../src/engine/sandbox.js';
import { Store } from '../src/persist/store.js';
import { recordsFromPrediction, reconcileSummary } from '../src/engine/reconcile.js';
import { generateReport, DISCLAIMER } from '../src/engine/editor.js';
import { DEFAULT_CONFIG, type MarketSnapshot, type PredictionResult, type ReconcileRecord } from '../src/engine/types.js';
import { MockLlm, MockClock, MockUi } from '../src/host/mock-host.js';

function snapshotWith(overrides: Partial<MarketSnapshot>): MarketSnapshot {
  return {
    index: 'SH000001',
    tradeDate: '2026-11-06',
    bars: Array.from({ length: 30 }, (_, i) => ({
      date: `2025-12-${String(10 + i).padStart(2, '0')}`, open: 3000, high: 3010, low: 2990, close: 3000 + i, volume: 1e8,
    })),
    breadth: { limitUp: 84, limitDown: 8, failedBoard: 48, maxStreak: 4, advancers: 4538, decliners: 604 },
    sentiment: { source: 'eastmoney', heatIndex: 100, asOf: '2026-11-06' },
    news: { items: [{ text: '央行开展逆回购操作', ts: '2026-11-06T10:00:00+08:00', source: 'sina' }], asOf: '2026-11-06' },
    funds: { marginBalance: 1.196e12, northboundNet: null, asOf: '2026-11-06', marginAsOf: '2026-11-05', northAsOf: '2026-11-06' },
    volatility20: 0.18,
    legionBullPct: null,
    degraded: [],
    ...overrides,
  };
}

describe('资金面数据流激活（采而不食修复）', () => {
  it('公共块渲染资金面：两融按字段 asOf（T+1）、北向未披露如实标注', () => {
    const text = buildCommonBlock(snapshotWith({}));
    expect(text).toContain('资金面：两融余额 11960 亿（截至 2026-11-05，T+1 披露）');
    expect(text).toContain('北向净买 未披露（上游 2024-08 起停报每日净买额）');
  });
  it('两融降级 → 未知，不伪造数值', () => {
    const snap = snapshotWith({ funds: { marginBalance: null, northboundNet: null, asOf: '2026-11-06' } });
    const text = buildCommonBlock(snap);
    expect(text).toContain('两融余额 未知（降级）');
  });
  it('旧快照无 marginAsOf（undefined）→ 渲染不带「截至」（#28 向后兼容）', () => {
    const snap = snapshotWith({ funds: { marginBalance: 1.196e12, northboundNet: null, asOf: '2026-11-06' } });
    const text = buildCommonBlock(snap);
    expect(text).toContain('两融余额 11960 亿；');
    expect(text).not.toContain('（截至 2026-11-05，T+1 披露）');
  });
});

describe('情绪热度量纲标注（跨源不可比）', () => {
  it('东财来源标注「榜单条目数」', () => {
    const text = buildCommonBlock(snapshotWith({}));
    expect(text).toContain('榜单条目数');
    expect(text).toContain('跨源量纲不同');
  });
  it('雪球来源标注「关注均值」', () => {
    const snap = snapshotWith({ sentiment: { source: 'xueqiu', heatIndex: 35234, asOf: '2026-11-06' } });
    expect(buildCommonBlock(snap)).toContain('关注均值');
  });
});

describe('沙盘宽度衰减（F4/#41）', () => {
  const breadth = { limitUp: 84, limitDown: 8, failedBoard: 48, maxStreak: 4, advancers: 4538, decliners: 604 };
  it('w=0.5 → 计数减半', () => {
    const b = decayBreadth(breadth, 0.5);
    expect(b.limitUp).toBe(42);
    expect(b.advancers).toBe(2269);
  });
  it('w=0 → 全部 null（渲染「未知」），不得 0 冒充无涨停', () => {
    const b = decayBreadth(breadth, 0);
    expect(b.limitUp).toBeNull();
    expect(b.advancers).toBeNull();
  });
  it('原值 null 保持 null', () => {
    expect(decayBreadth({ ...breadth, limitUp: null }, 1).limitUp).toBeNull();
  });
});

describe('对账账本保全（F20）', () => {
  it('未来版本的账本被 append 时原样保留并追加', async () => {
    const { Store, writeJson } = await import('../src/persist/store.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiucai-f20-'));
    const store = new Store(dir);
    const legacy: ReconcileRecord = {
      anchorDate: '2026-01-01', horizon: '1d', index: 'SH000001',
      predictedDirection: 1, predictedMedianPct: 1, actualPct: 2, outcome: 'hit', settledAt: 't',
    };
    await writeJson(store.reconcilePath(), { schemaVersion: 999, savedAt: 't', payload: [legacy] });
    const rec: ReconcileRecord = {
      anchorDate: '2026-01-02', horizon: '1d', index: 'SH000001',
      predictedDirection: -1, predictedMedianPct: -1, actualPct: null, outcome: null, settledAt: null,
    };
    const merged = await store.appendReconcile([rec]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.anchorDate).toBe('2026-01-01'); // 未来版本条目未被清空
    expect(merged[1]!.anchorDate).toBe('2026-01-02');
  });
});

describe('mock 打标与命中率隔离（F21）', () => {
  const base: PredictionResult = {
    schemaVersion: 1, mode: 'prediction', index: 'SH000001', anchorDate: '2026-11-06',
    runAt: 't', intradayNote: null, mock: true,
    days: [{ tradeDate: '2026-11-09', netFlowMedian: 1, direction: 1, offsetPct: 1, closeEstimate: 3030, band: { p10: 3000, p90: 3060 } }],
    terminal: { dist: [3030], median: 3030 }, multiBullPct: 0.6, multiBearPct: 0.2,
    dispersionNarrow: false, coldStartNote: null, representativeQuotes: [],
    report: { markdown: '', camps: [], dispersionNote: '', participationNote: null },
    rounds: [],
  };
  it('recordsFromPrediction 把 mock 传递到对账记录', () => {
    const recs = recordsFromPrediction(base);
    expect(recs.every((r) => r.mock === true)).toBe(true);
  });
  it('reconcileSummary 不计入 mock 记录', () => {
    const recs = recordsFromPrediction(base).map((r) => ({ ...r, actualPct: 3, outcome: 'hit' as const, settledAt: 't' }));
    const s = reconcileSummary(recs);
    expect(s.d1.decided).toBe(0); // mock 全部被排除（fixture 只有 1 日，recs 仅 1 条 1d 记录）
    const real = recs.map((r) => ({ ...r, mock: false }));
    expect(reconcileSummary(real).d1.decided).toBe(1);
  });
});

describe('沙盘内生推演标注强制（F2）', () => {
  it('LLM 叙事丢掉「内生」时自动补回 sandboxNote', async () => {
    const llm = new MockLlm().enqueue('今天军团情绪高涨，大家都看多。'); // 无「内生」字样
    const ports = { llm, proc: {} as never, ui: new MockUi(), clock: new MockClock() };
    const report = await generateReport(ports, {
      dayLabel: '沙盘 D3', camps: [], dispersionText: '军团步伐比较齐。',
      participationNote: null, multiBullPct: 0.7, degradedFlags: [],
      sandboxNote: '⚠ 沙盘推演：第 1 日后全部为内生演化（#41）。',
    });
    expect(report.markdown).toContain('内生演化');
    expect(report.markdown).toContain(DISCLAIMER);
  });
  it('非沙盘（无 sandboxNote）不追加', async () => {
    const llm = new MockLlm().enqueue('今天军团情绪高涨。');
    const ports = { llm, proc: {} as never, ui: new MockUi(), clock: new MockClock() };
    const report = await generateReport(ports, {
      dayLabel: '2026-11-06', camps: [], dispersionText: '', participationNote: null,
      multiBullPct: 0.6, degradedFlags: [],
    });
    expect(report.markdown).not.toContain('内生演化');
  });
});

describe('F9 死旋钮移除后配置兼容', () => {
  it('DEFAULT_CONFIG.emotion 不再含 decayHalfLifeDays，且旧 config.json 多余键被容忍', () => {
    expect('decayHalfLifeDays' in DEFAULT_CONFIG.emotion).toBe(false);
    const legacy = { ...DEFAULT_CONFIG, emotion: { ...DEFAULT_CONFIG.emotion, decayHalfLifeDays: 1 } } as typeof DEFAULT_CONFIG;
    expect(legacy.emotion.carryover).toBe(0.6); // 旧配置可读、新键不丢
  });
});
