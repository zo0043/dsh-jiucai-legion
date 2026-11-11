/**
 * info-set 分层信息集测试 —— 零网络、零 LLM（全部模板拼装，#13 修正）。
 * 覆盖：军团意见气候块（#50 升级，P1：全团行/风格组行/结果子句/感知噪声/asOf 防护）、
 * 公共块各段、降级标注、风格块裁剪（#13）、个人块成本锚文案（#49）与情绪描述（#48）、
 * 洗牌后块内容集合不变（#39）、同 seed 确定性、块序与既有 seed 逐字不变（独立噪声种子）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildCommonBlock,
  buildLegionClimateBlock,
  buildPersonalBlock,
  buildStyleBlock,
  buildUserMessage,
} from '../src/engine/info-set.js';
import { buildLegionClimate } from '../src/engine/aggregate.js';
import { mulberry32, seededShuffle } from '../src/engine/persona-pool.js';
import type { AgentState, Bar, LegionClimate, MarketSnapshot, MemoryItem, NewsItem, Persona } from '../src/engine/types.js';

const LONG_NEWS = '消息面利好'.repeat(30); // 150 字，用于截断断言

function makeBars(n = 25): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i += 1) {
    const base = 3200 + i * 3 + (i % 3);
    bars.push({
      date: `2026-10-${String(i + 1).padStart(2, '0')}`,
      open: base - 2,
      high: base + 6,
      low: base - 8,
      close: base,
      volume: 100000000 + i * 5000000,
    });
  }
  return bars;
}

const NEWS: NewsItem[] = [
  { text: LONG_NEWS, ts: '2026-10-25 09:31:00', source: 'sina' },
  { text: '证监会例行发布会', ts: '2026-10-25 10:00:00', source: 'cls' },
];

function makeSnapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    index: 'SH000001',
    tradeDate: '2026-10-25',
    bars: makeBars(),
    breadth: { limitUp: 45, limitDown: 8, failedBoard: 12, maxStreak: 5, advancers: 2800, decliners: 2100 },
    sentiment: { source: 'xueqiu', heatIndex: 85.2, asOf: '2026-10-25' },
    news: { items: NEWS, asOf: '2026-10-25' },
    funds: { marginBalance: 18000, northboundNet: 32.5, asOf: '2026-10-24' },
    volatility20: 0.18,
    legionBullPct: null,
    degraded: [],
    ...overrides,
  };
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p01',
    name: '测试老哥',
    style: 'technical',
    capitalTier: 2,
    stability: 1,
    stance: 'range',
    biases: ['chasing'],
    maxLossPct: null,
    baseline: 50,
    systemPrompt: '',
    ...overrides,
  };
}

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    personaId: 'p01',
    cash: 40000,
    exposurePct: 60,
    costBasis: 3245,
    emotion: 50,
    memory: [],
    ...overrides,
  };
}

function mem(day: string, realized: number | null): MemoryItem {
  return { day, action: '加仓', targetPct: 60, confidence: 3, realizedPnlPct: realized, reason: '跟着量走' };
}

/** 意见气候 fixture：trend 组 3 人（看多 2/3 看空 1/3）+ contrarian 组 1 人（全看空） */
function climateFixture(asOf = '2026-10-24'): LegionClimate {
  const personas = new Map<string, Persona>([
    ['t1', makePersona({ id: 't1', style: 'trend' })],
    ['t2', makePersona({ id: 't2', style: 'trend' })],
    ['t3', makePersona({ id: 't3', style: 'trend' })],
    ['c1', makePersona({ id: 'c1', style: 'contrarian' })],
  ]);
  const outputs = [
    { personaId: 't1', targetPct: 90, confidence: 3 as const, reason: '' },
    { personaId: 't2', targetPct: 80, confidence: 3 as const, reason: '' },
    { personaId: 't3', targetPct: 10, confidence: 3 as const, reason: '' },
    { personaId: 'c1', targetPct: 20, confidence: 3 as const, reason: '' },
  ];
  return buildLegionClimate(asOf, outputs, personas);
}

