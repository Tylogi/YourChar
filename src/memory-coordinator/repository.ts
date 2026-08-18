import type { AppDatabase } from "../storage/database.js";
import type { ContextLogEntry, ConversationSpace, Mode } from "../domain/types.js";
import type {
  MemoryExtractionJob,
  MemoryExtractionJobStatus,
  MemoryTargetRealm,
} from "./types.js";

type Row = Record<string, unknown>;

export class MemoryCoordinatorRepository {
  constructor(private readonly database: AppDatabase) {}

  createJob(job: MemoryExtractionJob): MemoryExtractionJob {
    this.database.connection.prepare(`
      INSERT INTO memory_extraction_jobs(
        id, idempotency_key, source_context_log_id, session_id, source_message_id,
        mode, conversation_space, secret_owner_character_id,
        realm, character_id, trigger_kind, trigger_reason, status, attempts,
        max_attempts, input_token_estimate, duration_ms, result_count, last_error,
        available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      job.id, job.idempotencyKey, job.sourceContextLogId, job.sessionId, job.sourceMessageId,
      job.mode, job.conversationSpace, job.secretOwnerCharacterId ?? null,
      job.realm, job.characterId ?? null, job.triggerKind, job.triggerReason,
      job.status, job.attempts, job.maxAttempts, job.inputTokenEstimate,
      job.durationMs ?? null, job.resultCount, job.lastError ?? null, job.availableAt,
      job.createdAt, job.updatedAt,
    );
    return this.findByIdempotencyKey(job.idempotencyKey)!;
  }

  getJob(id: string): MemoryExtractionJob | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM memory_extraction_jobs WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  findByIdempotencyKey(key: string): MemoryExtractionJob | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM memory_extraction_jobs WHERE idempotency_key = ?",
    ).get(key) as Row | undefined;
    return row ? mapJob(row) : undefined;
  }

  listRecent(
    limit = 20,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): MemoryExtractionJob[] {
    assertSpace(conversationSpace, secretOwnerCharacterId);
    return (this.database.connection.prepare(`
      SELECT * FROM memory_extraction_jobs
      WHERE conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(
      conversationSpace,
      secretOwnerCharacterId ?? null,
      Math.min(Math.max(limit, 1), 100),
    ) as Row[]).map(mapJob);
  }

  listRunnable(now: string, limit = 10): MemoryExtractionJob[] {
    return (this.database.connection.prepare(`
      SELECT * FROM memory_extraction_jobs
      WHERE (status = 'pending' AND available_at <= ?)
         OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
      ORDER BY created_at, id LIMIT ?
    `).all(now, now, Math.min(Math.max(limit, 1), 50)) as Row[]).map(mapJob);
  }

