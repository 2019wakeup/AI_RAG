import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCorpus, type CorpusReport } from '../validate-corpus';
import { buildIndex } from '../../packages/retrieval/src/build';
import type { EmbedderLike } from '../../packages/retrieval/src/build';
import { SqliteVectorStore } from '../../packages/retrieval/src/sqlite';

const REAL_CORPUS = path.resolve(__dirname, '../../data/corpus');

function tmpCorpus(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(content, null, 2));
  }
  return dir;
}

const VALID_TAGS = {
  tags: [
    { id: 'c-hot', label: '高温', kind: 'climate' },
    { id: 'd-rutting', label: '车辙', kind: 'distress' },
  ],
};

const VALID_SCENE = {
  schemaVersion: '1',
  climate: { zone: '1-4', pgHigh: 76, pgLow: -10 },
  traffic: { level: 'heavy', esal: 30000000 },
  pavement: { layer: 'surface', structure: '半刚性基层沥青路面' },
  distresses: [{ type: 'rutting', severity: 'severe' }],
  constraints: { budget: 500, schedule: 30, env: 'normal', noise: 'none' },
  notes: '',
};

const VALID_FORMULAS = [
  {
    binder: { type: 'SBS改性沥青', grade: 'I-D', pg: 'PG76-22' },
    modifier: { type: 'SBS', dosage: 4.5 },
    gradation: { type: 'SMA-13' },
    additives: [{ type: '木质素纤维', dosage: 0.3 }],
    oilStoneRatio: 6.0,
    airVoids: 4.0,
  },
  {
    binder: { type: '基质沥青', grade: '70#', pg: 'PG64-22' },
    modifier: { type: '无', dosage: 0 },
    gradation: { type: 'AC-13' },
    additives: [],
    oilStoneRatio: 5.0,
    airVoids: 3.5,
  },
];

const VALID_ENTRY = {
  schemaVersion: '1',
  id: 'k-binder-001',
  category: 'binder',
  title: '基质沥青',
  text: '基质沥青是通用基准胶结料。',
  name: '基质沥青',
  type: '沥青品种',
  sourceRef: 'JTG F40-2004',
  relations: [
    {
      property: '成本',
      effect: '基准成本',
      direction: '+',
      magnitude: '成本最低',
      applicableScene: ['d-rutting'],
      sourceRef: 'JTG F40-2004',
    },
  ],
};

