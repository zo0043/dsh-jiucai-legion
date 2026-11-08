/**
 * 韭菜军团 — 引擎领域类型（全仓唯一事实来源）
 * 对应 docs/技术设计.md §4；需求 ID（#N）见字段注释。
 */

export const SCHEMA_VERSION = 1;

// ---------- 基础枚举 ----------

export type IndexId = 'SH000001' | 'CSI300';

/** 7 类风格：trend 趋势 / contrarian 逆向 / technical 技术派 / news 消息党 / hotmoney 打板 / indexer 指数定投 / speculator 接力 */
export type Style = 'trend' | 'contrarian' | 'technical' | 'news' | 'hotmoney' | 'indexer' | 'speculator';

/** 立场先验（#39，写进系统提示，与风格锚兼容） */
export type Stance = 'bull' | 'bear' | 'range';

/** 行为偏差标签（#49，散户内置） */
export type Bias = 'loss_aversion' | 'breakeven' | 'chasing' | 'anchoring';

/** 资金规模档位 1–4（聚合权重 [1,2,4,8]，#43） */
export type CapitalTier = 1 | 2 | 3 | 4;

export const HOT_MONEY_STYLES: Style[] = ['hotmoney', 'speculator'];

// ---------- 人设与状态 ----------

export interface Persona {
  id: string;
  name: string;
  style: Style;
  capitalTier: CapitalTier;
  /** 情绪稳定性 0.5–2.0，越低情绪波动越大（#48 三维矩阵） */
  stability: number;
  stance: Stance;
  biases: Bias[];
  /** 游资纪律条款（#49）：亏损超此比例无条件减仓；散户为 null */
  maxLossPct: number | null;
  /** 情绪基线 0–100（#48） */
  baseline: number;
  /** 编译产物，风格锚，终身不重写（#15） */
  systemPrompt: string;
}

export interface MemoryItem {
  day: string;
  action: string;
  targetPct: number;
  confidence: number;
  realizedPnlPct: number | null;
  reason: string;
  /**
   * 判断方向（P2 方向结算）：push 时 sign(targetPct−exposurePct)，|delta|≤1 记 0（持稳不判方向）。
   * 可选：旧落盘状态文件无该字段 → undefined 视为未结算、不进方向统计（升级后新判断自愈）。
   */
  intendedDir?: -1 | 0 | 1;
  /**
   * 方向结算结果（P2，%）：intendedDir × 判断日次一交易日涨跌 × 100；null/缺省 = 待结算
   * （判断日次日 bar 尚不可得，保持未结算、不进统计）。
   */
  judgmentRet?: number | null;
  /** 纪律止损豁免标记（P2/#49）：游资 maxLossPct 触发的止损减仓，方向结算不计「错」 */
  stopLoss?: boolean;
}

export interface AgentState {
  personaId: string;
  cash: number;
  /** 当前指数敞口 0–100（#12 仓位制） */
  exposurePct: number;
  /** 平均成本价（#49 成本锚）；无持仓为 null */
  costBasis: number | null;
  /** 情绪值 0–100（#48） */
  emotion: number;
  memory: MemoryItem[];
}

// ---------- 市场快照 ----------

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 市场宽度（#22 千股千评替换项）。
 * Python 侧（breadth.py）任一池降级时对应字段实发 null（#24 分级降级）——
 * 字段因此可空，渲染层必须判空显示「未知/不可用」，不得当 0 参与计算（F23）。
 */
export interface Breadth {
  limitUp: number | null;
  limitDown: number | null;
  failedBoard: number | null;
  maxStreak: number | null;
  advancers: number | null;
  decliners: number | null;
}

export interface SentimentInfo {
  source: 'xueqiu' | 'eastmoney';
  heatIndex: number;
  asOf: string;
}

export interface NewsItem {
  text: string;
  ts: string;
  source: 'sina' | 'cls';
}

