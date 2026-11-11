/**
 * 端到端集成测试（MockHost，零网络零真实 LLM）：
 * 冷启动 → 首预测（K=5+递推）→ 落盘 → 沙盘（事件卡）→ 对账 → 重置。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPool } from '../src/engine/persona-pool.js';
import { MockLlm, MockClock, MockUi, fakeProcPort } from '../src/host/mock-host.js';
import { DataClient } from '../src/engine/data-client.js';
import { Store } from '../src/persist/store.js';
import { cmdInit, cmdPredict, cmdSandbox, cmdReconcile, cmdReset, cmdPersonas } from '../src/commands-impl.js';
import { DEFAULT_CONFIG, type MarketSnapshot, type EngineConfig } from '../src/engine/types.js';
import type { NodeSubprocessPort } from '../src/host/node-proc.js';

// ---------- fixture ----------
function fixtureCalendar(n = 12): string[] {
  const days: string[] = [];
  const d = new Date(Date.UTC(2026, 0, 5)); // 周一
  while (days.length < n) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return days;
}

function fixtureSnapshot(calendar: string[]): MarketSnapshot {
  const bars = calendar.slice(0, 10).map((date, i) => ({
    date,
    open: 3000 + i, high: 3005 + i, low: 2995 + i, close: 3000 + i * 2, volume: 1e8 + i,
  }));
  return {
    index: 'SH000001',
    tradeDate: bars[bars.length - 1]!.date,
    bars,
    breadth: { limitUp: 45, limitDown: 8, failedBoard: 20, maxStreak: 5, advancers: 3200, decliners: 1800 },
    sentiment: { source: 'xueqiu', heatIndex: 66.5, asOf: bars[bars.length - 1]!.date },
    news: {
      items: [{ text: '央行开展逆回购操作', ts: '2026-01-15T10:00:00+08:00', source: 'sina' }],
      asOf: bars[bars.length - 1]!.date,
    },
    funds: { marginBalance: 1.8e12, northboundNet: 5.2e9, asOf: bars[bars.length - 1]!.date },
    volatility20: 0.18,
    legionBullPct: null,
    degraded: [],
  };
}

let dir: string;
let bundle: Parameters<typeof cmdInit>[0];
let snapshot: MarketSnapshot;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiucai-e2e-'));
  const calendar = fixtureCalendar();
  snapshot = fixtureSnapshot(calendar);
  const cfg: EngineConfig = { ...DEFAULT_CONFIG, dataDir: dir, pythonBin: 'python3', quorumFloor: 24 };
  const llm = new MockLlm();
  let i = 0;
  llm.setFallback(() => {
    i += 1;
    const target = (i * 37) % 101;
    const conf = (i % 5) + 1;
    return `{"target_position_pct":${target},"confidence":${conf},"reason":"脚本化理由 ${i}：跟风梭了一把"}`;
  });
  const ports = {
    llm,
    proc: fakeProcPort(snapshot, calendar) as unknown as NodeSubprocessPort,
    ui: new MockUi(),
    clock: new MockClock(new Date(`${snapshot.tradeDate}T16:00:00+08:00`)),
  };
  bundle = {
    cfg, ports, store: new Store(dir),
    data: new DataClient(ports.proc, { pythonBin: 'python3', cwd: dir, dataDir: dir }),
    skipPing: true,
  };
});

describe('端到端（MockHost，#32 冷启动三步）', () => {
  it('init：组建 30 人军团并落盘', async () => {
    await cmdInit(bundle);
    const pool = await bundle.store.loadPool();
    const states = await bundle.store.loadAgentStates();
    expect(pool).toHaveLength(30);
    expect(states).toHaveLength(30);
    const hot = pool!.filter((p) => p.style === 'hotmoney' || p.style === 'speculator');
    expect(hot).toHaveLength(5);
    expect(hot.every((p) => p.maxLossPct !== null)).toBe(true); // #49 游资纪律
    const retail = pool!.filter((p) => !hot.includes(p));
    expect(retail.every((p) => p.biases.length >= 1)).toBe(true); // #49 偏差标签
  });

  it('predict：K=5 + 4 天递推 + 落盘 + 对账记录（#36/#35）', async () => {
    await cmdInit(bundle);
    const { result } = await cmdPredict(bundle);
    expect(result.rounds).toHaveLength(5); // #18 K=5
    expect(result.days).toHaveLength(5);   // #36 逐日路径
    const d1 = result.days[0]!;
    expect(d1.band.p10).toBeLessThanOrEqual(d1.closeEstimate);
    expect(d1.closeEstimate).toBeLessThanOrEqual(d1.band.p90);
    // 误差累积：带宽逐日不收窄（#20）
    for (let i = 1; i < result.days.length; i += 1) {
      const prev = result.days[i - 1]!;
      const cur = result.days[i]!;
      expect(cur.band.p90 - cur.band.p10).toBeGreaterThanOrEqual(prev.band.p90 - prev.band.p10 - 1e-6);
    }
    // 多空统计
    expect(result.multiBullPct + result.multiBearPct).toBeLessThanOrEqual(1.0001);
    // 报告含免责声明（#28）
    expect(result.report.markdown).toContain('不构成任何投资建议');
    // 落盘
    expect(await bundle.store.loadPrediction(result.anchorDate)).not.toBeNull();
    const recs = await bundle.store.loadReconcile();
    expect(recs).toHaveLength(2); // 1d + 5d（#35）
    // 状态提交：中位轮执行后部分 Agent 仓位非零（#51 结算）
    const statesAfter = await bundle.store.loadAgentStates();
    expect(statesAfter!.some((s) => s.exposurePct > 0 || s.exposurePct < 0)).toBe(true);
    // 冷启动标注（#45）
    expect(result.coldStartNote).toContain('首跑');
  });

  it('P1 气候跨运行注入：第二次预测第 1 日用户消息含气候行（MockLlm.calls）', async () => {
    await cmdInit(bundle);
    await cmdPredict(bundle);
    // 首跑无上一已结算轮 → 第一次预测第 1 日（K=5 × 30 人）消息不含气候行
    const firstDay1 = bundle.ports.llm.calls.slice(0, 150);
    expect(firstDay1).toHaveLength(150);
    expect(firstDay1.every((c) => !c.req.messages[1]!.content.includes('军团意见气候'))).toBe(true);
    const afterFirst = bundle.ports.llm.calls.length; // 150 + 递推 4×30 + 编辑报告 1
    await cmdPredict(bundle);
    // 第二次预测第 1 日：上一已结算轮的 legionClimate 注入 snapshot → 气候行可见
    const secondDay1 = bundle.ports.llm.calls.slice(afterFirst, afterFirst + 150);
    expect(secondDay1).toHaveLength(150);
    expect(secondDay1.every((c) => c.req.messages[1]!.content.includes('军团意见气候'))).toBe(true);
    // 同日重跑防护：注入气候 asOf=上一锚定日=本次末根 → 不拼「随后一个交易日」结果子句
    expect(secondDay1.every((c) => !c.req.messages[1]!.content.includes('随后一个交易日'))).toBe(true);
  });

  it('sandbox：外生冻结衰减 + 事件卡衰减 + 军团回流（#41/#42/#50）', async () => {
    await cmdInit(bundle);
    const { result } = await cmdSandbox(bundle, 5, '央行宣布全面降准 0.5 个百分点');
    expect(result.days).toHaveLength(5);
    expect(result.note).toContain('frozen');
    // 事件卡线性衰减：第 0 日有权重，衰减 2 天后消失（#42 默认 2 天）
    expect(result.days[0]!.activeEvents.length).toBeGreaterThan(0);
    const lastActive = result.days.filter((d) => d.activeEvents.length > 0).length;
    expect(lastActive).toBeLessThanOrEqual(2);
    // 收盘路径存在（无阻尼线性外推，#40）
    expect(result.days[4]!.close).not.toBe(result.days[0]!.close);
    // 军团回流：第 2 日起 legionBullPct 来自上一日（#50）
    expect(result.days[1]!.legionBullPct).toBeGreaterThanOrEqual(0);
    // 情绪值始终在 0–100（#48 clamp）
    const states = await bundle.store.loadAgentStates();
    for (const s of states!) expect(s.emotion).toBeGreaterThanOrEqual(0);
    for (const s of states!) expect(s.emotion).toBeLessThanOrEqual(100);
  });

  it('reconcile + personas + reset（#35/#31/#15）', async () => {
    await cmdInit(bundle);
    await cmdPredict(bundle);
    const banner = await cmdReconcile(bundle);
    expect(banner).toContain('命中率');
    const roster = await cmdPersonas(bundle);
    expect(roster).toContain('p01');
    await cmdReset(bundle);
    const states = await bundle.store.loadAgentStates();
    expect(states!.every((s) => s.exposurePct === 0 && s.memory.length === 0 && s.costBasis === null)).toBe(true);
  });

  it('确定性：同种子人设池一致（#11）', () => {
    const a = createPool({ ...DEFAULT_CONFIG, seed: 2026 });
    const b = createPool({ ...DEFAULT_CONFIG, seed: 2026 });
    expect(a.personas.map((p) => p.id)).toEqual(b.personas.map((p) => p.id));
    expect(a.personas[0]!.systemPrompt).toBe(b.personas[0]!.systemPrompt);
  });
});

// ---------- v1.4 #60/#61：机构层进合成管线（端到端，MockHost） ----------
import { institutionNetFlow } from '../src/engine/institutions.js';
import type { InstitutionFlow } from '../src/engine/types.js';

function instFixture(marginYi: number): InstitutionFlow {
  return {
    asOf: '2026-01-15',
    netFlowYi: marginYi,
    paths: [
      { pathId: 'margin', label: 'M1', netFlowYi: marginYi, signals: { sseAsOf: '2026-01-15' }, asOf: '2026-01-15', note: null },
      { pathId: 'etfSse', label: 'M2', netFlowYi: -14.96, signals: {}, asOf: '2026-01-15', note: null },
      { pathId: 'eventSeat', label: 'M3', netFlowYi: -1.3, signals: { lhbYi: -2.5, dzjyYi: 1.2 }, asOf: '2026-01-15', note: null },
      { pathId: 'quarterlyStructure', label: 'M4', netFlowYi: null, signals: {}, asOf: '2025-12-31', note: null },
      { pathId: 'northbound', label: 'M5', netFlowYi: null, signals: { southboundNetYi: 45.72 }, asOf: null, note: '北向 2024-08 停披露' },
    ],
    degraded: [],
  };
}

describe('机构层端到端（#60 合成 + #61 flowScope 断代）', () => {
  it('predict：inst 常数加进每轮（median 平移）、flowScope=retail+inst、rounds 落 retail 字段', async () => {
    const inst = instFixture(100); // nfScale 0.1 × 100 亿 = +10 NF
    const instSnapshot = { ...snapshot, inst };
    const cfg: EngineConfig = { ...DEFAULT_CONFIG, dataDir: dir, pythonBin: 'python3', quorumFloor: 24 };
    const llm = new MockLlm();
    llm.setFallback(() => '{\"target_position_pct\":0,\"confidence\":3,\"reason\":\"脚本化理由\"}');
    const localBundle = {
      cfg, ports: {
        llm, proc: fakeProcPort(instSnapshot, fixtureCalendar()) as unknown as NodeSubprocessPort,
        ui: new MockUi(), clock: new MockClock(new Date(`${instSnapshot.tradeDate}T16:00:00+08:00`)),
      }, store: new Store(dir + '-inst'), data: new DataClient(
        fakeProcPort(instSnapshot, fixtureCalendar()) as unknown as NodeSubprocessPort,
        { pythonBin: 'python3', cwd: dir, dataDir: dir },
      ), skipPing: true,
    };
    await cmdInit(localBundle);
    const { result } = await cmdPredict(localBundle);
    const instNF = institutionNetFlow(inst, cfg).netFlow;
    expect(instNF).toBeCloseTo(10 - 0.1 * 14.96 - 0.13, 10); // 0.1×(100−14.96−1.3)=8.374
    // 确定性常数平移：netFlow − retailNetFlow 每轮恒等于 instNF；median 同步平移
    for (const r of result.rounds) {
      expect(r.retailNetFlow).toBeDefined();
      expect(r.netFlow - (r.retailNetFlow ?? 0)).toBeCloseTo(instNF, 10);
      expect(r.retailDirection).toBeDefined();
    }
    const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    expect(med(result.rounds.map((r) => r.netFlow)) - med(result.rounds.map((r) => r.retailNetFlow ?? 0))).toBeCloseTo(instNF, 10);
    // 落盘：inst 原始载荷 + flowScope 按当时 cfg 写入
    expect(result.inst).toEqual(inst);
    expect(result.flowScope).toBe('retail+inst');
    // 对账记录携带 flowScope
    const recs = await localBundle.store.loadReconcile();
    expect(recs.every((r) => r.flowScope === 'retail+inst')).toBe(true);
    // 分歧告警读纯散户口径（#61）：目标=初始仓位 0 → 零调仓 → retail 恒 0；不因机构常数翻转
    expect(result.rounds.every((r) => r.retailDirection === 0)).toBe(true);
  });

  it('predict：instLayer.enabled=false → flowScope=retail 且 netFlow=retailNetFlow（逐点等价旧口径）', async () => {
    const inst = instFixture(100);
    const instSnapshot = { ...snapshot, inst };
    const cfg: EngineConfig = {
      ...DEFAULT_CONFIG, dataDir: dir, pythonBin: 'python3', quorumFloor: 24,
      instLayer: { enabled: false, nfScale: 0.1, paths: { margin: true, etf: true, event: true } },
    };
    const llm = new MockLlm();
    llm.setFallback(() => '{"target_position_pct":80,"confidence":5,"reason":"梭哈"}');
    const localBundle = {
      cfg, ports: {
        llm, proc: fakeProcPort(instSnapshot, fixtureCalendar()) as unknown as NodeSubprocessPort,
        ui: new MockUi(), clock: new MockClock(new Date(`${instSnapshot.tradeDate}T16:00:00+08:00`)),
      }, store: new Store(dir + '-off'), data: new DataClient(
        fakeProcPort(instSnapshot, fixtureCalendar()) as unknown as NodeSubprocessPort,
        { pythonBin: 'python3', cwd: dir, dataDir: dir },
      ), skipPing: true,
    };
    await cmdInit(localBundle);
    const { result } = await cmdPredict(localBundle);
    expect(result.flowScope).toBe('retail');
    for (const r of result.rounds) expect(r.netFlow).toBeCloseTo(r.retailNetFlow ?? 0, 10);
  });

  it('sandbox：SandboxDay.instNF 恒为锚定日冻结常数、SandboxResult.inst 原样落盘（#41）', async () => {
    const inst = instFixture(50); // 0.1×(50−14.96−1.3)=3.374
    const instSnapshot = { ...snapshot, inst };
    const cfg: EngineConfig = { ...DEFAULT_CONFIG, dataDir: dir, pythonBin: 'python3', quorumFloor: 24 };
    const llm = new MockLlm();
    llm.setFallback(() => '{\"target_position_pct\":0,\"confidence\":3,\"reason\":\"脚本化理由\"}');
    const localBundle = {
      cfg, ports: {
        llm, proc: fakeProcPort(instSnapshot, fixtureCalendar()) as unknown as NodeSubprocessPort,
        ui: new MockUi(), clock: new MockClock(new Date(`${instSnapshot.tradeDate}T16:00:00+08:00`)),
      }, store: new Store(dir + '-sbx'), data: new DataClient(
        fakeProcPort(instSnapshot, fixtureCalendar()) as unknown as NodeSubprocessPort,
        { pythonBin: 'python3', cwd: dir, dataDir: dir },
      ), skipPing: true,
    };
    await cmdInit(localBundle);
    const { result } = await cmdSandbox(localBundle, 3, '央行宣布全面降准 0.5 个百分点');
    const instNF = institutionNetFlow(inst, cfg).netFlow;
    expect(result.inst).toEqual(inst); // day-0 载荷原样冻结
    expect(result.days).toHaveLength(3);
    for (const d of result.days) expect(d.instNF).toBeCloseTo(instNF, 10); // 常数不衰减不重算
    // 日报兜底或叙事含机构动向行（#64）
    expect(result.report.markdown.length).toBeGreaterThan(0);
  });
});
