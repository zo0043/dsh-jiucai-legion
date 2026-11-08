/** 持久化单测（#8/#28：原子写、版本兼容、对账账本 append） */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store, writeJson, readJson } from '../src/persist/store.js';
import { DEFAULT_CONFIG, type ReconcileRecord } from '../src/engine/types.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiucai-store-'));
});

describe('Store', () => {
  it('config 往返', async () => {
    const s = new Store(dir);
    await s.saveConfig(DEFAULT_CONFIG);
    const cfg = await s.loadConfig();
    expect(cfg?.index).toBe('SH000001');
    expect(cfg?.hotMoneyAmp).toBe(3);
  });
  it('缺失文件返回 null 不抛', async () => {
    const s = new Store(dir);
    expect(await s.loadPool()).toBeNull();
  });
  it('schemaVersion 高于当前 → 拒读（向后兼容语义，#28）', async () => {
    const file = path.join(dir, 'future.json');
    await writeJson(file, { schemaVersion: 999, savedAt: 'x', payload: { a: 1 } });
    expect(await readJson(file)).not.toBeNull(); // 原始可读
    const s = new Store(dir);
    // 通过 unwrap 路径验证：写入未来版本的 config 后 loadConfig 返回 null
    await writeJson(s.configPath(), { schemaVersion: 999, savedAt: 'x', payload: DEFAULT_CONFIG });
    expect(await s.loadConfig()).toBeNull();
  });
  it('对账账本 append 保留历史（#35）', async () => {
    const s = new Store(dir);
    const rec = (d: string): ReconcileRecord => ({
      anchorDate: d, horizon: '1d', index: 'SH000001', predictedDirection: 1,
      predictedMedianPct: 1, actualPct: null, outcome: null, settledAt: null,
    });
    await s.appendReconcile([rec('2026-01-01')]);
    await s.appendReconcile([rec('2026-01-02')]);
    const all = await s.loadReconcile();
    expect(all).toHaveLength(2);
  });
  it('原子写不残留 tmp 文件', async () => {
    const file = path.join(dir, 'x.json');
    await writeJson(file, { a: 1 });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    expect(leftovers).toHaveLength(0);
    expect((await readJson<{ a: number }>(file))?.a).toBe(1);
  });
  it('listPredictionDates 排序返回', async () => {
    const s = new Store(dir);
    await s.savePrediction('2026-01-02', {} as never);
    await s.savePrediction('2026-01-01', {} as never);
    expect(await s.listPredictionDates()).toEqual(['2026-01-01', '2026-01-02']);
  });
});
