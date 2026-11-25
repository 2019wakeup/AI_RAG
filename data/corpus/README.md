# `data/corpus/` · 语料真相源

> 本目录是**唯一需要长期维护的语料来源**：向量索引与关系库都从这里重建。
> 详细规则（来源、切分、清洗、无效值、已知问题、版权）见 **[docs/数据来源与清洗说明.md](../../docs/数据来源与清洗说明.md)**；本文件只说明目录结构与文件格式。
>
> ⚠️ 约束：① 本目录内文件会被 `pnpm build:index` 读取，**改动后必须重建索引**；② 编码统一 UTF-8；③ 不得放入原始 PDF、扫描件或含个人信息的资料（版权见 [NOTICE.md](../../NOTICE.md)）。

## 1. 目录结构

```
data/corpus/
├── README.md                 # 本文件
├── scene-tags.json           # 场景标签词典（27 个标签，不入索引）
├── knowledge/
│   └── entries.json          # 材料知识条目（42 条 → 94 块）
├── standards/
│   ├── jtg-d50-2017.md       # 规范条文摘编（8 部 → 57 块）
│   ├── jtg-f40-2004.md
│   ├── jtg-3410-2025.md
│   ├── jtg-5142-2019.md
│   ├── jtg-5210-2018.md
│   ├── jtg-5421-2018.md
│   ├── aashto-hm40-g3.md
│   └── aashto-hm41-e1.md
├── literature/
│   └── from-xlsx.json        # 论文题录（142 条 → 142 块）
├── literature-full/
│   ├── litfull-001.md        # 论文全文节选（40 篇 → 9,753 块）
│   └── ...                   # MinerU 解析产物，图片不入库
├── tables/
│   └── tables.json           # 定量表格（1,041 张 → 1,041 块）
├── enterprise/
│   ├── binders.json          # 胶结料 7 条
│   ├── additives.json        # 再生添加剂 4 条
│   ├── catalog.json          # 拌合站/料源目录 45 条
│   └── lab-indicators.json   # 11 项实测指标元数据（不入索引）
└── cases/
    └── cases.json            # 5 个端到端案例（评测输入，不入索引）
```

索引口径：**11,143 块 / 395 文档**（`data/index/manifest.json`，构建后生成）。

## 2. 文件格式速查

| 路径 | 格式 | 规模 | 是否入索引 | 说明 |
|---|---|---|---|---|
| `scene-tags.json` | `{ "tags": [{ id, label, kind, synonyms[] }] }` | 27 个标签（气候 6 / 交通 4 / 病害 9 / 约束 8） | 否 | 场景标签词典；知识条目入库时把 `k-*`/`c-*` 等标签映射为中文名 |
| `knowledge/entries.json` | `[{ id, category, type, name, title, specs, relations[], sourceRef, tags[], text, schemaVersion }]` | 42 条 / 94 条关系 | 是（`knowledge`，按关系拆块） | 每条关系一块；`id` 必须为 `k-<category>-<nnn>`；`relations[].property` 必须在属性词汇表内 |
| `standards/*.md` | Markdown，分节标题 `## <规范号>-<条号> <主题>` | 8 部 / 57 条 | 是（`standard`，每条一块） | 文件名即 `docId`（如 `jtg-d50-2017`）；无分节标题会导致入库报错 |
| `literature/from-xlsx.json` | `[{ id, title, authors, journal, year, doi, taskZh, sourceRef }]` | 142 条（109 条带 DOI） | 是（`literature`，一条一块） | 由 `scripts/convert-literature.ts` 从调研 xlsx 生成；无 DOI 用「期刊, 年份」兜底 |
| `literature-full/litfull-*.md` | Markdown，文件头 `<!-- SOURCE: 原始 PDF: … DOI: … -->` | 40 篇 / 9,753 块 | 是（`literature-full`，按 `##` 章节切块） | MinerU 解析后的人工整理副本；图片引用行不入块；单块约 500 字、上限 600 字 |
| `tables/tables.json` | `[{ id, docTitle, caption, markdown, sourcePath, page }]` | 1,041 张 / 107 篇文档 | 是（`table`，一表一块） | 由 `scripts/extract-tables.ts` 从 MinerU `structured_content.json` 提取；只保留含数值且长度 ≥20 的表 |
| `enterprise/*.json` | `[{ id, category, type, name, specs, sourceRef, text, tags[], relations[] }]` | 7 + 4 + 45 = 56 条 | 是（`enterprise`，一条一块） | 脱敏样例；`sourceRef` 仅为文字说明，原始数据集不在仓库 |
| `enterprise/lab-indicators.json` | `{ schemaVersion, indicators: [{ key, label, group, unit, threshold, sampleSize, testMethod }] }` | 11 项 | 否 | 服务端展示用的实测指标元数据 |
| `cases/cases.json` | `[{ schemaVersion, id, title, summary, tags[], scene, expected }]` | 5 个案例 | 否 | 端到端评测输入（`pnpm e2e`）；`scene` 为推荐链路输入 |

## 3. 生成物与手工维护的边界

| 文件 | 维护方式 |
|---|---|
| `knowledge/entries.json`、`standards/*.md`、`enterprise/*.json`、`cases/cases.json`、`scene-tags.json` | **手工维护**（人工整理），提交前跑 `pnpm eval:corpus` 校验 |
| `literature/from-xlsx.json` | 由 `scripts/convert-literature.ts` **生成**，不手改 |
| `tables/tables.json` | 由 `scripts/extract-tables.ts` **生成**，不手改 |
| `literature-full/*.md` | 由 MinerU 产物整理而来，可人工校对，但需保持文件头 `SOURCE` 注释完整 |

任意语料改动后：

```bash
pnpm eval:corpus                          # 1) 校验语料（秒级）
pnpm build:index -- --rebuild --backend=lancedb --model=multilingual-e5-small   # 2) 重建索引（约 12 分钟）
EMBEDDING_MODEL=multilingual-e5-small pnpm exec tsx scripts/golden-eval.ts lancedb  # 3) 金标准回归
```
