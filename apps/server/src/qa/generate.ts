import { z } from 'zod';
import type { QaCitation } from '@ai-rag/contracts';
import { getNumber } from '../config';
import { generateStructured, readPrompt } from '../llm/client';
import type { LlmCall } from '../llm/client';

/**
 * 问答生成与引用绑定（T09）：citations → 答案，答案里每个 `[n]` 必须落在 `citations[].n` 上。
 * 三种「不可溯源」情形一律降到抽取式答案（没有 LLM 也必须有答案）：生成降级（无 key / 402 / 超时 /
 * 解析失败）、清洗后答案为空、清洗后一个有效角标都不剩。`insufficient:true` 只清空 answer。
 * `refused` 的原因映射留给 T19（不与 C 的 T17 判据重复实现）。
 */

export const QA_GEN_SCHEMA = z.object({
  answer: z.string(),
  insufficient: z.boolean().optional(),
  usedCitations: z.array(z.number().int()).optional(),
});
const PROMPT_SNIPPET_CHARS = 600; // prompt 内单条证据上限（响应里的 snippet 仍是全文）
const MAX_GROUPS = 3;
const MAX_PER_GROUP = 2;
const SENTENCE_CHARS = 120;
const PREFIX = '根据检索到的证据：';

/** docType → 主题标签：抽取式答案按主题归并同源证据 */
const DOC_TYPE_LABEL: Record<string, string> = {
  knowledge: '材料机理', standard: '规范要求', table: '试验数据',
  literature: '研究结论', 'literature-full': '文献原文', enterprise: '企业资料',
};

/** 注入 fake LLM；缺省走 env（DEEPSEEK_API_KEY / LLM_OFF） */
export type QaGenerateDeps = { llm?: LlmCall };

export interface GenerateResult {
  answer: string;
  insufficient: boolean;
  usedCitations: number[];
  /** true = 答案来自 LLM（未降级） */
  llmUsed: boolean;
  generateMs: number;
}

/** `[1]` / `[1,2]` / 全角 `［1］`「【1】」统一识别，逗号与顿号都可作分隔 */
const CITATION_MARK = /[\[［【]\s*(\d{1,3}(?:\s*[,，、]\s*\d{1,3})*)\s*[\]］】]/g;

/** 双向校验（验收①）：越界编号删角标留句子；`[1,2]` 拆成 `[1][2]`；`[1][1]` 只计一次；全角归一 */
export function sanitizeCitationNumbers(
  answer: string,
  maxN: number,
): { answer: string; used: number[] } {
  const used = new Set<number>();
  const replaced = answer.replace(CITATION_MARK, (_m, group: string) => {
    const nums = group.split(/\s*[,，、]\s*/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= maxN);
    for (const n of nums) used.add(n);
    return nums.map((n) => `[${n}]`).join('');
  });
  const text = replaced
    .replace(/(\[(\d+)\])(?:\s*\1)+/g, '$1') // [1][1] → [1]
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([，。；、！？])/g, '$1')
    .trim();
  return { answer: text, used: [...used].sort((a, b) => a - b) };
}

/** 按 `qa.maxAnswerChars` 截断；截断点落在角标中间时退到角标之前，绝不输出半截 `[1` */
export function clipAnswer(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  const open = head.lastIndexOf('[');
  return (open > head.lastIndexOf(']') ? head.slice(0, open) : head).trimEnd();
}

/** 取首句并去掉章号（`3.2 软化点…` → `软化点…`），超长补省略号 */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/^\d+(?:\.\d+)*\s*[.、)）]\s*/, '');
  const stop = flat.search(/[。！？；]/);
  const one = stop > 0 ? flat.slice(0, stop) : flat;
  return one.length > SENTENCE_CHARS ? `${one.slice(0, SENTENCE_CHARS)}…` : one;
}

/**
 * 抽取式降级（验收③）：同 `docType` 的证据先合并成一个主题段（组内最多 2 条、各取首句并各挂 `[n]`），
 * 主题段按组内最高分排序、最多 3 段；总长超 `maxChars` 时整段丢弃，不切半截角标。
 */
