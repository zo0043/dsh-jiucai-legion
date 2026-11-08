/**
 * memory 记忆环形缓冲测试 —— 零网络、零 LLM。
 * 覆盖：上限 20 条 FIFO（#15）、不可变更新、pnlStatsLine 判定/计数口径（#52，逐字保留）、
 * buildMemoryPrompt 空记忆文案与摘要内容；P2 方向结算（directionStatsLine/calibrationLine、
 * 纪律止损豁免 #49、缺员结算、跳日断档、intendedDir push 口径）。
 */
import { describe, expect, it } from 'vitest';
import { MEMORY_LIMIT, buildMemoryPrompt, calibrationLine, directionStatsLine, pnlStatsLine, pushMemory } from '../src/engine/memory.js';
import { applyFeedback, realizedRetMapFromBars } from '../src/engine/feedback.js';
import { DEFAULT_CONFIG, type AgentOutput, type AgentState, type MemoryItem, type Persona } from '../src/engine/types.js';

function mem(day: string, realized: number | null, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    day,
    action: '加仓',
    targetPct: 60,
    confidence: 3,
    realizedPnlPct: realized,
    reason: '放量跟一手',
    ...overrides,
  };
}

function makeState(memory: MemoryItem[] = []): AgentState {
  return { personaId: 'p01', cash: 100000, exposurePct: 50, costBasis: 3200, emotion: 55, memory };
}

describe('pushMemory 上限 20 与 FIFO（#15）', () => {
  it('未超上限直接追加', () => {
    const s0 = makeState();
    const s1 = pushMemory(s0, mem('d1', null));
    expect(s1.memory).toHaveLength(1);
    expect(s1.memory[0]?.day).toBe('d1');
  });

  it('超过 20 条丢弃最老（FIFO）', () => {
    let s = makeState();
    for (let i = 0; i < 25; i += 1) {
      s = pushMemory(s, mem(`d${i}`, i % 2 === 0 ? 1 : -1));
    }
    expect(s.memory).toHaveLength(MEMORY_LIMIT);
    expect(s.memory[0]?.day).toBe('d5'); // 最老的 5 条被丢
    expect(s.memory[s.memory.length - 1]?.day).toBe('d24');
  });

  it('连续多条也只保留最新 20 条', () => {
    const items = Array.from({ length: 30 }, (_, i) => mem(`x${i}`, null));
    let s = makeState();
    for (const it of items) s = pushMemory(s, it);
    expect(s.memory).toHaveLength(20);
    expect(s.memory.map((m) => m.day)).toEqual(items.slice(10).map((m) => m.day));
  });

  it('不可变：返回新对象，原 state 与原 memory 数组不受影响', () => {
    const s0 = makeState([mem('d0', 2)]);
    const s1 = pushMemory(s0, mem('d1', -1));
    expect(s0.memory).toHaveLength(1);
    expect(s1.memory).toHaveLength(2);
    expect(s1).not.toBe(s0);
    expect(s1.memory).not.toBe(s0.memory);
    // 再写 s1 不影响 s0
    pushMemory(s1, mem('d2', null));
    expect(s0.memory).toHaveLength(1);
    expect(s1.memory).toHaveLength(2);
  });
});

describe('pnlStatsLine 判断/错误计数口径（#52）', () => {
  it('realizedPnlPct 非空才算判断；错 = 方向亏（<0）；0 不算错', () => {
    const items = [
      mem('d1', 2.1), // 对
      mem('d2', -0.8), // 错
      mem('d3', null), // 未结算，不计
      mem('d4', -3), // 错
      mem('d5', 0), // 平盘，不算错但算判断
    ];
    expect(pnlStatsLine(items)).toBe('近 4 次判断错了 2 次');
  });

  it('空记忆返回空串', () => {
    expect(pnlStatsLine([])).toBe('');
  });

  it('只有未结算记录也返回空串', () => {
    expect(pnlStatsLine([mem('d1', null), mem('d2', null)])).toBe('');
  });

  it('全对/全错的极端', () => {
    expect(pnlStatsLine([mem('a', 1), mem('b', 0.5)])).toBe('近 2 次判断错了 0 次');
    expect(pnlStatsLine([mem('a', -1), mem('b', -0.5)])).toBe('近 2 次判断错了 2 次');
  });
});

