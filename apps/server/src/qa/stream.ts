import type { QaCitation, QaRequest, QaResponse } from '@ai-rag/contracts';
import { generateAnswer } from './generate';
import { prepareEvidence, toResponse } from './index';
import type { QaDeps } from './index';

/**
 * 问答流式（T10）：`meta → delta×n → citation×n → done`，帧格式与前端 `api/qa.ts::askStream()` 对齐
 * （`event:` 名一致、data 为 JSON、末帧 `done` 载荷是完整 `QaResponse`）。
 * 生成侧仍是一次性结构化 JSON（`llm/client.ts` 不在问答写域），故 delta 由完整答案切分而来 —— **伪流式**：
 * 换取的是「检索一完成就能看到 meta」与「402/无 LLM 时必然发出 done 而不挂起」，首字延迟不等同 token 流。
 */

export interface QaStreamMeta {
  question: string;
  trace: { retrievalMs: number; hitCount: number; vectorUsed: boolean; citationCount: number };
}

export type QaStreamFrame =
  | { event: 'meta'; data: QaStreamMeta }
  | { event: 'delta'; data: { delta: string } }
  | { event: 'citation'; data: QaCitation }
  | { event: 'done'; data: QaResponse };

/** 单帧目标长度；硬切上限为 2 倍，且绝不在 `[n]` 角标中间下刀 */
const DELTA_CHARS = 48;

/** 按句切分并累积到 ≥ maxChars；`splitAnswer(x).join('') === x` 恒成立（测试守着，前端靠它拼答案） */
export function splitAnswer(answer: string, maxChars = DELTA_CHARS): string[] {
  if (!answer) return [];
  const out: string[] = [];
  let buf = '';
  for (const ch of answer) {
    buf += ch;
    const atSentenceEnd = /[。；！？\n]/.test(ch);
    const atHardLimit = buf.length >= maxChars * 2 && !/\[\d*(?:,\d*)?$/.test(buf);
    if ((atSentenceEnd && buf.length >= maxChars) || atHardLimit) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 帧生成器：meta 先于生成发出；无论 LLM 是否可用，最后一定发 done（不挂起） */
export async function* streamAnswer(deps: QaDeps, req: QaRequest): AsyncGenerator<QaStreamFrame> {
  const prepared = await prepareEvidence(deps, req);
  yield {
    event: 'meta',
    data: {
      question: req.question,
      trace: {
        retrievalMs: prepared.retrieved.retrievalMs,
        hitCount: prepared.retrieved.hits.length,
        vectorUsed: prepared.retrieved.vectorUsed,
        citationCount: prepared.citations.length,
      },
    },
  };

  const generated = await generateAnswer(
    deps.llm ? { llm: deps.llm } : {},
    { question: req.question, citations: prepared.citations },
  );
  for (const delta of splitAnswer(generated.answer)) yield { event: 'delta', data: { delta } };
  for (const citation of prepared.citations) yield { event: 'citation', data: citation };
  yield { event: 'done', data: toResponse(req, prepared, generated) };
}