export interface FundsInfo {
  marginBalance: number | null;
  northboundNet: number | null;
  /** 资金面块整体数据截至（两融/北向中较新者，测试口径锁定） */
  asOf: string;
  /** 两融余额实际交易日（T+1 披露，#47）；旧快照缺失 → undefined */
  marginAsOf?: string | null;
  /** 北向数据实际交易日；上游 2024-08 停披露 → 值为 null 但日期可能存在 */
  northAsOf?: string | null;
}

export interface DataSourceFlag {
  source: string;
  asOf: string;
  degraded: boolean;
  note?: string;
}

/**
 * 意见气候统计（P1）：按**目标仓位水平**测观点（≥70 看多 / ≤30 看空 / 其余观望）。
 * 与 #26 报告页的动作差口径（bullBearSplit：target vs current）互补——
 * 单边满仓行情中动作差口径看多比例为 0，气候口径仍能报出真实看多浓度。
 */
export interface ClimateStats {
  bullPct: number;
  bearPct: number;
  neutralPct: number;
  /** 样本数（该组有效输出数） */
  count: number;
}

/**
 * 军团意见气候（P1，#50「一句」升级）：全团＋分风格气候与形成日。
 * asOf = 产生该轮输出的交易日所见的最后已收盘 bar 日期；
 * 跨运行注入时仅当 asOf 严格早于当前末根才拼「随后一个交易日」结果子句（同日重跑不拼）。
 */
export interface LegionClimate {
  asOf: string;
  overall: ClimateStats;
  byStyle: Partial<Record<Style, ClimateStats>>;
}

/**
 * 军团资金镜像（P5 社会镜像精度）：资金加权看多/看空与集中度传闻。
 * 分母一律取参战者权重和（描述在场资金结构；缺员轮已有部分失败口径标注【技术默认】）。
 */
export interface LegionMirror {
  /** 资金加权看多/看空份额（口径对齐 opinionClimate 的仓位水平测观点，权重按 agentWeight #43） */
  weightedBullPct: number;
  weightedBearPct: number;
  /**
   * 集中度传闻（#14 边界：无身份、无具体操作）：领先阵营（按阵营权重和）内
   * 最大单一权重占比超过 cfg.whaleRumorThresholdPct 时给出方向（做多/做空）；
   * 领先阵营为观望或未超阈值 → null。
   */
  whaleRumor: '做多' | '做空' | null;
}

export interface MarketSnapshot {
  index: IndexId;
  /** Asia/Shanghai 交易日（#38 时区固定） */
  tradeDate: string;
  /** 至少 250 交易日历史（#45 首跑回补） */
  bars: Bar[];
  breadth: Breadth;
  sentiment: SentimentInfo;
  news: { items: NewsItem[]; asOf: string };
  funds: FundsInfo;
  /** 20 日年化波动率（#21 冲击系数标定输入） */
  volatility20: number;
  /** 军团上轮看多比例 0–1（#50 回流；首轮 null）。派生值：口径 = legionClimate.overall.bullPct（P1），保留供旧消费方 */
  legionBullPct: number | null;
  /**
   * 军团意见气候（P1）：由调用方注入（预测前取上一已结算轮结果）或递推逐日滚动；
   * 首轮/旧快照缺省（undefined/null）→ 气候块整块省略。
   */
  legionClimate?: LegionClimate | null;
  /** 军团资金镜像（P5）：与气候同路径注入/滚动；缺省 → 双轨行与传闻行省略 */
  legionMirror?: LegionMirror | null;
  degraded: DataSourceFlag[];
}

// ---------- 运行结果 ----------

