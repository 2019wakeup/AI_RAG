import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '@ai-rag/retrieval';
import { QaResponseSchema, validateCitationNumbering } from '@ai-rag/contracts';
import type { DocType, QaResponse, SearchHit } from '@ai-rag/contracts';
import type { VectorStore } from '@ai-rag/retrieval';
import type { LlmCall } from '../src/llm/client';
import { createApp } from '../src/app';
import { initRelationDb } from '../src/relation/db';
import { splitAnswer, streamAnswer } from '../src/qa/stream';
import type { QaStreamFrame } from '../src/qa/stream';

/** T10 流式：逐帧断言事件序列与载荷；内存 store + fake LLM，不触网、不依赖真实索引。 */

const PROVENANCE = {
  contentHash: 'h'.repeat(16), embeddingModel: 'multilingual-e5-small', modelVersion: 'v1',
  dim: 384, pipelineRev: 'test', embeddedAt: '2026-11-25T00:00:00.000Z',
};
let seq = 0;

function mkHit(o: { docType: DocType; docId: string; score?: number }): SearchHit {
  seq += 1;
  return {
    schemaVersion: '1',
    chunkId: `${o.docId}:${seq}`,
    text: `${o.docId} 第 ${seq} 段原文：SBS 改性沥青软化点不低于 60℃。`,
    docType: o.docType,
    tags: [o.docId],
    score: o.score ?? 0.95 - seq * 0.01,
    provenance: { sourceDocId: o.docId, ...PROVENANCE },
  };
}

/** 多类型命中：覆盖抽取式按主题归并的分支 */
const HITS: SearchHit[] = [
  mkHit({ docType: 'knowledge', docId: 'k1', score: 0.95 }),
  mkHit({ docType: 'standard', docId: 's1', score: 0.93 }),
  mkHit({ docType: 'table', docId: 't1', score: 0.86 }),
  mkHit({ docType: 'literature-full', docId: 'l1', score: 0.8 }),
];

function makeStore(preset: SearchHit[]): VectorStore {
  return {
    add: async () => {},
    search: async (q) => preset.slice(0, q.topK),
    delete: async () => {},
    rebuild: async () => {},
    stats: async () => ({ count: 0, docTypes: {} }),
  };
}

// dim/modelName/modelVersion 让它同时满足 EmbedderLike（路由）与 QaEmbedder（qa 链路）
const embedder = {
  dim: 3,
  modelName: 'fake',
  modelVersion: 'v0',
  embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
};

// 显式关掉 LLM：默认走确定性的抽取式降级
beforeEach(() => {
  vi.stubEnv('DEEPSEEK_API_KEY', '');
  vi.stubEnv('LLM_OFF', '1');
});
afterEach(() => vi.unstubAllEnvs());

const Q = 'SBS 改性沥青软化点要求';

async function collect(llm?: LlmCall, preset = HITS): Promise<QaStreamFrame[]> {
  const deps = { store: makeStore(preset), embedder, ...(llm ? { llm } : {}) };
  const frames: QaStreamFrame[] = [];
  for await (const f of streamAnswer(deps, { question: Q })) frames.push(f);
  return frames;
}
const eventOf = (frames: QaStreamFrame[]) => frames.map((f) => f.event);
const last = (frames: QaStreamFrame[]) => frames[frames.length - 1];
const done = (frames: QaStreamFrame[]) => last(frames).data as QaResponse;
const deltasOf = (frames: QaStreamFrame[]) =>
  frames.filter((f) => f.event === 'delta').map((f) => (f.data as { delta: string }).delta);
const citationsOf = (frames: QaStreamFrame[]) => frames.filter((f) => f.event === 'citation').map((f) => f.data);