  recoverExpired(now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE memory_extraction_jobs
      SET status = 'pending', available_at = ?,
          trigger_reason = trigger_reason || ':stale_running_recovery',
          owner_id = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(now, now, now).changes);
  }

  claim(id: string, ownerId: string, claimToken: string, now: string, leaseExpiresAt: string): MemoryExtractionJob | undefined {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'running', attempts = attempts + 1, last_error = NULL,
            trigger_reason = CASE
              WHEN status = 'running' THEN trigger_reason || ':expired_lease_recovery'
              ELSE trigger_reason
            END,
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
      UPDATE memory_extraction_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND owner_id = ? AND claim_token = ?
    `).run(leaseExpiresAt, now, id, ownerId, claimToken).changes) === 1;
  }

  finish(
    id: string,
    status: Exclude<MemoryExtractionJobStatus, "pending" | "running">,
    patch: { durationMs?: number; resultCount?: number; lastError?: string; availableAt?: string },
    now: string,
    claim?: { ownerId: string; claimToken: string },
  ): boolean {
    const result = this.database.connection.prepare(`
      UPDATE memory_extraction_jobs
      SET status = ?, duration_ms = ?, result_count = ?, last_error = ?,
          available_at = COALESCE(?, available_at), updated_at = ?,
          owner_id = NULL, claim_token = NULL, lease_expires_at = NULL
      WHERE id = ?
        AND (? IS NULL OR (status = 'running' AND owner_id = ? AND claim_token = ?))
    `).run(
      status,
      patch.durationMs ?? null,
      patch.resultCount ?? 0,
      patch.lastError ?? null,
      patch.availableAt ?? null,
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
      UPDATE memory_extraction_jobs
      SET status = 'pending', available_at = ?,
          trigger_reason = trigger_reason || ':owner_released:restart_recovery',
          owner_id = NULL, claim_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND owner_id = ?
    `).run(now, now, ownerId).changes);
  }

  retry(
    id: string,
    now: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): MemoryExtractionJob {
    assertSpace(conversationSpace, secretOwnerCharacterId);
    const job = this.getJob(id);
    if (
      !job || job.conversationSpace !== conversationSpace ||
      job.secretOwnerCharacterId !== secretOwnerCharacterId
    ) throw new Error(`memory extraction job not found: ${id}`);
    if (job.status !== "failed") throw new Error("only failed memory extraction jobs can be retried");
    if (job.attempts >= job.maxAttempts) throw new Error("memory extraction retry limit reached");
    this.database.connection.prepare(`
      UPDATE memory_extraction_jobs
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
      conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
      ...(typeof row.secret_owner_character_id === "string" && row.secret_owner_character_id
        ? { secretOwnerCharacterId: row.secret_owner_character_id }
        : {}),
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

  pendingCount(
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): number {
    assertSpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM memory_extraction_jobs
      WHERE status IN ('pending', 'running') AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).get(conversationSpace, secretOwnerCharacterId ?? null) as { count: number };
    return Number(row.count);
  }

  estimatedTokensSince(
    since: string,
    conversationSpace: ConversationSpace = "normal",
    secretOwnerCharacterId?: string,
  ): number {
    assertSpace(conversationSpace, secretOwnerCharacterId);
    const row = this.database.connection.prepare(`
      SELECT COALESCE(SUM(input_token_estimate), 0) AS total
      FROM memory_extraction_jobs
      WHERE updated_at >= ? AND status IN ('running', 'completed', 'failed')
        AND conversation_space = ?
        AND COALESCE(secret_owner_character_id, '') = COALESCE(?, '')
    `).get(since, conversationSpace, secretOwnerCharacterId ?? null) as { total: number };
    return Number(row.total);
  }
}

function assertSpace(
  conversationSpace: ConversationSpace,
  secretOwnerCharacterId?: string,
): void {
  if (conversationSpace === "secret" && !secretOwnerCharacterId) {
    throw new Error("secret memory scope requires a characterId");
  }
  if (conversationSpace === "normal" && secretOwnerCharacterId) {
    throw new Error("normal memory scope cannot include a secret characterId");
  }
}

function mapJob(row: Row): MemoryExtractionJob {
  return {
    id: String(row.id),
    idempotencyKey: String(row.idempotency_key),
    sourceContextLogId: String(row.source_context_log_id),
    sessionId: String(row.session_id),
    sourceMessageId: String(row.source_message_id),
    mode: row.mode as Mode,
    conversationSpace: row.conversation_space === "secret" ? "secret" : "normal",
    ...(typeof row.secret_owner_character_id === "string" && row.secret_owner_character_id
      ? { secretOwnerCharacterId: row.secret_owner_character_id }
      : {}),
    realm: row.realm as MemoryTargetRealm,
    ...(typeof row.character_id === "string" && row.character_id ? { characterId: row.character_id } : {}),
    triggerKind: row.trigger_kind as MemoryExtractionJob["triggerKind"],
    triggerReason: String(row.trigger_reason),
    status: row.status as MemoryExtractionJobStatus,
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
