/**
 * 机构决策层规则引擎测试（v1.4 #58–#60）：逐路径确定性单测。
 * 折算只发生在 institutionNetFlow；inst 载荷本身未折算（#60）。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  type EngineConfig,
  type InstitutionFlow,
  type InstPathFlow,
  type InstPathId,
} from '../src/engine/types.js';
import {
  DAILY_FLOW_PATH_IDS,
  INST_UNCALIBRATED_NOTE,
  instInformationalSumYi,
  instNarrativeLine,
  institutionNetFlow,
} from '../src/engine/institutions.js';

function mkPath(
  pathId: InstPathId,
  netFlowYi: number | null,
  note: string | null = null,
): InstPathFlow {
  return { pathId, label: pathId, netFlowYi, signals: {}, asOf: '2026-11-11', note };
}

/** 五路径构造器（与 python get_institution 的 paths 顺序一致） */
function mkInst(
  margin: number | null,
  etfSse: number | null,
  eventSeat: number | null,
  quarterlyStructure: number | null = null,
  northbound: number | null = null,
  note: string | null = null,
): InstitutionFlow {
  return {
    asOf: '2026-11-11',
    netFlowYi: null,
    paths: [
      mkPath('margin', margin, note),
      mkPath('etfSse', etfSse, note),
      mkPath('eventSeat', eventSeat, note),
      mkPath('quarterlyStructure', quarterlyStructure),
      mkPath('northbound', northbound),
    ],
  };
}

const cfg: EngineConfig = { ...DEFAULT_CONFIG, instLayer: { enabled: true, nfScale: 0.1 } };

describe('institutionNetFlow（#60 折算唯一发生处）', () => {
  it('三路径齐备：0.1 × (120 − 14.96 − 1.3) = 10.374（etfSse 为 A 股口径、eventSeat = lhb −2.5 + dzjy +1.2）', () => {
    const inst = mkInst(120, -14.96, -1.3);
    const res = institutionNetFlow(inst, cfg);
    expect(res.netFlow).toBeCloseTo(10.374, 12);
    expect(res.usedPaths).toEqual(['margin', 'etfSse', 'eventSeat']);
    expect(res.degraded).toEqual([]);
  });

  it('折算系数随 cfg：nfScale=0.2 → 20.748', () => {
    const res = institutionNetFlow(mkInst(120, -14.96, -1.3), {
      ...cfg,
      instLayer: { enabled: true, nfScale: 0.2 },
    });
    expect(res.netFlow).toBeCloseTo(20.748, 12);
  });

  it('etfSse=null：跳过并记 degraded（含其 note），0.1 × (120 − 1.3) = 11.87', () => {
    const note = 'ETF 份额最新截面不可得（#58：仅沪市、仅 A 股股票型计入净流口径）';
    const res = institutionNetFlow(mkInst(120, null, -1.3, null, null, note), cfg);
    expect(res.netFlow).toBeCloseTo(11.87, 12);
    expect(res.usedPaths).not.toContain('etfSse');
    expect(res.usedPaths).toEqual(['margin', 'eventSeat']);
    expect(res.degraded).toEqual([{ pathId: 'etfSse', note }]);
  });

  it('五路径全 null → netFlow=0（degraded 记三条约定的日频路径）', () => {
    const res = institutionNetFlow(mkInst(null, null, null), cfg);
    expect(res.netFlow).toBe(0);
    expect(res.usedPaths).toEqual([]);
    expect(res.degraded.map((d) => d.pathId)).toEqual(['margin', 'etfSse', 'eventSeat']);
  });

  it('enabled=false → 恒 0（旧口径回退锚，#60），不读任何路径', () => {
    const res = institutionNetFlow(mkInst(120, -14.96, -1.3), {
      ...cfg,
      instLayer: { enabled: false, nfScale: 0.1 },
    });
    expect(res.netFlow).toBe(0);
    expect(res.usedPaths).toEqual([]);
    expect(res.degraded).toEqual([]);
  });

  it('inst 缺省（undefined/null，旧缓存快照）→ 与 enabled=false 同款返回 0（#64）', () => {
    expect(institutionNetFlow(undefined, cfg).netFlow).toBe(0);
    expect(institutionNetFlow(null, cfg).netFlow).toBe(0);
    expect(institutionNetFlow(undefined, cfg)).toEqual({ netFlow: 0, usedPaths: [], degraded: [] });
  });

  it('旧配置缺 instLayer → 等价旧口径恒 0', () => {
    const legacyCfg = { ...DEFAULT_CONFIG } as EngineConfig;
    delete (legacyCfg as Partial<EngineConfig>).instLayer;
    expect(institutionNetFlow(mkInst(120, -14.96, -1.3), legacyCfg).netFlow).toBe(0);
  });

  it('非有限 netFlowYi（NaN）按 null 处理并记降级，不毒化求和', () => {
    const inst = mkInst(120, Number.NaN, -1.3, null, null, '上游返回 NaN（F33 协议红线）');
    const res = institutionNetFlow(inst, cfg);
    expect(res.netFlow).toBeCloseTo(11.87, 12);
    expect(res.usedPaths).toEqual(['margin', 'eventSeat']);
    expect(res.degraded[0]?.pathId).toBe('etfSse');
  });

  it('季频/北向路径即使误带数值也不参与折算（#58：不产 NF）', () => {
    const inst = mkInst(120, -14.96, -1.3, 999, 888);
    const res = institutionNetFlow(inst, cfg);
    expect(res.netFlow).toBeCloseTo(10.374, 12);
    expect(res.usedPaths).toEqual(['margin', 'etfSse', 'eventSeat']);
  });

  it('确定性：同输入重复调用 1000 次输出逐位一致（#58 纯函数）', () => {
    const inst = mkInst(120, -14.96, -1.3);
    const first = institutionNetFlow(inst, cfg);
    for (let i = 0; i < 1000; i++) {
      const again = institutionNetFlow(inst, cfg);
      expect(again.netFlow).toBe(first.netFlow);
      expect(again.usedPaths).toEqual(first.usedPaths);
      expect(again.degraded).toEqual(first.degraded);
    }
  });

  it('DAILY_FLOW_PATH_IDS 定死为三条日频路径（#58）', () => {
    expect(DAILY_FLOW_PATH_IDS).toEqual(['margin', 'etfSse', 'eventSeat']);
  });

  it('配置开关（#63）：paths.event=false → 事件席位不参与折算、不记降级（用户选择非数据降级）', () => {
    const inst = mkInst(120, -14.96, -1.3);
    const res = institutionNetFlow(inst, {
      ...cfg,
      instLayer: { enabled: true, nfScale: 0.1, paths: { margin: true, etf: true, event: false } },
    });
    expect(res.netFlow).toBeCloseTo(0.1 * (120 - 14.96), 12);
    expect(res.usedPaths).toEqual(['margin', 'etfSse']);
    expect(res.degraded).toEqual([]);
  });

  it('旧配置缺 paths → 三路径全启用（向后兼容，round-1 行为不变）', () => {
    const res = institutionNetFlow(mkInst(120, -14.96, -1.3), {
      ...cfg,
      instLayer: { enabled: true, nfScale: 0.1 },
    } as EngineConfig);
    expect(res.netFlow).toBeCloseTo(10.374, 12);
  });
});

