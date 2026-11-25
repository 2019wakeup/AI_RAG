import type { SearchHit } from '@ai-rag/contracts';
import { selectCandidateHits } from '../orchestrator';

/**
 * 问答证据选择（T08）。
 *
 * 不能直接套用 `selectCandidateHits()`：那是**按推荐候选**设计的（单候选上限 `EVIDENCE_SLOTS=3`、
 * 同一 `sourceDocId` 只留 1 条、跨候选复用计数），而问答是单问题场景，验收要求 citations 3–8 条，
 * 且同一篇文献的不同章节可能都是有效证据。
 *
 * 因此分两层：① 配额优先——直接调用 `selectCandidateHits()` 取「配额内的核心证据」（不复制配额规则）；
 * ② 相关度补齐——核心不足下限时按 score 降序补齐，只按 `chunkId` 去重，不引入新配额。
 * 最终统一按 score 降序，为 `citations[n-1].n === n` 铺好顺序。
 */

/** 验收区间：citations 3–8 条 */
export const QA_MIN_CITATIONS = 3;
export const QA_MAX_CITATIONS = 8;

export interface SelectEvidenceOptions {
  /** 本次最多几条引用（默认 8，不超过验收上限） */
  maxCitations?: number;
}

export function selectEvidence(hits: SearchHit[], opts: SelectEvidenceOptions = {}): SearchHit[] {
  // 重复 chunkId 与空文本命中直接丢弃（空 snippet 会让「snippet 为原文且非空」的验收失败）
  const unique: SearchHit[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (!h.text || !h.text.trim() || seen.has(h.chunkId)) continue;
    seen.add(h.chunkId);
    unique.push(h);
  }
  if (unique.length === 0) return [];
  const max = Math.max(1, Math.min(opts.maxCitations ?? QA_MAX_CITATIONS, QA_MAX_CITATIONS));
  const min = Math.min(QA_MIN_CITATIONS, max);

  // ① 配额内的核心证据（传独立计数容器，不污染调用方）
  const chosen = selectCandidateHits(unique, new Map<string, number>(), new Set<string>());
  const picked = new Set(chosen.map((h) => h.chunkId));
  const target = Math.min(unique.length, max, Math.max(chosen.length, min));

  // ② 不足下限则按相关度补齐
  for (const h of [...unique].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= target) break;
    if (picked.has(h.chunkId)) continue;
    chosen.push(h);
    picked.add(h.chunkId);
  }
  // 统一按相关度降序：n=1 是最相关证据
  return chosen.sort((a, b) => b.score - a.score).slice(0, target);
}
