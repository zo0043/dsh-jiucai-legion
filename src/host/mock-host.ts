/**
 * 测试替身（MockHost）：脚本化 LLM + 进程内数据子进程替身 + 固定时钟。
 * 全部引擎测试经此运行：零网络、零真实 LLM（docs/技术设计.md §10）。
 */
import type { HostPorts, LlmMessage, LlmPort, LlmRequest, SubprocessHandle, SubprocessPort, UiPort, ClockPort } from './ports.js';
import type { MarketSnapshot } from '../engine/types.js';

/** LLM 响应脚本：字符串（原样返回）或按请求内容动态生成 */
export type LlmScript = string | ((req: LlmRequest, callIndex: number) => string);

export class MockLlm implements LlmPort {
  public calls: { req: LlmRequest; response: string }[] = [];
  private queue: LlmScript[] = [];
  private fallback: ((req: LlmRequest, callIndex: number) => string) | null = null;

  /** 预设响应队列：按调用顺序弹出 */
  enqueue(...scripts: LlmScript[]): this {
    this.queue.push(...scripts);
    return this;
  }
  /** 队列耗尽后的兜底生成器 */
  setFallback(fn: (req: LlmRequest, callIndex: number) => string): this {
    this.fallback = fn;
    return this;
  }
  async *stream(req: LlmRequest): AsyncIterable<string> {
    const idx = this.calls.length;
    let response: string;
    const next = this.queue.shift();
    if (next !== undefined) {
      response = typeof next === 'string' ? next : next(req, idx);
    } else if (this.fallback) {
      response = this.fallback(req, idx);
    } else {
      throw new Error(`MockLlm: 第 ${idx + 1} 次调用无脚本且未设 fallback`);
    }
    this.calls.push({ req, response });
    // 模拟流式：按 24 字符切片
    for (let i = 0; i < response.length; i += 24) {
      yield response.slice(i, i + 24);
    }
  }
}

/** 把文本按行拆成 AsyncIterable */
function linesOf(text: string): AsyncIterable<string> {
  const lines = text.split('\n');
  return (async function* () { for (const l of lines) yield l; })();
}

export class MockSubprocess implements SubprocessPort {
  public launched = 0;
  constructor(private handler: (req: unknown) => unknown) {}
  spawn(_cmd: string, _args: string[], _opts?: { cwd?: string; env?: Record<string, string> }): SubprocessHandle {
    this.launched += 1;
    const self = this;
    let inputQueue: ((line: string) => void) | null = null;
    const handle: SubprocessHandle = {
      stdin: {
        write(line: string): void {
          // 进程内直调 handler，模拟行协议（响应必须带换行，与 Python 子进程一致）
          let req: unknown;
          try { req = JSON.parse(line); } catch { req = { id: -1, op: 'bad' }; }
          const res = self.handler(req);
          inputQueue?.(`${JSON.stringify(res)}\n`);
        },
        end(): void { /* no-op */ },
      },
      stdout: {
        [Symbol.asyncIterator]() {
          const buffer: string[] = [];
          const waiters: ((v: IteratorResult<string>) => void)[] = [];
          inputQueue = (line: string) => {
            const w = waiters.shift();
            if (w) w({ value: line, done: false });
            else buffer.push(line);
          };
          return {
            next(): Promise<IteratorResult<string>> {
              const b = buffer.shift();
              if (b !== undefined) return Promise.resolve({ value: b, done: false });
              return new Promise((resolve) => waiters.push(resolve));
            },
          };
        },
      },
      stderr: linesOf(''),
      exitCode: null,
      kill(): void { /* no-op */ },
    };
    return handle;
  }
}

/** 构造一个按行协议响应 fixture 快照的假子进程端口 */
export function fakeProcPort(snapshot: MarketSnapshot, calendar: string[] = []): MockSubprocess {
  return new MockSubprocess((req) => {
    const r = req as { id: number; op: string };
    switch (r.op) {
      case 'ping': return { id: r.id, ok: true, data: { ready: true }, asOf: null, degraded: [], error: null };
      case 'getCalendar': return { id: r.id, ok: true, data: { days: calendar }, asOf: null, degraded: [], error: null };
      case 'getDailyBars': return { id: r.id, ok: true, data: { bars: snapshot.bars, stale: false }, asOf: snapshot.tradeDate, degraded: [], error: null };
      case 'getSnapshot': return { id: r.id, ok: true, data: snapshot, asOf: snapshot.tradeDate, degraded: snapshot.degraded, error: null };
      default: return { id: r.id, ok: false, data: null, asOf: null, degraded: [], error: `unknown op ${r.op}` };
    }
  });
}

export class MockClock implements ClockPort {
  constructor(private fixed: Date = new Date('2026-11-06T16:00:00+08:00')) {}
  now(): Date { return this.fixed; }
  shanghaiDate(d: Date = this.fixed): string {
    // UTC+8 固定偏移取日期（#38 业务日期一律 Asia/Shanghai）
    const ms = d.getTime() + 8 * 3600 * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
}

export class MockUi implements UiPort {
  public outputs: string[] = [];
  async renderMarkdown(md: string): Promise<void> { this.outputs.push(md); }
}

export function mockHost(opts: {
  llm?: MockLlm;
  proc?: SubprocessPort;
  clock?: MockClock;
  ui?: MockUi;
}): HostPorts & { llm: MockLlm; clock: MockClock; ui: MockUi } {
  return {
    llm: opts.llm ?? new MockLlm(),
    proc: opts.proc ?? fakeProcPort({} as MarketSnapshot),
    clock: opts.clock ?? new MockClock(),
    ui: opts.ui ?? new MockUi(),
  };
}
