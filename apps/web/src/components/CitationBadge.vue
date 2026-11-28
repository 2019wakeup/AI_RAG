<script setup lang="ts">
import { computed } from 'vue'

import { DOC_TYPE_LABELS } from '@/utils/labels'
import type { QaCitation } from '@ai-rag/contracts'

/**
 * 引用角标 [n]（T14）：span+role=button 保证 Tab 聚焦与 Enter 触发；
 * 悬停显示出处（docType + sourceDocId，有 title/locator——规范号/DOI/页码——一并显示）。
 */
const props = defineProps<{ citation: QaCitation }>()
const emit = defineEmits<{ (e: 'select', citation: QaCitation): void }>()

const sourceText = computed(() => {
  const parts = [DOC_TYPE_LABELS[props.citation.docType] ?? props.citation.docType, props.citation.sourceDocId]
  if (props.citation.title) parts.push(props.citation.title)
  if (props.citation.locator) parts.push(props.citation.locator)
  return parts.join(' · ')
})
</script>

<template>
  <el-tooltip :content="sourceText" placement="top">
    <span
      class="cite-badge"
      data-testid="cite-badge"
      role="button"
      tabindex="0"
      :title="sourceText"
      :aria-label="`定位证据 ${citation.n}：${sourceText}`"
      @click="emit('select', citation)"
      @keydown.enter.prevent="emit('select', citation)"
    >[{{ citation.n }}]</span>
  </el-tooltip>
</template>

<style scoped>
.cite-badge {
  display: inline-block;
  padding: 0 4px;
  margin: 0 1px;
  border-radius: 4px;
  background: var(--el-fill-color-light);
  color: var(--el-color-primary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.cite-badge:hover {
  background: var(--el-color-primary-light-8);
}

.cite-badge:focus-visible {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
</style>
