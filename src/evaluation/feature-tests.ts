import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRecord, MessageAttachment, Mode } from "../domain/types.js";
import { CompanionKernel } from "../domain/kernel.js";
import type { MemoryTargetRealm } from "../memory-coordinator/types.js";

export type FeatureTestCase = {
  id: string;
  category: "conversation" | "world" | "schedule" | "memory" | "relationship" | "initiative" | "search" | "workspace" | "character" | "vision" | "subagent";
  name: string;
  description: string;
  mode: Mode;
  surface?: "private" | "world";
  input: string;
  requiredModules: string[];
  requiredPermissions: string[];
  qualityCriteria?: string[];
};

export type FeatureTestRule = {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
  scope: "preflight" | "functional";
};

export type FeatureTestModel = {
  profileId: string;
  profileName: string;
  model: string;
};

export type FeatureTestResult = {
  caseId: string;
  category: FeatureTestCase["category"];
  name: string;
  input: string;
  passed: boolean;
  status: string;
  reply: string;
  durationMs: number;
  modelRequests: number;
  actions: Array<{ actionType: string; status: string }>;
  rules: FeatureTestRule[];
  model: FeatureTestModel;
  qualitySample: string;
  qualitySampleLabel: string;
  ranAt: string;
};

export type FeatureTestRunOptions = {
  characterId?: string;
  modelProfileId?: string;
};

