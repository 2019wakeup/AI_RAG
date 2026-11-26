import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '@ai-rag/retrieval';
import { QaResponseSchema } from '@ai-rag/contracts';
import { initRelationDb } from '../src/relation/db';
import { createApp } from '../src/app';
import type { EmbedderLike } from '../src/orchestrator';

const fakeEmbedder: EmbedderLike = {
  dim: 2,
  modelName: 'fake',
  modelVersion: 'v0',
  embed: async (texts: string[]) => texts.map(() => [0, 0]),
};

/** 问答端点契约守卫（T08 起为真实检索链路；更细的检索/证据用例见 qa-retrieve.test.ts）。 */
describe('T08 问答端点（检索链路）', () => {
  function makeApp() {
    const dir = mkdtempSync(join(tmpdir(), 'qa-'));
    const relationDb = initRelationDb(join(dir, 'relation.db'));
    const store = new SqliteVectorStore(':memory:');
    const app = createApp({
      store,
      embedder: fakeEmbedder,
      relationDb,
      backend: 'sqlite',
      corpusDir: join(dir, 'corpus'),
      manifestPath: join(dir, 'manifest.json'),
    });
    const cleanup = () => {
      store.close();
      relationDb.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { app, cleanup };
  }

  it('非法请求返回 400', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request('/api/v1/qa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: '' }),
      });
      expect(res.status).toBe(400);
    } finally {
      cleanup();
    }
  });

  it('空库返回 200 且响应体符合 QaResponse 契约（citations 为空、status=degraded，不 5xx）', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request('/api/v1/qa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'SBS 改性沥青适用于什么场景？', topK: 5 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      const parsed = QaResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe('degraded');
        expect(parsed.data.citations).toEqual([]);
        expect(parsed.data.refused).toBe(false);
        expect(parsed.data.answer).toBe('');
        expect(parsed.data.trace?.hitCount).toBe(0);
      }
    } finally {
      cleanup();
    }
  });
});
