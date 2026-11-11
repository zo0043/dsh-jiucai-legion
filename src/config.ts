/**
 * 配置中心 —— Schemastery 同构 schema + 默认值（需求 #26 设置页 / #28 零手调）。
 * dsh-adapter 用此 schema 渲染设置卡片；独立运行器读同一份默认值。
 */
import type { EngineConfig, IndexId } from './engine/types.js';
import { DEFAULT_CONFIG } from './engine/types.js';

/** 设置页滑杆/选项描述（供 Schemastery 渲染与文档生成共用） */
export interface SettingField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'select' | 'boolean';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
  /** role('secret') 标记（#28） */
  secret?: boolean;
  note?: string;
}

export const SETTING_FIELDS: SettingField[] = [
  { key: 'index', label: '标的指数', type: 'select', options: [
    { value: 'SH000001', label: '上证指数' },
    { value: 'CSI300', label: '沪深300' },
  ], default: 'SH000001', note: '情绪/宽度为全市场口径，资金面取最贴近口径（#47）' },
  { key: 'modelId', label: '模型 ID（留空用宿主默认）', type: 'string', default: '', secret: false },
  { key: 'hotMoneyAmp', label: '游资放大系数', type: 'number', min: 1, max: 10, step: 0.5, default: 3, note: '净流聚合中游资/大户权重倍数（#43 可调）' },
  { key: 'eventDecayDays', label: '事件卡衰减天数', type: 'number', min: 1, max: 3, step: 1, default: 2, note: 'what-if 事件影响持续天数，线性衰减（#42）' },
  { key: 'sandboxK', label: '沙盘每日采样轮数 K', type: 'number', min: 1, max: 5, step: 1, default: 1, note: '高级选项：成本随 K 线性增长（#38）' },
  { key: 'seed', label: '人设池随机种子', type: 'number', min: 1, max: 999999, step: 1, default: 2026 },
  // 情绪引擎常量（#48 可调常量，技术设计 §5.2；F14：补齐设置 schema 使「#48 设置页可调」成立）
  { key: 'emotionEventWeight', label: '情绪·事件权重', type: 'number', min: 0, max: 10, step: 0.5, default: 4, note: '事件卡情绪贡献系数（#48）' },
  { key: 'emotionPnlWeight', label: '情绪·盈亏权重', type: 'number', min: 0, max: 20, step: 0.5, default: 6, note: '个人浮盈亏系数（#48，±5% 饱和）' },
  { key: 'emotionMarketWeight', label: '情绪·大盘权重', type: 'number', min: 0, max: 2000, step: 10, default: 400, note: '大盘波动系数（#48，只对 |涨跌|>1% 部分计价）' },
  { key: 'emotionCarryover', label: '情绪·惯性残留 λ', type: 'number', min: 0, max: 0.9, step: 0.05, default: 0.6, note: '前一日情绪残留比例（P3 情绪惯性；0=逐日锚定基线重算）' },
  { key: 'emotionNegativeAsym', label: '情绪·负面不对称', type: 'number', min: 1, max: 3, step: 0.1, default: 1.3, note: '负向冲击放大系数（bad is stronger；1=对称，稳态即回现行口径）' },
  // 机构决策层（v1.4 #58–#60：开关/折算系数/三条日频路径独立开关）
  { key: 'instEnabled', label: '机构决策层', type: 'boolean', default: true, note: '关闭后逐点等价旧口径（回退锚，#60）' },
  { key: 'instNfScale', label: '机构净流折算系数（亿元→NF）', type: 'number', min: 0, max: 1, step: 0.05, default: 0.1, note: '一期未校准默认值（#60 面板明示）；禁止静默调参' },
  { key: 'instPathMargin', label: '机构路径·两融杠杆（M1）', type: 'boolean', default: true, note: '关闭后该路径不参与折算（#58）' },
  { key: 'instPathEtf', label: '机构路径·被动 ETF（M2，仅 A 股股票型）', type: 'boolean', default: true, note: 'A 股口径由数据侧产出（#58）' },
  { key: 'instPathEvent', label: '机构路径·事件席位（M3，龙虎榜+大宗）', type: 'boolean', default: true, note: '日频 T+0 盘后（#58）' },
];

