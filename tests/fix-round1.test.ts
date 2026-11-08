/**
 * 第 1 轮修复清单的目标回归测试：
 * F16/F24 反馈时序（结算前口径）、F5 对账 5 日累计口径、F28 法定人数轮剔除、
 * F31/F37 数据子进程崩溃重启与 pending 中断。
 */
import { describe, it, expect } from 'vitest';
import { applyFeedback } from '../src/engine/feedback.js';
import { settlePositions } from '../src/engine/orchestrator.js';
import { runPrediction, type PredictDeps } from '../src/engine/predict.js';
import { recordsFromPrediction } from '../src/engine/reconcile.js';
import { DataClient } from '../src/engine/data-client.js';
import { MockLlm, MockClock, MockUi } from '../src/host/mock-host.js';
import type { SubprocessHandle, SubprocessPort } from '../src/host/ports.js';
import type {
  AgentOutput, AgentState, Persona, PredictionResult,
} from '../src/engine/types.js';
import { DEFAULT_CONFIG } from '../src/engine/types.js';

// ---------- fixture ----------

function mkPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p01', name: '测试哥', style: 'trend', capitalTier: 2, stability: 1,
    stance: 'range', biases: [], maxLossPct: null, baseline: 50, systemPrompt: '',
    ...overrides,
  };
}

function mkState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    personaId: 'p01', cash: 1_000_000, exposurePct: 0, costBasis: null, emotion: 50, memory: [],
    ...overrides,
  };
}

function mkResult(offsets: number[]): PredictionResult {
  let close = 3000;
  return {
    schemaVersion: 1, mode: 'prediction', index: 'SH000001', anchorDate: '2026-11-06',
    runAt: '2026-11-06T16:00:00Z', intradayNote: null,
    days: offsets.map((o, i) => {
      close = close * (1 + o / 100);
      return {
        tradeDate: `2026-11-${10 + i}`, netFlowMedian: 1, direction: 1 as const,
        offsetPct: o, closeEstimate: close, band: { p10: 2950, p90: 3050 },
      };
    }),
    terminal: { dist: [3000], median: 3000 }, multiBullPct: 0.6, multiBearPct: 0.2,
    dispersionNarrow: false, coldStartNote: null, representativeQuotes: [],
    report: { markdown: '', camps: [], dispersionNote: '', participationNote: null },
    rounds: [],
  };
}

// ---------- F16/F24：反馈时序（先情绪/记忆（结算前口径）→ 后仓位结算） ----------

describe('F16/F24 反馈时序', () => {
  it('conf=5 清仓：记忆记「减仓 + 已实现盈亏」，仓位照常结算为空仓', () => {
    const persona = mkPersona();
    const states = new Map([['p01', mkState({ exposurePct: 100, costBasis: 100 })]]);
    const outputs: AgentOutput[] = [{ personaId: 'p01', targetPct: 0, confidence: 5, reason: '清仓离场' }];
    const fed = applyFeedback(states, outputs, new Map([['p01', persona]]), {
      execPrice: 103.33, marketRet: 0, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: new Map(), // P2：本用例不结算方向（空表 → 全部保持未结算）
    });
    const committed = settlePositions(fed, outputs, 103.33);
    const st = committed.get('p01')!;
    expect(st.exposurePct).toBe(0);
    expect(st.costBasis).toBeNull();
    expect(st.memory).toHaveLength(1);
    expect(st.memory[0]!.action).toBe('减仓');
    expect(st.memory[0]!.realizedPnlPct).toBeCloseTo(3.33, 2);
  });

  it('加仓者情绪基于结算前成本（50→100 @103 → 情绪 68），成本照常加权为 101.5', () => {
    const persona = mkPersona();
    const states = new Map([['p01', mkState({ exposurePct: 50, costBasis: 100 })]]);
    const outputs: AgentOutput[] = [{ personaId: 'p01', targetPct: 100, confidence: 5, reason: '梭哈' }];
    const fed = applyFeedback(states, outputs, new Map([['p01', persona]]), {
      execPrice: 103, marketRet: 0, day: '2026-11-06', cfg: { ...DEFAULT_CONFIG }, eventContrib: new Map(),
      realizedRetByDay: new Map(), // P2：本用例不结算方向（空表 → 全部保持未结算）
    });
    const committed = settlePositions(fed, outputs, 103);
    const st = committed.get('p01')!;
    // 结算前口径：(103-100)/100×100 = 3 → clamp(3)×pnlWeight6×stability1 = 18；
    // P3 公式：prev=baseline=50 → λ 项为 0，正向 shock 不放大 → 50 + 0.4×18 = 57.2
    expect(st.emotion).toBeCloseTo(57.2, 6);
    expect(st.exposurePct).toBe(100);
    expect(st.costBasis).toBeCloseTo(101.5, 6);
    expect(st.memory[0]!.action).toBe('加仓');
    expect(st.memory[0]!.realizedPnlPct).toBeNull();
  });
});

