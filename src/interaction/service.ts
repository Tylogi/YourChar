import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { Mode } from "../domain/types.js";
import type { RpService } from "../rp/service.js";
import type { WorldService } from "../world/service.js";
import type { PostTurnInteractionDecision } from "../post-turn/types.js";
import { contradictsImmediateCoPresence } from "./evidence.js";
import type { InteractionRepository } from "./repository.js";
import type {
  InteractionEvent,
  InteractionEventSource,
  InteractionEvidenceKind,
  InteractionScope,
  InteractionState,
  InteractionStateSnapshot,
  InteractionTransitionResult,
  InteractionWorldRuntimeSnapshot,
} from "./types.js";

export type InteractionValidationCode =
  | "INTERACTION_MODE_INVALID"
  | "INTERACTION_TRANSITION_INVALID"
  | "INTERACTION_EVIDENCE_REQUIRED"
  | "INTERACTION_LOCATION_INVALID"
  | "INTERACTION_CONFLICT"
  | "INTERACTION_UNDO_UNAVAILABLE";

export class InteractionValidationError extends Error {
  constructor(message: string, readonly code: InteractionValidationCode) {
    super(message);
    this.name = "InteractionValidationError";
  }
}

type LocationInput = { placeId?: string; location?: string };

export class InteractionService {
  constructor(
    readonly repository: InteractionRepository,
    private readonly rpService: RpService,
    private readonly worldService: WorldService,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly reportProjectionWarning: (warning: {
      operation: string;
      sessionId: string;
      characterId: string;
      errorName: string;
      errorCode?: string;
    }) => void = () => undefined,
  ) {}

  ensure(
    sessionId: string,
    characterId: string,
    mode: Mode,
    scope: InteractionScope,
  ): InteractionState {
    assertScopeForCharacter(scope, characterId);
    const existing = this.repository.getState(sessionId, scope);
    if (existing) {
      if (existing.characterId !== characterId) {
        throw new InteractionValidationError(
          `interaction state already belongs to character ${existing.characterId}`,
          "INTERACTION_CONFLICT",
        );
      }
      return existing;
    }
    const now = this.clock.now().toISOString();
    return this.repository.upsertState(defaultState(sessionId, characterId, mode, scope, now));
  }

  peekOrDefault(
    sessionId: string,
    characterId: string,
    mode: Mode,
    scope: InteractionScope,
  ): InteractionState {
    assertScopeForCharacter(scope, characterId);
    return this.repository.getState(sessionId, scope) ?? defaultState(
      sessionId,
      characterId,
      mode,
      scope,
      this.clock.now().toISOString(),
    );
  }

  get(sessionId: string, scope: InteractionScope): InteractionState | undefined {
    return this.repository.getState(sessionId, scope);
  }

  listEvents(sessionId: string, scope: InteractionScope, limit = 50): InteractionEvent[] {
    return this.repository.listEvents(sessionId, scope, limit);
  }

  listAllEvents(sessionId: string, scope: InteractionScope): InteractionEvent[] {
    return this.repository.listAllEvents(sessionId, scope);
  }

  canUndoLatest(sessionId: string, scope: InteractionScope): boolean {
    const state = this.repository.getState(sessionId, scope);
    const event = this.repository.latestAppliedReversibleEvent(sessionId, scope);
    return Boolean(state && !state.pendingEventId && event && sameSnapshot(snapshot(state), event.afterState));
  }

