import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ConversationSpace } from "../domain/types.js";
import type { MemoryVaultService } from "../memory-vault/service.js";
import { normalizeMemoryContent, type RpRepository } from "./repository.js";
import {
  RP_MEMORY_REALM,
  RP_MEMORY_SCOPE,
  isRoleplayMemoryType,
  type CharacterProfile,
  type CreateCharacterInput,
  type CreateMemoryInput,
  type MemorySearchFilter,
  type MemoryWriteResult,
  type PendingRealMutation,
  type ProposeMemoryInput,
  type RoleSession,
  type RpMemory,
  type SceneState,
  type UpdateCharacterInput,
  type UpdateMemoryInput,
  type UpdateSceneInput,
} from "./types.js";
import {
  CharacterSoulService,
  legacyCharacterSoulMarkdown,
} from "./soul.js";

export class RpNotFoundError extends Error {
  constructor(kind: string, id: string) {
    super(`${kind} not found: ${id}`);
    this.name = "RpNotFoundError";
  }
}

export class RpMemoryValidationError extends Error {
  constructor(
    message: string,
    readonly code: "RP_MEMORY_SCOPE_INVALID" | "RP_MEMORY_TYPE_INVALID" = "RP_MEMORY_SCOPE_INVALID",
  ) {
    super(message);
    this.name = "RpMemoryValidationError";
  }
}

export class RpService {
  readonly soulService: CharacterSoulService;
  private memoryVault?: MemoryVaultService;

  constructor(
    readonly repository: RpRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    options: { stateDir?: string } = {},
  ) {
    this.soulService = new CharacterSoulService(options.stateDir);
  }

  attachMemoryVault(vault: MemoryVaultService): void {
    this.memoryVault = vault;
    this.soulService.attachMemoryVault(vault);
  }

  createCharacter(input: CreateCharacterInput): CharacterProfile {
    const now = this.clock.now().toISOString();
    const id = this.idGenerator.next("character");
    const name = requiredText(input.name, "name");
    const soul = this.soulService.update(
      id,
      input.soulMarkdown ?? legacyCharacterSoulMarkdown({ ...input, name }),
    );
    const character: CharacterProfile = {
      id,
      name,
      modelProfileId: optionalModelProfileId(input.modelProfileId),
      meetingPresetId: optionalMeetingPresetId(input.meetingPresetId),
      soulMarkdown: soul.markdown,
      soulCharacterCount: soul.characterCount,
      soulMaxCharacters: soul.maxCharacters,
      createdAt: now,
      updatedAt: now,
    };
    try {
      return this.repository.createCharacter(character);
    } catch (error) {
      this.soulService.delete(id);
      throw error;
    }
  }

  listCharacters(): CharacterProfile[] {
    return this.repository.listCharacters().map((character) => this.withSoul(character));
  }

  listRoleSessions(): RoleSession[] {
    return this.repository.listRoleSessions();
  }

  deleteSessionData(appSessionId: string) {
    this.memoryVault?.removeScene(appSessionId);
    return this.repository.deleteSessionData(appSessionId);
  }

  listScenes(): SceneState[] {
    if (this.memoryVault) {
      this.memoryVault.syncIfChanged();
      return this.memoryVault.listScenes();
    }
    return this.repository.listScenes();
  }

  getCharacter(id: string): CharacterProfile {
    const character = this.repository.getCharacter(id);
    if (!character) throw new RpNotFoundError("character", id);
    return this.withSoul(character);
  }

  updateCharacter(id: string, patch: UpdateCharacterInput): CharacterProfile {
    const current = this.getCharacter(id);
    const name = patch.name === undefined ? current.name : requiredText(patch.name, "name");
    const legacyPatch = hasLegacyCharacterFields(patch)
      ? legacyCharacterSoulMarkdown({ ...patch, name })
      : undefined;
    const soul = patch.soulMarkdown === undefined && legacyPatch === undefined
      ? {
          markdown: current.soulMarkdown,
          characterCount: current.soulCharacterCount,
          maxCharacters: current.soulMaxCharacters,
        }
      : this.soulService.update(id, patch.soulMarkdown ?? legacyPatch!);
    const next: CharacterProfile = {
      ...current,
      name,
      modelProfileId: patch.modelProfileId === undefined
        ? current.modelProfileId
        : optionalModelProfileId(patch.modelProfileId),
      meetingPresetId: patch.meetingPresetId === undefined
        ? current.meetingPresetId
        : optionalMeetingPresetId(patch.meetingPresetId),
      soulMarkdown: soul.markdown,
      soulCharacterCount: soul.characterCount,
      soulMaxCharacters: soul.maxCharacters,
      updatedAt: this.clock.now().toISOString(),
    };
    return this.repository.updateCharacter(next);
  }

