import { describe, expect, it } from 'vitest';
import {
  DOC_TYPES,
  PROVENANCE_FIELDS,
  ProvenanceSchema,
  DocTypeSchema,
  OPENAPI_COMPONENTS,
  OPENAPI_COMPONENT_NAMES,
  componentJsonSchemas,
} from '../src/index';
import type { z } from 'zod';
import {
  SCHEMA_VERSION,
  SceneInputSchema,
  TargetProfileSchema,
  FormulaSchema,
  FormulaPredictionSchema,
  CandidateSchema,
  EvidenceRefSchema,
  RecommendationReportSchema,
  ChatRequestSchema,
  CaseSeedSchema,
  KnowledgeEntrySchema,
  CorpusChunkSchema,
  SearchHitSchema,
  LabIndicatorSchema,
  BenchmarkRowSchema,
  FIELD_REGISTRY,
  toJsonSchema,
} from '../src/index';

const validScene = {
  climate: { zone: '华南高温区', pgHigh: 76, pgLow: -22 },
  traffic: { level: '重交通', esal: 20_000_000 },
  pavement: { layer: '上面层', structure: '半刚性基层沥青路面' },
  distresses: [{ type: '车辙', severity: '重' }],
  constraints: { budget: 500, schedule: 30, env: '环保要求高', noise: '低噪' },
  notes: '演示场景',
};

const validChunk = {
  chunkId: 'k-binder-001:0:v1',
  text: 'SBS 改性沥青可显著提高混合料高温抗车辙性能。',
  docType: 'knowledge',
  tags: ['高温', '车辙'],
  provenance: {
    sourceDocId: 'k-binder-001',
    contentHash: 'abc123',
    embeddingModel: 'bge-m3',
    modelVersion: 'v1',
    dim: 1024,
    pipelineRev: 'abc1234',
    embeddedAt: '2026-10-17T00:00:00Z',
  },
};

const validFormula = {
  binder: { type: 'SBS改性沥青', grade: '70号', pg: 'PG 76-22' },
  modifier: { type: 'SBS', dosage: 4.5 },
  gradation: { type: 'SMA-13' },
  additives: [{ type: '木质素纤维', dosage: 0.3 }],
  oilStoneRatio: 6.1,
  airVoids: 4.0,
};

