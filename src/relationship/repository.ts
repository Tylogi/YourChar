import type { AppDatabase } from "../storage/database.js";
import type { ContextLogEntry, Mode } from "../domain/types.js";
import type {
  AffectLabel,
  CharacterRelationshipState,
  RelationshipDelta,
  RelationshipEvent,
  RelationshipExtractionJob,
  RelationshipJobStatus,
} from "./types.js";

type Row = Record<string, unknown>;

export class RelationshipRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  createState(state: CharacterRelationshipState): CharacterRelationshipState {
    this.database.connection.prepare(`
      INSERT INTO character_relationship_states(
        character_id, trust, closeness, affection, respect, tension,
        affect_valence, affect_arousal, affect_control, affect_labels_json,
        affect_updated_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO NOTHING
    `).run(
      state.characterId,
      state.trust,
      state.closeness,
      state.affection,
      state.respect,
      state.tension,
      state.affect.valence,
      state.affect.arousal,
      state.affect.control,
      JSON.stringify(state.affect.labels),
      state.affect.updatedAt,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
    return this.getState(state.characterId)!;
  }

  getState(characterId: string): CharacterRelationshipState | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM character_relationship_states WHERE character_id = ?",
    ).get(characterId) as Row | undefined;
    return row ? mapState(row) : undefined;
  }

  updateState(state: CharacterRelationshipState): CharacterRelationshipState {
    this.database.connection.prepare(`
      UPDATE character_relationship_states SET
        trust = ?, closeness = ?, affection = ?, respect = ?, tension = ?,
        affect_valence = ?, affect_arousal = ?, affect_control = ?,
        affect_labels_json = ?, affect_updated_at = ?, version = ?, updated_at = ?
      WHERE character_id = ?
    `).run(
      state.trust,
      state.closeness,
      state.affection,
      state.respect,
      state.tension,
      state.affect.valence,
      state.affect.arousal,
      state.affect.control,
      JSON.stringify(state.affect.labels),
      state.affect.updatedAt,
      state.version,
      state.updatedAt,
      state.characterId,
    );
    return this.getState(state.characterId)!;
  }

  deleteState(characterId: string): void {
    this.database.connection.prepare("DELETE FROM character_relationship_states WHERE character_id = ?").run(characterId);
  }

  createEvent(event: RelationshipEvent): RelationshipEvent {
    this.database.connection.prepare(`
      INSERT INTO relationship_events(
        id, character_id, source_session_id, source_context_log_id,
        event_type, impact, summary, confidence, delta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_context_log_id) DO NOTHING
    `).run(
      event.id,
      event.characterId,
      event.sourceSessionId,
      event.sourceContextLogId,
      event.type,
      event.impact,
      event.summary,
      event.confidence,
      JSON.stringify(event.delta),
      event.createdAt,
    );
    return this.findEventByContextLog(event.sourceContextLogId)!;
  }

  findEventByContextLog(contextLogId: string): RelationshipEvent | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM relationship_events WHERE source_context_log_id = ?",
    ).get(contextLogId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  listEvents(characterId: string, limit = 20): RelationshipEvent[] {
    return (this.database.connection.prepare(`
      SELECT * FROM relationship_events
      WHERE character_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(characterId, Math.min(Math.max(limit, 1), 100)) as Row[]).map(mapEvent);
  }

  deleteEvents(characterId: string): void {
    this.database.connection.prepare("DELETE FROM relationship_events WHERE character_id = ?").run(characterId);
  }

  cancelOutstandingJobs(characterId: string, now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE relationship_extraction_jobs
      SET status = 'skipped', trigger_reason = trigger_reason || ':relationship_reset',
          result_count = 0, last_error = NULL, owner_id = NULL, claim_token = NULL,
          lease_expires_at = NULL, updated_at = ?
      WHERE character_id = ? AND status IN ('pending', 'running', 'failed')
    `).run(now, characterId).changes);
  }

  createJob(job: RelationshipExtractionJob): RelationshipExtractionJob {
    this.database.connection.prepare(`
      INSERT INTO relationship_extraction_jobs(
        id, idempotency_key, source_context_log_id, session_id, character_id,
        mode, trigger_reason, status, attempts, max_attempts, input_token_estimate,
        duration_ms, result_count, last_error, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      job.id,
      job.idempotencyKey,
      job.sourceContextLogId,
      job.sessionId,
      job.characterId,
      job.mode,
      job.triggerReason,
      job.status,
      job.attempts,
      job.maxAttempts,
      job.inputTokenEstimate,
      job.durationMs ?? null,
      job.resultCount,
      job.lastError ?? null,
      job.availableAt,
      job.createdAt,
      job.updatedAt,
    );
    return this.findJobByIdempotencyKey(job.idempotencyKey)!;
  }

  getJob(id: string): RelationshipExtractionJob | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM relationship_extraction_jobs WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  findJobByIdempotencyKey(key: string): RelationshipExtractionJob | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM relationship_extraction_jobs WHERE idempotency_key = ?",
    ).get(key) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  listRecentJobs(limit = 20): RelationshipExtractionJob[] {
    return (this.database.connection.prepare(`
      SELECT * FROM relationship_extraction_jobs
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 100)) as Row[]).map(mapJob);
  }

  listRunnable(now: string, limit = 10): RelationshipExtractionJob[] {
    return (this.database.connection.prepare(`
      SELECT * FROM relationship_extraction_jobs
      WHERE (status = 'pending' AND available_at <= ?)
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      ORDER BY created_at, id LIMIT ?
    `).all(now, now, Math.min(Math.max(limit, 1), 50)) as Row[]).map(mapJob);
  }

  recoverExpired(now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE relationship_extraction_jobs
      SET status = 'pending', available_at = ?,
          trigger_reason = trigger_reason || ':stale_running_recovery',
          owner_id = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(now, now, now).changes);
  }

  claim(id: string, ownerId: string, claimToken: string, now: string, leaseExpiresAt: string): RelationshipExtractionJob | undefined {
    return this.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE relationship_extraction_jobs
        SET status = 'running', attempts = attempts + 1, last_error = NULL,
            trigger_reason = CASE WHEN status = 'running'
              THEN trigger_reason || ':expired_lease_recovery' ELSE trigger_reason END,
            owner_id = ?, claim_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND (
          (status = 'pending' AND available_at <= ?)
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      `).run(ownerId, claimToken, leaseExpiresAt, now, id, now, now);
      return Number(result.changes) === 1 ? this.getJob(id) : undefined;
    });
  }

  renewClaim(id: string, ownerId: string, claimToken: string, leaseExpiresAt: string, now: string): boolean {
    return Number(this.database.connection.prepare(`
      UPDATE relationship_extraction_jobs SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?
    `).run(leaseExpiresAt, now, id, ownerId, claimToken).changes) === 1;
  }

  finish(
    id: string,
    status: Exclude<RelationshipJobStatus, "pending" | "running">,
    patch: { durationMs?: number; resultCount?: number; lastError?: string },
    now: string,
    claim?: { ownerId: string; claimToken: string },
  ): boolean {
    const result = this.database.connection.prepare(`
      UPDATE relationship_extraction_jobs
      SET status = ?, duration_ms = ?, result_count = ?, last_error = ?, updated_at = ?,
          owner_id = NULL, claim_token = NULL, lease_expires_at = NULL
      WHERE id = ?
        AND (? IS NULL OR (status = 'running' AND owner_id = ? AND claim_token = ?))
    `).run(
      status,
      patch.durationMs ?? null,
      patch.resultCount ?? 0,
      patch.lastError ?? null,
      now,
      id,
      claim?.ownerId ?? null,
      claim?.ownerId ?? null,
      claim?.claimToken ?? null,
    );
    return Number(result.changes) === 1;
  }

  releaseOwner(ownerId: string, now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE relationship_extraction_jobs
      SET status = 'pending', available_at = ?,
          trigger_reason = trigger_reason || ':owner_released:restart_recovery',
          owner_id = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND owner_id = ?
    `).run(now, now, ownerId).changes);
  }

  retry(id: string, now: string): RelationshipExtractionJob {
    const job = this.getJob(id);
    if (!job) throw new Error(`relationship extraction job not found: ${id}`);
    if (job.status !== "failed") throw new Error("only failed relationship extraction jobs can be retried");
    if (job.attempts >= job.maxAttempts) throw new Error("relationship extraction retry limit reached");
    this.database.connection.prepare(`
      UPDATE relationship_extraction_jobs
      SET status = 'pending', available_at = ?, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
    return this.getJob(id)!;
  }

  getContextLog(id: string): ContextLogEntry | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM context_log_summaries WHERE id = ?",
    ).get(id) as Row | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      sessionId: String(row.session_id),
      mode: row.mode as Mode,
      requestText: String(row.request_text),
      systemPrompt: String(row.system_prompt_excerpt),
      messageCountBefore: Number(row.message_count_before),
      toolNames: [],
      reply: String(row.reply),
      status: row.turn_status === "completed" ? "completed" : "failed",
      canRetry: Boolean(row.can_retry),
      actions: [],
      events: [],
      createdAt: String(row.created_at),
    };
  }

  pendingCount(): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM relationship_extraction_jobs WHERE status IN ('pending', 'running')
    `).get() as { count: number };
    return Number(row.count);
  }

  estimatedTokensSince(since: string): number {
    const row = this.database.connection.prepare(`
      SELECT COALESCE(SUM(input_token_estimate), 0) AS total
      FROM relationship_extraction_jobs
      WHERE updated_at >= ? AND status IN ('running', 'completed', 'failed')
    `).get(since) as { total: number };
    return Number(row.total);
  }
}

