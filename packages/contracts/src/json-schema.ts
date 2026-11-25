import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodType } from 'zod';
import { OPENAPI_COMPONENTS } from './openapi-components';

/**
 * zod schema → JSON Schema（OpenAPI 文档与前端可选校验共用）。
 * 统一注入 $schema 骨架。
 */
export function toJsonSchema(schema: ZodType): object {
  const json = zodToJsonSchema(schema);
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    ...(json as object),
  };
}

/**
 * 对外响应体的 JSON Schema 映射（组件名 → JSON Schema）。
 * 与 `OPENAPI_COMPONENTS` 一一对应，`/openapi` 的 `components.schemas` 用同一批 schema 生成。
 */
export function componentJsonSchemas(): Record<string, object> {
  const out: Record<string, object> = {};
  for (const [name, schema] of Object.entries(OPENAPI_COMPONENTS)) {
    out[name] = toJsonSchema(schema);
  }
  return out;
}