// ---------- F5：5 日对账累计口径 ----------

describe('F5 对账 5 日累计口径', () => {
  it('predictedMedianPct = 累计复利偏移，方向取累计符号（≠第 5 日单日偏移）', () => {
    const offsets = [1, 2, -1, 0.5, 1];
    const recs = recordsFromPrediction(mkResult(offsets));
    expect(recs).toHaveLength(2);
    const d5 = recs.find((r) => r.horizon === '5d')!;
    const cumFactor = offsets.reduce((f, o) => f * (1 + o / 100), 1);
    expect(d5.predictedMedianPct).toBeCloseTo((cumFactor - 1) * 100, 6);
    expect(d5.predictedMedianPct).toBeCloseTo(3.52474649, 6);
    expect(d5.predictedDirection).toBe(1);
    const d1 = recs.find((r) => r.horizon === '1d')!;
    expect(d1.predictedMedianPct).toBeCloseTo(1, 6); // 1d 仍为单日口径
  });

  it('累计下跌 → 5d 方向 -1', () => {
    const recs = recordsFromPrediction(mkResult([-1, -1, -1, -1, -1]));
    const d5 = recs.find((r) => r.horizon === '5d')!;
    expect(d5.predictedDirection).toBe(-1);
    expect(d5.predictedMedianPct).toBeCloseTo((0.99 ** 5 - 1) * 100, 6);
  });
});

// ---------- F28：单轮低于法定人数 → 剔除该轮，不整场作废 ----------

function mkPorts(llm: MockLlm) {
  return {
    llm,
    proc: { spawn: (): SubprocessHandle => { throw new Error('测试不触达子进程'); } },
    ui: new MockUi(),
    clock: new MockClock(new Date('2026-11-06T16:00:00+08:00')),
  };
}

describe('F28 法定人数轮剔除', () => {
  it('第 1 轮全体失败（QuorumError）→ 从分布剔除，其余 4 轮照常出结果并标注', async () => {
    const llm = new MockLlm();
    let calls = 0;
    llm.setFallback(() => {
      calls += 1;
      if (calls <= 30) throw new Error('模拟第 1 轮全体失败'); // 30 人 × 1 次尝试（agentRetries=0）
      return '{"target_position_pct":50,"confidence":3,"reason":"正常输出"}';
    });
    const cfg = { ...DEFAULT_CONFIG, quorumFloor: 24, agentRetries: 0 };
    const pool = Array.from({ length: 30 }, (_, i) => mkPersona({ id: `p${String(i + 1).padStart(2, '0')}` }));
    const states = new Map(pool.map((p) => [p.id, mkState({ personaId: p.id })]));
    const deps: PredictDeps = {
      ports: mkPorts(llm), cfg, calendar: ['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'],
      snapshot: {
        index: 'SH000001', tradeDate: '2026-11-06',
        bars: [
          { date: '2026-11-05', open: 2990, high: 3000, low: 2980, close: 2995, volume: 1e8 },
          { date: '2026-11-06', open: 2995, high: 3010, low: 2990, close: 3000, volume: 1.1e8 },
        ],
        breadth: { limitUp: 45, limitDown: 8, failedBoard: 12, maxStreak: 5, advancers: 2800, decliners: 2100 },
        sentiment: { source: 'xueqiu', heatIndex: 60, asOf: '2026-11-06' },
        news: { items: [], asOf: '2026-11-06' },
        funds: { marginBalance: null, northboundNet: null, asOf: '2026-11-06' },
        volatility20: 0.18, legionBullPct: null, degraded: [],
      },
      stale: false, pool, states, cards: [], coldStart: false,
    };
    const { result } = await runPrediction(deps);
    expect(result.rounds).toHaveLength(4); // 第 1 轮被剔除
    expect(result.rounds[0]!.round).toBe(2);
    expect(result.report.participationNote).toContain('低于法定人数');
    expect(result.days).toHaveLength(5); // 路径完整
  });
});

// ---------- F31/F37：数据子进程崩溃重启 ----------

