/**
 * what-if 事件卡（需求 #19/#42）：一句话 → 结构化事件卡（LLM 展开）→ 定向注入 + 线性衰减。
 */
import type { HostPorts } from '../host/ports.js';
import type { EngineConfig, EventCard, MarketSnapshot, Persona, Style } from './types.js';
import { collectStream } from './orchestrator.js';
import { eventContribution } from './emotion.js';

/** 事件卡展开提示词（#19） */
function eventPrompt(text: string): string {
  return [
    '把下面这条市场消息展开成结构化事件卡，只输出严格 JSON，不要输出其他内容：',
    '{"sectors":["板块名"],"direction":-1或1,"strength":1到5,"summary":"一句话概括"}',
    'direction=-1 表示利空，1 表示利空；strength 反映对市场情绪的冲击强度。',
    `市场消息：${text}`,
  ].join('\n');
}

/** LLM 展开事件卡；解析失败重试 1 次，仍失败抛错（调用方给用户人话提示，#28） */
export async function parseEventCard(
  ports: HostPorts,
  text: string,
  today: string,
  cfg: EngineConfig,
): Promise<EventCard> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await collectStream(ports, { messages: [{ role: 'user', content: eventPrompt(text) }] });
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('no json');
      const obj = JSON.parse(m[0]) as { sectors?: unknown; direction?: unknown; strength?: unknown; summary?: unknown };
      const sectors = Array.isArray(obj.sectors) ? obj.sectors.map(String) : [];
      const direction = obj.direction === -1 ? -1 : 1;
      const strength = Math.min(5, Math.max(1, Math.round(Number(obj.strength) || 3))) as 1 | 2 | 3 | 4 | 5;
      const summary = typeof obj.summary === 'string' && obj.summary.length > 0 ? obj.summary : text;
      return {
        id: `ev-${today}-${Math.floor(Math.random() * 1e6)}`,
        sectors,
        direction,
        strength,
        text: summary,
        injectedDay: today,
        decayDays: cfg.eventDecayDays,
      };
    } catch {
      if (attempt === 1) throw new Error('事件卡展开失败：请换一种说法再试（例如写明板块与利好/利空）');
    }
  }
  throw new Error('unreachable');
}

/**
 * 定向注入判定（#42）：消息党/游资必看；其余风格按强度（≥4 全员可见）
 * 或种子随机（50%）决定。
 */
export function agentSeesCard(card: EventCard, persona: Persona, seed: number): boolean {
  if (persona.style === 'news' || persona.style === 'hotmoney' || persona.style === 'speculator') return true;
  if (card.strength >= 4) return true;
  // mulberry32 单步采样
  let t = seed + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return r < 0.5;
}

/** 某 Agent 在某模拟日从全部活跃事件卡获得的情绪贡献（#42 定向注入 + 线性衰减） */
export function cardContributions(
  cards: EventCard[],
  persona: Persona,
  currentDay: string,
  cfg: EngineConfig,
  seed: number,
): number {
  let total = 0;
  for (const card of cards) {
    if (!agentSeesCard(card, persona, seed + card.id.length * 31 + card.strength)) continue;
    const dayOffset = daysBetween(card.injectedDay, currentDay);
    if (dayOffset < 0 || dayOffset >= card.decayDays) continue;
    total += eventContribution(card, dayOffset, cfg);
  }
  return total;
}

/** 活跃事件（面板沙盘页展示，#26） */
export function activeEvents(cards: EventCard[], currentDay: string): { id: string; text: string; weight: number }[] {
  return cards
    .map((c) => {
      const off = daysBetween(c.injectedDay, currentDay);
      const weight = off < 0 || off >= c.decayDays ? 0 : Math.max(0, 1 - off / c.decayDays);
      return { id: c.id, text: c.text, weight };
    })
    .filter((e) => e.weight > 0);
}

/** 一键剧本推荐（#33/#51）：LLM 生成 3 个，失败回退预设 */
export async function recommendScripts(ports: HostPorts, snapshot: MarketSnapshot): Promise<string[]> {
  const fallback = [
    '央行宣布全面降准 0.5 个百分点，释放长期流动性',
    '海外科技股昨晚暴跌，情绪传染到 A 股',
    '重磅产业政策出台，科技板块集体涨停',
  ];
  try {
    const raw = await collectStream(ports, {
      messages: [{
        role: 'user',
        content: `基于当前市场（最近收盘 ${snapshot.tradeDate}，涨停 ${snapshot.breadth.limitUp ?? '未知'} 家、跌停 ${snapshot.breadth.limitDown ?? '未知'} 家），给出 3 条一句话 what-if 剧本，每条不超过 40 字，逐行输出，不要编号。`,
      }],
    });
    const lines = raw.split('\n').map((l) => l.trim().replace(/^[-\d.、\s]+/, '')).filter((l) => l.length > 5);
    return lines.length >= 3 ? lines.slice(0, 3) : fallback;
  } catch {
    return fallback;
  }
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return -1;
  return Math.round((b - a) / 86_400_000);
}

export type { Style };