export interface AgentOutput {
  personaId: string;
  /** 目标仓位 0–100 */
  targetPct: number;
  confidence: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

export interface RoundResult {
  round: number;
  outputs: AgentOutput[];
  /** 重试后仍失败的 Agent（#54） */
  missing: string[];
  /** 有效参与人数（outputs.length） */
  participants: number;
  netFlow: number;
  direction: -1 | 0 | 1;
  offsetPct: number;
}

export interface EventCard {
  id: string;
  sectors: string[];
  direction: -1 | 1;
  strength: 1 | 2 | 3 | 4 | 5;
  text: string;
  injectedDay: string;
  /** 线性衰减天数（#42 默认 2，面板可调） */
  decayDays: number;
}

/** 阵营代表发言（P5）：结构化署名素材，渲染「@昵称（风格·N档）：理由」 */
export interface CampQuote {
  personaId: string;
  /** 署名（P5） */
  name: string;
  style: Style;
  capitalTier: CapitalTier;
  reason: string;
}

export interface CampSummary {
  camp: 'bull' | 'bear' | 'neutral';
  count: number;
  avgTargetPct: number;
  avgEmotion: number;
  /**
   * 该阵营资金权重 ÷ 参战者权重和（P5 资金镜像；分母=参战者权重和——描述在场资金结构，
   * 与冲击映射分母语义相互独立；缺员轮已有部分失败口径标注【技术默认】）。
   */
  weightShare: number;
  quotes: CampQuote[];
}

export interface EditorReport {
  markdown: string;
  camps: CampSummary[];
  /** 分歧度话术素材（#30） */
  dispersionNote: string;
  /** 「本轮仅 N/30 参战」类标注（#54） */
  participationNote: string | null;
}

export interface DayPrediction {
  tradeDate: string;
  netFlowMedian: number;
  direction: -1 | 0 | 1;
  offsetPct: number;
  closeEstimate: number;
  band: { p10: number; p90: number };
}

export interface PredictionResult {
  schemaVersion: number;
  mode: 'prediction';
  index: IndexId;
  anchorDate: string;
  /** ISO 时间戳 */
  runAt: string;
  /** 「盘中运行，锚定 X 日收盘」标注（#46）；盘后运行 null */
  intradayNote: string | null;
  /** 逐日路径（#36，5 条，带置信区间） */
  days: DayPrediction[];
  terminal: { dist: number[]; median: number };
  multiBullPct: number;
  multiBearPct: number;
  /** 分歧度过窄告警（#39） */
  dispersionNarrow: boolean;
  /** 情绪/新闻冷启动标注（#45） */
  coldStartNote: string | null;
  representativeQuotes: { personaId: string; reason: string }[];
  report: EditorReport;
  /** K 轮轨迹（回放源） */
  rounds: RoundResult[];
  /**
   * 军团意见气候（P1）：锚定日中位轮口径，供下一运行经 store.loadPrediction 跨运行注入。
   * 旧落盘记录无该字段 → 视为 null → 气候块省略，升级后首次运行自愈（#28 向后兼容）。
   */
  legionClimate?: LegionClimate | null;
  /** 军团资金镜像（P5）：锚定日中位轮口径，跨运行注入同 legionClimate（旧记录缺失 → null） */
  legionMirror?: LegionMirror | null;
  /** mock 运行标记（F21）：脚本化 LLM 产生的结果，面板显示徽章、对账不计入命中率 */
  mock?: boolean;
}

export interface SandboxDay {
  tradeDate: string;
  dayIndex: number;
  netFlow: number;
  direction: -1 | 0 | 1;
  close: number;
  legionBullPct: number;
  activeEvents: { id: string; text: string; weight: number }[];
  round: RoundResult;
}

export interface SandboxResult {
  schemaVersion: number;
  mode: 'sandbox';
  index: IndexId;
  startDate: string;
  runAt: string;
  days: SandboxDay[];
  /** 「沙盘 N 日后数据为内生推演」（#41） */
  note: 'exogenous frozen at day0, decaying';
  report: EditorReport;
  /** 军团意见气候（P1）：末轮口径，供跨运行读取；旧落盘记录缺失 → 视为 null（#28 向后兼容） */
  legionClimate?: LegionClimate | null;
  /** 军团资金镜像（P5）：末轮口径，供跨运行读取；旧落盘记录缺失 → 视为 null（#28 向后兼容） */
  legionMirror?: LegionMirror | null;
  /** mock 运行标记（F21）：脚本化 LLM 产生的结果，面板显示徽章、对账不计入命中率 */
  mock?: boolean;
}

export interface ReconcileRecord {
  anchorDate: string;
  horizon: '1d' | '5d';
  index: IndexId;
  predictedDirection: -1 | 0 | 1;
  predictedMedianPct: number;
  /** 结算后写入 */
  actualPct: number | null;
  /** hit | miss | tie（平局剔除分母，#44） */
  outcome: 'hit' | 'miss' | 'tie' | null;
  settledAt: string | null;
  /** mock 运行产生（F21）：true = 脚本化演示数据，不计入命中率统计 */
  mock?: boolean;
}

// ---------- 配置（#28 默认值零手调；设置页可调项见注释） ----------

export interface EngineConfig {
  index: IndexId;
  /** 可选模型 ID（#7）；独立运行器直连时必填 */
  modelId?: string;
  seed: number;
  /** 并发路数（#54） */
  concurrency: number;
  /** 单 Agent 重试次数（#54 默认 2） */
  agentRetries: number;
  /** 部分失败下限（#54 默认 24/30） */
  quorumFloor: number;
  /** 游资放大系数（#43 可调，默认 3；设置 schema 见 src/config.ts SETTING_FIELDS） */
  hotMoneyAmp: number;
  /** 沙盘每日采样轮数（#38 高级选项，默认 1） */
  sandboxK: number;
  /** 事件卡衰减天数（#42 默认 2） */
  eventDecayDays: number;
  /** 冲击系数（#21 一期未校准默认 0.8） */
  impactK: number;
  /**
   * 集中度传闻阈值（P5，%）：领先阵营内最大单一权重占该阵营权重和的比例超过此值 →
   * 信息集公共块追加模板传闻「盘面风闻有大资金在做多/做空」（#14：无身份无具体操作）。
   */
  whaleRumorThresholdPct: number;
  /** 平局阈值 %（#44 默认 0.1） */
  tieThresholdPct: number;
  /** 情绪引擎常量（#48 可调） */
  emotion: {
    eventWeight: number;
    pnlWeight: number;
    marketWeight: number;
    /**
     * 情绪惯性残留 λ（P3）：e = baseline + λ·(prev−baseline) + (1−λ)·asym·shock。
     * 补齐 #48「逐日衰减回人设基线」的时间尾（旧公式三源中两源零日衰减）；
     * 0 = 逐日锚定基线重算（旧行为）。持续冲击稳态 = baseline + asym·shock，无棘轮放大。
     */
    carryover: number;
    /** 负面不对称（P3，bad is stronger）：shock<0 时的冲击放大系数；1 = 对称（旧行为）。 */
    negativeAsym: number;
  };
  /** 回补历史长度（#45 默认 250） */
  historyDays: number;
  /** 沙盘外生衰减天数（#41） */
  exogenousDecayDays: number;
  pythonBin: string;
  dataDir: string;
}

export const DEFAULT_CONFIG: EngineConfig = {
  index: 'SH000001',
  seed: 2026,
  concurrency: 6,
  agentRetries: 2,
  quorumFloor: 24,
  hotMoneyAmp: 3,
  sandboxK: 1,
  eventDecayDays: 2,
  impactK: 0.8,
  whaleRumorThresholdPct: 40,
  tieThresholdPct: 0.1,
  emotion: { eventWeight: 4, pnlWeight: 6, marketWeight: 400, carryover: 0.6, negativeAsym: 1.3 },
  historyDays: 250,
  exogenousDecayDays: 5,
  pythonBin: 'python3',
  dataDir: 'data',
};

// ---------- 聚合常量（#43） ----------

export const CAPITAL_WEIGHTS: Record<CapitalTier, number> = { 1: 1, 2: 2, 3: 4, 4: 8 };