describe('buildMemoryPrompt 记忆摘要（#15/#52）', () => {
  it('空记忆返回「（你还没有任何操作记忆）」', () => {
    expect(buildMemoryPrompt(makeState())).toBe('（你还没有任何操作记忆）');
  });

  it('包含统计行与最近记录明细', () => {
    const s = makeState([
      mem('2026-11-01', 1.5, { action: '加仓', reason: '突破跟多' }),
      mem('2026-11-02', -0.6, { action: '减仓', reason: '破位先跑' }),
      mem('2026-11-03', null, { action: '持稳', reason: '再看一天' }),
    ]);
    const text = buildMemoryPrompt(s);
    expect(text).toContain('【操作记忆】');
    expect(text).toContain('近 2 次判断错了 1 次');
    expect(text).toContain('2026-11-01 加仓');
    expect(text).toContain('突破跟多');
    expect(text).toContain('盈亏 +1.5%');
    expect(text).toContain('盈亏 -0.6%');
    expect(text).toContain('未结算');
  });

  it('最多展示最近 5 条明细（统计仍覆盖全部记忆）', () => {
    const items = Array.from({ length: 8 }, (_, i) => mem(`d${i}`, i === 0 ? -1 : 1));
    const text = buildMemoryPrompt(makeState(items));
    expect(text).toContain('近 8 次判断错了 1 次');
    expect(text).toContain('d7');
    expect(text).not.toContain('d0 ');
    expect(text).not.toContain('d2 ');
  });
});

// ---------- P2 方向结算 ----------

/** 带方向结算字段的记忆条 */
function dirMem(
  day: string,
  intendedDir: -1 | 0 | 1,
  judgmentRet: number | null,
  stopLoss = false,
  confidence: 1 | 2 | 3 | 4 | 5 = 3,
): MemoryItem {
  return {
    day,
    action: intendedDir === 1 ? '加仓' : intendedDir === -1 ? '减仓' : '持稳',
    targetPct: 60,
    confidence,
    realizedPnlPct: null,
    reason: '方向结算',
    intendedDir,
    judgmentRet,
    stopLoss,
  };
}

function fbPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p01', name: '测试哥', style: 'trend', capitalTier: 2, stability: 1,
    stance: 'range', biases: [], maxLossPct: null, baseline: 50, systemPrompt: '',
    ...overrides,
  };
}

function fbState(overrides: Partial<AgentState> = {}): AgentState {
  return { personaId: 'p01', cash: 100000, exposurePct: 50, costBasis: 3200, emotion: 55, memory: [], ...overrides };
}

function bar(date: string, close: number) {
  return { date, open: close, high: close, low: close, close, volume: 1e8 };
}

describe('directionStatsLine 方向结算口径（P2）', () => {
  it('纪律止损豁免：止损项不计「错」并计入止损豁免计数', () => {
    const items = [
      dirMem('d1', -1, -2.5, true), // 止损后市场反弹 → judgmentRet<0，但按纪律止损豁免
      dirMem('d2', 1, 1.2),
    ];
    expect(directionStatsLine(items)).toBe('近 2 次方向判断对了 2 次（其中按纪律止损 1 次，不算错）');
  });

  it('散户亏损减仓（非纪律止损）：照常计「错」', () => {
    expect(directionStatsLine([dirMem('d1', -1, -2, false)])).toBe('近 1 次方向判断对了 0 次');
  });

  it('未结算（judgmentRet=null）与持稳（intendedDir=0）不进方向统计', () => {
    const items = [dirMem('d1', 1, null), dirMem('d2', 0, 0), dirMem('d3', 1, -1.5)];
    expect(directionStatsLine(items)).toBe('近 1 次方向判断对了 0 次');
  });

  it('纯加仓者结算后方向行非空（#52 漂移信号修复：realizedPnlPct 恒 null 不再卡死记忆）', () => {
    expect(directionStatsLine([])).toBe('');
    expect(directionStatsLine([dirMem('d1', 1, null)])).toBe('');
    expect(directionStatsLine([dirMem('d1', 1, 2.1)])).toBe('近 1 次方向判断对了 1 次');
  });
});

describe('calibrationLine 信心校准（P2）', () => {
  it('高信心（4–5）与低信心（1–3）分桶命中率', () => {
    const items = [
      dirMem('d1', 1, 2, false, 5), // 高 对
      dirMem('d2', -1, -1.5, false, 4), // 高 错
      dirMem('d3', 1, 3, false, 2), // 低 对
      dirMem('d4', 1, -1, false, 1), // 低 错
      dirMem('d5', 1, 1, false, 3), // 低 对
    ];
    expect(calibrationLine(items)).toBe('信心校准：信心 4–5 命中 1/2，信心 1–3 命中 2/3');
  });

  it('平盘（judgmentRet=0）不进命中率分母；某侧无样本则省略该侧', () => {
    expect(calibrationLine([dirMem('d1', 1, 0, false, 5)])).toBe('');
    expect(calibrationLine([])).toBe('');
    expect(calibrationLine([dirMem('d1', 1, 2, false, 4)])).toBe('信心校准：信心 4–5 命中 1/1');
  });
});