describe('contracts 契约包', () => {
  it('B1 docType 扩展：table / literature-full 可解析，旧值向后兼容（P0）', () => {
    for (const docType of ['knowledge', 'standard', 'literature', 'enterprise', 'table', 'literature-full']) {
      expect(
        CorpusChunkSchema.safeParse({ ...validChunk, docType }).success,
        `docType=${docType}`,
      ).toBe(true);
    }
    expect(CorpusChunkSchema.safeParse({ ...validChunk, docType: 'bogus' }).success).toBe(false);
  });

  it('SceneInput 解析成功且保留未知字段（passthrough 前向兼容）', () => {
    const parsed = SceneInputSchema.parse({ ...validScene, extraField: 1, nested: { x: 2 } });
    expect(parsed.climate.zone).toBe('华南高温区');
    expect((parsed as unknown as Record<string, unknown>).extraField).toBe(1);
    expect(
      ((parsed as unknown as Record<string, unknown>).nested as { x: number }).x,
    ).toBe(2);
  });

  it('每个顶层 schema 都带 schemaVersion 且枚举为 1', () => {
    const topLevel: Array<[string, z.ZodObject<z.ZodRawShape>]> = [
      ['SceneInput', SceneInputSchema],
      ['TargetProfile', TargetProfileSchema],
      ['Formula', FormulaSchema],
      ['FormulaPrediction', FormulaPredictionSchema],
      ['Candidate', CandidateSchema],
      ['EvidenceRef', EvidenceRefSchema],
      ['RecommendationReport', RecommendationReportSchema],
      ['ChatRequest', ChatRequestSchema],
      ['CaseSeed', CaseSeedSchema],
      ['KnowledgeEntry', KnowledgeEntrySchema],
      ['CorpusChunk', CorpusChunkSchema],
      ['SearchHit', SearchHitSchema],
    ];
    for (const [name, schema] of topLevel) {
      expect(schema.shape, `${name} 缺少 schemaVersion`).toHaveProperty('schemaVersion');
    }
    // 缺省时补 1
    expect(SceneInputSchema.parse(validScene).schemaVersion).toBe(SCHEMA_VERSION);
    expect(SceneInputSchema.parse(validScene).schemaVersion).toBe('1');
    // 错误版本被拒绝
    expect(SceneInputSchema.safeParse({ ...validScene, schemaVersion: '2' }).success).toBe(false);
  });

  it('toJsonSchema 输出 JSON Schema 骨架', () => {
    const js = toJsonSchema(SceneInputSchema) as Record<string, unknown>;
    expect(js.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(js.type).toBe('object');
    expect(js).toHaveProperty('properties');
  });

  it('FIELD_REGISTRY 覆盖表单 7 条必查路径且各有 label/control', () => {
    const requiredPaths = [
      'climate.zone',
      'climate.pgHigh',
      'climate.pgLow',
      'traffic.level',
      'distresses',
      'constraints.budget',
      'notes',
    ];
    for (const path of requiredPaths) {
      const def = FIELD_REGISTRY[path];
      expect(def, `FIELD_REGISTRY 缺少 ${path}`).toBeDefined();
      expect(def.label, `${path}.label`).toBeTypeOf('string');
      expect(def.control, `${path}.control`).toBeTypeOf('string');
    }
  });

  it('B5 值域统一：病害 value 为英文 slug、zone 含案例取值、env/noise 为 select', () => {
    const distress = FIELD_REGISTRY.distresses;
    expect(distress.control).toBe('checkbox');
    const distressValues = (distress.options ?? []).map((o) => o.value);
    for (const v of ['rutting', 'shoving', 'transverse-crack', 'water-damage', 'raveling', 'skid']) {
      expect(distressValues, `病害选项 ${v}`).toContain(v);
    }
    // value 全英文 slug（与 cases.json / 场景标签对齐）
    for (const v of distressValues) {
      expect(/[\u4e00-\u9fa5]/.test(v), `病害 value 含中文：${v}`).toBe(false);
    }

    const zones = (FIELD_REGISTRY['climate.zone'].options ?? []).map((o) => o.value);
    for (const z of ['1-4 华南湿热区', '2-2 东北寒冷区', '1-3 江淮湿润区', '2-1 华北温区']) {
      expect(zones, `气候分区选项 ${z}`).toContain(z);
    }

    const env = FIELD_REGISTRY['constraints.env'];
    expect(env.control).toBe('select');
    expect((env.options ?? []).map((o) => o.value)).toEqual(['normal', 'strict']);

    const noise = FIELD_REGISTRY['constraints.noise'];
    expect(noise.control).toBe('select');
    expect((noise.options ?? []).map((o) => o.value)).toEqual(['none', 'low', 'high']);
  });

  it('C1 LabIndicator：11 项实测指标解析（阈值判定/样本量/置信区间）', () => {
    const labs = [
      { key: 'vv', label: '空隙率', group: 'volume', unit: '%', value: 4.2, threshold: { min: 3, max: 6 }, pass: true, sampleSize: 116, ciLow: 4.0, ciHigh: 4.4 },
      { key: 'vma', label: '矿料间隙率', group: 'volume', unit: '%', value: 15.5, threshold: { min: 14 }, pass: true, sampleSize: 116 },
      { key: 'vfa', label: '沥青饱和度', group: 'volume', unit: '%', value: 71, threshold: { min: 65, max: 75 }, pass: true, sampleSize: 116 },
      { key: 'ms', label: '马歇尔稳定度', group: 'marshall', unit: 'kN', value: 9.2, threshold: { min: 8 }, pass: true, sampleSize: 116 },
      { key: 'fl', label: '流值', group: 'marshall', unit: 'mm', value: 3.1, threshold: { min: 2, max: 4 }, pass: true, sampleSize: 116 },
      { key: 'tsr', label: '冻融劈裂强度比', group: 'water', unit: '%', value: 84.5, threshold: { min: 75 }, pass: true, sampleSize: 85 },
      { key: 'retainedStability', label: '浸水残留稳定度', group: 'water', unit: '%', value: 88, threshold: { min: 85 }, pass: true, sampleSize: 83 },
      { key: 'ds', label: '动稳定度', group: 'highTemp', unit: '次/mm', value: 2600, threshold: { min: 800 }, pass: true, sampleSize: 83 },
      { key: 'bendingStrain', label: '低温弯曲破坏应变', group: 'lowTemp', unit: 'με', value: 3200, threshold: { min: 2000 }, pass: true, sampleSize: 75 },
      { key: 'tensileStrength', label: '低温抗拉强度', group: 'lowTemp', unit: 'MPa', value: 6.2, sampleSize: 75 },
      { key: 'bendingModulus', label: '低温弯曲劲度模量', group: 'lowTemp', unit: 'MPa', value: 2900, sampleSize: 75 },
    ];
    for (const lab of labs) {
      expect(LabIndicatorSchema.safeParse(lab).success, `lab ${lab.key}`).toBe(true);
    }
    // 无阈值时 pass 缺省合法
    expect(LabIndicatorSchema.safeParse({ key: 'vv', label: '空隙率', group: 'volume', unit: '%', value: 4.2 }).success).toBe(true);
    // 阈值判定字段可选
    expect(LabIndicatorSchema.safeParse({ key: 'vv', label: '空隙率', group: 'volume', unit: '%', value: 4.2, threshold: { min: 3, max: 6 }, pass: false, sampleSize: 116 }).success).toBe(true);
  });

  it('C1/C4：Candidate.labIndicators 与 BenchmarkRow.acceptance 解析', () => {
    const labs = [{ key: 'vv', label: '空隙率', group: 'volume', unit: '%', value: 4.2, threshold: { min: 3, max: 6 }, pass: true, sampleSize: 116 }];
    expect(
      CandidateSchema.safeParse({
        id: 'cand-1',
        formula: validFormula,
        predictions: [],
        radar: { highTemp: 88, lowTemp: 70, fatigue: 75, waterStability: 85, lcc: 60, carbon: 55, expectedLife: 80, constructability: 90 },
        lcc: 120,
        carbon: 15,
        expectedLife: 12,
        score: 0.8,
        evidenceIds: [],
        labIndicators: labs,
      }).success,
    ).toBe(true);
    expect(
      BenchmarkRowSchema.safeParse({
        label: '空隙率',
        unit: '%',
        baseline: 4.5,
        candidates: { 'cand-1': 4.2 },
        acceptance: { min: 3, max: 6 },
      }).success,
    ).toBe(true);
  });

  it('V1：Candidate.scoreBreakdown（维度/标签/权重/归一化/贡献）与 penalty 解析', () => {
    const base = {
      id: 'cand-1',
      formula: validFormula,
      predictions: [],
      radar: { highTemp: 88, lowTemp: 70, fatigue: 75, waterStability: 85, lcc: 60, carbon: 55, expectedLife: 80, constructability: 90 },
      lcc: 120,
      carbon: 15,
      expectedLife: 12,
      score: 0.82,
      evidenceIds: [],
    };
    const parsed = CandidateSchema.safeParse({
      ...base,
      scoreBreakdown: [
        { dimension: 'highTemp', label: '高温性能', weight: 0.5, normalized: 0.9, contribution: 0.45 },
        { dimension: 'waterStability', label: '水稳定性', weight: 0.3, normalized: 0.6, contribution: 0.18 },
      ],
      penalty: 0.05,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scoreBreakdown).toHaveLength(2);
      expect(parsed.data.scoreBreakdown![0].dimension).toBe('highTemp');
      expect(parsed.data.penalty).toBe(0.05);
    }
    // 非法归一化（>1）拒绝
    expect(
      CandidateSchema.safeParse({
        ...base,
        scoreBreakdown: [{ dimension: 'x', label: 'X', weight: 1, normalized: 1.5, contribution: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it('RecommendationReport 解析成功且保留未知字段（Review Focus #1）', () => {
    const report = {
      scene: validScene,
      targets: {
        targets: [{ perf: 'highTemp', value: 76, unit: '℃' }],
        priorities: [{ perf: 'highTemp', weight: 0.5 }],
      },
      candidates: [
        {
          id: 'cand-1',
          formula: validFormula,
          predictions: [{ perf: 'highTemp', value: 82, ciLow: 80, ciHigh: 84, unit: '℃' }],
          radar: {
            highTemp: 88,
            lowTemp: 70,
            fatigue: 75,
            waterStability: 85,
            lcc: 60,
            carbon: 55,
            expectedLife: 80,
            constructability: 90,
          },
          labIndicators: [
            { key: 'ds', label: '动稳定度', group: 'highTemp', unit: '次/mm', value: 2600, threshold: { min: 800 }, pass: true, sampleSize: 83 },
          ],
          lcc: 120,
          carbon: 15,
          expectedLife: 12,
          score: 0.82,
          evidenceIds: [validChunk.chunkId],
        },
      ],
      evidence: [{ ...validChunk, score: 0.9 }],
      benchmark: [{ label: '高温性能', unit: '℃', baseline: 70, candidates: { 'cand-1': 82 } }],
      sections: [],
      llmStatus: 'degraded',
      adapterMode: { a: 'mock', c: 'mock' },
      warnings: [],
      steps: [{ name: 'parse', ms: 1 }],
    };
    const parsed = RecommendationReportSchema.parse({ ...report, futureField: 'x' });
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.llmStatus).toBe('degraded');
    expect(parsed.adapterMode).toEqual({ a: 'mock', c: 'mock' });
    expect((parsed as unknown as Record<string, unknown>).futureField).toBe('x');
  });
});


describe('T02 契约治理基线（provenance / docType / 组件导出）', () => {
  it('PROVENANCE_FIELDS 为七项且与 ProvenanceSchema 的必填键一一对应', () => {
    expect(PROVENANCE_FIELDS).toHaveLength(7);
    const shape = Object.keys(ProvenanceSchema.shape).sort();
    expect([...PROVENANCE_FIELDS].sort()).toEqual(shape);
  });

  it('DOC_TYPES 为六类且与 DocTypeSchema 的枚举值一一对应', () => {
    expect(DOC_TYPES).toHaveLength(6);
    expect([...DOC_TYPES].sort()).toEqual([...DocTypeSchema.options].sort());
  });

  it('SearchHit 与 EvidenceRef 同构：同一 schema 对象（chunkId 即证据 id）', () => {
    expect(EvidenceRefSchema).toBe(SearchHitSchema);
  });

  it('SearchHit 在 CorpusChunk 基础上仅新增 score，且 text 为原文片段字段', () => {
    const shape = Object.keys(SearchHitSchema.shape);
    expect(shape).toContain('text');
    expect(shape).toContain('chunkId');
    expect(shape).toContain('provenance');
    expect(shape).toContain('score');
  });

  it('OPENAPI_COMPONENTS 至少登记 8 个对外响应体，且名字唯一', () => {
    const names = OPENAPI_COMPONENT_NAMES;
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(typeof OPENAPI_COMPONENTS[name]?.safeParse).toBe('function');
    }
  });

  it('componentJsonSchemas 与 OPENAPI_COMPONENT_NAMES 键集合一致', () => {
    expect(Object.keys(componentJsonSchemas()).sort()).toEqual([...OPENAPI_COMPONENT_NAMES].sort());
  });

  it('每个组件 JSON Schema 带 draft-07 $schema 与 object 类型', () => {
    for (const [name, schema] of Object.entries(componentJsonSchemas()) as Array<[string, Record<string, unknown>]>) {
      expect(schema.$schema, `${name} 缺少 $schema`).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.type, `${name} 非 object`).toBe('object');
    }
  });

  it('组件导出是确定性的（两次调用深相等）', () => {
    expect(componentJsonSchemas()).toEqual(componentJsonSchemas());
  });

  it('组件名暂不含 QA 契约（留给 T07 单独登记，避免两处重复注册）', () => {
    expect(OPENAPI_COMPONENT_NAMES.some((n) => n.startsWith('Qa'))).toBe(false);
  });
});
