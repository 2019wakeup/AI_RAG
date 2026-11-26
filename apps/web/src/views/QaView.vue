<script setup lang="ts">
import { ref } from 'vue'

import { DOC_TYPE_LABELS } from '@/utils/labels'
import { useQaStore } from '@/stores/qa'

/**
 * 问答视图（T13）：输入 → 流式提问（api/qa.askStream）→ 答案 + 证据卡片。
 * 拒答/追问的完整 UI 在 T21 收口；[n] 角标定位在 T14 接入（证据卡片已带 data-evidence-id）。
 */
const store = useQaStore()
const question = ref('')

const EXAMPLES = [
  'SBS 改性沥青软化点要求',
  'OGFC 沥青混合料目标空隙率范围',
  '重载交通路面抗车辙混合料设计要点',
]

function ask(q?: string): void {
  const text = (q ?? question.value).trim()
  if (!text || store.status === 'loading') return
  question.value = text
  void store.askStreaming({ question: text })
}
</script>

<template>
  <div class="qa-page">
    <header class="qa-header">
      <h2>智能问答</h2>
      <p class="qa-subtitle">基于领域语料检索作答，每个结论可点开原文证据；证据不足会明确拒答。</p>
    </header>

    <div class="qa-input-row">
      <el-input
        v-model="question"
        data-testid="qa-input"
        placeholder="输入一个沥青路面养护材料问题，如：SBS 改性沥青软化点要求"
        maxlength="2000"
        :disabled="store.status === 'loading'"
        @keydown.enter.exact.prevent="ask()"
      />
      <el-button
        type="primary"
        data-testid="qa-submit"
        :loading="store.status === 'loading'"
        :disabled="!question.trim() || store.status === 'loading'"
        @click="ask()"
      >提问</el-button>
      <el-button v-if="store.status === 'loading'" data-testid="qa-cancel" @click="store.cancel()">取消</el-button>
    </div>

    <!-- 空态：引导 + 示例问题 -->
    <div v-if="store.status === 'idle' && !store.hasResult" class="qa-empty" data-testid="qa-empty">
      <p>问一个沥青养护材料问题</p>
      <div class="qa-examples">
        <el-button
          v-for="example in EXAMPLES"
          :key="example"
          size="small"
          round
          data-testid="qa-example"
          @click="ask(example)"
        >{{ example }}</el-button>
      </div>
    </div>

    <!-- 加载态：骨架屏 + 已到达的部分答案 -->
    <div v-else-if="store.status === 'loading'" class="qa-loading" data-testid="qa-loading">
      <el-skeleton :rows="3" animated />
      <p v-if="store.partialAnswer" class="qa-partial">{{ store.partialAnswer }}</p>
      <p class="qa-loading-hint">正在检索领域语料并组织证据…</p>
    </div>

    <!-- 错误态：归一文案 + 重试 -->
    <el-alert
      v-else-if="store.status === 'error'"
      type="error"
      data-testid="qa-error"
      :closable="false"
      show-icon
    >
      <template #title>{{ store.errorMessage || '问答请求失败' }}</template>
      <template #default>
        <el-button size="small" type="primary" plain data-testid="qa-retry" @click="store.retry()">重试</el-button>
        <span v-if="store.partialAnswer" class="qa-partial-hint">以下为失败前已生成部分：</span>
        <p v-if="store.partialAnswer" class="qa-partial">{{ store.partialAnswer }}</p>
      </template>
    </el-alert>

    <!-- 答案态 -->
    <template v-else-if="store.response">
      <el-card shadow="never" class="qa-answer" data-testid="qa-answer">
        <template #header>答案</template>
        <p v-if="store.refused" class="qa-refused">
          当前证据不足以回答该问题，系统未编造答案。
          <span class="qa-refused-reason">（原因：{{ store.refusalReason }}）</span>
        </p>
        <ul v-else-if="store.needInfo.length" class="qa-needinfo" data-testid="qa-needinfo">
          <li v-for="slot in store.needInfo" :key="slot">{{ slot }}</li>
        </ul>
        <p v-if="store.answer" class="qa-answer-text">{{ store.answer }}</p>
        <p class="qa-trace" data-testid="qa-trace">
          命中 {{ store.trace?.hitCount ?? 0 }} 块 · 引用 {{ store.citations.length }} 条
          <template v-if="store.trace?.retrievalMs != null"> · 检索 {{ store.trace.retrievalMs }} ms</template>
          <el-tag v-if="store.degraded" size="small" type="warning" data-testid="qa-degraded-tag">降级模式</el-tag>
        </p>
      </el-card>

      <el-card shadow="never" class="qa-evidence" data-testid="qa-evidence">
        <template #header>证据（{{ store.citations.length }}）</template>
        <el-empty v-if="store.citations.length === 0" description="本次没有可引用的原文证据" :image-size="48" />
        <div v-else>
          <div v-for="citation in store.citations" :key="citation.chunkId" class="qa-citation" :data-evidence-id="citation.chunkId">
            <div class="qa-citation-head">
              <span class="qa-cite-n" data-testid="qa-cite-n">[{{ citation.n }}]</span>
              <el-tag size="small" effect="plain">{{ DOC_TYPE_LABELS[citation.docType] ?? citation.docType }}</el-tag>
              <span class="qa-citation-source">{{ citation.title ?? citation.sourceDocId }}</span>
            </div>
            <p class="qa-citation-snippet">{{ citation.snippet }}</p>
          </div>
        </div>
      </el-card>
    </template>
  </div>
</template>

<style scoped>
.qa-page { max-width: 860px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.qa-header h2 { margin: 0; font-size: 20px; }
.qa-subtitle { margin: 4px 0 0; font-size: 13px; color: var(--el-text-color-secondary); }
.qa-input-row { display: flex; gap: 8px; }
.qa-empty { padding: 40px 16px; text-align: center; color: var(--el-text-color-secondary); border: 1px dashed var(--app-border); border-radius: var(--app-radius-inner); }
.qa-examples { display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.qa-loading-hint { font-size: 12px; color: var(--el-text-color-placeholder); }
.qa-partial { margin: 8px 0 0; white-space: pre-line; color: var(--el-text-color-regular); }
.qa-partial-hint { display: block; margin-top: 6px; font-size: 12px; color: var(--el-text-color-secondary); }
.qa-refused { font-weight: 600; }
.qa-refused-reason { color: var(--el-text-color-secondary); font-weight: 400; }
.qa-needinfo { margin: 0; padding-left: 20px; }
.qa-answer-text { white-space: pre-line; line-height: 1.7; margin: 0 0 10px; }
.qa-trace { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; color: var(--el-text-color-secondary); }
.qa-citation { padding: 10px 0; border-top: 1px solid var(--app-border); }
.qa-citation:first-child { border-top: none; }
.qa-citation-head { display: flex; align-items: center; gap: 8px; }
.qa-cite-n { font-weight: 600; color: var(--el-color-primary); }
.qa-citation-source { font-size: 12px; color: var(--el-text-color-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qa-citation-snippet { margin: 6px 0 0; font-size: 13px; line-height: 1.6; white-space: pre-line; color: var(--el-text-color-regular); }
</style>
