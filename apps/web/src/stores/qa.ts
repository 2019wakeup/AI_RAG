import { defineStore } from 'pinia'
import { computed, shallowRef } from 'vue'

import { askQuestion, askStream, QaClientError } from '@/api/qa'
import type { QaErrorKind } from '@/api/qa'
import type { QaCitation, QaRequest, QaResponse } from '@ai-rag/contracts'

/**
 * 问答状态机（T12）：idle → loading → done | error。
 * - done / error 由本次请求结果决定；后端降级信息（status:"degraded"、llm 不可用）透出为派生态，不另设状态；
 * - 失败置 error 并保留 partialAnswer（流式已生成部分不清空，视图可读）；
 * - 取消（aborted）不算错误：有旧答案回 done，否则回 idle。
 */
export type QaFlowStatus = 'idle' | 'loading' | 'done' | 'error'

export const useQaStore = defineStore('qa', () => {
  const status = shallowRef<QaFlowStatus>('idle')
  const response = shallowRef<QaResponse | null>(null)
  const partialAnswer = shallowRef('')
  const liveTrace = shallowRef<QaResponse['trace']>(undefined)
  const liveCitations = shallowRef<QaCitation[]>([])
  const errorMessage = shallowRef('')
  const errorKind = shallowRef<QaErrorKind | ''>('')

  let lastRequest: QaRequest | null = null
  let lastMode: 'json' | 'stream' = 'json'
  let abortController: AbortController | null = null

  const answer = computed(() => (status.value === 'loading' ? partialAnswer.value : (response.value?.answer ?? partialAnswer.value)))
  const citations = computed<QaCitation[]>(() =>
    status.value === 'loading' ? liveCitations.value : (response.value?.citations ?? []),
  )
  const trace = computed(() => (status.value === 'loading' ? liveTrace.value : response.value?.trace))
  const refused = computed(() => response.value?.refused ?? false)
  const refusalReason = computed(() => response.value?.refusalReason)
  const needInfo = computed(() => response.value?.needInfo ?? [])
  const degraded = computed(() => response.value?.status === 'degraded')
  const hasResult = computed(() => response.value !== null)

  function citationByN(n: number): QaCitation | undefined {
    return citations.value.find((c) => c.n === n)
  }

  function start(req: QaRequest, mode: 'json' | 'stream'): void {
    status.value = 'loading'
    lastRequest = req
    lastMode = mode
    errorMessage.value = ''
    errorKind.value = ''
    partialAnswer.value = ''
    liveTrace.value = undefined
    liveCitations.value = []
    abortController = new AbortController()
  }

  function applyResponse(res: QaResponse): void {
    response.value = res
    partialAnswer.value = ''
    liveTrace.value = undefined
    liveCitations.value = []
    status.value = 'done'
  }

  function fail(err: unknown): void {
    const e = err instanceof QaClientError ? err : new QaClientError('network', String(err))
    if (e.kind === 'aborted') {
      // 用户取消：回滚到请求前展示态，不算错误
      partialAnswer.value = ''
      liveTrace.value = undefined
      liveCitations.value = []
      status.value = response.value ? 'done' : 'idle'
      return
    }
    // 402 / 网络失败 / 契约不匹配：置 error，保留 partialAnswer 供视图显示已生成部分
    status.value = 'error'
    errorKind.value = e.kind
    errorMessage.value = e.message
  }

  async function ask(req: QaRequest): Promise<void> {
    start(req, 'json')
    try {
      applyResponse(await askQuestion(req))
    } catch (err) {
      fail(err)
    }
  }

  async function askStreaming(req: QaRequest): Promise<void> {
    start(req, 'stream')
    try {
      await askStream(
        req,
        {
          onMeta: (meta) => {
            if (meta.trace) liveTrace.value = meta.trace
          },
          onDelta: (delta) => {
            partialAnswer.value += delta
          },
          onCitation: (citation) => {
            liveCitations.value = [...liveCitations.value, citation]
          },
          onDone: applyResponse,
        },
        { signal: abortController?.signal },
      )
    } catch (err) {
      fail(err)
    }
  }

  /** 取消本次流式生成（aborted 不算错误）。 */
  function cancel(): void {
    abortController?.abort()
  }

  /** 失败后按原模式重跑上一次问题。 */
  function retry(): void {
    if (!lastRequest) return
    if (lastMode === 'stream') void askStreaming(lastRequest)
    else void ask(lastRequest)
  }

  function reset(): void {
    abortController?.abort()
    abortController = null
    response.value = null
    status.value = 'idle'
    partialAnswer.value = ''
    liveTrace.value = undefined
    liveCitations.value = []
    errorMessage.value = ''
    errorKind.value = ''
    lastRequest = null
  }

  return {
    status,
    response,
    partialAnswer,
    errorMessage,
    errorKind,
    answer,
    citations,
    trace,
    refused,
    refusalReason,
    needInfo,
    degraded,
    hasResult,
    citationByN,
    ask,
    askStreaming,
    cancel,
    retry,
    reset,
  }
})
