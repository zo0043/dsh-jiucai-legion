/**
 * 总编 Agent（需求 #30；P5 社会镜像精度）：map-reduce 产出《今日散户生态观察》。
 * Map = 纯计算阵营聚合（人数 + 资金权重份额 + 三元代表发言带署名）；
 * Reduce = 1 次 LLM 叙事（失败回退模板，日报永不缺席）。
 */
import type { HostPorts } from '../host/ports.js';
import type {
  AgentOutput, AgentState, CampQuote, CampSummary, EditorReport, EngineConfig, LegionMirror, Persona,
} from './types.js';
import { collectStream } from './orchestrator.js';
import { agentWeight } from './aggregate.js';
import { STYLE_LABEL } from './prompts.js';

export const DISCLAIMER = '⚠️ 本日报由模拟沙盘生成，仅供娱乐与研究，不构成任何投资建议。';

/**
 * 阵营内代表发言三元选择（P5，替换旧「按 reason 长度取前 3」，设计 §5.10 的三元落实）：
 * - 影响力×极端度 = agentWeight（#43 资金加权×游资放大）× |targetPct−exposurePct| 取前 2 条
 *   （并列按 personaId 升序，确定性）；发言按资金加权，不再表面按人头；
 * - 最反差 1 条 = 阵营内 |delta| 最小者（距换边最近、嘴上最不坚定的声音，与阵营狂热成反差）；
 *   已入选前 2 的跳过；并列同上。阵营人数 <3 时按分数序给全（自然去重）。
 */
function pickQuotes(
  members: { o: AgentOutput; delta: number; weight: number }[],
  personas: Map<string, Persona>,
  n = 3,
): CampQuote[] {
  const scoreOf = (m: { delta: number; weight: number }): number => m.weight * Math.abs(m.delta);
  const sorted = [...members].sort((a, b) =>
    scoreOf(b) - scoreOf(a) || a.o.personaId.localeCompare(b.o.personaId));
  const picked = sorted.slice(0, 2);
  const rest = sorted.filter((m) => !picked.includes(m));
  const contrast = [...rest].sort((a, b) =>
    Math.abs(a.delta) - Math.abs(b.delta) || scoreOf(b) - scoreOf(a) || a.o.personaId.localeCompare(b.o.personaId))[0];
  if (contrast !== undefined) picked.push(contrast);
  return picked.slice(0, n).map(({ o }) => {
    const pe = personas.get(o.personaId)!;
    return { personaId: o.personaId, name: pe.name, style: pe.style, capitalTier: pe.capitalTier, reason: o.reason };
  });
}

/**
 * Map：按调仓意图分阵营（加仓>5 个点 = 多军，减仓<−5 = 空军，其余观望）（#30）。
 * P5：各阵营附带资金权重份额 weightShare（camp 权重 ÷ 参战者权重和，#43 加权），
 * 代表发言按「影响力×极端度×2 + 最反差×1」三元选取并带署名。
 */
export function buildCamps(
  outputs: AgentOutput[],
  states: Map<string, AgentState>,
  personas: Map<string, Persona>,
  cfg: EngineConfig,
): CampSummary[] {
  const def = (camp: CampSummary['camp']): CampSummary => ({ camp, count: 0, avgTargetPct: 0, avgEmotion: 0, weightShare: 0, quotes: [] });
  const camps: Record<CampSummary['camp'], CampSummary & { _sumTarget: number; _sumEmotion: number; _weight: number; _members: { o: AgentOutput; delta: number; weight: number }[] }> = {
    bull: { ...def('bull'), _sumTarget: 0, _sumEmotion: 0, _weight: 0, _members: [] },
    bear: { ...def('bear'), _sumTarget: 0, _sumEmotion: 0, _weight: 0, _members: [] },
    neutral: { ...def('neutral'), _sumTarget: 0, _sumEmotion: 0, _weight: 0, _members: [] },
  };
  let participantWeight = 0;
  for (const o of outputs) {
    const st = states.get(o.personaId);
    const pe = personas.get(o.personaId);
    if (!st || !pe) continue;
    const delta = o.targetPct - st.exposurePct;
    const camp: CampSummary['camp'] = delta > 5 ? 'bull' : delta < -5 ? 'bear' : 'neutral';
    const weight = agentWeight(pe, cfg);
    const c = camps[camp];
    c.count += 1;
    c._weight += weight;
    c._sumTarget += o.targetPct;
    c._sumEmotion += st.emotion;
    c._members.push({ o, delta, weight });
    participantWeight += weight;
  }
  return (['bull', 'bear', 'neutral'] as const).map((k) => {
    const c = camps[k];
    return {
      camp: k,
      count: c.count,
      avgTargetPct: c.count > 0 ? c._sumTarget / c.count : 0,
      avgEmotion: c.count > 0 ? c._sumEmotion / c.count : 0,
      weightShare: participantWeight > 0 ? c._weight / participantWeight : 0,
      quotes: pickQuotes(c._members, personas),
    };
  });
}

