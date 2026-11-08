/**
 * emotion 情绪引擎测试 —— 零网络、零 LLM。
 * 覆盖：事件卡线性衰减到 0（#42）、updateEmotion 情绪惯性公式（#48 + P3：λ 残留 +
 * 负面不对称）、legacy 锚（λ=0 且 negativeAsym=1 逐点等价旧 §5.2 公式，可回退）、
 * 持续冲击稳态（baseline+asym·shock，无棘轮）、clamp 0–100、盈亏 ±5 饱和、
 * 大盘波动 1%/5% 阈值、stability 缩放、纯函数不变性、设置页两滑杆经 applySettings 生效。
 */
import { describe, expect, it } from 'vitest';
import { clamp, eventContribution, updateEmotion } from '../src/engine/emotion.js';
import { applySettings } from '../src/config.js';
import { DEFAULT_CONFIG, type EngineConfig, type EventCard, type Persona } from '../src/engine/types.js';

const cfg: EngineConfig = DEFAULT_CONFIG; // eventWeight 4 / pnlWeight 6 / marketWeight 400

function makeCard(overrides: Partial<EventCard> = {}): EventCard {
  return {
    id: 'ev-1',
    sectors: ['半导体'],
    direction: 1,
    strength: 3,
    text: '降准利好',
    injectedDay: '2026-11-05',
    decayDays: 2,
    ...overrides,
  };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p01',
    name: '测试老哥',
    style: 'trend',
    capitalTier: 2,
    stability: 1,
    stance: 'bull',
    biases: ['chasing'],
    maxLossPct: null,
    baseline: 50,
    systemPrompt: '',
    ...overrides,
  };
}

const zeroInput = { eventContrib: 0, unrealizedPnlPct: 0, marketRet: 0 };

describe('eventContribution 事件卡贡献（#42/#48）', () => {
  it('注入当日贡献最大：strength × direction × eventWeight', () => {
    // 3 × 1 × 4 × 衰减 1 = 12
    expect(eventContribution(makeCard(), 0, cfg)).toBe(12);
  });

  it('线性衰减：1 天后减半，衰减期满归零（decayDays=2）', () => {
    expect(eventContribution(makeCard(), 1, cfg)).toBeCloseTo(6, 10);
    expect(eventContribution(makeCard(), 2, cfg)).toBe(0);
    expect(eventContribution(makeCard(), 5, cfg)).toBe(0);
  });

  it('更长衰减期按比例衰减（decayDays=5）', () => {
    const card = makeCard({ decayDays: 5 });
    expect(eventContribution(card, 2.5, cfg)).toBeCloseTo(6, 10);
    expect(eventContribution(card, 5, cfg)).toBe(0);
  });

  it('direction=-1 贡献为负', () => {
    expect(eventContribution(makeCard({ direction: -1 }), 0, cfg)).toBe(-12);
  });

  it('事件权重跟随 cfg.emotion.eventWeight（#48 可调）', () => {
    const custom: EngineConfig = { ...cfg, emotion: { ...cfg.emotion, eventWeight: 10 } };
    expect(eventContribution(makeCard(), 0, custom)).toBe(30);
  });

  it('offset 从 0 到 decayDays 单调降到 0', () => {
    const card = makeCard({ decayDays: 2 });
    let prev = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 2; d += 0.25) {
      const v = eventContribution(card, d, cfg);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
    expect(eventContribution(card, 2, cfg)).toBe(0);
  });

  it('防御：decayDays 非正返回 0，负 dayOffset 不放大', () => {
    expect(eventContribution(makeCard({ decayDays: 0 }), 0, cfg)).toBe(0);
    expect(eventContribution(makeCard(), -1, cfg)).toBe(12); // 视为注入当日
  });
});

