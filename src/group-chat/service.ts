import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { RpService } from "../rp/service.js";
import type { GroupChat, CreateGroupChatInput, GroupChatMessage, GroupChatTurn } from "./types.js";
import { GroupChatRepository } from "./repository.js";

export class GroupChatNotFoundError extends Error {
  constructor(id: string) {
    super(`group chat not found: ${id}`);
    this.name = "GroupChatNotFoundError";
  }
}

export class GroupChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroupChatValidationError";
  }
}

export class GroupChatService {
  constructor(
    readonly repository: GroupChatRepository,
    private readonly rpService: RpService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {}

  create(input: CreateGroupChatInput): GroupChat {
    const characterIds = [...new Set(input.characterIds.map((id) => id.trim()).filter(Boolean))];
    if (characterIds.length < 2 || characterIds.length > 8) {
      throw new GroupChatValidationError("group chat requires between 2 and 8 unique characters");
    }
    const characters = characterIds.map((id) => this.rpService.getCharacter(id));
    const maxSpeakers = input.maxSpeakers === undefined
      ? Math.min(3, characterIds.length)
      : Math.floor(input.maxSpeakers);
    if (!Number.isFinite(maxSpeakers) || maxSpeakers < 1 || maxSpeakers > characterIds.length) {
      throw new GroupChatValidationError("maxSpeakers must be between 1 and the member count");
    }
    if (input.mode !== undefined && input.mode !== "sms" && input.mode !== "rp") {
      throw new GroupChatValidationError("mode must be sms or rp");
    }
    const now = this.clock.now().toISOString();
    const title = input.title?.trim() || characters.map((character) => character.name).join("、");
    if ([...title].length > 80) throw new GroupChatValidationError("group chat title must not exceed 80 characters");
    const chat: GroupChat = {
      id: this.idGenerator.next("group-chat"),
      title,
      mode: input.mode ?? "sms",
      status: "active",
      maxSpeakers,
      characterIds,
      createdAt: now,
      updatedAt: now,
    };
    return this.repository.transaction(() => this.repository.create(chat));
  }

  get(id: string): GroupChat {
    const chat = this.repository.get(id);
    if (!chat) throw new GroupChatNotFoundError(id);
    return chat;
  }

  list(includeArchived = false): GroupChat[] {
    return this.repository.list(includeArchived);
  }

  archive(id: string): GroupChat {
    this.get(id);
    return this.repository.setStatus(id, "archived", this.clock.now().toISOString())!;
  }

  restore(id: string): GroupChat {
    this.get(id);
    return this.repository.setStatus(id, "active", this.clock.now().toISOString())!;
  }

  delete(id: string): { id: string; deleted: true } {
    this.get(id);
    this.repository.delete(id);
    return { id, deleted: true };
  }

  listMessages(groupId: string, limit?: number): GroupChatMessage[] {
    this.get(groupId);
    return this.repository.listMessages(groupId, limit);
  }

  beginTurn(groupId: string, text: string): { turn: GroupChatTurn; message: GroupChatMessage } {
    const chat = this.get(groupId);
    if (chat.status !== "active") throw new GroupChatValidationError("group chat is archived");
    const content = text.trim();
    if (!content) throw new GroupChatValidationError("message text is required");
    if ([...content].length > 20_000) throw new GroupChatValidationError("message text is too long");
    const now = this.clock.now().toISOString();
    const turn: GroupChatTurn = {
      id: this.idGenerator.next("group-turn"),
      groupId,
      status: "running",
      modelCalls: 0,
      speakerCount: 0,
      messageCount: 0,
      startedAt: now,
    };
    return this.repository.transaction(() => {
      this.repository.createTurn(turn);
      const message = this.repository.appendMessage({
        id: this.idGenerator.next("group-message"),
        groupId,
        turnId: turn.id,
        senderType: "user",
        content,
        createdAt: now,
      });
      this.repository.touch(groupId, now);
      return { turn, message };
    });
  }
}
