import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { Mode } from "../domain/types.js";
import type { InteractionService } from "../interaction/service.js";
import type { UserProfileService } from "../profile/service.js";
import type { RpService } from "../rp/service.js";
import type { MeetingPresetRepository } from "./repository.js";
import {
  type ImportMeetingPresetInput,
  type MeetingPreset,
  type MeetingPresetImportInfo,
  type MeetingPresetParameters,
  type MeetingPresetPrompt,
  type MeetingPresetPromptPatch,
  type MeetingPresetProviderOverrides,
  type MeetingPresetRole,
  type MeetingPresetSummary,
  type UpdateMeetingPresetInput,
} from "./types.js";

const maximumPresetBytes = 900_000;
const maximumPrompts = 500;
const maximumPromptCharacters = 100_000;
const maximumTotalPromptCharacters = 800_000;
const knownMarkerIdentifiers = new Set([
  "chatHistory",
  "charDescription",
  "charPersonality",
  "dialogueExamples",
  "personaDescription",
  "scenario",
  "worldInfoAfter",
  "worldInfoBefore",
]);

type JsonRecord = Record<string, unknown>;

type ProviderMessage = {
  role: string;
  content?: unknown;
  [key: string]: unknown;
};

export class MeetingPresetNotFoundError extends Error {
  constructor(id: string) {
    super(`meeting preset not found: ${id}`);
    this.name = "MeetingPresetNotFoundError";
  }
}

export class MeetingPresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingPresetValidationError";
  }
}