describe('validate-corpus', () => {
  it('真实语料目录整体校验通过且统计达标', () => {
    const r: CorpusReport = validateCorpus(REAL_CORPUS);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.stats.entries).toBeGreaterThanOrEqual(40);
    expect(r.stats.cases).toBe(5);
    expect(r.stats.tags).toBeGreaterThanOrEqual(20);
    expect(r.stats.standards).toBeGreaterThanOrEqual(8);
    expect(r.stats.literature).toBeGreaterThanOrEqual(140);
    // T15：域外表格已物理剔除（1041 → 934），清洗后 excludedDocs 零命中
    expect(r.stats.tables).toBe(934);
    expect(r.stats.excludedTables).toBe(0);
  });

  it('真实语料条目 id 与 sourceRef 合法', () => {
    const r = validateCorpus(REAL_CORPUS);
    expect(r.errors.filter((e) => e.includes('id') || e.includes('sourceRef'))).toEqual([]);
  });

  it('拒绝非法 id 格式的条目', () => {
    const dir = tmpCorpus({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [{ ...VALID_ENTRY, id: 'k-binder-abc' }],
      'cases/cases.json': [],
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('k-binder-abc'))).toBe(true);
  });

  it('拒绝缺失 sourceRef 的条目', () => {
    const dir = tmpCorpus({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [{ ...VALID_ENTRY, sourceRef: '' }],
      'cases/cases.json': [],
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('sourceRef'))).toBe(true);
  });

  it('拒绝方向非 ± 的关系', () => {
    const bad = structuredClone(VALID_ENTRY);
    (bad.relations[0] as Record<string, unknown>).direction = '↑';
    const dir = tmpCorpus({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [bad],
      'cases/cases.json': [],
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('direction'))).toBe(true);
  });

  it('拒绝引用未定义标签的案例', () => {
    const dir = tmpCorpus({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [],
      'cases/cases.json': [
        {
          schemaVersion: '1',
          id: 'case-01',
          title: '测试案例',
          summary: '测试',
          tags: ['c-hot', 'd-unknown-tag'],
          scene: VALID_SCENE,
          expected: { formulas: VALID_FORMULAS },
        },
      ],
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('d-unknown-tag'))).toBe(true);
  });

  it('拒绝 scene 必填字段缺失的案例', () => {
    const dir = tmpCorpus({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [],
      'cases/cases.json': [
        {
          schemaVersion: '1',
          id: 'case-01',
          title: '测试',
          summary: '测试',
          scene: { climate: { zone: '1-4' } },
          expected: { formulas: VALID_FORMULAS },
        },
      ],
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('case-01'))).toBe(true);
  });

  it('拒绝无条文分节的规范文件', () => {
    const dir = tmpCorpus({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [],
      'cases/cases.json': [],
      'standards/empty.md': '只有正文没有条文标题',
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('empty.md'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// T15：域外表格剔除（cleaning-rules.json）与 <30 字碎块过滤
// ───────────────────────────────────────────────────────────────────────────

const RULES = {
  version: 1,
  minChunkChars: 30,
  excludedDocs: [
    {
      sourcePath: 'ref/out-of-domain.pdf',
      docTitle: '域外论文',
      category: 'xgboost',
      reason: '测试用：通用机器学习论文',
    },
  ],
};

const TABLE_OUT = {
  id: 'table-000-0',
  docTitle: '域外论文',
  caption: '表 1',
  markdown: '| a | b |',
  sourcePath: 'ref/out-of-domain.pdf',
};

const TABLE_IN = {
  id: 'table-001-0',
  docTitle: '域内论文',
  caption: '表 1',
  markdown: '| a | b |',
  sourcePath: 'ref/in-domain.pdf',
};

/** tmpCorpus 的放宽版：字符串按原文写入（用于 .md 语料） */
function tmpCorpusRaw(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

/** 最小骨架：其余必需语料置空，只考察 tables 分支 */
function tableCorpus(rules: unknown, tables: unknown[]): string {
  return tmpCorpusRaw({
    'scene-tags.json': VALID_TAGS,
    'knowledge/entries.json': [],
    'cases/cases.json': [],
    'cleaning-rules.json': rules,
    'tables/tables.json': tables,
  });
}

describe('T15·域外表格剔除', () => {
  it('表格行的 sourcePath 命中 excludedDocs → 失败并指出行数与类别', () => {
    const r = validateCorpus(tableCorpus(RULES, [TABLE_OUT, TABLE_IN]));
    expect(r.ok).toBe(false);
    expect(r.stats.tables).toBe(2);
    expect(r.stats.excludedTables).toBe(1);
    const err = r.errors.find((e) => e.includes('ref/out-of-domain.pdf'));
    expect(err).toContain('域外表格未剔除：1 行');
    expect(err).toContain('xgboost');
  });

  it('域外行已剔除后校验通过（excludedTables=0）', () => {
    const r = validateCorpus(tableCorpus(RULES, [TABLE_IN]));
    // 最小 fixture 不含 cases/standards/literature，这里只断言领域纯度这条规则本身
    expect(r.errors.filter((e) => e.includes('域外表格'))).toEqual([]);
    expect(r.stats.tables).toBe(1);
    expect(r.stats.excludedTables).toBe(0);
  });

  it('含 tables 语料但缺 cleaning-rules.json → 失败', () => {
    const dir = tmpCorpusRaw({
      'scene-tags.json': VALID_TAGS,
      'knowledge/entries.json': [],
      'cases/cases.json': [],
      'tables/tables.json': [TABLE_IN],
    });
    const r = validateCorpus(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('cleaning-rules.json 不存在'))).toBe(true);
  });

  it('excludedDocs 为空数组 → 失败（不允许「空规则」蒙混过关）', () => {
    const r = validateCorpus(tableCorpus({ version: 1, minChunkChars: 30, excludedDocs: [] }, [TABLE_IN]));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('excludedDocs'))).toBe(true);
  });

  it('category 非法 / 缺 reason → 失败', () => {
    const bad = {
      version: 1,
      minChunkChars: 30,
      excludedDocs: [{ sourcePath: 'ref/x.pdf', category: 'not-a-category', reason: '' }],
    };
    const r = validateCorpus(tableCorpus(bad, [TABLE_IN]));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('category 非法'))).toBe(true);
    expect(r.errors.some((e) => e.includes('缺 reason'))).toBe(true);
  });

  it('minChunkChars 非正整数 → 失败', () => {
    const bad = { ...RULES, minChunkChars: 0 };
    const r = validateCorpus(tableCorpus(bad, [TABLE_IN]));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('minChunkChars'))).toBe(true);
  });

  it('表格行缺 sourcePath → 失败（无法判定领域归属）', () => {
    const { sourcePath: _drop, ...noSource } = TABLE_IN;
    const r = validateCorpus(tableCorpus(RULES, [noSource]));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('缺 sourcePath'))).toBe(true);
  });
});

describe('T15·<30 字碎块过滤', () => {
  const FAKE_EMBEDDER: EmbedderLike = {
    dim: 2,
    modelName: 'fake',
    modelVersion: 'v0',
    embed: async (texts: string[]) => texts.map(() => [0, 0]),
  };

  // 一个 20 字的章节残留块 + 一个长块；前者默认阈值(10)保留、minChunkChars=30 时丢弃
  const SHORT_SECTION = ['## 4. Conclusions', 't.'].join('\n');
  const LONG_BODY = '这是一段足够长的正文，用于验证碎块阈值。'.repeat(15);
  const LIT_MD = ['# Title', '', SHORT_SECTION, '', '## 1. Introduction', LONG_BODY].join('\n');

  async function buildTotal(corpusDir: string): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-'));
    const store = new SqliteVectorStore(path.join(dir, 'index.db'));
    try {
      const r = await buildIndex({
        corpusDir,
        store,
        embedder: FAKE_EMBEDDER,
        rebuild: true,
        manifestPath: path.join(dir, 'manifest.json'),
        pipelineRev: 't15test',
      });
      return r.total;
    } finally {
      store.close();
    }
  }

  it('cleaning-rules 的 minChunkChars 生效：20 字章节残留被丢弃', async () => {
    const dir = tmpCorpusRaw({
      'cleaning-rules.json': { version: 1, minChunkChars: 30, excludedDocs: [] },
      'literature-full/litfull-001.md': LIT_MD,
    });
    expect(await buildTotal(dir)).toBe(1);
  });

  it('无 cleaning-rules.json 时退回默认阈值 10（短块保留，向后兼容）', async () => {
    const dir = tmpCorpusRaw({ 'literature-full/litfull-001.md': LIT_MD });
    expect(await buildTotal(dir)).toBe(2);
  });
});
