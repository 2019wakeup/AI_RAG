import { QaResponseSchema } from '@ai-rag/contracts'
import { parseSseStream } from '@/utils/sse'
import type { QaCitation, QaRequest, QaResponse } from '@ai-rag/contracts'

/**
 * QA 类型化客户端（T12）。字段真相源：@ai-rag/contracts（T07），响应体一律运行时校验。
 * askStream 帧格式与 T10 约定：`meta → delta×n → citation×n → done`（done 载荷为完整 QaResponse）。
 */

const API_BASE = '/api/v1'

// network=连不上服务 llm_unavailable=HTTP 402 contract=响应不合契约 aborted=用户取消
export type QaErrorKind = 'network' | 'llm_unavailable' | 'http' | 'contract' | 'timeout' | 'aborted'

export class QaClientError extends Error {
  readonly kind: QaErrorKind
  readonly status?: number
  constructor(kind: QaErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'QaClientError'
    this.kind = kind
    this.status = status
  }
}

export interface QaRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export function classifyQaError(err: unknown, timedOut: boolean): QaClientError {
  if (err instanceof QaClientError) return err
  if (err instanceof Error && err.name === 'AbortError') {
    return new QaClientError(timedOut ? 'timeout' : 'aborted', timedOut ? '请求超时' : '请求已取消')
  }
  return new QaClientError('network', err instanceof Error ? err.message : String(err))
}

function toHttpError(res: Response, path: string): QaClientError {
  if (res.status === 402) return new QaClientError('llm_unavailable', 'LLM 不可用（HTTP 402，余额不足或未配置）', 402)
  return new QaClientError('http', `请求失败（${res.status}）: ${path}`, res.status)
}

function tryJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return null
  }
}

function createController(options: QaRequestOptions) {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 30000)
  const onExternalAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) {
      clearTimeout(timer)
      controller.abort()
    } else {
      options.signal.addEventListener('abort', onExternalAbort)
    }
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onExternalAbort)
    },
  }
}

/** 非流式问答：POST /api/v1/qa → 契约校验后的 QaResponse；失败抛 QaClientError。 */
export async function askQuestion(req: QaRequest, options: QaRequestOptions = {}): Promise<QaResponse> {
  const ctrl = createController(options)
  try {
    const res = await fetch(`${API_BASE}/qa`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    })
    if (!res.ok) throw toHttpError(res, '/qa')
    const parsed = QaResponseSchema.safeParse(await res.json().catch(() => null))
    if (!parsed.success) throw new QaClientError('contract', '问答响应体不符合 QaResponse 契约')
    return parsed.data
  } catch (err) {
    throw classifyQaError(err, ctrl.timedOut())
  } finally {
    ctrl.cleanup()
  }
}

/** meta 帧：done 之前先行到达的部分信息（检索 trace）。 */
export interface QaStreamMeta {
  question?: string
  status?: QaResponse['status']
  trace?: QaResponse['trace']
}

export interface QaStreamHandlers {
  onMeta?: (meta: QaStreamMeta) => void
  onDelta?: (delta: string) => void
  onCitation?: (citation: QaCitation) => void
  /** 末帧 done：已通过契约校验的完整响应（以其为准存 store）。 */
  onDone?: (response: QaResponse) => void
}

/**
 * 流式问答：POST /api/v1/qa/stream（SSE）。缺 done / event:error / 非 2xx 均抛 QaClientError；
 * 后端以普通 JSON 回 QaResponse 时按 onDone 兜底；未知 event 与坏帧宽容跳过（与 streamRecommend 同风格）。
 */
export async function askStream(
  req: QaRequest,
  handlers: QaStreamHandlers = {},
  options: QaRequestOptions = {},
): Promise<void> {
  let doneReceived = false
  let streamError: QaClientError | null = null
  const ctrl = createController(options)
  try {
    const res = await fetch(`${API_BASE}/qa/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    })
    if (!res.ok) throw toHttpError(res, '/qa/stream')
    if (!(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const parsed = QaResponseSchema.safeParse(await res.json().catch(() => null))
      if (!parsed.success) throw new QaClientError('contract', '问答流式响应格式异常')
      handlers.onDone?.(parsed.data)
      return
    }
    await parseSseStream(res.body, (event, data) => {
      if (event === 'error') {
        const payload = tryJson(data) as { message?: string } | null
        streamError = new QaClientError('http', payload?.message || '问答流式失败')
      } else if (event === 'done') {
        const parsed = QaResponseSchema.safeParse(tryJson(data))
        if (!parsed.success) streamError = new QaClientError('contract', 'done 帧不符合 QaResponse 契约')
        else {
          doneReceived = true
          handlers.onDone?.(parsed.data)
        }
      } else if (event === 'meta') {
        const meta = tryJson(data)
        if (meta) handlers.onMeta?.(meta as QaStreamMeta)
      } else if (event === 'citation') {
        const citation = tryJson(data)
        if (citation) handlers.onCitation?.(citation as QaCitation)
      } else if (event === 'delta') {
        const payload = tryJson(data) as { delta?: string } | null
        // 非 JSON 的 data 行按纯文本增量处理
        if (typeof payload?.delta === 'string') handlers.onDelta?.(payload.delta)
        else if (payload === null) handlers.onDelta?.(data)
      }
      // 未知 event 忽略
    })
    if (streamError) throw streamError
    if (!doneReceived) throw new QaClientError('contract', '流式响应缺少 done 帧')
  } catch (err) {
    throw classifyQaError(err, ctrl.timedOut())
  } finally {
    ctrl.cleanup()
  }
}
