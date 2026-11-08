/**
 * editor 总编测试（P5 社会镜像精度）—— 零网络（generateReport 经 MockLlm 捕获 prompt）。
 * 钉：阵营 weightShare 资金加权（验收 b：5 游资 108/372 ≈ 0.29）、三元代表发言带署名、
 * 集中度传闻判定（cfg 阈值生效）、当日阵营分歧话术实测化（一致/分裂两样例）、
 * reduce 提示资金镜像行。
 */
import { describe, expect, it } from 'vitest';
import { buildCamps, buildLegionMirror, campDispersion, dispersionNote, generateReport } from '../src/engine/editor.js';
import { agentWeight } from '../src/engine/aggregate.js';
import { MockLlm, MockClock, MockUi } from '../src/host/mock-host.js';
import { DEFAULT_CONFIG, type AgentOutput, type AgentState, type EngineConfig, type Persona } from '../src/engine/types.js';

const cfg: EngineConfig = { ...DEFAULT_CONFIG };

function persona(id: string, style: Persona['style'], tier: 1 | 2 | 3 | 4, name = `昵称${id}`): Persona {
  return {
    id, name, style, capitalTier: tier, stability: 1, stance: 'range',
    biases: [], maxLossPct: style === 'hotmoney' || style === 'speculator' ? 5 : null,
    baseline: 50, systemPrompt: 'x',
  };
}

function state(id: string, exposure: number): [string, AgentState] {
  return [id, { personaId: id, cash: 0, exposurePct: exposure, costBasis: null, emotion: 50, memory: [] }];
}

/** 验收 b 构造：5 游资（权重和 108 = 4×24 + 12）同落多军 + 33 个 tier-4 散户（264）落空军 → 参战者权重和 372 */
function whaleFixture(): { personas: Map<string, Persona>; states: Map<string, AgentState>; outputs: AgentOutput[] } {
  const hotTiers: (3 | 4)[] = [4, 4, 4, 3, 4];
  const personas = new Map<string, Persona>();
  const states = new Map<string, AgentState>();
  const outputs: AgentOutput[] = [];
  hotTiers.forEach((tier, i) => {
    const id = `h${i + 1}`;
    personas.set(id, persona(id, 'hotmoney', tier));
    states.set(id, state(id, 0)[1]);
    outputs.push({ personaId: id, targetPct: 100, confidence: 5, reason: `游资 ${id} 梭哈` }); // delta=100 → bull
  });
  for (let i = 1; i <= 33; i += 1) {
    const id = `r${String(i).padStart(2, '0')}`;
    personas.set(id, persona(id, 'trend', 4));
    states.set(id, state(id, 100)[1]);
    outputs.push({ personaId: id, targetPct: 0, confidence: 5, reason: `散户 ${i} 清仓` }); // delta=-100 → bear
  }
  return { personas, states, outputs };
}

describe('buildCamps 资金权重份额（P5 验收 b）', () => {
  it('5 游资同落一 camp → weightShare = 108/372 ≈ 0.29（分母=参战者权重和，非人头）', () => {
    const { personas, states, outputs } = whaleFixture();
    const camps = buildCamps(outputs, states, personas, cfg);
    const bull = camps.find((c) => c.camp === 'bull')!;
    const bear = camps.find((c) => c.camp === 'bear')!;
    expect(agentWeight(personas.get('h1')!, cfg)).toBe(24);
    expect(bull.count).toBe(5);
    expect(bear.count).toBe(33);
    expect(bull.weightShare).toBeCloseTo(108 / 372, 10); // ≈0.2903
    expect(bull.weightShare).toBeGreaterThan(0.29);
    expect(bear.weightShare).toBeCloseTo(264 / 372, 10);
    // 对照：人头份额 5/38 ≈ 0.13 —— 资金加权口径显著不同（P5 的根因修正）
    expect(bull.weightShare).not.toBeCloseTo(5 / 38, 1);
  });

  it('人设缺失的输出不计入任何阵营、也不进分母', () => {
    const personas = new Map([['a', persona('a', 'trend', 1)]]);
    const states = new Map([state('a', 0)]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 100, confidence: 3, reason: 'x' },
      { personaId: 'ghost', targetPct: 100, confidence: 3, reason: 'y' },
    ];
    const bull = buildCamps(outputs, states, personas, cfg).find((c) => c.camp === 'bull')!;
    expect(bull.count).toBe(1);
    expect(bull.weightShare).toBe(1); // 分母只有 a 的权重 1
  });

  it('无参战者 → weightShare 全 0', () => {
    const camps = buildCamps([], new Map(), new Map(), cfg);
    expect(camps.every((c) => c.weightShare === 0 && c.count === 0)).toBe(true);
  });
});

