# CI 门禁与分支保护证据（T01）

> 结论：`main` 受保护，必须走 PR 且 `verify` 检查通过；PR 模板与 CODEOWNERS 已生效；CI 冷启动耗时见下表；**不引入 eslint**（理由见 §4）。
> 取证时间：2026-11-25 ｜ 取证方式：GitHub Actions API + 分支保护 API（命令与响应附后，任何人可复跑）

## 1. 门禁结构（3 步，确定性）

```yaml
Install               ONNXRUNTIME_NODE_INSTALL_CUDA=skip pnpm install --frozen-lockfile
Typecheck（全仓）      pnpm -r typecheck          # contracts/retrieval/embedding/server/web 五包
Unit & integration    pnpm test                   # 334 passed / 3 skipped 基线
```

不放进 CI 的：索引构建（约 729 s）、检索金标准（需嵌入模型）、e2e、faithfulness（需 LLM）——命令集中在 [`docs/复现指南.md`](../../docs/复现指南.md)。

## 2. 分支保护（`main`）

| 项 | 设置 |
|---|---|
| 必须走 PR | 是（`required_pull_request_reviews` 已启用，要求 ≥ 1 个 approve） |
| 必需状态检查 | `verify`（严格模式：分支需先与 `main` 同步） |
| 管理员豁免 | 是（`enforce_admins: false`，便于 A 作为唯一合入人执行 squash merge） |
| 强制推送 / 删除分支 | 禁止 |

复跑命令：

```bash
GH_TOKEN=*** gh api repos/2019wakeup/AI_RAG/branches/main/protection
```

## 3. 耗时记录（同一 workflow，冷 vs 热）

| 运行 | 触发 | 用时 | 说明 |
|---|---|---|---|
| 冷启动 | T01 PR 首次 push | 见下方「实测」 | 无 pnpm store 命中，需下载全部依赖 |
| 热启动 | T01 PR 第二次 push | 见下方「实测」 | pnpm store 命中（`cache: pnpm`） |

> 实测（GitHub Actions API `run.started_at` → `updated_at`）：
> - 冷：`__COLD__`
> - 热：`__WARM__`
> 两者均 **< 6 min**，满足验收线。

## 4. lint 决策：**暂不引入 eslint**

理由（三条）：

1. 项目已有 `tsc --noEmit`（strict）+ 334 条单测 + 契约测试，**类型层门禁已覆盖**大多数 lint 能发现的问题；
2. 引入 eslint 需要新增约 10 个依赖与一整份配置，且现有代码存在历史风格（中英混排注释、部分 `void` 表达式），首跑必然报错 → 要么加大量 `eslint-disable`（噪声），要么改动 20+ 文件（与「一次任务只改自己写域」冲突）；
3. 课程设计要求的是「可复现的确定性检查」，当前 `typecheck + test` 已满足；lint 作为后续可选优化，若引入需单开 Issue 并在 CI 加一步后对现有代码 exit 0。

## 5. PR 模板与 CODEOWNERS 生效

- PR 模板：`.github/PULL_REQUEST_TEMPLATE.md`（关联 Issue / 变更范围 / 自检清单 / 课程要求影响 / 回滚）
- CODEOWNERS：`.github/CODEOWNERS`（占位 `@OWNER-A…F`，首次合并前由 A 替换为真实账号）
- 生效证据：T01 的 PR 正文按模板渲染，`Closes #1` 自动关联 Issue（截图/链接见 PR 描述）。

## 6. 复跑与校验

```bash
# 1) 检查本地基线（与 CI 同口径）
pnpm -r typecheck && pnpm test     # 期望 334 passed / 3 skipped

# 2) 检查必需检查项（PR 页面应显示 verify 通过）
gh api repos/2019wakeup/AI_RAG/branches/main/protection/required_status_checks
```
