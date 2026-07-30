import type { AppDatabase } from "../storage/database.js";
import type {
  CharacterChannel,
  CharacterChannelEpisode,
  CharacterChannelMessage,
  CharacterCollaborationJob,
  CharacterCollaborationJobStatus,
  CharacterCollaborationReportStatus,
} from "./types.js";

type Row = Record<string, unknown>;

export class CharacterChannelRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  ensureChannel(channel: CharacterChannel): CharacterChannel {
    this.database.connection.prepare(`
      INSERT INTO character_channels(
        id, world_id, first_character_id, second_character_id,
        unread_count, last_unread_at, last_read_at, last_message_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_id, first_character_id, second_character_id) DO NOTHING
    `).run(
      channel.id,
      channel.worldId,
      channel.firstCharacterId,
      channel.secondCharacterId,
      channel.unreadCount,
      channel.lastUnreadAt ?? null,
      channel.lastReadAt ?? null,
      channel.lastMessageAt ?? null,
      channel.createdAt,
      channel.updatedAt,
    );
    return this.getChannelByPair(
      channel.worldId,
      channel.firstCharacterId,
      channel.secondCharacterId,
    )!;
  }

  getChannel(id: string): CharacterChannel | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_channels WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapChannel(row) : undefined;
  }

  getChannelByPair(
    worldId: string,
    firstCharacterId: string,
    secondCharacterId: string,
  ): CharacterChannel | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_channels
      WHERE world_id = ? AND first_character_id = ? AND second_character_id = ?
    `).get(worldId, firstCharacterId, secondCharacterId) as Row | undefined;
    return row ? mapChannel(row) : undefined;
  }

  listChannels(input: { worldId?: string; characterId?: string; limit?: number } = {}): CharacterChannel[] {
    const limit = Math.max(1, Math.min(Math.floor(input.limit ?? 100), 500));
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (input.worldId) {
      conditions.push("world_id = ?");
      parameters.push(input.worldId);
    }
    if (input.characterId) {
      conditions.push("(first_character_id = ? OR second_character_id = ?)");
      parameters.push(input.characterId, input.characterId);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    return (this.database.connection.prepare(`
      SELECT * FROM character_channels
      ${where}
      ORDER BY COALESCE(last_message_at, updated_at) DESC, id DESC
      LIMIT ?
    `).all(...parameters, limit) as Row[]).map(mapChannel);
  }

  markRead(channelId: string, now: string): CharacterChannel | undefined {
    this.database.connection.prepare(`
      UPDATE character_channels
      SET unread_count = 0, last_read_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, channelId);
    return this.getChannel(channelId);
  }

  createEpisode(episode: CharacterChannelEpisode): CharacterChannelEpisode {
    this.database.connection.prepare(`
      INSERT INTO character_channel_episodes(
        id, channel_id, world_id, kind, source,
        initiator_character_id, target_character_id, parent_session_id,
        title, objective, status, model_calls, message_count, idempotency_key,
        result_text, failure_reason, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      episode.id,
      episode.channelId,
      episode.worldId,
      episode.kind,
      episode.source,
      episode.initiatorCharacterId,
      episode.targetCharacterId,
      episode.parentSessionId ?? null,
      episode.title,
      episode.objective,
      episode.status,
      episode.modelCalls,
      episode.messageCount,
      episode.idempotencyKey,
      episode.resultText ?? null,
      episode.failureReason ?? null,
      episode.createdAt,
      episode.updatedAt,
      episode.completedAt ?? null,
    );
    return this.findEpisodeByIdempotencyKey(episode.idempotencyKey)!;
  }

  createQueuedCollaboration(
    episode: CharacterChannelEpisode,
    job: CharacterCollaborationJob,
    openingMessage: Omit<CharacterChannelMessage, "sequence">,
  ): { episode: CharacterChannelEpisode; job: CharacterCollaborationJob; existing: boolean } {
    return this.database.transaction(() => {
      const stored = this.createEpisode(episode);
      const existing = stored.id !== episode.id;
      if (!existing) {
        this.database.connection.prepare(`
          INSERT INTO character_collaboration_jobs(
            episode_id, opening_message, routing_json, status,
            attempts, max_attempts, last_error, owner_id, claim_token,
            lease_expires_at, available_at, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          job.episodeId,
          job.openingMessage,
          JSON.stringify(job.routing),
          job.status,
          job.attempts,
          job.maxAttempts,
          job.lastError ?? null,
          job.ownerId ?? null,
          job.claimToken ?? null,
          job.leaseExpiresAt ?? null,
          job.availableAt,
          job.createdAt,
          job.updatedAt,
          job.completedAt ?? null,
        );
        this.appendMessage(openingMessage);
      }
      const storedJob = this.getCollaborationJob(stored.id);
      if (!storedJob) {
        throw new Error(`queued collaboration job not found: ${stored.id}`);
      }
      return { episode: this.getEpisode(stored.id)!, job: storedJob, existing };
    });
  }

  getEpisode(id: string): CharacterChannelEpisode | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_channel_episodes WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapEpisode(row) : undefined;
  }

  findEpisodeByIdempotencyKey(idempotencyKey: string): CharacterChannelEpisode | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_channel_episodes WHERE idempotency_key = ?
    `).get(idempotencyKey) as Row | undefined;
    return row ? mapEpisode(row) : undefined;
  }

  updateEpisode(episode: CharacterChannelEpisode): CharacterChannelEpisode {
    this.database.connection.prepare(`
      UPDATE character_channel_episodes SET
        title = ?, objective = ?, status = ?, model_calls = ?, message_count = ?,
        result_text = ?, failure_reason = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      episode.title,
      episode.objective,
      episode.status,
      episode.modelCalls,
      episode.messageCount,
      episode.resultText ?? null,
      episode.failureReason ?? null,
      episode.updatedAt,
      episode.completedAt ?? null,
      episode.id,
    );
    return this.getEpisode(episode.id)!;
  }

  listEpisodes(channelId: string, limit = 40): CharacterChannelEpisode[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
    return (this.database.connection.prepare(`
      SELECT * FROM character_channel_episodes
      WHERE channel_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(channelId, bounded) as Row[]).map(mapEpisode);
  }

  listCollaborationEpisodesByParentSession(
    parentSessionId: string,
    initiatorCharacterId: string,
    limit = 100,
  ): CharacterChannelEpisode[] {
    const bounded = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), 200))
      : 100;
    return (this.database.connection.prepare(`
      SELECT * FROM character_channel_episodes
      WHERE parent_session_id = ?
        AND initiator_character_id = ?
        AND kind = 'collaboration'
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(parentSessionId, initiatorCharacterId, bounded) as Row[]).map(mapEpisode);
  }

  unlinkParentSession(parentSessionId: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET parent_session_id = NULL
      WHERE parent_session_id = ?
    `).run(parentSessionId).changes);
  }

  countAutonomySocialEpisodes(
    initiatorCharacterId: string,
    startsAt: string,
    endsAt: string,
  ): number {
    const row = this.database.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM character_channel_episodes
      WHERE initiator_character_id = ?
        AND kind = 'social'
        AND source = 'autonomy'
        AND status NOT IN ('failed', 'cancelled')
        AND created_at >= ?
        AND created_at < ?
    `).get(initiatorCharacterId, startsAt, endsAt) as Row;
    return Number(row.count ?? 0);
  }

  appendMessage(
    message: Omit<CharacterChannelMessage, "sequence">,
    unread = true,
  ): CharacterChannelMessage {
    const sequenceRow = this.database.connection.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
      FROM character_channel_messages WHERE channel_id = ?
    `).get(message.channelId) as Row;
    const stored: CharacterChannelMessage = {
      ...message,
      sequence: Number(sequenceRow.sequence),
    };
    this.database.connection.prepare(`
      INSERT INTO character_channel_messages(
        id, channel_id, episode_id, sequence, sender_type,
        sender_character_id, kind, content, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      stored.id,
      stored.channelId,
      stored.episodeId,
      stored.sequence,
      stored.senderType,
      stored.senderCharacterId ?? null,
      stored.kind,
      stored.content,
      stored.createdAt,
    );
    this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET message_count = message_count + 1, updated_at = ?
      WHERE id = ?
    `).run(stored.createdAt, stored.episodeId);
    this.database.connection.prepare(`
      UPDATE character_channels SET
        unread_count = unread_count + ?,
        last_unread_at = CASE WHEN ? = 1 THEN ? ELSE last_unread_at END,
        last_message_at = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      unread ? 1 : 0,
      unread ? 1 : 0,
      stored.createdAt,
      stored.createdAt,
      stored.createdAt,
      stored.channelId,
    );
    return stored;
  }

  listMessages(channelId: string, limit = 100): CharacterChannelMessage[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = this.database.connection.prepare(`
      SELECT * FROM (
        SELECT * FROM character_channel_messages
        WHERE channel_id = ?
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence
    `).all(channelId, bounded) as Row[];
    return rows.map(mapMessage);
  }

  listEpisodeMessages(episodeId: string, limit = 500): CharacterChannelMessage[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 500));
    return (this.database.connection.prepare(`
      SELECT * FROM character_channel_messages
      WHERE episode_id = ?
      ORDER BY sequence
      LIMIT ?
    `).all(episodeId, bounded) as Row[]).map(mapMessage);
  }

  latestMessage(channelId: string): CharacterChannelMessage | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_channel_messages
      WHERE channel_id = ?
      ORDER BY sequence DESC LIMIT 1
    `).get(channelId) as Row | undefined;
    return row ? mapMessage(row) : undefined;
  }

  getCollaborationJob(episodeId: string): CharacterCollaborationJob | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_collaboration_jobs WHERE episode_id = ?
    `).get(episodeId) as Row | undefined;
    return row ? mapCollaborationJob(row) : undefined;
  }

  listRunnableCollaborationJobs(now: string, limit = 10): CharacterCollaborationJob[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 50));
    return (this.database.connection.prepare(`
      SELECT jobs.*
      FROM character_collaboration_jobs AS jobs
      JOIN character_channel_episodes AS episodes ON episodes.id = jobs.episode_id
      WHERE jobs.attempts < jobs.max_attempts
        AND episodes.status IN ('queued', 'running')
        AND (
          (jobs.status = 'queued' AND jobs.available_at <= ?)
          OR (
            jobs.status = 'running'
            AND (jobs.lease_expires_at IS NULL OR jobs.lease_expires_at <= ?)
          )
        )
      ORDER BY jobs.created_at, jobs.episode_id
      LIMIT ?
    `).all(now, now, bounded) as Row[]).map(mapCollaborationJob);
  }

  recoverExpiredCollaborationJobs(now: string): number {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(`
        SELECT episode_id FROM character_collaboration_jobs
        WHERE status = 'running'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).all(now) as Array<{ episode_id: string }>;
      const updateJob = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = 'queued', available_at = ?, owner_id = NULL,
            claim_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE episode_id = ? AND status = 'running'
      `);
      const updateEpisode = this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'running'
      `);
      let recovered = 0;
      for (const row of rows) {
        const result = updateJob.run(now, now, row.episode_id);
        if (Number(result.changes) !== 1) continue;
        recovered += 1;
        updateEpisode.run(now, row.episode_id);
      }
      return recovered;
    });
  }

  recoverInterruptedCollaborationJobs(now: string): number {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(`
        SELECT episode_id FROM character_collaboration_jobs
        WHERE status = 'running'
      `).all() as Array<{ episode_id: string }>;
      const updateJob = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = 'queued', available_at = ?, owner_id = NULL,
            claim_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE episode_id = ? AND status = 'running'
      `);
      const updateEpisode = this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'running'
      `);
      let recovered = 0;
      for (const row of rows) {
        const result = updateJob.run(now, now, row.episode_id);
        if (Number(result.changes) !== 1) continue;
        recovered += 1;
        updateEpisode.run(now, row.episode_id);
      }
      return recovered;
    });
  }

  claimCollaborationJob(
    episodeId: string,
    ownerId: string,
    claimToken: string,
    now: string,
    leaseExpiresAt: string,
  ): CharacterCollaborationJob | undefined {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = 'running', attempts = attempts + 1, last_error = NULL,
            owner_id = ?, claim_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE episode_id = ?
          AND attempts < max_attempts
          AND (
            (status = 'queued' AND available_at <= ?)
            OR (
              status = 'running'
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            )
          )
          AND EXISTS (
            SELECT 1 FROM character_channel_episodes
            WHERE id = character_collaboration_jobs.episode_id
              AND status IN ('queued', 'running')
          )
      `).run(ownerId, claimToken, leaseExpiresAt, now, episodeId, now, now);
      if (Number(result.changes) !== 1) return undefined;
      this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET status = 'running', updated_at = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `).run(now, episodeId);
      return this.getCollaborationJob(episodeId);
    });
  }

  renewCollaborationClaim(
    episodeId: string,
    ownerId: string,
    claimToken: string,
    leaseExpiresAt: string,
    now: string,
  ): boolean {
    return Number(this.database.connection.prepare(`
      UPDATE character_collaboration_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE episode_id = ? AND status = 'running'
        AND owner_id = ? AND claim_token = ?
    `).run(leaseExpiresAt, now, episodeId, ownerId, claimToken).changes) === 1;
  }

  finishCollaborationJob(
    episodeId: string,
    status: Exclude<CharacterCollaborationJobStatus, "queued" | "running">,
    patch: { lastError?: string },
    now: string,
    claim: { ownerId: string; claimToken: string },
  ): boolean {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = ?, last_error = ?, updated_at = ?, completed_at = ?,
            owner_id = NULL, claim_token = NULL, lease_expires_at = NULL
        WHERE episode_id = ? AND status = 'running'
          AND owner_id = ? AND claim_token = ?
      `).run(
        status,
        patch.lastError ?? null,
        now,
        now,
        episodeId,
        claim.ownerId,
        claim.claimToken,
      );
      if (Number(result.changes) !== 1) return false;
      this.markCollaborationReportPending(episodeId, now);
      return true;
    });
  }

  releaseCollaborationOwner(ownerId: string, now: string): number {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(`
        SELECT episode_id FROM character_collaboration_jobs
        WHERE status = 'running' AND owner_id = ?
      `).all(ownerId) as Array<{ episode_id: string }>;
      const releaseJob = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = 'queued', available_at = ?, owner_id = NULL,
            claim_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE episode_id = ? AND status = 'running' AND owner_id = ?
      `);
      const releaseEpisode = this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET status = 'queued', updated_at = ?
        WHERE id = ? AND status = 'running'
      `);
      let released = 0;
      for (const row of rows) {
        const result = releaseJob.run(now, now, row.episode_id, ownerId);
        if (Number(result.changes) !== 1) continue;
        released += 1;
        releaseEpisode.run(now, row.episode_id);
      }
      return released;
    });
  }

  failExhaustedCollaborationJobs(now: string, reason: string): number {
    return this.database.transaction(() => {
      const rows = this.database.connection.prepare(`
        SELECT episode_id FROM character_collaboration_jobs
        WHERE attempts >= max_attempts
          AND (
            status = 'queued'
            OR (
              status = 'running'
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            )
          )
      `).all(now) as Array<{ episode_id: string }>;
      const failJob = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = 'failed', last_error = ?, updated_at = ?, completed_at = ?,
            owner_id = NULL, claim_token = NULL, lease_expires_at = NULL
        WHERE episode_id = ? AND status IN ('queued', 'running')
      `);
      const failEpisode = this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET status = 'failed', failure_reason = ?, updated_at = ?, completed_at = ?,
            report_status = COALESCE(report_status, 'pending')
        WHERE id = ? AND status IN ('queued', 'running')
      `);
      let failed = 0;
      for (const row of rows) {
        const result = failJob.run(reason, now, now, row.episode_id);
        if (Number(result.changes) !== 1) continue;
        failed += 1;
        failEpisode.run(reason, now, now, row.episode_id);
      }
      return failed;
    });
  }

  reconcileTerminalCollaborationJobs(now: string): number {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE character_collaboration_jobs
        SET status = CASE (
              SELECT status FROM character_channel_episodes
              WHERE id = character_collaboration_jobs.episode_id
            )
              WHEN 'completed' THEN 'completed'
              WHEN 'declined' THEN 'completed'
              WHEN 'cancelled' THEN 'cancelled'
              ELSE 'failed'
            END,
            last_error = CASE
              WHEN (
                SELECT status FROM character_channel_episodes
                WHERE id = character_collaboration_jobs.episode_id
              ) = 'failed'
              THEN (
                SELECT failure_reason FROM character_channel_episodes
                WHERE id = character_collaboration_jobs.episode_id
              )
              ELSE last_error
            END,
            updated_at = ?, completed_at = COALESCE(completed_at, ?),
            owner_id = NULL, claim_token = NULL, lease_expires_at = NULL
        WHERE status IN ('queued', 'running')
          AND EXISTS (
            SELECT 1 FROM character_channel_episodes
            WHERE id = character_collaboration_jobs.episode_id
              AND status IN ('completed', 'declined', 'failed', 'cancelled')
          )
      `).run(now, now);
      this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET report_status = 'pending', updated_at = ?
        WHERE report_status IS NULL
          AND status IN ('completed', 'declined', 'failed', 'cancelled')
          AND EXISTS (
            SELECT 1 FROM character_collaboration_jobs
            WHERE episode_id = character_channel_episodes.id
              AND status IN ('completed', 'failed', 'cancelled')
          )
      `).run(now);
      return Number(result.changes);
    });
  }

  recoverExpiredCollaborationReports(now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET report_status = 'pending', report_owner_id = NULL,
          report_claim_token = NULL, report_lease_expires_at = NULL, updated_at = ?
      WHERE report_status = 'delivering'
        AND (report_lease_expires_at IS NULL OR report_lease_expires_at <= ?)
    `).run(now, now).changes);
  }

  recoverInterruptedCollaborationReports(now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET report_status = 'pending', report_owner_id = NULL,
          report_claim_token = NULL, report_lease_expires_at = NULL, updated_at = ?
      WHERE report_status = 'delivering'
    `).run(now).changes);
  }

  listReportableCollaborationEpisodes(
    now: string,
    limit = 10,
  ): CharacterChannelEpisode[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 50));
    return (this.database.connection.prepare(`
      SELECT episodes.*
      FROM character_channel_episodes AS episodes
      WHERE episodes.status IN ('completed', 'declined', 'failed', 'cancelled')
        AND (
          episodes.report_status = 'pending'
          OR (
            episodes.report_status = 'delivering'
            AND (
              episodes.report_lease_expires_at IS NULL
              OR episodes.report_lease_expires_at <= ?
            )
          )
        )
        AND EXISTS (
          SELECT 1 FROM character_collaboration_jobs
          WHERE episode_id = episodes.id
        )
      ORDER BY episodes.completed_at, episodes.created_at, episodes.id
      LIMIT ?
    `).all(now, bounded) as Row[]).map(mapEpisode);
  }

  claimCollaborationReport(
    episodeId: string,
    ownerId: string,
    claimToken: string,
    now: string,
    leaseExpiresAt: string,
  ): CharacterChannelEpisode | undefined {
    return this.database.transaction(() => {
      const result = this.database.connection.prepare(`
        UPDATE character_channel_episodes
        SET report_status = 'delivering', report_attempts = report_attempts + 1,
            report_error = NULL, report_owner_id = ?, report_claim_token = ?,
            report_lease_expires_at = ?, updated_at = ?
        WHERE id = ?
          AND status IN ('completed', 'declined', 'failed', 'cancelled')
          AND (
            report_status = 'pending'
            OR (
              report_status = 'delivering'
              AND (report_lease_expires_at IS NULL OR report_lease_expires_at <= ?)
            )
          )
      `).run(ownerId, claimToken, leaseExpiresAt, now, episodeId, now);
      return Number(result.changes) === 1 ? this.getEpisode(episodeId) : undefined;
    });
  }

  renewCollaborationReportClaim(
    episodeId: string,
    ownerId: string,
    claimToken: string,
    leaseExpiresAt: string,
    now: string,
  ): boolean {
    return Number(this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET report_lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND report_status = 'delivering'
        AND report_owner_id = ? AND report_claim_token = ?
    `).run(leaseExpiresAt, now, episodeId, ownerId, claimToken).changes) === 1;
  }

  finishCollaborationReport(
    episodeId: string,
    status: Exclude<CharacterCollaborationReportStatus, "pending" | "delivering">,
    error: string | undefined,
    now: string,
    claim: { ownerId: string; claimToken: string },
  ): boolean {
    return Number(this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET report_status = ?, reported_at = ?, report_error = ?, updated_at = ?,
          report_owner_id = NULL, report_claim_token = NULL,
          report_lease_expires_at = NULL
      WHERE id = ? AND report_status = 'delivering'
        AND report_owner_id = ? AND report_claim_token = ?
    `).run(
      status,
      now,
      error ?? null,
      now,
      episodeId,
      claim.ownerId,
      claim.claimToken,
    ).changes) === 1;
  }

  releaseCollaborationReportOwner(ownerId: string, now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET report_status = 'pending', report_owner_id = NULL,
          report_claim_token = NULL, report_lease_expires_at = NULL, updated_at = ?
      WHERE report_status = 'delivering' AND report_owner_id = ?
    `).run(now, ownerId).changes);
  }

  private markCollaborationReportPending(episodeId: string, now: string): void {
    this.database.connection.prepare(`
      UPDATE character_channel_episodes
      SET report_status = COALESCE(report_status, 'pending'), updated_at = ?
      WHERE id = ? AND status IN ('completed', 'declined', 'failed', 'cancelled')
    `).run(now, episodeId);
  }
}

function mapChannel(row: Row): CharacterChannel {
  const lastUnreadAt = optionalString(row.last_unread_at);
  const lastReadAt = optionalString(row.last_read_at);
  const lastMessageAt = optionalString(row.last_message_at);
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    firstCharacterId: String(row.first_character_id),
    secondCharacterId: String(row.second_character_id),
    unreadCount: Number(row.unread_count),
    ...(lastUnreadAt ? { lastUnreadAt } : {}),
    ...(lastReadAt ? { lastReadAt } : {}),
    ...(lastMessageAt ? { lastMessageAt } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapEpisode(row: Row): CharacterChannelEpisode {
  const parentSessionId = optionalString(row.parent_session_id);
  const resultText = optionalString(row.result_text);
  const failureReason = optionalString(row.failure_reason);
  const reportStatus = optionalString(row.report_status) as
    | CharacterCollaborationReportStatus
    | undefined;
  const reportedAt = optionalString(row.reported_at);
  const reportError = optionalString(row.report_error);
  const completedAt = optionalString(row.completed_at);
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    worldId: String(row.world_id),
    kind: String(row.kind) as CharacterChannelEpisode["kind"],
    source: String(row.source) as CharacterChannelEpisode["source"],
    initiatorCharacterId: String(row.initiator_character_id),
    targetCharacterId: String(row.target_character_id),
    ...(parentSessionId ? { parentSessionId } : {}),
    title: String(row.title),
    objective: String(row.objective),
    status: String(row.status) as CharacterChannelEpisode["status"],
    modelCalls: Number(row.model_calls),
    messageCount: Number(row.message_count),
    idempotencyKey: String(row.idempotency_key),
    ...(resultText ? { resultText } : {}),
    ...(failureReason ? { failureReason } : {}),
    ...(reportStatus ? { reportStatus } : {}),
    ...(row.report_attempts === undefined
      ? {}
      : { reportAttempts: Number(row.report_attempts) }),
    ...(reportedAt ? { reportedAt } : {}),
    ...(reportError ? { reportError } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(completedAt ? { completedAt } : {}),
  };
}

function mapCollaborationJob(row: Row): CharacterCollaborationJob {
  const routing = JSON.parse(String(row.routing_json)) as CharacterCollaborationJob["routing"];
  const lastError = optionalString(row.last_error);
  const ownerId = optionalString(row.owner_id);
  const claimToken = optionalString(row.claim_token);
  const leaseExpiresAt = optionalString(row.lease_expires_at);
  const completedAt = optionalString(row.completed_at);
  return {
    episodeId: String(row.episode_id),
    openingMessage: String(row.opening_message),
    routing,
    status: String(row.status) as CharacterCollaborationJob["status"],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    ...(lastError ? { lastError } : {}),
    ...(ownerId ? { ownerId } : {}),
    ...(claimToken ? { claimToken } : {}),
    ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
    availableAt: String(row.available_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(completedAt ? { completedAt } : {}),
  };
}

function mapMessage(row: Row): CharacterChannelMessage {
  const senderCharacterId = optionalString(row.sender_character_id);
  return {
    id: String(row.id),
    channelId: String(row.channel_id),
    episodeId: String(row.episode_id),
    sequence: Number(row.sequence),
    senderType: String(row.sender_type) as CharacterChannelMessage["senderType"],
    ...(senderCharacterId ? { senderCharacterId } : {}),
    kind: String(row.kind) as CharacterChannelMessage["kind"],
    content: String(row.content),
    createdAt: String(row.created_at),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
