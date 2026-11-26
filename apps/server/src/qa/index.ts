import { SCHEMA_VERSION } from '@ai-rag/contracts';
import type { QaCitation, QaRequest, QaResponse } from '@ai-rag/contracts';
import { getNumber } from '../config';
import type { LlmCall } from '../llm/client';
import { generateAnswer } from './generate';
import type { GenerateResult } from './generate';
import { retrieveCandidates } from './retrieve';
import type { QaRetrieveDeps, RetrieveResult } from './retrieve';
import { QA_MAX_CITATIONS, selectEvidence } from './select';

/**
 * 问答编排（T08 检索 + T09 生成 + T10 编排复用）：`answerQuestion(deps, req) → QaResponse`。
 * `citations[].snippet` 逐字取自命中 `text`（不截断、不摘要）；答案由 `generate.ts` 生成，
 * 无 LLM / 402 / 不可溯源时回落抽取式答案并标 `status:"degraded"`。
 * 流式（`stream.ts`）复用 `prepareEvidence` / `toResponse`，两条路径的 status/trace 口径由此同源。
 * 拒答/追问仍由 C 的 refusal/needinfo 提供、T19 接入，因此此处 `refused:false`、`needInfo:[]`。
 */

export type QaDeps = QaRetrieveDeps & {
  /** 注入 fake LLM（测试/评测）；缺省走 env 配置 */
  llm?: LlmCall;
};

/** citation 的 n 由证据顺序（score 降序）决定：n = i+1；连续性由契约 `validateCitationNumbering()` 自检 */
export function toCitations(hits: ReturnType<typeof selectEvidence>): QaCitation[] {
  return hits.map((h, i) => ({
    n: i + 1,
    chunkId: h.chunkId,
    sourceDocId: h.provenance.sourceDocId,
    docType: h.docType,
    score: h.score,
    snippet: h.text,
  }));
}

export interface PreparedQa {
  retrieved: RetrieveResult;
  citations: QaCitation[];
}

/** 检索 + 证据选择（非流式与流式共用）：先拿到它，流式就能在生成前发出 meta 帧 */
export async function prepareEvidence(deps: QaRetrieveDeps, req: QaRequest): Promise<PreparedQa> {
  // 默认召回池来自 config/params.json 的 qa.topK（owner: B），请求体 topK 优先
  const topK = req.topK ?? getNumber('qa.topK');
  const retrieved = await retrieveCandidates(deps, {
    question: req.question,
    topK,
    ...(req.docTypes ? { docTypes: req.docTypes } : {}),
  });
  // citations 上限受 qa.topK 与验收上限 8 共同约束（topK 更小时不放大候选池）
  const evidence = selectEvidence(retrieved.hits, { maxCitations: Math.min(topK, QA_MAX_CITATIONS) });
  return { retrieved, citations: toCitations(evidence) };
}

/** 组装 QaResponse（HTTP 响应与流式 done 帧共用，避免两处各写一遍 status/trace 口径） */
export function toResponse(req: QaRequest, prepared: PreparedQa, generated: GenerateResult): QaResponse {
  const { retrieved, citations } = prepared;
  const topScore = retrieved.hits.length > 0 ? Math.max(...retrieved.hits.map((h) => h.score)) : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    question: req.question,
    answer: generated.answer,
    citations,
    refused: false,
    needInfo: [],
    // 只有「LLM 真生成出非空、且每个断言都有有效角标」才算 ok；其余（含抽取式降级）都是 degraded
    status: generated.llmUsed && generated.answer.length > 0 ? 'ok' : 'degraded',
    trace: {
      retrievalMs: retrieved.retrievalMs,
      generateMs: generated.generateMs,
      hitCount: retrieved.hits.length,
      ...(topScore === undefined ? {} : { topScore }),
      vectorUsed: retrieved.vectorUsed,
      citationCount: citations.length,
      llmUsed: generated.llmUsed,
    },
  };
}

export async function answerQuestion(deps: QaDeps, req: QaRequest): Promise<QaResponse> {
  const prepared = await prepareEvidence(deps, req);
  const generated = await generateAnswer(
    deps.llm ? { llm: deps.llm } : {},
    { question: req.question, citations: prepared.citations },
  );
  return toResponse(req, prepared, generated);
}
