/**
 * 命令实现层 —— CLI 与 DSH 插件共用的业务入口（#4 手动触发、#26 三命令面）。
 * 引擎与渲染严格分离：本层只产出 Markdown / 结果对象，输出交给 UiPort。
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { HostPorts } from './host/ports.js';
import { DataClient } from './engine/data-client.js';
import type { Store } from './persist/store.js';
import type { AgentState, EngineConfig, EventCard, MarketSnapshot, Persona } from './engine/types.js';
import { runPrediction } from './engine/predict.js';
import { runSandbox } from './engine/sandbox.js';
import { parseEventCard, recommendScripts } from './engine/event-card.js';
import { recordsFromPrediction, settleRecords, reconcileSummary, hitRateBanner } from './engine/reconcile.js';
import { expectedLatestCloseDate } from './engine/dates.js';
import { SETTING_FIELDS } from './config.js';

export interface RuntimeBundle {
  cfg: EngineConfig;
  ports: HostPorts;
  data: DataClient;
  store: Store;
  /** 测试注入：跳过真实子进程冷启动校验 */
  skipPing?: boolean;
  /** mock 运行（F21）：脚本化 LLM 产生的结果打标 mock=true，不计入命中率统计 */
  mock?: boolean;
}

export interface PoolBundle { personas: Persona[]; states: AgentState[] }

/** CLI 命令行输出的短免责（#28/F1：声明常驻所有输出路径） */
const DISCLAIMER_SHORT = '⚠️ 模拟沙盘，仅供娱乐与研究，不构成任何投资建议。';

/** 加载军团（冷启动守卫，#32） */
export async function loadPoolBundle(store: Store): Promise<{ personas: Persona[]; states: Map<string, AgentState> }> {
  const personas = await store.loadPool();
  const states = await store.loadAgentStates();
  if (!personas || !states) {
    throw new Error('军团尚未创建：先运行 init（冷启动向导第 1 步：组建人设池）');
  }
  return { personas, states: new Map(states.map((s) => [s.personaId, s])) };
}

/**
 * 行情不新鲜判定（#24 硬失败前置，#45 回补后）。
 * 基准 = 期望的最新已收盘交易日；考虑真实世界的数据发布滞后（收盘后当日 bar 可能尚未入库），
 * 允许锚定「期望日的上一个交易日」；落后两天以上才判不新鲜（硬失败）。
 */
export function isStale(bars: { date: string }[], calendar: string[], now: Date): boolean {
  const expected = expectedLatestCloseDate(calendar, now);
  if (!expected) return false;
  const past = calendar.filter((d) => d < expected);
  const allowed = past.length > 0 ? past[past.length - 1]! : expected; // 滞后宽限一日
  const last = bars[bars.length - 1];
  return last === undefined || last.date < allowed;
}

/** 冷启动：组建军团（人设池 + 状态落盘 + 数据子进程 ping），#32 第 1 步 */
export async function cmdInit(bundle: RuntimeBundle): Promise<string> {
  const { cfg, ports, data, store, skipPing } = bundle;
  const { createPool } = await import('./engine/persona-pool.js');
  const { personas } = createPool(cfg);
  const states: AgentState[] = personas.map((p) => ({
    personaId: p.id, cash: 1_000_000, exposurePct: 0, costBasis: null, emotion: p.baseline, memory: [],
  }));
  await store.saveConfig(cfg);
  await store.savePool(personas);
  await store.saveAgentStates(states);
  if (skipPing !== true) await data.ping();
  const lines = [
    `✅ 军团已组建：30 名 Agent（25 散户 + 5 游资），种子 ${cfg.seed}`,
    '—— 人设预览（向导第 2 步，#32）——',
    ...personas.map((p) => `  ${p.id} ${p.name}｜${p.style}｜资金档 ${p.capitalTier}｜立场 ${p.stance}｜稳定性 ${p.stability}${p.maxLossPct !== null ? `｜纪律 止损${p.maxLossPct}%` : ''}`),
    '接下来运行 predict 完成首跑预测（全量拉 250 日数据 + 情绪冷启动标注，#45）',
    DISCLAIMER_SHORT,
  ];
  const md = lines.join('\n');
  await ports.ui.renderMarkdown(md);
  return md;
}

