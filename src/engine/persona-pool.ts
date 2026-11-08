/**
 * 韭菜军团 — 三维人设池生成（需求 #10/#11/#39/#48/#49）。
 *
 * - 确定性：同 seed 同池（自实现 mulberry32，零依赖）；重播种仅用于结构对冲兜底。
 * - 规模：总 30 = 散户 25（trend/contrarian/technical/news/indexer 按分布）
 *   + 游资 5（只允许 hotmoney/speculator）。
 * - 三维矩阵（#11/#48）：资金档位 1–4（散户低档多、游资强制 3–4）
 *   × 风格 × 情绪稳定性三档 0.5/1.0/2.0（风格条件分布，游资偏 0.5–1.0）。
 * - 结构对冲（#40 拒绝价格侧阻尼后的人设多样性底线）：contrarian+indexer 人数
 *   + stance==='bear' 人数 ≥ 总人数 30%；不满足则重播种重生成（上限 100 次，仍失败抛错）。
 * - 偏差与纪律（#49）：散户每人 1–2 个偏差标签、maxLossPct=null；
 *   游资 biases=[]、maxLossPct=DEFAULT_MAX_LOSS_PCT；
 *   偏差抽取按风格/档位条件权重（P4：trend→chasing、technical/contrarian→anchoring、
 *   1–2 档→breakeven），mulberry32 确定性不变。
 * - 生成后调用 prompts.compileSystemPrompt 编译 systemPrompt（#15，终身不重写）。
 */
import type { Bias, CapitalTier, EngineConfig, Persona, Stance, Style } from './types.js';
import { compileSystemPrompt } from './prompts.js';

// ---------- 规模常量 ----------

export const POOL_SIZE = 30;
export const RETAIL_COUNT = 25;
export const HOT_MONEY_COUNT = 5;
/** 结构对冲下限：总人数 × 30%（#40/#39），30 人 → 9 */
export const STRUCTURAL_HEDGE_MIN = Math.ceil(POOL_SIZE * 0.3);
/** 重播种循环上限 */
const MAX_SEED_ATTEMPTS = 100;

/**
 * 游资默认纪律：亏损超 5% 无条件减仓（#49）。
 * 注：EngineConfig 目前没有对应字段（可在设置页调），暂以模块常量承载默认值；
 * 如需配置化，见测试报告中对 types.ts 的扩展建议（hotMoneyMaxLossPct）。
 */
export const DEFAULT_MAX_LOSS_PCT = 5;

// ---------- 可播种随机数（自实现，零依赖） ----------

/**
 * mulberry32 可播种 PRNG（返回 () => [0,1) 的数）。
 * 同 seed 同序列，保证 createPool 确定性（#10）。
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 加权抽取：table 为 [值, 权重] 元组表 */
type Weighted<T> = readonly [T, number];

function weightedPick<T>(rng: () => number, table: readonly Weighted<T>[]): T {
  let total = 0;
  for (const [, w] of table) total += w;
  let roll = rng() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll < 0) return value;
  }
  const last = table[table.length - 1];
  if (last === undefined) throw new Error('weightedPick：权重表为空');
  return last[0];
}

/** 均匀取一个元素 */
function pick<T>(rng: () => number, arr: readonly T[]): T {
  const v = arr[Math.floor(rng() * arr.length)];
  if (v === undefined) throw new Error('pick：候选为空');
  return v;
}

/** Fisher-Yates 洗牌（确定性，返回新数组）——info-set 呈现顺序随机化（#39）复用 */
export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) throw new Error('seededShuffle：索引越界');
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

/** 简单确定性哈希（FNV-1a）：给每个 Agent 的呈现顺序/派生随机流独立种子（#39；P1 气候噪声流） */
export function hashSeed(...xs: (string | number)[]): number {
  let h = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0;
}

// ---------- 分布表（#11 三维矩阵；#48 稳定性；#39 立场先验） ----------