describe('updateEmotion 情绪惯性公式（#48 + P3：λ 残留 + 负面不对称）', () => {
  // 默认常量：λ=0.6、negativeAsym=1.3；公式 e = clamp(baseline + λ(prev−baseline) + (1−λ)·asym·shock)
  it('三源输入全零 → 按 λ 向基线收敛（情绪惯性时间尾，替换旧「一步回基线」）', () => {
    expect(updateEmotion(99, makePersona({ baseline: 50 }), zeroInput, cfg)).toBeCloseTo(79.4, 10); // 50+0.6×49
    expect(updateEmotion(3, makePersona({ baseline: 62 }), zeroInput, cfg)).toBeCloseTo(26.6, 10); // 62+0.6×(−59)
    // 多日迭代收敛到基线（终点与旧公式一致，速度按 λ 衰减）
    let e = 99;
    for (let i = 0; i < 200; i += 1) e = updateEmotion(e, makePersona({ baseline: 50 }), zeroInput, cfg);
    expect(e).toBeCloseTo(50, 6);
  });

  it('个人盈亏项（正向）：shock=24 → baseline + 0.4×24', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: 4 }, cfg)).toBeCloseTo(59.6, 10);
  });

  it('个人盈亏项（负向，:115-118 按新公式重算）：asym=1.3 放大 → 50 − 0.4×1.3×24', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -4 }, cfg)).toBeCloseTo(37.52, 10);
  });

  it('盈亏在 ±5% 处饱和（clamp）', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    const at5 = updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: 5 }, cfg);
    const beyond = updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: 50 }, cfg);
    expect(at5).toBeCloseTo(62, 10); // 50 + 0.4×30
    expect(beyond).toBe(at5);
    const negAt5 = updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -5 }, cfg);
    const negBeyond = updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -50 }, cfg);
    expect(negAt5).toBeCloseTo(34.4, 10); // 50 − 0.4×1.3×30
    expect(negBeyond).toBe(negAt5);
  });

  it('大盘波动项：|ret| ≤ 1% 不计价，超出部分计价、5% 封顶，负向按 asym 放大', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: 0.005 }, cfg)).toBeCloseTo(50, 10);
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: 0.02 }, cfg)).toBeCloseTo(51.6, 10); // 50+0.4×4
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: -0.02 }, cfg)).toBeCloseTo(47.92, 10); // 50−0.4×1.3×4
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: 0.5 }, cfg)).toBeCloseTo(58, 10); // 50+0.4×20 封顶
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: -0.5 }, cfg)).toBeCloseTo(39.6, 10); // 50−0.4×1.3×20
  });

  it('stability 缩放：0.5 放大一倍、2.0 折半（#48 三维之一）', () => {
    const jumpy = makePersona({ baseline: 50, stability: 0.5 });
    const calm = makePersona({ baseline: 50, stability: 2 });
    const base = makePersona({ baseline: 50, stability: 1 });
    const retInput = { ...zeroInput, marketRet: 0.02 };
    expect(updateEmotion(50, jumpy, retInput, cfg)).toBeCloseTo(53.2, 10); // 0.4×8
    expect(updateEmotion(50, calm, retInput, cfg)).toBeCloseTo(50.8, 10); // 0.4×2（0.01×400×0.5）
    const pnlInput = { ...zeroInput, unrealizedPnlPct: 4 };
    expect(updateEmotion(50, jumpy, pnlInput, cfg)).toBeCloseTo(69.2, 10); // 0.4×48
    expect(updateEmotion(50, calm, pnlInput, cfg)).toBeCloseTo(54.8, 10); // 0.4×12
    expect(updateEmotion(50, base, pnlInput, cfg)).toBeCloseTo(59.6, 10); // 0.4×24
  });

  it('clamp 0–100：极端输入触顶/触底', () => {
    const p = makePersona({ baseline: 50, stability: 0.5 });
    expect(updateEmotion(50, p, { eventContrib: 1000, unrealizedPnlPct: 5, marketRet: 0.5 }, cfg)).toBe(100);
    expect(updateEmotion(50, p, { eventContrib: -1000, unrealizedPnlPct: -5, marketRet: -0.5 }, cfg)).toBe(0);
    // 低基线 + 中等利好也顶不到天上时正常落区间
    const v = updateEmotion(50, makePersona({ baseline: 10 }), { eventContrib: 8, unrealizedPnlPct: 2, marketRet: 0.03 }, cfg);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(100);
  });

  it('事件贡献直接叠加（调用方已按 eventContribution 求和）', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    expect(updateEmotion(50, p, { eventContrib: 12, unrealizedPnlPct: 0, marketRet: 0 }, cfg)).toBeCloseTo(54.8, 10);
  });

  it('纯函数：不修改 persona；prev 经 λ 进入结果（不再是弃用参数）', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    const snapshot = JSON.stringify(p);
    const input = { eventContrib: 30, unrealizedPnlPct: 5, marketRet: 0.05 };
    const fromCalm = updateEmotion(50, p, input, cfg);
    const fromPanic = updateEmotion(7, p, input, cfg);
    expect(fromPanic).toBeLessThan(fromCalm); // 前日恐慌残留拉低今日情绪
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});

