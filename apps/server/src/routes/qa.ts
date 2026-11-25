import type { OpenAPIHono } from '@hono/zod-openapi';
import { QaRequestSchema } from '@ai-rag/contracts';
import type { AppDeps } from '../app';

/**
 * 领域知识库问答端点（课程设计主线）。
 *
 * 现状：**骨架**。T02/T03（B）实现检索→证据选择→生成→引用绑定；
 *       T04/T05（C）实现拒答与追问判定；T06/T07（D）实现前端消费。
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
    void deps;
    const notImplemented = {
      schemaVersion: '1',
      question: parsed.data.question,
      answer: '',
      citations: [],
      refused: false,
      needInfo: [],
      status: 'not_implemented',
    };
    return c.json(notImplemented, 501);
  });
}