/**
 * 军团资金镜像（P5）：资金加权看多/看空 + 集中度传闻，供信息集气候块双轨行/传闻行。
 * - 加权口径对齐 opinionClimate（≥70 看多 / ≤30 看空），权重 agentWeight（#43）；
 * - 传闻：按 buildCamps 同一划分找「领先阵营」（阵营权重和最大）；领先阵营为多/空且
 *   其内最大单一权重占该阵营权重和比例 > cfg.whaleRumorThresholdPct → 给出方向。
 */
export function buildLegionMirror(
  outputs: AgentOutput[],
  states: Map<string, AgentState>,
  personas: Map<string, Persona>,
  cfg: EngineConfig,
): LegionMirror {
  const camps = buildCamps(outputs, states, personas, cfg);
  // 资金加权看多/看空（仓位水平口径，分母=参战者权重和）
  let bullW = 0;
  let bearW = 0;
  let total = 0;
  for (const o of outputs) {
    const pe = personas.get(o.personaId);
    if (!pe) continue;
    const w = agentWeight(pe, cfg);
    total += w;
    if (o.targetPct >= 70) bullW += w;
    else if (o.targetPct <= 30) bearW += w;
  }
  // 领先阵营（阵营权重和最大）内的最大单一权重占比 → 集中度传闻
  const leader = [...camps].sort((a, b) => b.weightShare - a.weightShare)[0];
  let whaleRumor: LegionMirror['whaleRumor'] = null;
  if (leader && leader.camp !== 'neutral' && leader.count > 0) {
    const members: { weight: number }[] = [];
    for (const o of outputs) {
      const st = states.get(o.personaId);
      const pe = personas.get(o.personaId);
      if (!st || !pe) continue;
      const delta = o.targetPct - st.exposurePct;
      const camp = delta > 5 ? 'bull' : delta < -5 ? 'bear' : 'neutral';
      if (camp === leader.camp) members.push({ weight: agentWeight(pe, cfg) });
    }
    const campWeight = members.reduce((s, m) => s + m.weight, 0);
    const maxSingle = Math.max(0, ...members.map((m) => m.weight));
    if (campWeight > 0 && (maxSingle / campWeight) * 100 > cfg.whaleRumorThresholdPct) {
      whaleRumor = leader.camp === 'bull' ? '做多' : '做空';
    }
  }
  return {
    weightedBullPct: total > 0 ? bullW / total : 0,
    weightedBearPct: total > 0 ? bearW / total : 0,
    whaleRumor,
  };
}

/**
 * 当日阵营分歧度（P5）：1 − 最大阵营人数份额（headcount——分歧话术描述「人」的意见分裂，
 * 不与资金份额混用；与 dispersionOf 的 1−最大份额语义一致，应用到单日阵营）。无参战者 → 0。
 */
export function campDispersion(camps: CampSummary[]): number {
  const participants = camps.reduce((s, c) => s + c.count, 0);
  if (participants <= 0) return 0;
  return 1 - Math.max(...camps.map((c) => c.count)) / participants;
}

/** 分歧度话术素材（#30：K 轮分歧大 →「今天军团吵得特别凶」） */
export function dispersionNote(dispersion: number, narrow: boolean): string {
  if (narrow) return '军团今天意见出奇一致，这种安静反而要留个心眼。';
  if (dispersion >= 0.4) return '今天军团吵得特别凶，多空谁也说服不了谁。';
  if (dispersion >= 0.15) return '军团内部有些分歧，但大方向还算一致。';
  return '军团步伐比较齐。';
}