  clearCharacterSouls(): void {
    this.soulService.clearAll();
  }

  private withSoul(character: CharacterProfile): CharacterProfile {
    const soul = this.soulService.get(character.id, character.soulMarkdown);
    return {
      ...character,
      soulMarkdown: soul.markdown,
      soulCharacterCount: soul.characterCount,
      soulMaxCharacters: soul.maxCharacters,
    };
  }

  ensureRoleSession(appSessionId: string, characterId: string, worldId?: string): RoleSession {
    this.getCharacter(characterId);
    const existing = this.repository.getRoleSession(appSessionId);
    if (existing) {
      if (existing.characterId !== characterId) {
        throw new Error(`RP session ${appSessionId} already belongs to character ${existing.characterId}`);
      }
      return existing;
    }
    const now = this.clock.now().toISOString();
    return this.repository.createRoleSession({
      appSessionId,
      characterId,
      worldId,
      status: "active",
      continuity: {},
      createdAt: now,
      updatedAt: now,
    });
  }

  getScene(appSessionId: string, characterId?: string): SceneState {
    let roleSession = this.repository.getRoleSession(appSessionId);
    if (!roleSession && characterId) roleSession = this.ensureRoleSession(appSessionId, characterId);
    if (!roleSession) throw new RpNotFoundError("role session", appSessionId);
    if (this.memoryVault) {
      this.memoryVault.syncIfChanged();
      const scene = this.memoryVault.getScene(appSessionId);
      if (scene) return scene;
    }
    return this.repository.getScene(appSessionId) ?? {
      roleSessionId: appSessionId,
      participants: [this.getCharacter(roleSession.characterId).name],
      openThreads: [],
      summary: "",
      updatedAt: this.clock.now().toISOString(),
    };
  }

  updateScene(appSessionId: string, patch: UpdateSceneInput, characterId?: string, toolCallId?: string): SceneState {
    if (toolCallId) {
      const existing = this.repository.getSceneByToolCallId(toolCallId);
      if (existing) return existing;
    }
    let roleSession = this.repository.getRoleSession(appSessionId);
    if (!roleSession && characterId) roleSession = this.ensureRoleSession(appSessionId, characterId);
    if (!roleSession) throw new RpNotFoundError("role session", appSessionId);
    const current = this.memoryVault
      ? this.repository.getScene(appSessionId) ?? {
          roleSessionId: appSessionId,
          participants: [this.getCharacter(roleSession.characterId).name],
          openThreads: [],
          summary: "",
          updatedAt: this.clock.now().toISOString(),
        }
      : this.getScene(appSessionId, characterId);
    const next: SceneState = {
      ...current,
      ...patch,
      participants: patch.participants === undefined ? current.participants : cleanList(patch.participants),
      openThreads: patch.openThreads === undefined ? current.openThreads : cleanList(patch.openThreads),
      summary: patch.summary === undefined ? current.summary : clean(patch.summary),
      updatedAt: this.clock.now().toISOString(),
    };
    return this.memoryVault
      ? this.memoryVault.writeScene(next, this.repository.getRoleSession(appSessionId)!.characterId, toolCallId)
      : this.repository.upsertScene(next, toolCallId);
  }

