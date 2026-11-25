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

/** 问答端点契约守卫：M1 里程碑（T02/T03）实现后，本文件应扩展为真实问答用例。 */
describe('T02 问答端点（骨架）', () => {
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

  it('骨架阶段返回 501 且响应体符合 QaResponse 契约', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request('/api/v1/qa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: 'SBS 改性沥青适用于什么场景？', topK: 5 }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      const parsed = QaResponseSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.status).toBe('not_implemented');
        expect(parsed.data.citations).toEqual([]);
        expect(parsed.data.refused).toBe(false);
      }
    } finally {
      cleanup();
    }
  });
});