describe('buildLegionClimateBlock 军团意见气候（#50 升级，P1）', () => {
  const bars = makeBars();

  it('climate=null（首轮/旧落盘记录缺字段）→ null，公共块后不拼任何气候行', () => {
    expect(buildLegionClimateBlock(null, { style: 'trend', bars, seed: 1 })).toBeNull();
    expect(buildCommonBlock(makeSnapshot())).not.toContain('军团意见气候');
    expect(buildCommonBlock(makeSnapshot({ legionBullPct: 0.63 }))).not.toContain('军团');
  });

  it('气候块精确文案（钉死）：全团行＋风格组行＋结果子句，≤3 行', () => {
    const block = buildLegionClimateBlock(climateFixture(), { style: 'trend', bars, seed: 7 })!;
    expect(block).toBe(
      '军团意见气候（2026-10-24）：看多 53% / 看空 51% / 观望 0%\n' +
      '你同风格（趋势跟踪）3 人：看多 72% / 看空 28% / 观望 0%\n' +
      '随后一个交易日指数 +0.03%',
    );
    expect(block.split('\n')).toHaveLength(3);
  });

  it('本人风格组 ≥3 人报精确数字；<3 人用「风闻」措辞不报数字', () => {
    const nums = buildLegionClimateBlock(climateFixture(), { style: 'trend', bars, seed: 7 })!;
    expect(nums).toContain('你同风格（趋势跟踪）3 人：');
    const heard = buildLegionClimateBlock(climateFixture(), { style: 'contrarian', bars, seed: 7 })!;
    expect(heard).toContain('风闻你同风格（逆向操作）的兄弟最近偏空');
    expect(heard).not.toMatch(/你同风格（逆向操作）\d+ 人/);
  });

  it('本人风格不在上轮输出中 → 只报全团行（无风格行），共 2 行', () => {
    const block = buildLegionClimateBlock(climateFixture(), { style: 'technical', bars, seed: 7 })!;
    expect(block).toBe('军团意见气候（2026-10-24）：看多 53% / 看空 51% / 观望 0%\n随后一个交易日指数 +0.03%');
    expect(block).not.toContain('你同风格');
    expect(block).not.toContain('风闻');
  });

  it('满仓看多 → 气候报高看多比例（旧动作差口径为 0，P1 验收）', () => {
    const twoMap = new Map<string, Persona>([
      ['t1', makePersona({ id: 't1', style: 'trend' })],
      ['t2', makePersona({ id: 't2', style: 'trend' })],
    ]);
    const allIn = buildLegionClimate('2026-10-25', [
      { personaId: 't1', targetPct: 100, confidence: 5 as const, reason: '' },
      { personaId: 't2', targetPct: 95, confidence: 5 as const, reason: '' },
    ], twoMap);
    const line = buildLegionClimateBlock(allIn, { style: 'trend', bars, seed: 3 })!.split('\n')[0]!;
    const bull = Number(line.match(/看多 (\d+)%/)![1]);
    expect(bull).toBeGreaterThan(80); // 真值 100%，±8pp 噪声下仍 >80
  });

  it('asOf=末根（同日重跑）→ 不拼结果子句（防把已知当日涨幅当「随后」，P1 验收）', () => {
    const sameDay = buildLegionClimate('2026-10-25', [], new Map());
    const block = buildLegionClimateBlock(sameDay, { style: 'trend', bars, seed: 7 })!;
    expect(block).not.toContain('随后一个交易日');
  });

  it('asOf 严格早于末根 → 结果子句按 bars 末两根现算', () => {
    const block = buildLegionClimateBlock(climateFixture(), { style: 'technical', bars, seed: 7 })!;
    const prev = bars[bars.length - 2]!;
    const last = bars[bars.length - 1]!;
    const ret = ((last.close - prev.close) / prev.close) * 100;
    expect(block).toContain(`随后一个交易日指数 ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`);
  });

  it('asOf 不在 bars 中（如超出 250 日窗口）→ 无结果子句', () => {
    const stale = climateFixture('2020-01-02');
    const block = buildLegionClimateBlock(stale, { style: 'trend', bars, seed: 7 })!;
    expect(block).not.toContain('随后一个交易日');
  });

  it('同 seed 确定性：气候块两次构建逐字一致（独立噪声种子）', () => {
    const a = buildLegionClimateBlock(climateFixture(), { style: 'trend', bars, seed: 42 });
    const b = buildLegionClimateBlock(climateFixture(), { style: 'trend', bars, seed: 42 });
    expect(a).toBe(b);
  });

  it('感知噪声有界：各 seed 下全团看多比例 = 真值 ±8pp（clamp [0,100]）', () => {
    const climate = climateFixture();
    for (let seed = 0; seed < 60; seed += 1) {
      const line = buildLegionClimateBlock(climate, { style: 'technical', bars, seed })!.split('\n')[0]!;
      const bull = Number(line.match(/看多 (\d+)%/)![1]);
      expect(bull).toBeGreaterThanOrEqual(42); // 真值 50% − 8pp
      expect(bull).toBeLessThanOrEqual(58); // 真值 50% + 8pp
    }
  });

  it('P5 双轨行：mirror 存在 → 资金加权行带 ±8pp 噪声；缺省 → 省略（P1 三行块不变）', () => {
    const climate = climateFixture();
    const mirror = { weightedBullPct: 0.6207, weightedBearPct: 0.1034, whaleRumor: null as const };
    for (let seed = 0; seed < 40; seed += 1) {
      const block = buildLegionClimateBlock(climate, { style: 'technical', bars, seed, mirror })!;
      const weighted = block.split('\n').find((l) => l.startsWith('资金加权看多'))!;
      const wb = Number(weighted.match(/看多 (\d+)%/)![1]);
      expect(weighted).toMatch(/（按在场资金）$/);
      expect(wb).toBeGreaterThanOrEqual(54); // 真值 62.07% − 8pp
      expect(wb).toBeLessThanOrEqual(71); // 真值 62.07% + 8pp
    }
    // 同 seed 确定性
    const a = buildLegionClimateBlock(climate, { style: 'technical', bars, seed: 9, mirror });
    const b = buildLegionClimateBlock(climate, { style: 'technical', bars, seed: 9, mirror });
    expect(a).toBe(b);
    // mirror 缺省 → 无双轨行（P1 三行块逐字不变）
    expect(buildLegionClimateBlock(climate, { style: 'trend', bars, seed: 7 })).not.toContain('资金加权看多');
  });

  it('P5 传闻行：whaleRumor 非空 → 模板传闻（无身份无数字）；null/缺省 → 省略', () => {
    const climate = climateFixture();
    const rumor = { weightedBullPct: 1, weightedBearPct: 0, whaleRumor: '做多' as const };
    const block = buildLegionClimateBlock(climate, { style: 'technical', bars, seed: 7, mirror: rumor })!;
    expect(block).toContain('盘面风闻有大资金在做多');
    expect(block).not.toMatch(/盘面风闻[^\n]*\d/); // 传闻行不带数字/身份
    const bearish = { weightedBullPct: 0, weightedBearPct: 1, whaleRumor: '做空' as const };
    expect(buildLegionClimateBlock(climate, { style: 'technical', bars, seed: 7, mirror: bearish }))
      .toContain('盘面风闻有大资金在做空');
    expect(buildLegionClimateBlock(climate, { style: 'technical', bars, seed: 7, mirror: { weightedBullPct: 0.5, weightedBearPct: 0.2, whaleRumor: null } }))
      .not.toContain('盘面风闻');
  });
});

