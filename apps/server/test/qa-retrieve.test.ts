import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QaResponseSchema, validateCitationNumbering } from '@ai-rag/contracts';
import type { DocType, SearchHit } from '@ai-rag/contracts';
import type { VectorSearchQuery, VectorStore } from '@ai-rag/retrieval';
import { answerQuestion } from '../src/qa/index';
import { retrieveCandidates } from '../src/qa/retrieve';
import type { QaEmbedder } from '../src/qa/retrieve';
import { QA_MAX_CITATIONS, QA_MIN_CITATIONS, selectEvidence } from '../src/qa/select';

/**
 * T08 检索与证据选择：内存 fake store（不建索引），验证「取哪些、怎么编号、字段是否齐全」；
 * 真实语料端到端一致性由 T11 集成测试负责（需 data/index，CI 中 skip）。
 */

/** provenance 七字段（sourceDocId 由 mkHit 逐条给） */
const PROVENANCE = {
  contentHash: 'h'.repeat(16), embeddingModel: 'multilingual-e5-small', modelVersion: 'v1',
  dim: 384, pipelineRev: 'test', embeddedAt: '2026-11-25T00:00:00.000Z',
};

let seq = 0;

function mkHit(o: { docType: DocType; docId: string; text?: string; score?: number; chunkId?: string }): SearchHit {
  seq += 1;
  return {
    schemaVersion: '1',
    chunkId: o.chunkId ?? `${o.docId}:${seq}`,
    text: o.text ?? `${o.docId} 第 ${seq} 段原文：SBS 改性沥青软化点不低于 60℃。`,
    docType: o.docType,
    tags: [o.docId],
    score: o.score ?? 0.9 - seq * 0.01,
    provenance: { sourceDocId: o.docId, ...PROVENANCE },
  };
}

/** 内存 store：记录检索入参，按 topK 截断返回预设命中 */
function makeStore(preset: SearchHit[]): { store: VectorStore; calls: VectorSearchQuery[] } {
  const calls: VectorSearchQuery[] = [];
  const store: VectorStore = {
    add: async () => {},
    search: async (q) => {
      calls.push(q);
      return preset.slice(0, q.topK);
    },
    delete: async () => {},
    rebuild: async () => {},
    stats: async () => ({ count: 0, docTypes: {} }),
  };
  return { store, calls };
}

const embedder: QaEmbedder = { embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]) };

// T09 起 answerQuestion 会调用生成：显式关掉 LLM，保证用例走确定性的抽取式降级
beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('LLM_OFF', '1');
});
afterEach(() => vi.unstubAllEnvs());

/** 多类型命中（知识 / 规范 / 表格 / 文献全文 / 题录混合） */
function mixedHits(count = 10): SearchHit[] {
  const kinds: DocType[] = ['knowledge', 'standard', 'table', 'literature-full', 'literature'];
  return Array.from({ length: count }, (_, i) =>
    mkHit({ docType: kinds[i % kinds.length], docId: `doc-${i}`, score: 0.95 - i * 0.02 }),
  );
}

