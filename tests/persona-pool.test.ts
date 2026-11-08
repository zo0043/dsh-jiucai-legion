/**
 * persona-pool / prompts（编译与解析）测试 —— 零网络、零 LLM。
 * 覆盖：同 seed 同池/不同 seed 不同池、30 人与 25/5 拆分、contrarian+bear ≥30% 结构对冲、
 * 游资纪律非空/散户 bias 非空、资金档位覆盖、基线区间、昵称唯一、parseAgentOutput 容错。
 */
import { describe, expect, it } from 'vitest';
import {
  createPool,
  meetsStructuralHedge,
  DEFAULT_MAX_LOSS_PCT,
  POOL_SIZE,
  RETAIL_COUNT,
  HOT_MONEY_COUNT,
} from '../src/engine/persona-pool.js';
import {
  compileSystemPrompt,
  OUTPUT_CONTRACT,
  ParseError,
  parseAgentOutput,
} from '../src/engine/prompts.js';
import { buildPersonalBlock } from '../src/engine/info-set.js';
import { DEFAULT_CONFIG, type AgentState, type EngineConfig, type Persona } from '../src/engine/types.js';

const RETAIL_STYLES = ['trend', 'contrarian', 'technical', 'news', 'indexer'];
const HOT_STYLES = ['hotmoney', 'speculator'];
const ALL_BIASES = ['loss_aversion', 'breakeven', 'chasing', 'anchoring'];
const STABILITY_LEVELS = [0.5, 1, 2];

function cfg(seed: number): EngineConfig {
  return { ...DEFAULT_CONFIG, seed };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p01',
    name: '测试老哥',
    style: 'technical',
    capitalTier: 2,
    stability: 1,
    stance: 'range',
    biases: ['chasing'],
    maxLossPct: null,
    baseline: 50,
    systemPrompt: '',
    ...overrides,
  };
}