describe('buildCamps 三元代表发言与署名（P5，设计 §5.10）', () => {
  it('影响力×极端度取 2 条 + 最反差 1 条，三元互不相同且带署名', () => {
    // bull 阵营 4 人：score = weight×|delta| → a(24×60=1440) > b(24×50=1200) > c(8×40=320) > d(1×10)
    // 三元 = [a, b]（前 2 高分）+ d（|delta| 最小=最反差）；c 被排除（旧「按 reason 长度」口径不再生效）
    const personas = new Map([
      ['a', persona('a', 'hotmoney', 4, '龙头大哥')],
      ['b', persona('b', 'hotmoney', 4, '打板狂人')],
      ['c', persona('c', 'trend', 4, '趋势老哥')],
      ['d', persona('d', 'trend', 1, '小散一枚')],
    ]);
    const states = new Map([
      state('a', 40), state('b', 50), state('c', 60), state('d', 90),
    ]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 100, confidence: 5, reason: '龙头信仰' },
      { personaId: 'b', targetPct: 100, confidence: 5, reason: '板上加仓' },
      { personaId: 'c', targetPct: 100, confidence: 5, reason: '突破跟多这一条理由故意写得很长很长用来验证不再按长度挑发言' },
      { personaId: 'd', targetPct: 100, confidence: 5, reason: '跟着买一点' },
    ];
    const bull = buildCamps(outputs, states, personas, cfg).find((c) => c.camp === 'bull')!;
    const ids = bull.quotes.map((q) => q.personaId);
    expect(ids).toEqual(['a', 'b', 'd']); // 三元各不相同；长理由的 c 不再因长度入选
    expect(new Set(ids).size).toBe(3);
    // 署名结构：personaId + name + style + capitalTier + reason
    expect(bull.quotes[0]).toMatchObject({ personaId: 'a', name: '龙头大哥', style: 'hotmoney', capitalTier: 4, reason: '龙头信仰' });
    expect(bull.quotes[2]).toMatchObject({ personaId: 'd', name: '小散一枚', capitalTier: 1 }); // 最反差 = 阵营内 |delta| 最小者
  });

  it('阵营不足 3 人时按分数序给全（自然去重）', () => {
    const personas = new Map([
      ['a', persona('a', 'hotmoney', 4)],
      ['b', persona('b', 'trend', 1)],
    ]);
    const states = new Map([state('a', 0), state('b', 90)]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 100, confidence: 5, reason: 'x1' },
      { personaId: 'b', targetPct: 100, confidence: 5, reason: 'x2' },
    ];
    const bull = buildCamps(outputs, states, personas, cfg).find((c) => c.camp === 'bull')!;
    expect(bull.quotes.map((q) => q.personaId)).toEqual(['a', 'b']);
  });
});