/** 散户风格分布（低配额给逆向/定投，保证结构对冲基数） */
const RETAIL_STYLE_WEIGHTS: readonly Weighted<Style>[] = [
  ['trend', 0.28],
  ['contrarian', 0.2],
  ['technical', 0.24],
  ['news', 0.16],
  ['indexer', 0.12],
];

/** 游资风格分布：只允许 hotmoney/speculator（#10） */
const HOT_MONEY_STYLE_WEIGHTS: readonly Weighted<Style>[] = [
  ['hotmoney', 0.55],
  ['speculator', 0.45],
];

/** 立场先验按风格条件分布（#39：趋势偏多、逆向偏空、定投偏震荡） */
const STANCE_PRIORS: Record<Style, readonly Weighted<Stance>[]> = {
  trend: [['bull', 0.65], ['bear', 0.1], ['range', 0.25]],
  contrarian: [['bull', 0.1], ['bear', 0.6], ['range', 0.3]],
  technical: [['bull', 0.35], ['bear', 0.3], ['range', 0.35]],
  news: [['bull', 0.4], ['bear', 0.3], ['range', 0.3]],
  hotmoney: [['bull', 0.5], ['bear', 0.15], ['range', 0.35]],
  indexer: [['bull', 0.25], ['bear', 0.15], ['range', 0.6]],
  speculator: [['bull', 0.55], ['bear', 0.15], ['range', 0.3]],
};

/** 情绪稳定性三档（#48）：风格条件分布，游资偏 0.5–1.0（情绪放大器） */
const STABILITY_PRIORS: Record<Style, readonly Weighted<number>[]> = {
  trend: [[0.5, 0.3], [1, 0.45], [2, 0.25]],
  contrarian: [[0.5, 0.4], [1, 0.4], [2, 0.2]],
  technical: [[0.5, 0.2], [1, 0.45], [2, 0.35]],
  news: [[0.5, 0.45], [1, 0.4], [2, 0.15]],
  hotmoney: [[0.5, 0.5], [1, 0.4], [2, 0.1]],
  indexer: [[0.5, 0.15], [1, 0.45], [2, 0.4]],
  speculator: [[0.5, 0.5], [1, 0.4], [2, 0.1]],
};

/** 散户资金档位：低档多（#11）；保留 4 个名额强制覆盖 1–4 档 */
const RETAIL_TIER_WEIGHTS: readonly Weighted<CapitalTier>[] = [
  [1, 0.4],
  [2, 0.3],
  [3, 0.2],
  [4, 0.1],
];

/** 游资资金档位：只能 3–4 档（#10） */
const HOT_MONEY_TIER_WEIGHTS: readonly Weighted<CapitalTier>[] = [
  [3, 0.5],
  [4, 0.5],
];

/** 情绪基线区间（#48）：bull 55–70 / bear 30–45 / range 45–55 */
const BASELINE_RANGE: Record<Stance, readonly [number, number]> = {
  bull: [55, 70],
  bear: [30, 45],
  range: [45, 55],
};

/** 偏差标签池（#49） */
const BIAS_POOL: readonly Bias[] = ['loss_aversion', 'breakeven', 'chasing', 'anchoring'];

/**
 * 偏差条件权重表（P4 情境点火配套）：按风格/资金档位给偏差标签先验——
 * trend → chasing 高权重；technical/contrarian → anchoring 高；1–2 档 → breakeven 高。
 * 其余键保持基准权重 1（未列出的组合回退均匀）。纯查表、零随机。
 */
function biasWeights(style: Style, tier: CapitalTier): readonly Weighted<Bias>[] {
  const w: Record<Bias, number> = { loss_aversion: 1, breakeven: 1, chasing: 1, anchoring: 1 };
  if (style === 'trend') w.chasing += 2; // 趋势党：大阳线怕踏空
  if (style === 'technical' || style === 'contrarian') w.anchoring += 2; // 技术派/逆向党：围着成本与图形打转
  if (tier <= 2) w.breakeven += 2; // 低资金档：回本执念更强
  return [
    ['loss_aversion', w.loss_aversion],
    ['breakeven', w.breakeven],
    ['chasing', w.chasing],
    ['anchoring', w.anchoring],
  ];
}

