import type { QaRefusalReason, RefusalConfidence, RefusalDecision } from '@ai-rag/contracts';
import { QaRefusalReasonSchema } from '@ai-rag/contracts';

/**
 * 拒答判据（T17）：纯函数，不读配置、不访问网络/DB/文件。
 * 阈值由调用方从 config/params.json 的 qa.* 注入（T19 在编排里接入）。
 *
 * 判定顺序（前面的优先）：
 *   零命中 → no_hit；LLM 判定不足 → insufficient_evidence；覆盖率低 → out_of_domain；
 *   原始相似度低 → low_relevance；命中最少条数不足 → no_hit；LLM 不可用 → llm_unavailable。
 * llm_unavailable 放在检索判据之后，避免在无 LLM 的常规降级模式下掩盖可解释的检索失败。
 */

export const REFUSAL_THRESHOLD_KEYS = {
  minHits: 'qa.minHits',
  minScore: 'qa.minScore',
  minCoverage: 'qa.minCoverage',
} as const;

export interface RefusalThresholds {
  minHits: number;
  minScore: number;
  minCoverage: number;
}

export interface RefusalInput {
  /** 本次检索命中（只用于计数；分数不可解释，判据用 rawScores） */
  hits: readonly unknown[];
  /** 每条命中的原始相似度（非 RRF 融合分）；缺省则跳过 low_relevance 判据 */
  rawScores?: readonly number[];
  /** 证据覆盖问题要素的比例 [0,1]；缺省则跳过 out_of_domain 判据 */
  coverage?: number;
  /** LLM 明确判定证据不足 */
  llmInsufficient?: boolean;
  /** LLM 生成不可用且调用方要求必须由 LLM 作答；抽取式降级时应保持 false */
  llmUnavailable?: boolean;
  thresholds: RefusalThresholds;
}

const REASONS: ReadonlySet<string> = new Set(QaRefusalReasonSchema.options);

function makeDecision(
  refused: boolean,
  reason: QaRefusalReason | undefined,
  confidence: RefusalConfidence,
  signals: RefusalDecision['signals'],
): RefusalDecision {
  if (reason !== undefined && !REASONS.has(reason)) {
    throw new Error(`非法拒答原因: ${String(reason)}`);
  }
  return {
    refused,
    ...(reason === undefined ? {} : { reason }),
    confidence,
    ...(signals === undefined ? {} : { signals }),
  };
}

/** 从 params.json 的 qa.* 读取阈值；保持纯函数，不直接依赖 config 模块的 fs 读取。 */
export function resolveRefusalThresholds(get: (key: string) => number): RefusalThresholds {
  return {
    minHits: get(REFUSAL_THRESHOLD_KEYS.minHits),
    minScore: get(REFUSAL_THRESHOLD_KEYS.minScore),
    minCoverage: get(REFUSAL_THRESHOLD_KEYS.minCoverage),
  };
}

export function decideRefusal(input: RefusalInput): RefusalDecision {
  const { hits, rawScores, coverage, llmInsufficient, llmUnavailable, thresholds } = input;
  const hitCount = hits.length;
  const topScore = rawScores && rawScores.length > 0 ? Math.max(...rawScores) : undefined;
  const signals = {
    hitCount,
    ...(topScore === undefined ? {} : { topScore }),
    ...(coverage === undefined ? {} : { coverage }),
  };

  if (hitCount === 0) return makeDecision(true, 'no_hit', 'high', signals);
  if (llmInsufficient === true) {
    return makeDecision(true, 'insufficient_evidence', 'low', signals);
  }
  if (coverage !== undefined && coverage < thresholds.minCoverage) {
    return makeDecision(true, 'out_of_domain', 'high', signals);
  }
  if (topScore !== undefined && topScore < thresholds.minScore) {
    return makeDecision(true, 'low_relevance', 'medium', signals);
  }
  if (hitCount < thresholds.minHits) return makeDecision(true, 'no_hit', 'high', signals);
  if (llmUnavailable === true) return makeDecision(true, 'llm_unavailable', 'high', signals);
  return makeDecision(false, undefined, 'low', signals);
}