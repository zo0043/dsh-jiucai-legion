/**
 * 韭菜军团 — 系统提示编译器与输出解析（需求 #11/#15/#39/#49）。
 *
 * - compileSystemPrompt：人设卡（风格锚/资金档/立场先验/偏差标签/游资纪律条款）
 *   + 输出 JSON 契约（OUTPUT_CONTRACT）+「人设与风格锚不可变」声明（#15）
 *   + 股吧体语气要求（#34：轻松自嘲但数据严谨）。编译一次、终身不重写（#15 风格锚）。
 * - parseAgentOutput：容错解析 Agent 原始输出——剥 markdown 代码栅栏、截取第一个
 *   {...} JSON 块、clamp targetPct/confidence、截断 reason；解析不了抛 ParseError，
 *   调用方（orchestrator）据此计入重试次数（#54）。
 *
 * 只 import types.js，不依赖宿主端口（引擎核分层铁律 #8/#9）。
 */
import type { AgentOutput, Bias, CapitalTier, Persona, Stance, Style } from './types.js';

// ---------- 展示用中文标签（人设卡素材） ----------

/** 7 类风格的中文锚标签（导出供 info-set 气候块的风格行复用，P1） */
export const STYLE_LABEL: Record<Style, string> = {
  trend: '趋势跟踪',
  contrarian: '逆向操作',
  technical: '技术分析',
  news: '消息驱动',
  hotmoney: '打板游资',
  indexer: '指数定投',
  speculator: '情绪接力',
};

/** 风格行为描述（写进人设卡，LLM 据此演出，不做硬编码干预，#49） */
const STYLE_DESC: Record<Style, string> = {
  trend: '顺势而为、右侧追强，看重均线方向与趋势延续，不轻易逆势',
  contrarian: '人多的地方不去，喜欢逆向抄底摸顶、博超跌反弹',
  technical: '只看 K 线、量能和技术指标，图形说话，不听消息',
  news: '跟着消息与热点走，盘后新闻必刷，闻风而动',
  hotmoney: '打板敢死队风格，只做最强龙头，快进快出，是军团的情绪放大器',
  indexer: '指数定投党，不看个股，跌多了就补一点，长期主义',
  speculator: '情绪周期接力，卡位半路，做情绪溢价持续性',
};

/** 立场先验中文描述（#39 发散三件套之一：人设注入立场先验） */
const STANCE_LABEL: Record<Stance, string> = {
  bull: '偏多（逢低看多的倾向）',
  bear: '偏空（逢高看空的倾向）',
  range: '震荡（高抛低吸的倾向）',
};

/** 资金档位中文标签（档位 1–4 对应聚合权重 [1,2,4,8]，#43） */
const TIER_LABEL: Record<CapitalTier, string> = {
  1: '小散',
  2: '普通散户',
  3: '大户型',
  4: '游资级大户',
};

/** 行为偏差中文描述（#49：写进系统提示由 LLM 演出） */
const BIAS_DESC: Record<Bias, string> = {
  loss_aversion: '损失厌恶——亏钱的痛感远大于赚钱的快感，容易过早止盈、死扛亏损',
  breakeven: '回本执念——盯着成本价，一回本就想跑，深套反而躺平装死',
  chasing: '追涨——看到大阳线怕踏空，忍不住追进去',
  anchoring: '锚定成本——决策围绕自己的成本价而不是市场本身',
};

/**
 * 输出 JSON 契约（#12/#15）。所有 Agent 的系统提示都原样包含本段；
 * 解析端 parseAgentOutput 与之配套。
 */
export const OUTPUT_CONTRACT =
  '【输出契约】你只能输出一个严格的 JSON 对象，除此之外不要输出任何内容' +
  '（禁止 markdown 代码栅栏、禁止解释、禁止客套话）：\n' +
  '{"target_position_pct": <0到100的整数>, "confidence": <1到5的整数>, "reason": "<不超过30个字的一句话理由>"}';

/**
 * 编译 Agent 系统提示（#11/#15/#39/#49）。
 * 内容 = 人设卡（风格锚/资金档/立场先验/偏差或游资纪律/情绪基线）
 *      + 「风格锚不可变」声明 + 股吧体语气要求（#34）+ 输出契约。
 * 返回值写入 Persona.systemPrompt，编译一次终身不重写（#15）。
 */