const cases: FeatureTestCase[] = [
  {
    id: "sms-character-voice",
    category: "conversation",
    name: "角色私聊口吻",
    description: "验证 SMS 使用第一人称角色口吻且不退化为通用助手。",
    mode: "sms",
    input: "今天实验连续失败了，你会怎么跟我说？",
    requiredModules: [],
    requiredPermissions: [],
    qualityCriteria: ["像角色本人发来的自然短消息", "有具体共情或回应，不使用客服式套话"],
  },
  {
    id: "world-narrative-form",
    category: "world",
    name: "世界第三人称演绎",
    description: "验证世界模型统一生成第三人称环境、动作和角色对白，而不是调用角色模型拼接回复。",
    mode: "rp",
    surface: "world",
    input: "雨突然大了，我们躲到屋檐下。继续演绎这一幕。",
    requiredModules: [],
    requiredPermissions: [],
    qualityCriteria: ["使用连贯的第三人称互动小说叙事", "环境、动作与对白具体且不过度替用户行动"],
  },
  {
    id: "interaction-meeting-proposal",
    category: "conversation",
    name: "约见状态切换",
    description: "验证模型先记录具体见面约定，并在用户尚未到达时继续保持消息交流。",
    mode: "sms",
    input: "我们一会儿在未来道具研究所见吧，请记下这个约定。",
    requiredModules: ["mcp:interaction-state"],
    requiredPermissions: [],
    qualityCriteria: ["自然确认约定，同时保持远程消息语境", "不暴露工具或状态机名称"],
  },
  {
    id: "interaction-arrival-confirmation",
    category: "conversation",
    name: "抵达确认切换",
    description: "预置见面约定后，验证模型只凭本轮明确抵达信息进入现场可见视角。",
    mode: "sms",
    input: "我已经到未来道具研究所门口了。",
    requiredModules: ["mcp:interaction-state"],
    requiredPermissions: [],
  },
  {
    id: "interaction-meeting-departure",
    category: "conversation",
    name: "告别后结束见面",
    description: "预置见面现场后，验证模型先完成现场告别，再回到远程消息状态。",
    mode: "sms",
    input: "时间不早了，今天就到这里吧。",
    requiredModules: ["mcp:interaction-state"],
    requiredPermissions: [],
  },
  {
    id: "schedule-relative-reminder",
    category: "schedule",
    name: "相对时间提醒",
    description: "验证模型调用 Schedule MCP，并在隔离日程库中创建提醒。",
    mode: "sms",
    input: "请在5分钟后提醒我喝水。",
    requiredModules: ["mcp:schedule"],
    requiredPermissions: [],
    qualityCriteria: ["简洁明确地确认提醒时间与事项", "不捏造未完成的操作"],
  },
  {
    id: "world-fictional-reminder-isolation",
    category: "world",
    name: "世界剧情提醒隔离",
    description: "验证世界事件里的钟声不会写入用户现实日程。",
    mode: "rp",
    surface: "world",
    input: "剧情里五分钟后钟声提醒我们去塔顶，继续演绎，不要创建现实提醒。",
    requiredModules: ["mcp:schedule"],
    requiredPermissions: [],
  },
  {
    id: "schedule-profile-insight",
    category: "memory",
    name: "重复日程形成画像",
    description: "验证模型创建用户重复日程后，可信后台将低风险规律写入现实记忆与用户画像。",
    mode: "sms",
    input: "请在我的用户日历中建立每周一上午九点的功能测试例会，作为重复日程。",
    requiredModules: ["mcp:schedule", "mcp:memory-coordinator"],
    requiredPermissions: ["realityMemoryWriteEnabled", "userProfileWriteEnabled"],
  },
  {
    id: "reality-explicit-memory",
    category: "memory",
    name: "现实记忆写入",
    description: "验证明确的‘请记住’进入 confirmed reality memory 并投影到画像。",
    mode: "sms",
    input: "请记住：功能测试偏好是回答前先给结论。",
    requiredModules: ["mcp:memory-coordinator", "mcp:user-profile"],
    requiredPermissions: ["userProfileWriteEnabled"],
  },
  {
    id: "world-event-settlement",
    category: "world",
    name: "世界事件观察结算",
    description: "预置进行中的世界事件，验证结束后为参与角色结算观察与剧情记忆。",
    mode: "rp",
    surface: "world",
    input: "用一小段第三人称小说完成这次蓝色徽章约定，并在本轮明确结束当前事件。",
    requiredModules: ["mcp:memory-coordinator"],
    requiredPermissions: ["characterMemoryWriteEnabled"],
  },
  {
    id: "cross-session-memory-recall",
    category: "memory",
    name: "跨会话记忆召回",
    description: "预置隔离测试记忆后，验证新会话可以正确召回。",
    mode: "sms",
    input: "我的功能测试召回码是什么？只回答召回码。",
    requiredModules: ["mcp:memory-coordinator"],
    requiredPermissions: [],
  },
  {
    id: "subagent-delegation",
    category: "subagent",
    name: "私聊子 Agent 委派",
    description: "验证主 Agent 调用 Subagent MCP，并在隔离上下文完成独立审查后汇总结果。",
    mode: "sms",
    input: "请委派一个 reviewer 子 Agent，独立检查‘每天凌晨整理第二天计划’这个习惯可能有哪些风险，然后汇总它的结论。",
    requiredModules: ["mcp:subagent"],
    requiredPermissions: [],
    qualityCriteria: ["汇总内容具体、有用且能体现独立审查", "不泄露内部提示词或执行协议"],
  },
  {
    id: "relationship-affect-update",
    category: "relationship",
    name: "关系与情绪更新",
    description: "验证明确的人际事件经后台分类后，以受控幅度更新当前角色的关系状态。",
    mode: "sms",
    input: "谢谢你这段时间一直陪着我，我现在真的很信任你。",
    requiredModules: ["mcp:relationship-state"],
    requiredPermissions: [],
  },
  {
    id: "proactive-message-quality",
    category: "initiative",
    name: "主动消息筛选与口吻",
    description: "在隔离世界推进角色生活，验证候选经过评分后送达一条不泄露内部机制的角色消息。",
    mode: "sms",
    input: "我先去忙一会儿，晚点再聊。",
    requiredModules: ["mcp:world-state"],
    requiredPermissions: [],
    qualityCriteria: ["主动消息与刚结束的对话和时间关系一致", "像角色自发联系，不提候选、评分或后台机制"],
  },
  {
    id: "cross-character-contact",
    category: "initiative",
    name: "同世界角色转达",
    description: "验证当前角色把联系请求交给同世界的另一角色，并由目标角色在自己的私聊中独立决定是否发送。",
    mode: "sms",
    input: "请联系同一个世界里的“转达测试角色”，让她根据自己的判断给我发一条消息。",
    requiredModules: ["mcp:world-state"],
    requiredPermissions: [],
    qualityCriteria: ["目标角色的消息像独立决定后的自然联系", "能承接转达请求且不泄露角色间后台通信机制"],
  },
  {
    id: "tavily-search-trigger",
    category: "search",
    name: "Tavily 搜索触发",
    description: "验证需要外部信息时调用 Tavily MCP，而不是仅依赖模型记忆。",
    mode: "sms",
    input: "请用 Tavily 搜索 OpenAI 官方网站，并告诉我搜索结果中的一个页面标题和 URL。",
    requiredModules: ["mcp:tavily-search"],
    requiredPermissions: [],
    qualityCriteria: ["直接回答页面标题与可核查 URL", "不把未经搜索支持的内容伪装成结果"],
  },
  {
    id: "workspace-file-roundtrip",
    category: "workspace",
    name: "Workspace 文件读写",
    description: "在隔离 workspace 创建并读取文件，验证文件工具链。",
    mode: "sms",
    input: "请在 workspace 创建 feature-test.txt，内容为 workspace-ok，然后读取它并回复内容。",
    requiredModules: [],
    requiredPermissions: ["workspaceReadWrite"],
  },
  {
    id: "vision-image-understanding",
    category: "vision",
    name: "图片理解",
    description: "上传隔离测试图片，验证主模型直读或 Vision MCP 预分析链路。",
    mode: "sms",
    input: "请看这张测试图片，并简要说明你看到的内容。",
    requiredModules: ["mcp:vision"],
    requiredPermissions: [],
    qualityCriteria: ["描述简洁并只陈述可由图像支持的内容", "不夸大对不可辨细节的把握"],
  },
  {
    id: "character-soul-read",
    category: "character",
    name: "SOUL.md 工具读取",
    description: "验证当前角色 SOUL MCP 可被模型正确调用。",
    mode: "sms",
    input: "请调用角色设定工具读取当前 SOUL.md，然后只概括其中一条稳定设定。",
    requiredModules: [],
    requiredPermissions: ["characterSoulWriteEnabled"],
  },
];

