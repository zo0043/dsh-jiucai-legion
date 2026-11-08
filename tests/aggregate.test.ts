/** 聚合与命中口径单测（#43/#44/#51/#39；P1 意见气候；P5 资金加权份额） */
import { describe, it, expect } from 'vitest';
import {
  agentWeight, netFlowOfRound, median, directionOf, bullBearSplit,
  classifyOutcome, rollingHitRate, isDispersionNarrow, dispersionOf,
  opinionClimate, buildLegionClimate, capitalWeightedSplit, topWeightShare,
} from '../src/engine/aggregate.js';
import { createPool } from '../src/engine/persona-pool.js';
import { DEFAULT_CONFIG, HOT_MONEY_STYLES, type AgentOutput, type AgentState, type Persona, type RoundResult } from '../src/engine/types.js';

function persona(id: string, style: Persona['style'], tier: 1 | 2 | 3 | 4): Persona {
  return {
    id, name: id, style, capitalTier: tier, stability: 1, stance: 'range',
    biases: [], maxLossPct: style === 'hotmoney' ? 5 : null, baseline: 50, systemPrompt: 'x',
  };
}
function state(id: string, exposure: number): [string, AgentState] {
  return [id, { personaId: id, cash: 0, exposurePct: exposure, costBasis: null, emotion: 50, memory: [] }];
}

describe('agentWeight（#43 资金加权 × 游资放大）', () => {
  it('散户 tier1 = 1，游资 tier4 = 8 × 3', () => {
    expect(agentWeight(persona('a', 'trend', 1), DEFAULT_CONFIG)).toBe(1);
    expect(agentWeight(persona('b', 'hotmoney', 4), DEFAULT_CONFIG)).toBe(24);
  });
  it('游资放大系数可调', () => {
    expect(agentWeight(persona('b', 'speculator', 3), { ...DEFAULT_CONFIG, hotMoneyAmp: 2 })).toBe(4 * 2);
  });
});

describe('netFlowOfRound（#51 置信度调幅）', () => {
  it('满置信满仓进出相消', () => {
    const states = new Map([state('a', 0), state('b', 100)]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 100, confidence: 5, reason: '梭哈' },
      { personaId: 'b', targetPct: 0, confidence: 5, reason: '清仓' },
    ];
    const personas = new Map([[ 'a', persona('a', 'trend', 1)], ['b', persona('b', 'trend', 1)]]);
    expect(netFlowOfRound(outputs, states, personas, DEFAULT_CONFIG)).toBeCloseTo(0);
  });
  it('低置信度只试探 1/5（#51）', () => {
    const states = new Map([state('a', 0)]);
    const personas = new Map([['a', persona('a', 'trend', 1)]]);
    const outputs: AgentOutput[] = [{ personaId: 'a', targetPct: 100, confidence: 1, reason: '试试' }];
    expect(netFlowOfRound(outputs, states, personas, DEFAULT_CONFIG)).toBeCloseTo(0.2);
  });
});

describe('方向与命中（#44 中位数 + 平局剔除）', () => {
  it('median 偶数取均值；direction 取符号', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(directionOf(0.5)).toBe(1);
    expect(directionOf(-0.001)).toBe(-1);
    expect(directionOf(0)).toBe(0);
  });
  it('classifyOutcome：|x|<0.1% 平局剔除分母', () => {
    expect(classifyOutcome(1, 0.09, 0.1)).toBe('tie');
    expect(classifyOutcome(1, 0.5, 0.1)).toBe('hit');
    expect(classifyOutcome(1, -0.5, 0.1)).toBe('miss');
    expect(classifyOutcome(-1, -0.5, 0.1)).toBe('hit');
  });
  it('rollingHitRate：平局不计入分母（#44）', () => {
    const s = rollingHitRate(['hit', 'hit', 'miss', 'tie', 'hit'], 20);
    expect(s.hits).toBe(3);
    expect(s.ties).toBe(1);
    expect(s.decided).toBe(4);
    expect(s.rate).toBeCloseTo(0.75);
  });
});

