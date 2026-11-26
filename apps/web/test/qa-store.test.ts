import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { askQuestion, askStream, QaClientError } from '@/api/qa'
import { useQaStore } from '@/stores/qa'
import type { QaResponse } from '@ai-rag/contracts'

vi.mock('@/api/qa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/qa')>()
  return { ...actual, askQuestion: vi.fn(), askStream: vi.fn() }
})

const askQuestionMock = vi.mocked(askQuestion)
const askStreamMock = vi.mocked(askStream)

const responseFixture = (overrides: Partial<QaResponse> = {}): QaResponse => ({
  schemaVersion: '1',
  question: 'SBS 改性沥青软化点要求',
  answer: '规范要求软化点 ≥ 84 ℃ [1]。',
  citations: [
    { n: 1, chunkId: 'chunk-1', sourceDocId: 'JTGF41-2008', docType: 'standard', score: 0.92, snippet: '软化点不小于 84 ℃。' },
    { n: 2, chunkId: 'chunk-2', sourceDocId: 'lit-042', docType: 'literature-full', score: 0.81, snippet: '掺量影响软化点。' },
  ],
  refused: false,
  needInfo: [],
  status: 'ok',
  trace: { retrievalMs: 42, hitCount: 8 },
  ...overrides,
})

beforeEach(() => {
  setActivePinia(createPinia())
  askQuestionMock.mockReset()
  askStreamMock.mockReset()
})

describe('stores/qa - 非流式', () => {
  it('ask 成功：done 态，answer/citations/trace 可读，citationByN 命中', async () => {
    askQuestionMock.mockResolvedValueOnce(responseFixture())
    const store = useQaStore()

    await store.ask({ question: 'SBS 改性沥青软化点要求' })

    expect(store.status).toBe('done')
    expect(store.answer).toContain('[1]')
    expect(store.citations).toHaveLength(2)
    expect(store.trace).toMatchObject({ retrievalMs: 42 })
    expect(store.citationByN(2)?.chunkId).toBe('chunk-2')
    expect(store.citationByN(9)).toBeUndefined()
  })

  it('402：置 error 并记录 errorKind=llm_unavailable，不产生假答案', async () => {
    askQuestionMock.mockRejectedValueOnce(new QaClientError('llm_unavailable', 'LLM 不可用（HTTP 402）', 402))
    const store = useQaStore()

    await store.ask({ question: 'x' })

    expect(store.status).toBe('error')
    expect(store.errorKind).toBe('llm_unavailable')
    expect(store.errorMessage).toContain('402')
    expect(store.answer).toBe('')
    expect(store.hasResult).toBe(false)
  })

  it('refused / needInfo 派生态透出（T21 视图直接消费）', async () => {
    askQuestionMock.mockResolvedValueOnce(
      responseFixture({ answer: '', refused: true, refusalReason: 'no_hit', citations: [], status: 'degraded' }),
    )
    const store = useQaStore()

    await store.ask({ question: '今天天气怎么样' })

    expect(store.refused).toBe(true)
    expect(store.refusalReason).toBe('no_hit')
    expect(store.degraded).toBe(true)

    askQuestionMock.mockResolvedValueOnce(responseFixture({ needInfo: ['所在气候分区'] }))
    await store.ask({ question: '该用什么沥青' })
    expect(store.needInfo).toEqual(['所在气候分区'])
    expect(store.refused).toBe(false)
  })
})

describe('stores/qa - 流式与失败保留', () => {
  it('askStreaming：meta/delta/citation 增量可读，done 后以完整响应为准', async () => {
    const done = responseFixture()
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onMeta?.({ trace: { retrievalMs: 33 } })
      handlers?.onDelta?.('规范要求')
      handlers?.onDelta?.('软化点 ≥ 84 ℃ [1]。')
      handlers?.onCitation?.(done.citations[0])
      expect(useQaStore().status).toBe('loading')
      handlers?.onDone?.(done)
    })
    const store = useQaStore()

    await store.askStreaming({ question: 'x' })

    expect(store.status).toBe('done')
    expect(store.answer).toBe(done.answer)
    expect(store.partialAnswer).toBe('')
    expect(store.citations).toHaveLength(2)
  })

  it('流式中途网络失败：置 error 且保留 partialAnswer（验收③）', async () => {
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onDelta?.('已生成的前半段')
      throw new QaClientError('network', 'Failed to fetch')
    })
    const store = useQaStore()

    await store.askStreaming({ question: 'x' })

    expect(store.status).toBe('error')
    expect(store.errorKind).toBe('network')
    expect(store.partialAnswer).toBe('已生成的前半段')
    expect(store.answer).toBe('已生成的前半段')
  })

  it('流式 402：同样置 error 并保留已到达的 partialAnswer', async () => {
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onDelta?.('半截答案')
      throw new QaClientError('llm_unavailable', 'LLM 不可用（HTTP 402）', 402)
    })
    const store = useQaStore()

    await store.askStreaming({ question: 'x' })

    expect(store.status).toBe('error')
    expect(store.errorKind).toBe('llm_unavailable')
    expect(store.partialAnswer).toBe('半截答案')
  })

  it('cancel（aborted）不算错误：有旧答案回 done，无旧答案回 idle，partial 清空', async () => {
    askStreamMock.mockRejectedValueOnce(new QaClientError('aborted', '请求已取消'))
    const store = useQaStore()

    await store.askStreaming({ question: 'x' })
    expect(store.status).toBe('idle')
    expect(store.errorKind).toBe('')

    askQuestionMock.mockResolvedValueOnce(responseFixture())
    await store.ask({ question: 'y' })
    askStreamMock.mockRejectedValueOnce(new QaClientError('aborted', '请求已取消'))
    await store.askStreaming({ question: 'z' })
    expect(store.status).toBe('done')
    expect(store.answer).toBe(responseFixture().answer)
  })

  it('retry 按原模式重跑上一次问题', async () => {
    askQuestionMock.mockRejectedValueOnce(new QaClientError('network', 'boom'))
    askQuestionMock.mockResolvedValueOnce(responseFixture())
    const store = useQaStore()

    await store.ask({ question: '重试问题' })
    expect(store.status).toBe('error')

    store.retry()
    await vi.waitFor(() => expect(store.status).toBe('done'))
    expect(askQuestionMock).toHaveBeenCalledTimes(2)
    expect(askQuestionMock).toHaveBeenLastCalledWith({ question: '重试问题' })
    expect(askStreamMock).not.toHaveBeenCalled()
  })
})