  writeMemory(input: CreateMemoryInput): MemoryWriteResult {
    this.assertCharacterMemoryInput(input);
    this.memoryVault?.syncIfChanged();
    const conversationSpace = input.conversationSpace ?? "normal";
    const secretOwnerCharacterId = input.secretOwnerCharacterId;
    if (input.idempotencyKey) {
      const existing = this.repository.findMemoryByIdempotencyKey(
        input.idempotencyKey,
        conversationSpace,
        secretOwnerCharacterId,
      );
      if (existing) {
        if (existing.realm !== RP_MEMORY_REALM || existing.characterId !== input.characterId) {
          throw new RpMemoryValidationError(
            "idempotency key belongs to a different or quarantined memory",
          );
        }
        return { memory: existing, needsConfirmation: false };
      }
    }
    this.getCharacter(input.characterId);
    const content = requiredText(input.content, "content");
    const normalizedContent = normalizeMemoryContent(content);
    const duplicate = this.repository.findActiveMemoryByNormalizedContent(
      normalizedContent,
      input.characterId,
      conversationSpace,
      secretOwnerCharacterId,
    );
    if (duplicate) return { duplicate, needsConfirmation: false };
    const key = cleanOptional(input.key);
    const conflict = key
      ? this.repository.findActiveMemoryByKey(
          key,
          input.characterId,
          conversationSpace,
          secretOwnerCharacterId,
        )
      : undefined;
    if (conflict && conflict.normalizedContent !== normalizedContent && !input.confirmed) {
      return { conflict, needsConfirmation: true };
    }
    const now = this.clock.now().toISOString();
    const memory: RpMemory = {
      id: this.idGenerator.next("memory"),
      conversationSpace,
      ...(secretOwnerCharacterId ? { secretOwnerCharacterId } : {}),
      realm: RP_MEMORY_REALM,
      scope: RP_MEMORY_SCOPE,
      type: input.type,
      key,
      content,
      normalizedContent,
      sourceSessionId: cleanOptional(input.sourceSessionId),
      sourceMessageId: cleanOptional(input.sourceMessageId),
      characterId: input.characterId.trim(),
      salience: bounded(input.salience ?? 0.6),
      confidence: bounded(input.confidence ?? (input.confirmed ? 1 : 0.7)),
      validity: input.confirmed ? "active" : "pending",
      confirmed: Boolean(input.confirmed),
      tags: cleanList(input.tags ?? []),
      createdAt: now,
      updatedAt: now,
    };
    if (this.memoryVault) {
      if (conflict) {
        return {
          memory: this.memoryVault.writeMemoryPair(memory, {
            ...conflict,
            validity: "superseded",
            supersededById: memory.id,
            updatedAt: now,
          }, input.idempotencyKey),
          needsConfirmation: false,
        };
      }
      return {
        memory: this.memoryVault.writeMemory(memory, input.idempotencyKey),
        needsConfirmation: false,
      };
    }
    return this.repository.transaction(() => {
      this.repository.createMemory(memory, input.idempotencyKey);
      if (conflict) {
        this.repository.updateMemory({
          ...conflict,
          validity: "superseded",
          supersededById: memory.id,
          updatedAt: now,
        });
      }
      return { memory, needsConfirmation: false };
    });
  }

  proposeMemory(input: ProposeMemoryInput): MemoryWriteResult {
    return this.writeMemory({ ...input, confirmed: false });
  }

  searchMemories(filter: MemorySearchFilter = {}): RpMemory[] {
    this.memoryVault?.syncIfChanged();
    return this.repository.searchMemories(filter);
  }

  listAllMemories(): RpMemory[] {
    this.memoryVault?.syncIfChanged();
    return this.repository.listAllMemories();
  }

  listAllMemoriesAcrossSpaces(): RpMemory[] {
    this.memoryVault?.syncIfChanged();
    return this.repository.listAllMemoriesAcrossSpaces();
  }

