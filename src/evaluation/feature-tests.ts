import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionRecord, MessageAttachment, MessageResponse, Mode } from "../domain/types.js";
import { CompanionKernel } from "../domain/kernel.js";
import type { MemoryTargetRealm } from "../memory-coordinator/types.js";

export type FeatureTestCase = {
  id: string;
  category: "conversation" | "schedule" | "memory" | "search" | "workspace" | "character" | "vision";
  name: string;
  description: string;
  mode: Mode;
  input: string;
  requiredModules: string[];
  requiredPermissions: string[];
};

export type FeatureTestRule = {
  id: string;
  label: string;
  passed: boolean;
  evidence: string;
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
  ranAt: string;
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
  },
  {
    id: "rp-narrative-form",
    category: "conversation",
    name: "RP 第三人称演绎",
    description: "验证 RP 包含环境、动作和角色对白，而不是私聊短句。",
    mode: "rp",
    input: "雨突然大了，我们躲到屋檐下。继续演绎这一幕。",
    requiredModules: [],
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
  },
  {
    id: "rp-fictional-reminder-isolation",
    category: "schedule",
    name: "RP 虚构提醒隔离",
    description: "验证剧情中的钟声不会写入现实日程。",
    mode: "rp",
    input: "剧情里五分钟后钟声提醒我们去塔顶，继续演绎，不要创建现实提醒。",
    requiredModules: ["mcp:schedule"],
    requiredPermissions: [],
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
    id: "rp-explicit-memory",
    category: "memory",
    name: "角色剧情记忆写入",
    description: "验证明确授权写入当前角色独立的 RP 长期记忆。",
    mode: "rp",
    input: "请记住：剧情中我们约定用蓝色徽章作为见面信物。",
    requiredModules: ["mcp:memory-coordinator"],
    requiredPermissions: [],
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
    id: "tavily-search-trigger",
    category: "search",
    name: "Tavily 搜索触发",
    description: "验证需要外部信息时调用 Tavily MCP，而不是仅依赖模型记忆。",
    mode: "sms",
    input: "请用 Tavily 搜索 OpenAI 官方网站，并告诉我搜索结果中的一个页面标题和 URL。",
    requiredModules: ["mcp:tavily-search"],
    requiredPermissions: [],
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
  }));
}

