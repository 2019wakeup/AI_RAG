import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteVectorStore } from '@ai-rag/retrieval';
import {
  OPENAPI_COMPONENT_NAMES,
  OPENAPI_QA_COMPONENT_NAMES,
  componentJsonSchemas,
} from '@ai-rag/contracts';
import { initRelationDb } from '../src/relation/db';
import { createApp } from '../src/app';

/** T02：/openapi 的 components.schemas 必须与 packages/contracts 的组件登记同源。 */
describe('T02 OpenAPI 组件导出', () => {
  function makeApp() {
    const dir = mkdtempSync(join(tmpdir(), 'openapi-'));
    const relationDb = initRelationDb(join(dir, 'relation.db'));
    const store = new SqliteVectorStore(':memory:');
    const app = createApp({
      store,
      embedder: null,
      relationDb,
      backend: 'sqlite',
      corpusDir: join(dir, 'corpus'),
      manifestPath: join(dir, 'manifest.json'),
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

  it('GET /openapi 返回 200 且 components.schemas 覆盖全部登记组件', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request('/openapi');
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        components?: { schemas?: Record<string, unknown> };
      };
      const names = Object.keys(doc.components?.schemas ?? {});
      for (const name of [...OPENAPI_COMPONENT_NAMES, ...OPENAPI_QA_COMPONENT_NAMES]) {
        expect(names, `components.schemas 缺少 ${name}`).toContain(name);
      }
    } finally {
      cleanup();
    }
  });

  it('/openapi 的组件与 componentJsonSchemas() 名字集合一致', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request('/openapi');
      const doc = (await res.json()) as {
        components?: { schemas?: Record<string, unknown> };
      };
      const openapiNames = Object.keys(doc.components?.schemas ?? {}).sort();
      expect(openapiNames).toEqual(
        [...OPENAPI_COMPONENT_NAMES, ...OPENAPI_QA_COMPONENT_NAMES].sort(),
      );
      // componentJsonSchemas() 只覆盖通用响应体；QA 组件单独登记
      for (const name of Object.keys(componentJsonSchemas())) {
        expect(openapiNames).toContain(name);
      }
    } finally {
      cleanup();
    }
  });

  it('T07：/openapi 含 /api/v1/qa 路径且引用了 QA 组件', async () => {
    const { app, cleanup } = makeApp();
    try {
      const res = await app.request('/openapi');
      const doc = (await res.json()) as {
        paths?: Record<string, unknown>;
        components?: { schemas?: Record<string, unknown> };
      };
      expect(doc.paths?.['/api/v1/qa']).toBeDefined();
      const qa = Object.keys(doc.components?.schemas ?? {});
      for (const name of OPENAPI_QA_COMPONENT_NAMES) {
        expect(qa, `缺少 QA 组件 ${name}`).toContain(name);
      }
    } finally {
      cleanup();
    }
  });
});
