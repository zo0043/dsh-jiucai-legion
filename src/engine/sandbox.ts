/**
 * 沙盘模式（需求 #17/#37/#38/#40/#41/#50）：纯内生多日演化。
 * 无价格侧阻尼（#40）；外生变量第 0 日冻结并线性衰减（#41）；军团倾向逐日回流（#50）。
 */
import type { HostPorts } from '../host/ports.js';
import type {
  AgentState, EngineConfig, EventCard, LegionClimate, LegionMirror, MarketSnapshot, Persona, SandboxDay, SandboxResult,
} from './types.js';
import { runRound, settlePositions, QuorumError } from './orchestrator.js';
import { applyFeedback, realizedRetMapFromBars } from './feedback.js';
import { median, buildLegionClimate, topWeightShare } from './aggregate.js';
import { buildCamps, buildLegionMirror, campDispersion, dispersionNote, generateReport } from './editor.js';
import { applyOffset } from './impact.js';
import { cardContributions, activeEvents } from './event-card.js';
import { institutionNetFlow, instNarrativeLine } from './institutions.js';
import { tradeDayFrom, computeVol20 } from './dates.js';

export interface SandboxDeps {
  ports: HostPorts;
  cfg: EngineConfig;
  calendar: string[];
  /** 第 0 日真实快照（外生冻结源，#41） */
  snapshot: MarketSnapshot;
  pool: Persona[];
  states: Map<string, AgentState>;
  cards: EventCard[];
  days: number;
  /** 随机源（事件卡可见性采样，确定性） */
  seed: number;
}

export interface SandboxRunOutcome {
  result: SandboxResult;
  /** 沙盘终态（供调用方落盘） */
  finalStates: Map<string, AgentState>;
}

/**
 * 沙盘宽度外生衰减（#41/F4）：计数按 w 线性缩放（四舍五入）；
 * w 归零（或原值为 null）→ null——info-set 渲染「未知」，
 * 不得让 0 冒充「无涨停/无跌停」。独立导出便于直接单测。
 */
export function decayBreadth(breadth: MarketSnapshot['breadth'], w: number): MarketSnapshot['breadth'] {
  const decay = (v: number | null): number | null => (v === null || w <= 0 ? null : Math.round(v * w));
  return {
    limitUp: decay(breadth.limitUp),
    limitDown: decay(breadth.limitDown),
    failedBoard: decay(breadth.failedBoard),
    maxStreak: decay(breadth.maxStreak),
    advancers: decay(breadth.advancers),
    decliners: decay(breadth.decliners),
  };
}