describe('instNarrativeLine（#64 总编日报机构行素材，零 LLM）', () => {
  it('由原始载荷拼装：点名数据源、北向未披露、南向只作资金分流、带未校准标注', () => {
    const inst = mkInst(120, -14.96, -1.3);
    // 填充 M3/M5 signals
    (inst.paths[2] as InstPathFlow).signals = { lhbYi: -2.5, dzjyYi: 1.2 };
    (inst.paths[4] as InstPathFlow).signals = { southboundNetYi: 45.72 };
    const line = instNarrativeLine(inst);
    expect(line).toContain('机构动向：两融 +120.0 亿');
    expect(line).toContain('A股ETF -15.0 亿');
    expect(line).toContain('龙虎榜+大宗 -1.3 亿');
    expect(line).toContain('南向（资金分流，非北向）+45.7 亿');
    expect(line).toContain('折算系数未校准');
    // 南向子句不得出现「北向净买+数值」组合（#59 不得充当北向代理）
    const sbClause = (line ?? '').split('、').find((c) => c.includes('南向')) ?? '';
    expect(sbClause).not.toMatch(/北向净买[+−-]?\d/);
  });

  it('载荷缺省（旧记录）→ null（行省略，#28 自愈）', () => {
    expect(instNarrativeLine(undefined)).toBeNull();
    expect(instNarrativeLine(null)).toBeNull();
  });

  it('INST_UNCALIBRATED_NOTE 明示未校准系数与量级后果（#60/#21 先例）', () => {
    expect(INST_UNCALIBRATED_NOTE).toContain('未校准');
    expect(INST_UNCALIBRATED_NOTE).toContain('0.1');
    expect(INST_UNCALIBRATED_NOTE).toContain('#60');
  });
});

describe('instInformationalSumYi（#60 顶层信息性 Σ，仅展示）', () => {
  it('透传顶层未折算 Σ；inst 缺省 → null', () => {
    expect(instInformationalSumYi({ ...mkInst(120, -14.96, -1.3), netFlowYi: 103.74 })).toBe(
      103.74,
    );
    expect(instInformationalSumYi(undefined)).toBeNull();
    expect(instInformationalSumYi({ ...mkInst(120, null, null), netFlowYi: Number.NaN })).toBeNull();
  });
});

describe('DEFAULT_CONFIG.instLayer（#60 默认值零手调）', () => {
  it('默认开启 + 折算系数 0.1（未校准，面板明示）', () => {
    expect(DEFAULT_CONFIG.instLayer.enabled).toBe(true);
    expect(DEFAULT_CONFIG.instLayer.nfScale).toBe(0.1);
  });
});

describe('applySettings 机构五键（v1.4 #63 配置键，逐键类型守卫）', () => {
  it('instEnabled/instNfScale/instPath* 逐键生效；非法类型不动；嵌套 instLayer 对象兼容', async () => {
    const { applySettings } = await import('../src/config.js');
    const base = { ...DEFAULT_CONFIG };
    const s1 = applySettings(base, {
      instEnabled: false, instNfScale: 0.2,
      instPathMargin: false, instPathEtf: false, instPathEvent: false,
    });
    expect(s1.instLayer.enabled).toBe(false);
    expect(s1.instLayer.nfScale).toBe(0.2);
    expect(s1.instLayer.paths).toEqual({ margin: false, etf: false, event: false });
    expect(base.instLayer.enabled).toBe(true); // 不污染原 cfg（深拷贝）
    const s2 = applySettings(base, { instNfScale: 'x', instEnabled: 1 }); // 非法类型全部忽略
    expect(s2.instLayer.enabled).toBe(true);
    expect(s2.instLayer.nfScale).toBe(0.1);
    const s3 = applySettings(base, { instLayer: { enabled: false, nfScale: 0.5, paths: { etf: false } } });
    expect(s3.instLayer.enabled).toBe(false);
    expect(s3.instLayer.nfScale).toBe(0.5);
    expect(s3.instLayer.paths).toEqual({ margin: true, etf: false, event: true }); // 部分合并
  });
});
