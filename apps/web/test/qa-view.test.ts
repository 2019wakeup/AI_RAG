import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'

import { askStream, QaClientError } from '@/api/qa'
import App from '@/App.vue'
import QaView from '@/views/QaView.vue'
import { useQaStore } from '@/stores/qa'
import type { QaResponse } from '@ai-rag/contracts'

vi.mock('@/api/qa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/qa')>()
  return { ...actual, askQuestion: vi.fn(), askStream: vi.fn() }
})

const askStreamMock = vi.mocked(askStream)

const responseFixture = (overrides: Partial<QaResponse> = {}): QaResponse => ({
  schemaVersion: '1',
  question: 'SBS 改性沥青软化点要求',
  answer: '规范要求软化点 ≥ 84 ℃ [1]。',
  citations: [
    { n: 1, chunkId: 'chunk-1', sourceDocId: 'JTGF41-2008', docType: 'standard', score: 0.92, snippet: 'SBS 改性沥青 I-D 级软化点不小于 84 ℃。' },
    { n: 2, chunkId: 'chunk-2', sourceDocId: 'lit-042', docType: 'literature-full', score: 0.81, snippet: '改性剂掺量对软化点有显著影响。' },
  ],
  refused: false,
  needInfo: [],
  status: 'ok',
  trace: { retrievalMs: 42, hitCount: 8, citationCount: 2 },
  ...overrides,
})

/** 可控的流式 mock：返回 handlers 与 resolve 句柄，供逐态断言。 */
function pendingStream() {
  let handlers!: NonNullable<Parameters<typeof askStream>[1]>
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  askStreamMock.mockImplementationOnce((_req, h) => {
    handlers = h ?? {}
    return promise
  })
  return {
    getHandlers: () => handlers,
    finish: (res?: QaResponse) => {
      handlers.onDone?.(res ?? responseFixture())
      resolve()
    },
  }
}

async function mountView() {
  const wrapper = mount(QaView)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  askStreamMock.mockReset()
})

describe('QaView - 空态', () => {
  it('渲染引导语与 3 个示例问题按钮', async () => {
    const wrapper = await mountView()
    expect(wrapper.find('[data-testid="qa-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('问一个沥青养护材料问题')
    expect(wrapper.findAll('[data-testid="qa-example"]')).toHaveLength(3)
  })

  it('点示例按钮直接发起流式提问', async () => {
    const stream = pendingStream()
    const wrapper = await mountView()
    await wrapper.findAll('[data-testid="qa-example"]')[0].trigger('click')
    expect(askStreamMock).toHaveBeenCalledTimes(1)
    expect(askStreamMock.mock.calls[0]?.[0]).toEqual({ question: 'SBS 改性沥青软化点要求' })
    stream.finish()
  })
})

describe('QaView - 提交与加载态', () => {
  it('输入问题点「提问」提交；loading 期间显示骨架且提交按钮禁用', async () => {
    const stream = pendingStream()
    const wrapper = await mountView()
    await wrapper.find('[data-testid="qa-input"]').setValue('压实温度要求是什么')
    await wrapper.find('[data-testid="qa-submit"]').trigger('click')

    expect(askStreamMock).toHaveBeenCalledWith({ question: '压实温度要求是什么' }, expect.anything(), expect.anything())
    expect(wrapper.find('[data-testid="qa-loading"]').exists()).toBe(true)
    expect((wrapper.find('[data-testid="qa-submit"]').element as HTMLButtonElement).disabled).toBe(true)

    // 流式增量应实时可见
    stream.getHandlers().onDelta?.('规范规定压实')
    await flushPromises()
    expect(wrapper.text()).toContain('规范规定压实')
    stream.finish()
    await flushPromises()
  })
})

describe('QaView - 答案与证据态', () => {
  it('done 后渲染答案、trace、引用卡片（[n] + 原文 snippet + data-evidence-id）', async () => {
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onDone?.(responseFixture())
    })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="qa-input"]').setValue('SBS 改性沥青软化点要求')
    await wrapper.find('[data-testid="qa-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="qa-answer"]').exists()).toBe(true)
    expect(wrapper.find('.qa-answer-text').text()).toContain('[1]')
    expect(wrapper.find('[data-testid="qa-trace"]').text()).toContain('命中 8 块')
    const cards = wrapper.findAll('.qa-citation')
    expect(cards).toHaveLength(2)
    expect(cards[0].attributes('data-evidence-id')).toBe('chunk-1')
    expect(cards[0].find('[data-testid="qa-cite-n"]').text()).toBe('[1]')
    expect(cards[0].text()).toContain('软化点不小于 84 ℃')
  })

  it('refused 响应：显示拒答提示与原因，不显示编造答案', async () => {
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onDone?.(responseFixture({ answer: '', refused: true, refusalReason: 'out_of_domain', citations: [], status: 'degraded' }))
    })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="qa-input"]').setValue('今天天气怎么样')
    await wrapper.find('[data-testid="qa-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('.qa-refused').text()).toContain('未编造答案')
    expect(wrapper.text()).toContain('out_of_domain')
    expect(wrapper.find('[data-testid="qa-degraded-tag"]').exists()).toBe(true)
  })
})

describe('QaView - 错误态', () => {
  it('402 失败：显示归一错误与重试按钮；partialAnswer 仍可见', async () => {
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onDelta?.('已生成一半')
      throw new QaClientError('llm_unavailable', 'LLM 不可用（HTTP 402，余额不足或未配置）', 402)
    })
    const wrapper = await mountView()
    await wrapper.find('[data-testid="qa-input"]').setValue('x 问题')
    await wrapper.find('[data-testid="qa-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="qa-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('402')
    expect(wrapper.text()).toContain('已生成一半')
    expect(wrapper.find('[data-testid="qa-retry"]').exists()).toBe(true)
  })
})

describe('导航（T13 路由/入口）', () => {
  it('App 侧栏出现「智能问答」并指向 /qa 懒加载路由', async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/qa', name: 'qa', component: QaView }],
    })
    const wrapper = mount(App, { global: { plugins: [router] } })
    await router.isReady()
    await flushPromises()

    const links = wrapper.findAllComponents({ name: 'ElMenuItem' })
    const qaItem = links.find((item) => item.text().includes('智能问答'))
    expect(qaItem).toBeTruthy()
    expect(qaItem?.props('index')).toBe('/qa')
  })
})