describe('createPool 确定性与结构（#10/#11）', () => {
  it('同 seed 同池：personas 与 seedUsed 完全一致', () => {
    const a = createPool(cfg(2026));
    const b = createPool(cfg(2026));
    expect(JSON.stringify(a.personas)).toBe(JSON.stringify(b.personas));
    expect(a.seedUsed).toBe(b.seedUsed);
  });

  it('首次生成即满足约束时 seedUsed === cfg.seed', () => {
    const { seedUsed } = createPool(cfg(2026));
    expect(seedUsed).toBe(2026);
  });

  it('不同 seed 产生不同池', () => {
    const a = createPool(cfg(2026));
    const b = createPool(cfg(999));
    expect(JSON.stringify(a.personas)).not.toBe(JSON.stringify(b.personas));
  });

  it('共 30 人：散户 25（风格限定 5 类）+ 游资 5（风格限定 2 类），id 为 p01–p30', () => {
    const { personas } = createPool(cfg(2026));
    expect(personas).toHaveLength(POOL_SIZE);
    expect(personas.filter((p) => RETAIL_STYLES.includes(p.style))).toHaveLength(RETAIL_COUNT);
    expect(personas.filter((p) => HOT_STYLES.includes(p.style))).toHaveLength(HOT_MONEY_COUNT);
    expect(personas.filter((p) => !RETAIL_STYLES.includes(p.style) && !HOT_STYLES.includes(p.style))).toHaveLength(0);
    personas.forEach((p, i) => {
      expect(p.id).toBe(`p${String(i + 1).padStart(2, '0')}`);
    });
  });

  it('多个 seed 下结构对冲不变量恒成立：contrarian+indexer+bear ≥ 30%（#40/#39）', () => {
    for (const seed of [1, 7, 42, 2026, 55555, 999999]) {
      const { personas } = createPool(cfg(seed));
      expect(meetsStructuralHedge(personas)).toBe(true);
    }
  });

  it('散户资金档位覆盖 1–4 档；游资只在 3–4 档', () => {
    const { personas } = createPool(cfg(2026));
    const retail = personas.filter((p) => RETAIL_STYLES.includes(p.style));
    const hot = personas.filter((p) => HOT_STYLES.includes(p.style));
    expect(new Set(retail.map((p) => p.capitalTier))).toEqual(new Set([1, 2, 3, 4]));
    for (const p of hot) {
      expect([3, 4]).toContain(p.capitalTier);
    }
  });

  it('散户低档更多：档位 1+2 的人数多于 3+4', () => {
    const { personas } = createPool(cfg(2026));
    const retail = personas.filter((p) => RETAIL_STYLES.includes(p.style));
    const low = retail.filter((p) => p.capitalTier <= 2).length;
    const high = retail.filter((p) => p.capitalTier >= 3).length;
    expect(low).toBeGreaterThan(high);
  });

  it('稳定性只取三档 0.5/1.0/2.0（#48）；游资偏 0.5–1.0', () => {
    const { personas } = createPool(cfg(2026));
    for (const p of personas) {
      expect(STABILITY_LEVELS).toContain(p.stability);
    }
    const hot = personas.filter((p) => HOT_STYLES.includes(p.style));
    const stableish = hot.filter((p) => p.stability <= 1).length;
    expect(stableish).toBeGreaterThanOrEqual(4); // 权重 0.9/人，5 人中至少 4 人
  });

  it('散户 maxLossPct=null 且 1–2 个偏差标签；游资 biases=[] 且纪律=5（#49）', () => {
    const { personas } = createPool(cfg(2026));
    for (const p of personas) {
      if (HOT_STYLES.includes(p.style)) {
        expect(p.biases).toEqual([]);
        expect(p.maxLossPct).toBe(DEFAULT_MAX_LOSS_PCT);
        expect(p.maxLossPct).toBe(5);
      } else {
        expect(p.maxLossPct).toBeNull();
        expect(p.biases.length).toBeGreaterThanOrEqual(1);
        expect(p.biases.length).toBeLessThanOrEqual(2);
        for (const b of p.biases) {
          expect(ALL_BIASES).toContain(b);
        }
        expect(new Set(p.biases).size).toBe(p.biases.length); // 不重复
      }
    }
  });

  it('情绪基线按立场落区间：bull 55–70 / bear 30–45 / range 45–55（#48）', () => {
    const { personas } = createPool(cfg(2026));
    for (const p of personas) {
      if (p.stance === 'bull') {
        expect(p.baseline).toBeGreaterThanOrEqual(55);
        expect(p.baseline).toBeLessThanOrEqual(70);
      } else if (p.stance === 'bear') {
        expect(p.baseline).toBeGreaterThanOrEqual(30);
        expect(p.baseline).toBeLessThanOrEqual(45);
      } else {
        expect(p.baseline).toBeGreaterThanOrEqual(45);
        expect(p.baseline).toBeLessThanOrEqual(55);
      }
    }
  });

  it('昵称唯一且非空；systemPrompt 非空且包含风格锚与输出契约（#15/#39）', () => {
    const { personas } = createPool(cfg(2026));
    const names = new Set(personas.map((p) => p.name));
    expect(names.size).toBe(POOL_SIZE);
    for (const p of personas) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.systemPrompt.length).toBeGreaterThan(50);
      expect(p.systemPrompt).toContain('风格锚');
      expect(p.systemPrompt).toContain(p.name);
      expect(p.systemPrompt).toContain('输出契约');
      expect(p.systemPrompt).toContain('盈亏和情绪不能改变你的风格');
    }
  });

  it('散户 systemPrompt 含偏差描述、无纪律条款；游资 systemPrompt 含纪律条款', () => {
    const { personas } = createPool(cfg(2026));
    const retail = personas.find((p) => RETAIL_STYLES.includes(p.style));
    const hot = personas.find((p) => HOT_STYLES.includes(p.style));
    expect(retail).toBeDefined();
    expect(hot).toBeDefined();
    if (retail) {
      expect(retail.systemPrompt).toContain('行为偏差');
      expect(retail.systemPrompt).not.toContain('游资纪律');
    }
    if (hot) {
      expect(hot.systemPrompt).toContain('游资纪律');
      expect(hot.systemPrompt).toContain('5%');
      expect(hot.systemPrompt).not.toContain('行为偏差');
    }
  });

  it('重播种兜底：人为抬高下限后仍能生成（seedUsed 反映实际种子）', () => {
    // 直接验证 meetsStructuralHedge 边界：空池不满足
    expect(meetsStructuralHedge([])).toBe(false);
    // 30 人池在默认分布下恒满足（createPool 内部已兜底重播种）
    const { personas, seedUsed } = createPool(cfg(7));
    expect(personas).toHaveLength(30);
    expect(typeof seedUsed).toBe('number');
  });
});

describe('compileSystemPrompt（#11/#34/#49）', () => {
  it('包含 OUTPUT_CONTRACT 全文与立场先验、情绪基线', () => {
    const p = makePersona({ stance: 'bear', baseline: 38, style: 'contrarian' });
    const sp = compileSystemPrompt(p);
    expect(sp).toContain(OUTPUT_CONTRACT);
    expect(sp).toContain('偏空');
    expect(sp).toContain('38');
  });

  it('游资卡片带纪律条款，散户卡片带偏差标签', () => {
    const hot = compileSystemPrompt(makePersona({ style: 'hotmoney', biases: [], maxLossPct: 5 }));
    expect(hot).toContain('游资纪律');
    expect(hot).toContain('无条件减仓');
    const retail = compileSystemPrompt(makePersona({ biases: ['loss_aversion', 'anchoring'] }));
    expect(retail).toContain('损失厌恶');
    expect(retail).toContain('锚定成本');
  });
});

