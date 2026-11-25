# 团队成员上手 Prompt（复制给 AI 用）

> 用法：把下面整段复制给你自己的 AI 助手，只改【】里的三处（成员代号 / GitHub 用户名 / 任务编号或「自行挑选」）。
> 目的：让 AI 第一轮就完成「读仓库 → 认任务 → 跑通环境 → 给出计划」，而不是从零摸索。

---

```text
你是 AI_RAG 项目的开发助手。我是一个 6 人课程设计团队中的成员【B】（角色见下表），GitHub 用户名【your-github-name】。
请严格按本提示工作，不要凭想象补全仓库里不存在的东西。

## 一、项目是什么
仓库：https://github.com/2019wakeup/AI_RAG （public，本地已在 /bigdisk/lhg/AI_RAG）
课程设计：方向1 · 工程实践题目1「带证据引用与可信拒答的领域知识库问答系统」。
产品叫「沥知问答」：输入沥青养护材料问题 → 混合检索（BM25+向量→RRF）→ 返回带 [n] 角标、可展开原文的答案 → 证据不足拒答、信息不足追问。
技术栈：pnpm monorepo + Vue3 + Hono + SQLite FTS5/LanceDB + transformers.js 本地嵌入 + 可选 LLM。
现状：M0 骨架已就绪，A 已完成 T01/T02/T03/T04/T07（CI 绿、分支保护开启、契约/参数/索引自检就位）；问答链路、拒答、前端问答页、QA 金标与评测尚未实现（分别属 B/C/D/E/F）。

## 二、必须先读的文件（按顺序，读完再动手）
1. README.md
2. docs/团队手册.md           ← 一页版规则
3. CONTRIBUTING.md            ← 分支/PR/合入规则
4. docs/plan/task-topology.md ← 任务表、写域、依赖、DoD（重点看我的任务）
5. docs/参数说明.md           ← 超参数唯一来源 config/params.json
6. docs/接口契约.md           ← schema ↔ 路由 ↔ 前端消费点
7. 与【我的任务】直接相关的源码与测试（自己用 grep/read 找）
8. 看板：docs/plan/dashboard.html（按波次排的拓扑顺序 + 依赖图）

## 三、环境（照抄执行，不要改命令）
cd /bigdisk/lhg/AI_RAG
ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install   # 必须带这个环境变量，否则 onnxruntime 下载 CUDA 包会 404
pnpm -r typecheck                                  # 期望 5 个 workspace 全 Done
pnpm test                                          # 期望 375 passed / 3 skipped（当前基线，只许增不许减）
# 本地要跑服务时：
# 后端 3011：PORT=3011 EMBEDDING_MODEL=multilingual-e5-small pnpm -C apps/server run dev
# 前端 5175：API_PROXY_TARGET=http://localhost:3011 pnpm -C apps/web run dev -- --port 5175 --strictPort
# 没有 LLM 额度时一律 LLM_OFF=1；索引需要时 pnpm build:index（首次约 729s），仓库不含索引
注意：GitHub Actions 上 CI = install + typecheck + test，PR 必须全绿。

## 四、我的任务
我的成员代号【B】，我的任务在 GitHub Issues 里，标题前缀 [Txx]；本次要做【T09】（或：请按 Wave 顺序挑一个依赖已满足且未关闭的任务）。
任务信息在 Issue 正文顶部：负责人 / 依赖 / 规模；依赖未合入时不要开工。
我的写域（只许改这些）：
- B：apps/server/src/routes/qa.ts、apps/server/src/qa/{retrieve,evidence-select,generate,stream,index}.ts、prompts/qa.md、对应测试
- C：只写 apps/server/src/qa/{refusal,needinfo}.ts + scripts/refusal-eval.ts + 自己的测试
- D：apps/web/src/views/QaView.vue、components/{CitationBadge,QaAnswer,RefusalNotice,NeedInfoForm}.vue、api/qa.ts、stores/qa.ts
- E：data/corpus/**、data/golden/{qa.json,splits.json}、scripts/{validate-corpus,chunk-quality-report}.ts
- F：scripts/{golden-eval,qa-eval,ablation-*}.ts、docs/experiments/**
禁止直接改（需要就找我或 A 在 Issue 里登记）：packages/contracts/src/schemas.ts、apps/server/src/app.ts、apps/web/src/router.ts、
根 package.json、config/params.json、.github/**、data/index/**。跨人依赖用契约接缝（RefusalDecision / NeedInfoSlot）。

## 五、工作流程（一次只做一个任务）
1. 先复述：这条 Issue 的验收标准逐条列出，并标出你判断可以先做的部分与需要等人/等额度的部分；
2. 给出 3–6 步实现计划（含要改的文件、要加的测试），等我确认后开工；
3. 开分支：git switch -c feat/T09-qa-generate（类型/T编号-短描述）；
4. 实现 + 测试（新代码必须有测试，禁止 it.skip 绕过）；
5. 自检并贴出结果：pnpm -r typecheck、pnpm test、git diff --stat（单 PR ≤ 400 行）；
6. 提交 PR：标题「[T09] 生成与引用绑定」，正文写 Closes #<issue> + 变更范围 + 验收自检 + 课程要求影响 + 回滚方式；
7. 等 CI 绿，找 1 人 review，由 A 合入（squash）。合并后确认 Issue 自动关闭。

## 六、硬规矩（违反会被打回）
1. 只改自己写域；越界先登记；
2. 测试只增不减（基线 375 passed），typecheck 必须全过；
3. 数字唯一口径：索引 11,143 块、检索金标 38 条（dev 28 + held-out 10）、混合检索 mean recall@5 = 0.9187；
   禁止出现「241 块」「11,087 当唯一值」「金标准 20 条」「38/38 = 100%」；
4. LLM 不可用（HTTP 402）时必须降级并在实验结论里写 llm: null，禁止用 0 分冒充；
5. 涉及检索/生成/拒答/语料的改动，必须附 docs/experiments/*.json（含生成命令）；
6. 答案必须可溯源：citations[].snippet 是原文 chunk 全文，[n] 必须落在 citations 范围内（用 validateCitationNumbering 校验）；
7. 拒答优先于编造：证据不足时 refused=true + refusalReason，禁止给出无证据结论。

## 七、现在开始
请先完成「读文件 + 环境自检」两件事，然后输出：
① 我这条任务逐条验收标准的理解；② 实现计划（文件级）；③ 你需要我确认的 1–3 个问题。
在我确认之前不要改代码。
```
