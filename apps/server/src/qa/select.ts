import type { SearchHit } from '@ai-rag/contracts';

/**
 * 问答证据选择（T08，按 review 修订）：主排序是**相关度**。
 * 不套 `selectCandidateHits()`——它按「题录→表格→章节→其余」优先序取且封顶 `EVIDENCE_SLOTS=3`，
 * 会把最高分的知识/规范原文挤掉、也让 `maxCitations` 失效。这里只保留它同款的「同篇文献取 1 条」
 * 去重，且去重只影响优先权（取不满 target 时按分数续排）。`evidence.quota.*` 属推荐域口径，问答不启用。
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
  const ranked = [...unique].sort((a, b) => b.score - a.score);
  // 同一篇文献只取 1 条（排名靠前者胜出）；其余按分数续排，保证取满且 n=1 是全场最高分
  const head: SearchHit[] = [];
  const docs = new Set<string>();
  for (const h of ranked) {
    if (docs.has(h.provenance.sourceDocId)) continue;
    docs.add(h.provenance.sourceDocId);
    head.push(h);
  }
  const tail = ranked.filter((h) => !head.includes(h));
  const target = Math.min(unique.length, max);
  return [...head, ...tail].slice(0, target).sort((a, b) => b.score - a.score);
}
