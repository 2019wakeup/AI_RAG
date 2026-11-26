// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { askQuestion, askStream, QaClientError } from '@/api/qa'
import type { QaResponse } from '@ai-rag/contracts'

const qaResponseFixture = (overrides: Partial<QaResponse> = {}): QaResponse => ({
  schemaVersion: '1',
  question: 'SBS 改性沥青软化点要求',
  answer: '规范要求软化点 ≥ 84 ℃ [1]。',
  citations: [
    {
      n: 1,
      chunkId: 'chunk-1',
      sourceDocId: 'JTGF41-2008',
      docType: 'standard',
      score: 0.92,
      snippet: 'SBS 改性沥青 I-D 级软化点不小于 84 ℃。',
    },
    {
      n: 2,
      chunkId: 'chunk-2',
      sourceDocId: 'lit-042',
      docType: 'literature-full',
      score: 0.81,
      snippet: '改性剂掺量对软化点有显著影响。',
    },
  ],
  refused: false,
  needInfo: [],
  status: 'ok',
  trace: { retrievalMs: 42, hitCount: 8, topScore: 0.92, vectorUsed: true, citationCount: 2 },
  ...overrides,
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api/qa - askQuestion 非流式', () => {
  it('200 合法响应：POST /api/v1/qa 并返回契约校验后的 QaResponse', async () => {
    const body = qaResponseFixture()
    fetchMock.mockResolvedValueOnce(jsonResponse(body))

    const result = await askQuestion({ question: 'SBS 改性沥青软化点要求' })

    expect(result).toEqual(body)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/v1/qa')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ question: 'SBS 改性沥青软化点要求' })
  })

  it('refused=true + refusalReason 原样透传（前端据此渲染拒答态）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(qaResponseFixture({ answer: '', refused: true, refusalReason: 'out_of_domain', citations: [] })),
    )

    const result = await askQuestion({ question: '今天天气怎么样' })
    expect(result.refused).toBe(true)
    expect(result.refusalReason).toBe('out_of_domain')
  })

  it('needInfo 追问项以 string[] 透传', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(qaResponseFixture({ needInfo: ['所在气候分区（例如：华南高温区）', '交通等级'] })),
    )

    const result = await askQuestion({ question: '该用什么沥青' })
    expect(result.needInfo).toHaveLength(2)
    expect(result.needInfo[0]).toContain('气候分区')
  })

  it('HTTP 402 → QaClientError(kind=llm_unavailable)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'quota exceeded' }, 402))

    const err = await askQuestion({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('llm_unavailable')
    expect(err.status).toBe(402)
  })

  it('fetch 抛错（网络失败）→ kind=network', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

    const err = await askQuestion({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('network')
  })

  it('响应体不符合契约（refused 缺 refusalReason / 缺字段）→ kind=contract', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ schemaVersion: '1', question: 'x', answer: '', citations: [], refused: true, needInfo: [], status: 'ok' }),
    )

    const err = await askQuestion({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('contract')
  })

  it('其余非 2xx（500）→ kind=http 并带状态码', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'oops' }, 500))

    const err = await askQuestion({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('http')
    expect(err.status).toBe(500)
  })

  it('外部 signal 取消 → kind=aborted', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'))
    const controller = new AbortController()
    controller.abort()

    const err = await askQuestion({ question: 'x' }, { signal: controller.signal }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('aborted')
  })
})

describe('api/qa - askStream 流式分帧', () => {
  it('meta → delta×n → citation → done 逐帧回调，done 载荷过契约', async () => {
    const done = qaResponseFixture()
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: meta\ndata: {"question":"q","trace":{"retrievalMs":40,"hitCount":8}}\n\n',
        'event: delta\ndata: {"delta":"规范要求"}\n\n',
        'event: delta\ndata: {"delta":"软化点 ≥ 84 ℃ [1]。"}\n\n',
        'event: citation\ndata: {"n":1,"chunkId":"chunk-1","sourceDocId":"JTGF41-2008","docType":"standard","score":0.92,"snippet":"…"}\n\n',
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ]),
    )

    const onMeta = vi.fn()
    const deltas: string[] = []
    const onCitation = vi.fn()
    const onDone = vi.fn()
    await askStream(
      { question: 'q' },
      { onMeta, onDelta: (d) => deltas.push(d), onCitation, onDone },
    )

    expect(onMeta).toHaveBeenCalledWith({ question: 'q', trace: { retrievalMs: 40, hitCount: 8 } })
    expect(deltas).toEqual(['规范要求', '软化点 ≥ 84 ℃ [1]。'])
    expect(onCitation).toHaveBeenCalledTimes(1)
    expect(onCitation.mock.calls[0][0]).toMatchObject({ n: 1, chunkId: 'chunk-1' })
    expect(onDone).toHaveBeenCalledWith(done)
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('/api/v1/qa/stream')
  })

  it('流结束但缺 done 帧 → kind=contract（不得静默成功）', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(['event: delta\ndata: {"delta":"半截"}\n\n']))

    const err = await askStream({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('contract')
  })

  it('event:error → 抛 QaClientError 并透传后端 message', async () => {
    fetchMock.mockResolvedValueOnce(
      sseResponse(['event: error\ndata: {"message":"检索服务不可用"}\n\n']),
    )

    const err = await askStream({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.message).toBe('检索服务不可用')
  })

  it('后端未实现流式、直接回普通 JSON 时按 onDone 兜底', async () => {
    const done = qaResponseFixture()
    fetchMock.mockResolvedValueOnce(jsonResponse(done))
    const onDone = vi.fn()

    await askStream({ question: 'x' }, { onDone })
    expect(onDone).toHaveBeenCalledWith(done)
  })

  it('流式 HTTP 402 → kind=llm_unavailable（T10 要求后端此时仍发 done，客户端两者都兼容）', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'quota' }, 402))

    const err = await askStream({ question: 'x' }).catch((e) => e)
    expect(err).toBeInstanceOf(QaClientError)
    expect(err.kind).toBe('llm_unavailable')
  })

  it('坏帧宽容跳过：非法 JSON 的 delta 按纯文本，未知 event 忽略', async () => {
    const done = qaResponseFixture()
    fetchMock.mockResolvedValueOnce(
      sseResponse([
        'event: progress\ndata: whatever\n\n',
        'event: delta\ndata: 纯文本增量\n\n',
        'event: delta\ndata: {broken\n\n',
        `event: done\ndata: ${JSON.stringify(done)}\n\n`,
      ]),
    )

    const deltas: string[] = []
    await askStream({ question: 'x' }, { onDelta: (d) => deltas.push(d) })
    expect(deltas).toEqual(['纯文本增量', '{broken'])
  })
})
