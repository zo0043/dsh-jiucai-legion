/**
 * 净流 → 价格偏移映射（需求 #21）
 * 一期：未校准默认系数（面板明示），线性映射（凹函数随 #40 一并否决）。
 * offsetPct = impactK × (NF / 总权重) × σ20(年化, %)
 */
export function computeOffsetPct(
  netFlow: number,
  totalW: number,
  volatility20Annual: number,
  impactK: number,
): number {
  if (totalW <= 0) return 0;
  const normalized = netFlow / totalW;
  // volatility20Annual 以小数表示（如 0.18），换算成百分点
  return impactK * normalized * volatility20Annual * 100;
}

/** 收盘价推演：close_{t+1} = close_t × (1 + offsetPct/100)（#40 无阻尼，线性外推） */
export function applyOffset(lastClose: number, offsetPct: number): number {
  return lastClose * (1 + offsetPct / 100);
}

/** 冲击系数未校准标注（#21 面板明示） */
export const IMPACT_UNCALIBRATED_NOTE =
  '冲击系数为一期未校准默认值（k=0.8），校准将依赖二期对账数据积累。';