describe('updateEmotion legacy 锚（λ=0 且 negativeAsym=1 → 与旧 §5.2 公式逐点一致，可回退）', () => {
  const legacy: EngineConfig = { ...cfg, emotion: { ...cfg.emotion, carryover: 0, negativeAsym: 1 } };

  it('三源输入全零 → 精确回基线', () => {
    expect(updateEmotion(99, makePersona({ baseline: 50 }), zeroInput, legacy)).toBe(50);
    expect(updateEmotion(3, makePersona({ baseline: 62 }), zeroInput, legacy)).toBe(62);
  });

  it('盈亏/大盘/stability/clamp 逐点等于旧公式值', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: 4 }, legacy)).toBeCloseTo(74, 10);
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -4 }, legacy)).toBeCloseTo(26, 10);
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: 5 }, legacy)).toBeCloseTo(80, 10);
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -5 }, legacy)).toBeCloseTo(20, 10);
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: 0.02 }, legacy)).toBeCloseTo(54, 10);
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: -0.02 }, legacy)).toBeCloseTo(46, 10);
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: 0.5 }, legacy)).toBeCloseTo(70, 10);
    expect(updateEmotion(50, p, { ...zeroInput, marketRet: -0.5 }, legacy)).toBeCloseTo(30, 10);
    const jumpy = makePersona({ baseline: 50, stability: 0.5 });
    expect(updateEmotion(50, jumpy, { ...zeroInput, unrealizedPnlPct: 4 }, legacy)).toBeCloseTo(98, 10);
    expect(updateEmotion(50, jumpy, { eventContrib: -1000, unrealizedPnlPct: -5, marketRet: -0.5 }, legacy)).toBe(0);
    expect(updateEmotion(50, makePersona({ baseline: 50, stability: 1 }), { eventContrib: 12, unrealizedPnlPct: 0, marketRet: 0 }, legacy)).toBe(62);
  });
});

describe('updateEmotion 持续冲击稳态与负面不对称（P3，/tmp/verify-rev.mts 同款场景）', () => {
  it('持续浮亏 −4%（baseline 53 / stability 0.5）：1 日 28.04 → 稳态 clamp(baseline+asym·shock)=0，不因棘轮加速恶化', () => {
    const p = makePersona({ baseline: 53, stability: 0.5 });
    const input = { eventContrib: 0, unrealizedPnlPct: -4, marketRet: 0 };
    expect(updateEmotion(53, p, input, cfg)).toBeCloseTo(28.04, 10); // 53 − 0.4×1.3×48
    let e = 53;
    for (let i = 0; i < 30; i += 1) e = updateEmotion(e, p, input, cfg);
    expect(e).toBe(0); // 稳态解析值 53 + 1.3×(−48) = −9.4 → clamp 0（现行公式单日为 5）
  });

  it('中等冲击不触底：稳态精确 = baseline + asym·shock（无 1/(1−λ) 棘轮放大）', () => {
    const p = makePersona({ baseline: 53, stability: 1 });
    const input = { eventContrib: 0, unrealizedPnlPct: -4, marketRet: 0 };
    let e = 53;
    for (let i = 0; i < 60; i += 1) e = updateEmotion(e, p, input, cfg);
    expect(e).toBeCloseTo(53 + 1.3 * (-4 * 6), 6); // 21.8；棘轮式会是 53 − 31.2/0.4 < 0
  });

  it('负面残留 > 正向残留（bad is stronger）；negativeAsym=1 回到对称', () => {
    const p = makePersona({ baseline: 50, stability: 1 });
    const up = updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: 4 }, cfg); // 59.6
    const down = updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -4 }, cfg); // 37.52
    expect(50 - down).toBeGreaterThan(up - 50);
    const sym: EngineConfig = { ...cfg, emotion: { ...cfg.emotion, negativeAsym: 1 } };
    expect(updateEmotion(50, p, { ...zeroInput, unrealizedPnlPct: -4 }, sym)).toBeCloseTo(50 - (up - 50), 10);
  });
});

describe('config.applySettings 情绪惯性滑杆（P3）', () => {
  it('emotionCarryover / emotionNegativeAsym 两键生效（平键与嵌套 emotion 对象）', () => {
    const flat = applySettings({ ...DEFAULT_CONFIG }, { emotionCarryover: 0.2, emotionNegativeAsym: 2 });
    expect(flat.emotion.carryover).toBe(0.2);
    expect(flat.emotion.negativeAsym).toBe(2);
    const nested = applySettings({ ...DEFAULT_CONFIG }, { emotion: { carryover: 0.1, negativeAsym: 1 } });
    expect(nested.emotion.carryover).toBe(0.1);
    expect(nested.emotion.negativeAsym).toBe(1);
    // 滑杆值经 updateEmotion 生效
    expect(updateEmotion(99, makePersona({ baseline: 50 }), zeroInput, flat)).toBeCloseTo(59.8, 10); // 50+0.2×49
  });
});

describe('clamp 工具', () => {
  it('区间截断', () => {
    expect(clamp(5, 0, 100)).toBe(5);
    expect(clamp(-1, 0, 100)).toBe(0);
    expect(clamp(101, 0, 100)).toBe(100);
  });
});