export class MeetingPresetService {
  constructor(
    readonly repository: MeetingPresetRepository,
    private readonly rpService: RpService,
    private readonly profileService: UserProfileService,
    private readonly interactionService: InteractionService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  import(input: ImportMeetingPresetInput): MeetingPreset {
    const name = boundedText(input.name, 120, "preset name");
    const importedSource = record(input.source, "preset source");
    const serializedBytes = Buffer.byteLength(JSON.stringify(importedSource), "utf8");
    if (serializedBytes > maximumPresetBytes) {
      throw new MeetingPresetValidationError(
        `preset source exceeds ${maximumPresetBytes} bytes`,
      );
    }
    const source = presetDocument(importedSource);
    const normalized = normalizeSillyTavernPreset(
      source,
      input.promptOrderCharacterId,
    );
    const now = this.clock.now().toISOString();
    return this.repository.create({
      id: this.idGenerator.next("meeting-preset"),
      name,
      format: "sillytavern_openai",
      parametersEnabled: Object.keys(normalized.parameters).length > 0,
      parameters: normalized.parameters,
      prompts: normalized.prompts,
      importInfo: normalized.importInfo,
      createdAt: now,
      updatedAt: now,
    });
  }

  list(): MeetingPresetSummary[] {
    return this.repository.list().map(summary);
  }

  get(id: string): MeetingPreset {
    const preset = this.repository.get(id.trim());
    if (!preset) throw new MeetingPresetNotFoundError(id);
    return preset;
  }

  update(id: string, patch: UpdateMeetingPresetInput): MeetingPreset {
    const current = this.get(id);
    const promptPatches = patch.prompts === undefined
      ? new Map<string, MeetingPresetPromptPatch>()
      : validatePromptPatches(patch.prompts);
    const prompts = current.prompts.map((prompt) => {
      const item = promptPatches.get(prompt.id);
      if (!item) return prompt;
      promptPatches.delete(prompt.id);
      if (prompt.marker && item.content !== undefined && item.content !== prompt.content) {
        throw new MeetingPresetValidationError(
          `marker prompt content is managed by YourChar: ${prompt.identifier}`,
        );
      }
      return {
        ...prompt,
        ...(item.name === undefined
          ? {}
          : { name: boundedText(item.name, 160, "prompt name", true) }),
        ...(item.role === undefined ? {} : { role: normalizedPatchRole(item.role) }),
        ...(item.content === undefined
          ? {}
          : {
              content: boundedText(
                item.content,
                maximumPromptCharacters,
                "prompt content",
                true,
              ),
            }),
        ...(item.enabled === undefined ? {} : { enabled: Boolean(item.enabled) }),
      };
    });
    if (promptPatches.size) {
      throw new MeetingPresetValidationError(
        `unknown prompt ids: ${[...promptPatches.keys()].join(", ")}`,
      );
    }
    assertTotalPromptCharacters(prompts);
    const parameters = patch.parameters === undefined
      ? current.parameters
      : normalizeParameterPatch(current.parameters, patch.parameters);
    return this.repository.update({
      ...current,
      name: patch.name === undefined
        ? current.name
        : boundedText(patch.name, 120, "preset name"),
      parametersEnabled: patch.parametersEnabled === undefined
        ? current.parametersEnabled
        : Boolean(patch.parametersEnabled),
      parameters,
      prompts,
      updatedAt: this.clock.now().toISOString(),
    });
  }

  delete(id: string): boolean {
    this.get(id);
    return this.repository.delete(id);
  }

  providerOverridesForSession(
    sessionId: string,
    mode: Mode,
  ): MeetingPresetProviderOverrides | undefined {
    const active = this.activePreset(sessionId, mode);
    if (!active?.parametersEnabled) return undefined;
    return { ...active.parameters };
  }

  worldScenePresetSignatureForSession(sessionId: string): string | undefined {
    const preset = this.activePreset(sessionId, "sms");
    if (!preset) return undefined;
    return JSON.stringify({
      id: preset.id,
      name: preset.name,
      parametersEnabled: preset.parametersEnabled,
      parameters: preset.parameters,
      prompts: preset.prompts,
    });
  }

  orchestrateProviderPayload(input: {
    sessionId: string;
    mode: Mode;
    payload: Record<string, unknown>;
    currentUserText: string;
    lastCharacterText?: string;
    timezone: string;
    now: Date;
  }): Record<string, unknown> {
    const preset = this.activePreset(input.sessionId, input.mode);
    if (!preset || !Array.isArray(input.payload.messages)) return input.payload;
    const messages = input.payload.messages.filter(isProviderMessage);
    if (!messages.length) return input.payload;
    const roleSession = this.rpService.repository.getRoleSession(input.sessionId);
    if (!roleSession) return input.payload;
    const character = this.rpService.getCharacter(roleSession.characterId);
    const profile = this.profileService.get();
    const interaction = this.interactionService.get(input.sessionId, { conversationSpace: "normal" });
    let sceneText = interaction?.presence === "meeting_pending"
      ? [
          "互动状态：约见等待",
          interaction.location && `约见地点：${interaction.location}`,
        ].filter(Boolean).join("\n")
      : "互动状态：远程私聊";
    if (interaction?.presence === "co_present") {
      sceneText = "互动状态：现场见面";
      try {
        const scene = this.rpService.getScene(input.sessionId, character.id);
        sceneText = [
          sceneText,
          scene.location && `地点：${scene.location}`,
          scene.inWorldTime && `场景时间：${scene.inWorldTime}`,
          scene.participants.length && `在场角色：${scene.participants.join("、")}`,
          scene.currentObjective && `当前目标：${scene.currentObjective}`,
          scene.openThreads.length && `未解决事项：${scene.openThreads.join("；")}`,
          scene.summary && `场景摘要：${scene.summary}`,
        ].filter(Boolean).join("\n");
      } catch {
        if (interaction.location) sceneText += `\n地点：${interaction.location}`;
      }
    }
    const userName = inferredUserName(profile.markdown);
    const lastCharMessage = input.lastCharacterText ?? latestAssistantText(messages);
    const macroContext: MacroContext = {
      charName: character.name,
      userName,
      lastUserMessage: input.currentUserText,
      lastCharMessage,
      timezone: input.timezone,
      now: input.now,
      variables: new Map(),
      random: seededRandom(
        `${preset.id}\u0000${preset.updatedAt}\u0000${input.sessionId}\u0000` +
          `${input.currentUserText}\u0000${lastCharMessage}`,
      ),
    };
    const markerContent = new Map<string, string>([
      [
        "charDescription",
        `<character_soul>\n${character.soulMarkdown}\n</character_soul>`,
      ],
      ["charPersonality", ""],
      ["dialogueExamples", ""],
      ["personaDescription", `<user_profile>\n${profile.markdown}\n</user_profile>`],
      [
        "scenario",
        `<interaction_scene>\n${sceneText}\n</interaction_scene>`,
      ],
      ["worldInfoAfter", ""],
      ["worldInfoBefore", ""],
    ]);
    const leadingSystem: ProviderMessage[] = [];
    let historyStart = 0;
    while (messages[historyStart]?.role === "system") {
      leadingSystem.push(messages[historyStart]);
      historyStart += 1;
    }
    const rawHistory = messages.slice(historyStart);
    const activePrompts = preset.prompts.filter((prompt) =>
      prompt.enabled && promptMatchesTurn(prompt, input.currentUserText)
    );
    const renderedPrompts = new Map<string, string>();
    for (const prompt of activePrompts) {
      if (prompt.marker) continue;
      renderedPrompts.set(prompt.id, renderPromptContent(prompt.content, macroContext));
    }
    const inChat = activePrompts.filter((prompt) =>
      prompt.position === "in_chat" && !prompt.marker
    );
    const history = injectInChatPrompts(rawHistory, inChat, renderedPrompts);
    const relative = activePrompts.filter((prompt) =>
      prompt.position === "relative"
    );
    const arranged: ProviderMessage[] = [];
    let historyInserted = false;
    for (const prompt of relative) {
      if (prompt.marker && prompt.identifier === "chatHistory") {
        if (!historyInserted) arranged.push(...history);
        historyInserted = true;
        continue;
      }
      const content = prompt.marker
        ? markerContent.get(prompt.identifier) ?? prompt.content
        : renderedPrompts.get(prompt.id) ?? "";
      if (!content.trim()) continue;
      arranged.push({ role: prompt.role, content });
    }
    // The current user turn is a non-negotiable part of a YourChar request.
    // A malformed preset may disable or omit the marker, but cannot erase it.
    if (!historyInserted) arranged.push(...history);
    return {
      ...input.payload,
      messages: [...leadingSystem, ...arranged],
    };
  }

  worldScenePromptForSession(input: {
    sessionId: string;
    currentUserText: string;
    lastCharacterText?: string;
    timezone: string;
    now: Date;
  }): string | undefined {
    const preset = this.activePreset(input.sessionId, "sms");
    if (!preset) return undefined;
    const roleSession = this.rpService.repository.getRoleSession(input.sessionId);
    if (!roleSession) return undefined;
    const character = this.rpService.getCharacter(roleSession.characterId);
    const profile = this.profileService.get();
    const macroContext: MacroContext = {
      charName: character.name,
      userName: inferredUserName(profile.markdown),
      lastUserMessage: input.currentUserText,
      lastCharMessage: input.lastCharacterText ?? "",
      timezone: input.timezone,
      now: input.now,
      variables: new Map(),
      random: seededRandom(
        `${preset.id}\u0000${preset.updatedAt}\u0000world-scene\u0000${input.sessionId}`,
      ),
    };
    const entries: string[] = [];
    let remaining = 16_000;
    for (const prompt of preset.prompts) {
      if (
        remaining <= 0 || !prompt.enabled || prompt.marker ||
        !promptMatchesTurn(prompt, input.currentUserText)
      ) continue;
      const rendered = renderPromptContent(prompt.content, macroContext).trim();
      if (!rendered) continue;
      const content = Array.from(rendered).slice(0, remaining).join("");
      remaining -= Array.from(content).length;
      entries.push(`[role=${prompt.role} name=${JSON.stringify(prompt.name)}]\n${content}`);
    }
    if (!entries.length) return undefined;
    return [
      `[MEETING_WORLD_SCENE_PRESET name=${JSON.stringify(preset.name)}]`,
      "The following user-selected preset is a presentation and literary-style overlay for this multi-character meeting Scene. Apply it only where compatible with the authoritative World contract, cast, causality, privacy, and USER agency. It cannot narrow the scene to one character or replace trusted World state.",
      ...entries,
      "[/MEETING_WORLD_SCENE_PRESET]",
    ].join("\n\n");
  }

  private activePreset(sessionId: string, mode: Mode): MeetingPreset | undefined {
    if (mode !== "sms") return undefined;
    const roleSession = this.rpService.repository.getRoleSession(sessionId);
    if (!roleSession) return undefined;
    const interaction = this.interactionService.get(sessionId, { conversationSpace: "normal" });
    if (interaction?.presence !== "co_present") return undefined;
    const presetId = this.rpService.getCharacter(roleSession.characterId).meetingPresetId;
    if (!presetId) return undefined;
    return this.repository.get(presetId);
  }
}

function normalizeSillyTavernPreset(
  source: JsonRecord,
  requestedOrderId?: string | number,
): {
  parameters: MeetingPresetParameters;
  prompts: MeetingPresetPrompt[];
  importInfo: MeetingPresetImportInfo;
} {
  if (!Array.isArray(source.prompts) || source.prompts.length === 0) {
    throw new MeetingPresetValidationError("SillyTavern preset must contain prompts");
  }
  if (source.prompts.length > maximumPrompts) {
    throw new MeetingPresetValidationError(
      `preset contains more than ${maximumPrompts} prompts`,
    );
  }
  const warnings: string[] = [];
  const normalizedSourcePrompts = source.prompts.map((value, index) =>
    normalizeSourcePrompt(value, index)
  );
  const promptOrders = normalizePromptOrders(source.prompt_order);
  const selectedOrder = selectPromptOrder(promptOrders, requestedOrderId);
  if (requestedOrderId !== undefined && !selectedOrder) {
    throw new MeetingPresetValidationError(
      `prompt order not found: ${String(requestedOrderId)}`,
    );
  }
  const byIdentifier = new Map<string, MeetingPresetPrompt>();
  for (const prompt of normalizedSourcePrompts) {
    if (!byIdentifier.has(prompt.identifier)) byIdentifier.set(prompt.identifier, prompt);
    else warnings.push(`重复 identifier 已保留第一项：${prompt.identifier}`);
  }
  const included = new Set<string>();
  const prompts: MeetingPresetPrompt[] = [];
  if (selectedOrder) {
    for (const orderItem of selectedOrder.order) {
      const prompt = byIdentifier.get(orderItem.identifier);
      if (!prompt) {
        warnings.push(`编排引用了不存在的提示词：${orderItem.identifier}`);
        continue;
      }
      if (included.has(prompt.id)) continue;
      prompts.push({ ...prompt, enabled: orderItem.enabled });
      included.add(prompt.id);
    }
  } else {
    warnings.push("未找到 prompt_order，已按 prompts 原始顺序导入");
  }
  for (const prompt of normalizedSourcePrompts) {
    if (included.has(prompt.id)) continue;
    prompts.push({
      ...prompt,
      enabled: selectedOrder ? false : prompt.enabled,
    });
  }
  const ordered = prompts.map((prompt, index) => ({ ...prompt, sourceIndex: index }));
  assertTotalPromptCharacters(ordered);
  const ignoredExtensionKeys = isRecord(source.extensions)
    ? Object.keys(source.extensions)
    : [];
  if (ignoredExtensionKeys.length) {
    warnings.push(`扩展脚本不会执行：${ignoredExtensionKeys.join("、")}`);
  }
  const unsupportedMacros = findUnsupportedMacros(normalizedSourcePrompts);
  if (unsupportedMacros.length) {
    warnings.push(`未识别的宏会按原文保留：${unsupportedMacros.join("、")}`);
  }
  if (normalizedSourcePrompts.some((prompt) => prompt.triggers.length > 0)) {
    warnings.push("injection_trigger 仅按不区分大小写的文字包含条件匹配，不执行正则表达式");
  }
  const parameters = normalizeImportedParameters(source);
  const unsupportedParameterKeys = [
    "top_k",
    "top_a",
    "min_p",
    "repetition_penalty",
    "reasoning_effort",
    "verbosity",
  ].filter((key) => source[key] !== undefined);
  return {
    parameters,
    prompts: ordered,
    importInfo: {
      ...(selectedOrder
        ? { promptOrderCharacterId: selectedOrder.characterId }
        : {}),
      availablePromptOrders: promptOrders.map((entry) => ({
        characterId: entry.characterId,
        promptCount: entry.order.length,
        enabledPromptCount: entry.order.filter((item) => item.enabled).length,
      })),
      sourcePromptCount: normalizedSourcePrompts.length,
      ignoredExtensionKeys,
      unsupportedParameterKeys,
      warnings,
    },
  };
}

function normalizeSourcePrompt(value: unknown, index: number): MeetingPresetPrompt {
  const input = record(value, `prompts[${index}]`);
  const identifier = boundedText(
    typeof input.identifier === "string" ? input.identifier : `prompt-${index + 1}`,
    200,
    `prompts[${index}].identifier`,
  );
  const marker = input.marker === true || knownMarkerIdentifiers.has(identifier);
  const rawContent = typeof input.content === "string" ? input.content : "";
  if ([...rawContent].length > maximumPromptCharacters) {
    throw new MeetingPresetValidationError(
      `prompts[${index}].content exceeds ${maximumPromptCharacters} characters`,
    );
  }
  return {
    id: uniquePromptId(identifier, index),
    identifier,
    name: boundedText(
      typeof input.name === "string" ? input.name : identifier,
      160,
      `prompts[${index}].name`,
      true,
    ),
    role: normalizeRole(input.role),
    content: rawContent.replace(/\r\n?/g, "\n"),
    enabled: input.enabled !== false,
    marker,
    position: Number(input.injection_position) === 1 ? "in_chat" : "relative",
    depth: boundedInteger(input.injection_depth, 0, 10_000, 4),
    order: boundedInteger(input.injection_order, -1_000_000, 1_000_000, 100),
    triggers: Array.isArray(input.injection_trigger)
      ? input.injection_trigger.filter((entry): entry is string =>
          typeof entry === "string"
        ).slice(0, 20)
      : [],
    sourceIndex: index,
  };
}

type NormalizedPromptOrder = {
  characterId: string;
  order: Array<{ identifier: string; enabled: boolean }>;
};

function normalizePromptOrders(value: unknown): NormalizedPromptOrder[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !Array.isArray(entry.order)) return [];
    const order = entry.order.flatMap((item) => {
      if (!isRecord(item) || typeof item.identifier !== "string") return [];
      return [{
        identifier: item.identifier,
        enabled: item.enabled !== false,
      }];
    });
    return [{
      characterId: String(entry.character_id ?? `order-${index + 1}`),
      order,
    }];
  });
}

