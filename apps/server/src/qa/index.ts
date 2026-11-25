import { SCHEMA_VERSION } from '@ai-rag/contracts';
import type { QaCitation, QaRequest, QaResponse } from '@ai-rag/contracts';
import { getNumber } from '../config';
import { retrieveCandidates } from './retrieve';
import type { QaRetrieveDeps } from './retrieve';
import { QA_MAX_CITATIONS, selectEvidence } from './select';

/**
 * 问答编排（T08）：`answerQuestion(deps, req) → QaResponse`，供 `routes/qa.ts` 调用。
 *
 * 本阶段（PR1）**只做检索与证据选择**：
 * - `citations` 是真实检索命中的原文片段（`snippet` 逐字取自 `hit.text`，不截断、不摘要）；
 * - `answer` 仍为空字符串，生成与 `[n]` 绑定由 T09 的 `generate.ts` 接入；
 * - 拒答/追问判定由 C 的 `refusal.ts` / `clarify.ts` 提供、由 T19 接入，
 *   因此此处 `refused:false`、`needInfo:[]`（零命中只标 `status:"degraded"`，不冒充拒答）。
 */

export type QaDeps = QaRetrieveDeps;

/** citation 的 n 由证据顺序（score 降序）决定：citations[n-1].n === n */
function toCitations(hits: ReturnType<typeof selectEvidence>): QaCitation[] {
  return hits.map((h, i) => ({
    n: i + 1,
    chunkId: h.chunkId,
    sourceDocId: h.provenance.sourceDocId,
    docType: h.docType,
    score: h.score,
    snippet: h.text,
  }));
}

export async function answerQuestion(deps: QaDeps, req: QaRequest): Promise<QaResponse> {
  // 默认召回池来自 config/params.json 的 qa.topK（owner: B），请求体 topK 优先
  const topK = req.topK ?? getNumber('qa.topK');

  const retrieved = await retrieveCandidates(deps, {
    question: req.question,
    topK,
    ...(req.docTypes ? { docTypes: req.docTypes } : {}),
  });

  const hits = retrieved.hits;
  // citations 上限受 qa.topK 与验收上限 8 共同约束（topK 更小时不放大候选池）
  const evidence = selectEvidence(hits, {
    maxCitations: Math.min(topK, QA_MAX_CITATIONS),
  });
  const citations = toCitations(evidence);

  const topScore = hits.length > 0 ? Math.max(...hits.map((h) => h.score)) : undefined;

  return {
    schemaVersion: SCHEMA_VERSION,
    question: req.question,
    answer: '',
    citations,
    refused: false,
    needInfo: [],
    // 无命中 = 检索降级（不是拒答）；有命中 = ok（answer 由 T09 填充）
    status: citations.length > 0 ? 'ok' : 'degraded',
    trace: {
      retrievalMs: retrieved.retrievalMs,
      hitCount: hits.length,
      ...(topScore === undefined ? {} : { topScore }),
      vectorUsed: retrieved.vectorUsed,
      citationCount: citations.length,
    },
  };
}