describe('buildCommonBlock 公共块（#13）', () => {
  it('包含近 5 日行情、成交变化、宽度、情绪热度、新闻（50 字截断）', () => {
    const block = buildCommonBlock(makeSnapshot());
    expect(block).toContain('【市场全景】');
    expect(block).toContain('近 5 日行情');
    expect(block).toContain('2026-10-25'); // 最近交易日
    expect(block).toContain('成交变化');
    expect(block).toContain('上涨 2800 / 下跌 2100');
    expect(block).toContain('涨停 45');
    expect(block).toContain('最高连板 5 板');
    expect(block).toContain('情绪热度：85.2');
    // 新闻截断 50 字 + 省略号
    expect(block).toContain(`${LONG_NEWS.slice(0, 50)}…`);
    expect(block).not.toContain(LONG_NEWS);
  });

  it('降级数组非空时输出「⚠ … 数据截至 …」标注行；空数组不输出', () => {
    const flagged = buildCommonBlock(
      makeSnapshot({
        degraded: [
          { source: 'xueqiu', asOf: '2026-10-24', degraded: true, note: '使用缓存' },
          { source: 'sina', asOf: '2026-10-25', degraded: false },
        ],
      }),
    );
    expect(flagged).toContain('⚠ xueqiu 数据截至 2026-10-24（使用缓存）');
    expect(flagged).not.toContain('sina 数据截至'); // degraded=false 不标
    expect(buildCommonBlock(makeSnapshot())).not.toContain('⚠');
  });

  it('新闻超过 TopN 只取前 5 条', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ text: `新闻${i}`, ts: '2026-10-25', source: 'sina' as const }));
    const block = buildCommonBlock(makeSnapshot({ news: { items: many, asOf: '2026-10-25' } }));
    expect(block).toContain('新闻0');
    expect(block).toContain('新闻4');
    expect(block).not.toContain('新闻5');
    expect(block).not.toContain('新闻7');
  });
});