  getMemory(
    id: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory {
    this.memoryVault?.syncIfChanged();
    const memory = this.repository.getMemory(id, conversationSpace, secretOwnerCharacterId);
    if (!memory) throw new RpNotFoundError("memory", id);
    return memory;
  }

  updateMemory(
    id: string,
    patch: UpdateMemoryInput,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory {
    const current = this.memoryVault
      ? this.repository.getMemory(id, conversationSpace, secretOwnerCharacterId)
      : this.getMemory(id, conversationSpace, secretOwnerCharacterId);
    if (!current) throw new RpNotFoundError("memory", id);
    if (current.validity === "deleted") throw new Error("deleted memory cannot be updated");
    if (patch.type !== undefined) {
      if (current.realm === "legacy" && patch.type !== current.type) {
        throw new RpMemoryValidationError(
          "quarantined legacy memory type is immutable; correct its content or delete it",
          "RP_MEMORY_TYPE_INVALID",
        );
      }
      if (current.realm === RP_MEMORY_REALM && !isRoleplayMemoryType(patch.type)) {
        throw new RpMemoryValidationError(
          "roleplay memory type must be relationship_event, world_fact, plot_event, or boundary; use User Profile for real-user facts and preferences",
          "RP_MEMORY_TYPE_INVALID",
        );
      }
    }
    const content = patch.content === undefined ? current.content : requiredText(patch.content, "content");
    const next: RpMemory = {
      ...current,
      ...patch,
      realm: current.realm,
      scope: current.scope,
      characterId: current.characterId,
      quarantineReasons: current.quarantineReasons,
      type: patch.type ?? current.type,
      key: patch.key === undefined ? current.key : cleanOptional(patch.key),
      content,
      normalizedContent: normalizeMemoryContent(content),
      salience: patch.salience === undefined ? current.salience : bounded(patch.salience),
      confidence: patch.confidence === undefined ? current.confidence : bounded(patch.confidence),
      tags: patch.tags === undefined ? current.tags : cleanList(patch.tags),
      validity: patch.confirmed === true && patch.validity === undefined ? "active" : patch.validity ?? current.validity,
      updatedAt: this.clock.now().toISOString(),
    };
    return this.memoryVault ? this.memoryVault.writeMemory(next) : this.repository.updateMemory(next);
  }

  deleteMemory(
    id: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory {
    const current = this.memoryVault
      ? this.repository.getMemory(id, conversationSpace, secretOwnerCharacterId)
      : this.getMemory(id, conversationSpace, secretOwnerCharacterId);
    if (!current) throw new RpNotFoundError("memory", id);
    const next: RpMemory = {
      ...current,
      validity: "deleted",
      updatedAt: this.clock.now().toISOString(),
    };
    return this.memoryVault ? this.memoryVault.writeMemory(next) : this.repository.updateMemory(next);
  }

  touchMemories(
    ids: string[],
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): void {
    if (!ids.length) return;
    if (this.memoryVault) {
      this.memoryVault.touchMemories(ids, conversationSpace, secretOwnerCharacterId);
    } else {
      this.repository.touchMemories(
        ids,
        this.clock.now().toISOString(),
        conversationSpace,
        secretOwnerCharacterId,
      );
    }
  }

  private assertCharacterMemoryInput(input: CreateMemoryInput | ProposeMemoryInput): void {
    const conversationSpace = input.conversationSpace ?? "normal";
    if (conversationSpace === "secret") {
      if (!input.secretOwnerCharacterId?.trim()) {
        throw new RpMemoryValidationError("secret character memory requires an owner character");
      }
      if (input.secretOwnerCharacterId.trim() !== input.characterId.trim()) {
        throw new RpMemoryValidationError("secret character memory owner must match characterId");
      }
    } else if (input.secretOwnerCharacterId) {
      throw new RpMemoryValidationError("normal character memory cannot have a secret owner");
    }
    if (input.realm !== RP_MEMORY_REALM || input.scope !== RP_MEMORY_SCOPE) {
      throw new RpMemoryValidationError(
        "the character-memory API accepts only roleplay/character memory; use the reality-memory control plane for global reality data",
      );
    }
    if (!input.characterId?.trim()) {
      throw new RpMemoryValidationError(
        "roleplay character memory requires characterId; use User Profile for global reality data",
      );
    }
    if (!isRoleplayMemoryType(input.type)) {
      throw new RpMemoryValidationError(
        "roleplay memory type must be relationship_event, world_fact, plot_event, or boundary; use reality memory types for real-user facts and preferences",
        "RP_MEMORY_TYPE_INVALID",
      );
    }
  }

  requestRealMutation(sessionId: string, actionType: string, payload: Record<string, unknown>): PendingRealMutation {
    const now = this.clock.now().toISOString();
    return this.repository.transaction(() => this.repository.createPendingMutation({
      id: this.idGenerator.next("confirmation"),
      sessionId,
      actionType,
      payload,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }));
  }

  getPendingRealMutation(sessionId: string, actionType: string): PendingRealMutation | undefined {
    return this.rejectExpired(this.repository.getPendingMutation(sessionId, actionType));
  }

  getLatestPendingRealMutation(sessionId: string): PendingRealMutation | undefined {
    return this.rejectExpired(this.repository.getLatestPendingMutation(sessionId));
  }

  setRealMutationStatus(id: string, status: PendingRealMutation["status"]): void {
    this.repository.setMutationStatus(id, status, this.clock.now().toISOString());
  }

  private rejectExpired(mutation: PendingRealMutation | undefined): PendingRealMutation | undefined {
    if (!mutation) return undefined;
    if (this.clock.now().getTime() - new Date(mutation.createdAt).getTime() <= 15 * 60_000) return mutation;
    this.setRealMutationStatus(mutation.id, "rejected");
    return undefined;
  }
}

function optionalModelProfileId(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value.trim() || undefined;
}

function optionalMeetingPresetId(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 200) throw new Error("meeting preset id is too long");
  return normalized;
}

function requiredText(value: string, field: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function cleanOptional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function hasLegacyCharacterFields(input: UpdateCharacterInput): boolean {
  return input.identity !== undefined ||
    input.voice !== undefined ||
    input.narrativePerspective !== undefined ||
    input.behavior !== undefined ||
    input.relationshipDefaults !== undefined ||
    input.boundaries !== undefined;
}

function cleanList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function bounded(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("score must be between 0 and 1");
  return value;
}
