/**
 * 宿主端口定义 —— 引擎核只依赖这些接口，不 import 任何 DSH 符号（需求 #6/#7/#8）。
 * DSH 适配见 dsh-adapter.ts（签名以《DSH API 调研备忘录》为准）；测试用 mock-host.ts。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
}

export interface LlmPort {
  /** 流式补全：增量返回文本片段（#7 ctx.llm.stream 适配目标） */
  stream(req: LlmRequest): AsyncIterable<string>;
}

export interface SubprocessHandle {
  stdin: { write(line: string): void; end(): void };
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  /** 退出码，未退出为 null */
  readonly exitCode: number | null;
  kill(): void;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
}

export interface SubprocessPort {
  spawn(cmd: string, args: string[], opts?: SpawnOpts): SubprocessHandle; // #6 ctx.subprocess 适配目标
}

export interface UiPort {
  /** Plan B 降级共用输出通道（#8）：DSH 斜杠命令输出 / mock 走 stdout */
  renderMarkdown(md: string): Promise<void>;
}

export interface ClockPort {
  now(): Date;
  /** 需求 #38：全部业务日期按 Asia/Shanghai 固定 */
  shanghaiDate(d?: Date): string;
}

export interface HostPorts {
  llm: LlmPort;
  proc: SubprocessPort;
  ui: UiPort;
  clock: ClockPort;
}