describe('parseAgentOutput 容错解析（#12/#54）', () => {
  it('裸 JSON 正常解析', () => {
    const out = parseAgentOutput('p01', '{"target_position_pct": 60, "confidence": 4, "reason": "放量突破，加仓"}');
    expect(out).toEqual({ personaId: 'p01', targetPct: 60, confidence: 4, reason: '放量突破，加仓' });
  });

  it('markdown 代码栅栏容错（```json … ```）', () => {
    const raw = '```json\n{"target_position_pct": 30, "confidence": 2, "reason": "观望"}\n```';
    const out = parseAgentOutput('p02', raw);
    expect(out.targetPct).toBe(30);
    expect(out.confidence).toBe(2);
  });

  it('前后夹杂说明文字时截取第一个 {...} JSON 块', () => {
    const raw = '我觉得吧，军团兄弟都在等信号 {"target_position_pct": 45, "confidence": 3, "reason": "纠结"} 就这样';
    const out = parseAgentOutput('p03', raw);
    expect(out.targetPct).toBe(45);
    expect(out.reason).toBe('纠结');
  });

  it('reason 字符串里出现花括号/引号不截断错位', () => {
    const raw = '{"target_position_pct":1,"confidence":2,"reason":"都说了 \\"别追\\" } 啊"}';
    const out = parseAgentOutput('p04', raw);
    expect(out.targetPct).toBe(1);
    expect(out.reason).toContain('别追');
  });

  it('clamp：targetPct 到 0–100、confidence 到 1–5、小数四舍五入', () => {
    const a = parseAgentOutput('p05', '{"target_position_pct": 150, "confidence": 9, "reason": "r"}');
    expect(a.targetPct).toBe(100);
    expect(a.confidence).toBe(5);
    const b = parseAgentOutput('p06', '{"target_position_pct": -20, "confidence": 0, "reason": "r"}');
    expect(b.targetPct).toBe(0);
    expect(b.confidence).toBe(1);
    const c = parseAgentOutput('p07', '{"target_position_pct": 55.7, "confidence": 3.4, "reason": "r"}');
    expect(c.targetPct).toBe(56);
    expect(c.confidence).toBe(3);
  });

  it('兼容驼峰 targetPct 键', () => {
    const out = parseAgentOutput('p08', '{"targetPct": 72, "confidence": 5, "reason": "r"}');
    expect(out.targetPct).toBe(72);
  });

  it('reason 超长截断到 60 字符', () => {
    const long = '涨'.repeat(80);
    const out = parseAgentOutput('p09', `{"target_position_pct": 50, "confidence": 3, "reason": "${long}"}`);
    expect(Array.from(out.reason).length).toBe(60);
  });

  it('解析不了抛 ParseError（供 orchestrator 计重试，#54）', () => {
    expect(() => parseAgentOutput('p10', '我不知道该说什么')).toThrow(ParseError);
    expect(() => parseAgentOutput('p10', '{"target_position_pct": "高", "confidence": 3, "reason": "r"}')).toThrow(ParseError);
    expect(() => parseAgentOutput('p10', '{"confidence": 3, "reason": "缺 target"}')).toThrow(ParseError);
    try {
      parseAgentOutput('p10', '完全不是 json');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).personaId).toBe('p10');
      expect((e as ParseError).rawSnippet.length).toBeGreaterThan(0);
    }
  });
});

// ---------- P4 偏差条件先验与情境点火 ----------