  runtimeContextFor(
    sessionId: string,
    characterId: string,
    mode: Mode,
    scope: InteractionScope,
  ): string {
    const state = this.peekOrDefault(sessionId, characterId, mode, scope);
    const attributes = [
      `conversation_space="${state.conversationSpace}"`,
      `continuity="${state.continuity}"`,
      `presence="${state.presence}"`,
      `lens="${state.lens}"`,
      `revision="${state.revision}"`,
    ].join(" ");
    if (state.continuity === "sandbox") {
      return [
        `<interaction_state ${attributes}>`,
        "This is an isolated narrative scene. Use close third-person narration and the RP scene contract.",
        "</interaction_state>",
      ].join("\n");
    }
    if (state.presence === "co_present") {
      return [
        `<interaction_state ${attributes}>`,
        `Physical co-presence is confirmed${state.location ? ` at: ${xml(state.location)}` : ""}.`,
        "Use observable-scene output: describe environment and the character's visible actions, expression, and dialogue. Never invent the user's actions, speech, decisions, sensations, or inner state.",
        state.conversationSpace === "secret"
          ? "Co-presence changes only the narrative lens. Normal-space profile, relationship, schedule, world, scene, and collaboration state remain unavailable."
          : "Co-presence changes only the narrative lens. This remains a canonical private conversation: user reminders and user schedule requests still use calendar=user; character plans use calendar=character.",
        "</interaction_state>",
      ].join("\n");
    }
    if (state.presence === "meeting_pending") {
      return [
        `<interaction_state ${attributes}>`,
        `A meeting is planned${state.location ? ` at: ${xml(state.location)}` : "; location is not fixed"}, but physical co-presence is not yet confirmed.`,
        "Continue as first-person direct messages. Do not narrate a shared scene or claim the user has arrived until begin_meeting succeeds.",
        "</interaction_state>",
      ].join("\n");
    }
    return [
      `<interaction_state ${attributes}>`,
      "The user and character are communicating remotely. Use first-person direct messages only; do not narrate a shared physical scene.",
      "</interaction_state>",
    ].join("\n");
  }

  proposeMeeting(input: {
    sessionId: string;
    characterId: string;
    mode: Mode;
    scope: InteractionScope;
    placeId?: string;
    location?: string;
    note?: string;
    source: InteractionEventSource;
    idempotencyKey?: string;
  }): InteractionTransitionResult {
    const replay = input.idempotencyKey && this.repository.findEventByIdempotencyKey(
      input.idempotencyKey,
      input.scope,
    );
    if (replay) {
      return {
        state: this.ensure(input.sessionId, input.characterId, input.mode, input.scope),
        event: replay,
      };
    }
    const state = this.ensureCanonical(input.sessionId, input.characterId, input.mode, input.scope);
    this.assertNoPendingTransition(state);
    if (state.presence === "co_present") {
      throw new InteractionValidationError("the user and character are already together", "INTERACTION_TRANSITION_INVALID");
    }
    const location = this.resolveLocation(state, input);
    const note = optionalBounded(input.note, 240, "meeting note");
    const now = this.clock.now().toISOString();
    const after: InteractionState = {
      ...state,
      presence: "meeting_pending",
      lens: "message",
      ...(location.placeId ? { placeId: location.placeId } : { placeId: undefined }),
      ...(location.location ? { location: location.location } : { location: undefined }),
      ...(note ? { meetingNote: note } : { meetingNote: undefined }),
      revision: state.revision + 1,
      updatedAt: now,
    };
    return this.applyTransition({
      before: state,
      after,
      type: "propose_meeting",
      source: input.source,
      evidenceKind: input.source === "user_control" ? "ui_confirmation" : "character_action",
      summary: location.location ? `约定在${location.location}见面` : "约定见面，地点待定",
      idempotencyKey: input.idempotencyKey,
    });
  }

