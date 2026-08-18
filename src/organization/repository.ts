import type { AppDatabase } from "../storage/database.js";
import type { ConversationSpace } from "../domain/types.js";
import type {
  CharacterCapability,
  CharacterCapabilityEvidence,
  CharacterCapabilityEvidenceSummary,
  CharacterCapabilityId,
  CharacterFunctionProfile,
  CharacterSkillVersion,
} from "./types.js";

type Row = Record<string, unknown>;

export class CharacterCapabilityRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  getProfile(characterId: string): CharacterFunctionProfile | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_function_profiles WHERE character_id = ?
    `).get(characterId) as Row | undefined;
    return row ? mapProfile(row) : undefined;
  }

  upsertProfile(profile: CharacterFunctionProfile): CharacterFunctionProfile {
    this.database.connection.prepare(`
      INSERT INTO character_function_profiles(
        character_id, public_role, task_preferences, avoided_tasks,
        max_concurrent_tasks, manual_locked, inference_status, source_soul_hash,
        inference_error, inference_started_at, inferred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        public_role = excluded.public_role,
        task_preferences = excluded.task_preferences,
        avoided_tasks = excluded.avoided_tasks,
        max_concurrent_tasks = excluded.max_concurrent_tasks,
        manual_locked = excluded.manual_locked,
        inference_status = excluded.inference_status,
        source_soul_hash = excluded.source_soul_hash,
        inference_error = excluded.inference_error,
        inference_started_at = excluded.inference_started_at,
        inferred_at = excluded.inferred_at,
        updated_at = excluded.updated_at
    `).run(
      profile.characterId,
      profile.publicRole,
      profile.taskPreferences,
      profile.avoidedTasks,
      profile.maxConcurrentTasks,
      profile.manualLocked ? 1 : 0,
      profile.inferenceStatus,
      profile.sourceSoulHash,
      profile.inferenceError,
      profile.inferenceStartedAt ?? null,
      profile.inferredAt ?? null,
      profile.createdAt,
      profile.updatedAt,
    );
    return this.getProfile(profile.characterId)!;
  }

  listCapabilities(characterId: string): CharacterCapability[] {
    return (this.database.connection.prepare(`
      SELECT * FROM character_capabilities
      WHERE character_id = ?
      ORDER BY capability_id
    `).all(characterId) as Row[]).map(mapCapability);
  }

  replaceCapabilities(
    characterId: string,
    capabilities: CharacterCapability[],
  ): CharacterCapability[] {
    this.database.connection.prepare(
      "DELETE FROM character_capabilities WHERE character_id = ?",
    ).run(characterId);
    const insert = this.database.connection.prepare(`
      INSERT INTO character_capabilities(
        character_id, capability_id, level, responsibility, auto_accept,
        module_ids_json, notes, source, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const capability of capabilities) {
      insert.run(
        characterId,
        capability.capabilityId,
        capability.level,
        capability.responsibility,
        capability.autoAccept ? 1 : 0,
        JSON.stringify(capability.moduleIds),
        capability.notes,
        capability.source,
        capability.confidence,
        capability.createdAt,
        capability.updatedAt,
      );
    }
    return this.listCapabilities(characterId);
  }

  countActiveTasks(characterId: string): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM character_channel_episodes
      WHERE target_character_id = ?
        AND kind = 'collaboration'
        AND status IN ('queued', 'running')
    `).get(characterId) as Row;
    return Number(row.count ?? 0);
  }

  countCompletedTasks(characterId: string): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(DISTINCT source_task_id) AS count
      FROM character_capability_evidence
      WHERE character_id = ? AND outcome = 'completed'
    `).get(characterId) as Row;
    return Number(row.count ?? 0);
  }

  createEvidence(evidence: CharacterCapabilityEvidence): CharacterCapabilityEvidence {
    this.database.connection.prepare(`
      INSERT INTO character_capability_evidence(
        id, character_id, capability_id, source_task_id, outcome,
        functional_score, judge_score, summary, lesson, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_task_id, capability_id) DO NOTHING
    `).run(
      evidence.id,
      evidence.characterId,
      evidence.capabilityId,
      evidence.sourceTaskId,
      evidence.outcome,
      evidence.functionalScore ?? null,
      evidence.judgeScore ?? null,
      evidence.summary,
      evidence.lesson,
      evidence.createdAt,
    );
    return this.findEvidence(evidence.sourceTaskId, evidence.capabilityId)!;
  }

  findEvidence(
    sourceTaskId: string,
    capabilityId: CharacterCapabilityId,
  ): CharacterCapabilityEvidence | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_capability_evidence
      WHERE source_task_id = ? AND capability_id = ?
    `).get(sourceTaskId, capabilityId) as Row | undefined;
    return row ? mapEvidence(row) : undefined;
  }

  listEvidence(characterId: string, limit = 100): CharacterCapabilityEvidence[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    return (this.database.connection.prepare(`
      SELECT * FROM character_capability_evidence
      WHERE character_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(characterId, bounded) as Row[]).map(mapEvidence);
  }

  setEvidenceLesson(sourceTaskId: string, lesson: string): void {
    this.database.connection.prepare(`
      UPDATE character_capability_evidence
      SET lesson = ?
      WHERE source_task_id = ?
    `).run(lesson, sourceTaskId);
  }

  summarizeEvidence(characterId: string): CharacterCapabilityEvidenceSummary[] {
    const rows = this.database.connection.prepare(`
      SELECT
        capability_id,
        COUNT(*) AS total,
        SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN outcome = 'declined' THEN 1 ELSE 0 END) AS declined,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE
          WHEN functional_score IS NOT NULL OR judge_score IS NOT NULL THEN 1
          ELSE 0
        END) AS scored,
        AVG(functional_score) AS average_functional_score,
        AVG(judge_score) AS average_judge_score,
        AVG(CASE
          WHEN functional_score IS NOT NULL AND judge_score IS NOT NULL
            THEN (functional_score + judge_score) / 2.0
          WHEN functional_score IS NOT NULL THEN functional_score
          WHEN judge_score IS NOT NULL THEN judge_score
          ELSE NULL
        END) AS average_quality_score,
        MAX(created_at) AS last_created_at
      FROM character_capability_evidence
      WHERE character_id = ?
      GROUP BY capability_id
      ORDER BY capability_id
    `).all(characterId) as Row[];
    return rows.map((row) => {
      const capabilityId = String(row.capability_id) as CharacterCapabilityId;
      const last = this.database.connection.prepare(`
        SELECT outcome FROM character_capability_evidence
        WHERE character_id = ? AND capability_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1
      `).get(characterId, capabilityId) as Row | undefined;
      return {
        capabilityId,
        total: Number(row.total ?? 0),
        completed: Number(row.completed ?? 0),
        declined: Number(row.declined ?? 0),
        failed: Number(row.failed ?? 0),
        cancelled: Number(row.cancelled ?? 0),
        scored: Number(row.scored ?? 0),
        ...(optionalNumber(row.average_functional_score) === undefined
          ? {}
          : { averageFunctionalScore: optionalNumber(row.average_functional_score) }),
        ...(optionalNumber(row.average_judge_score) === undefined
          ? {}
          : { averageJudgeScore: optionalNumber(row.average_judge_score) }),
        ...(optionalNumber(row.average_quality_score) === undefined
          ? {}
          : { averageQualityScore: optionalNumber(row.average_quality_score) }),
        ...(last?.outcome ? {
          lastOutcome: String(last.outcome) as CharacterCapabilityEvidenceSummary["lastOutcome"],
        } : {}),
        ...(row.last_created_at ? { lastCreatedAt: String(row.last_created_at) } : {}),
      };
    });
  }

  getActiveSkill(
    characterId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterSkillVersion | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_skill_versions
      WHERE character_id = ? AND conversation_space = ? AND status = 'active'
      LIMIT 1
    `).get(characterId, conversationSpace) as Row | undefined;
    return row ? mapSkillVersion(row) : undefined;
  }

  findSkillBySourceTask(
    characterId: string,
    sourceTaskId: string,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterSkillVersion | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_skill_versions
      WHERE character_id = ? AND conversation_space = ? AND source_task_id = ?
      LIMIT 1
    `).get(characterId, conversationSpace, sourceTaskId) as Row | undefined;
    return row ? mapSkillVersion(row) : undefined;
  }

  listSkillVersions(
    characterId: string,
    limit = 50,
    conversationSpace: ConversationSpace = "normal",
  ): CharacterSkillVersion[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
    return (this.database.connection.prepare(`
      SELECT * FROM character_skill_versions
      WHERE character_id = ? AND conversation_space = ?
      ORDER BY version DESC
      LIMIT ?
    `).all(characterId, conversationSpace, bounded) as Row[]).map(mapSkillVersion);
  }

  nextSkillVersion(
    characterId: string,
    conversationSpace: ConversationSpace = "normal",
  ): number {
    const row = this.database.connection.prepare(`
      SELECT COALESCE(MAX(version), 0) + 1 AS version
      FROM character_skill_versions
      WHERE character_id = ? AND conversation_space = ?
    `).get(characterId, conversationSpace) as Row;
    return Number(row.version ?? 1);
  }

  supersedeActiveSkill(
    characterId: string,
    supersededAt: string,
    conversationSpace: ConversationSpace = "normal",
  ): void {
    this.database.connection.prepare(`
      UPDATE character_skill_versions
      SET status = 'superseded', superseded_at = ?
      WHERE character_id = ? AND conversation_space = ? AND status = 'active'
    `).run(supersededAt, characterId, conversationSpace);
  }

  insertSkillVersion(skill: CharacterSkillVersion): CharacterSkillVersion {
    this.database.connection.prepare(`
      INSERT INTO character_skill_versions(
        id, character_id, conversation_space, version, status, markdown, change_summary, source,
        source_task_id, content_hash, created_at, activated_at, superseded_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skill.id,
      skill.characterId,
      skill.conversationSpace,
      skill.version,
      skill.status,
      skill.markdown,
      skill.changeSummary,
      skill.source,
      skill.sourceTaskId ?? null,
      skill.contentHash,
      skill.createdAt,
      skill.activatedAt ?? null,
      skill.supersededAt ?? null,
    );
    return this.listSkillVersions(skill.characterId, 200, skill.conversationSpace)
      .find((entry) => entry.id === skill.id)!;
  }

  activateSkillVersion(
    characterId: string,
    id: string,
    activatedAt: string,
    conversationSpace: ConversationSpace = "normal",
  ): void {
    this.database.connection.prepare(`
      UPDATE character_skill_versions
      SET status = 'active', activated_at = ?, superseded_at = NULL
      WHERE character_id = ? AND conversation_space = ? AND id = ?
    `).run(activatedAt, characterId, conversationSpace, id);
  }
}

function mapProfile(row: Row): CharacterFunctionProfile {
  return {
    characterId: String(row.character_id),
    publicRole: String(row.public_role ?? ""),
    taskPreferences: String(row.task_preferences ?? ""),
    avoidedTasks: String(row.avoided_tasks ?? ""),
    maxConcurrentTasks: Number(row.max_concurrent_tasks ?? 1),
    manualLocked: Boolean(row.manual_locked),
    inferenceStatus: String(row.inference_status ?? "uninitialized") as CharacterFunctionProfile["inferenceStatus"],
    sourceSoulHash: String(row.source_soul_hash ?? ""),
    inferenceError: String(row.inference_error ?? ""),
    ...(row.inference_started_at
      ? { inferenceStartedAt: String(row.inference_started_at) }
      : {}),
    ...(row.inferred_at ? { inferredAt: String(row.inferred_at) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCapability(row: Row): CharacterCapability {
  return {
    characterId: String(row.character_id),
    capabilityId: String(row.capability_id) as CharacterCapabilityId,
    level: Number(row.level),
    responsibility: String(row.responsibility) as CharacterCapability["responsibility"],
    autoAccept: Boolean(row.auto_accept),
    moduleIds: stringArray(row.module_ids_json),
    notes: String(row.notes ?? ""),
    source: String(row.source ?? "manual") as CharacterCapability["source"],
    confidence: Number(row.confidence ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEvidence(row: Row): CharacterCapabilityEvidence {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    capabilityId: String(row.capability_id) as CharacterCapabilityId,
    sourceTaskId: String(row.source_task_id),
    outcome: String(row.outcome) as CharacterCapabilityEvidence["outcome"],
    ...(row.functional_score === null || row.functional_score === undefined
      ? {}
      : { functionalScore: Number(row.functional_score) }),
    ...(row.judge_score === null || row.judge_score === undefined
      ? {}
      : { judgeScore: Number(row.judge_score) }),
    summary: String(row.summary ?? ""),
    lesson: String(row.lesson ?? ""),
    createdAt: String(row.created_at),
  };
}

function mapSkillVersion(row: Row): CharacterSkillVersion {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    version: Number(row.version),
    status: String(row.status) as CharacterSkillVersion["status"],
    markdown: String(row.markdown ?? ""),
    changeSummary: String(row.change_summary ?? ""),
    source: String(row.source) as CharacterSkillVersion["source"],
    ...(row.source_task_id ? { sourceTaskId: String(row.source_task_id) } : {}),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
    ...(row.activated_at ? { activatedAt: String(row.activated_at) } : {}),
    ...(row.superseded_at ? { supersededAt: String(row.superseded_at) } : {}),
  };
}

function stringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
