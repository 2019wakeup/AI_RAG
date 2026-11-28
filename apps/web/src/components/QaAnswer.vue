<script setup lang="ts">
import { computed } from 'vue'

import CitationBadge from '@/components/CitationBadge.vue'
import type { QaCitation } from '@ai-rag/contracts'

/**
 * 答案渲染（T14）：把正文按 [n] 切分为文本段与角标段。
 * 越界编号（n 不在 citations 内）保持纯文本——前端不渲染指向不存在证据的角标。
 */
const props = defineProps<{ answer: string; citations: QaCitation[] }>()
const emit = defineEmits<{ (e: 'cite', citation: QaCitation): void }>()

type Segment = { type: 'text'; text: string } | { type: 'cite'; citation: QaCitation }

const segments = computed<Segment[]>(() => {
  const byN = new Map(props.citations.map((c) => [c.n, c]))
  const out: Segment[] = []
  let last = 0
  for (const match of props.answer.matchAll(/\[(\d+)\]/g)) {
    const index = match.index ?? 0
    if (index > last) out.push({ type: 'text', text: props.answer.slice(last, index) })
    const citation = byN.get(Number(match[1]))
    out.push(citation ? { type: 'cite', citation } : { type: 'text', text: match[0] })
    last = index + match[0].length
  }
  if (last < props.answer.length) out.push({ type: 'text', text: props.answer.slice(last) })
  return out
})
</script>

<template>
  <p class="qa-answer-text" data-testid="qa-answer-text">
    <template v-for="(segment, i) in segments" :key="i">
      <CitationBadge v-if="segment.type === 'cite'" :citation="segment.citation" @select="emit('cite', $event)" />
      <span v-else>{{ segment.text }}</span>
    </template>
  </p>
</template>

<style scoped>
.qa-answer-text {
  white-space: pre-line;
  line-height: 1.7;
  margin: 0 0 10px;
}
</style>
