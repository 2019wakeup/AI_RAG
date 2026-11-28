import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { askStream } from '@/api/qa'
import CitationBadge from '@/components/CitationBadge.vue'
import EvidencePanel from '@/components/EvidencePanel.vue'
import QaAnswer from '@/components/QaAnswer.vue'
import QaView from '@/views/QaView.vue'
import type { QaCitation, QaResponse, SearchHit } from '@ai-rag/contracts'

vi.mock('@/api/qa', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/qa')>()
  return { ...actual, askQuestion: vi.fn(), askStream: vi.fn() }
})

const askStreamMock = vi.mocked(askStream)

const citation1: QaCitation = {
  n: 1, chunkId: 'chunk-1', sourceDocId: 'JTGF41-2008', docType: 'standard',
  score: 0.92, snippet: '软化点不小于 84 ℃。', title: '公路沥青路面养护技术规范', locator: '4.6.2 条',
}
const citation2: QaCitation = {
  n: 2, chunkId: 'chunk-2', sourceDocId: 'lit-042', docType: 'literature-full',
  score: 0.81, snippet: '掺量对软化点有显著影响。',
}

const responseFixture = (answer: string): QaResponse => ({
  schemaVersion: '1',
  question: 'SBS 改性沥青软化点要求',
  answer,
  citations: [citation1, citation2],
  refused: false,
  needInfo: [],
  status: 'ok',
  trace: { retrievalMs: 42, hitCount: 8, citationCount: 2 },
})

beforeEach(() => {
  setActivePinia(createPinia())
  askStreamMock.mockReset()
  // happy-dom 无真实布局：桩住 scrollIntoView 以断言定位调用
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CitationBadge', () => {
  it('渲染 [n]，role=button 且 tabindex=0 可 Tab 聚焦', () => {
    const wrapper = mount(CitationBadge, { props: { citation: citation1 } })
    const badge = wrapper.get('[data-testid="cite-badge"]')
    expect(badge.text()).toBe('[1]')
    expect(badge.attributes('role')).toBe('button')
    expect(badge.attributes('tabindex')).toBe('0')
  })

  it('悬停信息含 docType + sourceDocId，有 title/locator 时一并显示', () => {
    const wrapper = mount(CitationBadge, { props: { citation: citation1 } })
    const title = wrapper.get('[data-testid="cite-badge"]').attributes('title')
    expect(title).toContain('规范')
    expect(title).toContain('JTGF41-2008')
    expect(title).toContain('公路沥青路面养护技术规范')
    expect(title).toContain('4.6.2 条')

    const plain = mount(CitationBadge, { props: { citation: citation2 } })
    expect(plain.get('[data-testid="cite-badge"]').attributes('title')).toBe('文献章节 · lit-042')
  })

  it('点击与 Enter 均触发 select', async () => {
    const wrapper = mount(CitationBadge, { props: { citation: citation1 } })
    await wrapper.get('[data-testid="cite-badge"]').trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual([citation1])
    await wrapper.get('[data-testid="cite-badge"]').trigger('keydown.enter')
    expect(wrapper.emitted('select')).toHaveLength(2)
  })
})

describe('QaAnswer - [n] 切分与越界保护', () => {
  it('有效编号渲染为角标，文本段保留', () => {
    const wrapper = mount(QaAnswer, {
      props: { answer: '规范要求 84 ℃ [1]；另有研究 [2] 佐证。', citations: [citation1, citation2] },
    })
    const badges = wrapper.findAllComponents(CitationBadge)
    expect(badges).toHaveLength(2)
    expect(wrapper.text()).toContain('规范要求 84 ℃ ')
    expect(wrapper.text()).toContain(' 佐证。')
  })

  it('越界编号 [9] 不渲染角标，保持纯文本（不指向不存在的证据）', () => {
    const wrapper = mount(QaAnswer, { props: { answer: '结论 [1] 与 [9]', citations: [citation1] } })
    expect(wrapper.findAllComponents(CitationBadge)).toHaveLength(1)
    expect(wrapper.text()).toContain('[9]')
  })

  it('角标点击事件向上传为 cite(citation)', async () => {
    const wrapper = mount(QaAnswer, { props: { answer: '结论 [2]。', citations: [citation1, citation2] } })
    await wrapper.get('[data-testid="cite-badge"]').trigger('click')
    expect(wrapper.emitted('cite')?.[0]).toEqual([citation2])
  })
})

describe('QaView - 角标 → 证据卡联动（验收①）', () => {
  async function mountAnswered(answer: string) {
    askStreamMock.mockImplementationOnce(async (_req, handlers) => {
      handlers?.onDone?.(responseFixture(answer))
    })
    // 挂到 document：anchorTo 走 document.querySelector 定位真实卡片
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(QaView, { attachTo: host })
    await flushPromises()
    await wrapper.find('[data-testid="qa-input"]').setValue('SBS 改性沥青软化点要求')
    await wrapper.find('[data-testid="qa-submit"]').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('点角标 → 对应 data-evidence-id 卡片高亮 + flash，滚动定位调用生效', async () => {
    vi.useFakeTimers()
    const wrapper = await mountAnswered('规范要求软化点 ≥ 84 ℃ [2]。')
    await vi.advanceTimersByTimeAsync(100)

    await wrapper.get('[data-testid="cite-badge"]').trigger('click')
    await vi.advanceTimersByTimeAsync(100)

    const target = wrapper.find('[data-evidence-id="chunk-2"]')
    expect(target.classes()).toContain('is-highlighted')
    expect(target.classes()).toContain('is-flash')
    expect(wrapper.find('[data-evidence-id="chunk-1"]').classes()).not.toContain('is-flash')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })

    // 700ms 后 flash 消退，持续高亮保留
    await vi.advanceTimersByTimeAsync(700)
    expect(wrapper.find('[data-evidence-id="chunk-2"]').classes()).not.toContain('is-flash')
    expect(wrapper.find('[data-evidence-id="chunk-2"]').classes()).toContain('is-highlighted')
  })
})

describe('EvidencePanel - activeId 向后兼容（验收：默认行为不变）', () => {
  const hit = (chunkId: string): SearchHit => ({
    schemaVersion: '1',
    chunkId,
    docType: 'standard',
    text: `证据原文 ${chunkId}`,
    tags: [],
    score: 0.9,
    provenance: {
      sourceDocId: `doc-${chunkId}`, contentHash: 'h', embeddingModel: 'e5-small',
      modelVersion: '1', dim: 384, pipelineRev: '1', embeddedAt: '2026-01-01',
    },
  })

  function mountPanel(props: Record<string, unknown> = {}) {
    return mount(EvidencePanel, { props: { evidence: [hit('c1'), hit('c2')], ids: ['c1', 'c2'], ...props } })
  }

  it('不传 activeId 时无 is-active（既有渲染不变，recommend 94 例同回归）', () => {
    const wrapper = mountPanel()
    expect(wrapper.findAll('.is-active')).toHaveLength(0)
  })

  it('传 activeId 时对应卡片持续高亮', () => {
    const wrapper = mountPanel({ activeId: 'c2' })
    expect(wrapper.find('[data-evidence-id="c2"]').classes()).toContain('is-active')
    expect(wrapper.find('[data-evidence-id="c1"]').classes()).not.toContain('is-active')
  })
})
