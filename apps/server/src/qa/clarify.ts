import { FIELD_REGISTRY, NeedInfoSlotSchema, needInfoFromSlots } from '@ai-rag/contracts';
import type { NeedInfoSlot } from '@ai-rag/contracts';

/**
 * 追问 needInfo 与缺槽识别（T18）：纯函数、规则优先、不依赖 LLM/网络/DB/fs。
 * 槽位语义与展示 label 全部直接取自 `@ai-rag/contracts` 的 `FIELD_REGISTRY`（杜绝自造词），
 * 通过契约接缝 `NeedInfoSlotSchema` + `needInfoFromSlots()` 投影为确定性 `string[]`（T19 接入）。
 */

export const CLARIFY_SLOT_KEYS = ['climate.zone', 'traffic.level', 'distresses'] as const;
export type ClarifySlotKey = (typeof CLARIFY_SLOT_KEYS)[number];

/** 各核心槽位的首选示例（按 FIELD_REGISTRY options 的 value 查表，保证示例同源） */
const PREFERRED_EXAMPLE_VALUE: Record<ClarifySlotKey, string> = {
  'climate.zone': '华南高温区',
  'traffic.level': 'heavy',
  distresses: 'rutting',
};

/** 沥青路面养护材料领域词（中英双语） */
const DOMAIN_RE =
  /沥青|混合料|路面|铺装|养护|改性剂|结合料|胶结料|级配|集料|面层|基层|sma|ogfc|ac-\d|sup-?\d|rap|sbs|sbr|\b(?:asphalt|bitumen|binder|pavement|mixture|mix|aggregate|overlay|maintenance)\b/i;

/** 剔除「问试验/指标/规范方法」短语后再判选材意图，防止误把指标问答当成材料选型追问 */
const NON_MATERIAL_QUERY_RE =
  /(?:用什么|采用什么|选什么|使用什么)(?:试验|测试|检测|方法|指标|规范|标准|仪器|设备|公式|参数)/g;

/** 材料/养护方案选型意图（中英双语） */
const SELECTION_INTENT_RE =
  /该用|用什么|用啥|选用|选什么|选啥|选哪种|选哪款|怎么选|如何选|挑什么|配什么|采用什么|建议用|适合用|推荐|选型|(?:什么|哪种|哪款).{0,6}(?:沥青|混合料|材料|改性剂|结合料|胶结料|级配|方案|措施)|\b(?:which|what)\s+(?:kind\s+of\s+)?(?:asphalt|bitumen|binder|mix|mixture|material|modifier|gradation)\b|\b(?:recommend|choose|select|suggest)\b/i;

