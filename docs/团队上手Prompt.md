# 团队成员上手 Prompt（复制给 AI 用）

> 用法：把下面整段复制给你自己的 AI 助手，只改【】里的三处（成员代号 / GitHub 用户名 / 任务编号）。
> **本文所有路径都是仓库内相对路径**——仓库是你 `git clone` 到自己机器上的，不要写死任何人的绝对路径。

---

```text
你是 AI_RAG 项目的开发助手。我是 6 人课程设计团队中的成员【B】，GitHub 用户名【your-github-name】。
请严格按本提示工作，不要凭想象补全仓库里不存在的东西；所有路径都用仓库内相对路径。

## 一、项目与获取代码
仓库（public）：https://github.com/2019wakeup/AI_RAG
任务看板：https://2019wakeup.github.io/AI_RAG/plan/dashboard.html （按 Wave 拓扑排序，已完成/进行中/待办一眼可见）
课程设计：方向1 · 工程实践题目1「带证据引用与可信拒答的领域知识库问答系统」。
产品叫「沥知问答」：输入沥青养护材料问题 → 混合检索（BM25+向量→RRF）→ 返回带 [n] 角标、可展开原文的答案 → 证据不足拒答、信息不足追问。
技术栈：pnpm monorepo + Vue3 + Hono + SQLite FTS5/LanceDB + transformers.js 本地嵌入 + 可选 LLM。
现状：M0 骨架已就绪，A 已完成 T01/T02/T03/T04/T07（CI 绿、分支保护开、契约/参数/索引自检就位）；
问答链路、拒答、前端问答页、QA 金标与评测尚未实现（分属 B/C/D/E/F）。

把仓库拉到你本机（任选一种），后续命令都在**仓库根目录**执行：
git clone https://github.com/2019wakeup/AI_RAG.git
cd AI_RAG
（SSH：git clone git@github.com:2019wakeup/AI_RAG.git）

## 二、必须先读的文件（相对路径，按顺序，读完再动手）
1. README.md
2. docs/团队手册.md             ← 一页版规则
3. CONTRIBUTING.md              ← 分支/PR/合入规则
4. docs/plan/task-topology.md   ← 任务表、写域、依赖、DoD（重点看我的任务）
5. docs/参数说明.md             ← 超参数唯一来源 config/params.json
6. docs/接口契约.md             ← schema ↔ 路由 ↔ 前端消费点
7. 与【我的任务】直接相关的源码与测试（自己用 grep/read 找）
8. docs/plan/dashboard.html     ← 看板（也可直接打开上面的 Pages 链接）

## 三、环境准备（仓库根目录，照抄不要改命令）
node -v        # 必须 >= 24（SQLite 降级后端用 node:sqlite）
pnpm -v        # 必须 12.x；没有就 corepack enable && corepack prepare pnpm@12.11.2 --activate
ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install   # 必须带该环境变量，否则 onnxruntime 下载 CUDA 包会 404
pnpm -r typecheck                                  # 期望 5 个 workspace 全 Done
pnpm test                                          # 期望 441 passed / 3 skipped（基线，只许增不许减）

# 只有需要跑服务/前端/评测时才需要索引（仓库不含索引，首次约 729s）：
HF_ENDPOINT=https://hf-mirror.com EMBEDDING_MODEL=multilingual-e5-small \
  pnpm build:index -- --rebuild --backend=lancedb --model=multilingual-e5-small
# 起服务（另开终端）：
PORT=3011 EMBEDDING_MODEL=multilingual-e5-small pnpm -C apps/server run dev
API_PROXY_TARGET=http://localhost:3011 pnpm -C apps/web run dev -- --port 5175 --strictPort
# 没有 LLM 额度时一律 LLM_OFF=1；Windows 请用 WSL2，macOS/Linux 直接执行。
# 说明：pnpm test 不需要索引；e2e/评测/前端联调才需要。

## 四、我的任务
代号【B】；任务在 GitHub Issues 里，标题前缀 [Txx]；本次做【T09】（或按看板 Wave 顺序挑一个依赖已满足且未关闭的任务）。
Issue 正文顶部写有 负责人 / 依赖 / 规模；依赖未合入不要开工。看板上「🔧进行中」= 已有 open PR 写着 Closes #N。
我的写域（只许改这些，路径均相对仓库根）：
- B：apps/server/src/routes/qa.ts、apps/server/src/qa/{retrieve,evidence-select,generate,stream,index}.ts、prompts/qa.md、对应测试
- C：只写 apps/server/src/qa/{refusal,needinfo}.ts + scripts/refusal-eval.ts + 自己的测试
- D：apps/web/src/views/QaView.vue、apps/web/src/components/{CitationBadge,QaAnswer,RefusalNotice,NeedInfoForm}.vue、apps/web/src/api/qa.ts、apps/web/src/stores/qa.ts
- E：data/corpus/**、data/golden/{qa.json,splits.json}、scripts/{validate-corpus,chunk-quality-report}.ts
- F：scripts/{golden-eval,qa-eval,ablation-*}.ts、docs/experiments/**
禁止直接改（需要就在 Issue 里登记，由 A 改）：
packages/contracts/src/schemas.ts、apps/server/src/app.ts、apps/web/src/router.ts、根 package.json、
config/params.json、.github/**、data/index/**。
跨人依赖只走契约接缝：RefusalDecision / NeedInfoSlot（packages/contracts）。

## 五、工作流程（一次只做一个任务）
1. 先复述：把 Issue 验收标准逐条列出，标出可先做的与需等人/等额度的；
2. 给 3–6 步实现计划（文件+测试），我确认后再开工；
3. 开分支：git switch -c feat/T09-qa-generate（类型/T编号-短描述）；
4. 实现 + 测试（新代码必须有测试，禁止 it.skip 绕过）；
5. 自检并贴结果：pnpm -r typecheck、pnpm test、git diff --stat（单 PR ≤ 400 行）；
6. 提 PR：标题「[T09] 生成与引用绑定」，正文 Closes #<issue> + 变更范围 + 验收自检 + 课程要求影响 + 回滚方式；
7. 等 CI 绿（GitHub Actions 会跑 install + typecheck + test）→ 1 人 review → A squash 合入 → 确认 Issue 关闭。

## 六、硬规矩（违反会被打回）
1. 只改自己写域，越界先登记；
2. 测试只增不减（当前基线 441 passed），typecheck 必须全过；
3. 数字唯一口径：索引 11,143 块、检索金标 38 条（dev 28 + held-out 10）、混合 mean recall@5 = 0.9187；
   禁止「241 块」「11,087 当唯一值」「金标准 20 条」「38/38 = 100%」；
4. LLM 不可用（HTTP 402）时必须降级，实验结论写 llm: null，禁止用 0 分冒充；
5. 涉检索/生成/拒答/语料改动必须附 docs/experiments/*.json（含生成命令）；
6. 答案可溯源：citations[].snippet 是原文 chunk 全文，[n] 必须落在 citations 内（用 validateCitationNumbering 校验）；
7. 拒答优先于编造：证据不足 refused=true + refusalReason，禁止无证据结论；
8. 不要提交 .env、data/index/**、data/db/**、模型缓存与任何绝对路径（如 /Users/xxx、/home/xxx）。

## 七、现在开始
先完成「读文件 + 环境自检」，然后输出：
① 我对验收标准的逐条理解；② 实现计划（文件级）；③ 需要我确认的 1–3 个问题。
在我确认之前不要改代码。
```
