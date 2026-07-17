import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { MemoryVaultService } from "../memory-vault/service.js";
import { projectRealityMemoriesIntoProfile } from "../profile/managed-memory.js";
import { normalizeMemoryContent, type RpRepository } from "../rp/repository.js";
import {
  REALITY_MEMORY_REALM,
  REALITY_MEMORY_SCOPE,
  RP_MEMORY_REALM,
  RP_MEMORY_SCOPE,
  isRealityMemoryType,
  isRoleplayMemoryType,
  type MemorySearchFilter,
  type RpMemory,
} from "../rp/types.js";
import type {
  MemoryCandidateInput,
  MemoryConfirmationResult,
  MemoryControlPlaneEdit,
} from "./types.js";

export class MemoryLifecycleError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MemoryLifecycleError";
  }
}

export class MemoryLifecycleService {
  constructor(
    private readonly repository: RpRepository,
    private readonly vault: MemoryVaultService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly profileAutoWriteEnabled: () => boolean,
  ) {}

  propose(input: MemoryCandidateInput): RpMemory {
    this.assertInput(input);
    this.vault.syncIfChanged();
    const idempotent = this.repository.findMemoryByIdempotencyKey(input.idempotencyKey);
    if (idempotent) return idempotent;
    const memory = this.buildMemory(input, false);
    return this.vault.writeMemory(memory, input.idempotencyKey);
  }

  captureAuthorized(input: MemoryCandidateInput): RpMemory {
    return this.captureConfirmed(input, "explicit_user_authorization");
  }

  createControlPlane(input: MemoryCandidateInput): RpMemory {
    return this.captureConfirmed(input, "trusted_control_plane");
  }

  private captureConfirmed(
    input: MemoryCandidateInput,
    provenanceKind: "explicit_user_authorization" | "trusted_control_plane",
  ): RpMemory {
    this.assertInput(input);
    this.vault.syncIfChanged();
    const idempotent = this.repository.findMemoryByIdempotencyKey(input.idempotencyKey);
    if (idempotent) return idempotent;
    const memory = this.buildMemory(input, true, provenanceKind);
    const conflict = memory.key
      ? this.repository.findActiveMemoryByKeyInRealm(memory.key, memory.realm, memory.characterId)
      : undefined;
    if (!conflict || conflict.normalizedContent === memory.normalizedContent) {
      return conflict ?? this.commit([
        { memory, idempotencyKey: input.idempotencyKey },
      ])[0];
    }
    const now = this.clock.now().toISOString();
    const [previous, next] = this.commit([
      { memory: { ...conflict, validity: "superseded", supersededById: memory.id, updatedAt: now } },
      { memory, idempotencyKey: input.idempotencyKey, supersedes: conflict.id },
    ]);
    void previous;
    return next;
  }

  confirm(id: string, edit: MemoryControlPlaneEdit = {}): MemoryConfirmationResult {
    this.vault.syncIfChanged();
    const current = this.require(id);
    if (current.validity !== "pending") {
      throw new MemoryLifecycleError("only pending memory can be confirmed", "MEMORY_NOT_PENDING");
    }
    const next = this.applyEdit(current, edit);
    this.assertMemoryRealmType(next);
    const now = this.clock.now().toISOString();
    const active: RpMemory = {
      ...next,
      validity: "active",
      confirmed: true,
      confirmationProvenance: {
        kind: "trusted_control_plane",
        actor: "user",
        confirmedAt: now,
        evidenceMessageId: current.sourceMessageId ?? null,
      },
      confidence: Math.max(next.confidence, 0.9),
      updatedAt: now,
    };
    const conflict = active.key
      ? this.repository.findActiveMemoryByKeyInRealm(active.key, active.realm, active.characterId)
      : undefined;
    if (!conflict || conflict.id === active.id || conflict.normalizedContent === active.normalizedContent) {
      return { memory: this.commit([{ memory: active }])[0] };
    }
    const [superseded, memory] = this.commit([
      { memory: { ...conflict, validity: "superseded", supersededById: active.id, updatedAt: now } },
      { memory: active, supersedes: conflict.id },
    ]);
    return {
      memory,
      superseded,
      diff: { previous: conflict.content, next: active.content },
    };
  }