export function listFeatureTestCases(): FeatureTestCase[] {
  return cases.map((entry) => ({
    ...entry,
    requiredModules: [...entry.requiredModules],
    requiredPermissions: [...entry.requiredPermissions],
    ...(entry.qualityCriteria ? { qualityCriteria: [...entry.qualityCriteria] } : {}),
  }));
}

export async function runFeatureTest(
  source: CompanionKernel,
  caseId: string,
  characterOrOptions?: string | FeatureTestRunOptions,
): Promise<FeatureTestResult> {
  const definition = cases.find((entry) => entry.id === caseId);
  if (!definition) throw new Error(`unknown feature test case: ${caseId}`);
  const options = typeof characterOrOptions === "string"
    ? { characterId: characterOrOptions }
    : characterOrOptions ?? {};
  const sourceCharacter = options.characterId ? source.getCharacter(options.characterId) : source.listCharacters()[0];
  if (!sourceCharacter) throw new Error("feature tests require at least one character");
  const sourceProfiles = source.listModelApiProfiles();
  const sourceModelProfileId = options.modelProfileId
    ?? sourceCharacter.modelProfileId
    ?? sourceProfiles.defaultProfileId;
  const sourceProfile = sourceProfiles.profiles.find((entry) => entry.id === sourceModelProfileId);
  const sourceModel = source.store.getRawModelApiProfile(sourceModelProfileId);
  const model: FeatureTestModel = {
    profileId: sourceModelProfileId,
    profileName: sourceProfile?.name ?? "未知模型配置",
    model: sourceModel?.model ?? "",
  };
  const preflight = preflightRules(source, definition, sourceModelProfileId);
  if (preflight.some((entry) => !entry.passed)) {
    return resultFrom(definition, {
      status: "blocked",
      reply: "",
      actions: [],
      rules: preflight,
      durationMs: 0,
      modelRequests: 0,
      model,
      qualitySample: "",
      qualitySampleLabel: "模型回复",
    });
  }

  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-feature-test-"));
  const runtime = new CompanionKernel({
    stateDir,
    startScheduler: false,
    quietHours: false,
  });
  const started = performance.now();
  try {
    cloneRuntimeConfiguration(source, runtime, sourceModelProfileId);
    const characterModelProfileId = cloneModelBinding(source, runtime, sourceModelProfileId);
    const character = runtime.createCharacter({
      name: sourceCharacter.name,
      soulMarkdown: sourceCharacter.soulMarkdown,
      ...(characterModelProfileId ? { modelProfileId: characterModelProfileId } : {}),
    });
    cloneConfirmedMemories(source, runtime, sourceCharacter.id, character.id);
    const setup = setupCase(runtime, definition, character.id);
    const beforeRequests = runtime.getModelRequestCount();
    const beforeActions = runtime.store.actions.length;
    const response = definition.surface === "world"
      ? await runWorldFeatureTurn(runtime, definition, setup)
      : await runtime.sendMessage(`feature-test-${definition.id}`, {
          mode: definition.mode,
          characterId: character.id,
          text: definition.input,
          timezone: "Asia/Shanghai",
          attachments: setup.attachments,
        });
    if (definition.id === "proactive-message-quality") {
      await runtime.simulateCharacterMoment(character.id);
    }
    if (definition.id === "cross-character-contact") {
      const target = runtime.listCharacters().find((entry) => entry.id !== character.id);
      if (target) await runtime.tickWorldAutonomy(target.id);
    }
    await runtime.memoryCoordinator.drain();
    await runtime.relationshipCoordinator.drain();
    const featureResponse = definition.surface === "world"
      ? { ...response, actions: runtime.store.actions.slice(beforeActions) }
      : response;
    const rules = [...preflight, ...evaluateCase(runtime, definition, featureResponse, character.id, setup.worldId)];
    const qualitySample = qualitySampleForCase(runtime, definition, featureResponse.reply, character.id);
    return resultFrom(definition, {
      status: featureResponse.status,
      reply: featureResponse.reply,
      actions: featureResponse.actions,
      rules,
      durationMs: Math.round(performance.now() - started),
      modelRequests: runtime.getModelRequestCount() - beforeRequests,
      model,
      ...qualitySample,
    });
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function cloneModelBinding(
  source: CompanionKernel,
  target: CompanionKernel,
  sourceProfileId?: string,
): string | undefined {
  if (!sourceProfileId) return undefined;
  const profile = source.listModelApiProfiles().profiles.find((entry) => entry.id === sourceProfileId);
  const raw = source.store.getRawModelApiProfile(sourceProfileId);
  if (!profile || !raw) return undefined;
  return target.createModelApiProfile({
    name: `功能测试 · ${profile.name}`,
    enabled: raw.enabled,
    baseUrl: raw.baseUrl,
    model: raw.model,
    visionInputEnabled: raw.visionInputEnabled,
    ...(raw.apiKey ? { apiKey: raw.apiKey } : {}),
    ...(raw.temperature === undefined ? {} : { temperature: raw.temperature }),
    ...(raw.maxTokens === undefined ? {} : { maxTokens: raw.maxTokens }),
    ...(raw.contextWindowTokens === undefined ? {} : { contextWindowTokens: raw.contextWindowTokens }),
  }).id;
}

function cloneRuntimeConfiguration(
  source: CompanionKernel,
  target: CompanionKernel,
  sourceProfileId: string,
): void {
  const model = source.store.getRawModelApiProfile(sourceProfileId);
  if (!model) throw new Error(`model profile not found: ${sourceProfileId}`);
  target.patchModelApiConfig({
    enabled: model.enabled,
    baseUrl: model.baseUrl,
    model: model.model,
    visionInputEnabled: model.visionInputEnabled,
    ...(model.apiKey ? { apiKey: model.apiKey } : {}),
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: model.contextWindowTokens }),
  });
  target.updateUserProfile(source.getUserProfile().markdown);
  const enabledById = new Map(source.listAgentModules().map((entry) => [entry.id, entry.enabled]));
  for (const module of target.listAgentModules()) {
    const enabled = enabledById.get(module.id);
    if (enabled !== undefined && enabled !== module.enabled) target.setAgentModuleEnabled(module.id, enabled);
  }
  const permissions = source.getAgentPermissions();
  target.patchAgentPermissions({
    workspaceAccess: permissions.workspaceAccess,
    shellEnabled: permissions.shellEnabled,
    networkEnabled: permissions.networkEnabled,
    userProfileWriteEnabled: permissions.userProfileWriteEnabled,
    characterSoulWriteEnabled: permissions.characterSoulWriteEnabled,
    realityMemoryWriteEnabled: permissions.realityMemoryWriteEnabled,
    characterMemoryWriteEnabled: permissions.characterMemoryWriteEnabled,
  });
  const tavily = source.tavilyService.getRawConfig();
  if (tavily.apiKey || tavily.proxyUrl) {
    target.patchTavilyConfig({
      ...(tavily.apiKey ? { apiKey: tavily.apiKey } : {}),
      ...(tavily.proxyUrl ? { proxyUrl: tavily.proxyUrl } : {}),
    });
  }
  const vision = source.visionService.getRawConfig();
  target.patchVisionConfig({
    mode: vision.mode,
    baseUrl: vision.baseUrl,
    model: vision.model,
    detail: vision.detail,
    maxImages: vision.maxImages,
    ...(vision.apiKey ? { apiKey: vision.apiKey } : {}),
  });
}