function mapState(row: Row): CharacterRelationshipState {
  const state = {
    characterId: String(row.character_id),
    trust: Number(row.trust),
    closeness: Number(row.closeness),
    affection: Number(row.affection),
    respect: Number(row.respect),
    tension: Number(row.tension),
    affect: {
      valence: Number(row.affect_valence),
      arousal: Number(row.affect_arousal),
      control: Number(row.affect_control),
      labels: parseLabels(row.affect_labels_json),
      updatedAt: String(row.affect_updated_at),
    },
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  return { ...state, stage: deriveStage(state) };
}

function mapEvent(row: Row): RelationshipEvent {
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    sourceSessionId: String(row.source_session_id),
    sourceContextLogId: String(row.source_context_log_id),
    type: row.event_type as RelationshipEvent["type"],
    impact: row.impact as RelationshipEvent["impact"],
    summary: String(row.summary),
    confidence: Number(row.confidence),
    delta: parseDelta(row.delta_json),
    createdAt: String(row.created_at),
  };
}

function mapJob(row: Row): RelationshipExtractionJob {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    sourceContextLogId: String(row.source_context_log_id),
    sessionId: String(row.session_id),
    characterId: String(row.character_id),
    mode: row.mode as Mode,
    triggerReason: String(row.trigger_reason),
    status: row.status as RelationshipJobStatus,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    inputTokenEstimate: Number(row.input_token_estimate),
    ...(typeof row.duration_ms === "number" ? { durationMs: Number(row.duration_ms) } : {}),
    resultCount: Number(row.result_count),
    ...(typeof row.last_error === "string" && row.last_error ? { lastError: row.last_error } : {}),
    ...(typeof row.owner_id === "string" && row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(typeof row.claim_token === "string" && row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(typeof row.lease_expires_at === "string" && row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    availableAt: String(row.available_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseLabels(value: unknown): AffectLabel[] {
  try {
    const labels = JSON.parse(String(value));
    return Array.isArray(labels) ? labels.filter((entry): entry is AffectLabel => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseDelta(value: unknown): RelationshipDelta {
  try {
    const parsed = JSON.parse(String(value)) as Partial<RelationshipDelta>;
    return {
      trust: Number(parsed.trust ?? 0),
      closeness: Number(parsed.closeness ?? 0),
      affection: Number(parsed.affection ?? 0),
      respect: Number(parsed.respect ?? 0),
      tension: Number(parsed.tension ?? 0),
    };
  } catch {
    return { trust: 0, closeness: 0, affection: 0, respect: 0, tension: 0 };
  }
}

function deriveStage(state: RelationshipDelta): CharacterRelationshipState["stage"] {
  if (state.tension >= 65 || (state.trust <= 20 && state.tension >= 40)) return "strained";
  const connection = (state.trust + state.closeness + state.affection + state.respect) / 4;
  if (connection >= 75 && state.closeness >= 65) return "intimate";
  if (connection >= 60 && state.closeness >= 45) return "close";
  if (connection >= 42 || state.closeness >= 30) return "familiar";
  if (connection >= 28) return "acquaintance";
  return "stranger";
}
