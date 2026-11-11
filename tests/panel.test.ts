/** 面板服务测试（#8 只读 / #26 API 契约 / #28 版本兼容） */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { startPanelServer, type PanelHandle } from '../src/panel-server.js';

let dir: string;
let handle: PanelHandle | null;
const PORT = 3451;
const BASE = `http://127.0.0.1:${PORT}`;

function writeEnvelope(rel: string, payload: unknown, schemaVersion = 1): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion, savedAt: 't', payload }));
}

beforeAllData();

function beforeAllData(): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiucai-panel-'));
  writeEnvelope('runs/prediction/2026-01-06.json', { anchorDate: '2026-01-06', days: [{ tradeDate: '2026-01-07', closeEstimate: 3010, band: { p10: 2990, p90: 3030 }, direction: 1, netFlowMedian: 2, offsetPct: 0.5 }], terminal: { dist: [3010], median: 3010 }, multiBullPct: 0.6, multiBearPct: 0.2, dispersionNarrow: false, coldStartNote: null, intradayNote: null, representativeQuotes: [], report: { markdown: '# 日报', camps: [], dispersionNote: '', participationNote: null }, rounds: [], schemaVersion2: undefined });
  writeEnvelope('runs/sandbox/2026-01-06-3d.json', { startDate: '2026-01-06', days: [], note: 'exogenous frozen at day0, decaying', report: { markdown: '', camps: [], dispersionNote: '', participationNote: null } });
  writeEnvelope('pool.json', [{ id: 'p01', name: '测试哥', style: 'trend', capitalTier: 1, stability: 1, stance: 'bull', biases: [], maxLossPct: null, baseline: 50, systemPrompt: 'x' }]);
  writeEnvelope('state/agents.json', [{ personaId: 'p01', cash: 0, exposurePct: 10, costBasis: null, emotion: 50, memory: [] }]);
  writeEnvelope('reconcile.json', []);
  writeEnvelope('runs/prediction/2099-01-01.json', {}, 999); // 426 场景（key 须满足白名单格式，F35）
  fs.writeFileSync(path.join(dir, 'secret.json'), JSON.stringify({ secret: 'TOPSECRET' })); // 路径穿越目标（F35）
}

afterAll(async () => { await handle?.close(); });

