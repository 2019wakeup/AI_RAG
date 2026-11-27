import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIELD_REGISTRY, NeedInfoSlotSchema, needInfoFromSlots } from '@ai-rag/contracts';
import { CLARIFY_SLOT_KEYS, collectNeedInfo, detectMissingSlots } from '../src/qa/clarify';

/** T18 追问 needInfo 与缺槽识别：纯函数规则单测，不依赖索引、LLM 或网络。 */

const REGISTRY_LABELS = CLARIFY_SLOT_KEYS.map((k) => FIELD_REGISTRY[k].label);

describe('T18·核心验收：泛选型追问与完整问题不追问', () => {
  it('「该用什么沥青」→ needInfo ≥ 2 条中文提示（含气候分区 / 交通荷载等级 / 病害类型）', () => {
    const hints = collectNeedInfo('该用什么沥青');
    expect(hints.length).toBeGreaterThanOrEqual(2);
    expect(hints).toHaveLength(3);
    expect(hints.some((h) => h.includes(FIELD_REGISTRY['climate.zone'].label))).toBe(true);
    expect(hints.some((h) => h.includes(FIELD_REGISTRY['traffic.level'].label))).toBe(true);
    expect(hints.some((h) => h.includes(FIELD_REGISTRY.distresses.label))).toBe(true);
  });

  it('「金坛区高温重载抗车辙」及带选型词的完整场景问题 → needInfo 为空', () => {
    expect(collectNeedInfo('金坛区高温重载抗车辙')).toEqual([]);
    expect(collectNeedInfo('金坛区高温重载抗车辙该用什么沥青')).toEqual([]);
    expect(collectNeedInfo('华南湿热区重交通车辙路面推荐什么改性沥青')).toEqual([]);
    expect(collectNeedInfo('东北寒冷区中等交通横向裂缝应该选用哪种混合料')).toEqual([]);
  });

  it('部分给出条件时只追问缺失槽位（不重复追问已提供信息）', () => {
    const onlyClimate = collectNeedInfo('高温地区该用什么沥青');
    expect(onlyClimate).toHaveLength(2);
    expect(onlyClimate.some((h) => h.includes(FIELD_REGISTRY['climate.zone'].label))).toBe(false);
    expect(onlyClimate.some((h) => h.includes(FIELD_REGISTRY['traffic.level'].label))).toBe(true);
    expect(onlyClimate.some((h) => h.includes(FIELD_REGISTRY.distresses.label))).toBe(true);

    const climateAndTraffic = collectNeedInfo('寒冷地区重载道路推荐什么改性沥青');
    expect(climateAndTraffic).toHaveLength(1);
    expect(climateAndTraffic[0]).toContain(FIELD_REGISTRY.distresses.label);
  });

  it('具体指标 / 规范 / 试验方法 / 适用场景问答不误追问', () => {
    expect(collectNeedInfo('SBS 改性沥青软化点要求是多少')).toEqual([]);
    expect(collectNeedInfo('JTG F40 对 70# 沥青针入度的规定')).toEqual([]);
    expect(collectNeedInfo('SBS 改性沥青适用于什么场景？')).toEqual([]);
    expect(collectNeedInfo('SBS 改性沥青用什么试验测软化点？')).toEqual([]);
  });

  it('域外问句不追问（留给 refusal.ts 判 out_of_domain）', () => {
    expect(collectNeedInfo('今天天气怎么样')).toEqual([]);
    expect(collectNeedInfo('推荐一部好看的科幻电影')).toEqual([]);
    expect(collectNeedInfo('该买什么型号的手机')).toEqual([]);
  });
});

