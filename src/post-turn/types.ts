import type { InteractionState } from "../interaction/types.js";
import type {
  RelationshipExtraction,
  RelationshipExtractionInput,
  RelationshipEvidence,
  RelationshipInitiator,
} from "../relationship/types.js";
import type {
  WorldAttributeAnalysisContext,
  WorldAttributeAnalysisDecision,
} from "../world/types.js";

export type PostTurnAnalysisKind = "relationship" | "interaction" | "world_attributes";

export type PostTurnInteractionReasonCode =
  | "explicit_departure"
  | "mutual_farewell"
  | "character_departure"
  | "temporary_absence"
  | "future_departure"
  | "ambiguous"
  | "none";

export type PostTurnInteractionDecision = {
  decision: "end" | "keep" | "uncertain" | "not_applicable";
  confidence: number;
  initiator?: RelationshipInitiator;
  reasonCode: PostTurnInteractionReasonCode;
  evidence?: RelationshipEvidence;
};

export type PostTurnInteractionContext = {
  sessionId: string;
  characterId: string;
  continuity: "canonical";
  presenceAtTurnStart: "co_present";
  currentPresence: "co_present";
  expectedRevision: number;
  location?: string;
};

export type PostTurnAnalysisInput = RelationshipExtractionInput & {
  requestedAnalyses: PostTurnAnalysisKind[];
  interaction?: PostTurnInteractionContext;
  worldAttributes?: WorldAttributeAnalysisContext;
  completedWorldActions?: Array<{
    actionType: "perform_place_action";
    eventId: string;
    summary: string;
    capabilityId: string;
    placeId?: string;
  }>;
};

export type PostTurnAnalysis = {
  relationship: RelationshipExtraction;
  interaction: PostTurnInteractionDecision;
  worldAttributes: WorldAttributeAnalysisDecision[];
};

export type PostTurnAnalyzer = (input: PostTurnAnalysisInput) => Promise<unknown>;

export type PostTurnEnqueueContext = {
  characterId?: string;
  interactionStateAtTurnStart?: InteractionState;
};