export function extractiveAnswer(citations: QaCitation[], maxChars: number): string {
  if (citations.length === 0) return '';
  const groups = new Map<string, QaCitation[]>();
  for (const c of citations) {
    const list = groups.get(c.docType) ?? [];
    if (list.length < MAX_PER_GROUP) list.push(c);
    groups.set(c.docType, list);
  }
  const segments = [...groups.entries()]
    .sort((a, b) => Math.max(...b[1].map((c) => c.score)) - Math.max(...a[1].map((c) => c.score)))
    .slice(0, MAX_GROUPS)
    .map(([type, list]) =>
      `【${DOC_TYPE_LABEL[type] ?? '相关证据'}】${list.map((c) => `${firstSentence(c.snippet)}[${c.n}]`).join('；')}。`,
    );
  const parts: string[] = [];
  let len = PREFIX.length;
  for (const seg of segments) {
    if (len + seg.length > maxChars && parts.length > 0) break;
    parts.push(seg);
    len += seg.length;
  }
  // maxChars 极小（参数下限 100）时连一段都放不下：只保留可溯源的最小答案
  if (parts.length === 0) return `${PREFIX}[${citations[0].n}]`;
  return `${PREFIX}${parts.join('')}`;
}

/** 证据块 `[n] (docType / sourceDocId)` + 原文；占位符用函数替换，避免问题里的 `$&` 被解释 */
export function buildPrompt(question: string, citations: QaCitation[]): string {
  const evidence = citations
    .map((c) => {
      const body =
        c.snippet.length > PROMPT_SNIPPET_CHARS
          ? `${c.snippet.slice(0, PROMPT_SNIPPET_CHARS)}…`
          : c.snippet;
      return `[${c.n}] (${c.docType} / ${c.sourceDocId})\n${body}`;
    })
    .join('\n\n');
  return readPrompt('qa.md')
    .replace('{{question}}', () => question)
    .replace('{{evidence}}', () => evidence);
}

/** 生成主入口：LLM 可用则结构化生成，否则（或结果不可溯源时）抽取式降级 */
export async function generateAnswer(
  deps: QaGenerateDeps,
  input: { question: string; citations: QaCitation[] },
): Promise<GenerateResult> {
  const startedAt = Date.now();
  const { question, citations } = input;
  const maxAnswerChars = getNumber('qa.maxAnswerChars');
  const done = (r: Omit<GenerateResult, 'generateMs'>): GenerateResult => ({
    ...r,
    generateMs: Date.now() - startedAt,
  });
  // 检索已降级（零命中）：没有证据就不生成，也不让模型自由发挥
  if (citations.length === 0) {
    return done({ answer: '', insufficient: false, usedCitations: [], llmUsed: false });
  }
  const fallback = (): GenerateResult => {
    const answer = extractiveAnswer(citations, maxAnswerChars);
    return done({ answer, insufficient: false, llmUsed: false, usedCitations: sanitizeCitationNumbers(answer, citations.length).used });
  };
  const res = await generateStructured({
    prompt: buildPrompt(question, citations),
    schema: QA_GEN_SCHEMA,
    temperature: 0.2,
    ...(deps.llm ? { llm: deps.llm } : {}),
  });
  if (res.status !== 'ok' || !res.data) return fallback();
  const raw = res.data.answer.trim();
  const insufficient = res.data.insufficient === true;
  if (insufficient || !raw) return done({ answer: '', insufficient, usedCitations: [], llmUsed: true });
  const cleaned = sanitizeCitationNumbers(raw, citations.length);
  const answer = clipAnswer(cleaned.answer, maxAnswerChars);
  const usedCitations = cleaned.used.filter((n) => answer.includes(`[${n}]`));
  if (usedCitations.length === 0) return fallback(); // 一个有效角标都没有 = 不可溯源
  return done({ answer, insufficient: false, usedCitations, llmUsed: true });
}
