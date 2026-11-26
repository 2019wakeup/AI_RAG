import type { OpenAPIHono } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { QaRequestSchema } from '@ai-rag/contracts';
import type { AppDeps } from '../app';
import { answerQuestion } from '../qa/index';
import type { QaDeps } from '../qa/index';
import { streamAnswer } from '../qa/stream';

/**
 * 领域知识库问答端点（课程设计主线）。
 *
 * 现状：检索 + 证据选择（T08）、生成与 `[n]` 绑定（T09）、流式 `meta → delta → citation → done`（T10）；
 *       拒答/追问判定见 T17/T18（接入 T19），前端消费见 T12–T14。
 *
 * 契约见 packages/contracts/src/schemas.ts 的 QaRequest / QaResponse：
 * - answer 中每个断言必须挂 [n] 角标，n → citations[].n
 * - citations[].snippet 必须是**原始证据片段全文**（不得只给 id/标题）
 * - 证据不足：refused=true + refusalReason；信息不足：needInfo 列出需补充项
 */
export function registerQa(app: OpenAPIHono, deps: AppDeps): void {
  // AppDeps.llmCall 与 QaDeps.llm 同签名不同名：不透传会让注入的 fake LLM（测试/评测）失效
  const qaDeps: QaDeps = { ...deps, ...(deps.llmCall ? { llm: deps.llmCall } : {}) };

  app.post('/api/v1/qa', async (c) => {
    const parsed = QaRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '问答请求不合法' }, 400);
    const response = await answerQuestion(qaDeps, parsed.data);
    return c.json(response, 200);
  });

  // T10：SSE 事件名与 data 形状与 apps/web/src/api/qa.ts::askStream() 一一对应
  app.post('/api/v1/qa/stream', async (c) => {
    const parsed = QaRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '问答请求不合法' }, 400);
    return streamSSE(c, async (stream) => {
      try {
        for await (const frame of streamAnswer(qaDeps, parsed.data)) {
          await stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.data) });
        }
      } catch {
        // 客户端中断或不可预期错误：补一帧 error 让前端立即失败，而不是干等到 30s 超时
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: '问答流式失败' }) }).catch(() => {});
      }
    });
  });
}
