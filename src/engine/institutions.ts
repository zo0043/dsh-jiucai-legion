/**
 * 机构决策层规则引擎（v1.4 #58–#62）：确定性聚合，固定输入必得固定输出（#58）。
 *
 * 折算唯一发生处：institutionNetFlow —— inst 为 python 侧原始载荷（亿元、未折算），
 * NF 贡献 = cfg.instLayer.nfScale × Σ(非 null 日频流量路径 netFlowYi)。
 * TS 不做二次资产过滤：A 股口径（M2 仅 A 股股票型）由 python 侧产出、note 随载荷（#60）。
 * 机构净流是确定性常数加进每轮：median(NF_i + c) = median(NF_i) + c，K=5 预测与
 * 沙盘中位轮同构一致（#60）。
 */
import type { EngineConfig, InstitutionFlow, InstPathFlow, InstPathId } from './types.js';

/** 日频流量路径（可进 NF 合成的 pathId，#58）；季频/北向 netFlowYi 恒 null，不参与 */
export const DAILY_FLOW_PATH_IDS: readonly InstPathId[] = ['margin', 'etfSse', 'eventSeat'];

/** 机构净流折算系数缺省值（#60）；cfg.instLayer.nfScale 非有限数值时兜底 */
const DEFAULT_NF_SCALE = 0.1;

/** 机构净流未校准标注（#60，仿 impact.ts IMPACT_UNCALIBRATED_NOTE 先例） */
export const INST_UNCALIBRATED_NOTE =
  '机构净流折算系数为一期未校准默认值（1 亿元→0.1 NF 单位），与全体军团同量级、可单独翻转方向（#60 量级锚），校准依赖二期对账数据积累。';

export interface InstitutionNetFlowResult {
  /** 折算后机构净流（NF 单位）：确定性常数，进每轮合成（#60） */
  netFlow: number;
  /** 实际参与合成的日频路径 pathId（null 路径不含） */
  usedPaths: InstPathId[];
  /** null 日频路径的降级标注（pathId + note），供数据源灯与日报降级文案 */
  degraded: { pathId: InstPathId; note: string }[];
}

/** 零值结果（enabled=false / inst 缺省 / 全路径 null 时的同款形状） */
export function zeroInstitutionNetFlow(): InstitutionNetFlowResult {
  return { netFlow: 0, usedPaths: [], degraded: [] };
}

/**
 * 机构五路径 → 折算净流（NF 单位）。
 *
 * - cfg.instLayer.enabled=false → 恒 {netFlow:0}（旧口径回退锚，#60）；
 *   cfg 缺 instLayer（旧配置）同款——旧配置等价旧口径。
 * - inst 缺省（undefined/null，旧缓存快照）→ 同款返回 0（#64 向后兼容自愈）。
 * - null/非有限日频路径跳过并记 degraded flag（note 取路径自带说明）；
 *   全 null → netFlow=0。
 * - 季频/北向路径恒 null 属设计（#58/#59），跳过但不记降级。
 * - cfg.instLayer.paths 显式关闭的日频路径不参与折算（用户配置选择，非数据降级，
 *   不记 degraded flag）；paths 缺省（旧配置）→ 三路径全启用（向后兼容）。
 */