  beginMeeting(input: {
    sessionId: string;
    characterId: string;
    mode: Mode;
    scope: InteractionScope;
    placeId?: string;
    location?: string;
    source: InteractionEventSource;
    evidenceText?: string;
    userConfirmed?: boolean;
    idempotencyKey?: string;
  }): InteractionTransitionResult {
    const replay = input.idempotencyKey && this.repository.findEventByIdempotencyKey(
      input.idempotencyKey,
      input.scope,
    );
    if (replay) {
      return {
        state: this.ensure(input.sessionId, input.characterId, input.mode, input.scope),
        event: replay,
      };
    }
    const state = this.ensureCanonical(input.sessionId, input.characterId, input.mode, input.scope);
    this.assertNoPendingTransition(state);
    if (state.presence === "co_present") {
      throw new InteractionValidationError("physical co-presence is already active", "INTERACTION_TRANSITION_INVALID");
    }
    const directAgentTransition = state.presence === "remote" && input.source === "agent_tool";
    if (state.presence !== "meeting_pending" && !directAgentTransition) {
      throw new InteractionValidationError(
        "a meeting must be planned before physical co-presence can begin",
        "INTERACTION_TRANSITION_INVALID",
      );
    }
    if (directAgentTransition && !input.placeId && !input.location) {
      throw new InteractionValidationError(
        "an immediate meeting transition from remote chat requires a concrete location",
        "INTERACTION_LOCATION_INVALID",
      );
    }
    const location = this.resolveLocation(state, input);
    if (!location.location) {
      throw new InteractionValidationError(
        "meeting location is still ambiguous; ask naturally where the user arrived",
        "INTERACTION_LOCATION_INVALID",
      );
    }
    if (input.source === "agent_tool" && contradictsImmediateCoPresence(input.evidenceText ?? "")) {
      throw new InteractionValidationError(
        "the current user message explicitly contradicts immediate co-presence; remain in direct messages",
        "INTERACTION_EVIDENCE_REQUIRED",
      );
    }
    if (input.source === "user_control" && input.userConfirmed !== true) {
      throw new InteractionValidationError("explicit UI confirmation is required", "INTERACTION_EVIDENCE_REQUIRED");
    }
    const conflict = this.repository.findCanonicalCoPresentSession(
      input.characterId,
      input.scope,
      input.sessionId,
    );
    if (conflict) {
      throw new InteractionValidationError(
        `this character is already co-present in session ${conflict.sessionId}`,
        "INTERACTION_CONFLICT",
      );
    }
    const now = this.clock.now().toISOString();
    const worldRuntimeBeforeMeeting = state.conversationSpace === "normal" && location.placeId
      ? this.captureWorldRuntime(input.characterId)
      : undefined;
    const after: InteractionState = {
      ...state,
      presence: "co_present",
      lens: "observable_scene",
      ...(location.placeId ? { placeId: location.placeId } : { placeId: undefined }),
      location: location.location,
      meetingNote: undefined,
      revision: state.revision + 1,
      updatedAt: now,
    };
    let result: InteractionTransitionResult;
    try {
      result = this.applyTransition({
        before: state,
        after,
        type: "begin_meeting",
        source: input.source,
        evidenceKind: input.source === "user_control" ? "ui_confirmation" : "user_message",
        summary: `已在${location.location}见面`,
        idempotencyKey: input.idempotencyKey,
        worldRuntimeBeforeMeeting,
      });
    } catch (error) {
      throwCanonicalMeetingConflict(error);
    }
    this.enterMeetingScene(result.state);
    return result;
  }

  scheduleEndMeeting(input: {
    sessionId: string;
    characterId: string;
    mode: Mode;
    scope: InteractionScope;
    source: "agent_tool";
    initiator: "user" | "character" | "mutual";
    summary?: string;
    idempotencyKey: string;
  }): InteractionTransitionResult {
    const replay = this.repository.findEventByIdempotencyKey(input.idempotencyKey, input.scope);
    if (replay) {
      return {
        state: this.ensure(input.sessionId, input.characterId, input.mode, input.scope),
        event: replay,
      };
    }
    const state = this.ensureCanonical(input.sessionId, input.characterId, input.mode, input.scope);
    this.assertNoPendingTransition(state);
    if (state.presence !== "co_present") {
      throw new InteractionValidationError("ending a meeting requires confirmed co-presence", "INTERACTION_TRANSITION_INVALID");
    }
    const now = this.clock.now().toISOString();
    const after = remoteState(state, now);
    const event = this.createEvent({
      before: state,
      after,
      type: "end_meeting",
      source: input.source,
      evidenceKind: input.initiator === "character" ? "character_action" : "user_message",
      status: "pending",
      summary: optionalBounded(input.summary, 500, "meeting summary") ??
        (state.location ? `结束在${state.location}的见面` : "结束见面"),
      idempotencyKey: input.idempotencyKey,
      now,
    });
    const pendingState = { ...state, pendingEventId: event.id, updatedAt: now };
    this.repository.transaction(() => {
      this.repository.createEvent(event);
      this.repository.upsertState(pendingState);
    });
    return { state: pendingState, event };
  }