describe('分歧度（#39）', () => {
  const mkRound = (dir: -1 | 0 | 1, nf: number): RoundResult =>
    ({ round: 1, outputs: [], missing: [], participants: 30, netFlow: nf, direction: dir, offsetPct: nf });
  it('5 轮全同向且离散度低 → 过窄告警', () => {
    expect(isDispersionNarrow([1, 2, 3, 4, 5].map((i) => mkRound(1, 10 + i * 0.01)))).toBe(true);
  });
  it('方向不一致 → 不过窄', () => {
    expect(isDispersionNarrow([mkRound(1, 10), mkRound(-1, -10), mkRound(1, 12), mkRound(-1, -8), mkRound(1, 11)])).toBe(false);
  });
  it('dispersionOf：全同向 0，均匀 2/3', () => {
    expect(dispersionOf([mkRound(1, 1), mkRound(1, 2), mkRound(1, 3)])).toBe(0);
    expect(dispersionOf([mkRound(1, 1), mkRound(-1, -1), mkRound(0, 0)])).toBeCloseTo(2 / 3);
  });
});

describe('多空统计（#26）', () => {
  it('bull/bear 按目标 vs 当前', () => {
    const states = new Map([state('a', 0), state('b', 100), state('c', 50)]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 80, confidence: 3, reason: '' },
      { personaId: 'b', targetPct: 20, confidence: 3, reason: '' },
      { personaId: 'c', targetPct: 50, confidence: 3, reason: '' },
    ];
    const s = bullBearSplit(outputs, states);
    expect(s.bullPct).toBeCloseTo(1 / 3);
    expect(s.bearPct).toBeCloseTo(1 / 3);
  });
});

describe('opinionClimate 意见气候（P1：按目标仓位水平测观点）', () => {
  it('全体满仓看多（目标≥70）→ 看多比例 >80%（现行动作差口径为 0，P1 验收）', () => {
    const states = new Map([state('a', 100), state('b', 100)]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 100, confidence: 3, reason: '' },
      { personaId: 'b', targetPct: 85, confidence: 3, reason: '' },
    ];
    // 旧口径对照：满仓→满仓无动作差，bullBearSplit 报 0（单边行情下播报反向气候的根因）
    expect(bullBearSplit(outputs, states).bullPct).toBe(0);
    const c = opinionClimate(outputs);
    expect(c.bullPct).toBe(1);
    expect(c.bullPct).toBeGreaterThan(0.8);
  });

  it('阈值边界：≥70 看多 / ≤30 看空 / 其余观望', () => {
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 70, confidence: 3, reason: '' }, // 看多（含边界）
      { personaId: 'b', targetPct: 69, confidence: 3, reason: '' }, // 观望
      { personaId: 'c', targetPct: 31, confidence: 3, reason: '' }, // 观望
      { personaId: 'd', targetPct: 30, confidence: 3, reason: '' }, // 看空（含边界）
    ];
    const c = opinionClimate(outputs);
    expect(c.bullPct).toBeCloseTo(0.25);
    expect(c.bearPct).toBeCloseTo(0.25);
    expect(c.neutralPct).toBeCloseTo(0.5);
    expect(c.count).toBe(4);
  });

  it('空输出 → 全 0（不伪造 100% 观望）', () => {
    expect(opinionClimate([])).toEqual({ bullPct: 0, bearPct: 0, neutralPct: 0, count: 0 });
  });
});

describe('buildLegionClimate 意见气候组装（P1）', () => {
  it('全团口径 + 分风格分组（人设缺失的输出不计组）', () => {
    const personas = new Map([
      ['a', persona('a', 'trend', 1)],
      ['b', persona('b', 'trend', 2)],
      ['c', persona('c', 'contrarian', 1)],
    ]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 90, confidence: 3, reason: '' },
      { personaId: 'b', targetPct: 20, confidence: 3, reason: '' },
      { personaId: 'ghost', targetPct: 95, confidence: 3, reason: '' }, // 无此人设 → 不计组
      { personaId: 'c', targetPct: 10, confidence: 3, reason: '' },
    ];
    const cl = buildLegionClimate('2026-11-06', outputs, personas);
    expect(cl.asOf).toBe('2026-11-06');
    expect(cl.overall.count).toBe(4);
    expect(cl.byStyle.trend?.count).toBe(2);
    expect(cl.byStyle.trend?.bullPct).toBeCloseTo(0.5);
    expect(cl.byStyle.contrarian?.bearPct).toBe(1);
    expect(cl.byStyle.hotmoney).toBeUndefined();
  });
});