export function institutionNetFlow(
  inst: InstitutionFlow | null | undefined,
  cfg: EngineConfig,
): InstitutionNetFlowResult {
  // 旧口径回退锚（#60）：enabled 非 true 恒 0；旧配置无 instLayer 同款
  if (!cfg.instLayer || cfg.instLayer.enabled !== true) return zeroInstitutionNetFlow();
  // 旧缓存快照无 inst 载荷 → 与 enabled=false 同款（#64）
  if (!inst || !Array.isArray(inst.paths)) return zeroInstitutionNetFlow();
  const scale =
    typeof cfg.instLayer.nfScale === 'number' && Number.isFinite(cfg.instLayer.nfScale)
      ? cfg.instLayer.nfScale
      : DEFAULT_NF_SCALE;
  const pathsCfg = cfg.instLayer.paths;
  let sumYi = 0;
  const usedPaths: InstPathId[] = [];
  const degraded: { pathId: InstPathId; note: string }[] = [];
  for (const p of inst.paths as InstPathFlow[]) {
    if (!p || !DAILY_FLOW_PATH_IDS.includes(p.pathId)) continue;
    // 配置开关（#63 配置键）：显式 false → 该路径不参与折算（缺省/旧配置 → 启用）
    if (pathsCfg && p.pathId === 'margin' && pathsCfg.margin === false) continue;
    if (pathsCfg && p.pathId === 'etfSse' && pathsCfg.etf === false) continue;
    if (pathsCfg && p.pathId === 'eventSeat' && pathsCfg.event === false) continue;
    if (typeof p.netFlowYi === 'number' && Number.isFinite(p.netFlowYi)) {
      sumYi += p.netFlowYi;
      usedPaths.push(p.pathId);
    } else {
      degraded.push({ pathId: p.pathId, note: p.note ?? '该路径数据缺失（null）' });
    }
  }
  return { netFlow: scale * sumYi, usedPaths, degraded };
}

/** 亿元数值 → 带符号文案（+1.2 / −3.4） */
function fmtSignedYi(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

/**
 * 总编日报「机构动向」叙事行素材（v1.4 #64）：从原始载荷规则拼装（零 LLM），
 * 只点名数据源、不做方向判断；载荷缺省 → null（行省略，#28 自愈）。
 * 预测/沙盘共用同一行（沙盘取锚定日冻结载荷，#41）。
 */
export function instNarrativeLine(inst: InstitutionFlow | null | undefined): string | null {
  if (!inst || !Array.isArray(inst.paths)) return null;
  const parts: string[] = [];
  const margin = inst.paths.find((p) => p.pathId === 'margin');
  const etf = inst.paths.find((p) => p.pathId === 'etfSse');
  const seat = inst.paths.find((p) => p.pathId === 'eventSeat');
  const north = inst.paths.find((p) => p.pathId === 'northbound');
  const marginYi = margin?.netFlowYi;
  parts.push(
    marginYi !== null && marginYi !== undefined && Number.isFinite(marginYi)
      ? `两融 ${fmtSignedYi(marginYi)} 亿`
      : '两融未知',
  );
  const etfYi = etf?.netFlowYi;
  parts.push(
    etfYi !== null && etfYi !== undefined && Number.isFinite(etfYi)
      ? `A股ETF ${fmtSignedYi(etfYi)} 亿`
      : 'A股ETF未知',
  );
  const lhb = (seat?.signals as { lhbYi?: number | null } | undefined)?.lhbYi ?? null;
  const dzjy = (seat?.signals as { dzjyYi?: number | null } | undefined)?.dzjyYi ?? null;
  const seatYi = seat?.netFlowYi;
  parts.push(
    seatYi !== null && seatYi !== undefined && Number.isFinite(seatYi)
      ? `龙虎榜+大宗 ${fmtSignedYi(seatYi)} 亿`
      : lhb === null && dzjy === null
        ? '龙虎榜+大宗未知'
        : `龙虎榜+大宗 ${lhb !== null ? fmtSignedYi(lhb) : '?'} / ${dzjy !== null ? fmtSignedYi(dzjy) : '?'} 亿`,
  );
  const sb = (north?.signals as { southboundNetYi?: number | null } | undefined)?.southboundNetYi ?? null;
  parts.push(
    sb !== null && Number.isFinite(sb)
      ? `南向（资金分流，非北向）${fmtSignedYi(sb)} 亿`
      : '北向未披露',
  );
  return `机构动向：${parts.join('、')}（折算系数未校准，#60）`;
}

/**
 * 顶层信息性 Σ（亿元、未折算，#60）：仅展示用；inst 缺省 → null。
 * 与 institutionNetFlow 的区别：后者是折算后的 NF 贡献，前者只是载荷自带数值的透传读取。
 */
export function instInformationalSumYi(inst: InstitutionFlow | null | undefined): number | null {
  if (!inst || !Array.isArray(inst.paths)) return null;
  const v = inst.netFlowYi;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
