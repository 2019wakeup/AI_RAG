import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '@ai-rag/retrieval';
import type { VectorStore } from '@ai-rag/retrieval';
import { createVectorStore, resolveEmbeddingModel } from '../src/config';

describe('EMBEDDING_MODEL 启动参数解析', () => {
  it('未设置 → 默认 bge-m3', () => {
    expect(resolveEmbeddingModel({})).toBe('bge-m3');
  });

  it('合法值 bge-m3 / multilingual-e5-small 透传', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_MODEL: 'bge-m3' })).toBe('bge-m3');
    expect(resolveEmbeddingModel({ EMBEDDING_MODEL: 'multilingual-e5-small' })).toBe(
      'multilingual-e5-small',
    );
  });

  it('非法值 → 抛错（启动退出）', () => {
    expect(() => resolveEmbeddingModel({ EMBEDDING_MODEL: 'gpt-99' })).toThrow(
      /EMBEDDING_MODEL/,
    );
  });
});

describe('createVectorStore（R3-C2：先 embedder 后 store，dim 对齐）', () => {
  let dir: string;
  let store: VectorStore | undefined;

  afterEach(() => {
    // Windows：LanceDB/SQLite 句柄未关闭时删除临时目录会 EPERM，先 close 再删
    (store as { close?: () => void } | undefined)?.close?.();
    store = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 't8store-'));
  });

  it('lancedb：store 构造器收到的 dim == embedder.dim', () => {
    store = createVectorStore({ backend: 'lancedb', indexDir: dir, dim: 384 });
    expect((store as unknown as { dim: number }).dim).toBe(384);
  });

  it('lancedb：embedder 失败（dim null）→ 默认 dim 1024', () => {
    store = createVectorStore({ backend: 'lancedb', indexDir: dir, dim: null });
    expect((store as unknown as { dim: number }).dim).toBe(1024);
  });

  it('sqlite 后端 → SqliteVectorStore（不受 dim 影响）', () => {
    store = createVectorStore({ backend: 'sqlite', indexDir: dir, dim: 384 });
    expect(store).toBeInstanceOf(SqliteVectorStore);
  });
});