describe('applyFeedback 方向结算（P2）', () => {
  it('游资（maxLossPct=5）浮亏 ≥5% 减仓后市场反弹 → 不计「错」且计入止损豁免计数', () => {
    const persona = fbPersona({ maxLossPct: 5, style: 'hotmoney' });
    const states = new Map([['p01', fbState({ exposurePct: 100, costBasis: 100 })]]);
    const outputs: AgentOutput[] = [{ personaId: 'p01', targetPct: 60, confidence: 4, reason: '纪律止损' }];
    // execPrice 94：对成本浮亏 −6% ≤ −5% → 触发纪律止损；随后一个交易日反弹 +3%
    const fed = applyFeedback(states, outputs, new Map([['p01', persona]]), {
      execPrice: 94, marketRet: -0.06, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: new Map([['2026-11-06', 0.03]]),
    });
    const item = fed.get('p01')!.memory[0]!;
    expect(item.stopLoss).toBe(true);
    expect(item.intendedDir).toBe(-1);
    expect(item.judgmentRet).toBeCloseTo(-3, 6); // −1 × 3%
    expect(directionStatsLine(fed.get('p01')!.memory)).toBe('近 1 次方向判断对了 1 次（其中按纪律止损 1 次，不算错）');
  });

  it('散户（maxLossPct=null）亏损减仓后市场反弹 → 照常计「错」', () => {
    const persona = fbPersona({ maxLossPct: null });
    const states = new Map([['p01', fbState({ exposurePct: 100, costBasis: 100 })]]);
    const outputs: AgentOutput[] = [{ personaId: 'p01', targetPct: 60, confidence: 4, reason: '恐慌割肉' }];
    const fed = applyFeedback(states, outputs, new Map([['p01', persona]]), {
      execPrice: 94, marketRet: -0.06, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: new Map([['2026-11-06', 0.03]]),
    });
    const item = fed.get('p01')!.memory[0]!;
    expect(item.stopLoss).toBe(false);
    expect(directionStatsLine(fed.get('p01')!.memory)).toBe('近 1 次方向判断对了 0 次');
  });

  it('stopLoss 阈值边界：浮亏恰为 maxLossPct 豁免（≤）；未达不豁免', () => {
    const persona = fbPersona({ maxLossPct: 5, style: 'hotmoney' });
    const outputs: AgentOutput[] = [{ personaId: 'p01', targetPct: 0, confidence: 5, reason: '清仓' }];
    const at = applyFeedback(new Map([['p01', fbState({ exposurePct: 100, costBasis: 100 })]]), outputs, new Map([['p01', persona]]), {
      execPrice: 95, marketRet: 0, day: 'd', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(), realizedRetByDay: new Map(),
    });
    expect(at.get('p01')!.memory[0]!.stopLoss).toBe(true); // −5% ≤ −5%
    const below = applyFeedback(new Map([['p01', fbState({ exposurePct: 100, costBasis: 100 })]]), outputs, new Map([['p01', persona]]), {
      execPrice: 95.1, marketRet: 0, day: 'd', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(), realizedRetByDay: new Map(),
    });
    expect(below.get('p01')!.memory[0]!.stopLoss).toBe(false); // −4.9% > −5%
  });

  it('缺员 Agent 的 T 日判断在 T+1 bar 可得时被结算（不依赖 outputs、不与 T+2 收益错配）', () => {
    const states = new Map<string, AgentState>([
      ['p01', fbState()],
      ['p02', fbState({ personaId: 'p02', memory: [dirMem('2026-11-05', 1, null)] })], // p02 上轮缺席，判断留在记忆
    ]);
    const outputs: AgentOutput[] = [{ personaId: 'p01', targetPct: 70, confidence: 3, reason: '今日只有 p01 参战' }];
    const fed = applyFeedback(states, outputs, new Map([
      ['p01', fbPersona()],
      ['p02', fbPersona({ id: 'p02', name: '缺员' })],
    ]), {
      execPrice: 3210, marketRet: 0.01, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: new Map([['2026-11-05', 0.02]]), // T+1 bar 相对 T 的涨跌
    });
    expect(fed.get('p02')!.memory[0]!.judgmentRet).toBeCloseTo(2, 6); // 1 × 2%
  });

  it('跳日断档：按 bars 相邻对结算（T 之后第一个交易日），隔多日补跑由日线自动补齐兜底', () => {
    const states = new Map([['p01', fbState({ memory: [dirMem('2026-11-04', -1, null)] })]]);
    const fed = applyFeedback(states, [], new Map([['p01', fbPersona()]]), {
      execPrice: 3200, marketRet: 0, day: '2026-11-07', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: realizedRetMapFromBars([bar('2026-11-04', 100), bar('2026-11-07', 102)]),
    });
    expect(fed.get('p01')!.memory[0]!.judgmentRet).toBeCloseTo(-2, 6); // −1 × 2%
  });

  it('次日 bar 缺失（判断日=末根）→ 保持未结算', () => {
    const states = new Map([['p01', fbState({ memory: [dirMem('2026-11-06', 1, null)] })]]);
    const fed = applyFeedback(states, [], new Map([['p01', fbPersona()]]), {
      execPrice: 3200, marketRet: 0, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: realizedRetMapFromBars([bar('2026-11-06', 3200)]),
    });
    expect(fed.get('p01')!.memory[0]!.judgmentRet).toBeNull();
  });

  it('旧落盘记忆无 intendedDir → 不结算、不进方向统计（升级后新判断自愈）', () => {
    const states = new Map([['p01', fbState({ memory: [mem('2026-11-05', -1)] })]]); // 无 intendedDir/judgmentRet
    const fed = applyFeedback(states, [], new Map([['p01', fbPersona()]]), {
      execPrice: 3200, marketRet: 0, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: new Map([['2026-11-05', 0.02]]),
    });
    const item = fed.get('p01')!.memory[0]!;
    expect(item.judgmentRet ?? null).toBeNull();
    expect(directionStatsLine([item])).toBe('');
    expect(pnlStatsLine([item])).toBe('近 1 次判断错了 1 次'); // #52 盈亏口径不受影响
  });

  it('intendedDir push 口径：sign(target−exposure)，|delta|≤1 记 0（与 action 阈值一致）', () => {
    const persona = fbPersona();
    const run = (target: number): MemoryItem => {
      const fed = applyFeedback(
        new Map([['p01', fbState({ exposurePct: 50 })]]),
        [{ personaId: 'p01', targetPct: target, confidence: 3, reason: '' }],
        new Map([['p01', persona]]),
        {
          execPrice: 3200, marketRet: 0, day: 'd', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
          realizedRetByDay: new Map(),
        },
      );
      return fed.get('p01')!.memory[0]!;
    };
    expect(run(100).intendedDir).toBe(1);
    expect(run(51).intendedDir).toBe(0);
    expect(run(49).intendedDir).toBe(0);
    expect(run(0).intendedDir).toBe(-1);
    expect(run(100).action).toBe('加仓');
    expect(run(51).action).toBe('持稳');
    expect(run(0).action).toBe('减仓');
  });
});