describe('T18·边界场景：中英混排、超短问句、纯符号与空白', () => {
  it('中英混排：英文工况词（PG / heavy traffic / rutting / cold / crack）可正确消槽', () => {
    expect(collectNeedInfo('PG76-22 heavy traffic rutting 该用什么 SBS asphalt')).toEqual([]);
    expect(collectNeedInfo('cold region cracking 用什么 asphalt binder')).toHaveLength(1);
    expect(collectNeedInfo('cold region cracking 用什么 asphalt binder')[0]).toContain(
      FIELD_REGISTRY['traffic.level'].label,
    );

    const enOnly = collectNeedInfo('Which asphalt binder should I choose?');
    expect(enOnly).toHaveLength(3);
  });

  it('英文词边界防误伤：slight 不误匹配 light 交通等级', () => {
    const hints = collectNeedInfo('slight temperature change, which asphalt should I select?');
    expect(hints.some((h) => h.includes(FIELD_REGISTRY['traffic.level'].label))).toBe(true);
  });

  it('超短问句：含明确选型意图时追问，无选型意图或无领域词时不误追问', () => {
    expect(collectNeedInfo('用啥沥青').length).toBeGreaterThanOrEqual(2);
    expect(collectNeedInfo('沥青选型').length).toBeGreaterThanOrEqual(2);
    expect(collectNeedInfo('沥青')).toEqual([]);
    expect(collectNeedInfo('沥青？')).toEqual([]);
    expect(collectNeedInfo('SBS')).toEqual([]);
    expect(collectNeedInfo('选啥')).toEqual([]);
  });

  it('纯符号、空白、单字符输入不抛错且返回空数组', () => {
    for (const raw of ['', '   ', '\t\n', '???', '！！！', '---===***', '@#$%^&*()', '问', 'a']) {
      expect(collectNeedInfo(raw)).toEqual([]);
      expect(detectMissingSlots(raw)).toEqual([]);
    }
  });
});

describe('T18·FIELD_REGISTRY 对齐、契约投影与纯函数约束', () => {
  it('每条追问涉及的槽位名与示例均严格来自 FIELD_REGISTRY（杜绝自造词）', () => {
    const slots = detectMissingSlots('该用什么沥青');
    expect(slots).toHaveLength(CLARIFY_SLOT_KEYS.length);

    for (const slot of slots) {
      expect(NeedInfoSlotSchema.safeParse(slot).success).toBe(true);
      const def = FIELD_REGISTRY[slot.key];
      expect(def, `槽位 ${slot.key} 必须在 FIELD_REGISTRY 中登记`).toBeDefined();
      expect(slot.label).toContain(def.label);
      if (slot.example) {
        const optionLabels = (def.options ?? []).map((o) => o.label);
        expect(optionLabels).toContain(slot.example);
      }
    }

    const hints = collectNeedInfo('该用什么沥青');
    expect(hints).toEqual(needInfoFromSlots(slots));
    for (const hint of hints) {
      expect(REGISTRY_LABELS.some((label) => hint.includes(label))).toBe(true);
    }
  });

  it('FIELD_REGISTRY 选项中的英文 slug（如 water-damage / channelized）可直接识别', () => {
    expect(collectNeedInfo('华南高温区 channelized water-damage 推荐什么混合料')).toEqual([]);
    expect(collectNeedInfo('华南高温区 channelized water damage 推荐什么混合料')).toEqual([]);
  });

  it('确定性可复现：相同输入多次调用输出完全一致', () => {
    const q = '推荐一种改性沥青方案';
    expect(collectNeedInfo(q)).toEqual(collectNeedInfo(q));
    expect(detectMissingSlots(q)).toEqual(detectMissingSlots(q));
  });

  it('纯函数静态断言：不引用网络 / DB / fs / LLM 客户端，单次执行 < 1ms', () => {
    const src = readFileSync(new URL('../src/qa/clarify.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from ['"](?:node:)?(?:fs(?:\/promises)?|http|https|net|dns)['"]/);
    expect(src).not.toMatch(/from ['"]\.\.\/llm\/client['"]/);
    expect(src).not.toMatch(/\b(?:fetch|require)\s*\(|import\s*\(/);
    expect(src).not.toMatch(/sqlite|lancedb|vectordb|process\.env|Date\.now|Math\.random/i);

    const sample = '该用什么沥青';
    for (let i = 0; i < 50; i += 1) collectNeedInfo(sample);
    const start = performance.now();
    for (let i = 0; i < 1000; i += 1) collectNeedInfo(sample);
    expect((performance.now() - start) / 1000).toBeLessThan(1);
  });
});
