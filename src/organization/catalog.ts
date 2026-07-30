import {
  relationshipStateMcpModuleId,
  scheduleMcpModuleId,
  subagentMcpModuleId,
  tavilySearchMcpModuleId,
  visionMcpModuleId,
  webReaderMcpModuleId,
  worldStateMcpModuleId,
} from "../modules/catalog.js";
import type {
  CharacterCapabilityDefinition,
  CharacterCapabilityId,
} from "./types.js";

export const characterCapabilityCatalog = [
  {
    id: "research.web",
    label: "网页研究",
    description: "检索公开来源、阅读网页并整理可追溯资料。",
    recommendedModuleIds: [tavilySearchMcpModuleId, webReaderMcpModuleId],
  },
  {
    id: "research.analysis",
    label: "研究分析",
    description: "比较证据、识别矛盾并形成结构化结论。",
    recommendedModuleIds: [],
  },
  {
    id: "software.debug",
    label: "软件调试",
    description: "定位故障、构造复现并验证修复方向。",
    recommendedModuleIds: [],
  },
  {
    id: "software.implementation",
    label: "软件实现",
    description: "实现、测试并交付边界明确的软件变更。",
    recommendedModuleIds: [],
  },
  {
    id: "planning.schedule",
    label: "日程规划",
    description: "把目标转成可执行的时间安排与跟进计划。",
    recommendedModuleIds: [scheduleMcpModuleId],
  },
  {
    id: "organization.coordination",
    label: "组织协调",
    description: "拆分任务、选择协作者并整合交付结果。",
    recommendedModuleIds: [worldStateMcpModuleId, subagentMcpModuleId],
  },
  {
    id: "communication.social",
    label: "沟通协商",
    description: "处理人际沟通、协调分歧与关系敏感表达。",
    recommendedModuleIds: [worldStateMcpModuleId, relationshipStateMcpModuleId],
  },
  {
    id: "creative.writing",
    label: "创意写作",
    description: "创作、改写和打磨叙事、对白与文案。",
    recommendedModuleIds: [],
  },
  {
    id: "creative.visual",
    label: "视觉创意",
    description: "理解图片并提出视觉构思、构图和风格方案。",
    recommendedModuleIds: [visionMcpModuleId],
  },
  {
    id: "world.knowledge",
    label: "世界知识",
    description: "理解共享世界中的地点、事件、人物与既定事实。",
    recommendedModuleIds: [worldStateMcpModuleId],
  },
] satisfies CharacterCapabilityDefinition[];

const catalogById = new Map<CharacterCapabilityId, CharacterCapabilityDefinition>(
  characterCapabilityCatalog.map((entry) => [entry.id, entry]),
);

export function characterCapabilityDefinition(
  capabilityId: CharacterCapabilityId,
): CharacterCapabilityDefinition {
  return catalogById.get(capabilityId)!;
}

