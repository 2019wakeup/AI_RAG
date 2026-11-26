import { describe, expect, it } from 'vitest';
import type { DocType, QaCitation } from '@ai-rag/contracts';
import { readPrompt } from '../src/llm/client';
import type { LlmCall } from '../src/llm/client';
import {
  buildPrompt,
  clipAnswer,
  extractiveAnswer,
  generateAnswer,
  sanitizeCitationNumbers,
} from '../src/qa/generate';

/** T09 生成与 `[n]` 绑定：fake LLM + 内存 citation，不触网、不依赖索引。 */

function cite(n: number, docType: DocType, snippet: string, score = 1 - n * 0.01): QaCitation {
  return { n, chunkId: `chunk-${n}`, sourceDocId: `doc-${n}`, docType, score, snippet };
}

const CITATIONS: QaCitation[] = [
  cite(1, 'knowledge', 'SBS 改性沥青可显著提高高温抗车辙能力。改性剂掺量一般为 3%~5%。'),
  cite(2, 'standard', 'JTG F40 规定软化点不小于 46℃。试验方法按 T 0606 执行。'),
  cite(3, 'knowledge', '掺量超过 5% 时低温性能可能下降。宜按气候分区选型。'),
  cite(4, 'table', '70# 基质沥青 25℃ 针入度为 68。'),
];

const Q = 'SBS 改性沥青软化点';
const ask = (llm: LlmCall | undefined, citations = CITATIONS) =>
  generateAnswer(llm ? { llm } : {}, { question: Q, citations });
const jsonOf = (o: unknown): LlmCall => async () => JSON.stringify(o);

describe('T09·引用清洗（验收① R3）', () => {
  it('越界编号删角标留句子，[0] 与超上限编号同样剔除，且不残留多余空白', () => {
    const r = sanitizeCitationNumbers('软化点不小于 46℃ [1]，另有说法 [9] 待补 [0] [12]。', 3);
    expect(r.answer).toContain('另有说法 待补');
    expect(r.answer).toBe('软化点不小于 46℃ [1]，另有说法 待补。');
    expect(r.used).toEqual([1]);
  });

  it('中英混排：中英文句内的两个角标都能识别', () => {
    const r = sanitizeCitationNumbers('Softening point ≥ 46℃ [1]，见 JTG F40 表 4 [2]。', 3);
    expect(r.used).toEqual([1, 2]);
    expect(r.answer).toContain('JTG F40');
  });

  it('[1,2] 拆成 [1][2]；[1][1] 只计一次；全角括号归一为半角', () => {
    const r = sanitizeCitationNumbers('结论 [1,2]，重复 [1][1]，全角［3］与【2】。', 3);
    expect(r.answer).toBe('结论 [1][2]，重复 [1]，全角[3]与[2]。');
    expect(r.used).toEqual([1, 2, 3]);
  });

  it('无编号时原样返回、used 为空', () =>
    expect(sanitizeCitationNumbers('没有角标的普通句子。', 3)).toEqual({
      answer: '没有角标的普通句子。',
      used: [],
    }));
});

describe('T09·答案截断（qa.maxAnswerChars）', () => {
  it('超长时截到上限且不切断角标；截断点落在角标中间则退到角标之前', () => {
    const out = clipAnswer(`${'甲'.repeat(50)}[1]${'乙'.repeat(50)}`, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).toContain('[1]');
    expect(clipAnswer(`${'甲'.repeat(50)}[1]`, 52)).toBe('甲'.repeat(50));
  });
});

describe('T09·抽取式降级（验收③）', () => {
  it('无 LLM：按主题合并同源证据，每段都挂 [n]', async () => {
    const r = await ask(undefined);
    expect(r.llmUsed).toBe(false);
    expect(r.insufficient).toBe(false);
    expect(r.answer).toContain('【材料机理】');
    expect(r.answer).toContain('【规范要求】');
    expect(r.answer).toContain('[1]');
    expect(r.answer).toContain('[2]');
    expect(r.generateMs).toBeGreaterThanOrEqual(0);
  });

  it('同主题两条证据合并进同一段，而不是逐条罗列', () =>
    expect(extractiveAnswer(CITATIONS, 1200)).toMatch(/【材料机理】[^【]*\[1\][^【]*\[3\]/));

  it('主题段最多 3 个；超长时整段丢弃、不超上限', () => {
    const many = ['knowledge', 'standard', 'table', 'literature', 'enterprise'].map((t, i) =>
      cite(i + 1, t as DocType, `${'长'.repeat(200)}。`),
    );
    const out = extractiveAnswer(many, 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect((out.match(/【/g) ?? []).length).toBeLessThanOrEqual(3);
    expect(out).toMatch(/\[\d+\]/);
  });

  it('402 抛错时降级抽取式、不抛异常', async () => {
    const llm: LlmCall = async () => {
      throw new Error('402 Payment Required');
    };
    const r = await ask(llm);
    expect(r.llmUsed).toBe(false);
    expect(r.answer).toContain('[1]');
  });

  it('零命中不生成、也不调用 LLM', async () => {
    let called = 0;
    const r = await ask(async () => ((called += 1), '{}'), []);
    expect(r.answer).toBe('');
    expect(called).toBe(0);
  });
});

describe('T09·LLM 生成与 [n] 绑定（验收②，fake LLM）', () => {
  it('合法 JSON：保留有效角标，混入的越界编号被剔除', async () => {
    const r = await ask(
      jsonOf({ answer: 'SBS 可提高抗车辙能力 [1]，软化点不小于 46℃ [2]，另见 [7]。', usedCitations: [1, 2, 7] }),
    );
    expect(r.llmUsed).toBe(true);
    expect(r.usedCitations).toEqual([1, 2]);
    expect(r.answer).toContain('[1]');
    expect(r.answer).not.toContain('[7]');
  });

  it('答案全是越界编号 → 视为不可溯源，回落抽取式', async () => {
    const r = await ask(jsonOf({ answer: '只看结论 [9]。' }));
    expect(r.llmUsed).toBe(false);
    expect(r.answer).toContain('【材料机理】');
  });

  it('insufficient=true → 清空答案（拒答映射留给 T19）', async () => {
    const r = await ask(jsonOf({ answer: '证据没有提到', insufficient: true }));
    expect(r.insufficient).toBe(true);
    expect(r.answer).toBe('');
    expect(r.llmUsed).toBe(true);
  });

  it('返回非 JSON → 重试 3 次后降级抽取式', async () => {
    const r = await ask(async () => '抱歉，我无法回答');
    expect(r.llmUsed).toBe(false);
    expect(r.answer).toContain('[1]');
  });
});

describe('T09·prompt 条款与证据注入（验收④）', () => {
  it('R1–R6 六条硬约束都在 prompt 里（条款被删即红）', () => {
    const p = readPrompt('qa.md');
    for (const r of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) expect(p).toContain(`**${r} `);
    expect(p).toContain('{{question}}');
    expect(p).toContain('{{evidence}}');
  });

  it('证据块带编号与出处，超长 snippet 截到 600 字；问题里的 $& 不被当替换符', () => {
    const p = buildPrompt('价格 $& 与 $1 软化点要求', [cite(1, 'standard', 'X'.repeat(900))]);
    expect(p).toContain('[1] (standard / doc-1)');
    expect(p).not.toContain('X'.repeat(601));
    expect(p).toContain('价格 $& 与 $1');
  });
});
