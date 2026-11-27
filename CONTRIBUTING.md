# 贡献指南（团队内部）

> 本仓库是研究生《课程设计》· 方向 1 · 工程实践题目 1 的交付物，6 人团队按模块分工。
> **任务编号、写域与依赖以 [`docs/plan/task-topology.md`](docs/plan/task-topology.md) 为准**，Issue 由 [`docs/plan/tasks.json`](docs/plan/tasks.json) 生成。

## 1. 认领任务

1. 在 GitHub Issues 里找到自己的 `[Txx]` 任务（标题前缀即任务 ID），确认 `blocked` 标签已移除（LLM 余额等原因除外）；
2. 在 Issue 下回复「认领 + 计划完成日期」，并把它加入当前里程碑；
3. **依赖未合入不要开工**（依赖关系写在 Issue 正文顶部）。

## 2. 分支与提交

```bash
git switch main && git pull --ff-only
git switch -c feat/T09-qa-generate      # 类型/T<编号>-短描述
```

| 前缀 | 用途 |
|---|---|
| `feat/` | 功能（`type:feature`） |
| `fix/` | 缺陷修复 |
| `test/` | 仅测试（`type:test`） |
| `docs/` | 仅文档（`type:docs`） |
| `exp/` | 实验/评测产物（`type:experiment`） |

提交信息：`<type>(Txx): 一句话`，例如 `feat(T09): 生成后双向校验 [n] 并剔除越界编号`。

## 3. PR 规则（违反即打回）

- PR 标题：`[T09] 生成与引用绑定`（**任务 ID 必填**），正文写 `Closes #<issue>`；
- **单 PR ≤ 400 行 diff**（不含锁文件/生成数据）；超出请拆；
- 必过 CI：`pnpm install` + `pnpm -r typecheck` + `pnpm test`（基线 **508 passed / 3 skipped**，只增不减）；
- **至少 1 名 reviewer**；共享文件（`packages/contracts/src/schemas.ts`、`apps/server/src/app.ts`、`apps/web/src/router.ts`、根 `package.json`、`config/params.json`、`.github/**`）必须由 A 评审，且 A 是唯一合入人；
- 涉及检索/生成/拒答/语料的改动，必须附 `docs/experiments/*.json`（含生成命令）；
- 新增/变更的命令、参数、数字，同步更新对应文档；**禁止出现旧口径**（`11,087` 当唯一值、`金标准 20 条`、`38/38 = 100%`、`241 块`）。

## 4. 本地自检清单

```bash
ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install
pnpm -r typecheck
pnpm test
git diff --stat          # 确认 ≤ 400 行、只动自己的写域
```

按 [`docs/复现指南.md`](docs/复现指南.md) 跑通与本次改动相关的评测命令，并把命令与关键输出贴进 PR。

## 5. 评审与合入

1. 作者在 PR 模板中逐项自检；
2. reviewer 检查：写域是否越界、验收标准是否可验证、测试是否覆盖、数字口径是否正确；
3. A 用 squash merge 合入，标题沿用 PR 标题（保留 `[Txx]` 便于检索）；
4. 合入后关闭 Issue，若验收含实验产物，确认 `docs/experiments/` 已更新。

## 6. 冲突与冻结窗

- 写域重叠 → 先按文件切开，切不开由 A 裁定（见拓扑 §3）；
- **契约冻结**：`QaResponse` 字段只增不改，破坏性变更需新 Issue + 前后端两个 PR；
- **语料/索引冻结窗**：语料清洗合入后需重建索引并重跑金标准，重建前其他人不得跑写索引的脚本。

## 7. 环境提示

- `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` 是必需的（否则 postinstall 下载 CUDA 包 404）；
- 无 LLM 余额（HTTP 402）时一律 `LLM_OFF=1` 演示，实验结论标 `llm: null`，**不得用 0 分冒充**；
- 端口用 3011（后端）/ 5175（前端），并保持 `PORT = API_PROXY_TARGET 端口 = E2E_BASE_URL 端口` 一致。
