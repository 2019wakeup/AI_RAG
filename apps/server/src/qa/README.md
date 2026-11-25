# 问答模块边界（apps/server/src/qa/）

> 本目录是课程设计**主线模块**：领域知识库问答（检索 → 证据选择 → 生成 → 引用绑定 → 拒答判定）。
> 当前为骨架：契约与路由已就位，编排逻辑由 M1/M2 里程碑的 PR 逐步补齐。
> **改动前先读 `docs/plan/task-topology.md` 的 §3 写域与冲突规则**（本文件的任务编号与该文件保持一致）。

## 1. 职责与归属

| 文件（规划） | 职责 | 负责人 | 任务 |
|---|---|---|---|
| `retrieve.ts` | 问题 → 查询向量 → `VectorStore.search`，返回候选 chunk（含 `text` 与 `provenance`） | B | T08 |
| `evidence-select.ts` | 证据选择与配额（知识/规范/文献/表格）、跨候选去重、相关性排序 | B | T08 |
| `generate.ts` | 构造 prompt（`prompts/qa.md`）→ 调 LLM → 解析 `[n]` 角标 → 回填 `QaCitation[]` | B | T09 |
| `stream.ts` | SSE 流式（meta → delta → citation → done）与无 LLM 降级 | B | T10 |
| `refusal.ts` | 拒答判据：命中数 / 原始相似度 / 覆盖率 / LLM `insufficient` → `refused + refusalReason` | C（判据 T17）→ B（接入 T19） | T17 / T19 |
| `needinfo.ts` | 追问判定：识别缺失槽位（气候/交通/病害/层位…）→ `needInfo[]` | C | T18 |
| `index.ts` | 编排：`answerQuestion(deps, req) → QaResponse`（供 `routes/qa.ts` 调用） | B | T08 / T09 |

> 物理隔离：C **只写** `refusal.ts`、`needinfo.ts` 及自己的测试；B 只写 `retrieve.ts` / `evidence-select.ts` / `generate.ts` / `stream.ts` / `index.ts` / `routes/qa.ts`。两边唯一的缝是 `packages/contracts` 里的 `RefusalDecision` / `NeedInfoSlot`（T07，由 A 维护）。

## 2. 硬约束（评测会用）

1. **答案可溯源**：`answer` 中每个事实性断言必须带 `[n]`，且 `citations[n-1].snippet` 必须来自该次检索的真实 chunk（禁止 LLM 编造证据 id）。
2. **原文兜底**：`QaCitation.snippet` 直接使用 chunk 的 `text` 字段，不截断到只剩标题/摘要。
3. **无 LLM 可降级**：LLM 不可用（未配置/402/超时）时返回**抽取式答案**（拼接证据原句 + 明确标注 `status=degraded`），不得返回空答案或崩溃；若证据本身不足则走拒答。
4. **拒答优先于编造**：`refused=true` 时 `answer` 必须为空字符串或仅含一句拒答说明，不得给出无证据结论。
5. **可测**：每条判据都要有单测；拒答阈值必须来自 `config/params.json`（T03），不得硬编码在函数里。

## 3. 当前骨架（M0 基线已交付）

- `apps/server/src/routes/qa.ts`：`POST /api/v1/qa`，做请求校验（`QaRequestSchema`）后返回 **501 + `status:"not_implemented"`**，响应体符合 `QaResponse` 契约。
- `apps/server/test/qa.test.ts`：2 个契约守卫用例（非法请求 400、骨架响应符合契约）。
- `packages/contracts`：`QaRequest / QaCitation / QaResponse / QaStatus / QaRefusalReason`。
- `prompts/qa.md`：答案生成 prompt（逐句 `[n]`、证据不足置 `insufficient`、缺信息写 `needInfo`）。

## 4. 非目标（不要在本模块做）

- 不改推荐链路（`apps/server/src/orchestrator.ts`、`relation/`），推荐是遗留下游应用。
- 不做模型微调、不做多智能体、不做代码仓库检索。
- 不引入新的向量库后端。
