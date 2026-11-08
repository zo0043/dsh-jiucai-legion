/**
 * 韭菜军团 — Agent 记忆环形缓冲与盈亏统计（需求 #15/#52；P2 方向结算）。
 *
 * - 记忆三保险之一：条数上限（#15），FIFO 丢弃最老，杜绝上下文无限膨胀；
 * - 盈亏统计行（#52 风格漂移的驱动素材）：「近 N 次判断错了 M 次」自动注入
 *   记忆摘要，让 LLM 自己演出动摇/膨胀，不硬编码漂移事件（#52）；
 * - 方向结算行与置信度校准行（P2）：按判断方向 × 次一交易日涨跌逐日结算，
 *   纪律止损豁免（#49），纯加仓者记忆也能结算。
 * 全部为纯函数：pushMemory 返回新 AgentState，不原地修改。
 */
import type { AgentState, MemoryItem } from './types.js';

/** 记忆条数上限（#15） */
export const MEMORY_LIMIT = 20;

/** 盈亏百分比显示：带符号、保留 1 位小数（如 +1.2 / -0.8） */
function fmtSignedPct(v: number): string {
  const r = Number(Math.abs(v).toFixed(1));
  if (v > 0) return `+${r}%`;
  if (v < 0) return `-${r}%`;
  return '0%';
}

/**
 * 追加一条记忆（#15）：上限 MEMORY_LIMIT=20，超出 FIFO 丢弃最老。
 * 返回新对象（不原地改 state/memory）。
 */
export function pushMemory(state: AgentState, item: MemoryItem): AgentState {
  const memory = [...state.memory, item];
  if (memory.length > MEMORY_LIMIT) {
    memory.splice(0, memory.length - MEMORY_LIMIT);
  }
  return { ...state, memory };
}

/**
 * 盈亏统计行（#52）：「近 N 次判断错了 M 次」。
 * - 只有 realizedPnlPct 非空的记录算一次「判断」（未结算的不计）；
 * - 「错」= 该次方向亏损（realizedPnlPct < 0；平盘 0 不算错）；
 * - 没有任何已结算判断时返回空串（调用方直接省略该行）。
 * 注意（P2）：本行盈亏口径逐字保留；方向结算另见 directionStatsLine（两行并存）。
 */
export function pnlStatsLine(memory: MemoryItem[]): string {
  const judged = memory.filter((m) => m.realizedPnlPct !== null);
  if (judged.length === 0) return '';
  const wrong = judged.filter((m) => (m.realizedPnlPct ?? 0) < 0).length;
  return `近 ${judged.length} 次判断错了 ${wrong} 次`;
}

/**
 * 方向统计行（P2 方向结算）：「近 N 次方向判断对了 K 次（其中按纪律止损 X 次，不算错）」。
 * - N = 已结算方向判断数（judgmentRet 非空且 intendedDir ≠ 0；持稳不判方向，不进统计）；
 * - 「错」= judgmentRet < 0 且非纪律止损——stopLoss=true 的游资纪律止损豁免，
 *   散户恐慌割肉照常计「错」（保护 #49 行为反差）；
 * - X = 其中按纪律止损的次数（为 0 时省略括注）；
 * - 没有已结算方向判断 → 空串（调用方省略该行）；旧记忆无 judgmentRet → 不计。
 * 修复点：纯加仓者 realizedPnlPct 恒为 null（#52 盈亏口径永不结算），方向口径
 * 让其记忆照常结算；纪律止损不再被 #49 情绪引擎注入口径持续记「错」。
 */
export function directionStatsLine(memory: MemoryItem[]): string {
  const judged = memory.filter((m) => (m.judgmentRet ?? null) !== null && (m.intendedDir ?? 0) !== 0);
  if (judged.length === 0) return '';
  const wrong = judged.filter((m) => (m.judgmentRet ?? 0) < 0 && m.stopLoss !== true).length;
  const stops = judged.filter((m) => m.stopLoss === true).length;
  const right = judged.length - wrong;
  return stops > 0
    ? `近 ${judged.length} 次方向判断对了 ${right} 次（其中按纪律止损 ${stops} 次，不算错）`
    : `近 ${judged.length} 次方向判断对了 ${right} 次`;
}

/**
 * 置信度校准行（P2）：高信心（4–5）vs 低信心（1–3）的方向命中率。
 * - 命中 = judgmentRet > 0（判断方向与随后走势同向）；judgmentRet = 0（平盘）两侧都不计入；
 * - 某侧无有效样本则省略该侧；两侧都无 → 空串（调用方省略该行）。
 */
export function calibrationLine(memory: MemoryItem[]): string {
  const settled = memory.filter((m) => (m.judgmentRet ?? null) !== null && m.intendedDir !== undefined);
  const bucket = (lo: number, hi: number): { hit: number; total: number } => {
    let hit = 0;
    let total = 0;
    for (const m of settled) {
      if (m.confidence < lo || m.confidence > hi) continue;
      const r = m.judgmentRet ?? 0;
      if (r === 0) continue; // 平盘不计入命中率分母
      total += 1;
      if (r > 0) hit += 1;
    }
    return { hit, total };
  };
  const high = bucket(4, 5);
  const low = bucket(1, 3);
  const parts: string[] = [];
  if (high.total > 0) parts.push(`信心 4–5 命中 ${high.hit}/${high.total}`);
  if (low.total > 0) parts.push(`信心 1–3 命中 ${low.hit}/${low.total}`);
  return parts.length > 0 ? `信心校准：${parts.join('，')}` : '';
}

/**
 * 记忆摘要文本块（#15/#52/P2）：盈亏统计行（#52 原行逐字保留）+ 方向结算行 +
 * 置信度校准行 + 最近 5 条操作记录，注入信息集个人块。
 * 记忆为空时返回「（你还没有任何操作记忆）」。
 */
export function buildMemoryPrompt(state: AgentState): string {
  if (state.memory.length === 0) return '（你还没有任何操作记忆）';
  const lines: string[] = ['【操作记忆】'];
  const stats = pnlStatsLine(state.memory); // #52 原行（盈亏口径），逐字保留（P2）
  if (stats !== '') lines.push(stats);
  // P2 新增：方向结算行 + 置信度校准行（对 #52 只增不改）
  const direction = directionStatsLine(state.memory);
  if (direction !== '') lines.push(direction);
  const calibration = calibrationLine(state.memory);
  if (calibration !== '') lines.push(calibration);
  for (const m of state.memory.slice(-5)) {
    const result = m.realizedPnlPct === null ? '未结算' : `盈亏 ${fmtSignedPct(m.realizedPnlPct)}`;
    lines.push(`- ${m.day} ${m.action}（目标仓位 ${m.targetPct}%，信心 ${m.confidence}/5）${m.reason}；结果：${result}`);
  }
  return lines.join('\n');
}