describe('generateReport 署名渲染与资金镜像行（P5）', () => {
  it('reduce prompt 含「@昵称（风格·N档）」署名与「多军资金占比/前 5 大户贡献」', async () => {
    const llm = new MockLlm();
    llm.enqueue('今天军团吵疯了，多军全是游资大哥。');
    const ports = { llm, proc: { spawn: (): never => { throw new Error('不触达'); } }, ui: new MockUi(), clock: new MockClock() };
    const { personas, states, outputs } = whaleFixture();
    const camps = buildCamps(outputs, states, personas, cfg);
    const report = await generateReport(ports, {
      dayLabel: '2026-11-06',
      camps,
      dispersionText: dispersionNote(0.1, false),
      participationNote: null,
      multiBullPct: 0.13,
      degradedFlags: [],
      topWhaleShare: 24 / 372,
    });
    const prompt = llm.calls[0]!.req.messages[0]!.content;
    expect(prompt).toContain('@昵称h1（打板游资·4档）：游资 h1 梭哈'); // 署名（STYLE_LABEL.hotmoney）
    expect(prompt).toContain('多军 5 人（资金占比 29%）'); // 108/372 → 29%（P5 验收 b 的口径进叙事）
    expect(prompt).toContain('资金镜像：多军资金占比 29%，前 5 大户贡献 6%（按在场资金）');
    expect(report.markdown).toContain('不构成任何投资建议');
  });

  it('topWhaleShare 缺省 → 资金镜像行省略（向后兼容）', async () => {
    const llm = new MockLlm();
    llm.enqueue('模板叙事。');
    const ports = { llm, proc: { spawn: (): never => { throw new Error('不触达'); } }, ui: new MockUi(), clock: new MockClock() };
    await generateReport(ports, {
      dayLabel: 'd', camps: [], dispersionText: 'x', participationNote: null,
      multiBullPct: 0, degradedFlags: [],
    });
    expect(llm.calls[0]!.req.messages[0]!.content).not.toContain('资金镜像');
  });
});

describe('buildLegionMirror 集中度传闻（P5，#14 无身份无具体操作）', () => {
  it('领先阵营内最大单一权重占比 > cfg 阈值 → 传闻方向跟随阵营', () => {
    // 多军 = 1 个 tier-4 游资（24）+ 2 个 tier-1 散户（1+1）→ 最大单一占比 24/26 ≈ 92% > 40%
    const personas = new Map([
      ['w', persona('w', 'hotmoney', 4)],
      ['u1', persona('u1', 'trend', 1)],
      ['u2', persona('u2', 'trend', 1)],
    ]);
    const states = new Map([state('w', 0), state('u1', 0), state('u2', 0)]);
    const outputs: AgentOutput[] = [
      { personaId: 'w', targetPct: 100, confidence: 5, reason: '梭哈' },
      { personaId: 'u1', targetPct: 100, confidence: 5, reason: '跟' },
      { personaId: 'u2', targetPct: 100, confidence: 5, reason: '跟' },
    ];
    const mirror = buildLegionMirror(outputs, states, personas, cfg);
    expect(mirror.whaleRumor).toBe('做多');
    expect(mirror.weightedBullPct).toBe(1); // 全员目标 ≥70
    // 空军镜像：同样构造方向反转
    const bearStates = new Map([state('w', 100), state('u1', 100), state('u2', 100)]);
    const bearOutputs: AgentOutput[] = [
      { personaId: 'w', targetPct: 0, confidence: 5, reason: '清' },
      { personaId: 'u1', targetPct: 0, confidence: 5, reason: '清' },
      { personaId: 'u2', targetPct: 0, confidence: 5, reason: '清' },
    ];
    expect(buildLegionMirror(bearOutputs, bearStates, personas, cfg).whaleRumor).toBe('做空');
  });

  it('权重分散（5 游资 108 内最大单一 24/108≈22%）→ 不超默认 40% 阈值不出传闻；阈值进 cfg 生效', () => {
    const hotTiers: (3 | 4)[] = [4, 4, 4, 3, 4];
    const personas = new Map<string, Persona>();
    const states = new Map<string, AgentState>();
    const outputs: AgentOutput[] = [];
    hotTiers.forEach((tier, i) => {
      const id = `h${i + 1}`;
      personas.set(id, persona(id, 'hotmoney', tier));
      states.set(id, state(id, 0)[1]);
      outputs.push({ personaId: id, targetPct: 100, confidence: 5, reason: 'x' });
    });
    expect(buildLegionMirror(outputs, states, personas, cfg).whaleRumor).toBeNull(); // 24/108 < 40%
    const lowBar: EngineConfig = { ...cfg, whaleRumorThresholdPct: 20 };
    expect(buildLegionMirror(outputs, states, personas, lowBar).whaleRumor).toBe('做多'); // 22% > 20%
  });

  it('领先阵营为观望 → 无传闻；资金加权份额按仓位水平口径', () => {
    const personas = new Map([
      ['a', persona('a', 'trend', 4)], // 权重 8
      ['b', persona('b', 'trend', 1)], // 权重 1
    ]);
    const states = new Map([state('a', 50), state('b', 50)]);
    const outputs: AgentOutput[] = [
      { personaId: 'a', targetPct: 52, confidence: 3, reason: '观望' }, // delta=2 → neutral（权重领先 8>1）
      { personaId: 'b', targetPct: 20, confidence: 3, reason: '减一点' }, // delta=-30 → bear，且 20≤30 观点=看空
    ];
    const mirror = buildLegionMirror(outputs, states, personas, cfg);
    expect(mirror.whaleRumor).toBeNull(); // 领先阵营=neutral → 不出方向传闻
    expect(mirror.weightedBullPct).toBe(0);
    expect(mirror.weightedBearPct).toBeCloseTo(1 / 9, 10); // 只有 b 落 ≤30（分母=参战者权重和 9）
  });
});