describe('T10·帧序列（验收①）', () => {
  it('meta 是首帧且带四要素；顺序为 meta → delta… → citation… → done', async () => {
    const events = eventOf(await collect());
    expect(events[0]).toBe('meta');
    expect(events.at(-1)).toBe('done');
    const firstDelta = events.indexOf('delta');
    const firstCitation = events.indexOf('citation');
    expect(firstDelta).toBeGreaterThan(0);
    expect(firstCitation).toBeGreaterThan(firstDelta);
    expect(events.slice(firstCitation).every((e) => e === 'citation' || e === 'done')).toBe(true);
  });

  it('meta.trace 含 retrievalMs / hitCount / vectorUsed / citationCount（生成前即可用）', async () => {
    const meta = (await collect())[0].data as { question: string; trace: Record<string, unknown> };
    expect(meta.question).toBe(Q);
    expect(meta.trace.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(meta.trace.hitCount).toBe(HITS.length);
    expect(meta.trace.vectorUsed).toBe(true);
    expect(meta.trace.citationCount).toBeGreaterThanOrEqual(3);
  });

  it('done 载荷通过 QaResponseSchema 与编号自检，trace 分项齐全（验收③）', async () => {
    const res = done(await collect());
    expect(QaResponseSchema.safeParse(res).success).toBe(true);
    expect(validateCitationNumbering(res.citations)).toEqual({ ok: true, errors: [] });
    expect(res.trace?.retrievalMs).toBeGreaterThanOrEqual(0);
    expect(res.trace?.generateMs).toBeGreaterThanOrEqual(0);
    expect(res.trace?.llmUsed).toBe(false);
    expect(res.status).toBe('degraded');
  });
});

describe('T10·增量与证据帧', () => {
  it('delta 拼接后逐字等于 done.answer；citation 帧与 done.citations 一一对应', async () => {
    const frames = await collect();
    expect(deltasOf(frames).join('')).toBe(done(frames).answer);
    expect(deltasOf(frames).join('').length).toBeGreaterThan(0);
    expect(citationsOf(frames)).toEqual(done(frames).citations);
    expect(citationsOf(frames).length).toBeGreaterThanOrEqual(3);
  });

  it('空库：只有 meta + done，无 delta / citation，answer 为空且不 5xx', async () => {
    const frames = await collect(undefined, []);
    expect(eventOf(frames)).toEqual(['meta', 'done']);
    expect(done(frames).answer).toBe('');
    expect(done(frames).citations).toEqual([]);
  });
});

describe('T10·无 LLM / 402 降级（验收②）', () => {
  it('402 抛错：仍然发出 done 而不是挂起，端到端 < 2s', async () => {
    const started = Date.now();
    const llm: LlmCall = async () => {
      throw new Error('402 Payment Required');
    };
    const frames = await collect(llm);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(done(frames).status).toBe('degraded');
    expect(done(frames).answer).toMatch(/\[\d+\]/);
  });

  it('LLM 可用：done 为 ok，越界角标 [9] 被剔除、其余角标都落在 citations 内', async () => {
    const llm: LlmCall = async () => JSON.stringify({ answer: '软化点不小于 46℃ [1]，掺量 3%~5% [9]。' });
    const res = done(await collect(llm));
    expect(res.status).toBe('ok');
    expect(res.answer).not.toContain('[9]');
    for (const m of res.answer.matchAll(/\[(\d+)\]/g)) expect(Number(m[1])).toBeLessThanOrEqual(res.citations.length);
  });
});

describe('T10·splitAnswer 切分不变量', () => {
  it('join 还原原文、不在 [n] 中间下刀；空答案为空数组、短答案单帧', () => {
    const long = `${'甲'.repeat(60)}[1]${'乙'.repeat(120)}[2]。`;
    const parts = splitAnswer(long, 20);
    expect(parts.join('')).toBe(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(/\[\d*$/.test(p)).toBe(false);
    expect(splitAnswer('')).toEqual([]);
    expect(splitAnswer('短答案。')).toEqual(['短答案。']);
  });
});

describe('T10·路由 /api/v1/qa/stream', () => {
  function makeApp(llmCall?: LlmCall) {
    const dir = mkdtempSync(join(tmpdir(), 'qa-stream-'));
    const relationDb = initRelationDb(join(dir, 'relation.db'));
    const store = new SqliteVectorStore(':memory:');
    const app = createApp({
      store, embedder, relationDb, backend: 'sqlite',
      corpusDir: join(dir, 'corpus'), manifestPath: join(dir, 'manifest.json'),
      ...(llmCall ? { llmCall } : {}),
    });
    return {
      app,
      cleanup: () => {
        store.close();
        relationDb.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  /** 拆 SSE 响应体为 [event, data]（与前端 parseSseStream 同规则：空行分隔） */
  function framesOf(text: string): Array<[string, string]> {
    return text.split(/\r?\n\r?\n/).map((b) => /event: (.+)\ndata: ([\s\S]*)/.exec(b.trim()))
      .filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1].trim(), m[2].trim()]);
  }

  const post = (app: ReturnType<typeof makeApp>['app'], body: unknown) =>
    app.request('/api/v1/qa/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('返回 text/event-stream，含 meta 与 done，done 载荷过契约', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await post(app, { question: Q });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
      const frames = framesOf(await res.text());
      expect(frames[0][0]).toBe('meta');
      expect(frames.at(-1)?.[0]).toBe('done');
      expect(QaResponseSchema.safeParse(JSON.parse(frames.at(-1)?.[1] ?? 'null')).success).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('注入的 llmCall 透传到问答链路（402 → 仍发 done 且 degraded）', async () => {
    const llmCall: LlmCall = async () => {
      throw new Error('402 Payment Required');
    };
    const { app, cleanup } = makeApp(llmCall);
    try {
      const frames = framesOf(await (await post(app, { question: Q })).text());
      expect(frames.at(-1)?.[0]).toBe('done');
      const body = JSON.parse(frames.at(-1)?.[1] ?? 'null');
      expect([body.status, body.trace.llmUsed]).toEqual(['degraded', false]);
    } finally {
      cleanup();
    }
  });

  it('非法请求返回 400（JSON 而非 SSE）', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await post(app, { question: '' });
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type') ?? '').toContain('application/json');
    } finally {
      cleanup();
    }
  });
});
