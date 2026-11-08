/**
 * 净流聚合与命中口径（需求 #43/#44/#51）
 * 纯函数模块：给定人设、状态、输出 → 净流、方向、平局判定。
 */
import type { AgentOutput, AgentState, ClimateStats, EngineConfig, LegionClimate, Persona, RoundResult, Style } from './types.js';
import { CAPITAL_WEIGHTS, HOT_MONEY_STYLES } from './types.js';

/** 单个 Agent 的聚合权重 = 资金档位权重 ×（游资放大系数，#43） */
export function agentWeight(persona: Persona, cfg: EngineConfig): number {
  const base = CAPITAL_WEIGHTS[persona.capitalTier];
  const amp = HOT_MONEY_STYLES.includes(persona.style) ? cfg.hotMoneyAmp : 1;
  return base * amp;
}

/** 全体权重和（冲击映射的归一化分母） */
export function totalWeight(personas: Persona[], cfg: EngineConfig): number {
  return personas.reduce((sum, p) => sum + agentWeight(p, cfg), 0);
}

/**
 * 一轮净流（#51 置信度参与调仓幅度）：
 * NF = Σ 权重 × (目标仓位 − 当前仓位)/100 × 置信度/5
 */
export function netFlowOfRound(
  outputs: AgentOutput[],
  states: Map<string, AgentState>,
  personas: Map<string, Persona>,
  cfg: EngineConfig,
): number {
  let nf = 0;
  for (const o of outputs) {
    const st = states.get(o.personaId);
    const pe = personas.get(o.personaId);
    if (!st || !pe) continue;
    const delta = (o.targetPct - st.exposurePct) / 100;
    nf += agentWeight(pe, cfg) * delta * (o.confidence / 5);
  }
  return nf;
}

/** 中位数（偶数取中间两值均值） */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid]!;
  return (s[mid - 1]! + s[mid]!) / 2;
}

/** 方向 = 净流中位数符号（#44）；|x| 过小视为 0 */
export function directionOf(netFlowMedian: number): -1 | 0 | 1 {
  if (netFlowMedian > 1e-9) return 1;
  if (netFlowMedian < -1e-9) return -1;
  return 0;
}

/**
 * 多空统计（#26 预测页）：以某轮输出为准，
 * bull = 加仓者（target > current），bear = 减仓者，neutral = 持平。
 * 注意：这是**动作差**口径，仅供报告页；意见气候（P1 回流）用 opinionClimate 的仓位水平口径。
 */
export function bullBearSplit(
  outputs: AgentOutput[],
  states: Map<string, AgentState>,
): { bullPct: number; bearPct: number } {
  let bull = 0;
  let bear = 0;
  for (const o of outputs) {
    const st = states.get(o.personaId);
    if (!st) continue;
    if (o.targetPct > st.exposurePct) bull += 1;
    else if (o.targetPct < st.exposurePct) bear += 1;
  }
  const n = outputs.length || 1;
  return { bullPct: bull / n, bearPct: bear / n };
}

/**
 * 意见气候（P1）：按**目标仓位水平**测观点——≥70 看多 / ≤30 看空 / 其余观望。
 * 不需要 states（评审采纳，删参）：动作差口径在单边满仓行情（全员满仓看多）下
 * bullPct=0，会播报反向气候；仓位水平口径不受当前仓位影响。
 */
export function opinionClimate(outputs: AgentOutput[]): ClimateStats {
  const n = outputs.length;
  if (n === 0) return { bullPct: 0, bearPct: 0, neutralPct: 0, count: 0 };
  let bull = 0;
  let bear = 0;
  for (const o of outputs) {
    if (o.targetPct >= 70) bull += 1;
    else if (o.targetPct <= 30) bear += 1;
  }
  return { bullPct: bull / n, bearPct: bear / n, neutralPct: (n - bull - bear) / n, count: n };
}

/** 按风格分组统计意见气候（P1 分风格气候行；人设缺失的输出不计入任何组） */
export function climateByStyle(
  outputs: AgentOutput[],
  personas: Map<string, Persona>,
): Partial<Record<Style, ClimateStats>> {
  const groups = new Map<Style, AgentOutput[]>();
  for (const o of outputs) {
    const pe = personas.get(o.personaId);
    if (!pe) continue;
    const arr = groups.get(pe.style);
    if (arr) arr.push(o);
    else groups.set(pe.style, [o]);
  }
  const byStyle: Partial<Record<Style, ClimateStats>> = {};
  for (const [style, group] of groups) byStyle[style] = opinionClimate(group);
  return byStyle;
}

