import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LanceDBVectorStore, SqliteVectorStore } from '@ai-rag/retrieval';
import type { VectorStore } from '@ai-rag/retrieval';
import type { EmbedderModel } from '@ai-rag/embedding';

// ---------------------------------------------------------------------------
// 集中参数（T03）：config/params.json 是超参数的唯一登记处。
// 优先级：环境变量 > params.json 的 default > 代码内兜底。
// 非法值在**加载时**抛错（与 resolveEmbeddingModel 的行为一致），不静默降级。
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export type ParamValue = number | boolean | string;

export interface ParamSpec {
  default: ParamValue;
  /** 数值范围 [min,max]；非数值参数为 null */
  range: [number, number] | null;
  owner: string;
  desc: string;
  /** 覆盖该参数的环境变量名；null 表示只能通过 params.json 修改 */
  env?: string | null;
}

export interface ParamsFile {
  version: number;
  params: Record<string, ParamSpec>;
}

export type ResolvedParams = Record<string, ParamValue>;

export function paramsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PARAMS_PATH ? resolve(env.PARAMS_PATH) : join(REPO_ROOT, 'config/params.json');
}

export function readParamsFile(path = paramsPath()): ParamsFile {
  if (!existsSync(path)) {
    throw new Error(`参数文件不存在：${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ParamsFile;
  validateParamsFile(parsed);
  return parsed;
}

/** 结构校验：每个参数必须有 default / range / owner / desc，数值参数必须有合法 range。 */
export function validateParamsFile(file: ParamsFile): void {
  if (!file || typeof file !== 'object' || typeof file.params !== 'object') {
    throw new Error('params.json 结构非法：缺少 params 对象');
  }
  for (const [key, spec] of Object.entries(file.params)) {
    if (!spec || typeof spec !== 'object') throw new Error(`参数 ${key} 定义非法`);
    if (spec.default === undefined) throw new Error(`参数 ${key} 缺少 default`);
    if (!('range' in spec)) throw new Error(`参数 ${key} 缺少 range`);
    if (!spec.owner) throw new Error(`参数 ${key} 缺少 owner`);
    if (!spec.desc) throw new Error(`参数 ${key} 缺少 desc`);
    const t = typeof spec.default;
    if (t === 'number') {
      if (!Array.isArray(spec.range) || spec.range.length !== 2) {
        throw new Error(`参数 ${key} 是数值，range 必须是 [min,max]`);
      }
      const [min, max] = spec.range;
      const d = spec.default as number;
      if (d < min || d > max) throw new Error(`参数 ${key} 的 default=${d} 超出 range [${min},${max}]`);
    } else if (t !== 'boolean' && t !== 'string') {
      throw new Error(`参数 ${key} 的类型不支持：${t}`);
    }
  }
}

function parseBoolean(key: string, raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'no'].includes(s)) return false;
  throw new Error(`参数 ${key} 需要布尔值，实际收到 "${raw}"（可用 1/0/on/off）`);
}

/** 解析单个参数：env 覆盖 → 类型转换 → 范围校验。 */
export function resolveParamValue(
  key: string,
  spec: ParamSpec,
  env: NodeJS.ProcessEnv = process.env,
): ParamValue {
  const raw = spec.env ? env[spec.env] : undefined;
  if (raw === undefined || raw === '') return spec.default;

  const t = typeof spec.default;
  if (t === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`参数 ${key} 需要数值，实际收到 "${raw}"（env ${spec.env}）`);
    const [min, max] = spec.range as [number, number];
    if (n < min || n > max) {
      throw new Error(`参数 ${key}=${n} 超出范围 [${min},${max}]（env ${spec.env}）`);
    }
    return n;
  }
  if (t === 'boolean') return parseBoolean(key, raw);
  return raw;
}

/** 加载全部参数（env 优先）。 */
export function loadParams(opts: { env?: NodeJS.ProcessEnv; path?: string } = {}): ResolvedParams {
  const env = opts.env ?? process.env;
  const file = readParamsFile(opts.path ?? paramsPath(env));
  const out: ResolvedParams = {};
  for (const [key, spec] of Object.entries(file.params)) {
    out[key] = resolveParamValue(key, spec, env);
  }
  return out;
}

let cached: ResolvedParams | null = null;
let fileCache: { path: string; file: ParamsFile } | null = null;

/**
 * 参数文件缓存（按路径缓存，避免每次取值都读盘；文件内容变更需重启进程——
 * 这与「启动即校验」的语义一致：运行期不允许悄悄换配置）。
 */
function currentParamsFile(): ParamsFile {
  const path = paramsPath();
  if (!fileCache || fileCache.path !== path) {
    fileCache = { path, file: readParamsFile(path) };
  }
  return fileCache.file;
}

/** 启动时做一次全量解析与校验（非法 env 值在此抛错，进程退出）。 */
export function getParams(): ResolvedParams {
  if (!cached) cached = loadParams();
  return cached;
}

/**
 * 取值器：**按当前 env 实时解析**（测试会 `vi.stubEnv` 后立即生效；
 * 也便于本地热调参而不重启进程）。非法值同样立即抛错。
 */
export function getNumber(key: string): number {
  const spec = currentParamsFile().params[key];
  if (!spec) throw new Error(`参数 ${key} 未在 config/params.json 登记`);
  const v = resolveParamValue(key, spec, process.env);
  if (typeof v !== 'number') throw new Error(`参数 ${key} 不是数值`);
  return v;
}

export function getBoolean(key: string): boolean {
  const spec = currentParamsFile().params[key];
  if (!spec) throw new Error(`参数 ${key} 未在 config/params.json 登记`);
  const v = resolveParamValue(key, spec, process.env);
  if (typeof v !== 'boolean') throw new Error(`参数 ${key} 不是布尔值`);
  return v;
}

export function getString(key: string): string {
  const spec = currentParamsFile().params[key];
  if (!spec) throw new Error(`参数 ${key} 未在 config/params.json 登记`);
  const v = resolveParamValue(key, spec, process.env);
  if (typeof v !== 'string') throw new Error(`参数 ${key} 不是字符串`);
  return v;
}

// P1·D5（data 实验）：multilingual-e5-base（768 维，e5 前缀规则同 small）；
// 类型以 packages/embedding 的 EmbedderModel 为准（data 并行落地，此处用字符串列表保持先行兼容）
const SUPPORTED: readonly string[] = ['bge-m3', 'multilingual-e5-small', 'multilingual-e5-base'];

/**
 * EMBEDDING_MODEL 环境变量解析（bge-m3 默认 | multilingual-e5-small）。
 * 非法值抛错（启动退出），避免"用 e5-small 建的索引 + bge-m3 查询"的维度静默不匹配。
 */
export function resolveEmbeddingModel(
  env: NodeJS.ProcessEnv = process.env,
): EmbedderModel {
  const raw = env.EMBEDDING_MODEL;
  if (raw === undefined || raw === '') return 'bge-m3';
  if (SUPPORTED.includes(raw)) return raw as EmbedderModel;
  throw new Error(
    `EMBEDDING_MODEL 非法值：${raw}（支持 ${SUPPORTED.join(' | ')}）`,
  );
}

/**
 * 向量库创建（R3-C2：启动顺序先 embedder 后 store）。
 * LanceDB 表维度必须与 embedder.dim 一致；embedder 失败时 dim=null → 默认 1024（纯 BM25 可用）。
 * lancedb 初始化失败自动降级 sqlite。
 */
/**
 * 索引产物路径的**唯一派生处**（T04）：服务端、评测脚本、构建脚本都用这一套名字，
 * 避免再出现「服务端读 sqlite.db（空库）、评测脚本读 app.db」的双后端不一致。
 */
export function vectorStorePaths(indexDir: string): {
  lancedb: string;
  sqlite: string;
  manifest: string;
} {
  return {
    lancedb: join(indexDir, 'lancedb'),
    sqlite: join(indexDir, 'app.db'),
    manifest: join(indexDir, 'manifest.json'),
  };
}

export function createVectorStore(opts: {
  backend: string;
  indexDir: string;
  dim: number | null;
}): VectorStore {
  const paths = vectorStorePaths(opts.indexDir);
  if (opts.backend === 'sqlite') {
    return new SqliteVectorStore(paths.sqlite);
  }
  try {
    return new LanceDBVectorStore(paths.lancedb, {
      dim: opts.dim ?? 1024,
    });
  } catch (err) {
    console.warn('LanceDB 初始化失败，自动降级 SQLite：', err);
    return new SqliteVectorStore(paths.sqlite);
  }
}