// ---------- 昵称词表（股吧风，#10） ----------

/** 按风格的昵称前缀词表 */
const NAME_CORE: Record<Style, readonly string[]> = {
  trend: ['趋势', '突破', '右侧', '追涨', '动能'],
  contrarian: ['抄底', '低吸', '左侧', '逆行', '捡烟蒂'],
  technical: ['K线', '均线', '缠论', '画线', 'MACD'],
  news: ['消息', '小道', '吃瓜', '快讯', '盘后'],
  indexer: ['定投', '宽基', '指数', '网格', 'ETF'],
  hotmoney: ['打板', '龙头', '梭哈', '顶一字', '敢死队'],
  speculator: ['接力', '卡位', '半路', '断板', '情绪'],
};

/** 昵称后缀词表 */
const NAME_SUFFIX: readonly string[] = [
  '大神', '老哥', '小散', '狂人', '一哥', '选手', '韭菜', '学徒', '本尊', '观察员', '炼金师', '本铺',
];

/** 成品昵称池（词表组合之外的风味补充） */
const NAME_FIXED: readonly string[] = [
  '仓位大神', '梭哈老哥', '定投小散', '回本就删APP', '解套就跑', '满仓干就完了',
  '一把梭大王', '装死躺平侠', '龙头战法传人', '涨停敢死队', '回本第一', '今天不割',
];

// ---------- 生成器 ----------

/** 生成 p01–p30 形式的编号 */
function padId(n: number): string {
  return `p${String(n).padStart(2, '0')}`;
}

/** 整数均匀抽取 [lo, hi]（含端点） */
function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** 情绪基线：按立场在对应区间内取整数（#48） */
function drawBaseline(rng: () => number, stance: Stance): number {
  const [lo, hi] = BASELINE_RANGE[stance];
  return randInt(rng, lo, hi);
}

/**
 * 散户偏差标签：每人 1–2 个、不重复（#49）；
 * 按风格/档位条件权重抽取（P4 情境点火配套），mulberry32 确定性不变。
 */
function drawBiases(rng: () => number, style: Style, tier: CapitalTier): Bias[] {
  const table = biasWeights(style, tier);
  const pool = [...BIAS_POOL];
  const count = rng() < 0.5 ? 1 : 2;
  const picks: Bias[] = [];
  for (let i = 0; i < count; i += 1) {
    // 在剩余候选上按条件权重归一化抽取（不重复约束保留）
    const remaining = table.filter(([b]) => pool.includes(b));
    const b = weightedPick(rng, remaining);
    pool.splice(pool.indexOf(b), 1);
    picks.push(b);
  }
  return picks;
}

/** 股吧风昵称：成品池 30% / 词表组合 70%，全局去重（确定性） */
function drawName(rng: () => number, style: Style, used: Set<string>): string {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let name: string;
    if (rng() < 0.3) {
      name = pick(rng, NAME_FIXED);
    } else {
      name = pick(rng, NAME_CORE[style]) + pick(rng, NAME_SUFFIX);
    }
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  // 兜底：确定性编号去重（正常词表空间内到不了这里）
  let serial = used.size + 1;
  let fallback = `无名韭菜${serial}`;
  while (used.has(fallback)) {
    serial += 1;
    fallback = `无名韭菜${serial}`;
  }
  used.add(fallback);
  return fallback;
}

/** 散户资金档位：按权重抽取 25 个，再随机挑 4 个名额强制改派为 1/2/3/4 档，保证覆盖（#11） */
function drawRetailTiers(rng: () => number): CapitalTier[] {
  const tiers: CapitalTier[] = [];
  for (let i = 0; i < RETAIL_COUNT; i += 1) {
    tiers.push(weightedPick(rng, RETAIL_TIER_WEIGHTS));
  }
  const slots: number[] = [];
  while (slots.length < 4) {
    const idx = randInt(rng, 0, RETAIL_COUNT - 1);
    if (!slots.includes(idx)) slots.push(idx);
  }
  slots.forEach((slot, k) => {
    tiers[slot] = (k + 1) as CapitalTier;
  });
  return tiers;
}

