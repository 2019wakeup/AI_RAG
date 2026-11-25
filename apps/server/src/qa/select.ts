import type { SearchHit } from '@ai-rag/contracts';
import { selectCandidateHits } from '../orchestrator';

/**
 * 问答证据选择（T08）。
 *
 * 与推荐链路的差异（这是本模块存在的唯一理由，不是「另写一套配额」）：
 * - `selectCandidateHits()` 是**按推荐候选**设计的：单次上限 `EVIDENCE_SLOTS=3`、
 *   同一 `sourceDocId` 只取 1 条（`docKeyOf`）、跨候选复用计数（`globalChunkCount`）；
 * - 问答是**单问题**场景，验收要求 `citations` 3–8 条，且同一篇文献的不同章节
 *   可能都是有效证据，因此不能直接套用「同 docId 只留 1 条」。
 *
 * 因此这里的分层是：
 * 1. **配额优先**：直接调用 `selectCandidateHits()` 得到「配额内的核心证据」（不复制配额规则）；
 * 2. **相关度补齐**：若核心证据不足下限（3 条），按 score 降序从剩余命中补齐，
 *    补齐只按 `chunkId` 去重，不引入新配额；
 * 3. 最终统一按 score 降序编号，`citations[n-1].n === n`。
 *
 * 若后续 `selectCandidateHits()` 增加 `slots` 参数（A 的写域），第 2 步的补齐范围可随之收窄。
 */

/** 验收下限：citations 至少 3 条 */
export const QA_MIN_CITATIONS = 3;
/** 验收上限：citations 最多 8 条 */
export const QA_MAX_CITATIONS = 8;

export interface SelectEvidenceOptions {
  /** 本次最多几条引用（默认 8；请求 topK 更小时取更小值） */
  maxCitations?: number;
  /** 本次至少几条引用（默认 3；命中不足时以实际命中数为准） */
  minCitations?: number;
}

/** chunkId 去重 + 丢弃空文本（空 snippet 会让验收「snippet 非空」失败） */
function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    if (!h.text || !h.text.trim()) continue;
    if (seen.has(h.chunkId)) continue;
    seen.add(h.chunkId);
    out.push(h);
  }
  return out;
}

export function selectEvidence(
  hits: SearchHit[],
  opts: SelectEvidenceOptions = {},
): SearchHit[] {
  const unique = dedupeHits(hits);
  if (unique.length === 0) return [];

  const maxCitations = Math.max(
    1,
    Math.min(opts.maxCitations ?? QA_MAX_CITATIONS, QA_MAX_CITATIONS),
  );
  const minCitations = Math.max(1, Math.min(opts.minCitations ?? QA_MIN_CITATIONS, maxCitations));

  // 1) 配额内的核心证据（复用推荐链路的配额/去重；传独立的计数容器，不污染调用方）
  const core = selectCandidateHits(unique, new Map<string, number>(), new Set<string>());
  const coreIds = new Set(core.map((h) => h.chunkId));

  // 2) 目标条数：核心已够下限就用核心，不够则补到下限；两者都不超上限与候选总数
  const target = Math.min(unique.length, maxCitations, Math.max(core.length, minCitations));

  const chosen = [...core];
  if (chosen.length < target) {
    const byScore = [...unique].sort((a, b) => b.score - a.score);
    for (const h of byScore) {
      if (chosen.length >= target) break;
      if (coreIds.has(h.chunkId)) continue;
      chosen.push(h);
      coreIds.add(h.chunkId);
    }
  }

  // 3) 统一按相关度降序，保证 citations[n-1].n === n 且 n=1 是最相关证据
  return chosen.sort((a, b) => b.score - a.score).slice(0, target);
}