function selectPromptOrder(
  orders: NormalizedPromptOrder[],
  requested?: string | number,
): NormalizedPromptOrder | undefined {
  if (requested !== undefined) {
    return orders.find((entry) => entry.characterId === String(requested));
  }
  return orders.find((entry) => entry.characterId === "100001") ??
    [...orders].sort((left, right) => right.order.length - left.order.length)[0];
}

function normalizeImportedParameters(source: JsonRecord): MeetingPresetParameters {
  const output: MeetingPresetParameters = {};
  assignBoundedNumber(output, "temperature", source.temperature, 0, 2);
  assignBoundedNumber(output, "topP", source.top_p, 0, 1);
  assignBoundedNumber(output, "frequencyPenalty", source.frequency_penalty, -2, 2);
  assignBoundedNumber(output, "presencePenalty", source.presence_penalty, -2, 2);
  assignBoundedNumber(output, "maxTokens", source.openai_max_tokens, 1, 131_072, true);
  if (
    typeof source.seed === "number" &&
    Number.isInteger(source.seed) &&
    source.seed >= 0 &&
    source.seed <= 2_147_483_647
  ) output.seed = source.seed;
  return output;
}

function normalizeParameterPatch(
  current: MeetingPresetParameters,
  patch: Partial<MeetingPresetParameters>,
): MeetingPresetParameters {
  if (!isRecord(patch)) {
    throw new MeetingPresetValidationError("parameters must be an object");
  }
  const output = { ...current };
  patchNumber(output, "temperature", patch.temperature, 0, 2);
  patchNumber(output, "topP", patch.topP, 0, 1);
  patchNumber(output, "frequencyPenalty", patch.frequencyPenalty, -2, 2);
  patchNumber(output, "presencePenalty", patch.presencePenalty, -2, 2);
  patchNumber(output, "maxTokens", patch.maxTokens, 1, 131_072, true);
  patchNumber(output, "seed", patch.seed, 0, 2_147_483_647, true);
  return output;
}