export async function runSandbox(deps: SandboxDeps): Promise<SandboxRunOutcome> {
  const { ports, cfg, calendar, pool, cards } = deps;
  const personaMap = new Map(pool.map((p) => [p.id, p]));
  const startDate = deps.snapshot.tradeDate;
  // 事件卡统一对齐到沙盘首日生效（注入时刻可能在锚定日，#42 语义：从沙盘开始衰减）
  const firstDay = tradeDayFrom(calendar, startDate, 0);
  const simCards = deps.cards.map((c) => ({ ...c, injectedDay: firstDay }));

  let states = new Map(deps.states);
  let snap: MarketSnapshot = deps.snapshot;
  let close = snap.bars[snap.bars.length - 1]!.close;
  // 军团意见气候（P1）/资金镜像（P5）：第 0 日用跨运行注入的快照值（缺省 null → 块省略），此后逐日滚动；
  // legionBullPct 保留为派生值（口径对齐 opinionClimate，无气候时沿用旧兜底 0.5）
  let climate: LegionClimate | null = deps.snapshot.legionClimate ?? null;
  let mirror: LegionMirror | null = deps.snapshot.legionMirror ?? null;
  let legionBullPct = climate !== null ? climate.overall.bullPct : (snap.legionBullPct ?? 0.5);
  const sandboxDays: SandboxDay[] = [];
  // #54/F38 缺席口径：全程汇总（被剔除轮数 / 去重缺席名单 / 最差一轮参战数）
  let quorumTrimmed = 0;
  // 最后一轮结算前状态引用（P5：报告阵营/分歧按结算前意图实测，结算后 delta 被置信度调幅抹平）
  let lastPreSettleStates: Map<string, AgentState> = states;

  for (let i = 0; i < deps.days; i += 1) {
    const tradeDate = tradeDayFrom(calendar, startDate, i);
    const dayOffset = i; // 事件卡与外生衰减都按模拟日序

    // 外生衰减权重（#41）：max(0, 1 - t/exogenousDecayDays)
    const w = Math.max(0, 1 - i / cfg.exogenousDecayDays);
    // F4 修复：宽度计数同样随 w 衰减（此前只有情绪热度与新闻衰减，宽度恒为第 0 日原值）；
    // w 归零后置 null → info-set 渲染「未知」，不得让 0 冒充「无涨停」
    const daySnapshot: MarketSnapshot = {
      ...snap,
      tradeDate,
      sentiment: { ...snap.sentiment, heatIndex: snap.sentiment.heatIndex * w },
      news: { items: snap.news.items.slice(0, Math.ceil(snap.news.items.length * w)), asOf: snap.news.asOf },
      breadth: decayBreadth(snap.breadth, w),
      legionBullPct,
      legionClimate: climate, // P1 意见气候回流（asOf=上一轮所见末根，结果子句随之现算）
      legionMirror: mirror, // P5 资金镜像回流（双轨行 + 集中度传闻）
      volatility20: computeVol20(snap.bars),
      degraded: [
        ...snap.degraded,
        { source: 'sandbox', asOf: tradeDate, degraded: w < 1, note: `外生输入冻结于 ${startDate}，衰减至 ${(w * 100).toFixed(0)}%（#41）` },
      ],
    };

    // K 轮采样（#38 默认 K=1）。#54/F28：单轮低于法定人数 → 从分布剔除，K 轮全作废才上抛；
    // K=1 时该轮即当日、无分布可剔除，QuorumError 上抛按「全作废」处理。
    const k = Math.max(1, cfg.sandboxK);
    const rounds: import('./types.js').RoundResult[] = [];
    // 机构净流常数（#60/#41）：daySnapshot 经 spread 原样透传 day-0 冻结载荷 inst——
    // 不随外生衰减折减、不重算（与 funds 冻结同构），每日折算得同一常数
    const instNF = institutionNetFlow(daySnapshot.inst, cfg).netFlow;
    for (let r = 1; r <= k; r += 1) {
      try {
        rounds.push(await runRound({
          ports, cfg, personas: pool, states, snapshot: daySnapshot, round: r, seed: deps.seed + i * 100 + r,
          instNF,
        }));
      } catch (e) {
        if (!(e instanceof QuorumError)) throw e;
        quorumTrimmed += 1;
      }
    }
    if (rounds.length === 0) throw new QuorumError(0, cfg.quorumFloor);
    const round = rounds.reduce((best, r) =>
      Math.abs(r.netFlow - median(rounds.map((x) => x.netFlow))) <
        Math.abs(best.netFlow - median(rounds.map((x) => x.netFlow))) ? r : best, rounds[0]!);

    // 事件卡定向注入的情绪贡献（#42：可见性过滤 + 线性衰减，与预测模式共用 cardContributions）
    const contrib = new Map<string, number>();
    for (const p of pool) {
      contrib.set(p.id, cardContributions(simCards, p, tradeDate, cfg, deps.seed + i));
    }

    // 军团意见气候（P1，结算前统计）：按目标仓位水平测观点，替代动作差口径；
    // asOf = 该轮所见末根（snap.bars 最后一根，本日 bar 尚未追加）
    const roundClimate = buildLegionClimate(snap.bars[snap.bars.length - 1]!.date, round.outputs, personaMap);
    // 结算：情绪/记忆（marketRet = 当日推演涨跌，#40 无阻尼线性外推）→ 仓位（置信度调幅）。
    // F16/F24：反馈须基于结算前口径（先 applyFeedback 再 settlePositions）。
    lastPreSettleStates = states; // P5：报告阵营按结算前意图实测
    const marketRet = round.offsetPct / 100;
    states = applyFeedback(states, round.outputs, personaMap, {
      execPrice: close, marketRet, day: tradeDate, cfg, eventContrib: contrib,
      realizedRetByDay: realizedRetMapFromBars(snap.bars), // P2：含推演 bar 的相邻对（本日判断待次日 bar）
    });
    states = settlePositions(states, round.outputs, close);
    close = applyOffset(close, round.offsetPct);
    legionBullPct = roundClimate.overall.bullPct;
    climate = roundClimate;
    mirror = buildLegionMirror(round.outputs, states, personaMap, cfg); // P5：结算前口径滚动

    sandboxDays.push({
      tradeDate,
      dayIndex: i,
      netFlow: round.netFlow,
      direction: round.direction,
      close,
      legionBullPct,
      activeEvents: activeEvents(simCards, tradeDate),
      round,
      instNF, // #60/#41：锚定日冻结值折算的常数（面板标注「锚定日冻结值」）
    });
    // 快照滚动：bars 追加推演 bar（供次日 computeVol20 与 K 线块）
    snap = { ...snap, bars: [...snap.bars, { date: tradeDate, open: close, high: close, low: close, close, volume: 0 }] };
  }

  const lastDay = sandboxDays[sandboxDays.length - 1];
  const camps = buildCamps(lastDay?.round.outputs ?? [], lastPreSettleStates, personaMap, cfg);
  // P5 分歧话术实测化：按当日阵营人数份额算 dispersion（1 − 最大阵营份额），
  // 替换旧硬编码 dispersionNote(0.2, false) 恒出「有些分歧」（#34 数据严谨）
  const dispersion = campDispersion(camps);
  // 缺席口径（#54/F38）：沙盘全程接入 participationNote，不再硬编码不标注
  const missingAll = [...new Set(sandboxDays.flatMap((d) => d.round.missing))];
  const minParticipants = sandboxDays.length > 0 ? Math.min(...sandboxDays.map((d) => d.round.participants)) : 0;
  const participationParts: string[] = [];
  if (quorumTrimmed > 0) participationParts.push(`${quorumTrimmed} 轮低于法定人数未入分布`);
  if (missingAll.length > 0) {
    participationParts.push(`${missingAll.join('、')} 缺席（最少一轮 ${minParticipants}/${pool.length} 参战）`);
  }
  const participationNote = participationParts.length > 0
    ? `⚠ 部分 Agent 未参与（#54）：${participationParts.join('；')}`
    : null;
  const report = await generateReport(ports, {
    dayLabel: `沙盘 ${startDate} 起第 ${deps.days} 日`,
    camps,
    dispersionText: dispersionNote(dispersion, false),
    participationNote,
    multiBullPct: legionBullPct,
    degradedFlags: [],
    sandboxNote: `⚠ 沙盘推演：外生数据冻结于 ${startDate} 并逐日衰减，第 1 日后全部为内生演化（#41），不构成对真实市场的预测。`,
    topWhaleShare: lastDay ? topWeightShare(lastDay.round.outputs, personaMap, cfg, 5) : null, // P5 资金镜像行
    // 机构动向叙事行（#64）：沙盘取 day-0 冻结载荷（#41 同构）
    instLine: instNarrativeLine(deps.snapshot.inst),
  });

  return {
    result: {
      schemaVersion: 1,
      mode: 'sandbox',
      index: cfg.index,
      startDate,
      runAt: ports.clock.now().toISOString(),
      days: sandboxDays,
      note: 'exogenous frozen at day0, decaying',
      report,
      legionClimate: climate, // P1：末轮气候，供跨运行读取（旧记录缺字段 → null，自愈）
      legionMirror: mirror, // P5：末轮资金镜像，供跨运行读取（旧记录缺字段 → null，自愈）
      inst: deps.snapshot.inst ?? null, // #60/#41：day-0 机构载荷原样冻结落盘
    },
    finalStates: states,
  };
}