/** 各核心槽位的领域关键词规则（与 FIELD_REGISTRY options 互补，覆盖常见工程与英文表述） */
const SLOT_PATTERNS: Record<ClarifySlotKey, RegExp> = {
  'climate.zone':
    /高温|低温|严寒|寒冷|炎热|湿热|湿润|干旱|干燥|多雨|潮湿|温和|冻融|高寒|高原|亚热带|季风|温区|寒区|热区|气候区|气候分区|降水|冰雪|结冰|冬冷|夏热|华南|华北|华东|华中|东北|西北|西南|江淮|江南|岭南|青藏|新疆|海南|广东|黑龙江|pg\s*\d{2}(?:\s*-\s*\d{2})?|(?:-?\d+\s*[℃°]|零下\s*\d+)|\b[1-3]-[1-4]\b|\b(?:hot|cold|warm|mild|humid|wet|dry|rainy|arid|freezing|freeze[- ]?thaw|tropical|subtropical|alpine|climate)\b/i,
  'traffic.level':
    /重载|重交通|特重|超载|渠化|轻交通|中等交通|中交通|低交通|大交通量|交通量|高荷载|重荷载|荷载等级|交通等级|轴载|轴次|高速公路|城市主干道|主干道|次干道|支路|港口|机场|货车|重车|轮迹集中|\besal\b|\d+(?:\.\d+)?\s*(?:万次|百万次|千万次)|\b(?:heavy|medium|light|channelized|overload|overloaded|high[- ]?volume|low[- ]?volume|traffic|axle\s*load)\b/i,
  distresses:
    /车辙|抗车辙|永久变形|推移|推挤|拥包|裂缝|开裂|抗裂|温缩|反射裂|龟裂|网裂|块裂|水损|水损坏|抗水损|剥落|松散|麻面|露骨|唧浆|坑槽|坑洞|脱皮|抗滑|打滑|磨光|泛油|老化|噪声|噪音|降噪|排水|积水|疲劳|\b(?:rutting|rut|shoving|crack|cracking|fatigue|water[- ]?damage|moisture|stripping|raveling|ravelling|pothole|skid|slippery|bleeding|aging|noise|drainage)\b/i,
};

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 从 FIELD_REGISTRY 动态匹配已登记选项（中文按子串，英文 slug 按词边界且兼容连字符/空格） */
function matchesRegistryOption(key: ClarifySlotKey, text: string, lower: string): boolean {
  const options = FIELD_REGISTRY[key]?.options ?? [];
  for (const opt of options) {
    if (opt.label && lower.includes(opt.label.toLowerCase())) return true;
    if (opt.value) {
      if (/^[a-z0-9-]+$/i.test(opt.value)) {
        const pattern = escapeRegExp(opt.value).replace(/-/g, '[-\\s]+');
        if (new RegExp(`\\b${pattern}\\b`, 'i').test(text)) return true;
      } else if (lower.includes(opt.value.toLowerCase())) {
        return true;
      }
    }
  }
  return false;
}

function hasSlotInfo(key: ClarifySlotKey, text: string, lower: string): boolean {
  return SLOT_PATTERNS[key].test(text) || matchesRegistryOption(key, text, lower);
}

/** 从 FIELD_REGISTRY 构造单条缺失槽位，并通过 NeedInfoSlotSchema 做运行时契约校验 */
function buildNeedInfoSlot(key: ClarifySlotKey): NeedInfoSlot {
  const def = FIELD_REGISTRY[key];
  if (!def) throw new Error(`FIELD_REGISTRY 缺少核心槽位定义：${key}`);
  const preferred = PREFERRED_EXAMPLE_VALUE[key];
  const example =
    def.options?.find((o) => o.value === preferred || o.label === preferred)?.label ??
    def.options?.[0]?.label;
  return NeedInfoSlotSchema.parse({
    key,
    label: `请补充${def.label}`,
    ...(example ? { example } : {}),
  });
}

/** 识别领域选型问句中缺失的核心槽位（结构化接缝；顺序稳定、确定性可复现） */
export function detectMissingSlots(text: string): NeedInfoSlot[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // 纯符号或少于 2 个有效字元的极短输入不追问（交给入口校验或拒答）
  const meaningful = trimmed.replace(/[^\p{L}\p{N}]+/gu, '');
  if (meaningful.length < 2) return [];

  const lower = trimmed.toLowerCase();
  // 域外问句（不含领域词）不追问，留给 refusal.ts 判 out_of_domain
  if (!DOMAIN_RE.test(trimmed)) return [];
  // 非材料选型问句（如具体指标/规范条文/试验方法咨询）不误追问
  const intentTarget = trimmed.replace(NON_MATERIAL_QUERY_RE, '');
  if (!SELECTION_INTENT_RE.test(intentTarget)) return [];

  const missing: NeedInfoSlot[] = [];
  for (const key of CLARIFY_SLOT_KEYS) {
    if (!hasSlotInfo(key, trimmed, lower)) missing.push(buildNeedInfoSlot(key));
  }
  return missing;
}

/** T18/T19 主接缝：缺槽识别 → 面向用户的中文追问数组（QaResponse.needInfo: string[]） */
export function collectNeedInfo(text: string): string[] {
  return needInfoFromSlots(detectMissingSlots(text));
}
