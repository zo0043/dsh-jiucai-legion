/**
 * 本地面板服务（需求 #8/#26/#44 Plan B 形态）：
 * 只读 data/ 结果 JSON + 静态面板；DSH client bundle 可复用同一 API 契约。
 * 引擎与渲染严格分离：本服务零引擎依赖（除 types 常量与设置合并 applySettings）。
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION, DEFAULT_CONFIG, type EngineConfig } from './engine/types.js';
import { applySettings } from './config.js';

export interface PanelServerOpts { storeDir: string; port?: number }
export interface PanelHandle { server: http.Server; port: number; close(): Promise<void> }

interface Envelope { schemaVersion: number; savedAt: string; payload: unknown }

function readEnvelope(file: string): { status: number; body: unknown } {
  try {
    const env = JSON.parse(fs.readFileSync(file, 'utf8')) as Envelope;
    if (typeof env.schemaVersion !== 'number' || env.schemaVersion > SCHEMA_VERSION) {
      return { status: 426, body: { error: `schemaVersion ${env.schemaVersion} 高于当前支持 ${SCHEMA_VERSION}，请升级面板` } };
    }
    return { status: 200, body: env.payload };
  } catch {
    return { status: 404, body: { error: 'not found' } };
  }
}

/** run key 白名单（F35 路径穿越防护）：预测=YYYY-MM-DD、沙盘=YYYY-MM-DD-<n>d */
const RUN_KEY_RE = /^\d{4}-\d{2}-\d{2}(-\d+d)?$/;

/** 当前生效配置（只读，成本预估/设置展示用，F14）：config.json 缺失/损坏 → 默认值 */
function currentConfig(storeDir: string): EngineConfig {
  try {
    const env = JSON.parse(fs.readFileSync(path.join(storeDir, 'config.json'), 'utf8')) as Envelope;
    return applySettings({ ...DEFAULT_CONFIG }, (env.payload ?? {}) as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function listRuns(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
  } catch { return []; }
}

/** 静态根目录：src/../static */
const STATIC_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');

export async function startPanelServer(opts: PanelServerOpts): Promise<PanelHandle> {
  const storeDir = path.resolve(opts.storeDir);
  const wanted = opts.port ?? 3210;
  let port = wanted;

  const server = http.createServer((req, res) => {
    // CORS（C4）：DSH client 面板（origin http://127.0.0.1:3080）跨源 GET 本服务。
    // 简单 GET 无自定义头不触发预检，仅 ACAO 一头即可；OPTIONS 分支为冗余保险。
    const corsHeaders = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    };
    const send = (status: number, body: unknown, type = 'application/json; charset=utf-8'): void => {
      res.writeHead(status, { 'content-type': type, ...corsHeaders });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    // Host 头校验（F35，DNS rebinding 防护）：服务只对本机开放，Host 必须为 127.0.0.1/localhost
    const host = (req.headers.host ?? '').split(':')[0] ?? '';
    if (host !== '127.0.0.1' && host !== 'localhost') {
      send(403, { error: 'invalid Host header' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname === '/api/runs') {
        send(200, {
          predictions: listRuns(path.join(storeDir, 'runs', 'prediction')),
          sandboxes: listRuns(path.join(storeDir, 'runs', 'sandbox')),
        });
        return;
      }
      if (url.pathname === '/api/config') {
        // 当前生效配置（只读展示，F14；面板不写盘）
        send(200, currentConfig(storeDir));
        return;
      }
      if (url.pathname.startsWith('/api/run/prediction/')) {
        const key = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (!RUN_KEY_RE.test(key)) { send(404, { error: 'not found' }); return; }
        const r = readEnvelope(path.join(storeDir, 'runs', 'prediction', `${key}.json`));
        send(r.status, r.body);
        return;
      }
      if (url.pathname.startsWith('/api/run/sandbox/')) {
        const key = decodeURIComponent(url.pathname.split('/').pop() ?? '');
        if (!RUN_KEY_RE.test(key)) { send(404, { error: 'not found' }); return; }
        const r = readEnvelope(path.join(storeDir, 'runs', 'sandbox', `${key}.json`));
        send(r.status, r.body);
        return;
      }
      if (url.pathname === '/api/pool') { const r = readEnvelope(path.join(storeDir, 'pool.json')); send(r.status, r.body); return; }
      if (url.pathname === '/api/states') { const r = readEnvelope(path.join(storeDir, 'state', 'agents.json')); send(r.status, r.body); return; }
      if (url.pathname === '/api/reconcile') { const r = readEnvelope(path.join(storeDir, 'reconcile.json')); send(r.status, r.body); return; }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        const file = path.join(STATIC_ROOT, 'panel.html');
        if (fs.existsSync(file)) send(200, fs.readFileSync(file), 'text/html; charset=utf-8');
        else send(404, 'panel.html 缺失');
        return;
      }
      if (url.pathname.startsWith('/static/')) {
        const rel = url.pathname.replace('/static/', '');
        const file = path.join(STATIC_ROOT, path.basename(rel));
        if (fs.existsSync(file)) send(200, fs.readFileSync(file), rel.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
        else send(404, 'not found');
        return;
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });

  // 端口占用时递增（最多 +10）
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const tryListen = (): void => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && attempts < 10) {
          attempts += 1;
          port += 1;
          tryListen();
        } else reject(e);
      });
      server.listen(port, '127.0.0.1', () => resolve());
    };
    tryListen();
  });

  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