export async function runFeatureTest(
  source: CompanionKernel,
  caseId: string,
  characterId?: string,
): Promise<FeatureTestResult> {
  const definition = cases.find((entry) => entry.id === caseId);
  if (!definition) throw new Error(`unknown feature test case: ${caseId}`);
  const sourceCharacter = characterId ? source.getCharacter(characterId) : source.listCharacters()[0];
  if (!sourceCharacter) throw new Error("feature tests require at least one character");
  const preflight = preflightRules(source, definition);
  if (preflight.some((entry) => !entry.passed)) {
    return resultFrom(definition, {
      status: "blocked",
      reply: "",
      actions: [],
      rules: preflight,
      durationMs: 0,
      modelRequests: 0,
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
    cloneRuntimeConfiguration(source, runtime);
    const character = runtime.createCharacter({
      name: sourceCharacter.name,
      soulMarkdown: sourceCharacter.soulMarkdown,
    });
    cloneConfirmedMemories(source, runtime, sourceCharacter.id, character.id);
    const attachments = setupCase(runtime, definition, character.id);
    const beforeRequests = runtime.getModelRequestCount();
    const response = await runtime.sendMessage(`feature-test-${definition.id}`, {
      mode: definition.mode,
      characterId: character.id,
      text: definition.input,
      timezone: "Asia/Shanghai",
      attachments,
    });
    await runtime.memoryCoordinator.drain();
    const rules = [...preflight, ...evaluateCase(runtime, definition, response, character.id)];
    return resultFrom(definition, {
      status: response.status,
      reply: response.reply,
      actions: response.actions,
      rules,
      durationMs: Math.round(performance.now() - started),
      modelRequests: runtime.getModelRequestCount() - beforeRequests,
    });
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function cloneRuntimeConfiguration(source: CompanionKernel, target: CompanionKernel): void {
  const model = source.store.getRawModelApiConfig();
  target.patchModelApiConfig({
    enabled: model.enabled,
    baseUrl: model.baseUrl,
    model: model.model,
    visionInputEnabled: model.visionInputEnabled,
    ...(model.apiKey ? { apiKey: model.apiKey } : {}),
    ...(model.temperature === undefined ? {} : { temperature: model.temperature }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
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

function setupCase(runtime: CompanionKernel, definition: FeatureTestCase, characterId: string): MessageAttachment[] {
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
  if (definition.id === "rp-narrative-form") {
    runtime.updateScene(`feature-test-${definition.id}`, {
      location: "雨夜街角的屋檐下",
      currentObjective: "避雨并确认下一步去向",
      summary: "角色与用户刚躲进屋檐，雨势仍在增强。",
    }, characterId);
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
    return [{ path: entry.path, name: entry.name, contentType: entry.contentType, size: entry.size }];
  }
  return [];
}

function preflightRules(source: CompanionKernel, definition: FeatureTestCase): FeatureTestRule[] {
  const modules = new Map(source.listAgentModules().map((entry) => [entry.id, entry]));
  const permissions = source.getAgentPermissions();
  const model = source.getModelApiConfig();
  const output: FeatureTestRule[] = [rule(
    "model-configured",
    "当前模型 API 已配置",
    Boolean(model.enabled && model.baseUrl && model.model),
    model.model || "未配置模型",
  )];
  for (const moduleId of definition.requiredModules) {
    const module = modules.get(moduleId);
    output.push(rule(`module-${moduleId}`, `${module?.name ?? moduleId} 已启用`, Boolean(module?.enabled), module?.enabled ? "enabled" : "disabled"));
  }
  for (const permission of definition.requiredPermissions) {
    const passed = permission === "workspaceReadWrite"
      ? permissions.workspaceAccess === "read_write"
      : Boolean((permissions as unknown as Record<string, unknown>)[permission]);
    output.push(rule(`permission-${permission}`, `${permission} 已授权`, passed, passed ? "enabled" : "disabled"));
  }
  if (definition.id === "tavily-search-trigger") {
    output.push(rule("tavily-configured", "Tavily API Key 已配置", source.tavilyService.isConfigured(), source.tavilyService.isConfigured() ? "configured" : "missing"));
  }
  if (definition.id === "vision-image-understanding") {
    const vision = source.getVisionConfig();
    const direct = vision.mode === "direct" || (vision.mode === "auto" && model.visionInputEnabled);
    const available = vision.mode !== "off" && (direct ? model.visionInputEnabled : source.visionService.isConfigured());
    output.push(rule(
      "vision-configured",
      "当前视觉路径可用",
      available,
      direct ? `direct/${model.visionInputEnabled ? "image" : "text-only"}` : `${vision.mode}/${vision.model || "missing"}`,
    ));
  }
  return output;
}

function evaluateCase(
  runtime: CompanionKernel,
  definition: FeatureTestCase,
  response: MessageResponse,
  characterId: string,
): FeatureTestRule[] {
  const rules = [rule("completed", "对话轮次成功完成", response.status === "completed", response.status)];
  const reply = response.reply;
  const completedActions = response.actions.filter((action) => action.status === "completed");
  if (definition.id === "sms-character-voice") {
    rules.push(rule("first-person", "包含第一人称表达", /我/.test(reply), excerpt(reply)));
    rules.push(rule("no-assistant-tone", "没有通用助手或 AI 自称", !/作为(?:一个)?AI|人工智能|我是.*助手/u.test(reply), excerpt(reply)));
  } else if (definition.id === "rp-narrative-form") {
    rules.push(rule("narrative-length", "剧情正文不少于 60 字", [...reply].length >= 60, `${[...reply].length} chars`));
    rules.push(rule("narrative-form", "包含环境、动作和对白", /雨|屋檐|风|街/u.test(reply) && /走|抬|停|望|伸|靠|转/u.test(reply) && /[“”]/u.test(reply), excerpt(reply)));
  } else if (definition.id === "schedule-relative-reminder") {
    rules.push(rule("schedule-tool", "调用 create_schedule_item", hasAction(completedActions, "create_schedule_item"), actionEvidence(completedActions)));
    rules.push(rule("schedule-created", "隔离日程库新增提醒", runtime.listScheduleItems().length === 1, `${runtime.listScheduleItems().length} items`));
  } else if (definition.id === "rp-fictional-reminder-isolation") {
    rules.push(rule("no-real-schedule", "没有创建现实日程", runtime.listScheduleItems().length === 0, `${runtime.listScheduleItems().length} items`));
    rules.push(rule("no-schedule-action", "没有完成日程变更工具", !completedActions.some((action) => /schedule|reminder/u.test(action.actionType)), actionEvidence(completedActions)));
  } else if (definition.id === "reality-explicit-memory") {
    const memory = runtime.listMemories({ realm: "reality" }).find((entry) => /功能测试偏好/u.test(entry.content));
    rules.push(rule("confirmed-reality-memory", "创建已确认现实记忆", memory?.confirmed === true && memory.validity === "active", memory ? `${memory.validity}/${memory.confirmed}` : "missing"));
    rules.push(rule("profile-projection", "记忆投影进入用户画像", /功能测试偏好|回答前先给结论/u.test(runtime.getUserProfile().markdown), excerpt(runtime.getUserProfile().markdown)));
  } else if (definition.id === "rp-explicit-memory") {
    const memory = runtime.listMemories({ realm: "roleplay", characterId }).find((entry) => /蓝色徽章/u.test(entry.content));
    rules.push(rule("confirmed-rp-memory", "创建当前角色已确认 RP 记忆", memory?.confirmed === true && memory.validity === "active", memory ? `${memory.validity}/${memory.confirmed}` : "missing"));
  } else if (definition.id === "cross-session-memory-recall") {
    rules.push(rule("memory-recalled", "回复召回测试码松针-17", /松针[-—]?17/u.test(reply), excerpt(reply)));
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
    ranAt: new Date().toISOString(),
  };
}

function rule(id: string, label: string, passed: boolean, evidence: string): FeatureTestRule {
  return { id, label, passed, evidence: evidence.slice(0, 500) };
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
