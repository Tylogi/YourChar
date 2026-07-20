import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { WorldService } from "./service.js";
import type {
  WorldCharacterObservation,
  WorldCharacterRelationship,
  WorldConversationAttachment,
  WorldConversationMessage,
  WorldConversationTurn,
  WorldStoryEvent,
  WorldStoryTransition,
} from "./types.js";
import { WorldConversationRepository } from "./conversation-repository.js";

export class WorldConversationValidationError extends Error {
  readonly code = "WORLD_CONVERSATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorldConversationValidationError";
  }
}

export type WorldStoryDecisionInput = {
  action: "none" | "propose" | "begin" | "resolve" | "cancel";
  title?: string;
  summary?: string;
  objective?: string;
  placeId?: string;
  participantIds?: string[];
  turnId?: string;
  source: WorldStoryTransition["source"];
};

export class WorldConversationService {
  constructor(
    readonly repository: WorldConversationRepository,
    private readonly worldService: WorldService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  list() {
    const now = this.clock.now().toISOString();
    return this.worldService.listWorlds().map((world) => {
      const conversation = this.repository.ensureConversation(world.id, now);
      const messages = this.repository.listMessages(world.id, 1);
      const memberships = this.worldService.repository.listMemberships(world.id);
      return {
        ...conversation,
        world,
        characterIds: memberships.map((entry) => entry.characterId),
        messageCount: this.repository.messageCount(world.id),
        preview: messages.at(-1)?.content ?? "",
        activeEvent: this.repository.getOpenStoryEvent(world.id),
      };
    }).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(worldId: string) {
    const world = this.worldService.getWorld(worldId);
    const conversation = this.repository.ensureConversation(world.id, this.clock.now().toISOString());
    return {
      ...conversation,
      world,
      characterIds: this.worldService.repository.listMemberships(world.id).map((entry) => entry.characterId),
      messageCount: this.repository.messageCount(world.id),
      activeEvent: this.repository.getOpenStoryEvent(world.id),
      events: this.repository.listStoryEvents(world.id, 30),
      relationships: this.repository.listCharacterRelationships(world.id),
    };
  }

  listMessages(worldId: string, limit = 200): WorldConversationMessage[] {
    this.worldService.getWorld(worldId);
    return this.repository.listMessages(worldId, limit);
  }

  beginTurn(
    worldId: string,
    text: string,
    attachments: WorldConversationAttachment[] = [],
  ): { turn: WorldConversationTurn; message: WorldConversationMessage } {
    const world = this.worldService.getWorld(worldId);
    if (world.status !== "active") throw new WorldConversationValidationError("world is archived");
    if (!this.worldService.repository.listMemberships(worldId).length) {
      throw new WorldConversationValidationError("add at least one character to the world before sending a message");
    }
    const content = text.trim();
    if (!content && !attachments.length) throw new WorldConversationValidationError("message text or attachment is required");
    if ([...content].length > 20_000) throw new WorldConversationValidationError("message text is too long");
    const now = this.clock.now().toISOString();
    const turn: WorldConversationTurn = {
      id: this.idGenerator.next("world-turn"),
      worldId,
      status: "running",
      modelCalls: 0,
      actorCount: 0,
      startedAt: now,
    };
    return this.repository.transaction(() => {
      this.repository.ensureConversation(worldId, now);
      this.repository.createTurn(turn);
      const message = this.repository.appendMessage({
        id: this.idGenerator.next("world-message"),
        worldId,
        turnId: turn.id,
        senderType: "user",
        content,
        attachments: normalizeAttachments(attachments),
        createdAt: now,
      });
      this.repository.touch(worldId, now);
      return { turn, message };
    });
  }

  appendMessage(input: {
    worldId: string;
    turnId: string;
    senderType: "director" | "character" | "system";
    senderId?: string;
    content: string;
  }): WorldConversationMessage {
    const content = input.content.trim();
    if (!content) throw new WorldConversationValidationError("world message content is required");
    const now = this.clock.now().toISOString();
    return this.repository.transaction(() => {
      const message = this.repository.appendMessage({
        id: this.idGenerator.next("world-message"),
        worldId: input.worldId,
        turnId: input.turnId,
        senderType: input.senderType,
        ...(input.senderId ? { senderId: input.senderId } : {}),
        content,
        attachments: [],
        createdAt: now,
      });
      this.repository.touch(input.worldId, now);
      return message;
    });
  }

  finishTurn(
    turnId: string,
    status: WorldConversationTurn["status"],
    modelCalls: number,
    actorCount: number,
    hasIncomingOutput: boolean,
  ): WorldConversationTurn {
    const current = this.repository.getTurn(turnId);
    if (!current) throw new WorldConversationValidationError(`world turn not found: ${turnId}`);
    const now = this.clock.now().toISOString();
    return this.repository.transaction(() => {
      const turn = this.repository.finishTurn(turnId, status, modelCalls, actorCount, now);
      if (hasIncomingOutput) this.repository.recordUnread(current.worldId, now);
      else this.repository.touch(current.worldId, now);
      return turn;
    });
  }

  markRead(worldId: string) {
    this.worldService.getWorld(worldId);
    this.repository.ensureConversation(worldId, this.clock.now().toISOString());
    return this.repository.markRead(worldId, this.clock.now().toISOString());
  }

  applyStoryDecision(worldId: string, input: WorldStoryDecisionInput): WorldStoryEvent | undefined {
    this.worldService.getWorld(worldId);
    const action = input.action;
    if (action === "none") return this.repository.getOpenStoryEvent(worldId);
    const memberships = new Set(
      this.worldService.repository.listMemberships(worldId).map((entry) => entry.characterId),
    );
    const participants = [...new Set(input.participantIds ?? [])].filter((id) => memberships.has(id));
    if (input.placeId) {
      const place = this.worldService.getPlace(input.placeId);
      if (place.worldId !== worldId) throw new WorldConversationValidationError("story event place belongs to another world");
    }
    const now = this.clock.now().toISOString();
    return this.repository.transaction(() => {
      const current = this.repository.getOpenStoryEvent(worldId);
      const beforeState = current ? { ...current, participantIds: [...current.participantIds] } : undefined;
      let afterState: WorldStoryEvent | undefined;
      if (action === "propose" || action === "begin") {
        const status = action === "begin" ? "active" as const : "planned" as const;
        if (current) {
          afterState = {
            ...current,
            ...(input.placeId ? { placeId: input.placeId } : {}),
            title: cleanText(input.title, current.title, 120),
            summary: cleanText(input.summary, current.summary, 1_200),
            objective: cleanText(input.objective, current.objective, 800),
            status,
            revision: current.revision + 1,
            participantIds: participants.length ? participants : current.participantIds,
            updatedAt: now,
            ...(status === "active" ? { startedAt: current.startedAt ?? now } : {}),
          };
        } else {
          afterState = {
            id: this.idGenerator.next("world-story-event"),
            worldId,
            ...(input.placeId ? { placeId: input.placeId } : {}),
            title: cleanText(input.title, "新的事件", 120),
            summary: cleanText(input.summary, "", 1_200),
            objective: cleanText(input.objective, "", 800),
            status,
            revision: 1,
            participantIds: participants,
            createdAt: now,
            updatedAt: now,
            ...(status === "active" ? { startedAt: now } : {}),
          };
        }
      } else {
        if (!current) return undefined;
        afterState = {
          ...current,
          title: cleanText(input.title, current.title, 120),
          summary: cleanText(input.summary, current.summary, 1_200),
          objective: cleanText(input.objective, current.objective, 800),
          status: action === "resolve" ? "resolved" : "cancelled",
          revision: current.revision + 1,
          participantIds: participants.length ? participants : current.participantIds,
          updatedAt: now,
          endedAt: now,
        };
      }
      const saved = this.repository.saveStoryEvent(afterState);
      this.repository.recordStoryTransition({
        id: this.idGenerator.next("world-story-transition"),
        worldId,
        eventId: saved.id,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        eventType: action,
        source: input.source,
        status: "applied",
        summary: saved.summary || saved.title,
        ...(beforeState ? { beforeState } : {}),
        afterState: saved,
        createdAt: now,
      });
      return saved;
    });
  }

  undoLatestStoryTransition(worldId: string): WorldStoryEvent | undefined {
    this.worldService.getWorld(worldId);
    const now = this.clock.now().toISOString();
    return this.repository.transaction(() => {
      const transition = this.repository.latestAppliedStoryTransition(worldId);
      if (!transition) throw new WorldConversationValidationError("no world event transition can be undone");
      const current = transition.eventId ? this.repository.getStoryEvent(transition.eventId) : undefined;
      if (transition.afterState && (!current || current.revision !== transition.afterState.revision)) {
        throw new WorldConversationValidationError("the world event changed after this transition and cannot be undone");
      }
      let restored: WorldStoryEvent | undefined;
      if (transition.beforeState) restored = this.repository.saveStoryEvent(transition.beforeState);
      else if (transition.eventId) this.repository.deleteStoryEvent(transition.eventId);
      this.repository.revertStoryTransition(transition.id, now);
      this.repository.recordStoryTransition({
        id: this.idGenerator.next("world-story-transition"),
        worldId,
        ...(transition.eventId ? { eventId: transition.eventId } : {}),
        eventType: "undo",
        source: "user_control",
        status: "applied",
        summary: `撤销：${transition.summary}`,
        ...(transition.afterState ? { beforeState: transition.afterState } : {}),
        ...(transition.beforeState ? { afterState: transition.beforeState } : {}),
        createdAt: now,
      });
      return restored;
    });
  }

  createObservation(input: Omit<WorldCharacterObservation, "id" | "createdAt">): WorldCharacterObservation {
    const membership = this.worldService.repository.getMembership(input.characterId);
    if (membership?.worldId !== input.worldId) {
      throw new WorldConversationValidationError("observation character does not belong to the world");
    }
    const observation: WorldCharacterObservation = {
      ...input,
      id: this.idGenerator.next("world-observation"),
      summary: cleanText(input.summary, "", 1_000),
      salience: boundedUnit(input.salience),
      createdAt: this.clock.now().toISOString(),
    };
    if (!observation.summary) throw new WorldConversationValidationError("observation summary is required");
    return this.repository.createObservation(observation);
  }

  applyRelationshipDelta(input: {
    worldId: string;
    subjectCharacterId: string;
    objectCharacterId: string;
    affinityDelta: number;
    trustDelta: number;
    tensionDelta: number;
    intimacyDelta: number;
    summary: string;
  }): WorldCharacterRelationship {
    if (input.subjectCharacterId === input.objectCharacterId) {
      throw new WorldConversationValidationError("a character relationship requires two characters");
    }
    for (const id of [input.subjectCharacterId, input.objectCharacterId]) {
      if (this.worldService.repository.getMembership(id)?.worldId !== input.worldId) {
        throw new WorldConversationValidationError("relationship character does not belong to the world");
      }
    }
    const current = this.repository.getCharacterRelationship(
      input.worldId,
      input.subjectCharacterId,
      input.objectCharacterId,
    );
    const now = this.clock.now().toISOString();
    const next: WorldCharacterRelationship = {
      worldId: input.worldId,
      subjectCharacterId: input.subjectCharacterId,
      objectCharacterId: input.objectCharacterId,
      affinity: boundedScore((current?.affinity ?? 50) + boundedDelta(input.affinityDelta)),
      trust: boundedScore((current?.trust ?? 40) + boundedDelta(input.trustDelta)),
      tension: boundedScore((current?.tension ?? 0) + boundedDelta(input.tensionDelta)),
      intimacy: boundedScore((current?.intimacy ?? 15) + boundedDelta(input.intimacyDelta)),
      summary: cleanText(input.summary, current?.summary ?? "", 600),
      revision: (current?.revision ?? 0) + 1,
      updatedAt: now,
    };
    return this.repository.upsertCharacterRelationship(next);
  }

  characterContext(worldId: string, characterId: string): string {
    const observations = this.repository.listObservations(characterId, worldId, 8);
    const relationships = this.repository.listCharacterRelationships(worldId, characterId).slice(0, 8);
    const activeEvent = this.repository.getOpenStoryEvent(worldId);
    const lines = [
      activeEvent
        ? `Active world event: ${activeEvent.title}; status=${activeEvent.status}; ${activeEvent.summary}`
        : "Active world event: none.",
      observations.length ? "Character observations (knowledge is observer-scoped):" : "",
      ...observations.map((entry) => `- [${entry.knowledge}] ${entry.summary}`),
      relationships.length ? "Character-to-character relationship state (express subtly):" : "",
      ...relationships.map((entry) =>
        `- ${entry.subjectCharacterId} -> ${entry.objectCharacterId}: affinity=${band(entry.affinity)}, trust=${band(entry.trust)}, tension=${band(entry.tension)}, intimacy=${band(entry.intimacy)}${entry.summary ? `; ${entry.summary}` : ""}`),
    ].filter(Boolean);
    return lines.join("\n").slice(0, 4_000);
  }
}

function normalizeAttachments(input: WorldConversationAttachment[]): WorldConversationAttachment[] {
  return input.slice(0, 8).flatMap((entry) => {
    const path = String(entry.path ?? "").trim();
    if (!path) return [];
    return [{
      path: path.slice(0, 500),
      ...(entry.name ? { name: entry.name.slice(0, 200) } : {}),
      ...(entry.contentType ? { contentType: entry.contentType.slice(0, 100) } : {}),
      ...(typeof entry.size === "number" && Number.isFinite(entry.size) ? { size: Math.max(0, Math.floor(entry.size)) } : {}),
    }];
  });
}

function cleanText(value: string | undefined, fallback: string, limit: number): string {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim() || fallback;
  return [...normalized].slice(0, limit).join("");
}

function boundedUnit(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0.5));
}

function boundedDelta(value: number): number {
  return Math.max(-5, Math.min(5, Math.round(Number.isFinite(value) ? value : 0)));
}

function boundedScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function band(value: number): string {
  if (value >= 75) return "high";
  if (value >= 45) return "moderate";
  if (value >= 20) return "low";
  return "very_low";
}
