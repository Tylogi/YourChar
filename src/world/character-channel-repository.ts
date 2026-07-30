import type { AppDatabase } from "../storage/database.js";
import type {
  CharacterChannel,
  CharacterChannelEpisode,
  CharacterChannelMessage,
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