  endMeetingNow(input: {
    sessionId: string;
    characterId: string;
    mode: Mode;
    scope: InteractionScope;
    source: "user_control" | "system";
    userConfirmed?: boolean;
    summary?: string;
    idempotencyKey?: string;
  }): InteractionTransitionResult {
    const state = this.ensureCanonical(input.sessionId, input.characterId, input.mode, input.scope);
    this.assertNoPendingTransition(state);
    if (state.presence !== "co_present") {
      throw new InteractionValidationError("there is no active meeting to end", "INTERACTION_TRANSITION_INVALID");
    }
    if (input.source === "user_control" && input.userConfirmed !== true) {
      throw new InteractionValidationError("explicit UI confirmation is required", "INTERACTION_EVIDENCE_REQUIRED");
    }
    const now = this.clock.now().toISOString();
    const worldRuntimeBeforeMeeting = this.meetingWorldRuntimeBefore(input.sessionId, input.scope);
    const result = this.applyTransition({
      before: state,
      after: remoteState(state, now),
      type: "end_meeting",
      source: input.source,
      evidenceKind: input.source === "user_control" ? "ui_confirmation" : "system",
      summary: optionalBounded(input.summary, 500, "meeting summary") ??
        (state.location ? `结束在${state.location}的见面` : "结束见面"),
      idempotencyKey: input.idempotencyKey,
    });
    this.leaveMeetingScene(state, worldRuntimeBeforeMeeting);
    return result;
  }

  applyPostTurnDeparture(input: {
    sessionId: string;
    characterId: string;
    mode: Mode;
    scope: InteractionScope;
    sourceContextLogId: string;
    expectedRevision: number;
    userText: string;
    assistantText: string;
    decision: PostTurnInteractionDecision;
  }): InteractionTransitionResult | undefined {
    const idempotencyKey = `post-turn:end-meeting:${input.sourceContextLogId}`;
    const replay = this.repository.findEventByIdempotencyKey(idempotencyKey, input.scope);
    if (replay) {
      const state = this.repository.getState(input.sessionId, input.scope);
      return state ? { state, event: replay } : undefined;
    }
    if (!isTrustedPostTurnDeparture(input.decision, input.userText, input.assistantText)) return undefined;
    const state = this.repository.getState(input.sessionId, input.scope);
    if (
      input.mode !== "sms" ||
      !state ||
      state.sessionId !== input.sessionId ||
      state.characterId !== input.characterId ||
      state.continuity !== "canonical" ||
      state.presence !== "co_present" ||
      state.pendingEventId ||
      state.revision !== input.expectedRevision
    ) return undefined;
    const now = this.clock.now().toISOString();
    const worldRuntimeBeforeMeeting = this.meetingWorldRuntimeBefore(input.sessionId, input.scope);
    const result = this.applyTransition({
      before: state,
      after: remoteState(state, now),
      type: "end_meeting",
      source: "post_turn_coordinator",
      evidenceKind: "post_turn_analysis",
      summary: state.location
        ? `回合后分析确认已结束在${state.location}的见面`
        : "回合后分析确认见面已经结束",
      idempotencyKey,
    });
    this.leaveMeetingScene(state, worldRuntimeBeforeMeeting);
    return result;
  }

