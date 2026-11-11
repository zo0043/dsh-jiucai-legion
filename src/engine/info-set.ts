/**
 * 韭菜军团 — 分层信息集与氛围模板（需求 #12–#14/#50）。
 *
 * - 公共块：行情/成交/宽度/情绪热度/新闻 TopN/降级标注（#13/#50），
 *   全部规则模板拼装、零 LLM（#13 修正）；
 * - 军团意见气候块（#50 升级，P1）：≤3 行（全团气候＋本人风格组＋结果子句），
 *   由 buildUserMessage 拼在公共块之后、随三块结构参与洗牌；感知噪声走
 *   hashSeed(seed,'climate') 独立派生流，不占用块序洗牌流（既有 seed 块序逐字不变）；
 * - 风格块：按人设裁剪的专属数据（#13：技术派→K线量能、消息党→新闻全文、
 *   游资→涨停梯队/连板高度、趋势/逆向/定投→收盘序列与均值偏离）；
 * - 个人块：仓位/成本锚（#49）/情绪值（#48）/记忆摘要（#52）/游资纪律提醒（#49）；
 * - buildUserMessage：公共块(+气候块)+风格块+个人块按 mulberry32(seed) 洗牌块序
 *   （#39 呈现顺序随机化；只动顺序、不动内容）。
 * 可见性规则（#14）：不互看具体操作，只有军团整体意见气候的交易日级回流（#50）。
 */
import type { AgentState, Bar, Bias, InstitutionFlow, InstPathFlow, LegionClimate, LegionMirror, MarketSnapshot, Persona, Style } from './types.js';
import { buildMemoryPrompt } from './memory.js';
import { STYLE_LABEL } from './prompts.js';
import { hashSeed, mulberry32, seededShuffle } from './persona-pool.js';

/** 公共块新闻 TopN 条数 */
const NEWS_TOP_N = 5;
/** 公共块行情表天数 */
const COMMON_BAR_DAYS = 5;
/** 风格块序列天数（K 线/收盘序列） */
const STYLE_BAR_DAYS = 20;

// ---------- 格式化小工具 ----------

