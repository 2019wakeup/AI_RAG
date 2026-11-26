import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { QaRefusalReasonSchema } from '@ai-rag/contracts';
import { loadParams } from '../src/config';
import {
  REFUSAL_THRESHOLD_KEYS,
  decideRefusal,
  resolveRefusalThresholds,
} from '../src/qa/refusal';
import type { RefusalInput, RefusalThresholds } from '../src/qa/refusal';

/** T17 拒答判据：纯函数单测，不依赖索引、LLM 或网络。 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PARAMS = join(REPO_ROOT, 'config/params.json');

const THRESHOLDS: RefusalThresholds = { minHits: 3, minScore: 0.35, minCoverage: 0.5 };
const hits = (n: number) => Array.from({ length: n }, (_, i) => ({ chunkId: `chunk-${i}` }));

const base = (over: Partial<RefusalInput> = {}): RefusalInput => ({
  hits: hits(4),
  rawScores: [0.9, 0.8, 0.7, 0.6],
  coverage: 0.9,
  thresholds: THRESHOLDS,
  ...over,
});

describe('T17·四判据独立触发', () => {
  it('空 hits → no_hit（验收④）', () => {
    const d = decideRefusal(base({ hits: [], rawScores: [], coverage: 0 }));
    expect(d).toMatchObject({ refused: true, reason: 'no_hit', confidence: 'high' });
    expect(d.signals).toMatchObject({ hitCount: 0, coverage: 0 });
  });

  it('命中数低于 qa.minHits（分数与覆盖率正常）→ no_hit', () => {
    const d = decideRefusal(base({ hits: hits(2), rawScores: [0.9, 0.8] }));
    expect(d.reason).toBe('no_hit');
    expect(d.signals?.hitCount).toBe(2);
  });

  it('最高原始相似度低于 qa.minScore → low_relevance（取最大值，不看 RRF 分）', () => {
    const d = decideRefusal(base({ rawScores: [0.2, 0.34, 0.1, 0.3] }));
    expect(d).toMatchObject({ refused: true, reason: 'low_relevance', confidence: 'medium' });
    expect(d.signals?.topScore).toBe(0.34);
  });

  it('证据覆盖率低于 qa.minCoverage → out_of_domain', () => {
    const d = decideRefusal(base({ coverage: 0.2 }));
    expect(d).toMatchObject({ refused: true, reason: 'out_of_domain', confidence: 'high' });
    expect(d.signals?.coverage).toBe(0.2);
  });

  it('LLM 判定证据不足 → insufficient_evidence', () => {
    const d = decideRefusal(base({ llmInsufficient: true }));
    expect(d).toMatchObject({ refused: true, reason: 'insufficient_evidence', confidence: 'low' });
  });

  it('LLM 不可用且检索判据都通过 → llm_unavailable', () => {
    const d = decideRefusal(base({ llmUnavailable: true }));
    expect(d).toMatchObject({ refused: true, reason: 'llm_unavailable', confidence: 'high' });
  });
});

describe('T17·优先级与短路', () => {
  it('insufficient_evidence > out_of_domain > low_relevance', () => {
    const d = decideRefusal(
      base({ llmInsufficient: true, coverage: 0.1, rawScores: [0.1, 0.1, 0.1, 0.1] }),
    );
    expect(d.reason).toBe('insufficient_evidence');
  });

  it('out_of_domain > low_relevance', () => {
    const d = decideRefusal(base({ coverage: 0.1, rawScores: [0.1, 0.1, 0.1, 0.1] }));
    expect(d.reason).toBe('out_of_domain');
  });

  it('low_relevance > no_hit（命中数不足但分数更低时，报更具体的原因）', () => {
    const d = decideRefusal(base({ hits: hits(2), rawScores: [0.2, 0.1] }));
    expect(d.reason).toBe('low_relevance');
  });

  it('零命中优先于 llm_unavailable（验收④不被 LLM 状态掩盖）', () => {
    const d = decideRefusal(base({ hits: [], rawScores: [], coverage: 0, llmUnavailable: true }));
    expect(d.reason).toBe('no_hit');
  });

  it('llm_unavailable 不掩盖 out_of_domain（无 LLM 的常规降级仍能报域外）', () => {
    const d = decideRefusal(base({ coverage: 0.1, llmUnavailable: true }));
    expect(d.reason).toBe('out_of_domain');
  });

  it('全部指标恰好等于阈值 → 不拒答', () => {
    const d = decideRefusal(
      base({ hits: hits(3), rawScores: [0.35, 0.35, 0.35], coverage: 0.5 }),
    );
    expect(d.refused).toBe(false);
    expect(d.reason).toBeUndefined();
    expect(d.confidence).toBe('low');
    expect(d.signals).toEqual({ hitCount: 3, topScore: 0.35, coverage: 0.5 });
  });

  it('缺省 rawScores / coverage 时跳过对应判据', () => {
    expect(decideRefusal({ hits: hits(4), coverage: 0.9, thresholds: THRESHOLDS }).refused).toBe(false);
    expect(decideRefusal({ hits: hits(4), rawScores: [0.9], thresholds: THRESHOLDS }).refused).toBe(false);
  });
});

describe('T17·契约与确定性', () => {
  const sampleDecisions = [
    decideRefusal(base({ hits: [], rawScores: [], coverage: 0 })),
    decideRefusal(base({ rawScores: [0.1, 0.1, 0.1, 0.1] })),
    decideRefusal(base({ coverage: 0.1 })),
    decideRefusal(base({ llmInsufficient: true })),
    decideRefusal(base({ llmUnavailable: true })),
  ];

  it('5 个拒答原因全部产出且均落在契约枚举内', () => {
    const reasons = sampleDecisions.map((d) => d.reason);
    expect(new Set(reasons)).toEqual(new Set(QaRefusalReasonSchema.options));
    for (const reason of reasons) {
      expect(QaRefusalReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it('同一输入多次调用结果完全一致', () => {
    const input = base({ llmInsufficient: true });
    expect(decideRefusal(input)).toEqual(decideRefusal(input));
  });

  it('阈值键与 config/params.json 的 qa.* 默认值对齐', () => {
    const params = loadParams({ env: {}, path: PARAMS });
    const get = (key: string): number => {
      const value = params[key];
      if (typeof value !== 'number') throw new Error(`参数 ${key} 不是数值`);
      return value;
    };
    expect(resolveRefusalThresholds(get)).toEqual({
      minHits: params['qa.minHits'],
      minScore: params['qa.minScore'],
      minCoverage: params['qa.minCoverage'],
    });
    expect(REFUSAL_THRESHOLD_KEYS).toEqual({
      minHits: 'qa.minHits',
      minScore: 'qa.minScore',
      minCoverage: 'qa.minCoverage',
    });
  });
});

describe('T17·纯函数与性能约束', () => {
  it('不引用网络 / DB / fs / config 模块', () => {
    const src = readFileSync(new URL('../src/qa/refusal.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"](?:node:)?(?:fs|http|https|net|dns)['"]/);
    expect(src).not.toMatch(/from ['"]\.\.\/config['"]/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/sqlite|lancedb|vectordb/i);
  });

  it('单次执行 < 1ms（1000 次均值，含预热）', () => {
    const input = base();
    for (let i = 0; i < 50; i += 1) decideRefusal(input);
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) decideRefusal(input);
    const averageMs = (performance.now() - start) / 1000;
    expect(averageMs).toBeLessThan(1);
  });
});