describe('buildStyleBlock 风格专属块（#13）', () => {
  it('技术派 → 近 20 日 K 线量能明细', () => {
    const block = buildStyleBlock('technical', makeSnapshot());
    expect(block).toContain('K 线量能');
    const rows = block.split('\n').filter((l) => l.startsWith('2026-'));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toContain('开 ');
    expect(rows[0]).toContain('量 ');
  });

  it('消息党 → 新闻全文（120 字截断）', () => {
    const block = buildStyleBlock('news', makeSnapshot());
    expect(block).toContain('消息党');
    expect(block).toContain(`${LONG_NEWS.slice(0, 120)}…`);
    expect(block).not.toContain(LONG_NEWS);
  });

  it('游资（hotmoney/speculator）→ 涨停梯队/连板高度明细', () => {
    for (const style of ['hotmoney', 'speculator'] as const) {
      const block = buildStyleBlock(style, makeSnapshot());
      expect(block).toContain('涨停梯队');
      expect(block).toContain('涨停 45 家 / 跌停 8 家 / 炸板 12 家');
      expect(block).toContain('炸板率 21.1%'); // 12/(45+12)
      expect(block).toContain('最高 5 板');
    }
  });

  it('trend/contrarian/indexer → 近 20 日收盘序列与均值偏离', () => {
    for (const style of ['trend', 'contrarian', 'indexer'] as const) {
      const block = buildStyleBlock(style, makeSnapshot());
      expect(block).toContain('收盘序列');
      expect(block).toContain('20 日均值');
      expect(block).toContain('现价偏离');
      expect(block).toContain('20 日区间');
    }
  });

  it('均值偏离数值正确（20 日均值 = 简单平均）', () => {
    const closes = makeBars().slice(-20).map((b) => b.close);
    const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
    const dev = ((closes[closes.length - 1] - mean) / mean) * 100;
    const block = buildStyleBlock('trend', makeSnapshot());
    expect(block).toContain(`20 日均值：${String(Number(mean.toFixed(2)))}`);
    expect(block).toContain(`现价偏离：${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%`);
  });
});

