import type { SearchHit } from '@ai-rag/contracts';
import type { VectorStore } from '@ai-rag/retrieval';

/**
 * 问答检索（T08）：问题 → 查询向量 → `VectorStore.search` → 候选 chunk。
 * 与 `routes/kb.ts` 的 `/kb/search` 同构；差别：本模块不读配置（topK 由 index.ts 传入，便于测试），
 * 且向量召回失败一律降级纯 BM25 不抛错（问答可用性优先），降级经 `vectorUsed` 透出到 trace。
 */

/** 检索所需的最小嵌入接口（结构兼容 EmbedderLike，避免 qa/ 反向依赖 orchestrator） */
export interface QaEmbedder {
  embed(texts: string[], opts?: { mode?: 'query' | 'passage' }): Promise<number[][]>;
}

export interface QaRetrieveDeps {
  store: VectorStore;
  /** null = 无向量能力，只能走 BM25 */
  embedder: QaEmbedder | null;
}

export interface RetrieveOptions {
  question: string;
  /** 候选池大小（qa.topK 或请求体 topK） */
  topK: number;
  /** 语料类型过滤（请求体 docTypes 透传） */
  docTypes?: string[];
}

export interface RetrieveResult {
  hits: SearchHit[];
  /** false = 本次为纯 BM25 检索 */
  vectorUsed: boolean;
  retrievalMs: number;
}

export async function retrieveCandidates(
  deps: QaRetrieveDeps,
  opts: RetrieveOptions,
): Promise<RetrieveResult> {
  const question = opts.question.trim();
  const startedAt = Date.now();
  // 空问题由 QaRequestSchema(min 1) 拦截，此处兜底为「无命中」而非抛错
  if (!question) return { hits: [], vectorUsed: false, retrievalMs: 0 };

  let vector: number[] | undefined;
  if (deps.embedder) {
    try {
      const [v] = await deps.embedder.embed([question], { mode: 'query' });
      // 空向量（零向量降级 embedder）会让 KNN 失去意义，视同无向量
      vector = v && v.length > 0 ? v : undefined;
    } catch {
      vector = undefined;
    }
  }

  const hits = await deps.store.search({
    text: question,
    vector,
    topK: opts.topK,
    ...(opts.docTypes && opts.docTypes.length > 0 ? { filter: { docTypes: opts.docTypes } } : {}),
  });

  return { hits, vectorUsed: vector !== undefined, retrievalMs: Date.now() - startedAt };
}