  cancelMeeting(input: {
    sessionId: string;
    characterId: string;
    mode: Mode;
    scope: InteractionScope;
    source: "user_control" | "system";
  }): InteractionTransitionResult {
    const state = this.ensureCanonical(input.sessionId, input.characterId, input.mode, input.scope);
    this.assertNoPendingTransition(state);
    if (state.presence !== "meeting_pending") {
      throw new InteractionValidationError("there is no pending meeting to cancel", "INTERACTION_TRANSITION_INVALID");
    }
    const now = this.clock.now().toISOString();
    return this.applyTransition({
      before: state,
      after: remoteState(state, now),
      type: "cancel_meeting",
      source: input.source,
      evidenceKind: input.source === "user_control" ? "ui_confirmation" : "system",
      summary: "见面安排已取消",
    });
  }

  finishPendingAfterTurn(
    sessionId: string,
    scope: InteractionScope,
    completed: boolean,
  ): InteractionTransitionResult | undefined {
    const state = this.repository.getState(sessionId, scope);
    if (!state?.pendingEventId) return undefined;
    const event = this.repository.getEvent(state.pendingEventId, scope);
    if (!event || event.status !== "pending") {
      this.repository.upsertState({ ...state, pendingEventId: undefined, updatedAt: this.clock.now().toISOString() });
      return undefined;
    }
    const now = this.clock.now().toISOString();
    const worldRuntimeBeforeMeeting = this.meetingWorldRuntimeBefore(sessionId, scope);
    if (!completed) {
      this.repository.transaction(() => {
        this.repository.updateEventStatus(event.id, scope, "cancelled");
        this.repository.upsertState({ ...state, pendingEventId: undefined, updatedAt: now });
      });
      return undefined;
    }
    const after: InteractionState = {
      ...state,
      ...event.afterState,
      pendingEventId: undefined,
      revision: state.revision + 1,
      updatedAt: now,
    };
    this.repository.transaction(() => {
      this.repository.upsertState(after);
      this.repository.updateEventStatus(event.id, scope, "applied", { appliedAt: now });
    });
    this.leaveMeetingScene(state, worldRuntimeBeforeMeeting);
    return { state: after, event: { ...event, status: "applied", appliedAt: now } };
  }

  recoverPendingAfterInterruptedTurn(sessionId: string, scope: InteractionScope): void {
    const state = this.repository.getState(sessionId, scope);
    if (!state?.pendingEventId) return;
    const event = this.repository.getEvent(state.pendingEventId, scope);
    const now = this.clock.now().toISOString();
    this.repository.transaction(() => {
      if (event?.status === "pending") {
        this.repository.updateEventStatus(event.id, scope, "cancelled");
      }
      this.repository.upsertState({ ...state, pendingEventId: undefined, updatedAt: now });
    });
  }

  undoLatest(
    sessionId: string,
    characterId: string,
    mode: Mode,
    scope: InteractionScope,
  ): InteractionTransitionResult {
    const state = this.ensureCanonical(sessionId, characterId, mode, scope);
    this.assertNoPendingTransition(state);
    const previous = this.repository.latestAppliedReversibleEvent(sessionId, scope);
    if (!previous || !sameSnapshot(snapshot(state), previous.afterState)) {
      throw new InteractionValidationError("the latest interaction transition can no longer be undone", "INTERACTION_UNDO_UNAVAILABLE");
    }
    if (previous.beforeState.presence === "co_present") {
      const conflict = this.repository.findCanonicalCoPresentSession(characterId, scope, sessionId);
      if (conflict) throw new InteractionValidationError("another session is already co-present", "INTERACTION_CONFLICT");
    }
    const now = this.clock.now().toISOString();
    const {
      worldRuntimeBeforeMeeting,
      ...previousInteractionState
    } = previous.beforeState;
    const restored: InteractionState = {
      ...state,
      ...previousInteractionState,
      pendingEventId: undefined,
      revision: state.revision + 1,
      updatedAt: now,
    };
    const undo = this.createEvent({
      before: state,
      after: restored,
      type: "undo_transition",
      source: "user_control",
      evidenceKind: "ui_confirmation",
      status: "applied",
      summary: `已撤销：${previous.summary}`,
      now,
    });
    try {
      this.repository.transaction(() => {
        this.repository.updateEventStatus(previous.id, scope, "reverted", { revertedAt: now });
        this.repository.upsertState(restored);
        this.repository.createEvent(undo);
      });
    } catch (error) {
      throwCanonicalMeetingConflict(error);
    }
    if (restored.presence === "co_present") this.enterMeetingScene(restored);
    else this.leaveMeetingScene(state, worldRuntimeBeforeMeeting);
    return { state: restored, event: undo };
  }

