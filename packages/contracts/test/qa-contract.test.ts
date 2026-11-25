import { describe, expect, it } from 'vitest';
import {
  OPENAPI_QA_COMPONENT_NAMES,
  QaResponseSchema,
  QaStatusSchema,
  RefusalDecisionSchema,
  NeedInfoSlotSchema,
  needInfoFromSlots,
  validateCitationNumbering,
} from '../src/index';

const stub = {
  schemaVersion: '1',
  question: 'SBS 改性沥青适用于什么场景？',
  answer: '',
  citations: [],
  refused: false,
  needInfo: [],
  status: 'not_implemented',
} as const;

const citation = (n: number) => ({
  n,
  chunkId: `standard-x:${n}`,
  sourceDocId: 'standard-x',
  docType: 'standard' as const,
  score: 1 / n,
  snippet: `证据片段 ${n}`,
});

describe('T07 QA 接缝契约', () => {
  it('M0 骨架响应（status=not_implemented）仍可通过 QaResponse 解析', () => {
    const parsed = QaResponseSchema.parse(stub);
    expect(parsed.status).toBe('not_implemented');
    expect(parsed.citations).toEqual([]);
  });

  it('refused=true 时 refusalReason 必填，缺失则解析失败', () => {
    expect(() => QaResponseSchema.parse({ ...stub, refused: true })).toThrow();
    const ok = QaResponseSchema.parse({
      ...stub,
      refused: true,
      refusalReason: 'no_hit',
    });
    expect(ok.refusalReason).toBe('no_hit');
  });

  it('refused=false 时允许不带 refusalReason', () => {
    expect(QaResponseSchema.parse(stub).refusalReason).toBeUndefined();
  });

  it('status 三值：ok / degraded / not_implemented', () => {
    expect(QaStatusSchema.options).toEqual(['ok', 'degraded', 'not_implemented']);
    expect(() => QaStatusSchema.parse('failed')).toThrow();
  });

  it('needInfo 必须是字符串数组（不得改成结构化对象）', () => {
    const ok = QaResponseSchema.parse({ ...stub, needInfo: ['请补充气候分区'] });
    expect(ok.needInfo).toEqual(['请补充气候分区']);
    expect(() => QaResponseSchema.parse({ ...stub, needInfo: [{ key: 'zone' }] })).toThrow();
  });

  it('citations[].n 从 1 起连续、无重复时校验通过', () => {
    const parsed = QaResponseSchema.parse({
      ...stub,
      answer: 'SBS 可提高高温性能 [1]，规范有要求 [2]。',
      citations: [citation(1), citation(2)],
      status: 'ok',
    });
    expect(validateCitationNumbering(parsed.citations)).toEqual({ ok: true, errors: [] });
  });

  it('citations[].n 跳号 / 重复时校验失败并给出原因', () => {
    const skip = validateCitationNumbering([citation(1), citation(3)]);
    expect(skip.ok).toBe(false);
    expect(skip.errors.join(';')).toContain('n 应为 2');

    const dup = validateCitationNumbering([citation(1), citation(1)]);
    expect(dup.ok).toBe(false);
    expect(dup.errors.join(';')).toContain('重复');
  });

  it('citation 必须带原文片段 snippet（不接受空串以外的缺省）', () => {
    expect(() => QaResponseSchema.parse({ ...stub, citations: [{ n: 1 }] })).toThrow();
    const parsed = QaResponseSchema.parse({ ...stub, citations: [citation(1)] });
    expect(parsed.citations[0]?.snippet).toBe('证据片段 1');
  });

  it('RefusalDecision：正常判定解析成功，置信度三档', () => {
    const d = RefusalDecisionSchema.parse({
      refused: false,
      confidence: 'high',
      signals: { hitCount: 8, topScore: 0.72, coverage: 0.9 },
    });
    expect(d.confidence).toBe('high');
    expect(d.signals?.hitCount).toBe(8);
  });

  it('RefusalDecision：refused=true 缺 reason 抛错，带 reason 通过', () => {
    expect(() => RefusalDecisionSchema.parse({ refused: true, confidence: 'high' })).toThrow();
    const d = RefusalDecisionSchema.parse({
      refused: true,
      reason: 'low_relevance',
      confidence: 'medium',
    });
    expect(d.reason).toBe('low_relevance');
  });

  it('NeedInfoSlot 投影为 needInfo 字符串，确定性可复现', () => {
    const slots = [
      { key: 'climate.zone', label: '请补充气候分区', example: '华南高温区' },
      { key: 'traffic.level', label: '请补充交通等级' },
    ];
    const a = needInfoFromSlots(slots);
    const b = needInfoFromSlots(slots);
    expect(a).toEqual(b);
    expect(a).toHaveLength(2);
    expect(a[0]).toContain('华南高温区');
    expect(a[1]).toBe('请补充交通等级');
  });

  it('NeedInfoSlot：非法槽位（缺 label）解析失败，合法槽位可选 example', () => {
    expect(() => NeedInfoSlotSchema.parse({ key: 'x' })).toThrow();
    expect(NeedInfoSlotSchema.parse({ key: 'x', label: 'y' }).example).toBeUndefined();
  });

  it('QA 接缝组件登记齐全（5 个 M0 契约 + 2 个接缝 schema = 7）', () => {
    expect(OPENAPI_QA_COMPONENT_NAMES).toEqual([
      'QaRequest',
      'QaCitation',
      'QaResponse',
      'QaRefusalReason',
      'QaStatus',
      'RefusalDecision',
      'NeedInfoSlot',
    ]);
  });
});