/** Reduce：1 次 LLM 叙事；失败 → 模板兜底（#28 异常给人话） */
export async function generateReport(
  ports: HostPorts,
  input: {
    dayLabel: string;
    camps: CampSummary[];
    dispersionText: string;
    participationNote: string | null;
    multiBullPct: number;
    degradedFlags: string[];
    sandboxNote?: string;
    intradayNote?: string | null;
    /** 前 5 大户权重占参战者权重和的份额（P5 资金镜像行；缺省/无参战 → 行省略） */
    topWhaleShare?: number | null;
    /** 机构动向叙事行（v1.4 #64：instNarrativeLine 拼装的零 LLM 素材；缺省 → 行省略） */
    instLine?: string | null;
  },
): Promise<EditorReport> {
  const mapSummary = input.camps
    .map((c) => {
      const label = c.camp === 'bull' ? '多军' : c.camp === 'bear' ? '空军' : '观望';
      // P5：人数之外补资金权重份额（叙事对齐资金结构）；发言带「@昵称（风格·N档）」署名
      const quotes = c.quotes.map((q) => `@${q.name}（${STYLE_LABEL[q.style]}·${q.capitalTier}档）：${q.reason}`).join('；');
      return `${label} ${c.count} 人（资金占比 ${(c.weightShare * 100).toFixed(0)}%），平均目标仓位 ${c.avgTargetPct.toFixed(1)}%，平均情绪 ${c.avgEmotion.toFixed(0)}，代表发言：${quotes || '（无）'}`;
    })
    .join('\n');
  // P5 资金镜像行：多军资金占比 + 前 5 大户贡献（总编叙事对齐资金加权冲击，#43）
  const bullShare = input.camps.find((c) => c.camp === 'bull')?.weightShare ?? 0;
  const mirrorLine = input.topWhaleShare === null || input.topWhaleShare === undefined
    ? ''
    : `资金镜像：多军资金占比 ${(bullShare * 100).toFixed(0)}%，前 5 大户贡献 ${(input.topWhaleShare * 100).toFixed(0)}%（按在场资金）`;
  // 机构动向行（v1.4 #64）：紧跟资金镜像行之后，零 LLM 素材原样进 prompt 与兜底模板
  const instNarrative = input.instLine ?? '';
  const flags = input.degradedFlags.length > 0 ? `\n数据降级：${input.degradedFlags.join('；')}` : '';
  const prompt = [
    `你是散户军团的总编。根据以下阵营数据写一篇《今日散户生态观察》（${input.dayLabel}），股吧体、轻松自嘲、但数字要严谨，300 字以内。`,
    `军团看多比例：${(input.multiBullPct * 100).toFixed(0)}%`,
    mirrorLine,
    instNarrative,
    input.dispersionText,
    input.participationNote ?? '',
    input.sandboxNote ?? '',
    input.intradayNote ?? '',
    mapSummary,
    flags,
    '结尾必须带上这句免责声明原文：' + DISCLAIMER,
  ].filter((s) => s.length > 0).join('\n');

  try {
    const md = await collectStream(ports, { messages: [{ role: 'user', content: prompt }] });
    // 防线：LLM 输出像 Agent 原始 JSON（脚本模式/异常）时不用作叙事，走模板兜底
    const looksLikeAgentJson = md.trim().startsWith('{') && md.includes('target_position_pct');
    if (md.trim().length > 0 && !looksLikeAgentJson) {
      // F2：沙盘「内生推演」标注与免责声明同级强制——LLM 叙事丢掉也要补回（#41）
      let out = ensureDisclaimer(md);
      if (input.sandboxNote !== undefined && !out.includes('内生')) {
        out = out.replace(DISCLAIMER, `${input.sandboxNote}\n\n${DISCLAIMER}`);
      }
      return { markdown: out, camps: input.camps, dispersionNote: input.dispersionText, participationNote: input.participationNote };
    }
  } catch { /* 走兜底 */ }
  return { markdown: fallbackReport(input), camps: input.camps, dispersionNote: input.dispersionText, participationNote: input.participationNote };
}

function ensureDisclaimer(md: string): string {
  return md.includes(DISCLAIMER) ? md : `${md.trim()}\n\n${DISCLAIMER}`;
}

function fallbackReport(input: {
  dayLabel: string;
  camps: CampSummary[];
  multiBullPct: number;
  dispersionText: string;
  participationNote: string | null;
  sandboxNote?: string;
  /** 机构动向行（v1.4 #64：兜底模板同步包含——#28 日报永不缺席） */
  instLine?: string | null;
}): string {
  const lines = [
    `# 今日散户生态观察（${input.dayLabel}）`,
    '',
    `军团今天 ${(input.multiBullPct * 100).toFixed(0)}% 的兄弟在加仓。${input.dispersionText}`,
    '',
    ...input.camps.map((c) => {
      const label = c.camp === 'bull' ? '多军' : c.camp === 'bear' ? '空军' : '观望';
      return `- **${label}** ${c.count} 人 ｜ 平均目标仓位 ${c.avgTargetPct.toFixed(1)}% ｜ 平均情绪 ${c.avgEmotion.toFixed(0)}`;
    }),
    ...(input.instLine ? ['', input.instLine] : []),
    ...(input.participationNote ? ['', input.participationNote] : []),
    ...(input.sandboxNote ? ['', input.sandboxNote] : []),
    '',
    DISCLAIMER,
  ];
  return lines.join('\n');
}
