// 韭菜军团三视图（C3）：预测页 / 沙盘页 / 军团与设置，
// 以 React 组件迁移自 static/panel.html（25.6KB 整页脚本 → PanelPage 组件树）。
// 数据通道见 api.ts（C4：绝对 URL）。本树由 esbuild 编译（tsconfig exclude），
// JSX 走 automatic runtime（react/jsx-runtime），hooks 走 react —— 均为种子词。
import { useEffect, useState } from 'react';
import {
  api,
  type AgentState, type PanelConfig, type Persona, type PredDay,
  type Prediction, type ReconcileRow, type SandboxRun, type SbxDay,
} from './api';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const fmtPct = (x: number): string => (x * 100).toFixed(0) + '%';

// ---------- 极简 Markdown（迁移 panel.html md()，转义后拼 HTML） ----------
function mdHtml(text: string): string {
  const lines = esc(text).split('\n');
  let html = '';
  let inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    const out = line.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    if (/^# /.test(line)) { if (inList) { html += '</ul>'; inList = false; } html += `<h1>${out.slice(2)}</h1>`; }
    else if (/^## /.test(line)) { if (inList) { html += '</ul>'; inList = false; } html += `<h2>${out.slice(3)}</h2>`; }
    else if (/^[-*] /.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${out.slice(2)}</li>`; }
    else { if (inList) { html += '</ul>'; inList = false; } if (line) html += `<p>${out}</p>`; }
  }
  if (inList) html += '</ul>';
  return html;
}

// ---------- SVG 图（迁移 panel.html svgPathChart / svgDrift，字符串拼装 + dangerouslySetInnerHTML） ----------
function svgPathChart(days: PredDay[] | undefined): string {
  if (!days || !days.length) return '<span class="jcl-dim">无数据</span>';
  const W = 640, H = 220, P = 36;
  const closes = days.map((d) => d.closeEstimate);
  const lows = days.map((d) => d.band.p10), highs = days.map((d) => d.band.p90);
  const all = lows.concat(highs);
  const min = Math.min(...all), max = Math.max(...all);
  const pad = (max - min) * 0.08 || 1;
  const y = (v: number): number => P + (H - 2 * P) * (1 - (v - (min - pad)) / (max + pad - (min - pad)));
  const x = (i: number): number => P + (W - 2 * P) * (days.length === 1 ? 0.5 : i / (days.length - 1));
  let s = `<svg width="${W}" height="${H}" style="max-width:100%">`;
  s += `<polygon fill="rgba(125,211,252,.15)" points="${days.map((d, i) => `${x(i)},${y(highs[i])}`).join(' ')} ${days.map((_, i) => `${x(days.length - 1 - i)},${y(lows[days.length - 1 - i])}`).join(' ')}" />`;
  s += `<polyline fill="none" stroke="#7dd3fc" stroke-width="2" points="${days.map((d, i) => `${x(i)},${y(closes[i])}`).join(' ')}" />`;
  days.forEach((d, i) => {
    s += `<circle cx="${x(i)}" cy="${y(closes[i])}" r="3" fill="#7dd3fc" />`;
    s += `<text x="${x(i)}" y="${y(closes[i]) - 10}" fill="#8b93a3" font-size="10" text-anchor="middle">${d.closeEstimate.toFixed(0)}</text>`;
    s += `<text x="${x(i)}" y="${H - 10}" fill="#8b93a3" font-size="9" text-anchor="middle">${esc(d.tradeDate.slice(5))}</text>`;
  });
  return s + '</svg>';
}

interface DriftMemory { targetPct: number; confidence: number }
function svgDrift(memory: DriftMemory[] | undefined): string {
  if (!memory || memory.length < 2) return '<span class="jcl-dim">记忆不足两条，漂移曲线暂无法绘制（#52）</span>';
  const W = 560, H = 160, P = 24;
  const x = (i: number): number => P + (W - 2 * P) * i / (memory.length - 1);
  const yT = (v: number): number => P + (H - 2 * P) * (1 - v / 100);
  const yC = (v: number): number => P + (H - 2 * P) * (1 - (v - 1) / 4);
  const line = (f: (m: DriftMemory) => number, yf: (v: number) => number): string =>
    memory.map((m, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yf(f(m)).toFixed(1)}`).join(' ');
  let s = `<svg width="${W}" height="${H}" style="max-width:100%">`;
  s += `<path d="${line((m) => m.targetPct, yT)}" fill="none" stroke="#4ade80" stroke-width="2"/>`;
  s += `<path d="${line((m) => m.confidence, yC)}" fill="none" stroke="#fbbf24" stroke-width="2"/>`;
  s += `<text x="${P}" y="14" fill="#4ade80" font-size="10">目标仓位%</text><text x="${P + 80}" y="14" fill="#fbbf24" font-size="10">置信度(1-5)</text>`;
  return s + '</svg>';
}

// ---------- 侧栏图标（收 {size, active}，对照 sidebar client.js:226-231 renderSlot({size:16|18,active})） ----------
export function PanelIcon({ size, active }: { size: number; active: boolean }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 6.5c2.6 1.2 4 3.2 4 5.5s-1.4 4.3-4 5.5c-2.6-1.2-4-3.2-4-5.5s1.4-4.3 4-5.5z" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// ---------- 通用异步加载 hook ----------
interface Async<T> { data: T | null; error: string }
function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const [state, setState] = useState<Async<T>>({ data: null, error: '' });
  useEffect(() => {
    let live = true;
    fn().then(
      (data) => { if (live) setState({ data, error: '' }); },
      (e) => { if (live) setState({ data: null, error: (e as Error).message }); },
    );
    return () => { live = false; };
  }, deps);
  return state;
}

// ---------- 主面板（main slot 挂载的页面组件） ----------
export function PanelPage(): JSX.Element {
  const [view, setView] = useState<'pred' | 'sandbox' | 'legion'>('pred');
  const runs = useAsync<import('./api').RunsIndex>(() => api('/api/runs'), []);
  const pool = useAsync<Persona[] | null>(() => api<Persona[]>('/api/pool').catch(() => null), []);
  const nameOf = (id: string): string => (pool.data ?? []).find((p) => p.id === id)?.name ?? id;
  const empty = runs.data !== null && runs.data.predictions.length === 0 && runs.data.sandboxes.length === 0;
  return (
    <div className="jcl-root">
      <div className="jcl-tabs">
        <button className={view === 'pred' ? 'on' : ''} onClick={() => setView('pred')}>预测页</button>
        <button className={view === 'sandbox' ? 'on' : ''} onClick={() => setView('sandbox')}>沙盘页</button>
        <button className={view === 'legion' ? 'on' : ''} onClick={() => setView('legion')}>军团与设置</button>
      </div>
      {runs.error !== '' && <div className="jcl-warn">⚠ {esc(runs.error)}</div>}
      {empty && (
        <div className="jcl-warn">
          还没有任何运行记录：先运行 `npm run cli -- init && npm run cli -- predict`（冷启动三步，#32）
        </div>
      )}
      {runs.data !== null && !empty && view === 'pred' && (
        <PredView predictions={[...runs.data.predictions].reverse()} pool={pool.data ?? []} />
      )}
      {runs.data !== null && !empty && view === 'sandbox' && (
        <SandboxView sandboxes={[...runs.data.sandboxes].reverse()} nameOf={nameOf} />
      )}
      {view === 'legion' && <LegionView pool={pool.data ?? []} nameOf={nameOf} />}
      <div className="jcl-footer">⚠️ 模拟沙盘，仅供娱乐与研究，不构成任何投资建议。（#28 免责声明常驻）</div>
    </div>
  );
}

// ---------- 预测页 ----------
function PredView({ predictions, pool }: { predictions: string[]; pool: Persona[] }): JSX.Element | null {
  const [date, setDate] = useState('');
  useEffect(() => { if (date === '' && predictions.length > 0) setDate(predictions[0]); }, [predictions, date]);
  const pred = useAsync<Prediction>(
    () => (date === '' ? Promise.reject(new Error('')) : api<Prediction>('/api/run/prediction/' + encodeURIComponent(date))),
    [date],
  );
  const recs = useAsync<ReconcileRow[]>(() => api<ReconcileRow[]>('/api/reconcile').catch(() => []), []);
  if (predictions.length === 0) return null;
  const p = pred.data;
  const nameOf = (id: string): string => pool.find((x) => x.id === id)?.name ?? id;

  // 命率横幅（平局剔除分母，#44）
  const settled = recs.data ? recs.data.filter((x) => x.outcome) : [];
  const stat = (h: string): string => {
    const rs = settled.filter((x) => x.horizon === h);
    const ties = rs.filter((x) => x.outcome === 'tie').length;
    const hits = rs.filter((x) => x.outcome === 'hit').length;
    const decided = rs.length - ties;
    return `${decided > 0 ? `最近 ${decided} 次命中 ${hits} 次（${(hits / decided * 100).toFixed(0)}%）` : '暂无已结算预测'}${ties ? `，另有 ${ties} 次平局未计入` : ''}`;
  };

  const warns: string[] = [];
  if (p?.dispersionNarrow) warns.push('⚠ 分歧度过窄告警（#39）：K 轮方向完全一致，分布可能偏窄。');
  if (p?.intradayNote) warns.push('⚠ ' + esc(p.intradayNote) + '（#46）');
  if (p?.coldStartNote) warns.push('ℹ ' + esc(p.coldStartNote) + '（#45）');
  if (p?.report.participationNote) warns.push('ℹ ' + esc(p.report.participationNote) + '（#54）');

  const bull = p?.multiBullPct ?? 0, bear = p?.multiBearPct ?? 0, neutral = Math.max(0, 1 - bull - bear);
  return (
    <section>
      <div className="jcl-card">
        <h3>选择预测记录</h3>
        <select value={date} onChange={(e) => setDate(e.target.value)}>
          {predictions.map((d) => <option key={d} value={d}>{esc(d)}</option>)}
        </select>
        {p && (
          <span className="jcl-kv" style={{ marginLeft: 12 }}>
            {`锚定 ${esc(p.anchorDate)} 收盘`}
            {p.mock === true && <span className="jcl-amber"> ｜ ⚠ mock 演示数据（不计入命中率，F21）</span>}
          </span>
        )}
      </div>
      <div className="jcl-banner">📊 <strong>1 日</strong>：{stat('1d')} ｜ <strong>5 日</strong>：{stat('5d')}</div>
      {pred.error !== '' && date !== '' && <div className="jcl-warn">⚠ {esc(pred.error)}</div>}
      {warns.map((w, i) => <div key={i} className="jcl-warn" dangerouslySetInnerHTML={{ __html: w }} />)}
      {p && (
        <div className="jcl-row">
          <div className="jcl-card">
            <h3>5 日路径与置信区间（误差累积逐日加宽，#20）</h3>
            <div dangerouslySetInnerHTML={{ __html: svgPathChart(p.days) }} />
            <div className="jcl-kv">{`第 5 日终点中位 ${p.terminal.median.toFixed(0)}（分布 ${p.terminal.dist.length} 轮）`}</div>
          </div>
          <div className="jcl-card">
            <h3>多空统计（中位轮）</h3>
            <div className="jcl-big">
              <span className={bull >= bear ? 'jcl-green' : 'jcl-red'}>{fmtPct(bull)}</span> <span className="jcl-dim">看多</span>
            </div>
            <div className="jcl-campbar">
              <div style={{ width: `${bull * 100}%`, background: 'var(--jcl-green)' }} />
              <div style={{ width: `${neutral * 100}%`, background: '#555' }} />
              <div style={{ width: `${bear * 100}%`, background: 'var(--jcl-red)' }} />
            </div>
            <div className="jcl-kv">绿=加仓 红=减仓 灰=持稳（相对当前仓位，#51 结算口径）</div>
            <h3 style={{ marginTop: 14 }}>代表性发言</h3>
            <div>
              {(p.representativeQuotes ?? []).map((q, i) => (
                <div key={i} className="jcl-quote">{esc(nameOf(q.personaId))}：{esc(q.reason)}</div>
              )) ?? null}
              {(p.representativeQuotes ?? []).length === 0 && <span className="jcl-dim">（无）</span>}
            </div>
          </div>
        </div>
      )}
      {p && (
        <div className="jcl-card">
          <h3>总编日报 · 今日散户生态观察（#30）</h3>
          <div className="jcl-md" dangerouslySetInnerHTML={{ __html: mdHtml(p.report.markdown) }} />
        </div>
      )}
      <div className="jcl-card">
        <h3>历史对账明细（平局剔除分母，#44）</h3>
        <table>
          <thead>
            <tr><th>锚定日</th><th>期限</th><th>预测</th><th>实际</th><th>结果</th></tr>
          </thead>
          <tbody>
            {(recs.data ?? []).slice(-20).reverse().map((x, i) => (
              <tr key={i}>
                <td>{esc(x.anchorDate)}</td>
                <td>{esc(x.horizon)}</td>
                <td>{x.predictedDirection === 1 ? '看多' : x.predictedDirection === -1 ? '看空' : '持平'}</td>
                <td>{x.actualPct === null ? '未结算' : x.actualPct.toFixed(2) + '%'}</td>
                <td className={x.outcome === 'hit' ? 'jcl-green' : x.outcome === 'miss' ? 'jcl-red' : 'jcl-dim'}>{x.outcome ?? '…'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------- 沙盘页（重放已落盘轨迹，不重跑——#44 技术默认） ----------
function SandboxView({ sandboxes, nameOf }: { sandboxes: string[]; nameOf: (id: string) => string }): JSX.Element | null {
  const [id, setId] = useState('');
  useEffect(() => { if (id === '' && sandboxes.length > 0) setId(sandboxes[0]); }, [sandboxes, id]);
  const [sbx, setSbx] = useState<SandboxRun | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (id === '') return;
    let live = true;
    api<SandboxRun>('/api/run/sandbox/' + encodeURIComponent(id)).then((r) => {
      if (live) { setSbx(r); setIdx(0); setPlaying(false); }
    }).catch(() => { if (live) setSbx(null); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => {
    if (!playing || !sbx) return;
    const t = setInterval(() => {
      setIdx((i) => {
        if (i >= sbx.days.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, 1200);
    return () => clearInterval(t);
  }, [playing, sbx]);
  if (sandboxes.length === 0 || !sbx) return null;
  const d: SbxDay | undefined = sbx.days[idx] ?? sbx.days[0];
  if (!d) return null;
  const closes = sbx.days.slice(0, idx + 1).map((x) => x.close);
  const W = 640, H = 180, P = 30;
  const min = Math.min(...closes), max = Math.max(...closes);
  const pad = (max - min) * 0.1 || 1;
  const y = (v: number): number => P + (H - 2 * P) * (1 - (v - (min - pad)) / (max + pad - (min - pad)));
  const x = (i: number): number => P + (W - 2 * P) * (closes.length === 1 ? 0.5 : i / (sbx.days.length - 1));
  let chart = `<svg width="${W}" height="${H}" style="max-width:100%">`;
  if (closes.length > 1) {
    chart += `<polyline fill="none" stroke="${d.direction === 1 ? '#4ade80' : d.direction === -1 ? '#f87171' : '#8b93a3'}" stroke-width="2" points="${closes.map((c, i) => `${x(i)},${y(c)}`).join(' ')}" />`;
  }
  chart += `<circle cx="${x(closes.length - 1)}" cy="${y(closes[closes.length - 1])}" r="4" fill="#fff" /></svg>`;
  const note = sbx.report && sbx.report.markdown.includes('沙盘')
    ? '⚠ 沙盘推演：外生数据冻结于第 0 日并逐日衰减，第 1 日后全部为内生演化（#41），不构成对真实市场的预测。'
    : '⚠ ' + esc(sbx.note ?? '');
  return (
    <section>
      <div className="jcl-card">
        <h3>沙盘回放（重放已落盘轨迹，不重跑——#44 技术默认）</h3>
        <select value={id} onChange={(e) => setId(e.target.value)}>
          {sandboxes.map((s) => <option key={s} value={s}>{esc(s)}</option>)}
        </select>
        <div className="jcl-btns">
          <button className="jcl-act" onClick={() => setPlaying(!playing)}>{playing ? '⏸ 暂停' : '▶ 播放'}</button>
          <button className="jcl-ghost" onClick={() => { setPlaying(false); if (idx < sbx.days.length - 1) setIdx(idx + 1); }}>步进 ▸</button>
          <input type="range" style={{ flex: 1 }} min={0} max={sbx.days.length - 1} value={idx}
            onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} />
          <span className="jcl-kv">{`第 ${d.dayIndex + 1} 日 · ${d.tradeDate} · 收盘 ${d.close.toFixed(0)}`}</span>
        </div>
        <div dangerouslySetInnerHTML={{ __html: chart }} />
        <div className="jcl-row" style={{ marginTop: 12 }}>
          <div className="jcl-card" style={{ flex: '0 0 220px' }}>
            <h3>当日军团倾向（#50 回流显示）</h3>
            <div className="jcl-big"><span className={d.legionBullPct >= 0.5 ? 'jcl-green' : 'jcl-red'}>{fmtPct(d.legionBullPct)}</span></div>
            <div className="jcl-kv">{`净流 ${d.netFlow.toFixed(3)} ｜ 方向 ${d.direction === 1 ? '做多' : d.direction === -1 ? '做空' : '观望'}`}</div>
            <h3 style={{ marginTop: 12 }}>活跃事件卡（#42）</h3>
            <div className="jcl-kv" dangerouslySetInnerHTML={{
              __html: d.activeEvents.length
                ? d.activeEvents.map((e) => `🃏 ${esc(e.text)}（权重 ${e.weight.toFixed(2)}）`).join('<br>')
                : '（无）',
            }} />
          </div>
          <div className="jcl-card" style={{ flex: 1 }}>
            <h3>军团发言流（当日 30 人，#29 现场感）</h3>
            <div className="jcl-feed">
              {d.round.outputs.map((o, i) => {
                const cls = o.targetPct > 50 ? 'jcl-green' : o.targetPct < 50 ? 'jcl-red' : 'jcl-dim';
                return (
                  <div key={i} className="jcl-item">
                    <span className={cls}>●</span> <strong>{esc(nameOf(o.personaId))}</strong>
                    {`（目标 ${o.targetPct}%，信心 ${o.confidence}/5）：${esc(o.reason)}`}
                  </div>
                );
              })}
              {d.round.outputs.length === 0 && <span className="jcl-dim">（本轮无人参战）</span>}
            </div>
          </div>
        </div>
        <div className="jcl-warn" style={{ marginTop: 12 }} dangerouslySetInnerHTML={{ __html: note }} />
      </div>
    </section>
  );
}

// ---------- 军团与设置 ----------
const BIAS_NAMES: Record<string, string> = { loss_aversion: '损失厌恶', breakeven: '回本执念', chasing: '追涨', anchoring: '锚定成本' };
function LegionView({ pool, nameOf }: { pool: Persona[]; nameOf: (id: string) => string }): JSX.Element {
  const states = useAsync<AgentState[]>(() => api<AgentState[]>('/api/states').catch(() => []), []);
  const cfg = useAsync<PanelConfig | null>(() => api<PanelConfig>('/api/config').catch(() => null), []);
  const runs = useAsync<import('./api').RunsIndex>(() => api('/api/runs'), []);
  const latest = useAsync<Prediction | null>(
    () => (runs.data && runs.data.predictions.length
      ? api<Prediction>('/api/run/prediction/' + encodeURIComponent(runs.data.predictions[0]))
      : Promise.resolve(null)),
    [runs.data],
  );
  const [card, setCard] = useState<string | null>(null);
  const byId = new Map((states.data ?? []).map((s) => [s.personaId, s]));
  const k = Math.max(1, Number(cfg.data?.sandboxK) || 1);
  const emo = cfg.data?.emotion ?? {};
  const cost = cfg.data
    ? `成本预估：预测一次 ≈ ${30 * 9 + 1} 次 LLM 调用（30 Agent × [K5+K1×4] + 总编 1）；` +
      `沙盘 ≈ ${30 * k} 次/日 × 天数（30 Agent × K=${k}）+ 总编 1 次/运行。` +
      `冲击系数 k=${cfg.data.impactK ?? 0.8}（一期未校准，#21；校准依赖二期对账数据）。`
    : '成本预估：加载中…（按当前配置实算）';
  const cfgRows: [string, string][] = cfg.data
    ? [
        ['标的指数', cfg.data.index === 'CSI300' ? '沪深300' : '上证指数'],
        ['模型 ID', cfg.data.modelId || '（宿主默认）'],
        ['游资放大系数', `×${cfg.data.hotMoneyAmp}`],
        ['事件卡衰减', `${cfg.data.eventDecayDays} 天`],
        ['沙盘每日采样轮数 K', String(k)],
        ['人设池随机种子', String(cfg.data.seed)],
        ['情绪权重（事件/盈亏/大盘）', `${emo.eventWeight ?? '?'} / ${emo.pnlWeight ?? '?'} / ${emo.marketWeight ?? '?'}`],
      ]
    : [];
  const lights = runs.data && runs.data.predictions.length
    ? (latest.data?.report.participationNote
        ? '<span class="jcl-light jcl-light-warn"></span>本轮有 Agent 缺席；'
        : '<span class="jcl-light"></span>本轮全员参战；') +
      (latest.data?.days && latest.data.days.length ? '<span class="jcl-light"></span>行情新鲜' : '')
    : '<span class="jcl-light"></span>行情：正常';
  const opened = card !== null ? pool.find((p) => p.id === card) : undefined;
  const openedState = card !== null ? byId.get(card) : undefined;
  return (
    <section>
      <div className="jcl-card">
        <h3>数据源状态灯（#26）与成本预估</h3>
        <div className="jcl-kv" dangerouslySetInnerHTML={{ __html: lights }} />
        <div className="jcl-kv" style={{ marginTop: 8 }}>{cost}</div>
        <h3 style={{ marginTop: 12 }}>当前生效设置（只读展示，按 /api/config 实时渲染；调整经 DSH 设置卡片或 config.json，面板不写盘，#26/#28）</h3>
        <div className="jcl-kv">
          {cfgRows.map(([a, b], i) => <div key={i}>· {esc(a)}：<strong>{esc(b)}</strong></div>)}
        </div>
      </div>
      <div className="jcl-card">
        <h3>军团名册（30 + 1 总编，点看档案卡，#31）</h3>
        <div className="jcl-grid">
          {pool.map((p) => {
            const st = byId.get(p.id);
            return (
              <div key={p.id} className="jcl-pcard" onClick={() => setCard(p.id)}>
                <div className="jcl-nm">{esc(p.name)}</div>
                <div className="jcl-meta">{esc(p.style)}｜档 {p.capitalTier}</div>
                <div className="jcl-meta">{`仓位 ${st ? st.exposurePct.toFixed(0) : '?'}%｜情绪 ${st ? st.emotion.toFixed(0) : '?'}`}</div>
              </div>
            );
          })}
          <div className="jcl-pcard" onClick={() => setCard('__chief')}>
            <div className="jcl-nm">📰 总编</div>
            <div className="jcl-meta">第 31 个角色</div>
            <div className="jcl-meta">每日生态观察（#30）</div>
          </div>
        </div>
      </div>
      {card !== null && (
        <div className="jcl-modal" onClick={(e) => { if (e.target === e.currentTarget) setCard(null); }}>
          <div className="jcl-inner">
            {opened ? (
              <div>
                <h3>{esc(opened.name)} <span className="jcl-dim">({esc(opened.id)})</span></h3>
                <p className="jcl-kv">
                  {`风格 ${esc(opened.style)}｜资金档 ${opened.capitalTier}｜立场 ${esc(opened.stance)}｜情绪稳定性 ${opened.stability}｜基线 ${esc(opened.baseline)}`}
                  {opened.biases.length
                    ? `｜偏差 ${opened.biases.map((b) => BIAS_NAMES[b] ?? b).join('/')}`
                    : ''}
                  {opened.maxLossPct !== null && (
                    <span className="jcl-amber">{`｜纪律：亏损超 ${opened.maxLossPct}% 无条件减仓`}</span>
                  )}
                </p>
                <p className="jcl-kv">
                  {`当前仓位 ${openedState ? openedState.exposurePct.toFixed(0) + '%' : '?'}｜情绪 ${openedState ? openedState.emotion.toFixed(0) : '?'}｜成本 ${openedState && openedState.costBasis !== null ? openedState.costBasis.toFixed(0) : '空仓'}`}
                </p>
                <h3 style={{ marginTop: 12 }}>性格漂移曲线（目标仓位 / 置信度滚动序列，#52）</h3>
                <div dangerouslySetInnerHTML={{ __html: svgDrift(openedState?.memory) }} />
                <h3 style={{ marginTop: 12 }}>操作复盘（沙盘/预测操作史，不称胜率——#31 分口径）</h3>
                {openedState && openedState.memory.length ? (
                  <table>
                    <thead><tr><th>日</th><th>动作</th><th>目标</th><th>信心</th><th>已实现</th><th>理由</th></tr></thead>
                    <tbody>
                      {openedState.memory.slice().reverse().map((m, i) => (
                        <tr key={i}>
                          <td>{esc(m.day)}</td><td>{esc(m.action)}</td><td>{m.targetPct}%</td><td>{m.confidence}</td>
                          <td>{m.realizedPnlPct === null ? '—' : m.realizedPnlPct.toFixed(2) + '%'}</td><td>{esc(m.reason)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : <p className="jcl-dim">（暂无操作记忆）</p>}
              </div>
            ) : (
              <div>
                <h3>📰 {card === '__chief' ? '总编' : esc(nameOf(card ?? ''))}</h3>
                <p className="jcl-dim">第 31 个角色：每日跑完自动产出《今日散户生态观察》（map-reduce 消化 30 人发言，#30）。日报见预测页。</p>
              </div>
            )}
            <p style={{ marginTop: 10 }}>
              <button className="jcl-act" onClick={() => setCard(null)}>关闭</button>
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