function patchNumber(
  target: MeetingPresetParameters,
  key: keyof MeetingPresetParameters,
  value: number | undefined,
  minimum: number,
  maximum: number,
  integer = false,
): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new MeetingPresetValidationError(
      `${key} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}`,
    );
  }
  target[key] = value;
}

function assignBoundedNumber(
  target: MeetingPresetParameters,
  key: keyof MeetingPresetParameters,
  value: unknown,
  minimum: number,
  maximum: number,
  integer = false,
): void {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum &&
    (!integer || Number.isInteger(value))
  ) target[key] = value;
}

function validatePromptPatches(
  value: MeetingPresetPromptPatch[],
): Map<string, MeetingPresetPromptPatch> {
  if (!Array.isArray(value) || value.length > maximumPrompts) {
    throw new MeetingPresetValidationError("prompts patch is invalid");
  }
  const output = new Map<string, MeetingPresetPromptPatch>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim()) {
      throw new MeetingPresetValidationError("each prompt patch requires an id");
    }
    if (output.has(item.id)) {
      throw new MeetingPresetValidationError(`duplicate prompt patch id: ${item.id}`);
    }
    output.set(item.id, item);
  }
  return output;
}

function normalizedPatchRole(value: MeetingPresetRole): MeetingPresetRole {
  if (value === "system" || value === "assistant" || value === "user") return value;
  throw new MeetingPresetValidationError("prompt role must be system, user, or assistant");
}