describe('campDispersion 当日阵营分歧（P5，sandbox 分歧话术实测化）', () => {
  it('构造一致样例 → 「步伐比较齐」；分裂样例 → 「吵得特别凶」；均不再恒出「有些分歧」', () => {
    const personas = new Map<string, Persona>();
    const states = new Map<string, AgentState>();
    const mk = (id: string, target: number, exposure: number): AgentOutput => {
      personas.set(id, persona(id, 'trend', 1));
      states.set(id, state(id, exposure)[1]);
      return { personaId: id, targetPct: target, confidence: 5, reason: `${id} 的理由，写得稍微长一点点` };
    };
    // 一致：全员加仓（同落多军）
    const consistent = Array.from({ length: 6 }, (_, i) => mk(`c${i}`, 100, 0));
    const consistentCamps = buildCamps(consistent, states, personas, cfg);
    const d1 = campDispersion(consistentCamps);
    expect(d1).toBe(0); // 最大阵营份额 = 1
    expect(dispersionNote(d1, false)).toBe('军团步伐比较齐。');
    // 分裂：一半加仓、一半减仓
    const split = [
      ...Array.from({ length: 3 }, (_, i) => mk(`s${i}`, 100, 0)),
      ...Array.from({ length: 3 }, (_, i) => mk(`t${i}`, 0, 100)),
    ];
    const splitCamps = buildCamps(split, states, personas, cfg);
    const d2 = campDispersion(splitCamps);
    expect(d2).toBeCloseTo(0.5, 10); // 1 − 3/6
    expect(dispersionNote(d2, false)).toBe('今天军团吵得特别凶，多空谁也说服不了谁。');
    // 两样例文案不同，且都不是旧硬编码 (0.2, false) 的「有些分歧」
    expect(dispersionNote(d1, false)).not.toBe(dispersionNote(d2, false));
    expect(dispersionNote(d1, false)).not.toContain('有些分歧');
    expect(dispersionNote(d2, false)).not.toContain('有些分歧');
  });

  it('无参战者 → dispersion 0（不产生 NaN）', () => {
    expect(campDispersion(buildCamps([], new Map(), new Map(), cfg))).toBe(0);
  });
});
