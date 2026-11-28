import { nextTick, onScopeDispose, shallowRef } from 'vue'

/**
 * 证据角标定位（T14）：从 RecommendView 的 onCite 抽出，推荐视图与问答视图共用。
 * 流程：置 highlight →（可选 onExpand 展开所属分组）→ nextTick → scrollIntoView 居中
 * → 700ms flash 微确认 →（可选 toast，1.6s 自动消失）。
 */
export interface EvidenceAnchorOptions {
  /** flash 高亮持续毫秒（默认 700，与既有推荐视图一致） */
  flashMs?: number
  /** toast 停留毫秒（默认 1600） */
  toastMs?: number
}

export interface AnchorHooks {
  /** 定位前调用：如推荐视图展开持有该证据的候选卡 */
  onExpand?: (evidenceId: string) => void
  /** 传入则显示 toast；undefined 不显示（问答视图静默定位） */
  toastText?: string
}

export function useEvidenceAnchor(options: EvidenceAnchorOptions = {}) {
  const flashMs = options.flashMs ?? 700
  const toastMs = options.toastMs ?? 1600

  const highlightId = shallowRef<string | null>(null)
  const flashId = shallowRef<string | null>(null)
  const toast = shallowRef('')
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  let toastTimer: ReturnType<typeof setTimeout> | undefined

  async function anchorTo(evidenceId: string, hooks: AnchorHooks = {}): Promise<void> {
    highlightId.value = evidenceId
    hooks.onExpand?.(evidenceId)
    await nextTick()
    const el = document.querySelector(`[data-evidence-id="${CSS.escape(evidenceId)}"]`)
    ;(el as HTMLElement | null)?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })

    flashId.value = evidenceId
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashId.value = null
    }, flashMs)

    if (hooks.toastText !== undefined) {
      toast.value = hooks.toastText
      if (toastTimer) clearTimeout(toastTimer)
      toastTimer = setTimeout(() => {
        toast.value = ''
      }, toastMs)
    }
  }

  onScopeDispose(() => {
    if (flashTimer) clearTimeout(flashTimer)
    if (toastTimer) clearTimeout(toastTimer)
  })

  return { highlightId, flashId, toast, anchorTo }
}