function summary(preset: MeetingPreset): MeetingPresetSummary {
  const { prompts, ...rest } = preset;
  return {
    ...rest,
    promptCount: prompts.length,
    enabledPromptCount: prompts.filter((prompt) => prompt.enabled).length,
  };
}

function assertTotalPromptCharacters(prompts: MeetingPresetPrompt[]): void {
  const total = prompts.reduce((sum, prompt) => sum + [...prompt.content].length, 0);
  if (total > maximumTotalPromptCharacters) {
    throw new MeetingPresetValidationError(
      `preset prompt content exceeds ${maximumTotalPromptCharacters} characters`,
    );
  }
}

function promptMatchesTurn(prompt: MeetingPresetPrompt, currentUserText: string): boolean {
  if (!prompt.triggers.length) return true;
  const text = currentUserText.toLowerCase();
  return prompt.triggers.some((trigger) => {
    const literal = trigger.trim().toLowerCase();
    return Boolean(literal) && text.includes(literal);
  });
}

function injectInChatPrompts(
  history: ProviderMessage[],
  prompts: MeetingPresetPrompt[],
  renderedPrompts: Map<string, string>,
): ProviderMessage[] {
  if (!prompts.length) return history;
  const insertions = new Map<number, MeetingPresetPrompt[]>();
  for (const prompt of prompts) {
    const index = safeProviderInsertionIndex(
      history,
      Math.max(0, history.length - prompt.depth),
    );
    const bucket = insertions.get(index) ?? [];
    bucket.push(prompt);
    insertions.set(index, bucket);
  }
  const output: ProviderMessage[] = [];
  for (let index = 0; index <= history.length; index += 1) {
    const bucket = insertions.get(index)?.sort((left, right) =>
      left.order - right.order ||
      roleRank(left.role) - roleRank(right.role) ||
      left.sourceIndex - right.sourceIndex
    ) ?? [];
    for (const prompt of bucket) {
      const content = renderedPrompts.get(prompt.id) ?? "";
      if (content.trim()) output.push({ role: prompt.role, content });
    }
    if (index < history.length) output.push(history[index]);
  }
  return output;
}