describe('buildPersonalBlock 个人块（#49/#48/#52）', () => {
  it('成本锚文案：「成本 3245，现价 3190，浮亏 1.7%」格式（#49）', () => {
    const block = buildPersonalBlock(makeState({ costBasis: 3245 }), makePersona(), 3190);
    expect(block).toContain('成本 3245，现价 3190，浮亏 1.7%');
  });

  it('浮盈同样带符号文案', () => {
    const block = buildPersonalBlock(makeState({ costBasis: 3000 }), makePersona(), 3245);
    expect(block).toContain('成本 3000，现价 3245，浮盈 8.2%');
  });

  it('无成本 → 「空仓」', () => {
    const block = buildPersonalBlock(makeState({ costBasis: null, exposurePct: 0 }), makePersona(), 3190);
    expect(block).toContain('空仓');
    expect(block).not.toContain('成本');
  });

  it('情绪值描述：<30 恐慌 / 30–70 中性 / >70 贪婪（#48）', () => {
    expect(buildPersonalBlock(makeState({ emotion: 22 }), makePersona(), 3190)).toContain('（恐慌');
    expect(buildPersonalBlock(makeState({ emotion: 30 }), makePersona(), 3190)).toContain('（中性');
    expect(buildPersonalBlock(makeState({ emotion: 70 }), makePersona(), 3190)).toContain('（中性');
    expect(buildPersonalBlock(makeState({ emotion: 85 }), makePersona(), 3190)).toContain('（贪婪');
  });

  it('注入记忆摘要（#52）：统计行与明细', () => {
    const state = makeState({ memory: [mem('2026-11-04', 1.2), mem('2026-11-05', -0.9)] });
    const block = buildPersonalBlock(state, makePersona(), 3190);
    expect(block).toContain('近 2 次判断错了 1 次');
    expect(block).toContain('【操作记忆】');
  });

  it('空记忆注入「（你还没有任何操作记忆）」', () => {
    expect(buildPersonalBlock(makeState(), makePersona(), 3190)).toContain('（你还没有任何操作记忆）');
  });

  it('游资带纪律提醒行，散户没有（#49 行为反差）', () => {
    const hot = buildPersonalBlock(makeState(), makePersona({ maxLossPct: 5, style: 'hotmoney' }), 3190);
    expect(hot).toContain('纪律提醒');
    expect(hot).toContain('超过 5%');
    const retail = buildPersonalBlock(makeState(), makePersona(), 3190);
    expect(retail).not.toContain('纪律提醒');
  });
});

describe('buildUserMessage 洗牌与组装（#39/P1）', () => {
  const snapshot = makeSnapshot({ legionClimate: climateFixture() });
  const state = makeState({ memory: [mem('2026-11-05', -0.9)] });
  const persona = makePersona(); // technical（不在气候输出风格中 → 只有全团行）

  it('包含公共块/风格块/个人块与气候行，末尾有输出提醒', () => {
    const msg = buildUserMessage({ snapshot, state, persona, seed: 1 });
    expect(msg).toContain('【市场全景】');
    expect(msg).toContain('技术视角');
    expect(msg).toContain('【个人状态】');
    expect(msg).toContain('军团意见气候（2026-10-24）');
    expect(msg).toContain('随后一个交易日指数 +0.03%');
    expect(msg).toContain('只输出一个严格 JSON 对象');
  });

  it('快照无气候（首轮/旧记录）→ 消息不含气候行（升级后首次运行自愈前省略）', () => {
    const bare = buildUserMessage({ snapshot: makeSnapshot(), state, persona, seed: 1 });
    expect(bare).not.toContain('军团意见气候');
    expect(bare).not.toContain('随后一个交易日');
  });

  it('同 seed 输出完全一致（确定性，含噪声流）', () => {
    const a = buildUserMessage({ snapshot, state, persona, seed: 42 });
    const b = buildUserMessage({ snapshot, state, persona, seed: 42 });
    expect(a).toBe(b);
  });

  it('块序与既有 seed 逐字不变：实际块序 = seededShuffle([0,1,2], mulberry32(seed))（噪声不占洗牌流，P1 验收）', () => {
    const markers = ['【市场全景】', '技术视角', '【个人状态】'];
    for (let seed = 0; seed < 30; seed += 1) {
      const msg = buildUserMessage({ snapshot, state, persona, seed });
      const idxs = markers.map((mk) => msg.indexOf(mk));
      const actual = idxs
        .map((idx, i) => ({ idx, i }))
        .sort((a, b) => a.idx - b.idx)
        .map((o) => o.i);
      expect(actual).toEqual(seededShuffle([0, 1, 2], mulberry32(seed >>> 0)));
    }
  });

  it('不同 seed：除气候噪声行外，行内容集合不变（只动顺序，#39）', () => {
    const isClimateLine = (l: string): boolean =>
      l.startsWith('军团意见气候') || l.startsWith('你同风格') || l.startsWith('风闻') || l.startsWith('随后一个交易日');
    const sortedLines = (msg: string): string =>
      msg.split('\n').filter((l) => !isClimateLine(l)).sort().join('|');
    const ref = sortedLines(buildUserMessage({ snapshot, state, persona, seed: 0 }));
    for (let seed = 1; seed < 30; seed += 1) {
      expect(sortedLines(buildUserMessage({ snapshot, state, persona, seed }))).toBe(ref);
    }
  });

  it('块序在多个 seed 下确实发生变化（洗牌生效）', () => {
    const orderOf = (msg: string): string => {
      const markers = ['【市场全景】', '技术视角', '【个人状态】'];
      return markers
        .map((mk) => ({ idx: msg.indexOf(mk), i: markers.indexOf(mk) }))
        .sort((a, b) => a.idx - b.idx)
        .map((o) => o.i)
        .join('');
    };
    const orders = new Set(
      Array.from({ length: 30 }, (_, seed) => orderOf(buildUserMessage({ snapshot, state, persona, seed }))),
    );
    expect(orders.size).toBeGreaterThan(1); // 至少两种块序
    expect(orders.size).toBeLessThanOrEqual(6); // 3! 全排列上限
  });
});

