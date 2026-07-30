import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { RpService } from "../rp/service.js";
import type { CharacterChannelRepository } from "./character-channel-repository.js";
import { WorldValidationError, type WorldService } from "./service.js";
import type {
  CharacterChannel,
  CharacterChannelEpisode,
  CharacterChannelEpisodeKind,
  CharacterChannelEpisodeSource,
  CharacterChannelEpisodeStatus,
  CharacterChannelMessage,
  CharacterChannelMessageKind,
  CharacterChannelSnapshot,
  CharacterChannelSummary,
  CharacterCollaborationSummary,
} from "./types.js";

const MAX_CHANNEL_TEXT = 4_000;
const MAX_OBJECTIVE_TEXT = 2_000;

export class CharacterChannelService {
  constructor(
    readonly repository: CharacterChannelRepository,
    private readonly worldService: WorldService,
    private readonly rpService: RpService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  ensureDirectChannel(
    firstCharacterId: string,
    secondCharacterId: string,
  ): CharacterChannel {
    if (firstCharacterId === secondCharacterId) {
      throw new WorldValidationError("a character channel requires two different characters");
    }
    this.rpService.getCharacter(firstCharacterId);
    this.rpService.getCharacter(secondCharacterId);
    const firstMembership = this.worldService.repository.getMembership(firstCharacterId);
    const secondMembership = this.worldService.repository.getMembership(secondCharacterId);
    if (!firstMembership || !secondMembership || firstMembership.worldId !== secondMembership.worldId) {
      throw new WorldValidationError("character channels require two characters in the same shared world");
    }
    const [first, second] = canonicalPair(firstCharacterId, secondCharacterId);
    const existing = this.repository.getChannelByPair(firstMembership.worldId, first, second);
    if (existing) return existing;
    const now = this.clock.now().toISOString();
    return this.repository.ensureChannel({
      id: this.idGenerator.next("character-channel"),
      worldId: firstMembership.worldId,
      firstCharacterId: first,
      secondCharacterId: second,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }

  getChannel(id: string): CharacterChannel {
    const channel = this.repository.getChannel(id);
    if (!channel) throw new WorldValidationError(`character channel not found: ${id}`);
    return channel;
  }

  listChannels(input: {
    worldId?: string;
    characterId?: string;
    limit?: number;
  } = {}): CharacterChannelSummary[] {
    if (input.worldId) this.worldService.getWorld(input.worldId);
    if (input.characterId) this.rpService.getCharacter(input.characterId);
    return this.repository.listChannels(input).map((channel) => this.summarize(channel));
  }

  snapshot(channelId: string, options: {
    messageLimit?: number;
    episodeLimit?: number;
    focusEpisodeId?: string;
  } = {}): CharacterChannelSnapshot {
    const channel = this.getChannel(channelId);
    const episodes = this.repository.listEpisodes(channel.id, options.episodeLimit ?? 40);
    const messages = this.repository.listMessages(channel.id, options.messageLimit ?? 120);
    const focusEpisodeId = cleanText(options.focusEpisodeId, 240);
    if (focusEpisodeId) {
      const focusedEpisode = this.repository.getEpisode(focusEpisodeId);
      if (!focusedEpisode || focusedEpisode.channelId !== channel.id) {
        throw new WorldValidationError(
          `character channel episode not found in channel: ${focusEpisodeId}`,
        );
      }
      if (!episodes.some((episode) => episode.id === focusedEpisode.id)) {
        episodes.push(focusedEpisode);
        episodes.sort(compareEpisodesNewestFirst);
      }
      const focusedMessages = this.repository.listEpisodeMessages(focusedEpisode.id);
      const messageIds = new Set(messages.map((message) => message.id));
      for (const message of focusedMessages) {
        if (!messageIds.has(message.id)) messages.push(message);
      }
      messages.sort((left, right) => left.sequence - right.sequence);
    }
    return {
      channel: this.summarize(channel),
      episodes,
      messages,
    };
  }

  listSessionCollaborations(
    parentSessionId: string,
    initiatorCharacterId: string,
    limit = 100,
  ): CharacterCollaborationSummary[] {
    const sessionId = requiredIdentifier(parentSessionId, "parent session id");
    const characterId = requiredText(initiatorCharacterId, "initiator character id", 240);
    this.rpService.getCharacter(characterId);
    return this.repository.listCollaborationEpisodesByParentSession(sessionId, characterId, limit)
      .reverse()
      .map((episode) => {
        const initiator = this.rpService.getCharacter(episode.initiatorCharacterId);
        const target = this.rpService.getCharacter(episode.targetCharacterId);
        return {
          episodeId: episode.id,
          channelId: episode.channelId,
          worldId: episode.worldId,
          initiatorCharacterId: initiator.id,
          initiatorCharacterName: initiator.name,
          targetCharacterId: target.id,
          targetCharacterName: target.name,
          title: episode.title,
          objective: episode.objective,
          status: episode.status,
          messageCount: episode.messageCount,
          createdAt: episode.createdAt,
          updatedAt: episode.updatedAt,
          ...(episode.completedAt ? { completedAt: episode.completedAt } : {}),
        };
      });
  }

  unlinkSession(parentSessionId: string): number {
    const sessionId = requiredIdentifier(parentSessionId, "parent session id");
    return this.repository.unlinkParentSession(sessionId);
  }

  markRead(channelId: string): CharacterChannelSummary {
    const channel = this.getChannel(channelId);
    return this.summarize(
      this.repository.markRead(channel.id, this.clock.now().toISOString()) ?? channel,
    );
  }

  startEpisode(input: {
    initiatorCharacterId: string;
    targetCharacterId: string;
    kind: CharacterChannelEpisodeKind;
    source: CharacterChannelEpisodeSource;
    idempotencyKey: string;
    parentSessionId?: string;
    title?: string;
    objective?: string;
  }): { channel: CharacterChannel; episode: CharacterChannelEpisode; existing: boolean } {
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotency key", 500);
    const existing = this.repository.findEpisodeByIdempotencyKey(idempotencyKey);
    if (existing) {
      return {
        channel: this.getChannel(existing.channelId),
        episode: existing,
        existing: true,
      };
    }
    const channel = this.ensureDirectChannel(input.initiatorCharacterId, input.targetCharacterId);
    const now = this.clock.now().toISOString();
    const parentSessionId = cleanIdentifier(input.parentSessionId);
    const episode = this.repository.createEpisode({
      id: this.idGenerator.next("character-channel-episode"),
      channelId: channel.id,
      worldId: channel.worldId,
      kind: input.kind,
      source: input.source,
      initiatorCharacterId: input.initiatorCharacterId,
      targetCharacterId: input.targetCharacterId,
      ...(parentSessionId ? { parentSessionId } : {}),
      title: cleanText(input.title, 160),
      objective: cleanText(input.objective, MAX_OBJECTIVE_TEXT),
      status: "queued",
      modelCalls: 0,
      messageCount: 0,
      idempotencyKey,
      createdAt: now,
      updatedAt: now,
    });
    return { channel, episode, existing: false };
  }

  updateEpisode(
    episodeId: string,
    patch: {
      status?: CharacterChannelEpisodeStatus;
      modelCalls?: number;
      resultText?: string;
      failureReason?: string;
      completed?: boolean;
    },
  ): CharacterChannelEpisode {
    const current = this.repository.getEpisode(episodeId);
    if (!current) throw new WorldValidationError(`character channel episode not found: ${episodeId}`);
    const now = this.clock.now().toISOString();
    const next: CharacterChannelEpisode = {
      ...current,
      status: patch.status ?? current.status,
      modelCalls: patch.modelCalls === undefined
        ? current.modelCalls
        : Math.max(0, Math.floor(patch.modelCalls)),
      ...(patch.resultText === undefined
        ? (current.resultText ? { resultText: current.resultText } : {})
        : cleanText(patch.resultText, MAX_CHANNEL_TEXT)
          ? { resultText: cleanText(patch.resultText, MAX_CHANNEL_TEXT) }
          : {}),
      ...(patch.failureReason === undefined
        ? (current.failureReason ? { failureReason: current.failureReason } : {})
        : cleanText(patch.failureReason, 800)
          ? { failureReason: cleanText(patch.failureReason, 800) }
          : {}),
      updatedAt: now,
      ...(patch.completed ? { completedAt: now } : (current.completedAt ? { completedAt: current.completedAt } : {})),
    };
    if (patch.resultText !== undefined && !cleanText(patch.resultText, MAX_CHANNEL_TEXT)) {
      delete next.resultText;
    }
    if (patch.failureReason !== undefined && !cleanText(patch.failureReason, 800)) {
      delete next.failureReason;
    }
    return this.repository.updateEpisode(next);
  }

  appendCharacterMessage(input: {
    channelId: string;
    episodeId: string;
    senderCharacterId: string;
    kind?: CharacterChannelMessageKind;
    content: string;
    unread?: boolean;
  }): CharacterChannelMessage {
    const channel = this.getChannel(input.channelId);
    if (
      input.senderCharacterId !== channel.firstCharacterId &&
      input.senderCharacterId !== channel.secondCharacterId
    ) {
      throw new WorldValidationError("message sender is not a member of the character channel");
    }
    const episode = this.repository.getEpisode(input.episodeId);
    if (!episode || episode.channelId !== channel.id) {
      throw new WorldValidationError("message episode does not belong to the character channel");
    }
    const content = requiredText(input.content, "character channel message", MAX_CHANNEL_TEXT);
    return this.repository.transaction(() => this.repository.appendMessage({
      id: this.idGenerator.next("character-channel-message"),
      channelId: channel.id,
      episodeId: episode.id,
      senderType: "character",
      senderCharacterId: input.senderCharacterId,
      kind: input.kind ?? "message",
      content,
      createdAt: this.clock.now().toISOString(),
    }, input.unread ?? true));
  }

  appendSystemMessage(input: {
    channelId: string;
    episodeId: string;
    content: string;
    unread?: boolean;
  }): CharacterChannelMessage {
    const channel = this.getChannel(input.channelId);
    const episode = this.repository.getEpisode(input.episodeId);
    if (!episode || episode.channelId !== channel.id) {
      throw new WorldValidationError("message episode does not belong to the character channel");
    }
    const content = requiredText(input.content, "character channel status", 800);
    return this.repository.transaction(() => this.repository.appendMessage({
      id: this.idGenerator.next("character-channel-message"),
      channelId: channel.id,
      episodeId: episode.id,
      senderType: "system",
      kind: "status",
      content,
      createdAt: this.clock.now().toISOString(),
    }, input.unread ?? true));
  }

  private summarize(channel: CharacterChannel): CharacterChannelSummary {
    const first = this.rpService.getCharacter(channel.firstCharacterId);
    const second = this.rpService.getCharacter(channel.secondCharacterId);
    const latest = this.repository.latestMessage(channel.id);
    const latestEpisode = this.repository.listEpisodes(channel.id, 1)[0];
    return {
      ...channel,
      characterIds: [first.id, second.id],
      characterNames: [first.name, second.name],
      preview: latest?.content ?? "",
      ...(latestEpisode ? { latestEpisodeStatus: latestEpisode.status } : {}),
    };
  }
}

function canonicalPair(firstCharacterId: string, secondCharacterId: string): [string, string] {
  return firstCharacterId.localeCompare(secondCharacterId) < 0
    ? [firstCharacterId, secondCharacterId]
    : [secondCharacterId, firstCharacterId];
}

function compareEpisodesNewestFirst(
  left: CharacterChannelEpisode,
  right: CharacterChannelEpisode,
): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = cleanText(value, maximum);
  if (!normalized) throw new WorldValidationError(`${label} is required`);
  return normalized;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = cleanIdentifier(value);
  if (!normalized) throw new WorldValidationError(`${label} is required`);
  return normalized;
}

function cleanIdentifier(value: string | undefined): string {
  return String(value ?? "").trim();
}

function cleanText(value: string | undefined, maximum: number): string {
  return [...String(value ?? "").trim()].slice(0, maximum).join("");
}