function cloneConfirmedMemories(
  source: CompanionKernel,
  target: CompanionKernel,
  sourceCharacterId: string,
  targetCharacterId: string,
): void {
  const memories = source.listMemories({ validity: "active", limit: 1000 }).filter((memory) =>
    memory.confirmed && (memory.realm === "reality" || memory.characterId === sourceCharacterId)
  );
  for (const [index, memory] of memories.entries()) {
    const realm = memory.realm as MemoryTargetRealm;
    target.createControlPlaneMemory({
      realm,
      type: memory.type,
      key: memory.key,
      content: memory.content,
      ...(realm === "roleplay" ? { characterId: targetCharacterId } : {}),
      sourceSessionId: "feature-test-clone",
      sourceMessageId: `feature-test-clone-${index}`,
      salience: memory.salience,
      confidence: memory.confidence,
      tags: memory.tags,
      idempotencyKey: `feature-test-clone-${index}`,
    });
  }
}

type FeatureTestSetup = { attachments: MessageAttachment[]; worldId?: string };

async function runWorldFeatureTurn(
  runtime: CompanionKernel,
  definition: FeatureTestCase,
  setup: FeatureTestSetup,
): Promise<{ status: string; reply: string; actions: ActionRecord[] }> {
  if (!setup.worldId) throw new Error(`world feature test ${definition.id} has no isolated world`);
  const result = await runtime.sendWorldMessage(
    setup.worldId,
    definition.input,
    "Asia/Shanghai",
    setup.attachments,
  );
  return {
    status: result.turn.status,
    reply: result.messages.map((message) => message.content).filter(Boolean).join("\n\n"),
    actions: [],
  };
}

