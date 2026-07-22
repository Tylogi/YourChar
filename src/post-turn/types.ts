import type { InteractionState } from "../interaction/types.js";
import type {
  RelationshipExtraction,
  RelationshipExtractionInput,
  RelationshipEvidence,
  RelationshipInitiator,
} from "../relationship/types.js";

export type PostTurnAnalysisKind = "relationship" | "interaction";

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
};

export type PostTurnAnalysis = {
  relationship: RelationshipExtraction;
  interaction: PostTurnInteractionDecision;
};

export type PostTurnAnalyzer = (input: PostTurnAnalysisInput) => Promise<unknown>;

export type PostTurnEnqueueContext = {
  characterId?: string;
  interactionStateAtTurnStart?: InteractionState;
};
