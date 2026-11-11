/**
 * 预测模式（需求 #17/#18/#36/#46/#50）：
 * 锚定最近已收盘交易日 → 第 1 日 K=5 蒙特卡洛 → 第 2–5 日 K=1 递推。
 * 仓位/情绪/记忆只从「中位轮」提交一天；递推在 working copy 上进行。
 */
import type { HostPorts } from '../host/ports.js';
import type {
  AgentState, DayPrediction, EngineConfig, EventCard, LegionClimate, LegionMirror, MarketSnapshot, Persona,
  PredictionResult, RoundResult,
} from './types.js';
import { runRound, settlePositions, QuorumError } from './orchestrator.js';
import { applyFeedback, realizedRetMapFromBars } from './feedback.js';
import { median, directionOf, bullBearSplit, dispersionOf, isDispersionNarrow, buildLegionClimate, topWeightShare } from './aggregate.js';
import { applyOffset } from './impact.js';
import { buildCamps, buildLegionMirror, generateReport, dispersionNote } from './editor.js';
import { cardContributions } from './event-card.js';
import { institutionNetFlow, instNarrativeLine } from './institutions.js';
import { nextTradeDay, computeVol20, quantile, isIntraday } from './dates.js';

export class MarketDataStaleError extends Error {
  constructor(public readonly latestBarDate: string) {
    super(`行情数据不新鲜（最新收盘 ${latestBarDate} 已落后交易日历），锚定基点无意义，本次预测硬失败。请检查数据源后重试。`);
    this.name = 'MarketDataStaleError';
  }
}

export interface PredictDeps {
  ports: HostPorts;
  cfg: EngineConfig;
  calendar: string[];
  snapshot: MarketSnapshot;
  /** snapshot 是否被判定为不新鲜（由调用方按日历+最新 bar 判定后传入） */
  stale: boolean;
  pool: Persona[];
  states: Map<string, AgentState>;
  cards: EventCard[];
  coldStart: boolean;
}

export interface PredictionRunOutcome {
  result: PredictionResult;
  /** 中位轮提交后的军团状态（仓位/成本/情绪/记忆，供调用方落盘） */
  committedStates: Map<string, AgentState>;
}