/** 按分布生成完整人设池（散户 p01–p25 在前，游资 p26–p30 在后） */
function generatePool(seed: number): Persona[] {
  const rng = mulberry32(seed);
  const usedNames = new Set<string>();
  const personas: Persona[] = [];
  const retailTiers = drawRetailTiers(rng);

  // 25 个散户：风格限定 trend/contrarian/technical/news/indexer（#10）
  for (let i = 0; i < RETAIL_COUNT; i += 1) {
    const style = weightedPick(rng, RETAIL_STYLE_WEIGHTS);
    const stance = weightedPick(rng, STANCE_PRIORS[style]);
    const persona: Persona = {
      id: padId(i + 1),
      name: drawName(rng, style, usedNames),
      style,
      capitalTier: retailTiers[i] ?? 1,
      stability: weightedPick(rng, STABILITY_PRIORS[style]),
      stance,
      biases: drawBiases(rng, style, retailTiers[i] ?? 1), // P4：按风格/档位条件权重
      maxLossPct: null, // 散户无游资纪律条款（#49）
      baseline: drawBaseline(rng, stance),
      systemPrompt: '',
    };
    persona.systemPrompt = compileSystemPrompt(persona);
    personas.push(persona);
  }

  // 5 个游资：风格限定 hotmoney/speculator，资金 3–4 档，稳定性偏 0.5–1.0（#10/#48/#49）
  for (let j = 0; j < HOT_MONEY_COUNT; j += 1) {
    const style = weightedPick(rng, HOT_MONEY_STYLE_WEIGHTS);
    const stance = weightedPick(rng, STANCE_PRIORS[style]);
    const persona: Persona = {
      id: padId(RETAIL_COUNT + j + 1),
      name: drawName(rng, style, usedNames),
      style,
      capitalTier: weightedPick(rng, HOT_MONEY_TIER_WEIGHTS),
      stability: weightedPick(rng, STABILITY_PRIORS[style]),
      stance,
      biases: [], // 游资不带散户偏差标签（#49）
      maxLossPct: DEFAULT_MAX_LOSS_PCT, // 游资纪律条款（#49）
      baseline: drawBaseline(rng, stance),
      systemPrompt: '',
    };
    persona.systemPrompt = compileSystemPrompt(persona);
    personas.push(persona);
  }

  return personas;
}

/**
 * 结构对冲校验（#40 拒绝价格侧阻尼后的多样性底线）：
 * contrarian+indexer 人数 + stance==='bear' 人数 ≥ 总人数 × 30%（30 人 → 9）。
 */
export function meetsStructuralHedge(personas: readonly Persona[]): boolean {
  let hedge = 0;
  for (const p of personas) {
    if (p.style === 'contrarian' || p.style === 'indexer') hedge += 1;
    if (p.stance === 'bear') hedge += 1;
  }
  return hedge >= STRUCTURAL_HEDGE_MIN;
}

/**
 * 生成 30 人人设池（#10/#11/#39/#48/#49）。
 * 确定性：同 cfg.seed 同池；生成后校验结构对冲，不满足则重播种
 * （seed+attempt）再生成，上限 100 次，仍不满足抛错。
 * 返回 seedUsed = 实际使用的种子（首次通过即 cfg.seed）。
 */
export function createPool(cfg: EngineConfig): { personas: Persona[]; seedUsed: number } {
  const baseSeed = cfg.seed >>> 0;
  for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS; attempt += 1) {
    const seedUsed = (baseSeed + attempt) >>> 0;
    const personas = generatePool(seedUsed);
    if (meetsStructuralHedge(personas)) {
      return { personas, seedUsed };
    }
  }
  throw new Error(
    `人设池生成失败：连续 ${MAX_SEED_ATTEMPTS} 次重播种仍不满足结构对冲约束` +
      `（contrarian+indexer+bear ≥ ${STRUCTURAL_HEDGE_MIN} 人），请检查种子与分布参数`,
  );
}