describe('buildMemoryPrompt 方向行与校准行（P2，#52 原行逐字保留）', () => {
  it('#52 盈亏行保留 + 新增方向行与校准行', () => {
    const items = [
      { ...dirMem('2026-11-01', 1, 1.5, false, 5), realizedPnlPct: 1.5, reason: '突破跟多' },
      { ...dirMem('2026-11-02', -1, -0.6, false, 2), realizedPnlPct: -0.6, reason: '破位先跑' },
      mem('2026-11-03', null),
    ];
    const text = buildMemoryPrompt(makeState(items));
    expect(text).toContain('近 2 次判断错了 1 次'); // #52 原行（盈亏口径）逐字保留
    expect(text).toContain('近 2 次方向判断对了 1 次'); // P2 方向行
    expect(text).toContain('信心校准：信心 4–5 命中 1/1，信心 1–3 命中 0/1'); // P2 校准行
    expect(text).toContain('未结算');
  });

  it('无已结算方向判断 → 只出现 #52 行（不出现空方向行）', () => {
    const text = buildMemoryPrompt(makeState([mem('2026-11-04', 1.2), mem('2026-11-05', -0.9)]));
    expect(text).toContain('近 2 次判断错了 1 次');
    expect(text).not.toContain('方向判断');
    expect(text).not.toContain('信心校准');
  });
});