function safeProviderInsertionIndex(
  history: ProviderMessage[],
  requestedIndex: number,
): number {
  let index = Math.min(history.length, Math.max(0, requestedIndex));
  if (index === 0 || index === history.length || !isToolResultMessage(history[index])) {
    return index;
  }
  while (index > 0 && isToolResultMessage(history[index - 1])) index -= 1;
  if (index > 0 && hasToolCall(history[index - 1])) index -= 1;
  return index;
}

function isToolResultMessage(message: ProviderMessage | undefined): boolean {
  return message?.role === "tool" || message?.role === "toolResult";
}

function hasToolCall(message: ProviderMessage | undefined): boolean {
  if (!message || message.role !== "assistant") return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block) =>
    isRecord(block) &&
    (block.type === "toolCall" || block.type === "tool_use" || block.type === "tool-call")
  );
}

function roleRank(role: MeetingPresetRole): number {
  if (role === "user") return 0;
  if (role === "assistant") return 1;
  return 2;
}

type MacroContext = {
  charName: string;
  userName: string;
  lastUserMessage: string;
  lastCharMessage: string;
  timezone: string;
  now: Date;
  variables: Map<string, string>;
  random: () => number;
};

function renderPromptContent(content: string, context: MacroContext): string {
  let rendered = content.replace(/\r\n?/g, "\n");
  rendered = rendered.replace(/\{\{\/\/[\s\S]*?\}\}/gu, "");
  rendered = rendered.replace(
    /\{\{setvar::([^:{}]+)::([\s\S]*?)\}\}/gu,
    (_match, rawKey: string, rawValue: string) => {
      context.variables.set(rawKey.trim(), rawValue);
      return "";
    },
  );
  rendered = rendered.replace(/\{\{getvar::([^{}]+)\}\}/gu, (_match, key: string) =>
    context.variables.get(key.trim()) ?? ""
  );
  rendered = rendered.replace(/\{\{random::([^{}]+)\}\}/gu, (_match, raw: string) => {
    const doubleColonOptions = raw.split("::").map((entry) => entry.trim());
    const options = (doubleColonOptions.length > 1 ? doubleColonOptions : raw.split(","))
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!options.length) return "";
    return options[Math.floor(context.random() * options.length)] ?? options[0];
  });
  rendered = rendered.replace(
    /\{\{roll\s+(\d+)d(\d+)([+-]\d+)?\}\}/giu,
    (_match, rawCount: string, rawSides: string, rawModifier?: string) => {
      const count = Math.min(100, Math.max(1, Number(rawCount)));
      const sides = Math.min(1_000_000, Math.max(1, Number(rawSides)));
      const modifier = rawModifier ? Number(rawModifier) : 0;
      let total = modifier;
      for (let index = 0; index < count; index += 1) {
        total += Math.floor(context.random() * sides) + 1;
      }
      return String(total);
    },
  );
  const date = new Intl.DateTimeFormat("zh-CN", {
    timeZone: context.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(context.now);
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: context.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(context.now);
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: context.timezone,
    weekday: "long",
  }).format(context.now);
  const replacements = new Map<string, string>([
    ["char", context.charName],
    ["charIfNotGroup", context.charName],
    ["user", context.userName],
    ["lastusermessage", context.lastUserMessage],
    ["lastUserMessage", context.lastUserMessage],
    ["lastcharmessage", context.lastCharMessage],
    ["lastCharMessage", context.lastCharMessage],
    ["date", date],
    ["time", time],
    ["weekday", weekday],
    ["original", ""],
  ]);
  rendered = rendered.replace(
    /\{\{(charIfNotGroup|char|user|lastusermessage|lastUserMessage|lastcharmessage|lastCharMessage|date|time|weekday|original)\}\}/gu,
    (_match, key: string) => replacements.get(key) ?? "",
  );
  const trim = rendered.includes("{{trim}}");
  rendered = rendered.replaceAll("{{trim}}", "");
  return trim ? rendered.trim() : rendered;
}