/** 预测（#17/#18/#36/#46）：锚定最近收盘 → K=5 + 递推 → 落盘 + 对账记录 */
export async function cmdPredict(bundle: RuntimeBundle): Promise<{ markdown: string; result: import('./engine/types.js').PredictionResult }> {
  const { cfg, ports, data, store } = bundle;
  const { personas, states } = await loadPoolBundle(store);
  const calendar = await data.getCalendar();
  const { bars, stale } = await data.getDailyBars(cfg.index, cfg.historyDays);
  const snapRes = await data.getSnapshot(cfg.index);
  // 军团意见气候（P1）/资金镜像（P5）跨运行注入：取上一已结算轮（最近一次落盘预测）的结果。
  // 旧落盘记录无该字段 → null → 对应块省略，升级后首次运行自愈（#28 向后兼容）。
  const prevDates = await store.listPredictionDates();
  const prevLast = prevDates[prevDates.length - 1];
  const prevRun = prevLast !== undefined ? await store.loadPrediction(prevLast) : null;
  const prevClimate = prevRun?.legionClimate ?? null;
  const prevMirror = prevRun?.legionMirror ?? null;
  const snapshot: MarketSnapshot = { ...snapRes.snapshot, bars, legionClimate: prevClimate, legionMirror: prevMirror };
  const coldStart = prevDates.length === 0;
  const outcome = await runPrediction({
    // Python 侧 stale 为信息性标志；硬失败判定以 TS 侧 isStale（日历+上海时钟+发布滞后宽限）为权威（#24/#46）
    ports, cfg, calendar, snapshot, stale: isStale(bars, calendar, ports.clock.now()),
    pool: personas, states, cards: [], coldStart,
  });
  const result = outcome.result;
  if (bundle.mock === true) result.mock = true; // F21：mock 运行打标，对账与面板据此隔离
  await store.savePrediction(result.anchorDate, result);
  await store.saveAgentStates([...outcome.committedStates.values()]);
  await store.appendReconcile(recordsFromPrediction(result));
  const summary = [
    `📊 ${result.anchorDate} 锚定 → 次日 ${result.days[0]?.tradeDate} 收盘估计 ${result.days[0]?.closeEstimate.toFixed(2)}（方向 ${result.days[0]?.direction === 1 ? '看多' : result.days[0]?.direction === -1 ? '看空' : '持平'}）`,
    `📈 5 日路径：${result.days.map((d) => d.closeEstimate.toFixed(0)).join(' → ')}｜${result.report.participationNote ?? '30/30 参战'}`,
    `📐 冲击系数 k=${cfg.impactK}（一期未校准，#21；校准依赖二期对账数据积累）`,
    result.dispersionNarrow ? '⚠️ 分歧度过窄告警（#39）：K 轮方向完全一致' : '',
    result.coldStartNote ?? '',
  ].filter((s) => s.length > 0).join('\n');
  const md = `${result.report.markdown}\n\n${summary}`;
  await ports.ui.renderMarkdown(md);
  return { markdown: md, result };
}

/** 沙盘（#37/#38/#40/#41/#42） */
export async function cmdSandbox(
  bundle: RuntimeBundle,
  days: number,
  eventText: string | null,
): Promise<{ markdown: string; id: string; result: import('./engine/types.js').SandboxResult }> {
  const { cfg, ports, data, store } = bundle;
  const { personas, states } = await loadPoolBundle(store);
  const calendar = await data.getCalendar();
  const { bars } = await data.getDailyBars(cfg.index, cfg.historyDays);
  const snapRes = await data.getSnapshot(cfg.index);
  const snapshot: MarketSnapshot = { ...snapRes.snapshot, bars };
  const cards: EventCard[] = [];
  let prelude = '';
  if (eventText) {
    const card = await parseEventCard(ports, eventText, snapshot.tradeDate, cfg);
    cards.push(card);
    prelude = `🃏 事件卡：[${card.sectors.join('/')}] 方向 ${card.direction === 1 ? '利好' : '利空'} 强度 ${card.strength}/5，衰减 ${card.decayDays} 天`;
  } else {
    const recs = await recommendScripts(ports, snapshot);
    prelude = `💡 一键剧本推荐（#33）：\n${recs.map((s) => `   · ${s}`).join('\n')}`;
  }
  const outcome = await runSandbox({ ports, cfg, calendar, snapshot, pool: personas, states, cards, days, seed: cfg.seed });
  const result = outcome.result;
  if (bundle.mock === true) result.mock = true; // F21：mock 运行打标
  const id = `${result.startDate}-${days}d`;
  await store.saveSandbox(id, result);
  await store.saveAgentStates([...outcome.finalStates.values()]);
  const md = `${prelude}\n\n${result.report.markdown}\n\n🏜️ 沙盘 ${id}：${result.days.map((d) => d.close.toFixed(0)).join(' → ')}（K=${cfg.sandboxK}，#38；无阻尼线性外推，#40）`;
  await ports.ui.renderMarkdown(md);
  return { markdown: md, id, result };
}