/** 测试替身：第 1 代进程应答一次后立即崩溃（crashWithoutReply=true 时不应答直接崩）；第 2 代起正常服务 */
class CrashingProcPort implements SubprocessPort {
  launched = 0;
  constructor(private crashWithoutReply: boolean) {}
  spawn(): SubprocessHandle {
    this.launched += 1;
    const gen = this.launched;
    const crashWithoutReply = this.crashWithoutReply;
    const buffer: string[] = [];
    const waiters: ((v: IteratorResult<string>) => void)[] = [];
    let closed = false;
    let replied = 0;
    const flush = (): void => {
      while (waiters.length > 0 && (buffer.length > 0 || closed)) {
        const w = waiters.shift()!;
        w(buffer.length > 0 ? { value: buffer.shift()!, done: false } : { value: undefined, done: true });
      }
    };
    const push = (line: string): void => { buffer.push(line); flush(); };
    const close = (): void => { closed = true; flush(); };
    const reply = (line: string): void => {
      const req = JSON.parse(line) as { id: number };
      push(`${JSON.stringify({ id: req.id, ok: true, data: { pong: true }, asOf: null, degraded: [], error: null })}\n`);
    };
    return {
      stdin: {
        write(line: string): void {
          if (gen === 1) {
            if (replied === 0 && !crashWithoutReply) {
              replied += 1;
              reply(line);
              setTimeout(close, 0); // 应答一次后崩溃
            } else {
              close(); // 不应答直接崩溃
            }
          } else {
            reply(line);
          }
        },
        end(): void { /* no-op */ },
      },
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<string>> {
              const b = buffer.shift();
              if (b !== undefined) return Promise.resolve({ value: b, done: false });
              if (closed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      },
      stderr: (async function* (): AsyncIterable<string> {})(),
      exitCode: null,
      kill(): void { /* no-op */ },
    };
  }
}

describe('F31/F37 数据子进程崩溃重启', () => {
  it('崩溃后重启：新句柄有活跃消费者，后续请求不再挂死', async () => {
    const port = new CrashingProcPort(false);
    const client = new DataClient(port, { pythonBin: 'python3', cwd: '.', dataDir: '.' });
    const r1 = await client.request('ping');
    expect(r1.ok).toBe(true);
    const r2 = await client.request('ping');
    expect(r2.ok).toBe(true);
    expect(port.launched).toBe(2);
    client.close();
  });

  it('无响应崩溃：pending 立即中断并自动重启重试成功（不等满超时）', async () => {
    const port = new CrashingProcPort(true);
    const client = new DataClient(port, { pythonBin: 'python3', cwd: '.', dataDir: '.' });
    const r = await client.request('ping');
    expect(r.ok).toBe(true);
    expect(port.launched).toBe(2);
    client.close();
  });
});

// ---------- F39：引擎入口日期格式校验（双保险） ----------

/** 按行协议应答的服务替身：getDailyBars 返回带非法日期（且含 HTML 片段）的 bar */
class BadDateProcPort implements SubprocessPort {
  spawn(): SubprocessHandle {
    const buffer: string[] = [];
    const waiters: ((v: IteratorResult<string>) => void)[] = [];
    const flush = (): void => {
      while (waiters.length > 0 && buffer.length > 0) {
        waiters.shift()!({ value: buffer.shift()!, done: false });
      }
    };
    return {
      stdin: {
        write(line: string): void {
          const req = JSON.parse(line) as { id: number };
          buffer.push(`${JSON.stringify({
            id: req.id, ok: true,
            data: { bars: [{ date: '2026/10/25<img>', open: 1, high: 1, low: 1, close: 1, volume: 1 }], stale: false },
            asOf: null, degraded: [], error: null,
          })}\n`);
          flush();
        },
        end(): void { /* no-op */ },
      },
      stdout: {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<string>> {
              const b = buffer.shift();
              if (b !== undefined) return Promise.resolve({ value: b, done: false });
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      },
      stderr: (async function* (): AsyncIterable<string> {})(),
      exitCode: null,
      kill(): void { /* no-op */ },
    };
  }
}

describe('F39 引擎入口日期校验', () => {
  it('getDailyBars 返回非法 bar 日期 → DataProcessError 硬失败（不透传进渲染层）', async () => {
    const client = new DataClient(new BadDateProcPort(), { pythonBin: 'python3', cwd: '.', dataDir: '.' });
    await expect(client.getDailyBars('SH000001', 250)).rejects.toThrow('非法 bar 日期');
    client.close();
  });
});