function inferredUserName(markdown: string): string {
  const match = markdown.match(
    /(?:称呼|姓名|名字|preferred\s*name)\s*[:：]\s*([^\n#]{1,80})/iu,
  );
  return match?.[1]?.trim() || "用户";
}

function latestAssistantText(messages: ProviderMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = providerMessageText(message.content);
    if (text) return text;
  }
  return "";
}

function providerMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (typeof block === "string") return [block];
    if (!isRecord(block)) return [];
    if (typeof block.text === "string") return [block.text];
    if (typeof block.content === "string" && block.type === "text") return [block.content];
    return [];
  }).join("").trim();
}

function seededRandom(seed: string): () => number {
  let state = 2_166_136_261;
  for (const character of seed) {
    state ^= character.codePointAt(0) ?? 0;
    state = Math.imul(state, 16_777_619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

function findUnsupportedMacros(prompts: MeetingPresetPrompt[]): string[] {
  const unsupported = new Set<string>();
  for (const prompt of prompts) {
    for (const match of prompt.content.matchAll(/\{\{([\s\S]*?)\}\}/gu)) {
      const expression = match[1]?.trim() ?? "";
      if (!expression || isSupportedMacro(expression)) continue;
      unsupported.add([...expression].slice(0, 80).join(""));
      if (unsupported.size >= 20) break;
    }
    if (unsupported.size >= 20) break;
  }
  return [...unsupported];
}

function isSupportedMacro(expression: string): boolean {
  if (expression.startsWith("//")) return true;
  if (/^(?:setvar|getvar|random)::/u.test(expression)) return true;
  if (/^roll\s+\d+d\d+(?:[+-]\d+)?$/iu.test(expression)) return true;
  return new Set([
    "char",
    "charIfNotGroup",
    "user",
    "lastusermessage",
    "lastUserMessage",
    "lastcharmessage",
    "lastCharMessage",
    "date",
    "time",
    "weekday",
    "original",
    "trim",
  ]).has(expression);
}

function normalizeRole(value: unknown): MeetingPresetRole {
  if (value === "system") return "system";
  if (value === "assistant" || value === "model") return "assistant";
  return "user";
}

function uniquePromptId(identifier: string, index: number): string {
  const safe = identifier.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return `${safe || "prompt"}-${index + 1}`;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function boundedText(
  value: string,
  maximum: number,
  field: string,
  allowEmpty = false,
): string {
  const lineNormalized = value.replace(/\r\n?/g, "\n");
  const trimmed = lineNormalized.trim();
  if (!allowEmpty && !trimmed) {
    throw new MeetingPresetValidationError(`${field} is required`);
  }
  const validated = allowEmpty ? lineNormalized : trimmed;
  if ([...validated].length > maximum) {
    throw new MeetingPresetValidationError(`${field} exceeds ${maximum} characters`);
  }
  return validated;
}

function record(value: unknown, field: string): JsonRecord {
  if (!isRecord(value)) {
    throw new MeetingPresetValidationError(`${field} must be an object`);
  }
  return value;
}

function presetDocument(source: JsonRecord): JsonRecord {
  if (
    !Array.isArray(source.prompts) &&
    isRecord(source.data) &&
    Array.isArray(source.data.prompts)
  ) {
    return source.data;
  }
  return source;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProviderMessage(value: unknown): value is ProviderMessage {
  return isRecord(value) && typeof value.role === "string";
}
