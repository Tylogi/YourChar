import type { SQLInputValue } from "node:sqlite";
import type { AppDatabase } from "../storage/database.js";
import type { ConversationSpace } from "../domain/types.js";
import {
  LEGACY_MEMORY_REALM,
  LEGACY_MEMORY_SCOPE,
  REALITY_MEMORY_REALM,
  REALITY_MEMORY_SCOPE,
  RP_MEMORY_REALM,
  RP_MEMORY_SCOPE,
  type CharacterProfile,
  type MemorySearchFilter,
  type MemoryRealm,
  type MemoryType,
  type PendingRealMutation,
  type RoleSession,
  type RpMemory,
  type SceneState,
} from "./types.js";
import {
  CHARACTER_SOUL_MAX_CHARACTERS,
  legacyCharacterSoulMarkdown,
} from "./soul.js";

type Row = Record<string, unknown>;

export class RpRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  createCharacter(character: CharacterProfile): CharacterProfile {
    this.database.connection.prepare(`
      INSERT INTO characters(
        id, name, identity, voice, narrative_perspective, behavior,
        relationship_defaults, boundaries_json, model_profile_id,
        meeting_preset_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      character.id,
      character.name,
      "",
      "",
      "third_person",
      "",
      "",
      "[]",
      character.modelProfileId ?? null,
      character.meetingPresetId ?? null,
      character.createdAt,
      character.updatedAt,
    );
    return character;
  }

  getCharacter(id: string): CharacterProfile | undefined {
    const row = this.database.connection.prepare("SELECT * FROM characters WHERE id = ?").get(id) as Row | undefined;
    return row ? mapCharacter(row) : undefined;
  }

  listCharacters(): CharacterProfile[] {
    return (this.database.connection.prepare("SELECT * FROM characters ORDER BY name, id").all() as Row[]).map(mapCharacter);
  }

  updateCharacter(character: CharacterProfile): CharacterProfile {
    this.database.connection.prepare(`
      UPDATE characters
      SET name = ?, model_profile_id = ?, meeting_preset_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      character.name,
      character.modelProfileId ?? null,
      character.meetingPresetId ?? null,
      character.updatedAt,
      character.id,
    );
    return character;
  }

  clearModelProfileBindings(modelProfileId: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE characters SET model_profile_id = NULL WHERE model_profile_id = ?
    `).run(modelProfileId).changes);
  }

  getRoleSession(appSessionId: string): RoleSession | undefined {
    const row = this.database.connection.prepare("SELECT * FROM role_sessions WHERE app_session_id = ?").get(appSessionId) as Row | undefined;
    return row ? mapRoleSession(row) : undefined;
  }

  createRoleSession(session: RoleSession): RoleSession {
    this.database.connection.prepare(`
      INSERT INTO role_sessions(
        app_session_id, character_id, world_id, status, continuity_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.appSessionId,
      session.characterId,
      session.worldId ?? null,
      session.status,
      JSON.stringify(session.continuity),
      session.createdAt,
      session.updatedAt,
    );
    return session;
  }

  listRoleSessions(): RoleSession[] {
    return (this.database.connection.prepare("SELECT * FROM role_sessions ORDER BY app_session_id").all() as Row[]).map(mapRoleSession);
  }

  getScene(roleSessionId: string): SceneState | undefined {
    const row = this.database.connection.prepare("SELECT * FROM scene_states WHERE role_session_id = ?").get(roleSessionId) as Row | undefined;
    return row ? mapScene(row) : undefined;
  }

  listScenes(): SceneState[] {
    return (this.database.connection.prepare("SELECT * FROM scene_states ORDER BY role_session_id").all() as Row[]).map(mapScene);
  }

  listScenesForMigration(): Array<{ scene: SceneState; idempotencyKey?: string }> {
    return (this.database.connection.prepare("SELECT * FROM scene_states ORDER BY role_session_id").all() as Row[])
      .map((row) => ({
        scene: mapScene(row),
        ...(optionalString(row.last_tool_call_id) ? { idempotencyKey: optionalString(row.last_tool_call_id) } : {}),
      }));
  }

  getSceneByToolCallId(toolCallId: string): SceneState | undefined {
    const row = this.database.connection.prepare("SELECT * FROM scene_states WHERE last_tool_call_id = ?").get(toolCallId) as Row | undefined;
    return row ? mapScene(row) : undefined;
  }

  upsertScene(scene: SceneState, toolCallId?: string): SceneState {
    this.database.connection.prepare(`
      INSERT INTO scene_states(
        role_session_id, location, in_world_time, participants_json,
        current_objective, open_threads_json, summary, last_tool_call_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role_session_id) DO UPDATE SET
        location = excluded.location,
        in_world_time = excluded.in_world_time,
        participants_json = excluded.participants_json,
        current_objective = excluded.current_objective,
        open_threads_json = excluded.open_threads_json,
        summary = excluded.summary,
        last_tool_call_id = excluded.last_tool_call_id,
        updated_at = excluded.updated_at
    `).run(
      scene.roleSessionId,
      scene.location ?? null,
      scene.inWorldTime ?? null,
      JSON.stringify(scene.participants),
      scene.currentObjective ?? null,
      JSON.stringify(scene.openThreads),
      scene.summary,
      toolCallId ?? null,
      scene.updatedAt,
    );
    return scene;
  }

  findMemoryByIdempotencyKey(
    key: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory | undefined {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE idempotency_key = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).get(
      storedIdempotencyKey(key, conversationSpace, secretOwnerCharacterId),
      conversationSpace,
      secretOwnerCharacterId ?? null,
    ) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  getMemory(
    id: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory | undefined {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).get(id, conversationSpace, secretOwnerCharacterId ?? null) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  findActiveMemoryByNormalizedContent(
    normalizedContent: string,
    characterId: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory | undefined {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE normalized_content = ? AND validity = 'active'
        AND character_id = ?
        AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
        AND type IN ('relationship_event', 'world_fact', 'plot_event', 'boundary')
      LIMIT 1
    `).get(normalizedContent, characterId, conversationSpace, secretOwnerCharacterId ?? null) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  findActiveMemoryByKey(
    key: string,
    characterId: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory | undefined {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE memory_key = ? AND validity = 'active'
        AND character_id = ?
        AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
        AND type IN ('relationship_event', 'world_fact', 'plot_event', 'boundary')
      ORDER BY updated_at DESC LIMIT 1
    `).get(key, characterId, conversationSpace, secretOwnerCharacterId ?? null) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  findActiveMemoryByNormalizedContentInRealm(
    normalizedContent: string,
    realm: MemoryRealm,
    characterId?: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory | undefined {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE normalized_content = ? AND validity = 'active' AND confirmed = 1
        AND realm = ? AND COALESCE(character_id, '') = COALESCE(?, '')
        AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      LIMIT 1
    `).get(
      normalizedContent,
      realm,
      characterId ?? null,
      conversationSpace,
      secretOwnerCharacterId ?? null,
    ) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  findActiveMemoryByKeyInRealm(
    key: string,
    realm: MemoryRealm,
    characterId?: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory | undefined {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE memory_key = ? AND validity = 'active' AND confirmed = 1
        AND realm = ? AND COALESCE(character_id, '') = COALESCE(?, '')
        AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY updated_at DESC LIMIT 1
    `).get(
      key,
      realm,
      characterId ?? null,
      conversationSpace,
      secretOwnerCharacterId ?? null,
    ) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  createMemory(memory: RpMemory, idempotencyKey?: string): RpMemory {
    this.database.connection.prepare(`
      INSERT INTO rp_memories(
        id, conversation_space, secret_owner_character_id,
        realm, scope, type, memory_key, content, normalized_content, source_session_id,
        source_message_id, character_id, salience, confidence, validity,
        confirmed, confirmation_kind, confirmed_at, confirmation_evidence_message_id,
        rejected_at, archived_at, deleted_at, status_reason,
        tags_json, superseded_by_id, idempotency_key,
        created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.conversationSpace,
      memory.secretOwnerCharacterId ?? null,
      memory.realm,
      memory.scope,
      memory.type,
      memory.key ?? null,
      memory.content,
      memory.normalizedContent,
      memory.sourceSessionId ?? null,
      memory.sourceMessageId ?? null,
      memory.characterId ?? null,
      memory.salience,
      memory.confidence,
      memory.validity,
      memory.confirmed ? 1 : 0,
      memory.confirmationProvenance?.kind ?? null,
      memory.confirmationProvenance?.confirmedAt ?? null,
      memory.confirmationProvenance?.evidenceMessageId ?? null,
      memory.rejectedAt ?? null,
      memory.archivedAt ?? null,
      memory.deletedAt ?? null,
      memory.statusReason ?? null,
      JSON.stringify(memory.tags),
      memory.supersededById ?? null,
      idempotencyKey
        ? storedIdempotencyKey(
            idempotencyKey,
            memory.conversationSpace,
            memory.secretOwnerCharacterId,
          )
        : null,
      memory.createdAt,
      memory.updatedAt,
      memory.lastUsedAt ?? null,
    );
    this.indexMemory(memory);
    return memory;
  }

  updateMemory(memory: RpMemory): RpMemory {
    this.database.connection.prepare(`
      UPDATE rp_memories SET type = ?, memory_key = ?, content = ?, normalized_content = ?,
        salience = ?, confidence = ?, validity = ?, confirmed = ?, tags_json = ?,
        confirmation_kind = ?, confirmed_at = ?, confirmation_evidence_message_id = ?,
        rejected_at = ?, archived_at = ?, deleted_at = ?, status_reason = ?,
        superseded_by_id = ?, updated_at = ?, last_used_at = ?
        WHERE id = ? AND conversation_space = ?
          AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).run(
      memory.type,
      memory.key ?? null,
      memory.content,
      memory.normalizedContent,
      memory.salience,
      memory.confidence,
      memory.validity,
      memory.confirmed ? 1 : 0,
      JSON.stringify(memory.tags),
      memory.confirmationProvenance?.kind ?? null,
      memory.confirmationProvenance?.confirmedAt ?? null,
      memory.confirmationProvenance?.evidenceMessageId ?? null,
      memory.rejectedAt ?? null,
      memory.archivedAt ?? null,
      memory.deletedAt ?? null,
      memory.statusReason ?? null,
      memory.supersededById ?? null,
      memory.updatedAt,
      memory.lastUsedAt ?? null,
      memory.id,
      memory.conversationSpace,
      memory.secretOwnerCharacterId ?? null,
    );
    this.database.connection.prepare(`
      DELETE FROM rp_memories_fts
      WHERE memory_id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).run(memory.id, memory.conversationSpace, memory.secretOwnerCharacterId ?? null);
    if (!["rejected", "archived", "deleted"].includes(memory.validity)) this.indexMemory(memory);
    return memory;
  }

  searchMemories(filter: MemorySearchFilter): RpMemory[] {
    const values: SQLInputValue[] = [];
    const clauses: string[] = [];
    const conversationSpace = filter.conversationSpace ?? "normal";
    assertMemorySpace(conversationSpace, filter.secretOwnerCharacterId);
    clauses.push("m.conversation_space = ?");
    values.push(conversationSpace);
    clauses.push("COALESCE(m.secret_owner_character_id, '') = COALESCE(?, '')");
    values.push(filter.secretOwnerCharacterId ?? null);
    if (filter.validities?.length) {
      clauses.push(`m.validity IN (${filter.validities.map(() => "?").join(", ")})`);
      values.push(...filter.validities);
    } else {
      clauses.push("m.validity = ?");
      values.push(filter.validity ?? "active");
    }
    if (filter.confirmedOnly) clauses.push("m.confirmed = 1");
    if (filter.characterId) {
      clauses.push("m.character_id = ?");
      values.push(filter.characterId);
    }
    if (filter.realm === RP_MEMORY_REALM) {
      clauses.push("m.realm = 'roleplay'");
    } else if (filter.realm === REALITY_MEMORY_REALM) {
      clauses.push("m.realm = 'reality'");
    } else if (filter.realm === LEGACY_MEMORY_REALM) {
      clauses.push("m.realm = 'legacy'");
    }
    if (filter.type) {
      clauses.push("m.type = ?");
      values.push(filter.type);
    } else if (filter.types?.length) {
      clauses.push(`m.type IN (${filter.types.map(() => "?").join(", ")})`);
      values.push(...filter.types);
    }
    if (filter.query?.trim()) {
      clauses.push(`(
        m.normalized_content LIKE ? OR m.tags_json LIKE ? OR m.id IN (
          SELECT memory_id FROM rp_memories_fts WHERE rp_memories_fts MATCH ?
        )
      )`);
      const normalized = normalizeMemoryContent(filter.query);
      values.push(`%${normalized}%`, `%${filter.query.trim()}%`, ftsQuery(filter.query));
    }
    values.push(Math.min(Math.max(filter.limit ?? 20, 1), 100));
    const rows = this.database.connection.prepare(`
      SELECT m.* FROM rp_memories m
      WHERE ${clauses.join(" AND ")}
      ORDER BY m.salience DESC, COALESCE(m.last_used_at, m.updated_at) DESC, m.id
      LIMIT ?
    `).all(...values) as Row[];
    return rows.map(mapMemory);
  }

  rankMemoryFts(input: {
    query: string;
    realm: "reality" | "roleplay";
    conversationSpace?: ConversationSpace;
    secretOwnerCharacterId?: string;
    characterId?: string;
    limit?: number;
  }): Map<string, number> {
    if (!input.query.trim()) return new Map();
    const conversationSpace = input.conversationSpace ?? "normal";
    assertMemorySpace(conversationSpace, input.secretOwnerCharacterId);
    const clauses = [
      "m.conversation_space = ?",
      "COALESCE(m.secret_owner_character_id, '') = COALESCE(?, '')",
      "m.realm = ?",
      "m.validity = 'active'",
      "m.confirmed = 1",
    ];
    const values: SQLInputValue[] = [
      ftsQuery(input.query),
      conversationSpace,
      input.secretOwnerCharacterId ?? null,
      input.realm,
    ];
    if (input.realm === "roleplay") {
      if (!input.characterId) return new Map();
      clauses.push("m.character_id = ?");
      values.push(input.characterId);
    } else {
      clauses.push("m.character_id IS NULL");
    }
    values.push(Math.min(Math.max(input.limit ?? 100, 1), 100));
    const rows = this.database.connection.prepare(`
      SELECT m.id, bm25(rp_memories_fts) AS rank
      FROM rp_memories_fts
      JOIN rp_memories m ON m.id = rp_memories_fts.memory_id
      WHERE rp_memories_fts MATCH ? AND ${clauses.join(" AND ")}
      ORDER BY rank, m.id
      LIMIT ?
    `).all(...values) as Array<{ id: string; rank: number }>;
    return new Map(rows.map((row) => [String(row.id), Number(row.rank)]));
  }

  listAllMemories(
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): RpMemory[] {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    return (this.database.connection.prepare(`
      SELECT * FROM rp_memories
      WHERE conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY created_at, id
    `).all(conversationSpace, secretOwnerCharacterId ?? null) as Row[]).map(mapMemory);
  }

  listAllMemoriesAcrossSpaces(): RpMemory[] {
    return (this.database.connection.prepare(
      "SELECT * FROM rp_memories ORDER BY created_at, id",
    ).all() as Row[]).map(mapMemory);
  }

  listAllMemoriesForMigration(): Array<{ memory: RpMemory; idempotencyKey?: string }> {
    return (this.database.connection.prepare("SELECT * FROM rp_memories ORDER BY created_at, id").all() as Row[])
      .map((row) => ({
        memory: mapMemory(row),
        ...(optionalString(row.idempotency_key)
          ? { idempotencyKey: exposedIdempotencyKey(optionalString(row.idempotency_key)!) }
          : {}),
      }));
  }

  touchMemories(
    ids: string[],
    usedAt: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): void {
    assertMemorySpace(conversationSpace, secretOwnerCharacterId);
    const statement = this.database.connection.prepare(`
      UPDATE rp_memories SET last_used_at = ?
      WHERE id = ? AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `);
    for (const id of ids) {
      statement.run(usedAt, id, conversationSpace, secretOwnerCharacterId ?? null);
    }
  }

  createPendingMutation(mutation: PendingRealMutation): PendingRealMutation {
    this.database.connection.prepare(`
      UPDATE pending_real_mutations SET status = 'rejected', updated_at = ?
      WHERE session_id = ? AND action_type = ? AND status = 'pending'
    `).run(mutation.updatedAt, mutation.sessionId, mutation.actionType);
    this.database.connection.prepare(`
      INSERT INTO pending_real_mutations(
        id, session_id, action_type, payload_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      mutation.id,
      mutation.sessionId,
      mutation.actionType,
      JSON.stringify(mutation.payload),
      mutation.status,
      mutation.createdAt,
      mutation.updatedAt,
    );
    return mutation;
  }

  getPendingMutation(sessionId: string, actionType: string): PendingRealMutation | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM pending_real_mutations
      WHERE session_id = ? AND action_type = ? AND status = 'pending'
      ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId, actionType) as Row | undefined;
    return row ? mapPendingMutation(row) : undefined;
  }

  getLatestPendingMutation(sessionId: string): PendingRealMutation | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM pending_real_mutations
      WHERE session_id = ? AND status = 'pending'
      ORDER BY updated_at DESC LIMIT 1
    `).get(sessionId) as Row | undefined;
    return row ? mapPendingMutation(row) : undefined;
  }

  setMutationStatus(id: string, status: PendingRealMutation["status"], updatedAt: string): void {
    this.database.connection.prepare(
      "UPDATE pending_real_mutations SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, updatedAt, id);
  }

  listPendingMutations(): PendingRealMutation[] {
    return (this.database.connection.prepare(
      "SELECT * FROM pending_real_mutations ORDER BY created_at, id",
    ).all() as Row[]).map(mapPendingMutation);
  }

  deleteSessionData(sessionId: string): { roleSessions: number; pendingMutations: number } {
    return this.database.transaction(() => {
      const pendingMutations = Number(this.database.connection.prepare(
        "DELETE FROM pending_real_mutations WHERE session_id = ?",
      ).run(sessionId).changes);
      const roleSessions = Number(this.database.connection.prepare(
        "DELETE FROM role_sessions WHERE app_session_id = ?",
      ).run(sessionId).changes);
      return { roleSessions, pendingMutations };
    });
  }

  private indexMemory(memory: RpMemory): void {
    this.database.connection.prepare(
      `INSERT INTO rp_memories_fts(
        memory_id, conversation_space, secret_owner_character_id, content, tags
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      memory.id,
      memory.conversationSpace,
      memory.secretOwnerCharacterId ?? null,
      memory.content,
      memory.tags.join(" "),
    );
  }
}

export function normalizeMemoryContent(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）]+/g, "");
}

