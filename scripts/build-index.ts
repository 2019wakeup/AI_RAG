/**
 * build-index CLI（T4，薄封装）：入库管线入口（spec §6.4 "可重建缓存"防线的执行者）。
 *
 * 用法（pnpm build:index 已绑定默认用法）：
 *   tsx scripts/build-index.ts [--rebuild] [--backend=sqlite|lancedb] [--model=...] [--db-path=...]
 *   tsx scripts/build-index.ts --check [--fingerprint=<path>] [--no-fingerprint]
 *
 * --check（T04）：只读自检，不重建、不加载嵌入模型：
 *   - manifest 是否存在、chunk 数与向量库实际 count 是否一致
 *   - 索引模型/维度与 EMBEDDING_MODEL 的期望维度是否一致（防「换模型没重建」的静默错配）
 *   - 输出 / 刷新 docs/experiments/index-fingerprint.json（索引指纹，入库）
 *
 * 环境变量：
 *   RETRIEVAL_BACKEND=sqlite|lancedb  后端引擎（默认 lancedb，见 spec D3）
 *   EMBEDDING_MODEL=bge-m3|multilingual-e5-small  嵌入模型（默认 bge-m3）
 *   HF_ENDPOINT=https://hf-mirror.com  模型下载镜像（网络受限时）
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SqliteVectorStore } from '../packages/retrieval/src/sqlite';
import { buildIndex } from '../packages/retrieval/src/build';
import type { VectorStore } from '../packages/retrieval/src/types';
import { createEmbedder, MODEL_REGISTRY, type EmbedderModel } from '../packages/embedding/src/embedder';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusDir = path.resolve(here, '../data/corpus');
const indexDir = path.resolve(here, '../data/index');

export const EMBEDDING_MODELS = ['bge-m3', 'multilingual-e5-small', 'multilingual-e5-base'] as const;

export interface CliOptions {
  rebuild: boolean;
  backend: 'sqlite' | 'lancedb';
  model: EmbedderModel;
  /** 库目录覆盖（D5 双索引实验；默认 data/index/{lancedb|app.db}） */
  dbPath?: string;
}

/** 纯参数解析（可测试）：非法 backend/model 抛明确错误（C4） */
export function resolveCliOptions(args: string[], env: NodeJS.ProcessEnv): CliOptions {
  const rebuild = args.includes('--rebuild');
  const backendArg = args.find((a) => a.startsWith('--backend='));
  const backend = backendArg?.split('=')[1] ?? env.RETRIEVAL_BACKEND ?? 'lancedb';
  const modelArg = args.find((a) => a.startsWith('--model='));
  const model = modelArg?.split('=')[1] ?? env.EMBEDDING_MODEL ?? 'bge-m3';
  const dbPathArg = args.find((a) => a.startsWith('--db-path='));

  if (backend !== 'sqlite' && backend !== 'lancedb') {
    throw new Error(`不支持的 backend: ${backend}（可选 sqlite|lancedb）`);
  }
  if (!(EMBEDDING_MODELS as readonly string[]).includes(model)) {
    throw new Error(`不支持的 embedding 模型: ${model}（可选 ${EMBEDDING_MODELS.join('|')}）`);
  }
  return {
    rebuild,
    backend: backend as CliOptions['backend'],
    model: model as EmbedderModel,
    dbPath: dbPathArg?.split('=')[1] || undefined,
  };
}

// ---------------------------------------------------------------------------
// --check 自检（T04）：纯函数可单测，runCheck 负责 I/O
// ---------------------------------------------------------------------------

export interface CheckOptions {
  backend: 'sqlite' | 'lancedb';
  model: EmbedderModel;
  indexDir: string;
  dbPath?: string;
  manifestPath: string;
  fingerprintPath: string;
  writeFingerprint: boolean;
}