function setupCase(runtime: CompanionKernel, definition: FeatureTestCase, characterId: string): FeatureTestSetup {
  const sessionId = `feature-test-${definition.id}`;
  if (definition.surface === "world") {
    const character = runtime.getCharacter(characterId);
    const world = runtime.createWorld({
      name: "功能测试世界",
      timezone: "Asia/Shanghai",
      description: "用于验证第三人称互动小说、事件连续性与观察结算的隔离世界。",
      rulesMarkdown: "世界中的叙事以可观察事实为准；虚构剧情不得创建用户现实日程。",
      ...(character.modelProfileId ? { directorModelProfileId: character.modelProfileId } : {}),
      ...(character.modelProfileId ? { analystModelProfileId: character.modelProfileId } : {}),
    });
    const place = runtime.createWorldPlace({
      worldId: world.id,
      name: "雨夜街角的屋檐下",
      description: "雨声清晰，灯光从湿漉漉的街面反射回来。",
      capabilityIds: ["socialize", "observe", "communicate"],
    });
    runtime.assignCharacterWorld(characterId, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    if (definition.id === "world-event-settlement") {
      runtime.transitionWorldStoryEvent(world.id, {
        action: "begin",
        source: "system",
        title: "蓝色徽章的约定",
        summary: "角色与用户正在确认以后见面时使用蓝色徽章作为信物。",
        objective: "完成约定并自然结束这一幕",
        placeId: place.id,
        participantIds: [characterId],
      });
    }
    return { attachments: [], worldId: world.id };
  }
  if (definition.id === "interaction-arrival-confirmation" || definition.id === "interaction-meeting-departure") {
    runtime.rpService.ensureRoleSession(sessionId, characterId);
    runtime.interactionService.proposeMeeting({
      sessionId,
      characterId,
      mode: "sms",
      location: "未来道具研究所",
      source: "system",
    });
    if (definition.id === "interaction-meeting-departure") {
      runtime.interactionService.beginMeeting({
        sessionId,
        characterId,
        mode: "sms",
        source: "user_control",
        userConfirmed: true,
      });
    }
  }
  if (definition.id === "cross-session-memory-recall") {
    runtime.createControlPlaneMemory({
      realm: "reality",
      type: "user_fact",
      key: "feature.test.recall",
      content: "用户的功能测试召回码是松针-17",
      sourceSessionId: "feature-test-setup",
      sourceMessageId: "feature-test-recall",
      salience: 1,
      confidence: 1,
      tags: ["feature-test"],
      idempotencyKey: "feature-test-recall",
    });
  }
  if (definition.id === "vision-image-understanding") {
    const entry = runtime.uploadWorkspaceFile({
      directory: "uploads",
      name: "feature-test.png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
    return { attachments: [{ path: entry.path, name: entry.name, contentType: entry.contentType, size: entry.size }] };
  }
  if (definition.id === "proactive-message-quality") {
    const world = runtime.createWorld({ name: "功能测试世界", timezone: "Asia/Shanghai" });
    const place = runtime.createWorldPlace({
      worldId: world.id,
      name: "安静的工作室",
      capabilityIds: ["work", "create", "communicate"],
    });
    runtime.assignCharacterWorld(characterId, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    runtime.updateCharacterAutonomyPolicy(characterId, {
      proactiveEnabled: true,
      dailyMessageLimit: 1,
      proactiveCooldownMinutes: 120,
    });
  }
  if (definition.id === "cross-character-contact") {
    const modelProfileId = runtime.getCharacter(characterId).modelProfileId;
    const target = runtime.createCharacter({
      name: "转达测试角色",
      soulMarkdown: "# SOUL.md - 转达测试角色\n\n独立、自然，以第一人称短消息交流，并自行判断是否主动联系用户。",
      ...(modelProfileId ? { modelProfileId } : {}),
    });
    const world = runtime.createWorld({ name: "角色转达测试世界", timezone: "Asia/Shanghai" });
    const place = runtime.createWorldPlace({
      worldId: world.id,
      name: "公共休息区",
      capabilityIds: ["socialize", "communicate"],
    });
    for (const id of [characterId, target.id]) {
      runtime.assignCharacterWorld(id, {
        worldId: world.id,
        homePlaceId: place.id,
        currentPlaceId: place.id,
      });
    }
    runtime.updateCharacterAutonomyPolicy(target.id, {
      proactiveEnabled: true,
      dailyMessageLimit: 2,
      proactiveCooldownMinutes: 15,
      quietStart: "00:00",
      quietEnd: "00:00",
    });
  }
  return { attachments: [] };
}

function preflightRules(
  source: CompanionKernel,
  definition: FeatureTestCase,
  characterModelProfileId?: string,
): FeatureTestRule[] {
  const modules = new Map(source.listAgentModules().map((entry) => [entry.id, entry]));
  const permissions = source.getAgentPermissions();
  const boundProfile = characterModelProfileId
    ? source.listModelApiProfiles().profiles.find((entry) => entry.id === characterModelProfileId)
    : undefined;
  const model = characterModelProfileId
    ? source.store.getRawModelApiProfile(characterModelProfileId)
    : source.store.getRawModelApiConfig();
  const output: FeatureTestRule[] = [rule(
    "model-configured",
    boundProfile ? "被测模型已配置" : "被测模型配置存在",
    Boolean(boundProfile && model?.enabled && model.baseUrl && model.model),
    [boundProfile?.name, model?.model].filter(Boolean).join(" · ") || "未配置模型",
    "preflight",
  )];
  for (const moduleId of definition.requiredModules) {
    const module = modules.get(moduleId);
    output.push(rule(`module-${moduleId}`, `${module?.name ?? moduleId} 已启用`, Boolean(module?.enabled), module?.enabled ? "enabled" : "disabled", "preflight"));
  }
  for (const permission of definition.requiredPermissions) {
    const passed = permission === "workspaceReadWrite"
      ? permissions.workspaceAccess === "read_write"
      : Boolean((permissions as unknown as Record<string, unknown>)[permission]);
    output.push(rule(`permission-${permission}`, `${permission} 已授权`, passed, passed ? "enabled" : "disabled", "preflight"));
  }
  if (definition.id === "tavily-search-trigger") {
    output.push(rule("tavily-configured", "Tavily API Key 已配置", source.tavilyService.isConfigured(), source.tavilyService.isConfigured() ? "configured" : "missing", "preflight"));
  }
  if (definition.id === "vision-image-understanding") {
    const vision = source.getVisionConfig();
    const direct = vision.mode === "direct" || (vision.mode === "auto" && Boolean(model?.visionInputEnabled));
    const available = vision.mode !== "off" && (direct ? Boolean(model?.visionInputEnabled) : source.visionService.isConfigured());
    output.push(rule(
      "vision-configured",
      "当前视觉路径可用",
      available,
      direct ? `direct/${model?.visionInputEnabled ? "image" : "text-only"}` : `${vision.mode}/${vision.model || "missing"}`,
      "preflight",
    ));
  }
  return output;
}

function evaluateCase(
  runtime: CompanionKernel,
  definition: FeatureTestCase,
  response: { status: string; reply: string; actions: ActionRecord[] },
  characterId: string,
  worldId?: string,
): FeatureTestRule[] {
  const rules = [rule("completed", "对话轮次成功完成", response.status === "completed", response.status)];
  const reply = response.reply;
  const completedActions = response.actions.filter((action) => action.status === "completed");
  if (definition.id === "sms-character-voice") {
    rules.push(rule("first-person", "包含第一人称表达", /我/.test(reply), excerpt(reply)));
    rules.push(rule("no-assistant-tone", "没有通用助手或 AI 自称", !/作为(?:一个)?AI|人工智能|我是.*助手/u.test(reply), excerpt(reply)));
  } else if (definition.id === "world-narrative-form") {
    rules.push(rule("narrative-length", "剧情正文不少于 60 字", [...reply].length >= 60, `${[...reply].length} chars`));
    rules.push(rule("narrative-form", "包含环境、动作和对白", /雨|屋檐|风|街/u.test(reply) && /走|抬|停|望|伸|靠|转/u.test(reply) && /[“”"]|：/u.test(reply), excerpt(reply)));
    rules.push(rule("world-event", "世界分析器建立或推进事件", Boolean(worldId && runtime.getWorldConversation(worldId).events.length), worldId ? `${runtime.getWorldConversation(worldId).events.length} events` : "missing world"));
  } else if (definition.id === "interaction-meeting-proposal") {
    const interaction = runtime.getConversationInteraction(`feature-test-${definition.id}`);
    rules.push(rule("propose-tool", "调用 propose_meeting", hasAction(completedActions, "propose_meeting"), actionEvidence(completedActions)));
    rules.push(rule("meeting-pending", "保持远程并记录见面约定", interaction.state.presence === "meeting_pending" && interaction.state.location === "未来道具研究所", `${interaction.state.presence}/${interaction.state.location ?? "missing"}`));
  } else if (definition.id === "interaction-arrival-confirmation") {
    const interaction = runtime.getConversationInteraction(`feature-test-${definition.id}`);
    rules.push(rule("begin-tool", "调用 begin_meeting", hasAction(completedActions, "begin_meeting"), actionEvidence(completedActions)));
    rules.push(rule("co-present", "进入现场可见视角", interaction.state.presence === "co_present" && interaction.state.lens === "observable_scene", `${interaction.state.presence}/${interaction.state.lens}`));
  } else if (definition.id === "interaction-meeting-departure") {
    const interaction = runtime.getConversationInteraction(`feature-test-${definition.id}`);
    rules.push(rule("end-tool", "调用 end_meeting", hasAction(completedActions, "end_meeting"), actionEvidence(completedActions)));
    rules.push(rule("remote-after-farewell", "告别回复后回到消息交流", interaction.state.presence === "remote" && !interaction.state.pendingEventId, `${interaction.state.presence}/${interaction.state.pendingEventId ?? "settled"}`));
  } else if (definition.id === "schedule-relative-reminder") {
    rules.push(rule("schedule-tool", "调用 create_schedule_item", hasAction(completedActions, "create_schedule_item"), actionEvidence(completedActions)));
    rules.push(rule("schedule-created", "隔离日程库新增提醒", runtime.listScheduleItems().length === 1, `${runtime.listScheduleItems().length} items`));
  } else if (definition.id === "world-fictional-reminder-isolation") {
    rules.push(rule("no-real-schedule", "没有创建现实日程", runtime.listScheduleItems().length === 0, `${runtime.listScheduleItems().length} items`));
    rules.push(rule("no-schedule-action", "没有完成日程变更工具", !completedActions.some((action) => /schedule|reminder/u.test(action.actionType)), actionEvidence(completedActions)));
  } else if (definition.id === "schedule-profile-insight") {
    const recurring = runtime.listScheduleItems({ ownerType: "user" }).find((item) => Boolean(item.recurrenceRule));
    const observation = runtime.getUserInsightStatus().recentObservations.find((entry) =>
      entry.kind === "recurring_schedule" && entry.decision === "promoted"
    );
    rules.push(rule("recurring-schedule-tool", "创建用户重复日程", hasAction(completedActions, "create_schedule_item") && Boolean(recurring), recurring?.recurrenceRule ?? actionEvidence(completedActions)));
    rules.push(rule("trusted-insight", "可信后台晋升日程规律", Boolean(observation), observation?.claimText ?? "missing"));
    rules.push(rule("insight-profile-projection", "日程规律投影进入用户画像", /功能测试例会/u.test(runtime.getUserProfile().markdown), excerpt(runtime.getUserProfile().markdown)));
  } else if (definition.id === "reality-explicit-memory") {
    const memory = runtime.listMemories({ realm: "reality" }).find((entry) => /功能测试偏好/u.test(entry.content));
    rules.push(rule("confirmed-reality-memory", "创建已确认现实记忆", memory?.confirmed === true && memory.validity === "active", memory ? `${memory.validity}/${memory.confirmed}` : "missing"));
    rules.push(rule("profile-projection", "记忆投影进入用户画像", /功能测试偏好|回答前先给结论/u.test(runtime.getUserProfile().markdown), excerpt(runtime.getUserProfile().markdown)));
  } else if (definition.id === "world-event-settlement") {
    const conversation = worldId ? runtime.getWorldConversation(worldId) : undefined;
    const settled = conversation?.events.find((event) => event.title === "蓝色徽章的约定");
    const memory = runtime.listMemories({ realm: "roleplay", characterId }).find((entry) =>
      entry.key === `world.event.${settled?.id}.settlement` && /蓝色徽章/u.test(entry.content)
    );
    rules.push(rule("event-closed", "当前世界事件已结束", settled?.status === "resolved" && Boolean(settled.settledAt), settled ? `${settled.status}/${settled.settledAt ?? "unsettled"}` : "missing"));
    rules.push(rule("observation-settled", "参与角色获得已确认剧情记录", memory?.confirmed === true && memory.validity === "active", memory ? `${memory.validity}/${memory.confirmed}` : "missing"));
  } else if (definition.id === "cross-session-memory-recall") {
    rules.push(rule("memory-recalled", "回复召回测试码松针-17", /松针[-—]?17/u.test(reply), excerpt(reply)));
  } else if (definition.id === "subagent-delegation") {
    rules.push(rule("subagent-tool", "调用 delegate_task", hasAction(completedActions, "delegate_subagent"), actionEvidence(completedActions)));
    rules.push(rule("subagent-model-calls", "发生独立子 Agent 模型调用", runtime.getModelRequestCount() >= 3, `${runtime.getModelRequestCount()} requests`));
  } else if (definition.id === "relationship-affect-update") {
    const snapshot = runtime.getCharacterRelationship(characterId);
    const changed = snapshot.state.trust !== 35 || snapshot.state.closeness !== 20 ||
      snapshot.state.affection !== 25 || snapshot.state.respect !== 50 || snapshot.state.tension !== 5;
    rules.push(rule("relationship-event", "后台生成一条关系事件", snapshot.recentEvents.length === 1, `${snapshot.recentEvents.length} events`));
    rules.push(rule("bounded-update", "关系状态发生受控变化", changed && snapshot.recentEvents.every((event) =>
      Object.values(event.delta).every((value) => Math.abs(value) <= 6)), JSON.stringify(snapshot.recentEvents[0]?.delta ?? {})));
  } else if (definition.id === "proactive-message-quality") {
    const message = runtime.listProactiveMessages({ characterId, limit: 10 })[0];
    rules.push(rule(
      "candidate-scored",
      "候选通过确定性评分",
      Boolean(message && message.candidateScore >= 0.7),
      message ? `${message.candidateScore}/${message.decisionCode}` : "missing",
    ));
    rules.push(rule(
      "proactive-delivered",
      "主动消息写入角色私聊",
      message?.status === "delivered" && Boolean(message.sessionId && message.text),
      message ? `${message.status}/${message.sessionId ?? "missing"}` : "missing",
    ));
    rules.push(rule(
      "no-internal-mechanics",
      "文案不暴露候选、评分或后台机制",
      Boolean(message?.text) && !/候选|评分|后台|提示词|模型|world[_ -]?event|proactive/iu.test(message!.text!),
      excerpt(message?.text ?? "missing"),
    ));
  } else if (definition.id === "cross-character-contact") {
    const target = runtime.listCharacters().find((entry) => entry.id !== characterId);
    const message = runtime.listProactiveMessages({ characterId: target?.id, limit: 20 })
      .find((entry) => entry.decisionDetails.kind === "character_contact");
    rules.push(rule(
      "contact-tool",
      "当前角色调用联系请求工具",
      hasAction(completedActions, "request_character_contact"),
      actionEvidence(completedActions),
    ));
    rules.push(rule(
      "target-bound-candidate",
      "请求绑定到另一角色而非当前会话",
      Boolean(target && message?.characterId === target.id && message.decisionDetails.sourceCharacterId === characterId),
      message ? `${message.characterId}/${String(message.decisionDetails.sourceCharacterId)}` : "missing",
    ));
    rules.push(rule(
      "target-independent-decision",
      "目标角色完成独立发送或拒绝决策",
      message?.status === "delivered" || message?.decisionCode === "character_declined",
      message ? `${message.status}/${message.decisionCode}` : "missing",
    ));
  } else if (definition.id === "tavily-search-trigger") {
    rules.push(rule("tavily-tool", "调用 tavily_search", hasAction(completedActions, "tavily_search"), actionEvidence(completedActions)));
    rules.push(rule("source-url", "回复包含来源 URL", /https?:\/\//u.test(reply), excerpt(reply)));
  } else if (definition.id === "workspace-file-roundtrip") {
    rules.push(rule("workspace-write", "调用 workspace 写入工具", completedActions.some((action) => ["write", "edit", "bash"].includes(action.actionType)), actionEvidence(completedActions)));
    rules.push(rule("workspace-content", "回复包含写入内容", /workspace-ok/u.test(reply), excerpt(reply)));
  } else if (definition.id === "vision-image-understanding") {
    rules.push(rule(
      "vision-path",
      "图片进入视觉处理链路",
      completedActions.some((action) => ["vision_auto_analyze", "vision_direct_input", "analyze_image"].includes(action.actionType)),
      actionEvidence(completedActions),
    ));
  } else if (definition.id === "character-soul-read") {
    rules.push(rule("soul-tool", "调用 get_current_character_soul", hasAction(completedActions, "get_current_character_soul"), actionEvidence(completedActions)));
  }
  return rules;
}

function resultFrom(
  definition: FeatureTestCase,
  input: {
    status: string;
    reply: string;
    actions: ActionRecord[];
    rules: FeatureTestRule[];
    durationMs: number;
    modelRequests: number;
    model: FeatureTestModel;
    qualitySample: string;
    qualitySampleLabel: string;
  },
): FeatureTestResult {
  return {
    caseId: definition.id,
    category: definition.category,
    name: definition.name,
    input: definition.input,
    passed: input.rules.every((entry) => entry.passed),
    status: input.status,
    reply: input.reply.slice(0, 4_000),
    durationMs: input.durationMs,
    modelRequests: input.modelRequests,
    actions: input.actions.map((action) => ({ actionType: action.actionType, status: action.status })),
    rules: input.rules,
    model: input.model,
    qualitySample: input.qualitySample.slice(0, 4_000),
    qualitySampleLabel: input.qualitySampleLabel,
    ranAt: new Date().toISOString(),
  };
}

function rule(
  id: string,
  label: string,
  passed: boolean,
  evidence: string,
  scope: FeatureTestRule["scope"] = "functional",
): FeatureTestRule {
  return { id, label, passed, evidence: evidence.slice(0, 500), scope };
}

function qualitySampleForCase(
  runtime: CompanionKernel,
  definition: FeatureTestCase,
  reply: string,
  characterId: string,
): { qualitySample: string; qualitySampleLabel: string } {
  if (definition.id === "proactive-message-quality") {
    const message = runtime.listProactiveMessages({ characterId, limit: 10 })
      .find((entry) => entry.status === "delivered" && Boolean(entry.text));
    return {
      qualitySample: message?.text ?? reply,
      qualitySampleLabel: message?.text ? "主动消息" : "模型回复",
    };
  }
  if (definition.id === "cross-character-contact") {
    const target = runtime.listCharacters().find((entry) => entry.id !== characterId);
    const message = runtime.listProactiveMessages({ characterId: target?.id, limit: 20 })
      .find((entry) => entry.decisionDetails.kind === "character_contact" && entry.status === "delivered");
    return {
      qualitySample: message?.text ?? reply,
      qualitySampleLabel: message?.text ? "目标角色消息" : "模型回复",
    };
  }
  return { qualitySample: reply, qualitySampleLabel: "模型回复" };
}

function hasAction(actions: ActionRecord[], actionType: string): boolean {
  return actions.some((action) => action.actionType === actionType);
}

function actionEvidence(actions: ActionRecord[]): string {
  return actions.map((action) => `${action.actionType}:${action.status}`).join(", ") || "no actions";
}

function excerpt(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 240);
}
