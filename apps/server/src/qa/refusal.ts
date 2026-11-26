import { RefusalDecisionSchema } from '@ai-rag/contracts';
import type { QaRefusalReason, RefusalConfidence, RefusalDecision } from '@ai-rag/contracts';

/**
 * 拒答判据核心（T17）：纯函数，不读配置、不访问网络/DB/文件，无魔法阈值。
 * 阈值由调用方通过 `resolveRefusalThresholds(getNumber)` 从 `config/params.json` 的 `qa.*` 注入（T19 接入）。
 *
 * 判定优先级（高 → 低）：
 *   1. 显式域外（outOfDomain=true）→ out_of_domain（即使纯 BM25 零命中也不被 no_hit 掩盖）
 *   2. 零命中（hits.length=0）→ no_hit（验收④硬兜底；零命中不进入生成）
 *   3. LLM 明确判定证据不足（llmInsufficient=true）→ insufficient_evidence（最强证据不足信号）
 *   4. 覆盖率不足（coverage < qa.minCoverage）→ 明确域内（outOfDomain=false）报 insufficient_evidence，否则 out_of_domain
 *   5. 最高原始相似度不足（topScore < qa.minScore）→ low_relevance（只看 rawScores，绝不用 RRF 分）
 *   6. 命中条数不足（hits.length < qa.minHits）→ no_hit
 *   7. LLM 不可用（llmUnavailable=true）→ llm_unavailable（置于检索判据之后，避免掩盖可解释检索失败）
 *
 * confidence 语义（判定确信度，零魔法常数）：
 *   - 拒答：硬信号或双判据印证给 high，单路边缘信号给 medium；
 *   - 放行：三信号齐全通过给 high，缺一路可选信号给 medium，仅凭命中数放行给 low。
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
  /** 本次检索命中（仅用于计数；RRF 融合分不可解释，相关性判据必须使用 rawScores） */
  hits: readonly unknown[];
  /** 每条命中的原始相似度（非 RRF 分）；缺省或空数组时跳过 low_relevance 判据 */
  rawScores?: readonly number[];
  /** 证据覆盖问题要素的比例 [0,1]；缺省时跳过覆盖率判据 */
  coverage?: number;
  /** 显式域外信号（T19 识别域外问句传 true；明确域内传 false 时低覆盖归为 insufficient_evidence） */
  outOfDomain?: boolean;
  /** LLM 明确判定给定证据不足以支撑回答 */
  llmInsufficient?: boolean;
  /** LLM 生成不可用且调用方要求必须由 LLM 作答；抽取式降级时应保持 false/undefined */
  llmUnavailable?: boolean;
  thresholds: RefusalThresholds;
}

function assertFinite(name: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} 必须是有限数值，实际收到 ${String(value)}`);
  }
}

function validateThresholds(t: RefusalThresholds): void {
  assertFinite('thresholds.minHits', t.minHits);
  assertFinite('thresholds.minScore', t.minScore);
  assertFinite('thresholds.minCoverage', t.minCoverage);
}

/** 取 rawScores 中的最大有限值；单个非有限脏值忽略，非空但全非有限则抛错（防 NaN 静默绕过拒答）。 */
function maxFiniteScore(rawScores: readonly number[] | undefined): number | undefined {
  if (!rawScores || rawScores.length === 0) return undefined;
  let best = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const s of rawScores) {
    if (!Number.isFinite(s)) continue;
    if (!found || s > best) best = s;
    found = true;
  }
  if (!found) throw new RangeError('rawScores 不含有效有限数值');
  return best;
}

/** 编译期 + 运行时双重契约断言：完整返回值必须通过 RefusalDecisionSchema。 */
function makeDecision(
  refused: boolean,
  reason: QaRefusalReason | undefined,
  confidence: RefusalConfidence,
  signals: RefusalDecision['signals'],
): RefusalDecision {
  return RefusalDecisionSchema.parse({
    refused,
    ...(reason === undefined ? {} : { reason }),
    confidence,
    ...(signals === undefined ? {} : { signals }),
  });
}

/** 从 config/params.json 的 qa.* 读取阈值；保持纯函数，不直接依赖 config 模块的 fs 读取。 */
export function resolveRefusalThresholds(get: (key: string) => number): RefusalThresholds {
  const thresholds: RefusalThresholds = {
    minHits: get(REFUSAL_THRESHOLD_KEYS.minHits),
    minScore: get(REFUSAL_THRESHOLD_KEYS.minScore),
    minCoverage: get(REFUSAL_THRESHOLD_KEYS.minCoverage),
  };
  validateThresholds(thresholds);
  return thresholds;
}

export function decideRefusal(input: RefusalInput): RefusalDecision {
  const { hits, rawScores, coverage, outOfDomain, llmInsufficient, llmUnavailable, thresholds } = input;
  validateThresholds(thresholds);
  if (coverage !== undefined) assertFinite('coverage', coverage);

  const hitCount = hits.length;
  const topScore = maxFiniteScore(rawScores);
  const signals = {
    hitCount,
    ...(topScore === undefined ? {} : { topScore }),
    ...(coverage === undefined ? {} : { coverage }),
  };

  const scoreLow = topScore !== undefined && topScore < thresholds.minScore;
  const coverageLow = coverage !== undefined && coverage < thresholds.minCoverage;
  const hitsLow = hitCount < thresholds.minHits;

  if (outOfDomain === true) return makeDecision(true, 'out_of_domain', 'high', signals);
  if (hitCount === 0) return makeDecision(true, 'no_hit', 'high', signals);
  if (llmInsufficient === true) return makeDecision(true, 'insufficient_evidence', 'high', signals);
  if (coverageLow) {
    const reason: QaRefusalReason = outOfDomain === false ? 'insufficient_evidence' : 'out_of_domain';
    const confidence: RefusalConfidence = coverage === 0 || scoreLow ? 'high' : 'medium';
    return makeDecision(true, reason, confidence, signals);
  }
  if (scoreLow) {
    const confidence: RefusalConfidence = hitsLow || (topScore !== undefined && topScore <= 0) ? 'high' : 'medium';
    return makeDecision(true, 'low_relevance', confidence, signals);
  }
  if (hitsLow) {
    const confidence: RefusalConfidence = topScore !== undefined ? 'medium' : 'high';
    return makeDecision(true, 'no_hit', confidence, signals);
  }
  if (llmUnavailable === true) return makeDecision(true, 'llm_unavailable', 'high', signals);

  const passConfidence: RefusalConfidence =
    topScore !== undefined && coverage !== undefined
      ? 'high'
      : topScore !== undefined || coverage !== undefined
        ? 'medium'
        : 'low';
  return makeDecision(false, undefined, passConfidence, signals);
}
