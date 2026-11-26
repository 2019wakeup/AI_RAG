import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildFingerprint,
  evaluateIndexCheck,
  readManifest,
  resolveCheckOptions,
  type ManifestSnapshot,
} from '../build-index';

const manifest: ManifestSnapshot = {
  chunks: 11143,
  embeddingModel: 'Xenova/multilingual-e5-small',
  modelVersion: '3.8.1',
  dim: 384,
  pipelineRev: 'abc1234',
  docTypes: { knowledge: 94, standard: 57 },
};

describe('T04 build-index --check', () => {
  it('解析 --check 选项：默认后端/模型/指纹路径，--fingerprint 可覆盖', () => {
    const a = resolveCheckOptions(['--check'], {}, { indexDir: '/tmp/idx', repoRoot: '/repo' });
    expect(a.backend).toBe('lancedb');
    // 用 path.join/resolve 构造期望值：Windows 下实现会规范化为反斜杠/带盘符，字面量断言会误报
    expect(a.manifestPath).toBe(join('/tmp/idx', 'manifest.json'));
    expect(a.fingerprintPath).toBe(join('/repo', 'docs/experiments/index-fingerprint.json'));
    expect(a.writeFingerprint).toBe(true);

    const b = resolveCheckOptions(
      ['--check', '--backend=sqlite', '--model=multilingual-e5-small', '--fingerprint=/tmp/fp.json', '--no-fingerprint'],
      {},
      { indexDir: '/tmp/idx', repoRoot: '/repo' },
    );
    expect(b.backend).toBe('sqlite');
    expect(b.fingerprintPath).toBe(resolve('/tmp/fp.json'));
    expect(b.writeFingerprint).toBe(false);
  });

  it('自检通过：count 与 manifest 一致、维度与模型一致', () => {
    const r = evaluateIndexCheck({
      backend: 'lancedb',
      dbPath: '/tmp/idx/lancedb',
      storeCount: 11143,
      manifest,
      model: 'multilingual-e5-small',
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.expectedDim).toBe(384);
  });

  it('count 不一致即失败（库与 manifest 不同源）', () => {
    const r = evaluateIndexCheck({
      backend: 'lancedb',
      dbPath: '/tmp/idx/lancedb',
      storeCount: 11087,
      manifest,
      model: 'multilingual-e5-small',
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/count=11087 与 manifest chunks=11143 不一致/);
  });

  it('换模型未重建即失败（维度/模型名不匹配）', () => {
    const r = evaluateIndexCheck({
      backend: 'lancedb',
      dbPath: '/tmp/idx/lancedb',
      storeCount: 11143,
      manifest,
      model: 'bge-m3',
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/期望维度 1024/);
    expect(r.problems.join('\n')).toMatch(/embeddingModel=/);
  });

  it('空库/空 manifest 均判失败', () => {
    const r = evaluateIndexCheck({
      backend: 'sqlite',
      dbPath: '/tmp/idx/app.db',
      storeCount: 0,
      manifest: { ...manifest, chunks: 0 },
      model: 'multilingual-e5-small',
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/manifest 为空/);
    expect(r.problems.join('\n')).toMatch(/向量库为空/);
  });

  it('指纹字段齐全且除 generatedAt 外确定（同输入同输出）', () => {
    const base = {
      backend: 'lancedb',
      dbPath: '/tmp/idx/lancedb',
      manifestPath: '/tmp/idx/manifest.json',
      manifest,
      manifestHash: 'deadbeef',
      command: 'pnpm exec tsx scripts/build-index.ts --check',
      generatedAt: '2026-11-25T00:00:00.000Z',
    };
    const a = buildFingerprint(base);
    const b = buildFingerprint(base);
    expect(a).toEqual(b);
    for (const k of ['count', 'model', 'dim', 'manifestHash', 'pipelineRev', 'command', 'generatedAt']) {
      expect(a[k], `指纹缺少 ${k}`).toBeDefined();
    }
    expect(a.count).toBe(11143);
  });

  it('readManifest：缺文件报错、读入后统计 chunk 数与 docType 分布', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idx-manifest-'));
    const p = join(dir, 'manifest.json');
    try {
      expect(() => readManifest(p)).toThrow(/manifest 不存在/);
      writeFileSync(
        p,
        JSON.stringify({
          embeddingModel: 'Xenova/multilingual-e5-small',
          modelVersion: '3.8.1',
          dim: 384,
          pipelineRev: 'r1',
          chunks: {
            'a:0': { docType: 'knowledge' },
            'a:1': { docType: 'knowledge' },
            'b:0': { docType: 'standard' },
          },
        }),
      );
      const m = readManifest(p);
      expect(m.chunks).toBe(3);
      expect(m.docTypes).toEqual({ knowledge: 2, standard: 1 });
      expect(m.embeddingModel).toBe('Xenova/multilingual-e5-small');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