// ---------- v1.4 #62：公共块「机构动向」行 + 封闭面零泄漏 ----------
import { buildInstLine } from '../src/engine/info-set.js';
import type { InstitutionFlow, InstPathFlow } from '../src/engine/types.js';

function mkInstPath(pathId: InstPathFlow['pathId'], netFlowYi: number | null, signals: Record<string, unknown> = {}, asOf: string | null = '2026-11-10'): InstPathFlow {
  return { pathId, label: pathId, netFlowYi, signals, asOf, note: null };
}
function mkInst(): InstitutionFlow {
  return {
    asOf: '2026-11-11',
    netFlowYi: 12.0,
    paths: [
      mkInstPath('margin', 12.0, { sseAsOf: '2026-11-10', maintenanceRatio: 260.88, maintenanceAsOf: '2026-11-10' }),
      mkInstPath('etfSse', -14.96, { bondYi: -23.51, moneyYi: null, otherYi: 2.65, crossBorderYi: 4.09 }, '2026-11-11'),
      mkInstPath('eventSeat', -1.3, { lhbYi: -2.5, dzjyYi: 1.2, lhbAsOf: '2026-11-11', dzjyAsOf: '2026-11-11' }, '2026-11-11'),
      mkInstPath('quarterlyStructure', null, { fundHoldCount: { asOf: '2026-09-30', increaseCount: 390, decreaseCount: 3467 }, hkscHolding: { asOf: '2026-09-30', totalStocks: 3040 } }, '2026-09-30'),
      mkInstPath('northbound', null, { southboundNetYi: 45.72, southboundAsOf: '2026-11-11' }, '2026-11-11'),
    ],
    degraded: [],
  };
}