/** 部分设置项 → EngineConfig 增量（其余走默认值）；DSH ctx.settings 与面板 /api/config 共用 */
export function applySettings(cfg: EngineConfig, s: Record<string, unknown>): EngineConfig {
  // instLayer 深拷贝（旧 cfg 缺 instLayer → 用默认值兜底，#64 additive 自愈）
  const baseLayer = cfg.instLayer ?? { ...DEFAULT_CONFIG.instLayer, paths: { ...DEFAULT_CONFIG.instLayer.paths } };
  const next: EngineConfig = {
    ...cfg,
    emotion: { ...cfg.emotion },
    instLayer: { ...baseLayer, paths: { ...baseLayer.paths } },
  };
  if (s['index'] === 'SH000001' || s['index'] === 'CSI300') next.index = s['index'] as IndexId;
  if (typeof s['modelId'] === 'string' && s['modelId'].length > 0) next.modelId = s['modelId'];
  if (typeof s['hotMoneyAmp'] === 'number') next.hotMoneyAmp = s['hotMoneyAmp'];
  if (typeof s['eventDecayDays'] === 'number') next.eventDecayDays = s['eventDecayDays'];
  if (typeof s['sandboxK'] === 'number') next.sandboxK = s['sandboxK'];
  if (typeof s['seed'] === 'number') next.seed = s['seed'];
  if (typeof s['emotionEventWeight'] === 'number') next.emotion.eventWeight = s['emotionEventWeight'];
  if (typeof s['emotionPnlWeight'] === 'number') next.emotion.pnlWeight = s['emotionPnlWeight'];
  if (typeof s['emotionMarketWeight'] === 'number') next.emotion.marketWeight = s['emotionMarketWeight'];
  if (typeof s['emotionCarryover'] === 'number') next.emotion.carryover = s['emotionCarryover'];
  if (typeof s['emotionNegativeAsym'] === 'number') next.emotion.negativeAsym = s['emotionNegativeAsym'];
  // 机构决策层五键（v1.4 #58–#60，逐键类型守卫）
  if (typeof s['instEnabled'] === 'boolean') next.instLayer.enabled = s['instEnabled'];
  if (typeof s['instNfScale'] === 'number' && Number.isFinite(s['instNfScale'])) next.instLayer.nfScale = s['instNfScale'];
  if (typeof s['instPathMargin'] === 'boolean') next.instLayer.paths.margin = s['instPathMargin'];
  if (typeof s['instPathEtf'] === 'boolean') next.instLayer.paths.etf = s['instPathEtf'];
  if (typeof s['instPathEvent'] === 'boolean') next.instLayer.paths.event = s['instPathEvent'];
  // 兼容完整 config.json 的嵌套 emotion 对象（面板 /api/config 复用本函数做只读合并）
  const emo = s['emotion'];
  if (emo && typeof emo === 'object') {
    const e = emo as Record<string, unknown>;
    if (typeof e['eventWeight'] === 'number') next.emotion.eventWeight = e['eventWeight'];
    if (typeof e['pnlWeight'] === 'number') next.emotion.pnlWeight = e['pnlWeight'];
    if (typeof e['marketWeight'] === 'number') next.emotion.marketWeight = e['marketWeight'];
    if (typeof e['carryover'] === 'number') next.emotion.carryover = e['carryover'];
    if (typeof e['negativeAsym'] === 'number') next.emotion.negativeAsym = e['negativeAsym'];
  }
  // 兼容完整 config.json 的嵌套 instLayer 对象（同上只读合并，#60）
  const layer = s['instLayer'];
  if (layer && typeof layer === 'object') {
    const l = layer as Record<string, unknown>;
    if (typeof l['enabled'] === 'boolean') next.instLayer.enabled = l['enabled'];
    if (typeof l['nfScale'] === 'number' && Number.isFinite(l['nfScale'])) next.instLayer.nfScale = l['nfScale'];
    const p = l['paths'];
    if (p && typeof p === 'object') {
      const pp = p as Record<string, unknown>;
      if (typeof pp['margin'] === 'boolean') next.instLayer.paths.margin = pp['margin'];
      if (typeof pp['etf'] === 'boolean') next.instLayer.paths.etf = pp['etf'];
      if (typeof pp['event'] === 'boolean') next.instLayer.paths.event = pp['event'];
    }
  }
  return next;
}

export { DEFAULT_CONFIG };
