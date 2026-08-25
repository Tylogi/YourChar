import type { Mode } from "../domain/types.js";

export type InteractionScope =
  | {
      conversationSpace: "normal";
      secretOwnerCharacterId?: never;
    }
  | {
      conversationSpace: "secret";
      secretOwnerCharacterId: string;
    };

export type InteractionContinuity = "canonical" | "sandbox";
export type InteractionPresence = "remote" | "meeting_pending" | "co_present";
export type NarrativeLens = "message" | "observable_scene" | "close_third";
export type InteractionEventType =
  | "propose_meeting"
  | "begin_meeting"
  | "end_meeting"
  | "cancel_meeting"
  | "undo_transition";
export type InteractionEventSource = "agent_tool" | "user_control" | "system" | "post_turn_coordinator";
export type InteractionEventStatus = "pending" | "applied" | "reverted" | "cancelled";
export type InteractionEvidenceKind =
  | "user_message"
  | "ui_confirmation"
  | "character_action"
  | "system"
  | "post_turn_analysis";

export type InteractionWorldRuntimeSnapshot = {
  placeId?: string;
  activity: string;
  availability: "free" | "busy" | "resting" | "traveling";
  expectedUntil?: string;
};

export type InteractionState = InteractionScope & {
  sessionId: string;
  characterId: string;
  continuity: InteractionContinuity;
  presence: InteractionPresence;
  lens: NarrativeLens;
  placeId?: string;
  location?: string;
  meetingNote?: string;
  pendingEventId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type InteractionStateSnapshot = Pick<
  InteractionState,
  "continuity" | "presence" | "lens" | "placeId" | "location" | "meetingNote"
> & { worldRuntimeBeforeMeeting?: InteractionWorldRuntimeSnapshot };

export type InteractionEvent = InteractionScope & {
  id: string;
  sessionId: string;
  characterId: string;
  type: InteractionEventType;
  source: InteractionEventSource;
  status: InteractionEventStatus;
  evidenceKind: InteractionEvidenceKind;
  fromPresence: InteractionPresence;
  toPresence: InteractionPresence;
  placeId?: string;
  location?: string;
  summary: string;
  beforeState: InteractionStateSnapshot;
  afterState: InteractionStateSnapshot;
  idempotencyKey?: string;
  createdAt: string;
  appliedAt?: string;
  revertedAt?: string;
};

export type InteractionTransitionResult = {
  state: InteractionState;
  event: InteractionEvent;
};

export type InteractionSessionDescriptor = {
  sessionId: string;
  characterId: string;
  mode: Mode;
} & InteractionScope;
