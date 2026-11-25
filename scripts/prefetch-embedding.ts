// 预下载嵌入模型到 data/index/hf-cache（演示前准备）
// 用法：EMBEDDING_MODEL=multilingual-e5-small HF_ENDPOINT=https://hf-mirror.com pnpm exec tsx scripts/prefetch-embedding.ts
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmbedder } from '@ai-rag/embedding';
import type { EmbedderModel } from '@ai-rag/embedding';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

async function main(): Promise<void> {
  const model = (process.env.EMBEDDING_MODEL ?? 'multilingual-e5-small') as EmbedderModel;
  const e = await createEmbedder({
    model,
    // 与 build-index / 服务端一致：默认仓库内 data/index/hf-cache，可用 EMBEDDING_CACHE_DIR 覆盖
    cacheDir: process.env.EMBEDDING_CACHE_DIR ?? resolve(repoRoot, 'data/index/hf-cache'),
  });
  const v = await e.embed(['沥知问答 沥青路面养护场景']);
  console.log(`EMBEDDING READY model=${e.modelName} dim=${e.dim} vec_len=${v[0].length}`);
}

void main();