/** 按码点截断（不劈开代理对），超长补省略号 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`;
}

/** 价格显示：去掉无意义的尾零（3245 → "3245"，3245.61 → "3245.61"） */
function fmtPrice(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** 成交量显示：中文习惯（≥1亿 → 亿，≥1万 → 万） */
function fmtVolume(v: number): string {
  if (v >= 1e8) return `${(v / 1e8).toFixed(2)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(Math.round(v));
}

/** 金额显示（现金等） */
function fmtMoney(v: number): string {
  return v.toFixed(2);
}

/** 宽度计数显示：null（对应池降级，Python 实发 null）→「未知」，不伪造数值（#24 分级降级，F23） */
function fmtBreadth(v: number | null): string {
  return v === null ? '未知' : String(v);
}

const INDEX_LABEL: Record<MarketSnapshot['index'], string> = {
  SH000001: '上证指数',
  CSI300: '沪深300',
};

// ---------- 公共块「机构动向」行（v1.4 #62：零 LLM 模板拼装） ----------

/** 带符号金额（亿，1 位小数） */
function fmtSigned(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`;
}

function pathOf(inst: InstitutionFlow, pathId: InstPathFlow['pathId']): InstPathFlow | undefined {
  return inst.paths.find((p) => p.pathId === pathId);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 公共块「机构动向」行（v1.4 #62）：在资金面行之后、新闻要点之前规则模板拼装（零 LLM）。
 * - 每个子句按字段标注各自 asOf（两融 T+1、事件席位 T+0 盘后、季频报告期滞后）；
 * - 每源 null → 如实降级文案（「未知（降级）」，funds 行先例）；全源 null → 整行
 *   「机构动向：今日无可用机构数据（各源降级，如实标注）」；
 * - 非权益/跨境 ETF 申赎以旁注子句呈现并明示「不计入净流口径」，绝不与 A 股口径净额相加；
 * - 与 #57 集中度传闻解耦：本行只点名数据源（两融/ETF/龙虎榜/大宗），不出现
 *   「大资金/主力」模糊身份词；
 * - inst 载荷缺省（undefined，旧缓存快照）→ 返回 null → 整行省略（#64 additive 自愈）。
 */
export function buildInstLine(inst: InstitutionFlow | null | undefined): string | null {
  if (!inst || !Array.isArray(inst.paths)) return null;
  const clauses: string[] = [];

  // M1 两融：净流入 + 维持担保比例（后者只进文案不改 NF，#58/#40）
  const margin = pathOf(inst, 'margin');
  if (margin) {
    clauses.push(
      num(margin.netFlowYi)
        ? `两融净流入 ${fmtSigned(margin.netFlowYi)} 亿（截至 ${margin.signals['sseAsOf'] ?? margin.asOf ?? '未知'}，T+1）`
        : '两融净流入未知（降级）',
    );
    const ratio = margin.signals['maintenanceRatio'];
    const mAsOf = margin.signals['maintenanceAsOf'];
    if (num(ratio)) {
      clauses.push(`平均维持担保比例 ${Number(ratio).toFixed(1)}${num(mAsOf) ? `（截至 ${mAsOf}）` : ''}（安全垫参考，不计入净流）`);
    }
  } else {
    clauses.push('两融净流入未知（降级）');
  }

  // M2 被动 ETF：仅 A 股股票型净申购 + 非权益/跨境申赎旁注（分桶金额不与净额相加，#58）
  const etf = pathOf(inst, 'etfSse');
  if (etf) {
    clauses.push(
      num(etf.netFlowYi)
        ? `沪市 A股ETF 净申购 ${fmtSigned(etf.netFlowYi)} 亿（深市份额不可观测）`
        : '沪市 A股ETF 净申购未知（降级）',
    );
    const s = etf.signals as { bondYi?: number | null; moneyYi?: number | null; otherYi?: number | null; crossBorderYi?: number | null };
    const sideNotes: string[] = [];
    if (num(s.bondYi)) sideNotes.push(`债券 ETF 申赎 ${fmtSigned(s.bondYi)} 亿`);
    if (num(s.moneyYi)) sideNotes.push(`货币 ETF 申赎 ${fmtSigned(s.moneyYi)} 亿`);
    if (num(s.otherYi)) sideNotes.push(`黄金等 ${fmtSigned(s.otherYi)} 亿`);
    if (num(s.crossBorderYi)) sideNotes.push(`跨境 ${fmtSigned(s.crossBorderYi)} 亿`);
    if (sideNotes.length > 0) clauses.push(`${sideNotes.join(' / ')}——均不计入净流口径（signals 分桶）`);
  } else {
    clauses.push('沪市 A股ETF 净申购未知（降级）');
  }

  // M3 事件席位：龙虎榜机构席位 + 大宗「机构专用」（T+0 盘后；折溢率不上信息集行）
  const seat = pathOf(inst, 'eventSeat');
  if (seat) {
    const s = seat.signals as { lhbYi?: number | null; dzjyYi?: number | null; lhbAsOf?: string | null; dzjyAsOf?: string | null };
    const lhb = num(s.lhbYi) ? `龙虎榜机构席位净买 ${fmtSigned(s.lhbYi)} 亿${s.lhbAsOf ? `（截至 ${s.lhbAsOf}）` : ''}` : '龙虎榜机构席位净买未知（降级）';
    const dz = num(s.dzjyYi) ? `大宗「机构专用」净买 ${fmtSigned(s.dzjyYi)} 亿${s.dzjyAsOf ? `（截至 ${s.dzjyAsOf}）` : ''}` : '大宗「机构专用」净买未知（降级）';
    clauses.push(`${lhb}、${dz}（T+0 盘后）`);
  } else {
    clauses.push('龙虎榜/大宗未知（降级）');
  }

  // M4 季频结构（只产结构信号不产 NF，#58）：基金家数增减 + 香港中央结算（北向季度代理）
  const quarterly = pathOf(inst, 'quarterlyStructure');
  if (quarterly) {
    const s = quarterly.signals as {
      fundHoldCount?: { asOf?: string | null; increaseCount?: number; decreaseCount?: number } | null;
      hkscHolding?: { asOf?: string | null; totalStocks?: number | null } | null;
    };
    const fh = s.fundHoldCount;
    const hk = s.hkscHolding;
    const qParts: string[] = [];
    if (fh && num(fh.increaseCount) && num(fh.decreaseCount)) {
      qParts.push(`公募基金季报增持 ${fh.increaseCount} 家/减持 ${fh.decreaseCount} 家（报告期 ${fh.asOf ?? '未知'}，滞后披露）`);
    }
    if (hk && num(hk.totalStocks)) {
      qParts.push(`香港中央结算（北向季度代理）持有 ${hk.totalStocks} 只（报告期 ${hk.asOf ?? '未知'}，滞后 30–40 天）`);
    }
    clauses.push(qParts.length > 0 ? qParts.join('；') : '季频结构未知（降级）');
  } else {
    clauses.push('季频结构未知（降级）');
  }

  // M5 北向恒不可观测（#59 如实）+ 南向只作资金分流 signals（不得充当北向代理）
  const north = pathOf(inst, 'northbound');
  clauses.push('北向每日净买：未披露（上游 2024-08 起停报）');
  if (north) {
    const sb = (north.signals as { southboundNetYi?: number | null }).southboundNetYi;
    if (num(sb)) clauses.push(`南向（资金分流，非北向）${fmtSigned(sb)} 亿`);
  }

  // 全源降级（子句全部为「未知」类）→ 整行兜底文案，不渲染半残明细
  if (clauses.every((c) => c.includes('未知（降级）') || c.includes('未披露'))) {
    return '机构动向：今日无可用机构数据（各源降级，如实标注）';
  }
  return `机构动向：${clauses.join('；')}`;
}

// ---------- 军团意见气候（#50 升级，P1） ----------

/** 气候感知噪声幅度（±8pp）：每个 Agent 对同一气候的「感知」略有偏差（确定性、可复现） */
const CLIMATE_NOISE_PP = 8;

/**
 * 军团意见气候块（#50「一句」升级；P1 ≤3 行 + P5 双轨/传闻扩展，模板拼装零 LLM）：
 * - 第 1 行：全团气候「军团意见气候（asOf）：看多 X% / 看空 Y% / 观望 Z%」（带 ±8pp 感知噪声）；
 * - 第 2 行（P5 双轨，mirror 缺省省略）：资金加权看多/看空「资金加权看多 X% / 看空 Y%
 *   （按在场资金）」——人数口径之外的资金结构镜像（分母=参战者权重和），同噪声流；
 * - 第 3 行：本人风格组气候——组内 ≥3 人报精确数字；<3 人样本太少，改「风闻」措辞不报数字；
 *   本人风格不在上轮输出中 → 省略该行；
 * - 第 4 行（P5 传闻，条件触发）：领先阵营集中度超 cfg 阈值时由调用方在 mirror.whaleRumor
 *   给出方向 → 模板传闻「盘面风闻有大资金在做多/做空」（#14：无身份、无具体操作）；
 * - 第 5 行：结果子句「随后一个交易日指数 ±X.XX%」——由 bars 现算（asOf 之后第一根 bar
 *   相对 asOf，常规情形即 bars 末两根），且仅当气候 asOf 严格早于末根才拼接：
 *   同日重跑（asOf=末根）不拼，防止把气候形成时已知的当日涨幅当成「随后」结果；
 *   asOf 不在 bars 中（如超出 250 日窗口）→ 不拼。
 * - climate 为空（首轮/旧落盘记录缺字段）→ 返回 null，公共块后不拼任何气候行。
 * 感知噪声用独立派生种子 mulberry32(hashSeed(seed,'climate'))，与块序洗牌流
 * （buildUserMessage 的 mulberry32(seed)，只耗用于块序）互不共用——同 seed 块序逐字
 * 不变、噪声确定可复现（P1 验收）。
 */
export function buildLegionClimateBlock(
  climate: LegionClimate | null | undefined,
  opts: { style: Style; bars: Bar[]; seed: number; mirror?: LegionMirror | null },
): string | null {
  if (!climate) return null;
  const rng = mulberry32(hashSeed(opts.seed, 'climate'));
  // 感知噪声：各比例独立叠加 ±8pp 后 clamp 到 [0,100] 取整显示
  const noisyPct = (v: number): number =>
    Math.round(Math.min(100, Math.max(0, v * 100 + (rng() * 2 - 1) * CLIMATE_NOISE_PP)));
  const lines: string[] = [];
  const bull = noisyPct(climate.overall.bullPct);
  const bear = noisyPct(climate.overall.bearPct);
  lines.push(`军团意见气候（${climate.asOf}）：看多 ${bull}% / 看空 ${bear}% / 观望 ${Math.max(0, 100 - bull - bear)}%`);
  // P5 双轨行：资金加权看多/看空（与人数口径并排，叙事对齐资金结构）
  if (opts.mirror) {
    const wb = noisyPct(opts.mirror.weightedBullPct);
    const ws = noisyPct(opts.mirror.weightedBearPct);
    lines.push(`资金加权看多 ${wb}% / 看空 ${ws}%（按在场资金）`);
  }
  const group = climate.byStyle[opts.style];
  if (group && group.count > 0) {
    if (group.count >= 3) {
      const groupBull = noisyPct(group.bullPct);
      const groupBear = noisyPct(group.bearPct);
      lines.push(
        `你同风格（${STYLE_LABEL[opts.style]}）${group.count} 人：` +
          `看多 ${groupBull}% / 看空 ${groupBear}% / 观望 ${Math.max(0, 100 - groupBull - groupBear)}%`,
      );
    } else {
      // 组内 <3 人：不报精确数字，改「风闻」措辞（P1）
      const lean = group.bullPct > group.bearPct ? '偏多' : group.bullPct < group.bearPct ? '偏空' : '观望居多';
      lines.push(`风闻你同风格（${STYLE_LABEL[opts.style]}）的兄弟最近${lean}`);
    }
  }
  // P5 集中度传闻行（#14：无身份无具体操作；条件由调用方按 cfg 阈值判定）
  if (opts.mirror?.whaleRumor !== null && opts.mirror?.whaleRumor !== undefined) {
    lines.push(`盘面风闻有大资金在${opts.mirror.whaleRumor}`);
  }
  // 结果子句：asOf 严格早于末根（idx 命中且非末根）→ 取 asOf 之后第一根 bar 相对 asOf 的涨跌
  const bars = opts.bars;
  const idx = bars.findIndex((b) => b.date === climate.asOf);
  if (idx >= 0 && idx < bars.length - 1) {
    const base = bars[idx]!;
    const nextBar = bars[idx + 1]!;
    if (base.close > 0) {
      const ret = ((nextBar.close - base.close) / base.close) * 100;
      lines.push(`随后一个交易日指数 ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`);
    }
  }
  return lines.join('\n');
}

// ---------- 公共块（#13） ----------

/**
 * 公共块（#13/#50）：最近 5 日行情表、成交变化、涨跌家数/涨停梯队（breadth）、
 * 情绪热度、新闻 TopN（text 截断 50 字/条）、
 * 降级标注行（degraded 数组有 degraded=true 项时「⚠ … 数据截至 …」）。
 * 军团意见气候块（P1）不在本块内：它依赖个人 style 与 seed（感知噪声），
 * 由 buildUserMessage 拼在公共块文本之后、随三块结构参与洗牌。
 */
export function buildCommonBlock(snapshot: MarketSnapshot): string {
  const lines: string[] = [];
  lines.push(`【市场全景】${INDEX_LABEL[snapshot.index]}（${snapshot.index}）· ${snapshot.tradeDate}`);

  // 最近 5 日行情表（首行涨跌相对更早一根 K 线计算）
  const bars = snapshot.bars;
  const recent = bars.slice(-COMMON_BAR_DAYS);
  if (recent.length > 0) {
    const startIdx = bars.length - recent.length;
    lines.push('近 5 日行情：');
    for (let i = 0; i < recent.length; i += 1) {
      const bar = recent[i];
      if (bar === undefined) continue;
      const prev = bars[startIdx + i - 1];
      const chgText =
        prev && prev.close !== 0
          ? `（${((bar.close - prev.close) / prev.close) * 100 >= 0 ? '+' : ''}${(((bar.close - prev.close) / prev.close) * 100).toFixed(2)}%）`
          : '';
      lines.push(`  ${bar.date} 收 ${fmtPrice(bar.close)}${chgText} 量 ${fmtVolume(bar.volume)}`);
    }
    // 成交变化：最新量 vs 上一交易日
    const last = recent[recent.length - 1];
    const prevBar = bars[bars.length - 2];
    if (last && prevBar && prevBar.volume > 0) {
      const d = ((last.volume - prevBar.volume) / prevBar.volume) * 100;
      lines.push(`成交变化：最新成交量 ${fmtVolume(last.volume)}，较上一交易日 ${d >= 0 ? '+' : ''}${d.toFixed(1)}%`);
    }
  }

  // 市场宽度（#22 替换千股千评；降级字段显示「未知」，不裸灌 null/0，F23）
  const b = snapshot.breadth;
  lines.push(
    `涨跌家数：上涨 ${fmtBreadth(b.advancers)} / 下跌 ${fmtBreadth(b.decliners)}；` +
      `涨停 ${fmtBreadth(b.limitUp)} / 跌停 ${fmtBreadth(b.limitDown)} / 炸板 ${fmtBreadth(b.failedBoard)} / 最高连板 ${fmtBreadth(b.maxStreak)} 板`,
  );

  // 情绪热度（数据流分析修复：两源量纲不同——雪球=关注均值、东财=榜单条目数，
  // 必须随数值标注量纲语义，防止跨源切换时 Agent 把「条目数 100」与「关注均值 35000」当成同尺度）
  const heatUnit = snapshot.sentiment.source === 'eastmoney' ? '榜单条目数' : '关注均值';
  lines.push(
    `情绪热度：${snapshot.sentiment.heatIndex}（${heatUnit}，来源 ${snapshot.sentiment.source}，截至 ${snapshot.sentiment.asOf}；` +
      `跨源量纲不同，仅与同源前值比较）`,
  );

  // 资金面（#16 机构外生数据；数据流分析修复「采而不食」：两融/北向此前从未到达 Agent 信息集）
  // 按字段标注各自截至日（两融 T+1，#47）；北向 2024-08 起上游停披露 → 如实报「未披露」
  const funds = snapshot.funds;
  const marginText =
    funds.marginBalance === null
      ? '未知（降级）'
      : `${(funds.marginBalance / 1e8).toFixed(0)} 亿${funds.marginAsOf ? `（截至 ${funds.marginAsOf}，T+1 披露）` : ''}`;
  const northText =
    funds.northboundNet === null
      ? '未披露（上游 2024-08 起停报每日净买额）'
      : `${(funds.northboundNet / 1e8).toFixed(1)} 亿${funds.northAsOf ? `（截至 ${funds.northAsOf}）` : ''}`;
  lines.push(`资金面：两融余额 ${marginText}；北向净买 ${northText}`);

  // 机构动向行（v1.4 #62）：资金面行之后、新闻要点之前；载荷缺省（旧快照）→ 整行省略。
  // 行在公共块字符串内部——buildUserMessage 三块结构与 seed 块序逐字不变（#62 不新增洗牌块）
  const instLine = buildInstLine(snapshot.inst);
  if (instLine) lines.push(instLine);

  // 新闻 TopN（截断 50 字/条）
  const news = snapshot.news.items.slice(0, NEWS_TOP_N);
  if (news.length > 0) {
    lines.push('新闻要点：');
    news.forEach((n, i) => {
      lines.push(`  ${i + 1}. [${n.source} ${n.ts}] ${truncate(n.text, 50)}`);
    });
  }

  // 军团意见气候块（P1）由 buildUserMessage 拼接（依赖个人 style 与 seed，不进公共块）

  // 分级降级标注（#24）：数据陈旧/缓存降级必须显著标注截至日
  for (const flag of snapshot.degraded) {
    if (flag.degraded) {
      lines.push(`⚠ ${flag.source} 数据截至 ${flag.asOf}${flag.note ? `（${flag.note}）` : ''}`);
    }
  }

  return lines.join('\n');
}

// ---------- 风格专属块（#13） ----------

/**
 * 风格专属块（#13）：按人设裁剪的差异化数据。
 * - technical → 最近 20 日 K 线量能明细；
 * - news → 新闻全文（截断 120 字/条）；
 * - hotmoney/speculator（游资）→ 涨停梯队/连板高度明细；
 * - trend/contrarian/indexer → 近 20 日收盘序列与均值偏离。
 */
export function buildStyleBlock(style: Style, snapshot: MarketSnapshot): string {
  const bars = snapshot.bars;

  if (style === 'technical') {
    const lines = ['【技术视角·近 20 日 K 线量能】'];
    const recent = bars.slice(-STYLE_BAR_DAYS);
    if (recent.length === 0) return `${lines[0]}\n（暂无行情数据）`;
    for (const bar of recent) {
      lines.push(
        `${bar.date} 开 ${fmtPrice(bar.open)} 高 ${fmtPrice(bar.high)} 低 ${fmtPrice(bar.low)} 收 ${fmtPrice(bar.close)} 量 ${fmtVolume(bar.volume)}`,
      );
    }
    return lines.join('\n');
  }

  if (style === 'news') {
    const lines = ['【消息党·新闻全文】'];
    if (snapshot.news.items.length === 0) return `${lines[0]}\n（暂无新闻）`;
    for (const n of snapshot.news.items) {
      lines.push(`[${n.source} ${n.ts}] ${truncate(n.text, 120)}`);
    }
    return lines.join('\n');
  }

  if (style === 'hotmoney' || style === 'speculator') {
    const lines = ['【游资视角·涨停梯队】'];
    const b = snapshot.breadth;
    lines.push(`涨停 ${fmtBreadth(b.limitUp)} 家 / 跌停 ${fmtBreadth(b.limitDown)} 家 / 炸板 ${fmtBreadth(b.failedBoard)} 家`);
    // F23/#24 分级降级：涨停池或炸板池降级（实发 null）→ 明示不可用，不得当 0 伪造炸板率
    if (b.limitUp === null || b.failedBoard === null) {
      lines.push('炸板率不可用（涨停池降级）');
    } else {
      const denom = b.limitUp + b.failedBoard;
      if (denom > 0) {
        lines.push(`炸板率 ${((b.failedBoard / denom) * 100).toFixed(1)}%（打板成功率参考）`);
      }
    }
    lines.push(`连板高度：最高 ${fmtBreadth(b.maxStreak)} 板（情绪周期位置参考）`);
    return lines.join('\n');
  }

  // trend / contrarian / indexer：近 20 日收盘序列与均值偏离
  const lines = ['【趋势震荡视角·近 20 日收盘与均值偏离】'];
  const recent = bars.slice(-STYLE_BAR_DAYS);
  if (recent.length === 0) return `${lines[0]}\n（暂无行情数据）`;
  const closes = recent.map((bar) => bar.close);
  const mean = closes.reduce((s, v) => s + v, 0) / closes.length;
  const lastClose = closes[closes.length - 1] ?? 0;
  const dev = mean !== 0 ? ((lastClose - mean) / mean) * 100 : 0;
  const hi = Math.max(...closes);
  const lo = Math.min(...closes);
  lines.push(`收盘序列：${closes.map((c) => fmtPrice(c)).join(', ')}`);
  lines.push(`20 日均值：${fmtPrice(mean)}；现价偏离：${dev >= 0 ? '+' : ''}${dev.toFixed(2)}%`);
  lines.push(`20 日区间：${fmtPrice(lo)} ~ ${fmtPrice(hi)}`);
  return lines.join('\n');
}

// ---------- 个人块（#49/#48/#52；P4 偏差情境点火） ----------

/**
 * 偏差情境触发行（P4）：按偏差标签 × 当下情境规则拼装的「内心戏」素材（零 LLM、
 * 不读记忆内容——确定性不随记忆窗口波动；第二人称倾向措辞，不含具体历史事件断言，
 * 不向 Agent 注入可能与记忆矛盾的伪造个人史）。行为仍由 LLM 决定——#49「写进
 * 系统提示、LLM 演出、不做硬编码干预」不变，这里只补情境素材。条件不满足不渲染。
 * - breakeven 且浮亏收窄至 −2%~0：「离回本就差 X%，一回本你就想跑」；
 * - chasing 且当日大盘 >+1.5%：「大阳线，再不上车就踏空了」；
 * - loss_aversion 且浮亏 <−3%：「再亏睡不着了，要不先割？」。
 */
function situationalBiasLines(persona: Persona, pnlPct: number | null, marketRet: number): string[] {
  const out: string[] = [];
  const has = (b: Bias): boolean => persona.biases.includes(b);
  if (has('breakeven') && pnlPct !== null && pnlPct < 0 && pnlPct >= -2) {
    out.push(`离回本就差 ${Math.abs(pnlPct).toFixed(1)}%，一回本你就想跑`);
  }
  if (has('chasing') && marketRet > 0.015) {
    out.push('大阳线，再不上车就踏空了');
  }
  if (has('loss_aversion') && pnlPct !== null && pnlPct < -3) {
    out.push('再亏睡不着了，要不先割？');
  }
  return out;
}

/**
 * 个人块：当前仓位、成本/现价/浮盈亏（#49 文案「成本 3245，现价 3190，浮亏 1.7%」，
 * 无成本则「空仓」）、偏差情境触发行（P4，条件满足才渲染）、当前情绪值描述
 * （<30 恐慌 / 30–70 中性 / >70 贪婪，#48）、记忆摘要（#52）、游资纪律提醒行（#49，仅游资）。
 * marketRet = 当日大盘涨跌（小数，chasing 触发输入；由调用方从 bars 末两根现算，缺省 0）。
 */
export function buildPersonalBlock(
  state: AgentState,
  persona: Persona,
  lastClose: number,
  marketRet = 0,
): string {
  const lines: string[] = [];
  lines.push(`【个人状态】${persona.name}（${persona.id}）`);
  lines.push(`当前仓位：指数敞口 ${state.exposurePct}%，现金 ${fmtMoney(state.cash)}`);

  // 成本锚（#49）：有持仓给「成本 X，现价 Y，浮盈/浮亏 Z%」；无成本「空仓」
  let pnlPct: number | null = null;
  if (state.costBasis !== null && state.costBasis > 0) {
    pnlPct = ((lastClose - state.costBasis) / state.costBasis) * 100;
    const pnlText = pnlPct >= 0 ? `浮盈 ${pnlPct.toFixed(1)}%` : `浮亏 ${Math.abs(pnlPct).toFixed(1)}%`;
    lines.push(`持仓：成本 ${fmtPrice(state.costBasis)}，现价 ${fmtPrice(lastClose)}，${pnlText}`);
  } else {
    lines.push('持仓：空仓');
  }

  // 偏差情境触发行（P4）：紧跟持仓情境，作为内心戏素材
  lines.push(...situationalBiasLines(persona, pnlPct, marketRet));

  // 情绪值注入（#48：「你当前恐慌度 72」式）
  const emotionShown = Math.round(state.emotion);
  const emotionLabel = emotionShown < 30 ? '恐慌' : emotionShown <= 70 ? '中性' : '贪婪';
  lines.push(`当前情绪值 ${emotionShown}（${emotionLabel}，0=恐慌 100=贪婪）`);

  // 记忆摘要（#52：含「近 N 次判断错了 M 次」统计行）
  lines.push(buildMemoryPrompt(state));

  // 游资纪律提醒（#49，与散户形成行为反差）
  if (persona.maxLossPct !== null) {
    lines.push(`纪律提醒：单日亏损超过 ${persona.maxLossPct}% 无条件减仓，不心存侥幸。`);
  }

  return lines.join('\n');
}

// ---------- 用户消息组装（#39 呈现顺序随机化） ----------

/** buildUserMessage 的入参（orchestrator.askAgent 调用） */
export interface BuildUserMessageOptions {
  snapshot: MarketSnapshot;
  state: AgentState;
  persona: Persona;
  /** 呈现顺序洗牌种子（#39，通常为轮次种子 + personaId 哈希） */
  seed: number;
}

/**
 * 组装用户消息（#12/#13/#39/#50）：公共块（+军团意见气候块，P1）+ 风格块 + 个人块，
 * 块序按 mulberry32(seed) 洗牌（#39 呈现顺序随机化——只动顺序、不动内容），
 * 末尾附输出提醒。气候块文本拼在公共块之后（同属「公共信息+个人感知」），
 * 不新增洗牌块，保持既有 seed 的块序逐字不变；其感知噪声走独立派生种子
 * mulberry32(hashSeed(seed,'climate'))，与本洗牌流互不占用（P1）。
 */
export function buildUserMessage(opts: BuildUserMessageOptions): string {
  const { snapshot, state, persona, seed } = opts;
  const lastBar = snapshot.bars[snapshot.bars.length - 1];
  const prevBar = snapshot.bars[snapshot.bars.length - 2];
  const lastClose = lastBar !== undefined ? lastBar.close : 0;
  // 当日大盘涨跌（P4 情境点火 chasing 触发输入；bars 末两根现算，无前根按 0）
  const marketRet =
    lastBar !== undefined && prevBar !== undefined && prevBar.close > 0
      ? (lastBar.close - prevBar.close) / prevBar.close
      : 0;

  const common = buildCommonBlock(snapshot);
  // 军团意见气候块（P1）+ 资金镜像双轨/传闻行（P5）：缺省 → null → 不拼（首轮/旧记录自愈）
  const climate = buildLegionClimateBlock(snapshot.legionClimate ?? null, {
    style: persona.style,
    bars: snapshot.bars,
    seed,
    mirror: snapshot.legionMirror ?? null,
  });
  const blocks = [
    climate !== null ? `${common}\n${climate}` : common,
    buildStyleBlock(persona.style, snapshot),
    buildPersonalBlock(state, persona, lastClose, marketRet),
  ];
  // #39 呈现顺序随机化：轮次种子洗牌块序（内容不变）；气候噪声不占用本 rng 流
  const rng = mulberry32(seed >>> 0);
  const order = seededShuffle([0, 1, 2], rng);
  const body = order.map((i) => blocks[i] ?? '').join('\n\n');
  return `${body}\n\n请基于以上信息输出你今日的目标仓位判断：只输出一个严格 JSON 对象（格式见系统提示中的输出契约）。`;
}
