/**
 * 持久化（需求 #8/#28）：版本化 JSON、原子写、读取端向前兼容。
 * data/ 目录布局见 docs/技术设计.md §7。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { SCHEMA_VERSION, type EngineConfig, type Persona, type AgentState, type PredictionResult, type SandboxResult, type ReconcileRecord } from '../engine/types.js';

export interface StoredEnvelope<T> {
  schemaVersion: number;
  savedAt: string;
  payload: T;
}

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

/** 原子写：临时文件 + rename */
export async function writeJson(file: string, payload: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class Store {
  constructor(public readonly dataDir: string) {}

  private envelope<T>(payload: T): StoredEnvelope<T> {
    return { schemaVersion: SCHEMA_VERSION, savedAt: new Date().toISOString(), payload };
  }

  /** 读取端兼容：schemaVersion ≤ 当前版本均可读（#28 向后兼容） */
  private unwrap<T>(env: StoredEnvelope<T> | null): T | null {
    if (!env || typeof env.schemaVersion !== 'number' || env.schemaVersion > SCHEMA_VERSION) return null;
    return env.payload;
  }

  // ---------- 配置 ----------
  configPath(): string { return path.join(this.dataDir, 'config.json'); }
  async saveConfig(cfg: EngineConfig): Promise<void> { await writeJson(this.configPath(), this.envelope(cfg)); }
  async loadConfig(): Promise<EngineConfig | null> { return this.unwrap(await readJson(this.configPath())); }

  // ---------- 人设池 ----------
  private poolPath(): string { return path.join(this.dataDir, 'pool.json'); }
  async savePool(personas: Persona[]): Promise<void> { await writeJson(this.poolPath(), this.envelope(personas)); }
  async loadPool(): Promise<Persona[] | null> { return this.unwrap(await readJson(this.poolPath())); }

  // ---------- Agent 状态 ----------
  private statePath(): string { return path.join(this.dataDir, 'state', 'agents.json'); }
  async saveAgentStates(states: AgentState[]): Promise<void> { await writeJson(this.statePath(), this.envelope(states)); }
  async loadAgentStates(): Promise<AgentState[] | null> { return this.unwrap(await readJson(this.statePath())); }

  // ---------- 运行结果（含轨迹，回放源） ----------
  private runPath(mode: 'prediction' | 'sandbox', key: string): string {
    return path.join(this.dataDir, 'runs', mode, `${key}.json`);
  }
  async savePrediction(key: string, result: PredictionResult): Promise<void> {
    await writeJson(this.runPath('prediction', key), this.envelope(result));
  }
  async loadPrediction(key: string): Promise<PredictionResult | null> {
    return this.unwrap(await readJson(this.runPath('prediction', key)));
  }
  async saveSandbox(id: string, result: SandboxResult): Promise<void> {
    await writeJson(this.runPath('sandbox', id), this.envelope(result));
  }
  async loadSandbox(id: string): Promise<SandboxResult | null> {
    return this.unwrap(await readJson(this.runPath('sandbox', id)));
  }
  async listPredictionDates(): Promise<string[]> {
    try {
      const dir = path.join(this.dataDir, 'runs', 'prediction');
      const files = await fs.readdir(dir);
      return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    } catch { return []; }
  }

  // ---------- 对账账本（append-only，#35） ----------
  private reconcilePath(): string { return path.join(this.dataDir, 'reconcile.json'); }
  /**
   * 追加对账记录（数据流分析修复 F20）：绕过 unwrap 直接读原始信封——
   * 账本文件 schemaVersion 高于当前版本时（版本回退/混布场景）不得静默清空，
   * 保留原 payload 原样追加，信封版本取两者较大值（append-only 语义优先）。
   */
  async appendReconcile(records: ReconcileRecord[]): Promise<ReconcileRecord[]> {
    const { records: existing, schemaVersion } = await this.loadReconcileRaw();
    const merged = [...existing, ...records];
    await writeJson(this.reconcilePath(), { schemaVersion, savedAt: new Date().toISOString(), payload: merged });
    return merged;
  }

  /**
   * 原始读取对账账本（F20 配套）：不因 schemaVersion 过高返回空——
   * 结算重写路径（cmdReconcile）同样必须保全未来版本的账本内容。
   */
  async loadReconcileRaw(): Promise<{ records: ReconcileRecord[]; schemaVersion: number }> {
    const raw = await readJson<StoredEnvelope<ReconcileRecord[]>>(this.reconcilePath());
    if (raw === null || !Array.isArray(raw.payload)) return { records: [], schemaVersion: SCHEMA_VERSION };
    return { records: raw.payload, schemaVersion: Math.max(raw.schemaVersion, SCHEMA_VERSION) };
  }
  async loadReconcile(): Promise<ReconcileRecord[]> {
    const env = await readJson<StoredEnvelope<ReconcileRecord[]>>(this.reconcilePath());
    return this.unwrap(env) ?? [];
  }

  // ---------- 缓存（降级数据，Python 侧也用同目录） ----------
  cachePath(...segs: string[]): string { return path.join(this.dataDir, 'cache', ...segs); }
}