describe('capitalWeightedSplit 资金加权份额（P5）', () => {
  it('按风格组：seed 2026 全池游资组（hotmoney+speculator）份额 = 108/174 ≈ 0.62（确定性，P5 验收 a）', () => {
    const { personas } = createPool({ ...DEFAULT_CONFIG, seed: 2026 });
    const pm = new Map(personas.map((p) => [p.id, p]));
    // 全员输出（分组只看风格，target 任意）；游资风格组 = HOT_MONEY_STYLES（#43 放大对象）
    const outputs: AgentOutput[] = personas.map((p) => ({ personaId: p.id, targetPct: 50, confidence: 3, reason: '' }));
    const shares = capitalWeightedSplit(outputs, pm, DEFAULT_CONFIG, (_o, p) =>
      HOT_MONEY_STYLES.includes(p.style) ? 'hotmoney' : p.style);
    const hot = personas.filter((p) => HOT_MONEY_STYLES.includes(p.style));
    const hotW = hot.reduce((s, p) => s + agentWeight(p, DEFAULT_CONFIG), 0);
    const total = personas.reduce((s, p) => s + agentWeight(p, DEFAULT_CONFIG), 0);
    expect(hotW).toBe(108);
    expect(total).toBe(174);
    expect(shares.get('hotmoney')).toBeCloseTo(108 / 174, 10); // ≈0.6207
    expect(shares.get('hotmoney')).toBeGreaterThan(0.6);
    // 份额和 = 1（人设缺失者除外）
    const sum = [...shares.values()].reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('按观点分组：≥70 看多 / ≤30 看空，人设缺失的输出不进任何组也不进分母', () => {
    const pm = new Map([
      ['a', persona('a', 'trend', 1)],   // 权重 1
      ['b', persona('b', 'hotmoney', 4)], // 权重 24
      ['c', persona('c', 'trend', 2)],   // 权重 2
    ]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 80, confidence: 3, reason: '' },  // 看多
      { personaId: 'b', targetPct: 80, confidence: 3, reason: '' },  // 看多
      { personaId: 'c', targetPct: 20, confidence: 3, reason: '' },  // 看空
      { personaId: 'ghost', targetPct: 90, confidence: 3, reason: '' }, // 无此人设 → 不计
    ];
    const shares = capitalWeightedSplit(outputs, pm, DEFAULT_CONFIG, (o) =>
      o.targetPct >= 70 ? 'bull' : o.targetPct <= 30 ? 'bear' : 'neutral');
    expect(shares.get('bull')).toBeCloseTo(25 / 27, 10);
    expect(shares.get('bear')).toBeCloseTo(2 / 27, 10);
    expect(shares.has('neutral')).toBe(false);
  });

  it('空输出 → 空 Map（读方按 0 处理）；topWeightShare 前 5 大户份额', () => {
    expect(capitalWeightedSplit([], new Map(), DEFAULT_CONFIG, () => 'x').size).toBe(0);
    const pm = new Map([
      ['a', persona('a', 'hotmoney', 4)], // 24
      ['b', persona('b', 'hotmoney', 4)], // 24
      ['c', persona('c', 'trend', 1)],    // 1
      ['d', persona('d', 'trend', 1)],    // 1
    ]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 50, confidence: 3, reason: '' },
      { personaId: 'b', targetPct: 50, confidence: 3, reason: '' },
      { personaId: 'c', targetPct: 50, confidence: 3, reason: '' },
      { personaId: 'd', targetPct: 50, confidence: 3, reason: '' },
    ];
    expect(topWeightShare(outputs, pm, DEFAULT_CONFIG, 5)).toBeCloseTo(1, 10); // n=5 > 4 人 → 全体
    expect(topWeightShare(outputs, pm, DEFAULT_CONFIG, 1)).toBeCloseTo(24 / 50, 10);
    expect(topWeightShare([], pm, DEFAULT_CONFIG, 5)).toBe(0);
  });
});
