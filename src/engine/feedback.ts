/**
 * 每日反馈回路（需求 #48 情绪更新 / #52 记忆注入 / #49 盈亏反哺 / P2 方向结算）。
 * 预测与沙盘两模式共用的「收盘结算 → 情绪 → 记忆」管线。
 */
import type { AgentOutput, AgentState, Bar, EngineConfig, Persona } from './types.js';
import { updateEmotion } from './emotion.js';
import { pushMemory } from './memory.js';

export interface FeedbackCtx {
  /** 本轮成交价（预测=锚定收盘；沙盘=当日推演收盘） */
  execPrice: number;
  /** 当日市场涨跌幅（小数，如 0.012 = +1.2%） */
  marketRet: number;
  /** 业务日（Asia/Shanghai，#38） */
  day: string;
  cfg: EngineConfig;
  /** 各 Agent 从事件卡获得的情绪贡献（#42，key=personaId） */
  eventContrib: Map<string, number>;
  /**
   * 方向结算用已实现收益表（P2）：key=判断日 D，value=D 之后第一个交易日相对 D 的涨跌（小数）。
   * 由调用方从 bars 相邻收盘对现算（realizedRetMapFromBars；预测模式含锚定日对），
   * 跳日补跑由需求文档 83 行技术默认「隔多日补跑时日线自动补齐」兜底。
   * 判断日不在表中（次日 bar 尚不可得）→ 该条保持未结算。
   */
  realizedRetByDay: Map<string, number>;
}

/**
 * 从 bars 相邻收盘对现算「D → D 之后第一个交易日」的已实现收益表（P2）。
 * key=前一根 bar 日期，value=相对该根收盘的涨跌（小数）；末根之后无 bar → 无对应键。
 * 日历断档时 bars 相邻两根即「D 之后第一个交易日」，天然对齐（不与 T+2 收益错配）。
 */
export function realizedRetMapFromBars(bars: Bar[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (prev.close > 0) map.set(prev.date, (cur.close - prev.close) / prev.close);
  }
  return map;
}

/**
 * 对一轮输出执行：情绪更新 → 记忆写入（基于**结算前**状态与结算前 delta，F16/F24）。
 * ⚠ 必须在 settlePositions **之前**调用：置信度=5 的调仓在结算后 deltaPct 恒为 0
 * （会被误记「持稳、盈亏 null」），加仓者的情绪盈亏项也会被新混合成本稀释。
 * 返回新状态表（不可变更新；仓位/成本由调用方随后经 settlePositions 覆写）。
 */
export function applyFeedback(
  states: Map<string, AgentState>,
  outputs: AgentOutput[],
  personas: Map<string, Persona>,
  ctx: FeedbackCtx,
): Map<string, AgentState> {
  const next = new Map(states);
  for (const o of outputs) {
    const st = next.get(o.personaId);
    const pe = personas.get(o.personaId);
    if (!st || !pe) continue;

    // 1) 浮动盈亏（相对本次成交价，#49 成本锚）
    const unrealizedPnlPct = st.costBasis !== null ? ((ctx.execPrice - st.costBasis) / st.costBasis) * 100 : 0;
    // 2) 减仓即实现盈亏（卖出部分，#49）
    const deltaPct = o.targetPct - st.exposurePct;
    const realizedPnlPct =
      deltaPct < 0 && st.costBasis !== null ? ((ctx.execPrice - st.costBasis) / st.costBasis) * 100 : null;
    // 2.5) 纪律止损判定（P2/#49）：仅游资纪律（maxLossPct 非空）触发的止损减仓豁免方向「错」，
    //      散户恐慌割肉照常计「错」（否则会摧毁 #49 要保护的行为反差）。
    //      口径选择：此处用「对成本的浮亏」（realizedPnlPct ≤ −maxLossPct，与既有记忆口径一致）；
    //      如需严格「单日亏损」口径可改用 ctx.marketRet ≤ −pe.maxLossPct。
    const stopLoss =
      pe.maxLossPct !== null && deltaPct < 0 && realizedPnlPct !== null && realizedPnlPct <= -pe.maxLossPct;
    // 判断方向（P2）：sign(targetPct−exposurePct)，|delta|≤1 记 0（持稳不判方向，与 action 阈值一致）
    const intendedDir: -1 | 0 | 1 = deltaPct > 1 ? 1 : deltaPct < -1 ? -1 : 0;
    // 3) 情绪更新（三源：事件卡 / 个人盈亏 / 大盘波动，#48）
    const emotion = updateEmotion(st.emotion, pe, {
      eventContrib: ctx.eventContrib.get(o.personaId) ?? 0,
      unrealizedPnlPct,
      marketRet: ctx.marketRet,
    }, ctx.cfg);
    // 4) 仓位结算（置信度调幅，#51）由调用方在本函数**之后**调用 orchestrator.settlePositions
    //    完成——本函数只更新情绪与记忆，且必须基于结算前口径（F16/F24 时序）。
    // 5) 记忆（上限 20，#15；含盈亏统计注入素材，#52；方向结算素材，P2）
    const item = {
      day: ctx.day,
      action: deltaPct > 1 ? '加仓' : deltaPct < -1 ? '减仓' : '持稳',
      targetPct: o.targetPct,
      confidence: o.confidence,
      realizedPnlPct,
      reason: o.reason,
      intendedDir,
      judgmentRet: null, // 待结算：判断日次一交易日 bar 可得后由下方结算遍历回填
      stopLoss,
    };
    next.set(o.personaId, pushMemory({ ...st, emotion }, item));
  }

  // ---------- 方向结算遍历（P2）：不依赖 outputs，覆盖全部 states（含当日缺员者） ----------
  // 对记忆中「判断日 D 的次一交易日收益已可得」的未结算条目回填
  // judgmentRet = intendedDir × realizedRetByDay.get(D) × 100；
  // 次日 bar 缺失（D 为末根或不在 bars）→ 保持未结算、不进统计。
  // 旧落盘记忆无 intendedDir（undefined）→ 不结算、不进方向统计（升级后新判断自愈）。
  for (const [personaId, st] of next) {
    let changed = false;
    const memory = st.memory.map((m) => {
      if ((m.judgmentRet ?? null) === null && m.intendedDir !== undefined) {
        const ret = ctx.realizedRetByDay.get(m.day);
        if (ret !== undefined) {
          changed = true;
          return { ...m, judgmentRet: m.intendedDir * ret * 100 };
        }
      }
      return m;
    });
    if (changed) next.set(personaId, { ...st, memory });
  }
  return next;
}
