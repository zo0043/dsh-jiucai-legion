/**
 * Python 数据子进程客户端（需求 #6）：行式 JSON 协议、崩溃重启、超时。
 * 端口实现来自 host/ports.SubprocessPort（DSH ctx.subprocess 适配 / Node child_process / mock）。
 */
import type { SubprocessHandle, SubprocessPort } from '../host/ports.js';
import type { Bar, MarketSnapshot } from './types.js';

export interface SubResponse<T = unknown> {
  id: number;
  ok: boolean;
  data: T;
  asOf: string | null;
  /** 行情类 op 的响应级新鲜度标志（Python 协议：stale 为 data 的兄弟键） */
  stale?: boolean;
  degraded: { source: string; asOf: string; degraded: boolean; note?: string }[];
  error: string | null;
}

export interface SnapshotResponse {
  snapshot: MarketSnapshot;
  stale: boolean;
}

export class DataProcessError extends Error {
  constructor(message: string) { super(message); this.name = 'DataProcessError'; }
}

/** 日期格式白名单（F39 双保险）：上游日期字段必须为 YYYY-MM-DD，防止透传进 HTML/SVG 命名空间 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidBarDates(bars: Bar[], where: string): void {
  for (const b of bars) {
    if (!DATE_RE.test(b.date)) {
      throw new DataProcessError(`${where} 返回非法 bar 日期 ${JSON.stringify(b.date)}（期望 YYYY-MM-DD），已按硬失败处理（#24）`);
    }
  }
}

export class DataClient {
  private handle: SubprocessHandle | null = null;
  /** 当前持有活跃消费者的句柄（消费者与句柄绑定，F31/F37）；null = 无活跃消费者 */
  private consuming: SubprocessHandle | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: SubResponse) => void; reject: (e: Error) => void }>();
  private buffer = '';
  /** 无法解析的响应行计数（F33 观测性：静默丢弃前先计数，供诊断协议污染） */
  parseFailures = 0;

  constructor(
    private proc: SubprocessPort,
    private opts: { pythonBin: string; cwd: string; dataDir: string; startTimeoutMs?: number },
  ) {}

  /** 拉起子进程（幂等）：python -m djiucai_data，cwd 指向 python/ 包，缓存目录经环境变量传递 */
  async start(): Promise<void> {
    if (this.handle && this.handle.exitCode === null && this.consuming === this.handle) return;
    // 旧消费者已终止（进程退出/流结束）→ 终止旧句柄再重启，避免句柄泄漏（F31）
    if (this.handle && this.consuming !== this.handle) {
      try { this.handle.kill(); } catch { /* 已退出 */ }
    }
    this.handle = this.proc.spawn(this.opts.pythonBin, ['-m', 'djiucai_data'], {
      cwd: this.opts.cwd,
      env: { DJIUCAI_DATA_DIR: this.opts.dataDir },
    });
    this.buffer = '';
    // 无条件为新句柄启动消费者；旧迭代若仍存活，会因句柄不匹配自行退出（F31/F37）
    void this.consumeLoop(this.handle);
  }

  /** 消费循环绑定到具体句柄 h：重启产生新句柄后，旧迭代不会阻塞新应答的消费 */
  private async consumeLoop(h: SubprocessHandle): Promise<void> {
    this.consuming = h;
    try {
      for await (const chunk of h.stdout) {
        if (this.consuming !== h) return; // 已被新句柄的消费者取代，旧迭代立即终止
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line.length === 0) continue;
          this.dispatch(line);
        }
      }
    } catch {
      // stdout 读失败（进程崩溃）：与流结束同等处理，走 finally 清理
    } finally {
      if (this.consuming === h) this.consuming = null;
      // 进程退出/流中断：reject 全部 pending，请求方立即进入重启重试，而非等满超时（F37）
      this.rejectAllPending(new DataProcessError('数据子进程已退出，未完成请求全部中断'));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(err);
    }
  }

  private dispatch(line: string): void {
    let msg: { id?: number; ok?: boolean; ready?: boolean; error?: string };
    try { msg = JSON.parse(line); } catch { this.parseFailures += 1; return; }
    if (msg.ready !== undefined) return; // 启动握手
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    p.resolve(msg as SubResponse);
  }

  /** 发送请求；进程崩溃时自动重启并重试一次（#42 崩溃恢复） */
  async request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 120_000): Promise<SubResponse<T>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.start();
      const h = this.handle;
      if (!h) throw new DataProcessError('子进程句柄缺失');
      const id = this.nextId++;
      const p = new Promise<SubResponse>((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        setTimeout(() => {
          if (this.pending.has(id)) {
            this.pending.delete(id);
            reject(new DataProcessError(`请求 ${op} 超时（${timeoutMs}ms）`));
          }
        }, timeoutMs);
      });
      try {
        h.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      } catch {
        // 写入失败（进程已死）→ 走重启重试
      }
      try {
        return (await p) as SubResponse<T>;
      } catch (e) {
        if (attempt === 1) throw e;
        // 崩溃/超时 → 重启重试
        this.handle?.kill();
        this.handle = null;
      }
    }
    throw new DataProcessError('unreachable');
  }

  async ping(): Promise<boolean> {
    const r = await this.request('ping', {}, 10_000);
    return r.ok;
  }

  async getCalendar(): Promise<string[]> {
    const r = await this.request<{ days?: string[]; dates?: string[] }>('getCalendar');
    if (!r.ok) throw new DataProcessError(r.error ?? 'getCalendar 失败');
    return r.data.days ?? r.data.dates ?? [];
  }

  async getDailyBars(index: string, days: number): Promise<{ bars: Bar[]; stale: boolean }> {
    const r = await this.request<{ bars: Bar[]; stale?: boolean }>('getDailyBars', { index, days });
    if (!r.ok) throw new DataProcessError(r.error ?? 'getDailyBars 失败');
    assertValidBarDates(r.data.bars ?? [], 'getDailyBars');
    // Python 协议：stale 在响应顶层（data 的兄弟键）；日历比对 isStale 仍是权威硬失败判定（#24）
    return { bars: r.data.bars, stale: r.stale === true || r.data.stale === true };
  }

  async getSnapshot(index: string, date?: string): Promise<SnapshotResponse> {
    // 全市场聚合慢（分钟级）且上游限流：超时放宽到 300s；同交易日快照走 Python 侧日缓存
    const r = await this.request<MarketSnapshot>('getSnapshot', { index, date }, 300_000);
    if (!r.ok) throw new DataProcessError(r.error ?? 'getSnapshot 失败');
    // 日期格式校验（F39 双保险）：tradeDate 与 bars[].date 必须为 YYYY-MM-DD
    if (typeof r.data.tradeDate !== 'string' || !DATE_RE.test(r.data.tradeDate)) {
      throw new DataProcessError(`getSnapshot 返回非法 tradeDate ${JSON.stringify(r.data.tradeDate)}（期望 YYYY-MM-DD），已按硬失败处理（#24）`);
    }
    assertValidBarDates(r.data.bars ?? [], 'getSnapshot');
    // Python 侧空降级时 degraded 可能为 null；TS 类型恒为数组。
    // stale 恒 false（F7：Python 侧 getSnapshot 不产出 stale）——新鲜度由调用方
    // isStale（日历+上海时钟+发布滞后宽限）权威判定，此处字段仅为接口形状兼容。
    return { snapshot: { ...r.data, degraded: r.data.degraded ?? [] }, stale: false };
  }

  close(): void {
    this.handle?.stdin.end();
    this.handle?.kill();
    this.handle = null;
  }
}