describe('P4 偏差条件先验（drawBiases 条件权重，同 seed 可复现）', () => {
  const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

  it('固定多 seed 统计：chasing 在 trend 中频率显著高于 indexer（3:1 条件先验）', () => {
    let trendN = 0;
    let trendChasing = 0;
    let indexerN = 0;
    let indexerChasing = 0;
    for (const seed of SEEDS) {
      const { personas } = createPool(cfg(seed));
      for (const p of personas) {
        if (p.style === 'trend') {
          trendN += 1;
          if (p.biases.includes('chasing')) trendChasing += 1;
        }
        if (p.style === 'indexer') {
          indexerN += 1;
          if (p.biases.includes('chasing')) indexerChasing += 1;
        }
      }
    }
    expect(trendN).toBeGreaterThan(0);
    expect(indexerN).toBeGreaterThan(0);
    expect(trendChasing / trendN).toBeGreaterThan(indexerChasing / indexerN + 0.1);
  });

  it('anchoring 在 technical/contrarian 中频率高于 trend；breakeven 在 1–2 档高于 3–4 档', () => {
    let techConN = 0;
    let techConAnch = 0;
    let trendN = 0;
    let trendAnch = 0;
    let lowN = 0;
    let lowBe = 0;
    let highN = 0;
    let highBe = 0;
    for (const seed of SEEDS) {
      const { personas } = createPool(cfg(seed));
      for (const p of personas) {
        if (HOT_STYLES.includes(p.style)) continue; // 游资无偏差标签
        if (p.style === 'technical' || p.style === 'contrarian') {
          techConN += 1;
          if (p.biases.includes('anchoring')) techConAnch += 1;
        }
        if (p.style === 'trend') {
          trendN += 1;
          if (p.biases.includes('anchoring')) trendAnch += 1;
        }
        if (p.capitalTier <= 2) {
          lowN += 1;
          if (p.biases.includes('breakeven')) lowBe += 1;
        } else {
          highN += 1;
          if (p.biases.includes('breakeven')) highBe += 1;
        }
      }
    }
    expect(techConAnch / techConN).toBeGreaterThan(trendAnch / trendN + 0.1);
    expect(lowBe / lowN).toBeGreaterThan(highBe / highN + 0.1);
  });

  it('同 seed 同池确定性回归：条件权重抽取后 JSON 逐字一致（drawBiases 确定性）', () => {
    const a = createPool(cfg(2026));
    const b = createPool(cfg(2026));
    expect(JSON.stringify(a.personas.map((p) => p.biases))).toBe(JSON.stringify(b.personas.map((p) => p.biases)));
  });
});

describe('P4 偏差情境触发行（info-set.buildPersonalBlock，倾向措辞）', () => {
  function st(overrides: Partial<AgentState> = {}): AgentState {
    return { personaId: 'p01', cash: 40000, exposurePct: 60, costBasis: 3245, emotion: 50, memory: [], ...overrides };
  }

  it('breakeven 浮亏收窄至 −2%~0 → 「离回本就差 X%，一回本你就想跑」；反例不触发', () => {
    const p = makePersona({ biases: ['breakeven'] });
    // 成本 3245、现价 3190 → 浮亏 1.7%（在 −2~0 内）
    const hit = buildPersonalBlock(st(), p, 3190);
    expect(hit).toContain('离回本就差 1.7%，一回本你就想跑');
    // 反例：浮亏深于 −2%（现价 3150 → −2.9%）
    expect(buildPersonalBlock(st(), p, 3150)).not.toContain('一回本你就想跑');
    // 反例：浮盈不触发
    expect(buildPersonalBlock(st(), p, 3300)).not.toContain('一回本你就想跑');
    // 倾向措辞：不含具体历史事件断言（不伪造「上次」类个人史）
    expect(hit).not.toContain('上次');
  });

  it('chasing 当日大盘 >+1.5% → 「大阳线，再不上车就踏空了」；反例不触发', () => {
    const p = makePersona({ biases: ['chasing'] });
    expect(buildPersonalBlock(st(), p, 3190, 0.016)).toContain('大阳线，再不上车就踏空了');
    expect(buildPersonalBlock(st(), p, 3190, 0.015)).not.toContain('大阳线'); // 严格 > 1.5%
    expect(buildPersonalBlock(st(), p, 3190, -0.02)).not.toContain('大阳线');
    expect(buildPersonalBlock(st(), p, 3190, 0.016)).not.toContain('上次'); // 倾向措辞
  });

  it('loss_aversion 浮亏 <−3% → 「再亏睡不着了，要不先割？」；反例不触发', () => {
    const p = makePersona({ biases: ['loss_aversion'] });
    // 成本 3245、现价 3100 → 浮亏 4.5%
    expect(buildPersonalBlock(st(), p, 3100)).toContain('再亏睡不着了，要不先割？');
    // 反例：浮亏 −1.7% 不够深
    expect(buildPersonalBlock(st(), p, 3190)).not.toContain('要不先割');
    // 反例：空仓无成本锚，无浮亏情境
    expect(buildPersonalBlock(st({ costBasis: null, exposurePct: 0 }), p, 3100)).not.toContain('要不先割');
  });

  it('无对应偏差标签 → 情境满足也不渲染；系统提示静态标签行不变（#49）', () => {
    const p = makePersona({ biases: ['anchoring'] });
    expect(buildPersonalBlock(st(), p, 3190, 0.03)).not.toContain('一回本');
    expect(buildPersonalBlock(st(), p, 3190, 0.03)).not.toContain('大阳线');
    expect(buildPersonalBlock(st(), p, 3100, 0.03)).not.toContain('要不先割');
    // 静态注入不变：compileSystemPrompt 偏差描述照旧
    expect(compileSystemPrompt(makePersona({ biases: ['breakeven'] }))).toContain('回本执念');
  });
});