  correct(id: string, edit: MemoryControlPlaneEdit): MemoryConfirmationResult {
    this.vault.syncIfChanged();
    const current = this.require(id);
    if (current.validity === "pending") return this.confirm(id, edit);
    if (current.validity !== "active" || !current.confirmed) {
      throw new MemoryLifecycleError("only pending or active memory can be corrected", "MEMORY_NOT_EDITABLE");
    }
    const edited = this.applyEdit(current, edit);
    this.assertMemoryRealmType(edited);
    if (edited.normalizedContent === current.normalizedContent && edited.type === current.type && edited.key === current.key) {
      throw new MemoryLifecycleError("memory correction has no changes", "MEMORY_EDIT_UNCHANGED");
    }
    const now = this.clock.now().toISOString();
    const replacement: RpMemory = {
      ...edited,
      id: this.idGenerator.next("memory"),
      validity: "active",
      confirmed: true,
      confirmationProvenance: {
        kind: "trusted_control_plane",
        actor: "user",
        confirmedAt: now,
        evidenceMessageId: current.sourceMessageId ?? null,
      },
      supersededById: undefined,
      createdAt: now,
      updatedAt: now,
    };
    const [superseded, memory] = this.commit([
      { memory: { ...current, validity: "superseded", supersededById: replacement.id, updatedAt: now } },
      { memory: replacement, supersedes: current.id },
    ]);
    return {
      memory,
      superseded,
      diff: { previous: current.content, next: replacement.content },
    };
  }

  reject(id: string, reason = "rejected_by_user"): RpMemory {
    return this.transition(id, "rejected", reason);
  }

  archive(id: string, reason = "archived_by_user"): RpMemory {
    return this.transition(id, "archived", reason);
  }

  forget(id: string, reason = "forgotten_by_user"): RpMemory {
    return this.transition(id, "deleted", reason);
  }

  get(id: string): RpMemory {
    this.vault.syncIfChanged();
    return this.require(id);
  }

  list(filter: MemorySearchFilter = {}): RpMemory[] {
    this.vault.syncIfChanged();
    return filter.validity || filter.validities
      ? this.repository.searchMemories(filter)
      : this.repository.listAllMemories().filter((memory) => {
          if (filter.realm && memory.realm !== filter.realm) return false;
          if (filter.characterId && memory.characterId !== filter.characterId) return false;
          if (filter.type && memory.type !== filter.type) return false;
          return true;
        }).slice(0, filter.limit ?? 100);
  }

  searchConfirmed(filter: Omit<MemorySearchFilter, "validity" | "validities" | "confirmedOnly">): RpMemory[] {
    this.vault.syncIfChanged();
    return this.repository.searchMemories({ ...filter, validity: "active", confirmedOnly: true });
  }

  pendingCandidateCount(): number {
    this.vault.syncIfChanged();
    return this.repository.listAllMemories().filter((memory) =>
      memory.realm !== "legacy" && memory.validity === "pending" && !memory.confirmed
    ).length;
  }

  private transition(id: string, validity: "rejected" | "archived" | "deleted", reason: string): RpMemory {
    this.vault.syncIfChanged();
    const current = this.require(id);
    if (current.validity === "deleted") return current;
    if (validity === "rejected" && current.validity !== "pending") {
      throw new MemoryLifecycleError("only pending memory can be rejected", "MEMORY_NOT_PENDING");
    }
    const now = this.clock.now().toISOString();
    const next: RpMemory = {
      ...current,
      validity,
      ...(validity === "rejected" ? { confirmed: false, confirmationProvenance: undefined, rejectedAt: now } : {}),
      ...(validity === "archived" ? { archivedAt: now } : {}),
      ...(validity === "deleted" ? { deletedAt: now } : {}),
      statusReason: cleanText(reason, "reason", 500),
      updatedAt: now,
    };
    return this.commit([{ memory: next }])[0];
  }

  private commit(
    entries: Array<{ memory: RpMemory; idempotencyKey?: string; supersedes?: string }>,
  ): RpMemory[] {
    const changesReality = entries.some((entry) => entry.memory.realm === REALITY_MEMORY_REALM);
    let profileMarkdown: string | undefined;
    if (changesReality && this.profileAutoWriteEnabled()) {
      const projected = new Map(
        this.repository.listAllMemories()
          .filter((memory) => memory.realm === REALITY_MEMORY_REALM)
          .map((memory) => [memory.id, memory]),
      );
      for (const entry of entries) projected.set(entry.memory.id, entry.memory);
      const active = [...projected.values()].filter(
        (memory) => memory.validity === "active" && memory.confirmed,
      );
      const currentProfile = this.vault.getProfile()?.markdown ?? "# 用户画像\n";
      profileMarkdown = projectRealityMemoriesIntoProfile(currentProfile, active);
    }
    return this.vault.writeMemoriesAtomically(entries, profileMarkdown);
  }