describe('panel-server API', () => {
  it('runs 列表', async () => {
    handle = await startPanelServer({ storeDir: dir, port: PORT });
    const r = await fetch(`${BASE}/api/runs`);
    const j = await r.json() as { predictions: string[]; sandboxes: string[] };
    expect(r.status).toBe(200);
    expect(j.predictions).toContain('2026-01-06');
    expect(j.sandboxes).toContain('2026-01-06-3d');
  });
  it('预测结果解包 payload', async () => {
    const r = await fetch(`${BASE}/api/run/prediction/2026-01-06`);
    const j = await r.json() as { anchorDate: string };
    expect(r.status).toBe(200);
    expect(j.anchorDate).toBe('2026-01-06');
  });
  it('schemaVersion 过高 → 426（#28 兼容语义）', async () => {
    const r = await fetch(`${BASE}/api/run/prediction/2099-01-01`);
    expect(r.status).toBe(426);
  });
  it('路径穿越 key → 404，不泄露 storeDir 外文件（F35）', async () => {
    const r = await fetch(`${BASE}/api/run/prediction/..%2F..%2Fsecret`);
    expect(r.status).toBe(404);
  });
  it('非法 Host 头 → 403（F35 DNS rebinding 防护）', async () => {
    // undici fetch 不便伪造 Host 头，用 node:http 原始请求
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/runs', headers: { host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });
  it('config 读取（F14：缺失回退默认值）', async () => {
    const j = await (await fetch(`${BASE}/api/config`)).json() as { sandboxK: number; emotion: { eventWeight: number } };
    expect(j.sandboxK).toBe(1);
    expect(j.emotion.eventWeight).toBe(4);
  });
  it('pool / states / reconcile', async () => {
    expect((await (await fetch(`${BASE}/api/pool`)).json() as { id: string }[])[0]!.id).toBe('p01');
    expect(((await (await fetch(`${BASE}/api/states`)).json()) as { exposurePct: number }[])[0]!.exposurePct).toBe(10);
    expect(await (await fetch(`${BASE}/api/reconcile`)).json()).toEqual([]);
  });
  it('静态面板 200 且含免责声明', async () => {
    const r = await fetch(`${BASE}/`);
    const body = await r.text();
    expect(r.status).toBe(200);
    expect(body).toContain('不构成任何投资建议');
  });
  it('未知路径 404', async () => {
    expect((await fetch(`${BASE}/api/nope`)).status).toBe(404);
  });
});

// ---------- v1.4 #64：机构字段 additive 透传（SCHEMA_VERSION=1 不变）+ 面板静态内容 ----------
describe('panel 机构决策层（#64 additive）', () => {
  it('GET /api/run/prediction/<key> 透传 inst/flowScope（旧记录缺字段 → undefined 自愈）', async () => {
    handle = await startPanelServer({ storeDir: dir, port: PORT + 1 });
    // 写入带 inst 的新形态记录
    writeEnvelope('runs/prediction/2026-02-06.json', {
      anchorDate: '2026-02-06',
      days: [{ tradeDate: '2026-02-09', closeEstimate: 3010, band: { p10: 2990, p90: 3030 }, direction: 1, netFlowMedian: 2, offsetPct: 0.5 }],
      terminal: { dist: [3010], median: 3010 }, multiBullPct: 0.6, multiBearPct: 0.2,
      dispersionNarrow: false, coldStartNote: null, intradayNote: null, representativeQuotes: [],
      report: { markdown: '# 日报', camps: [], dispersionNote: '', participationNote: null },
      rounds: [],
      inst: { asOf: '2026-02-06', netFlowYi: 8.374, paths: [{ pathId: 'margin', label: 'M1', netFlowYi: 100, signals: {}, asOf: '2026-02-06' }], degraded: [] },
      flowScope: 'retail+inst',
    });
    const withInst = await (await fetch(`${BASE.replace(String(PORT), String(PORT + 1))}/api/run/prediction/2026-02-06`)).json();
    expect(withInst.inst.netFlowYi).toBe(8.374);
    expect(withInst.flowScope).toBe('retail+inst');
    // 旧形态记录（beforeAllData 的 2026-01-06）无该字段 → 原样缺省（渲染层省略，#28 自愈）
    const legacy = await (await fetch(`${BASE.replace(String(PORT), String(PORT + 1))}/api/run/prediction/2026-01-06`)).json();
    expect(legacy.inst).toBeUndefined();
    expect(legacy.flowScope).toBeUndefined();
  });

  it('panel.html 静态内容：机构卡/锚定日冻结值/口径分列/成本 0 次 LLM/设置五键', async () => {
    handle = handle ?? await startPanelServer({ storeDir: dir, port: PORT + 1 });
    const base = `http://127.0.0.1:${PORT + 1}`;
    const html = await (await fetch(base + '/')).text();
    expect(html).toContain('机构决策层');           // 预测页独立机构卡
    expect(html).toContain('inst-card');
    expect(html).toContain('锚定日冻结值');          // 沙盘页 instNF 标注（#41）
    expect(html).toContain('retail+inst');          // 命中率分列渲染（#61）
    expect(html).toContain('机构层 0 次 LLM');       // 成本边界（#64）
    expect(html).toContain('机构路径·两融杠杆');      // 设置五键展示（#58/#60）
    expect(html).toContain('折算系数为一期未校准默认值'); // 未校准明示（#60）
    // 机构不进名册：pool-grid 渲染逻辑只含 POOL + 总编卡（loadPool 无机构条目）
    expect(html).not.toContain('data-id="__inst"');
  });
});
