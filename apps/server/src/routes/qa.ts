import type { OpenAPIHono } from '@hono/zod-openapi';
import { QaRequestSchema } from '@ai-rag/contracts';
import type { AppDeps } from '../app';
import { answerQuestion } from '../qa/index';

/**
 * 领域知识库问答端点（课程设计主线）。
 *
 * 现状：检索 + 证据选择已实现（T08）；生成与 `[n]` 绑定见 T09，拒答/追问判定见 T17/T18（接入 T19），
 *       前端消费见 T12–T14。
 *
 * 契约见 packages/contracts/src/schemas.ts 的 QaRequest / QaResponse：
 * - answer 中每个断言必须挂 [n] 角标，n → citations[].n
 * - citations[].snippet 必须是**原始证据片段全文**（不得只给 id/标题）
 * - 证据不足：refused=true + refusalReason；信息不足：needInfo 列出需补充项
 */
export function registerQa(app: OpenAPIHono, deps: AppDeps): void {
  app.post('/api/v1/qa', async (c) => {
    const parsed = QaRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '问答请求不合法' }, 400);
    const response = await answerQuestion(deps, parsed.data);
    return c.json(response, 200);
  });
}