  private buildMemory(
    input: MemoryCandidateInput,
    active: boolean,
    provenanceKind: "explicit_user_authorization" | "trusted_control_plane" = "explicit_user_authorization",
  ): RpMemory {
    const now = this.clock.now().toISOString();
    const content = cleanText(input.content, "content", 2_000);
    return {
      id: this.idGenerator.next("memory"),
      realm: input.realm,
      scope: input.realm === REALITY_MEMORY_REALM ? REALITY_MEMORY_SCOPE : RP_MEMORY_SCOPE,
      type: input.type,
      key: optionalText(input.key, 240),
      content,
      normalizedContent: normalizeMemoryContent(content),
      sourceSessionId: cleanText(input.sourceSessionId, "sourceSessionId", 240),
      sourceMessageId: cleanText(input.sourceMessageId, "sourceMessageId", 240),
      ...(input.realm === RP_MEMORY_REALM ? { characterId: cleanText(input.characterId, "characterId", 240) } : {}),
      salience: bounded(input.salience ?? 0.65),
      confidence: bounded(input.confidence ?? (active ? 1 : 0.7)),
      validity: active ? "active" : "pending",
      confirmed: active,
      ...(active ? {
        confirmationProvenance: {
          kind: provenanceKind,
          actor: "user" as const,
          confirmedAt: now,
          evidenceMessageId: input.sourceMessageId,
        },
      } : {}),
      tags: cleanTags(input.tags ?? []),
      createdAt: now,
      updatedAt: now,
    };
  }

  private applyEdit(current: RpMemory, edit: MemoryControlPlaneEdit): RpMemory {
    const content = edit.content === undefined ? current.content : cleanText(edit.content, "content", 2_000);
    return {
      ...current,
      ...edit,
      type: edit.type ?? current.type,
      key: edit.key === undefined ? current.key : optionalText(edit.key, 240),
      content,
      normalizedContent: normalizeMemoryContent(content),
      salience: edit.salience === undefined ? current.salience : bounded(edit.salience),
      confidence: edit.confidence === undefined ? current.confidence : bounded(edit.confidence),
      tags: edit.tags === undefined ? current.tags : cleanTags(edit.tags),
    };
  }

  private assertInput(input: MemoryCandidateInput): void {
    if (!input.idempotencyKey.trim()) throw new MemoryLifecycleError("idempotencyKey is required", "MEMORY_IDEMPOTENCY_REQUIRED");
    this.assertMemoryRealmType({
      realm: input.realm,
      type: input.type,
      characterId: input.characterId,
    });
  }

  private assertMemoryRealmType(memory: Pick<RpMemory, "realm" | "type" | "characterId">): void {
    if (memory.realm === REALITY_MEMORY_REALM) {
      if (memory.characterId || !isRealityMemoryType(memory.type)) {
        throw new MemoryLifecycleError(
          "reality memory must be global and use user_fact, preference, goal, person, project, or boundary",
          "REALITY_MEMORY_CONTRACT_INVALID",
        );
      }
      return;
    }
    if (memory.realm !== RP_MEMORY_REALM || !memory.characterId || !isRoleplayMemoryType(memory.type)) {
      throw new MemoryLifecycleError(
        "roleplay memory requires a character and an RP-only type",
        "ROLEPLAY_MEMORY_CONTRACT_INVALID",
      );
    }
  }

  private require(id: string): RpMemory {
    const memory = this.repository.getMemory(id);
    if (!memory) throw new MemoryLifecycleError(`memory not found: ${id}`, "MEMORY_NOT_FOUND");
    return memory;
  }
}

function cleanText(value: string | undefined, field: string, max: number): string {
  const text = value?.trim();
  if (!text) throw new MemoryLifecycleError(`${field} is required`, "MEMORY_INPUT_INVALID");
  if ([...text].length > max) throw new MemoryLifecycleError(`${field} exceeds ${max} characters`, "MEMORY_INPUT_TOO_LONG");
  return text;
}

function optionalText(value: string | undefined, max: number): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if ([...text].length > max) throw new MemoryLifecycleError(`value exceeds ${max} characters`, "MEMORY_INPUT_TOO_LONG");
  return text;
}

function bounded(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryLifecycleError("score must be between 0 and 1", "MEMORY_INPUT_INVALID");
  }
  return value;
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}
