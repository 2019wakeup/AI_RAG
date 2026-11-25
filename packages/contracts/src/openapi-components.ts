import type { ZodTypeAny } from 'zod';
import {
  CandidateSchema,
  NeedInfoSlotSchema,
  QaCitationSchema,
  QaRefusalReasonSchema,
  QaRequestSchema,
  QaResponseSchema,
  QaStatusSchema,
  RefusalDecisionSchema,
  CaseSeedSchema,
  CorpusChunkSchema,
  EvidenceRefSchema,
  KnowledgeEntrySchema,
  RecommendationReportSchema,
  SceneInputSchema,
  SearchHitSchema,
  TargetProfileSchema,
} from './schemas';

/**
 * 对外响应体组件登记（OpenAPI `components.schemas` 的单一来源）。
 *
 * 为什么要有它：前后端各自手写类型是「口径漂移」的根源。这里按组件名登记 schema，
 * `apps/server` 启动时把它们注册进 OpenAPI registry，`/openapi` 与 `componentJsonSchemas()`
 * 都以本表为准——测试断言两边的名字集合一致，任何一方漏登记都会红。
 *
 * 规则：只登记**已有** schema，不新增业务字段；QA 相关组件在 T07 单独登记。
 */
export const OPENAPI_COMPONENTS: Record<string, ZodTypeAny> = {
  SceneInput: SceneInputSchema,
  TargetProfile: TargetProfileSchema,
  RecommendationReport: RecommendationReportSchema,
  Candidate: CandidateSchema,
  EvidenceRef: EvidenceRefSchema,
  CorpusChunk: CorpusChunkSchema,
  SearchHit: SearchHitSchema,
  CaseSeed: CaseSeedSchema,
  KnowledgeEntry: KnowledgeEntrySchema,
};

/** 组件名清单（顺序稳定，供测试与文档生成复用）。 */
export const OPENAPI_COMPONENT_NAMES = Object.keys(OPENAPI_COMPONENTS);


/**
 * QA 接缝组件（T07）：5 个 M0 契约 + 2 个 B/C 接缝 schema。
 * 与 `OPENAPI_COMPONENTS` 分开登记，便于 T07 独立断言与后续演进。
 */
export const OPENAPI_QA_COMPONENTS: Record<string, ZodTypeAny> = {
  QaRequest: QaRequestSchema,
  QaCitation: QaCitationSchema,
  QaResponse: QaResponseSchema,
  QaRefusalReason: QaRefusalReasonSchema,
  QaStatus: QaStatusSchema,
  RefusalDecision: RefusalDecisionSchema,
  NeedInfoSlot: NeedInfoSlotSchema,
};

export const OPENAPI_QA_COMPONENT_NAMES = Object.keys(OPENAPI_QA_COMPONENTS);
