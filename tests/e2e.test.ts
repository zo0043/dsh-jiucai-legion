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