describe('公共块「机构动向」行（v1.4 #62，零 LLM 模板）', () => {
  it('margin +12.0 → 「两融净流入 +12.0 亿（截至 2026-11-10，T+1）」；维持担保比例进文案', () => {
    const block = buildCommonBlock(makeSnapshot({ inst: mkInst() }));
    expect(block).toContain('两融净流入 +12.0 亿（截至 2026-11-10，T+1）');
    expect(block).toContain('平均维持担保比例 260.9');
    expect(block).toContain('安全垫参考，不计入净流');
  });
  it('bondYi −23.51 只进旁注并明示「不计入净流口径」，不与 A 股净额相加展示', () => {
    const block = buildCommonBlock(makeSnapshot({ inst: mkInst() }));
    expect(block).toContain('债券 ETF 申赎 -23.5 亿');
    expect(block).toContain('均不计入净流口径（signals 分桶）');
    expect(block).toContain('沪市 A股ETF 净申购 -15.0 亿（深市份额不可观测）');
    // 相加值 -15.0 + (-23.5) = -38.5 不得出现
    expect(block).not.toContain('-38.5');
  });
  it('事件席位子句点名数据源（龙虎榜/大宗）与 T+0 盘后；季频子句带报告期滞后标注', () => {
    const block = buildCommonBlock(makeSnapshot({ inst: mkInst() }));
    expect(block).toContain('龙虎榜机构席位净买 -2.5 亿');
    expect(block).toContain('大宗「机构专用」净买 +1.2 亿');
    expect(block).toContain('T+0 盘后');
    expect(block).toContain('公募基金季报增持 390 家/减持 3467 家（报告期 2026-09-30，滞后披露）');
    expect(block).toContain('香港中央结算（北向季度代理）持有 3040 只（报告期 2026-09-30，滞后 30–40 天）');
  });
  it('北向 null → 未披露（上游 2024-08 起停报）；南向只出现在「资金分流，非北向」子句', () => {
    const block = buildCommonBlock(makeSnapshot({ inst: mkInst() }));
    expect(block).toContain('北向每日净买：未披露（上游 2024-08 起停报）');
    expect(block).toContain('南向（资金分流，非北向）+45.7 亿');
  });
  it('行在资金面行之后、新闻要点之前；不新增洗牌块（buildUserMessage 块序不变）', () => {
    const snap = makeSnapshot({ inst: mkInst() });
    const block = buildCommonBlock(snap);
    const fundsIdx = block.indexOf('资金面：');
    const instIdx = block.indexOf('机构动向：');
    const newsIdx = block.indexOf('新闻要点：');
    expect(instIdx).toBeGreaterThan(fundsIdx);
    expect(instIdx).toBeLessThan(newsIdx);
  });
  it('inst 缺省（旧缓存快照）→ 整行省略（#64 additive 自愈）', () => {
    expect(buildCommonBlock(makeSnapshot())).not.toContain('机构动向：');
  });
  it('全源 null → 整行兜底文案「今日无可用机构数据」', () => {
    const allNull = mkInst();
    for (const p of allNull.paths) {
      p.netFlowYi = null;
      p.signals = p.pathId === 'northbound' ? { southboundNetYi: null } : {};
    }
    expect(buildInstLine(allNull)).toBe('机构动向：今日无可用机构数据（各源降级，如实标注）');
  });
  it('机构行与 whaleRumor 解耦：机构行无「大资金/主力」模糊身份词（#14 边界）', () => {
    const line = buildInstLine(mkInst()) ?? '';
    expect(line).not.toContain('大资金');
    expect(line).not.toContain('主力');
  });

  // 封闭面（#62）：机构内容只进公共块，情绪/个人/气候块零泄漏
  it('封闭面：buildPersonalBlock / buildLegionClimateBlock 不含机构内容（负证据断言）', () => {
    const persona = makePersona();
    const state: AgentState = { personaId: persona.id, cash: 100000, exposurePct: 10, costBasis: 3200, emotion: 60, memory: [] };
    const personal = buildPersonalBlock(state, persona, 3245, 0.01);
    for (const kw of ['机构', '两融净流入', 'A股ETF', '龙虎榜', '大宗', '维持担保']) {
      expect(personal).not.toContain(kw);
    }
    const climate = buildLegionClimateBlock(
      { asOf: '2026-10-24', overall: { bullPct: 0.6, bearPct: 0.2, neutralPct: 0.2, count: 30 }, byStyle: {} },
      { style: persona.style, bars: makeBars(), seed: 7, mirror: { weightedBullPct: 0.6, weightedBearPct: 0.2, whaleRumor: '做多' } },
    );
    for (const kw of ['机构', '两融', 'ETF', '龙虎榜', '大宗']) {
      expect(climate).not.toContain(kw);
    }
  });
  it('buildUserMessage 含机构动向行（经由公共块），风格/个人块结构不变', () => {
    const persona = makePersona();
    const state: AgentState = { personaId: persona.id, cash: 100000, exposurePct: 10, costBasis: null, emotion: 60, memory: [] };
    const msg = buildUserMessage({ snapshot: makeSnapshot({ inst: mkInst() }), state, persona, seed: 42 });
    expect(msg).toContain('机构动向：');
  });
});
