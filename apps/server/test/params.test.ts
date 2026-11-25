import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getParams,
  loadParams,
  paramsPath,
  readParamsFile,
  resolveParamValue,
  validateParamsFile,
} from '../src/config';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PARAMS = join(REPO_ROOT, 'config/params.json');
const DOC = join(REPO_ROOT, 'docs/参数说明.md');

const baseEnv = {} as NodeJS.ProcessEnv;

describe('T03 集中参数配置', () => {
  it('默认值来自 params.json（rrfK=60 / qa.minHits=3 / mmr 默认关闭）', () => {
    const p = loadParams({ env: baseEnv, path: PARAMS });
    expect(p['retrieval.rrfK']).toBe(60);
    expect(p['qa.minHits']).toBe(3);
    expect(p['retrieval.mmrEnabled']).toBe(false);
    expect(p['qa.minScore']).toBe(0.35);
  });

  it('环境变量覆盖默认值（RRF_K=99）', () => {
    const p = loadParams({ env: { RRF_K: '99' } as NodeJS.ProcessEnv, path: PARAMS });
    expect(p['retrieval.rrfK']).toBe(99);
  });

  it('非法数值环境变量加载即报错（RRF_K=abc）', () => {
    expect(() => loadParams({ env: { RRF_K: 'abc' } as NodeJS.ProcessEnv, path: PARAMS })).toThrow(
      /retrieval\.rrfK 需要数值/,
    );
  });

  it('超出范围的环境变量加载即报错（RRF_K=0 / QA_MIN_SCORE=2）', () => {
    expect(() => loadParams({ env: { RRF_K: '0' } as NodeJS.ProcessEnv, path: PARAMS })).toThrow(
      /超出范围 \[1,200\]/,
    );
    expect(() =>
      loadParams({ env: { QA_MIN_SCORE: '2' } as NodeJS.ProcessEnv, path: PARAMS }),
    ).toThrow(/qa\.minScore=2 超出范围 \[0,1\]/);
  });

  it('布尔参数支持 on/off/1/0，非法值报错（MMR=maybe）', () => {
    expect(
      loadParams({ env: { MMR: 'on' } as NodeJS.ProcessEnv, path: PARAMS })['retrieval.mmrEnabled'],
    ).toBe(true);
    expect(
      loadParams({ env: { MMR: '0' } as NodeJS.ProcessEnv, path: PARAMS })['retrieval.mmrEnabled'],
    ).toBe(false);
    expect(() => loadParams({ env: { MMR: 'maybe' } as NodeJS.ProcessEnv, path: PARAMS })).toThrow(
      /需要布尔值/,
    );
  });

  it('params.json 至少登记 15 个参数，且每项含 default/range/owner/desc', () => {
    const file = readParamsFile(PARAMS);
    const entries = Object.entries(file.params);
    expect(entries.length).toBeGreaterThanOrEqual(15);
    for (const [key, spec] of entries) {
      expect(spec.default, `${key} 缺 default`).toBeDefined();
      expect('range' in spec, `${key} 缺 range`).toBe(true);
      expect(spec.owner, `${key} 缺 owner`).toMatch(/^[A-F]$/);
      expect(spec.desc.length, `${key} desc 太短`).toBeGreaterThan(4);
    }
  });

  it('docs/参数说明.md 与 params.json 键一一对应（缺一即失败）', () => {
    const file = readParamsFile(PARAMS);
    const doc = readFileSync(DOC, 'utf8');
    const documented = new Set<string>();
    for (const line of doc.split('\n')) {
      const m = /^\|\s*`([a-zA-Z]+\.[a-zA-Z.]+)`\s*\|/.exec(line);
      if (m) documented.add(m[1] as string);
    }
    expect([...documented].sort()).toEqual(Object.keys(file.params).sort());
  });

  it('validateParamsFile 拒绝缺字段的定义，resolveParamValue 支持无 env 的参数', () => {
    expect(() =>
      validateParamsFile({ version: 1, params: { 'x.y': { default: 1, owner: 'A', desc: 'd' } } as never }),
    ).toThrow(/缺少 range/);

    const spec = { default: 5, range: [1, 10] as [number, number], owner: 'A', desc: '测试项' };
    expect(resolveParamValue('x.y', spec, { X_Y: '' } as NodeJS.ProcessEnv)).toBe(5);
  });

  it('PARAMS_PATH 可指向自定义参数文件（隔离测试用）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'params-'));
    const p = join(dir, 'params.json');
    writeFileSync(
      p,
      JSON.stringify({ version: 1, params: { 'qa.topK': { default: 4, range: [1, 20], owner: 'B', desc: '自定义' } } }),
    );
    try {
      expect(paramsPath({ PARAMS_PATH: p } as NodeJS.ProcessEnv)).toBe(p);
      expect(loadParams({ env: baseEnv, path: p })['qa.topK']).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getParams 进程内缓存：同一对象', () => {
    expect(getParams()).toBe(getParams());
    expect(Object.keys(getParams()).length).toBeGreaterThanOrEqual(15);
  });
});
