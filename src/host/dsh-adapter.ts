/**
 * DSH 宿主适配层 —— 按真实 cordis 契约实现（2026-11-07 首日装载验证重写）。
 *
 * 真实宿主语义（与旧防御性探测版的核心差异，装载验证实测得出）：
 * 1. ctx 是惰性服务代理：**读取任何未声明 inject 的属性都会抛错**
 *    （"cannot get property X without inject"）——可选链探测在 cordis 里不成立；
 * 2. 插件通过导出函数的 `inject` 字段声明所需服务，声明后 ctx.<key> 才可读；
 * 3. 命令注册走 ctx.commands.register(CommandDefinition)（@deepseek-ai/dsh-commands），
 *    handler 返回 CommandResult = { kind: 'success', text? } | { kind: 'error', text }；
 * 4. LLM 走 ctx.llm.stream(GenerateOptions)（provider/model 路由 + RequestMessage[]）。
 *
 * 范围决策（首日版）：Python 数据子进程走 Node child_process（NodeSubprocessPort，
 * 与 ctx.subprocess.spawn(spec) 等价能力、零 spec 映射耦合）；DSH 命令面注册
 * 8 个命令；client bundle / settings 卡片留待下一迭代（Plan B #8 兜底）。
 */
import * as path from 'node:path';
import { NodeSubprocessPort } from './node-proc.js';
import { Store } from '../persist/store.js';
import { DataClient } from '../engine/data-client.js';
import { DEFAULT_CONFIG, type EngineConfig } from '../engine/types.js';
import {
  cmdInit, cmdPredict, cmdSandbox, cmdReconcile, cmdReport, cmdReset, cmdPersonas, cmdSettings,
  ensureDataDir, type RuntimeBundle,
} from '../commands-impl.js';

/** cordis 注入的宿主服务（只允许触碰这三个键——cordis 代理守卫） */
export interface InjectedServices {
  /** @deepseek-ai/dsh-llm：ctx.llm.stream(GenerateOptions) → AsyncIterable<StreamChunk> */
  llm: {
    stream(options: {
      provider: string;
      model: string;
      messages: { role: string; content: unknown }[];
    }): AsyncIterable<unknown>;
  };
  /** @deepseek-ai/dsh-subprocess（首日版未使用：Python 子进程走 NodeSubprocessPort，等价能力） */
  subprocess: unknown;
  /** @deepseek-ai/dsh-commands：ctx.commands.register(CommandDefinition) */
  commands: {
    register(definition: {
      name: string;
      description: string;
      handler: (invocation: { readonly rawInput: string }) =>
        Promise<{ kind: 'success' | 'error'; text: string }> | { kind: 'success' | 'error'; text: string };
    }): () => void;
  };
}

/** 把 DSH StreamChunk 防御性映射为文本片段（兜所有文本位；chunk 真实形状以官方 d.ts 为准） */
function chunkToText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk === null || chunk === undefined) return '';
  const c = chunk as { text?: unknown; delta?: unknown; content?: unknown };
  if (typeof c.text === 'string') return c.text;
  if (typeof c.delta === 'string') return c.delta;
  if (typeof c.content === 'string') return c.content;
  return '';
}

function adaptLlm(svc: InjectedServices['llm'], cfg: EngineConfig) {
  return {
    async *stream(req: { messages: { role: string; content: unknown }[] }): AsyncIterable<string> {
      const options = {
        provider: process.env['DJIUCAI_DSH_PROVIDER'] ?? 'deepseek-official',
        model: cfg.modelId ?? process.env['DJIUCAI_DSH_MODEL'] ?? 'deepseek-chat',
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      };
      for await (const chunk of svc.stream(options)) {
        const text = chunkToText(chunk);
        if (text) yield text;
      }
    },
  };
}

/** 组装插件运行时（注入服务 → 端口 → 引擎 bundle） */
export function buildRuntime(
  services: InjectedServices,
  opts?: { dataDir?: string },
): { bundle: RuntimeBundle; cfg: EngineConfig } {
  const cfg: EngineConfig = { ...DEFAULT_CONFIG };
  const dataDir = path.resolve(opts?.dataDir ?? process.env['DJIUCAI_DATA_DIR'] ?? cfg.dataDir);
  cfg.dataDir = dataDir;
  cfg.pythonBin = process.env['DJIUCAI_PYTHON'] ?? cfg.pythonBin;
  ensureDataDir(dataDir);
  const ports = {
    llm: adaptLlm(services.llm, cfg),
    proc: new NodeSubprocessPort(),
    ui: { async renderMarkdown() { /* 命令结果即输出通道（CommandResult.text） */ } },
    clock: {
      now: () => new Date(),
      shanghaiDate: (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10),
    },
  };
  const store = new Store(dataDir);
  const data = new DataClient(ports.proc, {
    pythonBin: cfg.pythonBin,
    cwd: path.join(process.cwd(), 'python'),
    dataDir,
  });
  return { cfg, bundle: { cfg, ports, store, data } };
}