export function compileSystemPrompt(p: Persona): string {
  const lines: string[] = [];
  lines.push(`你是 A 股散户群体博弈模拟「韭菜军团」中的成员「${p.name}」（编号 ${p.id}）。你交易的是指数，不是个股。`);
  lines.push('');
  lines.push('【人设卡】');
  lines.push(`- 风格锚：${STYLE_LABEL[p.style]}——${STYLE_DESC[p.style]}`);
  lines.push(`- 资金档位：第 ${p.capitalTier} 档（${TIER_LABEL[p.capitalTier]}）`);
  lines.push(`- 立场先验：${STANCE_LABEL[p.stance]}（这是你的默认倾向，允许被当日信息修正，但不能违背风格锚）`);
  if (p.biases.length > 0) {
    lines.push(`- 行为偏差：${p.biases.map((b) => BIAS_DESC[b]).join('；')}`);
  }
  if (p.maxLossPct !== null) {
    lines.push(`- 游资纪律：单日亏损超过 ${p.maxLossPct}% 无条件减仓，不心存侥幸、不抗单——这是你和散户最大的行为反差。`);
  }
  lines.push(`- 情绪基线：${p.baseline}/100（0=恐慌，100=贪婪，你日常回到这个基调附近）`);
  lines.push('');
  lines.push('【铁律】人设与风格锚不可变，盈亏和情绪不能改变你的风格：赚了你还是这个风格，亏了你还是这个风格；盈亏与情绪只影响你的语气和激进程度，不改变你的打法。');
  lines.push('');
  lines.push('【语气】股吧体：轻松自嘲、接地气、可以玩梗（例如「军团兄弟今天 63% 看多，杀疯了」），但引用的数据必须严谨，禁止编造数字。');
  lines.push('');
  lines.push(OUTPUT_CONTRACT);
  return lines.join('\n');
}

// ---------- 输出解析（#12 配套，#54 重试计数入口） ----------

/** 解析失败异常：调用方捕获后对该 Agent 计重试（#54），重试仍失败记缺失。 */
export class ParseError extends Error {
  readonly personaId: string;
  /** 原始输出前 200 字符，便于落盘排障 */
  readonly rawSnippet: string;

  constructor(personaId: string, raw: string, message?: string) {
    super(message ?? `Agent ${personaId} 的输出无法解析为输出契约 JSON`);
    this.name = 'ParseError';
    this.personaId = personaId;
    this.rawSnippet = raw.slice(0, 200);
  }
}

/** 剥掉 markdown 代码栅栏（``` / ```json），保留栅栏间内容 */
function stripFences(raw: string): string {
  return raw.replace(/```[a-zA-Z]*/g, '').replace(/```/g, '');
}

/**
 * 截取第一个平衡的 {...} JSON 块（容忍前后夹杂说明文字）。
 * 扫描器感知字符串与转义，reason 里出现花括号/引号不会截断错位。
 */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** 宽容取数：接受 number 或数字字符串，其余（含 NaN/Infinity）返回 null */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 容错解析 Agent 原始输出为 AgentOutput（#12 配套）。
 * - 剥代码栅栏、截取第一个 {...} JSON 块后 JSON.parse；
 * - target_position_pct（兼容驼峰 targetPct）clamp 到 0–100 并取整；
 * - confidence clamp 到 1–5 并取整；
 * - reason 超长截断到 60 字符（按 Unicode 码点，避免劈开代理对）；
 * - 无法解析（无 JSON 块 / JSON 非对象 / 关键字段缺失或非数值）抛 ParseError（#54）。
 */
export function parseAgentOutput(personaId: string, raw: string): AgentOutput {
  const jsonText = extractFirstJsonObject(stripFences(raw));
  if (jsonText === null) throw new ParseError(personaId, raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new ParseError(personaId, raw);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ParseError(personaId, raw);
  }
  const obj = parsed as Record<string, unknown>;
  const target = toFiniteNumber(obj.target_position_pct ?? obj.targetPct);
  const confidence = toFiniteNumber(obj.confidence);
  if (target === null || confidence === null) {
    throw new ParseError(personaId, raw);
  }
  const reasonRaw =
    typeof obj.reason === 'string'
      ? obj.reason
      : obj.reason === null || obj.reason === undefined
        ? ''
        : String(obj.reason);
  return {
    personaId,
    targetPct: clampNum(Math.round(target), 0, 100),
    confidence: clampNum(Math.round(confidence), 1, 5) as AgentOutput['confidence'],
    reason: Array.from(reasonRaw).slice(0, 60).join(''),
  };
}