/** 组装军团意见气候（P1）：asOf = 气候形成日（产生该轮输出时所见最后已收盘 bar 日期） */
export function buildLegionClimate(
  asOf: string,
  outputs: AgentOutput[],
  personas: Map<string, Persona>,
): LegionClimate {
  return { asOf, overall: opinionClimate(outputs), byStyle: climateByStyle(outputs, personas) };
}

/**
 * 资金加权份额（P5 社会镜像）：按 keyOf 任意分组，返回各组 agentWeight（#43）
 * 占「参战者权重和」的份额。分母=参战者权重和——叙事描述在场资金结构，与冲击映射
 * 分母语义相互独立（缺员轮已有部分失败口径标注【技术默认】，需求文档 108 行）。
 * 人设缺失的输出不计入任何组、也不进分母；outputs 为空 → 空 Map（读方按 0 处理）。
 */
export function capitalWeightedSplit(
  outputs: AgentOutput[],
  personas: Map<string, Persona>,
  cfg: EngineConfig,
  keyOf: (o: AgentOutput, p: Persona) => string,
): Map<string, number> {
  const sums = new Map<string, number>();
  let total = 0;
  for (const o of outputs) {
    const pe = personas.get(o.personaId);
    if (!pe) continue;
    const w = agentWeight(pe, cfg);
    total += w;
    const k = keyOf(o, pe);
    sums.set(k, (sums.get(k) ?? 0) + w);
  }
  const shares = new Map<string, number>();
  for (const [k, w] of sums) shares.set(k, total > 0 ? w / total : 0);
  return shares;
}

/** 前 n 大户权重占参战者权重和的份额（P5 总编 reduce 提示「前 5 大户贡献 Y%」素材） */
export function topWeightShare(
  outputs: AgentOutput[],
  personas: Map<string, Persona>,
  cfg: EngineConfig,
  n = 5,
): number {
  const weights = outputs
    .map((o) => personas.get(o.personaId))
    .filter((p): p is Persona => p !== undefined)
    .map((p) => agentWeight(p, cfg))
    .sort((a, b) => b - a);
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return 0;
  return weights.slice(0, n).reduce((s, w) => s + w, 0) / total;
}

/** K 轮分歧度：方向不一致的比例（#39 告警输入） */
export function dispersionOf(rounds: RoundResult[]): number {
  if (rounds.length <= 1) return 0;
  const dirs = rounds.map((r) => r.direction);
  const counts = new Map<number, number>();
  for (const d of dirs) counts.set(d, (counts.get(d) ?? 0) + 1);
  let maxShare = 0;
  for (const c of counts.values()) maxShare = Math.max(maxShare, c / dirs.length);
  return 1 - maxShare; // 0 = 全体同向（分歧最窄），越大分歧越大
}

/** 分歧度过窄判定（#39）：5 轮全同向且净流标准差相对均值极小 */
export function isDispersionNarrow(rounds: RoundResult[]): boolean {
  if (rounds.length < 3) return false;
  const dirs = new Set(rounds.map((r) => r.direction));
  if (dirs.size > 1) return false;
  const nfs = rounds.map((r) => r.netFlow);
  const m = median(nfs);
  const variance = nfs.reduce((s, x) => s + (x - m) ** 2, 0) / nfs.length;
  const sd = Math.sqrt(variance);
  const rel = Math.abs(m) > 1e-9 ? sd / Math.abs(m) : sd;
  return rel < 0.1; // 离散度 <10% 视为过窄
}

/**
 * 命中判定（#44）：|实际涨跌| < tieThresholdPct → 平局（剔除分母）；
 * 否则方向一致 hit / 不一致 miss。
 */
export function classifyOutcome(
  predictedDirection: -1 | 0 | 1,
  actualPct: number,
  tieThresholdPct: number,
): 'hit' | 'miss' | 'tie' {
  if (Math.abs(actualPct) < tieThresholdPct) return 'tie';
  const actualDir: -1 | 1 = actualPct > 0 ? 1 : -1;
  return predictedDirection === actualDir ? 'hit' : 'miss';
}

/** 滚动命中率统计（#35 预测页顶部「最近 20 次命中 12 次」） */
export function rollingHitRate(
  outcomes: ('hit' | 'miss' | 'tie')[],
  window = 20,
): { hits: number; decided: number; rate: number; ties: number } {
  const recent = outcomes.slice(-window);
  const hits = recent.filter((o) => o === 'hit').length;
  const ties = recent.filter((o) => o === 'tie').length;
  const decided = recent.length - ties;
  return { hits, decided, rate: decided > 0 ? hits / decided : 0, ties };
}