/** 对账（#35/#44）；免责声明常驻（F1/#28） */
export async function cmdReconcile(bundle: RuntimeBundle): Promise<string> {
  const { cfg, data, store } = bundle;
  const { records, schemaVersion } = await store.loadReconcileRaw();
  const { bars } = await data.getDailyBars(cfg.index, cfg.historyDays);
  const barsMap = new Map(bars.map((b) => [b.date, b.close]));
  const days = [...barsMap.keys()].sort();
  const { settled, remaining } = settleRecords(records, barsMap, days, new Date().toISOString());
  const all = [...settled, ...remaining];
  const { writeJson } = await import('./persist/store.js');
  await writeJson(path.join(store.dataDir, 'reconcile.json'), {
    schemaVersion, savedAt: new Date().toISOString(), payload: all,
  });
  const summary = reconcileSummary(all);
  return [
    `1 日命中率：${hitRateBanner(summary.d1)}`,
    `5 日命中率：${hitRateBanner(summary.d5)}`,
    DISCLAIMER_SHORT,
  ].join('\n');
}

/** 最近日报重放（#29 安静日报）；html=true 时同时落盘静态 HTML（#8 Plan B） */
export async function cmdReport(bundle: RuntimeBundle, html = false): Promise<string> {
  const { store, ports } = bundle;
  const dates = await store.listPredictionDates();
  const last = dates[dates.length - 1];
  if (!last) throw new Error('还没有预测记录：先运行 predict');
  const result = await store.loadPrediction(last);
  if (!result) throw new Error(`记录 ${last} 损坏或 schema 版本过高`);
  await ports.ui.renderMarkdown(result.report.markdown);
  if (html) {
    const { wrapStandaloneHtml } = await import('./static-report.js');
    const file = path.join(store.dataDir, 'runs', 'prediction', `${last}.report.html`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wrapStandaloneHtml(`韭菜军团日报 ${last}`, result.report.markdown), 'utf8');
    return `${result.report.markdown}\n\n📄 静态日报已落盘：${file}`;
  }
  return result.report.markdown;
}

/** 一键重置（#15 第三道保险） */
export async function cmdReset(bundle: RuntimeBundle): Promise<string> {
  const { store } = bundle;
  const states = await store.loadAgentStates();
  const pool = await store.loadPool();
  if (!states || !pool) throw new Error('军团尚未创建：先运行 init');
  const reset = states.map((s) => {
    const p = pool.find((x) => x.id === s.personaId);
    return { ...s, exposurePct: 0, costBasis: null, emotion: p?.baseline ?? 50, memory: [] };
  });
  await store.saveAgentStates(reset);
  return '♻️ 已一键重置：仓位、成本、情绪、记忆全部归零（#15 第三道保险）\n' + DISCLAIMER_SHORT;
}

/** 军团名册（档案卡数据，#31） */
export async function cmdPersonas(bundle: RuntimeBundle): Promise<string> {
  const { store } = bundle;
  const pool = await store.loadPool();
  const states = await store.loadAgentStates();
  if (!pool || !states) throw new Error('军团尚未创建：先运行 init');
  const roster = pool.map((p) => {
    const s = states.find((x) => x.personaId === p.id);
    const win = s?.memory.filter((m) => (m.realizedPnlPct ?? 0) > 0).length ?? 0;
    return `${p.id} ${p.name}｜${p.style}｜仓位 ${s?.exposurePct.toFixed(0) ?? '?'}%｜情绪 ${s?.emotion.toFixed(0) ?? '?'}｜记忆 ${s?.memory.length ?? 0} 条｜盈利操作 ${win} 次`;
  }).join('\n');
  return `${roster}\n${DISCLAIMER_SHORT}`;
}

/** 设置清单（#26/#28） */
export function cmdSettings(): string {
  return ['设置项（Schemastery 同构）：',
    ...SETTING_FIELDS.map((f) => `  ${f.key}｜${f.label}｜默认 ${JSON.stringify(f.default)}${f.note ? `｜${f.note}` : ''}`),
    DISCLAIMER_SHORT,
  ].join('\n');
}

/** 数据目录确保存在 */
export function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
}