export interface CommandReg {
  name: string;
  label: string;
  run: (bundle: RuntimeBundle) => Promise<string>;
}

/** 8 个斜杠命令的定义与执行体（#4 手动触发、#26 命令面）；沙盘默认 20 天（SANDBOX_DAYS） */
export const SANDBOX_DAYS = 20;

/** 面板服务器句柄与地址（菜单界面，随 DSH 常驻） */
let panelUrl: string | null = null;

/** 面板 URL（激活后可查；未就绪为 null） */
export function getPanelUrl(): string | null {
  return panelUrl;
}

/** 随宿主常驻拉起三视图菜单面板（用户要求：菜单界面优于命令行；失败不阻塞激活） */
async function startPanel(bundle: RuntimeBundle): Promise<void> {
  try {
    const { startPanelServer } = await import('../panel-server.js');
    const handle = await startPanelServer({ storeDir: bundle.store.dataDir, port: 3210 });
    panelUrl = `http://127.0.0.1:${handle.port}`;
    console.log(`[dsh-jiucai-legion] 菜单面板已就绪：${panelUrl}（预测/沙盘/军团档案卡三视图，只读 data/）`);
  } catch (e) {
    console.warn(`[dsh-jiucai-legion] 面板启动失败（不影响命令使用）：${(e as Error).message}`);
  }
}

export function commandList(bundle: RuntimeBundle, url: () => string | null): CommandReg[] {
  return [
    { name: 'jiucai-init', label: '组建军团', run: () => cmdInit(bundle) },
    { name: 'jiucai-predict', label: '今日预测', run: async () => (await cmdPredict(bundle)).markdown },
    { name: 'jiucai-sandbox', label: '沙盘推演', run: () => cmdSandbox(bundle, SANDBOX_DAYS, null).then((r) => r.markdown) },
    { name: 'jiucai-report', label: '最近日报', run: () => cmdReport(bundle) },
    { name: 'jiucai-reconcile', label: '历史对账', run: () => cmdReconcile(bundle) },
    { name: 'jiucai-reset', label: '一键重置', run: () => cmdReset(bundle) },
    { name: 'jiucai-personas', label: '军团名册', run: () => cmdPersonas(bundle) },
    { name: 'jiucai-settings', label: '设置说明', run: async () => cmdSettings() },
    { name: 'jiucai-panel', label: '菜单面板', run: async () =>
      panelUrl
        ? `🖥️ 菜单界面已就绪：${panelUrl}\n（预测/沙盘/军团档案卡三视图；面板随 DSH 常驻，浏览器直接打开即可）`
        : '面板尚未就绪：稍后再试 /jiucai-panel（启动失败时查看 DSH 日志）',
    },
  ];
}

/**
 * 插件激活（cordis 插件函数形式）：导出函数带 `inject` 字段声明 ['llm','subprocess','commands']，
 * 挂载时同步注册命令；handler 内部才做异步工作，异常收敛为 CommandResult.error
 * （#28 异常给人话，不崩宿主）。菜单面板随宿主常驻拉起（用户要求菜单管理而非命令行）。
 */
export function activatePlugin(services: InjectedServices): void {
  const { bundle, cfg } = buildRuntime(services);
  console.log(`[dsh-jiucai-legion] 已加载（index=${cfg.index}，数据目录 ${cfg.dataDir}）`);
  void startPanel(bundle); // 异步拉起面板，不阻塞命令注册
  let registered = 0;
  for (const cmd of commandList(bundle, () => panelUrl)) {
    try {
      services.commands.register({
        name: cmd.name,
        description: `韭菜军团 · ${cmd.label}`,
        handler: async () => {
          try {
            return { kind: 'success' as const, text: await cmd.run(bundle) };
          } catch (e) {
            return { kind: 'error' as const, text: `❌ ${cmd.label}失败：${(e as Error).message}\n\n⚠️ 模拟沙盘，不构成投资建议。` };
          }
        },
      });
      registered += 1;
    } catch (e) {
      console.warn(`[dsh-jiucai-legion] 命令 ${cmd.name} 注册失败：${(e as Error).message}`);
    }
  }
  console.log(`[dsh-jiucai-legion] 已注册 ${registered}/${commandList(bundle, () => panelUrl).length} 个命令（/jiucai-panel 打开菜单界面）；client bundle 原生嵌入 DSH 菜单见下一迭代`);
}
