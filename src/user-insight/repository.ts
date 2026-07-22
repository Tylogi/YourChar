import type { AppDatabase } from "../storage/database.js";
import type {
  UserInsightDecision,
  UserInsightObservation,
  UserInsightObservationInput,
  UserInsightObservationKind,
  UserInsightSourceType,
} from "./types.js";

type Row = Record<string, unknown>;

export class UserInsightRepository {
  constructor(private readonly database: AppDatabase) {}

  upsert(input: UserInsightObservationInput, id: string, now: string): UserInsightObservation {
    this.database.connection.prepare(`
      INSERT INTO user_insight_observations(
        id, source_type, source_id, source_session_id, observation_kind,
        claim_key, claim_type, claim_text, evidence_json, confidence,
        sensitivity, decision, memory_id, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id, observation_kind) DO UPDATE SET
        source_session_id = excluded.source_session_id,
        claim_key = excluded.claim_key,
        claim_type = excluded.claim_type,
        claim_text = excluded.claim_text,
        evidence_json = excluded.evidence_json,
        confidence = excluded.confidence,
        sensitivity = excluded.sensitivity,
        decision = CASE
          WHEN user_insight_observations.decision = 'user_blocked'
            AND user_insight_observations.claim_key = excluded.claim_key
          THEN user_insight_observations.decision
          ELSE excluded.decision
        END,
        memory_id = CASE
          WHEN user_insight_observations.decision = 'user_blocked'
            AND user_insight_observations.claim_key = excluded.claim_key
          THEN user_insight_observations.memory_id
          ELSE excluded.memory_id
        END,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.sourceType,
      input.sourceId,
      input.sourceSessionId ?? null,
      input.kind,
      input.claimKey,
      input.claimType,
      input.claimText,
      JSON.stringify(input.evidence),
      input.confidence,
      input.sensitivity,
      input.decision,
      input.memoryId ?? null,
      input.observedAt,
      now,
      now,
    );
    return this.getBySource(input.sourceType, input.sourceId, input.kind)!;
  }

  getBySource(
    sourceType: UserInsightSourceType,
    sourceId: string,
    kind: UserInsightObservationKind,
  ): UserInsightObservation | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM user_insight_observations
      WHERE source_type = ? AND source_id = ? AND observation_kind = ?
    `).get(sourceType, sourceId, kind) as Row | undefined;
    return row ? mapObservation(row) : undefined;
  }

  get(id: string): UserInsightObservation | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM user_insight_observations WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapObservation(row) : undefined;
  }

  listByClaim(claimKey: string): UserInsightObservation[] {
    return (this.database.connection.prepare(`
      SELECT * FROM user_insight_observations
      WHERE claim_key = ? ORDER BY observed_at, sequence
    `).all(claimKey) as Row[]).map(mapObservation);
  }

  listClaimKeys(): string[] {
    return (this.database.connection.prepare(`
      SELECT DISTINCT claim_key FROM user_insight_observations ORDER BY claim_key
    `).all() as Array<{ claim_key: string }>).map((row) => row.claim_key);
  }

  listRecent(limit = 50): UserInsightObservation[] {
    return (this.database.connection.prepare(`
      SELECT * FROM user_insight_observations
      ORDER BY updated_at DESC, sequence DESC LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 200)) as Row[]).map(mapObservation);
  }

  retractSource(sourceType: UserInsightSourceType, sourceId: string, now: string): string[] {
    const rows = this.database.connection.prepare(`
      SELECT DISTINCT claim_key FROM user_insight_observations
      WHERE source_type = ? AND source_id = ? AND decision != 'retracted'
    `).all(sourceType, sourceId) as Array<{ claim_key: string }>;
    this.database.connection.prepare(`
      UPDATE user_insight_observations
      SET decision = 'retracted', memory_id = NULL, updated_at = ?
      WHERE source_type = ? AND source_id = ? AND decision != 'retracted'
    `).run(now, sourceType, sourceId);
    return rows.map((row) => row.claim_key);
  }

  setClaimDecision(
    claimKey: string,
    decision: Extract<UserInsightDecision, "accumulating" | "promoted" | "write_disabled" | "conflicted" | "user_blocked">,
    memoryId: string | undefined,
    now: string,
  ): void {
    this.database.connection.prepare(`
      UPDATE user_insight_observations
      SET decision = ?, memory_id = ?, updated_at = ?
      WHERE claim_key = ?
        AND decision IN ('accumulating', 'promoted', 'write_disabled', 'conflicted', 'user_blocked')
    `).run(decision, memoryId ?? null, now, claimKey);
  }

  markClaimPromoted(claimKey: string, memoryId: string, now: string): void {
    this.database.connection.prepare(`
      UPDATE user_insight_observations
      SET decision = 'promoted', memory_id = ?, updated_at = ?
      WHERE claim_key = ? AND decision NOT IN ('blocked_sensitive', 'retracted')
    `).run(memoryId, now, claimKey);
  }

  blockClaim(claimKey: string, now: string): void {
    this.database.connection.prepare(`
      UPDATE user_insight_observations
      SET decision = 'user_blocked', memory_id = NULL, updated_at = ?
      WHERE claim_key = ? AND decision NOT IN ('blocked_sensitive', 'retracted')
    `).run(now, claimKey);
  }

  unlockClaim(claimKey: string, now: string): void {
    this.database.connection.prepare(`
      UPDATE user_insight_observations
      SET decision = 'accumulating', memory_id = NULL, updated_at = ?
      WHERE claim_key = ? AND decision = 'user_blocked'
    `).run(now, claimKey);
  }

  counts(): {
    total: number;
    promoted: number;
    pending: number;
    blocked: number;
    conflicted: number;
    userBlocked: number;
  } {
    const row = this.database.connection.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'promoted' THEN 1 ELSE 0 END) AS promoted,
        SUM(CASE WHEN decision IN ('accumulating', 'write_disabled', 'conflicted') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN decision = 'blocked_sensitive' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN decision = 'conflicted' THEN 1 ELSE 0 END) AS conflicted,
        SUM(CASE WHEN decision = 'user_blocked' THEN 1 ELSE 0 END) AS user_blocked
      FROM user_insight_observations
    `).get() as Record<string, number | null>;
    return {
      total: Number(row.total ?? 0),
      promoted: Number(row.promoted ?? 0),
      pending: Number(row.pending ?? 0),
      blocked: Number(row.blocked ?? 0),
      conflicted: Number(row.conflicted ?? 0),
      userBlocked: Number(row.user_blocked ?? 0),
    };
  }
}

function mapObservation(row: Row): UserInsightObservation {
  return {
    id: String(row.id),
    sourceType: row.source_type as UserInsightObservation["sourceType"],
    sourceId: String(row.source_id),
    ...(typeof row.source_session_id === "string" && row.source_session_id
      ? { sourceSessionId: row.source_session_id }
      : {}),
    kind: row.observation_kind as UserInsightObservation["kind"],
    claimKey: String(row.claim_key),
    claimType: row.claim_type as UserInsightObservation["claimType"],
    claimText: String(row.claim_text),
    evidence: parseEvidence(row.evidence_json),
    confidence: Number(row.confidence),
    sensitivity: row.sensitivity as UserInsightObservation["sensitivity"],
    decision: row.decision as UserInsightObservation["decision"],
    ...(typeof row.memory_id === "string" && row.memory_id ? { memoryId: row.memory_id } : {}),
    observedAt: String(row.observed_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseEvidence(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