  private ensureCanonical(
    sessionId: string,
    characterId: string,
    mode: Mode,
    scope: InteractionScope,
  ): InteractionState {
    const state = this.ensure(sessionId, characterId, mode, scope);
    if (mode !== "sms" || state.continuity !== "canonical") {
      throw new InteractionValidationError(
        "meeting transitions are available only in canonical private conversations",
        "INTERACTION_MODE_INVALID",
      );
    }
    return state;
  }

  private assertNoPendingTransition(state: InteractionState): void {
    if (state.pendingEventId) {
      throw new InteractionValidationError("another interaction transition is still pending", "INTERACTION_CONFLICT");
    }
  }

  private resolveLocation(state: InteractionState, input: LocationInput): { placeId?: string; location?: string } {
    if (state.conversationSpace === "secret") {
      if (input.placeId) {
        throw new InteractionValidationError(
          "private interaction locations cannot reference normal-space world places",
          "INTERACTION_LOCATION_INVALID",
        );
      }
      const location = optionalBounded(input.location, 120, "meeting location") ?? state.location;
      return location ? { location } : {};
    }
    const life = this.worldService.getCharacterLife(state.characterId);
    let placeId = optionalBounded(input.placeId, 160, "place id");
    let location = optionalBounded(input.location, 120, "meeting location");
    if (placeId) {
      const place = life.places.find((entry) => entry.id === placeId);
      if (!place || place.worldId !== life.membership?.worldId) {
        throw new InteractionValidationError("meeting place is not in the character's current world", "INTERACTION_LOCATION_INVALID");
      }
      location = place.name;
    } else if (location) {
      const place = life.places.find((entry) => entry.name === location);
      if (place) placeId = place.id;
    } else if (state.location) {
      location = state.location;
      placeId = state.placeId;
    } else {
      const place = life.places.find((entry) => entry.id === life.runtime?.placeId);
      if (place) {
        placeId = place.id;
        location = place.name;
      }
    }
    return {
      ...(placeId ? { placeId } : {}),
      ...(location ? { location } : {}),
    };
  }

  private applyTransition(input: {
    before: InteractionState;
    after: InteractionState;
    type: InteractionEvent["type"];
    source: InteractionEventSource;
    evidenceKind: InteractionEvidenceKind;
    summary: string;
    idempotencyKey?: string;
    worldRuntimeBeforeMeeting?: InteractionWorldRuntimeSnapshot;
  }): InteractionTransitionResult {
    const now = input.after.updatedAt;
    const event = this.createEvent({
      ...input,
      status: "applied",
      now,
    });
    this.repository.transaction(() => {
      this.repository.upsertState(input.after);
      this.repository.createEvent(event);
    });
    return { state: input.after, event };
  }

