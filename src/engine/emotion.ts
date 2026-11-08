/**
 * 韭菜军团 — 标量情绪引擎（需求 #48/#42/#52；P3 情绪惯性）。
 *
 * 三源冲击与更新公式（常量全部来自 cfg.emotion，#48 设置页可调）：
 * ```
 * shock_t = eventContrib                                                       // 事件卡（#42，已含权重与线性衰减）
 *         + clamp(unrealizedPnlPct, -5, 5) × pnlWeight × (1/stability)          // 个人盈亏（#49 成本锚）
 *         + clamp(|marketRet| - 0.01, 0, 0.05) × sign(marketRet) × marketWeight × (1/stability)  // 大盘波动
 * emotion_{t+1} = clamp(baseline + λ·(prev − baseline) + (1−λ)·asym·shock_t, 0, 100)
 * asym = cfg.emotion.negativeAsym（shock_t < 0）/ 1（否则）
 * ```
 * - λ = cfg.emotion.carryover（默认 0.6）：前一日情绪残留——补齐 #48「逐日衰减回人设基线」
 *   的时间尾（旧公式三源中两源零日衰减，prev 被弃用）。持续冲击稳态 = baseline + asym·shock，
 *   无 1/(1−λ) 棘轮放大（负面不对称会加深该稳态，negativeAsym 滑杆调 1.0 即回对称口径）。
 * - 兼容锚：carryover=0 且 negativeAsym=1 时逐点等价于旧 §5.2 公式（以 baseline 为锚整体重算）。
 * - 兼容守卫：升级前落盘的 config.json 的 emotion 可能缺新键 → 回退默认值（0.6/1.3），
 *   避免 undefined 参与运算产生 NaN。
 */
import type { EngineConfig, EventCard, Persona } from './types.js';

/** 区间截断 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 单张事件卡在 dayOffset 天后对该 Agent 的情绪贡献（#42 线性衰减，#48 事件权重）：
 * `strength × direction × cfg.emotion.eventWeight × max(0, 1 - dayOffset/card.decayDays)`。
 * - 注入当日（dayOffset=0）贡献最大；dayOffset ≥ decayDays 时贡献归零；
 * - direction=-1（利空）贡献为负；
 * - dayOffset<0 按异常输入处理为 0（不放大未来事件）。
 * 上层（event-card.cardContributions）负责按 dayOffset 门控并求和。
 */
export function eventContribution(card: EventCard, dayOffset: number, cfg: EngineConfig): number {
  const decayDays = card.decayDays;
  if (!(decayDays > 0)) return 0; // 防御：decayDays 非正视为无效事件
  const offset = Math.max(0, dayOffset);
  const decay = Math.max(0, 1 - offset / decayDays);
  return card.strength * card.direction * cfg.emotion.eventWeight * decay;
}

/** 情绪更新输入：三项贡献（事件卡已在外部求和，#48 三源规则更新） */
export interface EmotionInput {
  /** 本日全部可见事件卡的贡献之和（含权重与衰减，#42） */
  eventContrib: number;
  /** 浮动盈亏百分比（相对成本价，#49；无持仓为 0） */
  unrealizedPnlPct: number;
  /** 大盘当日涨跌幅（小数，如 0.012 = +1.2%） */
  marketRet: number;
}

/**
 * 标量情绪更新（#48 三源规则更新 + P3 情绪惯性）：见模块头公式，clamp 到 0–100。
 * - λ 残留作用于整体三源之和（而非逐源）：持续冲击下稳态 = baseline + asym·shock，
 *   不会出现攻击式（无 (1−λ)）的 1/(1−λ) 棘轮放大；
 * - 「情绪稳定性」stability 越低（0.5）波动放大越狠，越高（2.0）越钝感；
 * - 盈亏项在 ±5% 处饱和；大盘波动项只对 |ret|>1% 的部分计价、5% 封顶；
 * - 纯函数：不修改 persona，返回新数值。
 */
export function updateEmotion(
  prev: number,
  persona: Persona,
  input: EmotionInput,
  cfg: EngineConfig,
): number {
  const stability = persona.stability;
  const inv = stability > 0 ? 1 / stability : 1; // 防御：非法稳定性按中性 1 处理
  const pnlTerm = clamp(input.unrealizedPnlPct, -5, 5) * cfg.emotion.pnlWeight * inv;
  const ret = input.marketRet;
  const marketTerm =
    clamp(Math.abs(ret) - 0.01, 0, 0.05) * Math.sign(ret) * cfg.emotion.marketWeight * inv;
  const shock = input.eventContrib + pnlTerm + marketTerm; // 三源冲击之和（P3：λ 作用于整体）
  // 兼容守卫：升级前的旧 config.json 无 carryover/negativeAsym → undefined 参与运算会产生 NaN
  const lambda = Number.isFinite(cfg.emotion.carryover) ? cfg.emotion.carryover : 0.6;
  const asymCfg = Number.isFinite(cfg.emotion.negativeAsym) ? cfg.emotion.negativeAsym : 1.3;
  // 负面不对称（bad is stronger）：仅负向冲击放大；asymCfg=1 即对称（旧行为）
  const asym = shock < 0 ? asymCfg : 1;
  return clamp(
    persona.baseline + lambda * (prev - persona.baseline) + (1 - lambda) * asym * shock,
    0,
    100,
  );
}