describe('T08·retrieve', () => {
  it('用 query 模式嵌入，并透传 topK 与 docTypes', async () => {
    const { store, calls } = makeStore(mixedHits());
    await retrieveCandidates({ store, embedder }, { question: 'SBS 软化点', topK: 8, docTypes: ['knowledge'] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: 'SBS 软化点', topK: 8, vector: [0.1, 0.2, 0.3] });
    expect(calls[0].filter?.docTypes).toEqual(['knowledge']);
  });

  // 三条降级路径 → 一律纯 BM25，不抛错（问答可用性优先）
  it.each([
    ['embedder 为 null', null],
    ['embedder 抛错', { embed: async () => { throw new Error('model unavailable'); } }],
    ['embedder 返回空向量', { embed: async (t: string[]) => t.map(() => []) }],
  ])('%s 时降级为纯 BM25', async (_name, emb) => {
    const { store, calls } = makeStore(mixedHits());
    const result = await retrieveCandidates({ store, embedder: emb as QaEmbedder | null }, { question: '软化点', topK: 5 });

    expect(calls[0].vector).toBeUndefined();
    expect(result.vectorUsed).toBe(false);
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('空白问题不调用 store', async () => {
    const { store, calls } = makeStore(mixedHits());
    expect((await retrieveCandidates({ store, embedder }, { question: '   ', topK: 5 })).hits).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('T08·select', () => {
  it('多类型命中给出 3–8 条不重复 chunk、按 score 降序；maxCitations 更小不放大候选池', () => {
    const chosen = selectEvidence(mixedHits(10));
    expect(chosen.length).toBeGreaterThanOrEqual(QA_MIN_CITATIONS);
    expect(chosen.length).toBeLessThanOrEqual(QA_MAX_CITATIONS);
    expect(new Set(chosen.map((h) => h.chunkId)).size).toBe(chosen.length);
    expect(chosen.map((h) => h.score)).toEqual([...chosen.map((h) => h.score)].sort((a, b) => b - a));
    expect(selectEvidence(mixedHits(10), { maxCitations: 2 }).length).toBeLessThanOrEqual(2);
  });

  it('同一篇文献的多个章节块也能凑够下限（不被「同 docId 只留 1 条」卡住）', () => {
    const hits = Array.from({ length: 6 }, (_, i) =>
      mkHit({ docType: 'literature-full', docId: 'paper-1', score: 0.9 - i * 0.03 }),
    );
    const chosen = selectEvidence(hits);
    expect(chosen.length).toBeGreaterThanOrEqual(QA_MIN_CITATIONS);
    expect(chosen.length).toBeLessThanOrEqual(QA_MAX_CITATIONS);
  });

  // review 回归：主排序必须是相关度，docType 优先序不得把最高分挤掉
  it('最高分命中必须排在 citations[0]（不被 docType 优先序挤掉）', () => {
    expect(selectEvidence(mixedHits(10))[0].score).toBeCloseTo(0.95, 5); // knowledge 类型的最高分
  });

  it('命中充足时取满 maxCitations（不再被核心槽位锁死在 3 条）', () => {
    expect(selectEvidence(mixedHits(10), { maxCitations: 8 })).toHaveLength(8);
    expect(selectEvidence(mixedHits(10), { maxCitations: 5 })).toHaveLength(5);
  });

  it('同一篇文献多章节不霸屏：其他文献的命中仍能进入 citations', () => {
    const hits = [
      ...[0, 1, 2].map((i) => mkHit({ docType: 'literature-full', docId: 'paper-A', score: 0.9 - i * 0.01 })),
      mkHit({ docType: 'standard', docId: 'std-B', score: 0.5 }),
    ];
    const chosen = selectEvidence(hits, { maxCitations: 3 });
    expect(chosen).toHaveLength(3);
    expect(chosen.some((h) => h.provenance.sourceDocId === 'std-B')).toBe(true);
  });

  it('命中不足下限时不虚增；空输入返回空数组', () => {
    expect(selectEvidence([mkHit({ docType: 'knowledge', docId: 'k1' }), mkHit({ docType: 'standard', docId: 'k2' })])).toHaveLength(2);
    expect(selectEvidence([])).toEqual([]);
  });

  it('重复 chunkId 与空文本命中被丢弃', () => {
    const chosen = selectEvidence([
      mkHit({ docType: 'knowledge', docId: 'k1', chunkId: 'dup', score: 0.9 }),
      mkHit({ docType: 'knowledge', docId: 'k2', chunkId: 'dup', score: 0.8 }),
      mkHit({ docType: 'standard', docId: 'k3', text: '   ', score: 0.7 }),
      mkHit({ docType: 'table', docId: 'k4', score: 0.6 }),
      mkHit({ docType: 'literature', docId: 'k5', score: 0.5 }),
    ]);
    expect(chosen.map((h) => h.chunkId)).not.toContain('k3:3');
    expect(new Set(chosen.map((h) => h.chunkId)).size).toBe(chosen.length);
    expect(chosen.every((h) => h.text.trim().length > 0)).toBe(true);
  });
});

describe('T08·answerQuestion', () => {
  it('有命中：citations 3–8 条、六字段齐全、snippet 逐字等于 chunk 原文、n 连续', async () => {
    const preset = mixedHits(10);
    const { store } = makeStore(preset);
    const res = await answerQuestion({ store, embedder }, { question: 'SBS 改性沥青软化点要求' });

    expect(QaResponseSchema.safeParse(res).success).toBe(true);
    // 无 LLM key（beforeEach 已关）：答案走抽取式降级，因此是 degraded 而不是 ok
    expect(res.status).toBe('degraded');
    expect(res.citations.length).toBeGreaterThanOrEqual(QA_MIN_CITATIONS);
    expect(res.citations.length).toBeLessThanOrEqual(QA_MAX_CITATIONS);

    // n 连续用契约自检，不另写一套断言
    expect(validateCitationNumbering(res.citations)).toEqual({ ok: true, errors: [] });
    const origin = new Map(preset.map((h) => [h.chunkId, h]));
    for (const c of res.citations) {
      const src = origin.get(c.chunkId);
      expect(src).toBeDefined();
      expect(c.sourceDocId).toBe(src?.provenance.sourceDocId);
      expect(c.docType).toBe(src?.docType);
      expect(typeof c.score).toBe('number');
      // 验收②：snippet 必须是该 chunk 原文（非空、不截成标题）
      expect(c.snippet).toBe(src?.text);
      expect(c.snippet.trim().length).toBeGreaterThan(0);
    }
    // trace 回填（qa.topK=8 → store 侧按 topK 截断）
    expect(res.trace?.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(res.trace?.hitCount).toBe(8);
    expect(res.trace?.topScore).toBeCloseTo(0.95, 5);
    expect(res.trace?.vectorUsed).toBe(true);
  });

  it('无 LLM：给抽取式答案（非空、每个主题段带 [n]）且不冒充拒答（拒答由 T19 接入）', async () => {
    const { store } = makeStore(mixedHits());
    const res = await answerQuestion({ store, embedder }, { question: '软化点' });

    expect(res.answer.length).toBeGreaterThan(0);
    expect(res.answer).toMatch(/\[\d+\]/);
    expect(res.trace?.generateMs).toBeGreaterThanOrEqual(0);
    expect(res.trace?.llmUsed).toBe(false);
    expect(res.refused).toBe(false);
    expect(res.refusalReason).toBeUndefined();
    expect(res.needInfo).toEqual([]);
  });

  it('空库 → citations 为空、status=degraded、不抛异常（验收③）', async () => {
    const { store } = makeStore([]);
    const res = await answerQuestion({ store, embedder }, { question: 'SBS 改性沥青软化点要求' });

    expect(res.citations).toEqual([]);
    expect(res.status).toBe('degraded');
    expect(res.refused).toBe(false);
    expect(res.trace?.hitCount).toBe(0);
    expect(QaResponseSchema.safeParse(res).success).toBe(true);
  });

  it('请求 topK 优先于 qa.topK，并同时约束 citations 上限', async () => {
    const { store, calls } = makeStore(mixedHits(10));
    const res = await answerQuestion({ store, embedder }, { question: '软化点', topK: 4 });

    expect(calls[0].topK).toBe(4);
    expect(res.citations.length).toBeLessThanOrEqual(4);
  });
});