  private createEvent(input: {
    before: InteractionState;
    after: InteractionState;
    type: InteractionEvent["type"];
    source: InteractionEventSource;
    evidenceKind: InteractionEvidenceKind;
    status: InteractionEvent["status"];
    summary: string;
    now: string;
    idempotencyKey?: string;
    worldRuntimeBeforeMeeting?: InteractionWorldRuntimeSnapshot;
  }): InteractionEvent {
    return {
      id: this.idGenerator.next("interaction-event"),
      sessionId: input.before.sessionId,
      characterId: input.before.characterId,
      ...interactionScopeOf(input.before),
      type: input.type,
      source: input.source,
      status: input.status,
      evidenceKind: input.evidenceKind,
      fromPresence: input.before.presence,
      toPresence: input.after.presence,
      ...(input.after.placeId ? { placeId: input.after.placeId } : input.before.placeId ? { placeId: input.before.placeId } : {}),
      ...(input.after.location ? { location: input.after.location } : input.before.location ? { location: input.before.location } : {}),
      summary: input.summary,
      beforeState: {
        ...snapshot(input.before),
        ...(input.worldRuntimeBeforeMeeting ? { worldRuntimeBeforeMeeting: input.worldRuntimeBeforeMeeting } : {}),
      },
      afterState: snapshot(input.after),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      createdAt: input.now,
      ...(input.status === "applied" ? { appliedAt: input.now } : {}),
    };
  }

  private enterMeetingScene(state: InteractionState): void {
    if (state.conversationSpace === "secret") return;
    this.project("scene_enter", state, () => {
      const character = this.rpService.getCharacter(state.characterId);
      this.rpService.updateScene(state.sessionId, {
        location: state.location,
        participants: ["用户", character.name],
        summary: state.location ? `用户与${character.name}已在${state.location}见面。` : `用户与${character.name}已经见面。`,
      }, state.characterId);
    });
    if (state.placeId) {
      this.project("world_enter", state, () => {
        this.worldService.setCharacterRuntime(state.characterId, {
          placeId: state.placeId,
          activity: "与用户见面",
          availability: "busy",
          expectedUntil: null,
        });
      });
    }
  }

  private leaveMeetingScene(
    state: InteractionState,
    previousRuntime?: InteractionWorldRuntimeSnapshot,
  ): void {
    if (state.conversationSpace === "secret") return;
    if (!previousRuntime) return;
    this.project("world_leave", state, () => {
      const life = this.worldService.getCharacterLife(state.characterId);
      if (!life.runtime) return;
      this.worldService.setCharacterRuntime(state.characterId, {
        ...(previousRuntime.placeId ? { placeId: previousRuntime.placeId } : {}),
        activity: previousRuntime.activity,
        availability: previousRuntime.availability,
        expectedUntil: previousRuntime.expectedUntil ?? null,
      });
    });
  }

  private captureWorldRuntime(characterId: string): InteractionWorldRuntimeSnapshot | undefined {
    const runtime = this.worldService.getCharacterLife(characterId).runtime;
    if (!runtime) return undefined;
    return {
      ...(runtime.placeId ? { placeId: runtime.placeId } : {}),
      activity: runtime.activity,
      availability: runtime.availability,
      ...(runtime.expectedUntil ? { expectedUntil: runtime.expectedUntil } : {}),
    };
  }

  private meetingWorldRuntimeBefore(
    sessionId: string,
    scope: InteractionScope,
  ): InteractionWorldRuntimeSnapshot | undefined {
    if (scope.conversationSpace === "secret") return undefined;
    return this.repository.latestAppliedBeginEvent(sessionId, scope)
      ?.beforeState.worldRuntimeBeforeMeeting;
  }

  private project(operation: string, state: InteractionState, projection: () => void): void {
    try {
      projection();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
      try {
        this.reportProjectionWarning({
          operation,
          sessionId: state.sessionId,
          characterId: state.characterId,
          errorName: error instanceof Error ? error.name : "UnknownError",
          ...(code ? { errorCode: code } : {}),
        });
      } catch {
        // The canonical interaction transition is already durable; diagnostics must not reverse it.
      }
    }
  }
}

