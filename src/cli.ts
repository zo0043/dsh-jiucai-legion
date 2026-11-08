#!/usr/bin/env node
/**
 * 独立运行器（开发/演示用）：npm run cli -- <命令>
 *   init | personas | predict | sandbox --days N [--event "…"] | report | reconcile | reset | settings
 * 业务实现在 commands-impl.ts（与 DSH 插件共用）；无 OPENAI_API_KEY 时用 --mock 脚本化 LLM。
 */
import * as path from 'node:path';
import { DEFAULT_CONFIG } from './engine/types.js';
import { NodeSubprocessPort } from './host/node-proc.js';
import { HttpLlm } from './host/llm-http.js';
import { MockLlm } from './host/mock-host.js';
import { Store } from './persist/store.js';
import { DataClient } from './engine/data-client.js';
import { startPanelServer } from './panel-server.js';
import {
  cmdInit, cmdPredict, cmdSandbox, cmdReconcile, cmdReport, cmdReset, cmdPersonas, cmdSettings,
  ensureDataDir, type RuntimeBundle,
} from './commands-impl.js';

function resolvePaths(cfg: typeof DEFAULT_CONFIG): { dataDir: string; pythonCwd: string; pythonBin: string } {
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  return {
    dataDir: path.resolve(process.env['DJIUCAI_DATA_DIR'] ?? cfg.dataDir),
    pythonCwd: path.join(repoRoot, 'python'),
    pythonBin: process.env['DJIUCAI_PYTHON'] ?? cfg.pythonBin,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';
  const mock = args.includes('--mock');
  const daysIdx = args.indexOf('--days');
  const days = daysIdx >= 0 ? Number(args[daysIdx + 1]) || 20 : 20;
  const eventIdx = args.indexOf('--event');
  const eventText = eventIdx >= 0 ? args[eventIdx + 1] ?? null : null;

  const store = new Store(path.resolve(process.env['DJIUCAI_DATA_DIR'] ?? DEFAULT_CONFIG.dataDir));
  const cfg = (await store.loadConfig()) ?? { ...DEFAULT_CONFIG, pythonBin: process.env['DJIUCAI_PYTHON'] ?? DEFAULT_CONFIG.pythonBin };
  const { dataDir, pythonCwd, pythonBin } = resolvePaths(cfg);
  cfg.dataDir = dataDir;
  ensureDataDir(dataDir);

  const llm = mock || !process.env['OPENAI_API_KEY'] ? new MockLlm() : new HttpLlm(cfg.modelId ?? 'deepseek-chat');
  if (llm instanceof MockLlm) {
    // 脚本模式：确定性多样输出（部分加仓/部分减仓/部分观望），演示完整数据流
    let i = 0;
    llm.setFallback(() => {
      i += 1;
      const target = (i * 37) % 101;
      const conf = (i % 5) + 1;
      return `{"target_position_pct":${target},"confidence":${conf},"reason":"脚本模式演示输出 ${i}"}`;
    });
  }

  const ports = {
    llm,
    proc: new NodeSubprocessPort(),
    ui: { async renderMarkdown(md: string) { process.stdout.write(`\n${md}\n`); } },
    clock: {
      now: () => new Date(),
      shanghaiDate: (d = new Date()) => new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10),
    },
  };

  const bundle: RuntimeBundle = {
    cfg,
    ports,
    store,
    data: new DataClient(ports.proc, { pythonBin, cwd: pythonCwd, dataDir }),
    mock: mock || !process.env['OPENAI_API_KEY'],
  };
  if (bundle.mock === true && (cmd === 'predict' || cmd === 'sandbox' || cmd === 'wizard')) {
    console.error('⚠ mock 模式（--mock 或未配置 OPENAI_API_KEY）：本次运行结果将标记 mock=true，不计入命中率统计（F21）');
  }

  try {
    switch (cmd) {
      case 'init': await cmdInit(bundle); break;
      case 'wizard': {
        // 冷启动三步向导（#32）：选指数 → 人设预览 → 首跑全量拉数据 + 首预测（进度流水）→ 第一份日报
        console.log('🧭 冷启动向导 · 第 1 步：标的指数 = ' + cfg.index + '（可用 settings 修改）');
        console.log('🧭 第 2 步：预览人设池');
        await cmdInit(bundle);
        console.log('🧭 第 3 步：首跑全量拉数据（250 交易日日线，#45）+ 首预测（进度流水）');
        const { markdown } = await cmdPredict(bundle);
        console.log('✅ 首跑完成，你的第一份日报：');
        console.log(markdown);
        break;
      }
      case 'personas': console.log(await cmdPersonas(bundle)); break;
      case 'predict': await cmdPredict(bundle); break;
      case 'sandbox': await cmdSandbox(bundle, days, eventText); break;
      case 'report': console.log(await cmdReport(bundle, args.includes('--html'))); break;
      case 'reconcile': console.log(await cmdReconcile(bundle)); break;
      case 'reset': console.log(await cmdReset(bundle)); break;
      case 'settings': console.log(cmdSettings()); break;
      case 'panel': {
        const h = await startPanelServer({ storeDir: dataDir, port: 3210 });
        console.log(`🖥️ 面板已启动：http://127.0.0.1:${h.port}（Ctrl+C 停止；只读 data/，引擎与渲染分离 #8）`);
        // 挂起进程直到外部中断
        await new Promise(() => {});
      } break;
      default:
        console.log([
          '韭菜军团 CLI（独立运行器，模拟沙盘非投资建议）',
          '  init            组建军团（人设池+状态落盘）',
          '  predict         跑一次预测（锚定最近收盘，5 日路径）',
          '  sandbox --days 20 --event "…"   沙盘推演（可附 what-if 事件）',
          '  report          输出最近一期日报',
          '  panel           启动本地面板（http://127.0.0.1:3210，Plan B 形态）',
          '  reconcile       对账结算 + 滚动命中率',
          '  personas        军团名册（档案卡数据）',
          '  reset           一键重置军团状态',
          '  settings        查看设置项',
          '  --mock          脚本化 LLM（无 API key 演示数据流）',
        ].join('\n'));
    }
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    bundle.data.close();
  }
}

void main();