export function resolveCheckOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: { indexDir?: string; repoRoot?: string } = {},
): CheckOptions {
  const base = resolveCliOptions(args, env);
  const indexDirDefault = opts.indexDir ?? indexDir;
  const repoRoot = opts.repoRoot ?? path.resolve(here, '..');
  const fingerprintArg = args.find((a) => a.startsWith('--fingerprint='));
  return {
    backend: base.backend,
    model: base.model,
    indexDir: indexDirDefault,
    dbPath: base.dbPath,
    manifestPath: path.join(indexDirDefault, 'manifest.json'),
    fingerprintPath: fingerprintArg
      ? path.resolve(fingerprintArg.slice('--fingerprint='.length))
      : path.join(repoRoot, 'docs/experiments/index-fingerprint.json'),
    writeFingerprint: !args.includes('--no-fingerprint'),
  };
}

export interface ManifestSnapshot {
  chunks: number;
  embeddingModel: string;
  modelVersion: string;
  dim: number;
  pipelineRev: string;
  docTypes: Record<string, number>;
}

export function readManifest(manifestPath: string): ManifestSnapshot {
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest 不存在：${manifestPath}（先执行 pnpm build:index --rebuild）`);
  }
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    chunks?: Record<string, { docType?: string }>;
    embeddingModel?: string;
    modelVersion?: string;
    dim?: number;
    pipelineRev?: string;
  };
  const chunks = raw.chunks ?? {};
  const docTypes: Record<string, number> = {};
  for (const v of Object.values(chunks)) {
    const t = v.docType ?? 'unknown';
    docTypes[t] = (docTypes[t] ?? 0) + 1;
  }
  return {
    chunks: Object.keys(chunks).length,
    embeddingModel: raw.embeddingModel ?? 'unknown',
    modelVersion: raw.modelVersion ?? 'unknown',
    dim: raw.dim ?? 0,
    pipelineRev: raw.pipelineRev ?? 'unknown',
    docTypes,
  };
}

export interface IndexCheckInput {
  backend: string;
  dbPath: string;
  storeCount: number;
  manifest: ManifestSnapshot;
  model: EmbedderModel;
}

export interface IndexCheckResult {
  ok: boolean;
  problems: string[];
  expectedDim: number;
}

/** 纯判定：向量库实际 count 与 manifest、模型维度与索引维度是否自洽。 */
export function evaluateIndexCheck(input: IndexCheckInput): IndexCheckResult {
  const problems: string[] = [];
  const expectedDim = MODEL_REGISTRY[input.model].dim;
  if (input.storeCount !== input.manifest.chunks) {
    problems.push(
      `向量库 count=${input.storeCount} 与 manifest chunks=${input.manifest.chunks} 不一致（库与 manifest 不同源）`,
    );
  }
  if (input.manifest.dim !== expectedDim) {
    problems.push(
      `索引维度 dim=${input.manifest.dim} 与 EMBEDDING_MODEL=${input.model} 的期望维度 ${expectedDim} 不一致（换模型后未重建）`,
    );
  }
  if (!input.manifest.embeddingModel.includes(input.model)) {
    problems.push(
      `manifest 的 embeddingModel=${input.manifest.embeddingModel} 与 EMBEDDING_MODEL=${input.model} 不匹配`,
    );
  }
  if (input.manifest.chunks === 0) problems.push('manifest 为空（chunks=0）');
  if (input.storeCount === 0) problems.push(`向量库为空：${input.dbPath}`);
  return { ok: problems.length === 0, problems, expectedDim };
}

export interface FingerprintInput {
  backend: string;
  dbPath: string;
  manifestPath: string;
  manifest: ManifestSnapshot;
  manifestHash: string;
  command: string;
  generatedAt: string;
}

/** 索引指纹（入库证据）：二次运行只有 generatedAt 变化。 */
export function buildFingerprint(input: FingerprintInput): Record<string, unknown> {
  return {
    count: input.manifest.chunks,
    model: input.manifest.embeddingModel,
    modelVersion: input.manifest.modelVersion,
    dim: input.manifest.dim,
    backend: input.backend,
    dbPath: input.dbPath,
    manifestPath: input.manifestPath,
    manifestHash: input.manifestHash,
    pipelineRev: input.manifest.pipelineRev,
    docTypes: input.manifest.docTypes,
    command: input.command,
    generatedAt: input.generatedAt,
  };
}

export function sha256OfFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function runCheck(check: CheckOptions): Promise<number> {
  const manifest = readManifest(check.manifestPath);
  const dbPath =
    check.backend === 'sqlite'
      ? check.dbPath ?? path.join(check.indexDir, 'app.db')
      : check.dbPath ?? path.join(check.indexDir, 'lancedb');

  let store: VectorStore;
  if (check.backend === 'sqlite') {
    store = new SqliteVectorStore(dbPath);
  } else {
    const { LanceDBVectorStore } = await import('../packages/retrieval/src/lancedb');
    store = new LanceDBVectorStore(dbPath, { dim: manifest.dim });
  }
  const stats = await store.stats();
  const result = evaluateIndexCheck({
    backend: check.backend,
    dbPath,
    storeCount: stats.count,
    manifest,
    model: check.model,
  });

  console.log(
    [
      `index-check: count=${manifest.chunks} model=${manifest.embeddingModel} dim=${manifest.dim} backend=${check.backend}`,
      `  store: count=${stats.count} docTypes=${JSON.stringify(stats.docTypes)}`,
      `  path: ${dbPath}`,
      `  manifest: ${check.manifestPath}`,
      result.ok ? '  ✅ 自检通过' : `  ❌ ${result.problems.length} 项问题`,
      ...result.problems.map((p) => `   - ${p}`),
    ].join('\n'),
  );

  if (check.writeFingerprint) {
    const repoRoot = path.resolve(here, '..');
    const rel = (p: string): string => path.relative(repoRoot, p) || p;
    const fingerprint = buildFingerprint({
      backend: check.backend,
      dbPath: rel(dbPath),
      manifestPath: rel(check.manifestPath),
      manifest,
      manifestHash: sha256OfFile(check.manifestPath),
      command: 'pnpm exec tsx scripts/build-index.ts --check',
      generatedAt: new Date().toISOString(),
    });
    mkdirSync(path.dirname(check.fingerprintPath), { recursive: true });
    writeFileSync(check.fingerprintPath, `${JSON.stringify(fingerprint, null, 2)}\n`);
    console.log(`  指纹已写入：${check.fingerprintPath}`);
  }
  return result.ok ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--check')) {
    const check = resolveCheckOptions(args, process.env);
    process.exitCode = await runCheck(check);
    return;
  }
  const { rebuild, backend, model, dbPath } = resolveCliOptions(args, process.env);

  const embedder = await createEmbedder({
    model,
    cacheDir: process.env.EMBEDDING_CACHE_DIR ?? path.join(indexDir, 'hf-cache'),
  });
  let store: VectorStore;
  if (backend === 'sqlite') {
    store = new SqliteVectorStore(dbPath ?? path.join(indexDir, 'app.db'));
  } else {
    const { LanceDBVectorStore } = await import('../packages/retrieval/src/lancedb');
    store = new LanceDBVectorStore(dbPath ?? path.join(indexDir, 'lancedb'), { dim: embedder.dim });
  }

  const startedAt = Date.now();
  const result = await buildIndex({
    corpusDir,
    store,
    embedder,
    rebuild,
    manifestPath: path.join(indexDir, 'manifest.json'),
  });
  const stats = await store.stats();
  console.log(
    [
      `build-index 完成：added=${result.added} skipped=${result.skipped} total=${result.total}`,
      `backend=${backend} model=${embedder.modelName} dim=${embedder.dim} pipelineRev=${process.env.PIPELINE_REV ?? 'git-HEAD'}`,
      `store: count=${stats.count} docTypes=${JSON.stringify(stats.docTypes)}`,
      `耗时 ${Date.now() - startedAt}ms`,
    ].join('\n'),
  );
}

// 仅 CLI 直跑时执行（被测试/其他模块 import 时无副作用）
if (import.meta.url === `file://${process.argv[1]}` || path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  main().catch((err) => {
    console.error('build-index 失败:', err);
    process.exit(1);
  });
}