function defaultState(
  sessionId: string,
  characterId: string,
  mode: Mode,
  scope: InteractionScope,
  now: string,
): InteractionState {
  assertScopeForCharacter(scope, characterId);
  return mode === "rp"
    ? {
        ...scope,
        sessionId,
        characterId,
        continuity: "sandbox",
        presence: "co_present",
        lens: "close_third",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
    : {
        ...scope,
        sessionId,
        characterId,
        continuity: "canonical",
        presence: "remote",
        lens: "message",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
}

function remoteState(state: InteractionState, now: string): InteractionState {
  return {
    ...state,
    presence: "remote",
    lens: "message",
    placeId: undefined,
    location: undefined,
    meetingNote: undefined,
    pendingEventId: undefined,
    revision: state.revision + 1,
    updatedAt: now,
  };
}

function snapshot(state: InteractionState): InteractionStateSnapshot {
  return {
    continuity: state.continuity,
    presence: state.presence,
    lens: state.lens,
    ...(state.placeId ? { placeId: state.placeId } : {}),
    ...(state.location ? { location: state.location } : {}),
    ...(state.meetingNote ? { meetingNote: state.meetingNote } : {}),
  };
}

function sameSnapshot(left: InteractionStateSnapshot, right: InteractionStateSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isTrustedPostTurnDeparture(
  decision: PostTurnInteractionDecision,
  userText: string,
  assistantText: string,
): boolean {
  if (decision.decision !== "end" || decision.confidence < 0.9 || !decision.initiator) return false;
  if (
    decision.reasonCode !== "explicit_departure" &&
    decision.reasonCode !== "mutual_farewell" &&
    decision.reasonCode !== "character_departure"
  ) return false;
  if (decision.reasonCode === "mutual_farewell" && decision.initiator !== "mutual") return false;
  if (decision.reasonCode === "character_departure" && decision.initiator !== "character") return false;
  if (decision.reasonCode === "explicit_departure" && decision.initiator === "character") return false;
  const userEvidence = verifiedExactExcerpt(userText, decision.evidence?.user);
  const assistantEvidence = verifiedExactExcerpt(assistantText, decision.evidence?.assistant);
  if (decision.initiator === "user") return userEvidence;
  if (decision.initiator === "character") return assistantEvidence;
  return userEvidence && assistantEvidence;
}

function verifiedExactExcerpt(source: string, excerpt: string | undefined): boolean {
  if (!excerpt) return false;
  const normalizedExcerpt = normalizeEvidence(excerpt);
  return [...normalizedExcerpt].length >= 2 && normalizeEvidence(source).includes(normalizedExcerpt);
}

function normalizeEvidence(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function optionalBounded(value: string | undefined, maximum: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return undefined;
  if ([...normalized].length > maximum) {
    throw new InteractionValidationError(`${label} must not exceed ${maximum} characters`, "INTERACTION_LOCATION_INVALID");
  }
  return normalized;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function throwCanonicalMeetingConflict(error: unknown): never {
  if (
    error instanceof Error &&
    /UNIQUE constraint failed:\s*conversation_interaction_states\.conversation_space,\s*conversation_interaction_states\.character_id/iu
      .test(error.message)
  ) {
    throw new InteractionValidationError(
      "this character is already co-present in another session",
      "INTERACTION_CONFLICT",
    );
  }
  throw error;
}

function assertScopeForCharacter(scope: InteractionScope, characterId: string): void {
  if (scope.conversationSpace === "normal") {
    if ("secretOwnerCharacterId" in scope && scope.secretOwnerCharacterId !== undefined) {
      throw new InteractionValidationError(
        "normal interaction scope cannot have a secret owner",
        "INTERACTION_CONFLICT",
      );
    }
    return;
  }
  const owner = scope.secretOwnerCharacterId?.trim();
  if (!owner || owner !== characterId) {
    throw new InteractionValidationError(
      "private interaction scope does not belong to this character",
      "INTERACTION_CONFLICT",
    );
  }
}

function interactionScopeOf(state: InteractionState): InteractionScope {
  return state.conversationSpace === "secret"
    ? {
        conversationSpace: "secret",
        secretOwnerCharacterId: state.secretOwnerCharacterId,
      }
    : { conversationSpace: "normal" };
}