function ftsQuery(value: string): string {
  const terms = value.trim().split(/\s+/).filter(Boolean).slice(0, 12);
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") || '""';
}

function mapCharacter(row: Row): CharacterProfile {
  const soulMarkdown = legacyCharacterSoulMarkdown({
    name: String(row.name),
    identity: String(row.identity),
    voice: String(row.voice),
    narrativePerspective: row.narrative_perspective === "first_person" ? "first_person" : "third_person",
    behavior: String(row.behavior),
    relationshipDefaults: String(row.relationship_defaults),
    boundaries: parseStringArray(row.boundaries_json),
  });
  return {
    id: String(row.id),
    name: String(row.name),
    modelProfileId: optionalString(row.model_profile_id),
    meetingPresetId: optionalString(row.meeting_preset_id),
    soulMarkdown,
    soulCharacterCount: [...soulMarkdown].length,
    soulMaxCharacters: CHARACTER_SOUL_MAX_CHARACTERS,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRoleSession(row: Row): RoleSession {
  return {
    appSessionId: String(row.app_session_id),
    characterId: String(row.character_id),
    worldId: optionalString(row.world_id),
    status: row.status === "archived" ? "archived" : "active",
    continuity: parseRecord(row.continuity_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapScene(row: Row): SceneState {
  return {
    roleSessionId: String(row.role_session_id),
    location: optionalString(row.location),
    inWorldTime: optionalString(row.in_world_time),
    participants: parseStringArray(row.participants_json),
    currentObjective: optionalString(row.current_objective),
    openThreads: parseStringArray(row.open_threads_json),
    summary: String(row.summary),
    updatedAt: String(row.updated_at),
  };
}

function mapMemory(row: Row): RpMemory {
  const characterId = optionalString(row.character_id);
  const type = String(row.type) as MemoryType;
  const realm = row.realm === REALITY_MEMORY_REALM
    ? REALITY_MEMORY_REALM
    : row.realm === RP_MEMORY_REALM
      ? RP_MEMORY_REALM
      : LEGACY_MEMORY_REALM;
  const quarantined = realm === LEGACY_MEMORY_REALM;
  const quarantineReasons = [
    !characterId ? "missing_character" as const : undefined,
    type === "user_fact" || type === "preference" ? "disallowed_profile_type" as const : undefined,
  ].filter((reason): reason is NonNullable<typeof reason> => Boolean(reason));
  const confirmationKind = row.confirmation_kind === "explicit_user_authorization"
    ? "explicit_user_authorization" as const
    : row.confirmation_kind === "trusted_control_plane"
      ? "trusted_control_plane" as const
      : undefined;
  return {
    id: String(row.id),
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    ...(optionalString(row.secret_owner_character_id)
      ? { secretOwnerCharacterId: optionalString(row.secret_owner_character_id) }
      : {}),
    realm,
    scope: realm === REALITY_MEMORY_REALM
      ? REALITY_MEMORY_SCOPE
      : quarantined ? LEGACY_MEMORY_SCOPE : RP_MEMORY_SCOPE,
    type,
    key: optionalString(row.memory_key),
    content: String(row.content),
    normalizedContent: String(row.normalized_content),
    sourceSessionId: optionalString(row.source_session_id),
    sourceMessageId: optionalString(row.source_message_id),
    characterId,
    quarantineReasons: quarantined ? quarantineReasons : undefined,
    salience: Number(row.salience),
    confidence: Number(row.confidence),
    validity: row.validity as RpMemory["validity"],
    confirmed: Boolean(row.confirmed),
    ...(confirmationKind && optionalString(row.confirmed_at) ? {
      confirmationProvenance: {
        kind: confirmationKind,
        actor: "user" as const,
        confirmedAt: optionalString(row.confirmed_at)!,
        evidenceMessageId: optionalString(row.confirmation_evidence_message_id) ?? null,
      },
    } : {}),
    ...(optionalString(row.rejected_at) ? { rejectedAt: optionalString(row.rejected_at) } : {}),
    ...(optionalString(row.archived_at) ? { archivedAt: optionalString(row.archived_at) } : {}),
    ...(optionalString(row.deleted_at) ? { deletedAt: optionalString(row.deleted_at) } : {}),
    ...(optionalString(row.status_reason) ? { statusReason: optionalString(row.status_reason) } : {}),
    tags: parseStringArray(row.tags_json),
    supersededById: optionalString(row.superseded_by_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastUsedAt: optionalString(row.last_used_at),
  };
}

function assertMemorySpace(
  conversationSpace: ConversationSpace,
  secretOwnerCharacterId?: string,
): void {
  if (conversationSpace === "secret" && !secretOwnerCharacterId?.trim()) {
    throw new Error("secret memory scope requires secretOwnerCharacterId");
  }
  if (conversationSpace === "normal" && secretOwnerCharacterId) {
    throw new Error("normal memory scope cannot have secretOwnerCharacterId");
  }
}

export function storedIdempotencyKey(
  key: string,
  conversationSpace: ConversationSpace,
  secretOwnerCharacterId?: string,
): string {
  assertMemorySpace(conversationSpace, secretOwnerCharacterId);
  return conversationSpace === "secret"
    ? `v37:secret:${secretOwnerCharacterId}:${key}`
    : `v37:normal:${key}`;
}

function exposedIdempotencyKey(value: string): string {
  if (value.startsWith("v37:normal:")) return value.slice("v37:normal:".length);
  const secret = /^v37:secret:[A-Za-z0-9_-]+:(.*)$/su.exec(value);
  return secret?.[1] ?? value;
}

function mapPendingMutation(row: Row): PendingRealMutation {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    actionType: String(row.action_type),
    payload: parseRecord(row.payload_json),
    status: row.status as PendingRealMutation["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