export async function runPrediction(deps: PredictDeps): Promise<PredictionRunOutcome> {
  const { ports, cfg, calendar, pool, cards } = deps;
  const personaMap = new Map(pool.map((p) => [p.id, p]));

  // #24/#35：行情不新鲜 → 硬失败
  if (deps.stale) throw new MarketDataStaleError(deps.snapshot.tradeDate);

  const bars = deps.snapshot.bars;
  const anchorBar = bars[bars.length - 1]!;
  const anchorClose = anchorBar.close;
  const anchorDate = anchorBar.date;
  const prevClose = bars.length >= 2 ? bars[bars.length - 2]!.close : anchorClose;
  const day1Date = nextTradeDay(calendar, anchorDate);
  const todayRet = (anchorClose - prevClose) / prevClose;

  // #46 盘中触发：照跑 + 标注（锚即最近已收盘交易日）
  const intradayNote = isIntraday(ports.clock.now())
    ? `盘中运行：以 ${anchorDate} 收盘（${anchorClose.toFixed(2)}）为锚，预测下一交易日收盘。`
    : null;

  // ---------- 第 1 日：K=5 蒙特卡洛（#18） ----------
  const K = 5;
  const rounds: RoundResult[] = [];
  // #54/F28 部分失败口径：单轮低于法定人数 → 该轮从分布剔除（捕获 QuorumError），
  // 仅 K 轮全作废才让整场预测失败（4/5 轮成功不再白跑全场）。
  let quorumFailure: QuorumError | null = null;
  let quorumTrimmed = 0;
  for (let k = 1; k <= K; k += 1) {
    // K 轮之间互不可见（#50 澄清）：同一 snapshot、独立种子
    try {
      const r = await runRound({
        ports, cfg, personas: pool, states: deps.states, snapshot: deps.snapshot, round: k, seed: cfg.seed + k,
        // 机构折算净流（#60）：确定性常数加进每轮（median(NF_i+c)=median(NF_i)+c），
        // 折算只发生在 institutionNetFlow；snapshot.inst 为 python 原始载荷
        instNF: institutionNetFlow(deps.snapshot.inst, cfg).netFlow,
      });
      rounds.push(r);
    } catch (e) {
      if (!(e instanceof QuorumError)) throw e;
      quorumFailure = e;
      quorumTrimmed += 1;
    }
  }
  if (rounds.length === 0) throw quorumFailure ?? new QuorumError(0, cfg.quorumFloor);

  // #54/F38 缺席口径：汇总全部轮次（K=5 + 递推 4 日）的缺席（去重），参战数取最差一轮，
  // 而非只看中位轮（其他轮次缺席对用户可见）。
  const missingAll = new Set<string>();
  let minParticipants = pool.length;
  for (const r of rounds) {
    for (const m of r.missing) missingAll.add(m);
    minParticipants = Math.min(minParticipants, r.participants);
  }
  const nfs = rounds.map((r) => r.netFlow);
  const nfMedian = median(nfs);
  const direction = directionOf(nfMedian);
  // 中位轮 = 净流最接近中位数的轮（用于提交状态与叙事）
  const medianRound = rounds.reduce((best, r) =>
    Math.abs(r.netFlow - nfMedian) < Math.abs(best.netFlow - nfMedian) ? r : best, rounds[0]!);
  const day1Offsets = rounds.map((r) => r.offsetPct);
  const day1Close = day1Offsets.map((o) => applyOffset(anchorClose, o));
  // 中心估计：中位轮的 offset
  const day1Center = applyOffset(anchorClose, medianRound.offsetPct);

  // ---------- 提交一日状态（中位轮）：情绪/记忆（结算前口径）→ 仓位结算 ----------
  // F16/F24：反馈必须基于结算前的仓位/成本（conf=5 清仓在结算后 deltaPct 恒 0，会被误记
  // 「持稳、盈亏 null」；加仓者情绪盈亏项会被新混合成本稀释），故先 applyFeedback 再
  // settlePositions（后者只覆写仓位/成本，保留情绪与记忆）。
  const contrib1 = new Map<string, number>();
  for (const p of pool) {
    contrib1.set(p.id, cardContributions(cards, p, day1Date, cfg, cfg.seed + 1));
  }
  const fedBack = applyFeedback(deps.states, medianRound.outputs, personaMap, {
    execPrice: anchorClose, marketRet: todayRet, day: anchorDate, cfg, eventContrib: contrib1,
    // P2 方向结算：bars 相邻收盘对现算（含锚定日对）；锚定日自身的判断待下一运行结算
    realizedRetByDay: realizedRetMapFromBars(bars),
  });
  const committed = settlePositions(fedBack, medianRound.outputs, anchorClose);

  // ---------- 第 2–5 日：K=1 递推（#36），working copy ----------
  const spreadPct = Math.max(0.002, (quantile(day1Close, 0.9) - quantile(day1Close, 0.1)) / 2 / anchorClose * 100);
  const days: DayPrediction[] = [];
  let workStates = new Map(committed);
  let workSnapshot: MarketSnapshot = deps.snapshot;
  let workClose = day1Center;
  let lastPredictedDate = day1Date;
  // 军团意见气候（P1）+ 资金镜像（P5）：锚定日中位轮口径（asOf=锚定日=该轮所见末根），随递推逐日滚动；
  // legionBullPct 保留为派生值（口径对齐 opinionClimate）
  const anchorClimate: LegionClimate = buildLegionClimate(anchorDate, medianRound.outputs, personaMap);
  const anchorMirror: LegionMirror = buildLegionMirror(medianRound.outputs, deps.states, personaMap, cfg);
  let lastClimate: LegionClimate = anchorClimate;
  let lastMirror: LegionMirror = anchorMirror;
  let lastBullPct = lastClimate.overall.bullPct;
  const pathOffsets: number[] = [medianRound.offsetPct];

  for (let d = 2; d <= 5; d += 1) {
    // 先把上一预测日的 bar 追加进历史（K 线块需要到 d-1 的数据）
    const prevBar = { date: lastPredictedDate, open: workClose, high: workClose, low: workClose, close: workClose, volume: 0 };
    const barsWithPrev = [...workSnapshot.bars, prevBar];
    const tradeDate = nextTradeDay(calendar, lastPredictedDate);
    workSnapshot = {
      ...workSnapshot,
      tradeDate,
      bars: barsWithPrev,
      volatility20: computeVol20(barsWithPrev),
      legionBullPct: lastBullPct, // #50 军团倾向回流（交易日级；派生口径=opinionClimate）
      legionClimate: lastClimate, // P1 意见气候回流（asOf=上一轮所见末根，结果子句随之现算）
      legionMirror: lastMirror, // P5 资金镜像回流（双轨行 + 集中度传闻）
      // 外生输入沿用锚定日（情绪/新闻/资金面冻结，#36 递推规则）
    };
    const r = await runRound({
      ports, cfg, personas: pool, states: workStates, snapshot: workSnapshot, round: d, seed: cfg.seed + d,
      // 递推日同样加同一机构常数（workSnapshot 经 spread 透传锚定日 inst，#60：不重算不衰减）
      instNF: institutionNetFlow(workSnapshot.inst, cfg).netFlow,
    });
    // 递推日为 K=1 单轮：该轮即当日，无分布可剔除，QuorumError 上抛按「全作废」处理（#54）
    for (const m of r.missing) missingAll.add(m);
    minParticipants = Math.min(minParticipants, r.participants);
    // 气候/镜像滚动（P1/P5）：该轮所见末根 = 当前 lastPredictedDate（更新前）
    lastClimate = buildLegionClimate(lastPredictedDate, r.outputs, personaMap);
    lastMirror = buildLegionMirror(r.outputs, workStates, personaMap, cfg);
    lastBullPct = lastClimate.overall.bullPct;
    const contrib = new Map<string, number>();
    for (const p of pool) contrib.set(p.id, cardContributions(cards, p, tradeDate, cfg, cfg.seed + d));
    // 同上（F16/F24）：情绪/记忆按结算前口径，先于仓位结算
    workStates = applyFeedback(workStates, r.outputs, personaMap, {
      execPrice: workClose, marketRet: r.offsetPct / 100, day: tradeDate, cfg, eventContrib: contrib,
      realizedRetByDay: realizedRetMapFromBars(barsWithPrev), // P2：含推演 bar 的相邻对
    });
    workStates = settlePositions(workStates, r.outputs, workClose);
    workClose = applyOffset(workClose, r.offsetPct);
    lastPredictedDate = tradeDate;
    pathOffsets.push(r.offsetPct);
    // 误差累积：带宽随 sqrt(天序) 扩大（#20/#36）
    const half = spreadPct * Math.sqrt(d);
    days.push({
      tradeDate,
      netFlowMedian: r.netFlow,
      direction: r.direction,
      offsetPct: r.offsetPct,
      closeEstimate: workClose,
      band: { p10: workClose * (1 - half / 100), p90: workClose * (1 + half / 100) },
    });
  }

  // 第 1 日条目（band 直接来自 K=5 分布，#18）
  days.unshift({
    tradeDate: day1Date,
    netFlowMedian: nfMedian,
    direction,
    offsetPct: medianRound.offsetPct,
    closeEstimate: day1Center,
    band: { p10: quantile(day1Close, 0.1), p90: quantile(day1Close, 0.9) },
  });

  // 终点分布：每个 day-1 轮的收盘 + 递推段中位偏移累计（#36 第 5 日终点分布）
  const restOffsetSum = pathOffsets.slice(1).reduce((s, x) => s + x, 0);
  const terminalDist = day1Close.map((c) => applyOffset(c, restOffsetSum));

  const { bullPct, bearPct } = bullBearSplit(medianRound.outputs, deps.states);
  const dispersion = dispersionOf(rounds);
  const narrow = isDispersionNarrow(rounds);

  // 代表性发言（#26）：最长 / 最激进 / 最反差
  const sorted = [...medianRound.outputs].sort((a, b) => b.reason.length - a.reason.length);
  const mostExtreme = [...medianRound.outputs].sort((a, b) =>
    Math.abs(b.targetPct - (deps.states.get(b.personaId)?.exposurePct ?? 0)) -
    Math.abs(a.targetPct - (deps.states.get(a.personaId)?.exposurePct ?? 0)));
  const contra = medianRound.outputs.find((o) => {
    const st = deps.states.get(o.personaId);
    const delta = o.targetPct - (st?.exposurePct ?? 0);
    return direction === 1 ? delta < 0 : delta > 0;
  });
  const quotes: { personaId: string; reason: string }[] = [];
  if (sorted[0]) quotes.push({ personaId: sorted[0].personaId, reason: sorted[0].reason });
  if (mostExtreme[0]) quotes.push({ personaId: mostExtreme[0].personaId, reason: mostExtreme[0].reason });
  if (contra) quotes.push({ personaId: contra.personaId, reason: contra.reason });

  const camps = buildCamps(medianRound.outputs, deps.states, personaMap, cfg);
  // 缺席口径（#54/F38）：全部轮次汇总（剔除轮数 + 去重缺席名单 + 最差一轮参战数）
  const participationParts: string[] = [];
  if (quorumTrimmed > 0) participationParts.push(`${quorumTrimmed} 轮低于法定人数未入分布`);
  if (missingAll.size > 0) {
    participationParts.push(`${[...missingAll].join('、')} 缺席（最少一轮 ${minParticipants}/${pool.length} 参战）`);
  }
  const participationNote = participationParts.length > 0
    ? `⚠ 部分 Agent 未参与（#54）：${participationParts.join('；')}`
    : null;
  const report = await generateReport(ports, {
    dayLabel: day1Date,
    camps,
    dispersionText: dispersionNote(dispersion, narrow),
    participationNote,
    topWhaleShare: topWeightShare(medianRound.outputs, personaMap, cfg, 5), // P5 资金镜像行
    multiBullPct: bullPct,
    degradedFlags: deps.snapshot.degraded.filter((f) => f.degraded).map((f) => `${f.source}（截至 ${f.asOf}）`),
    intradayNote,
    // 机构动向叙事行（#64）：零 LLM 模板拼装，随日报与兜底模板落档
    instLine: instNarrativeLine(deps.snapshot.inst),
  });

  return {
    result: {
      schemaVersion: 1,
      mode: 'prediction',
      index: cfg.index,
      anchorDate,
      runAt: ports.clock.now().toISOString(),
      intradayNote,
      days,
      terminal: { dist: terminalDist, median: median(terminalDist) },
      multiBullPct: bullPct,
      multiBearPct: bearPct,
      dispersionNarrow: narrow,
      coldStartNote: deps.coldStart ? '情绪上下文自首跑日起步（情绪/新闻榜为点态快照，无历史回补，#45）' : null,
      representativeQuotes: quotes,
      report,
      rounds,
      legionClimate: anchorClimate, // P1：供下一运行跨运行注入（旧记录缺字段 → null，自愈）
      legionMirror: anchorMirror, // P5：资金镜像跨运行注入（旧记录缺字段 → null，自愈）
      // 机构决策层（v1.4 #60/#61）：锚定日原始载荷落盘 + 命中口径断代（按当时 cfg 写入）
      inst: deps.snapshot.inst ?? null,
      flowScope: cfg.instLayer && cfg.instLayer.enabled ? 'retail+inst' : 'retail',
    },
    committedStates: committed,
  };
}

export { QuorumError };
