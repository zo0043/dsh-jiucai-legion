/**
 * Agent 并发编排器（需求 #54）：并发池、单 Agent 重试、部分失败口径、状态结算。
 * 依赖心理模块（info-set/prompts，由心理引擎工程师实现）。
 */
import type { HostPorts } from '../host/ports.js';
import type { AgentOutput, AgentState, EngineConfig, MarketSnapshot, Persona, RoundResult } from './types.js';
import { buildUserMessage } from './info-set.js';
import { parseAgentOutput } from './prompts.js';
import { hashSeed } from './persona-pool.js';
import { netFlowOfRound, totalWeight, directionOf, bullBearSplit } from './aggregate.js';
import { computeOffsetPct } from './impact.js';

export class QuorumError extends Error {
  constructor(public readonly participants: number, public readonly floor: number) {
    super(`本轮仅 ${participants}/${floor} 参战，低于法定下限，整轮作废`);
    this.name = 'QuorumError';
  }
}

/** 收集流式响应为完整文本 */
export async function collectStream(ports: HostPorts, req: Parameters<HostPorts['llm']['stream']>[0]): Promise<string> {
  let text = '';
  for await (const chunk of ports.llm.stream(req)) text += chunk;
  return text;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 单个 Agent 的单次尝试：构建信息集 → LLM → 严格解析 */
async function askAgent(
  ports: HostPorts,
  cfg: EngineConfig,
  persona: Persona,
  state: AgentState,
  snapshot: MarketSnapshot,
  roundSeed: number,
): Promise<AgentOutput> {
  const user = buildUserMessage({ snapshot, state, persona, seed: hashSeed(roundSeed, persona.id) });
  const raw = await collectStream(ports, {
    messages: [
      { role: 'system', content: persona.systemPrompt },
      { role: 'user', content: user },
    ],
    temperature: 1.0,
  });
  return parseAgentOutput(persona.id, raw);
}

/**
 * 跑一轮：30 Agent 并发采样（#54）。
 * 失败重试 cfg.agentRetries 次；重试后仍失败记 missing；
 * 参战人数 < cfg.quorumFloor → 抛 QuorumError（整轮作废）。
 */
export async function runRound(ctx: {
  ports: HostPorts;
  cfg: EngineConfig;
  personas: Persona[];
  states: Map<string, AgentState>;
  snapshot: MarketSnapshot;
  round: number;
  seed: number;
}): Promise<RoundResult> {
  const { ports, cfg, personas, states, snapshot, round, seed } = ctx;
  const outputs: AgentOutput[] = [];
  const missing: string[] = [];

  const tasks: (() => Promise<void>)[] = personas.map((persona) => async () => {
    const state = states.get(persona.id);
    if (!state) throw new Error(`缺少 Agent 状态：${persona.id}`);
    for (let attempt = 0; attempt <= cfg.agentRetries; attempt += 1) {
      try {
        const out = await askAgent(ports, cfg, persona, state, snapshot, hashSeed(seed, round, attempt));
        outputs.push(out);
        return;
      } catch {
        if (attempt < cfg.agentRetries) await sleep(500 * 2 ** attempt);
      }
    }
    missing.push(persona.id);
  });

  // 并发池：cfg.concurrency 路（#54 默认 6）
  let cursor = 0;
  const workers = Array.from({ length: Math.min(cfg.concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const i = cursor;
      cursor += 1;
      await tasks[i]!();
    }
  });
  await Promise.all(workers);

  const participants = outputs.length;
  if (participants < cfg.quorumFloor) throw new QuorumError(participants, cfg.quorumFloor);

  const nf = netFlowOfRound(outputs, states, new Map(personas.map((p) => [p.id, p])), cfg);
  const direction = directionOf(nf);
  const offsetPct = computeOffsetPct(nf, totalWeight(personas, cfg), snapshot.volatility20, cfg.impactK);
  return { round, outputs, missing, participants, netFlow: nf, direction, offsetPct };
}

/**
 * 一轮结束后的状态结算（#51 置信度调仓 + #49 成本锚）：
 * 实际仓位变动 = (目标 − 当前) × 置信度/5，按 execPrice 成交；
 * 加权平均更新成本价；减仓按卖出比例实现盈亏。
 */
export function settlePositions(
  states: Map<string, AgentState>,
  outputs: AgentOutput[],
  execPrice: number,
): Map<string, AgentState> {
  const next = new Map(states);
  for (const o of outputs) {
    const st = next.get(o.personaId);
    if (!st) continue;
    const deltaPct = (o.targetPct - st.exposurePct) * (o.confidence / 5);
    const newExposure = Math.min(100, Math.max(0, st.exposurePct + deltaPct));
    let costBasis = st.costBasis;
    let realizedPnlPct: number | null = null;
    if (deltaPct > 0) {
      // 买入：加权平均成本
      costBasis =
        costBasis === null
          ? execPrice
          : (costBasis * st.exposurePct + execPrice * deltaPct) / newExposure;
    } else if (deltaPct < 0 && costBasis !== null) {
      // 卖出：对卖出部分实现盈亏
      realizedPnlPct = ((execPrice - costBasis) / costBasis) * 100;
      if (newExposure <= 0) costBasis = null;
    }
    next.set(o.personaId, { ...st, exposurePct: newExposure, costBasis });
  }
  return next;
}

export { bullBearSplit };
