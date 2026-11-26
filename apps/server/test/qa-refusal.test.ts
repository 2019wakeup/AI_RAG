import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QaRefusalReasonSchema, RefusalDecisionSchema } from '@ai-rag/contracts';
import { loadParams } from '../src/config';
import {
  REFUSAL_THRESHOLD_KEYS,
  decideRefusal,
  resolveRefusalThresholds,
} from '../src/qa/refusal';
import type { RefusalInput, RefusalThresholds } from '../src/qa/refusal';

/** T17 拒答判据：纯函数单测，阈值统一从 config/params.json 加载，不依赖索引、LLM 或网络。 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PARAMS = join(REPO_ROOT, 'config/params.json');

const fromParams = (env: NodeJS.ProcessEnv = {}): RefusalThresholds => {
  const params = loadParams({ env, path: PARAMS });
  return resolveRefusalThresholds((key) => {
    const value = params[key];
    if (typeof value !== 'number') throw new Error(`参数 ${key} 不是数值`);
    return value;
  });
};

const THRESHOLDS = fromParams();
const hits = (n: number) => Array.from({ length: n }, (_, i) => ({ chunkId: `chunk-${i}` }));

const base = (over: Partial<RefusalInput> = {}): RefusalInput => ({
  hits: hits(4),
  rawScores: [0.9, 0.8, 0.7, 0.6],
  coverage: 0.9,
  thresholds: THRESHOLDS,
  ...over,
});

describe('T17·四判据独立触发与域外接缝', () => {
  it('最简空输入（仅 hits=[] + thresholds）→ no_hit / high（验收④）', () => {
    const d = decideRefusal({ hits: [], thresholds: THRESHOLDS });
    expect(d).toEqual({ refused: true, reason: 'no_hit', confidence: 'high', signals: { hitCount: 0 } });
    expect(RefusalDecisionSchema.safeParse(d).success).toBe(true);
  });

  it('命中数低于 qa.minHits → no_hit（有高分命中时 medium，无原始分时 high）', () => {
    const withScore = decideRefusal(base({ hits: hits(2), rawScores: [0.9, 0.8] }));
    expect(withScore).toMatchObject({ refused: true, reason: 'no_hit', confidence: 'medium' });
    expect(withScore.signals?.hitCount).toBe(2);

    const noScore = decideRefusal({ hits: hits(2), coverage: 0.9, thresholds: THRESHOLDS });
    expect(noScore).toMatchObject({ refused: true, reason: 'no_hit', confidence: 'high' });
  });

  it('最高原始相似度低于 qa.minScore → low_relevance（取最大值；单维 medium，零/负分 high）', () => {
    const d = decideRefusal(base({ rawScores: [0.2, 0.34, 0.1, 0.3] }));
    expect(d).toMatchObject({ refused: true, reason: 'low_relevance', confidence: 'medium' });
    expect(d.signals?.topScore).toBe(0.34);

    expect(decideRefusal(base({ rawScores: [0] }))).toMatchObject({ reason: 'low_relevance', confidence: 'high' });
    expect(decideRefusal(base({ rawScores: [-0.2, -0.5] }))).toMatchObject({
      reason: 'low_relevance',
      confidence: 'high',
    });
  });

  it('证据覆盖率低于 qa.minCoverage → out_of_domain（零覆盖 high，部分覆盖 medium）', () => {
    const partial = decideRefusal(base({ coverage: 0.2 }));
    expect(partial).toMatchObject({ refused: true, reason: 'out_of_domain', confidence: 'medium' });
    expect(partial.signals?.coverage).toBe(0.2);

    const zero = decideRefusal(base({ coverage: 0 }));
    expect(zero).toMatchObject({ refused: true, reason: 'out_of_domain', confidence: 'high' });
    expect(zero.signals?.coverage).toBe(0);
  });

  it('显式域外信号 outOfDomain=true 优先于零命中；明确域内 outOfDomain=false 时低覆盖归为 insufficient_evidence', () => {
    const oodEmpty = decideRefusal({ hits: [], outOfDomain: true, thresholds: THRESHOLDS });
    expect(oodEmpty).toMatchObject({ refused: true, reason: 'out_of_domain', confidence: 'high' });

    const inDomainLowCov = decideRefusal(base({ outOfDomain: false, coverage: 0.3 }));
    expect(inDomainLowCov).toMatchObject({ refused: true, reason: 'insufficient_evidence', confidence: 'medium' });
  });

  it('LLM 判定证据不足 → insufficient_evidence / high（最强信号）', () => {
    const d = decideRefusal(base({ llmInsufficient: true }));
    expect(d).toMatchObject({ refused: true, reason: 'insufficient_evidence', confidence: 'high' });
  });

  it('LLM 不可用且检索判据全通过 → llm_unavailable / high', () => {
    const d = decideRefusal(base({ llmUnavailable: true }));
    expect(d).toMatchObject({ refused: true, reason: 'llm_unavailable', confidence: 'high' });
  });
});

describe('T17·优先级、边界与放行置信度', () => {
  it('insufficient_evidence > out_of_domain > low_relevance > no_hit', () => {
    const d = decideRefusal(
      base({ hits: hits(2), llmInsufficient: true, coverage: 0.1, rawScores: [0.1, 0.1] }),
    );
    expect(d).toMatchObject({ refused: true, reason: 'insufficient_evidence', confidence: 'high' });
  });

  it('out_of_domain > low_relevance（双低信号印证时 confidence=high）', () => {
    const d = decideRefusal(base({ coverage: 0.2, rawScores: [0.1, 0.1, 0.1, 0.1] }));
    expect(d).toMatchObject({ refused: true, reason: 'out_of_domain', confidence: 'high' });
  });

  it('low_relevance > no_hit（命中不足且低分时报更具体原因，双信号 confidence=high）', () => {
    const d = decideRefusal(base({ hits: hits(2), rawScores: [0.2, 0.1] }));
    expect(d).toMatchObject({ refused: true, reason: 'low_relevance', confidence: 'high' });
  });

  it('零命中优先于 llmInsufficient 与 llmUnavailable（无显式域外信号时验收④兜底）', () => {
    const d = decideRefusal(
      base({ hits: [], rawScores: [], coverage: 0, llmInsufficient: true, llmUnavailable: true }),
    );
    expect(d).toMatchObject({ refused: true, reason: 'no_hit', confidence: 'high' });
  });

  it('llm_unavailable 不掩盖检索拒答（out_of_domain / low_relevance / no_hit）', () => {
    expect(decideRefusal(base({ coverage: 0.1, llmUnavailable: true })).reason).toBe('out_of_domain');
    expect(decideRefusal(base({ rawScores: [0.1], llmUnavailable: true })).reason).toBe('low_relevance');
    expect(decideRefusal(base({ hits: hits(2), rawScores: [0.9], llmUnavailable: true })).reason).toBe('no_hit');
  });

  it('全部指标恰好等于阈值 → 不拒答且 confidence=high', () => {
    const d = decideRefusal(
      base({
        hits: hits(THRESHOLDS.minHits),
        rawScores: [THRESHOLDS.minScore, THRESHOLDS.minScore, THRESHOLDS.minScore],
        coverage: THRESHOLDS.minCoverage,
      }),
    );
    expect(d).toEqual({
      refused: false,
      confidence: 'high',
      signals: { hitCount: THRESHOLDS.minHits, topScore: THRESHOLDS.minScore, coverage: THRESHOLDS.minCoverage },
    });
  });

  it('放行置信度按信号完整度分三档：全有 high / 缺一路（含 rawScores=[]）medium / 双缺 low', () => {
    expect(decideRefusal(base())).toMatchObject({ refused: false, confidence: 'high' });
    expect(decideRefusal({ hits: hits(4), coverage: 0.9, thresholds: THRESHOLDS })).toMatchObject({
      refused: false,
      confidence: 'medium',
    });
    expect(decideRefusal({ hits: hits(4), rawScores: [], coverage: 0.9, thresholds: THRESHOLDS })).toMatchObject({
      refused: false,
      confidence: 'medium',
    });
    expect(decideRefusal({ hits: hits(4), rawScores: [0.9], thresholds: THRESHOLDS })).toMatchObject({
      refused: false,
      confidence: 'medium',
    });
    expect(decideRefusal({ hits: hits(4), thresholds: THRESHOLDS })).toMatchObject({
      refused: false,
      confidence: 'low',
    });
  });
});

describe('T17·数值健壮性与非法输入防御', () => {
  it('rawScores 混入单个 NaN / Infinity 时忽略脏值，不静默绕过 low_relevance', () => {
    const d = decideRefusal(base({ rawScores: [Number.NaN, 0.2, Number.POSITIVE_INFINITY] }));
    expect(d).toMatchObject({ refused: true, reason: 'low_relevance' });
    expect(d.signals?.topScore).toBe(0.2);
  });

  it('rawScores 非空但全是非有限数值时抛 RangeError（防静默放行）', () => {
    expect(() => decideRefusal(base({ rawScores: [Number.NaN, Number.NEGATIVE_INFINITY] }))).toThrow(RangeError);
  });

  it('coverage 为 NaN 或 Infinity 时抛 RangeError（防 0/0 静默绕过）', () => {
    expect(() => decideRefusal(base({ coverage: Number.NaN }))).toThrow(RangeError);
    expect(() => decideRefusal(base({ coverage: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
  });

  it('thresholds 含非有限数值时抛 RangeError', () => {
    expect(() => decideRefusal(base({ thresholds: { ...THRESHOLDS, minScore: Number.NaN } }))).toThrow(RangeError);
    expect(() => resolveRefusalThresholds(() => Number.NaN)).toThrow(RangeError);
  });
});

describe('T17·契约校验、确定性与参数对齐', () => {
  it('5 个拒答原因与不拒答三档全部产出，且全部通过 RefusalDecisionSchema 契约校验', () => {
    const refusedDecisions = [
      decideRefusal({ hits: [], thresholds: THRESHOLDS }),
      decideRefusal(base({ rawScores: [0.1] })),
      decideRefusal(base({ coverage: 0.1 })),
      decideRefusal(base({ llmInsufficient: true })),
      decideRefusal(base({ llmUnavailable: true })),
    ];
    const passDecisions = [
      decideRefusal(base()),
      decideRefusal({ hits: hits(4), rawScores: [0.9], thresholds: THRESHOLDS }),
      decideRefusal({ hits: hits(4), thresholds: THRESHOLDS }),
    ];

    expect(new Set(refusedDecisions.map((d) => d.reason))).toEqual(new Set(QaRefusalReasonSchema.options));
    expect(new Set(passDecisions.map((d) => d.confidence))).toEqual(new Set(['high', 'medium', 'low']));
    for (const d of [...refusedDecisions, ...passDecisions]) {
      expect(RefusalDecisionSchema.safeParse(d).success).toBe(true);
      if (d.refused) expect(QaRefusalReasonSchema.safeParse(d.reason).success).toBe(true);
    }
  });

  it('确定性与入参不可变性：重复调用一致，且不修改传入数组/对象', () => {
    const rawHits = Object.freeze(hits(4));
    const rawScores = Object.freeze([0.2, 0.3, 0.1, 0.25]);
    const frozenThresholds = Object.freeze({ ...THRESHOLDS });
    const input: RefusalInput = {
      hits: rawHits,
      rawScores,
      coverage: 0.9,
      thresholds: frozenThresholds,
    };
    expect(decideRefusal(input)).toEqual(decideRefusal(input));
  });

  it('阈值键与 config/params.json 的 qa.* 对齐，且 env 覆盖能透传生效', () => {
    expect(REFUSAL_THRESHOLD_KEYS).toEqual({
      minHits: 'qa.minHits',
      minScore: 'qa.minScore',
      minCoverage: 'qa.minCoverage',
    });
    const stricter = fromParams({ QA_MIN_SCORE: '0.95' });
    expect(decideRefusal(base({ rawScores: [0.9], thresholds: stricter })).reason).toBe('low_relevance');
  });
});

describe('T17·纯函数与性能约束', () => {
  it('不引用网络 / DB / fs / config / 全局状态，文件内无阈值魔法数', () => {
    const src = readFileSync(new URL('../src/qa/refusal.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"](?:node:)?(?:fs(?:\/promises)?|http|https|net|dns)['"]/);
    expect(src).not.toMatch(/from ['"]\.\.\/config['"]/);
    expect(src).not.toMatch(/\b(?:fetch|require)\s*\(|import\s*\(/);
    expect(src).not.toMatch(/sqlite|lancedb|vectordb|process\.env|Date\.now|Math\.random/i);
    // 除 0 与注释外，代码主体不出现 0.35 / 0.5 / minHits 硬编码常量
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/\b(?:0\.35|0\.5)\b/);
  });

  it('单次执行 < 1ms（1000 次均值，含预热）', () => {
    const input = base();
    for (let i = 0; i < 50; i += 1) decideRefusal(input);
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) decideRefusal(input);
    expect((performance.now() - start) / 1000).toBeLessThan(1);
  });
});
