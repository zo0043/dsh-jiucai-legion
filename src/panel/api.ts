// 韭菜军团面板数据层（C4）：一律绝对 URL。
// 迁入 DSH origin(:3080) 后，static/panel.html:226-231 的相对 fetch 会打到 DSH
// 服务器（全 404）——所以这里固定指本机 panel-server（:3210，由插件 node 半
// dsh-adapter.ts:124-127 随 DSH 自启，固定端口）。
// panel-server 的 Host 校验只看 Host 头（src/panel-server.ts:62-67），跨源 GET 可过；
// 简单 GET 无自定义头，不触发 CORS 预检。
export const PANEL_API_BASE = 'http://127.0.0.1:3210';

/** 统一 GET：426=schema 版本过高（#28），其余非 2xx 抛错。 */
export async function api<T>(pathname: string): Promise<T> {
  const r = await fetch(PANEL_API_BASE + pathname);
  if (r.status === 426) throw new Error('结果 schema 版本高于面板，请升级（#28）');
  if (!r.ok) throw new Error(`加载失败 ${r.status}`);
  return (await r.json()) as T;
}

// ---------- 与 panel-server /api 契约对应的最小类型（引擎只读展示，#26） ----------

export interface RunsIndex { predictions: string[]; sandboxes: string[] }

export interface Persona {
  id: string; name: string; style: string; capitalTier: string;
  stance: string; stability: number; baseline: string;
  biases: string[]; maxLossPct: number | null;
}

export interface PredDay { tradeDate: string; closeEstimate: number; band: { p10: number; p90: number } }

export interface Prediction {
  anchorDate: string; mock?: boolean; days: PredDay[];
  terminal: { median: number; dist: number[] };
  multiBullPct: number; multiBearPct: number;
  representativeQuotes?: { personaId: string; reason: string }[];
  report: { markdown: string; participationNote?: string };
  dispersionNarrow?: boolean; intradayNote?: string; coldStartNote?: string;
}

export interface ReconcileRow {
  anchorDate: string; horizon: string; predictedDirection: number;
  actualPct: number | null; outcome: string | null;
}

export interface SbxDay {
  dayIndex: number; tradeDate: string; close: number; direction: number;
  legionBullPct: number; netFlow: number;
  activeEvents: { text: string; weight: number }[];
  round: { outputs: { personaId: string; targetPct: number; confidence: number; reason: string }[] };
}

export interface SandboxRun { days: SbxDay[]; report?: { markdown: string }; note?: string }

export interface AgentState {
  personaId: string; exposurePct: number; emotion: number; costBasis: number | null;
  memory: { day: string; action: string; targetPct: number; confidence: number; realizedPnlPct: number | null; reason: string }[];
}

export interface PanelConfig {
  sandboxK?: number; impactK?: number; index?: string; modelId?: string;
  hotMoneyAmp?: number; eventDecayDays?: number; seed?: number;
  emotion?: { eventWeight?: number; pnlWeight?: number; marketWeight?: number };
}
