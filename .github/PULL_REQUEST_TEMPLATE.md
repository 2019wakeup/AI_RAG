<!--
PR 标题格式：[T<任务ID>] <任务标题>          例：[T07] QA 契约与 OpenAPI 定义
分支命名：feat/T07-qa-view  fix/T26-qa-eval-null  docs/T05-readme
规则来源：docs/plan/task-topology.md §0.3（PR 规范）与 §6（DoD）
提醒：本 PR 由 A 合入；作者不得自审自合；单 PR ≤ 400 行 diff（不含锁文件/生成数据）。
-->

## 1. 关联 Issue

- Closes #
- 任务 ID：`T__`（必须与 `docs/plan/tasks.json` 中的 id 一致）
- 里程碑：`S0-迁移收口` / `S1-QA主链路` / `S2-可信拒答与质量` / `S3-实验与提交`
- 本 PR 是否需要拆分（任务本身建议拆 1–2 个 PR）：否 / 是 → 已拆为 #__、#__

## 2. 变更范围

**写域（本 PR 实际改动的文件/目录）**

```
（逐行列出，与 Issue 里登记的写域对照；越界需在此说明并由 A 批准）
```

**改动规模**

- [ ] `git diff --stat main...HEAD` 新增+删除 ≤ 400 行（不含 `pnpm-lock.yaml`、数据集、快照）
- [ ] 未修改本任务写域之外的文件；若改了，已在下方「共享文件登记」说明

**共享文件登记**（`docs/plan/task-topology.md` §3.1，改动必须由 A 执行或提前登记）

- [ ] 本 PR 未触碰 `packages/contracts/src/schemas.ts` / `apps/server/src/app.ts` / `apps/web/src/router.ts` / 根 `package.json` / `apps/server/src/config.ts` / `data/index/**` / `.github/**`
- [ ] 或：已触碰，已在 Issue #__ 登记，且 A 已同意（写清文件与行数）

## 3. 验收自检清单

**门禁（CI 会重复跑一遍，但请本地先跑）**

- [ ] `pnpm test` 通过，passed ≥ **334**（M0 基线），且**新增用例未被 skip**
- [ ] `pnpm typecheck` 通过（contracts / retrieval / embedding / server / web 全部 workspace）
- [ ] 新增/变更的生产代码有对应测试（不是只测 happy path）
- [ ] 无 `TODO` / 调试残留；脚本类入口的日志带前缀

**任务验收标准逐条对照**（从 Issue 抄下来逐条打勾，不许改写成模糊措辞）

- [ ] 1.
- [ ] 2.
- [ ] 3.

**命令与输出证据**（贴真实输出片段，不写「我跑过了」）

```
$ 
（输出）
```

**数字口径**（`docs/plan/task-topology.md` §0.4：11,143 块 / 38 条金标准（dev 28 + held-out 10） / mean recall@5 0.9187 / 430 passed）

- [ ] 本 PR 涉及的数字与 §0.4 一致；未引入 `11,087`、`金标准 20 条`、`38/38（100%）` 等旧口径
- [ ] 若本次改动了语料或索引：已由 A 按 T04 流程重建索引，并更新 `docs/experiments/index-fingerprint.json`（贴出新旧 `manifestHash` 与混合检索复跑结果；**索引产物不入库**）

**文档**

- [ ] 新增/变更的路径、命令、参数已写进对应文档，可直接复制执行
- [ ] 如涉及评测：结果 JSON 已入 `docs/experiments/`，并在 `docs/experiments/README.md` 登记生成命令；依赖 LLM 的指标写 `llm: null` 并注明「未复现」

## 4. 对课程要求的影响

> 对照 `docs/plan/task-topology.md` §5 的覆盖矩阵，勾选本 PR 推进了哪几条（没有就写「无」）。

**课程统一要求**

- [ ] R1 完整代码与运行说明（结构 / README / 环境配置 / 可复现脚本 / 集中配置）
- [ ] R2 可演示系统（Web / API / CLI + 现场能跑）
- [ ] R3 数据与实验（来源 / 清洗 / 划分 / 基线 / 对比消融 / 指标 / 案例）
- [ ] R4 项目报告 6 章
- [ ] R5 团队分工说明

**本题硬要求**

- [ ] H1 明确领域 + 基于文档的 RAG 问答
- [ ] H2 回答必须返回原始证据片段
- [ ] H3 证据不足必须拒答或提示补充信息
- [ ] H4 必做实验：至少三种检索方案对比

**一句话说明影响**（例：本 PR 让「证据不足拒答」从零实现变成可评测，H3 由 ❌ → 🟡）

```
```

**已知局限 / 未验证部分**（例：LLM 402，`llm: null`，引用支撑率待额度恢复后补测）

```
```

## 5. 回滚方式

- [ ] 本 PR 为**纯新增文件**，回滚 = `git revert <merge-sha>`，不影响既有链路
- [ ] 本 PR 修改了既有行为，回滚需注意（写清顺序与副作用）：

```
（例：先 revert 本 PR，再重跑 pnpm test；索引无需重建，因 provenance 字段为可选）
```

- [ ] 本 PR 包含数据/索引变更，回滚需同时恢复 `data/corpus/**` 或 `data/index/**` 到指定 commit，并重跑 `pnpm exec tsx scripts/build-index.ts --check`

**是否是破坏性变更**：否 / 是（若是，说明受影响的接口、前端页面与数据文件）

```
```

---

<sub>评审人请重点看：写域是否越界（§2）、验收标准是否逐条可判定（§3）、回滚是否真的能回（§5）。</sub>
