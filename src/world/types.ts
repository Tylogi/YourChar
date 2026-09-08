import type {
  CharacterTaskSkill,
  CharacterTaskIdentity,
  CharacterTaskRoute,
} from "../organization/types.js";

export const worldCapabilities = {
  rest: { label: "休息", defaultActivity: "安静休息" },
  work: { label: "工作", defaultActivity: "处理手头的工作" },
  study: { label: "学习", defaultActivity: "阅读和整理资料" },
  socialize: { label: "社交", defaultActivity: "和熟人聊一会儿" },
  eat: { label: "用餐", defaultActivity: "吃点东西" },
  shop: { label: "购物", defaultActivity: "挑选需要的东西" },
  exercise: { label: "运动", defaultActivity: "活动身体" },
  travel: { label: "出行", defaultActivity: "在路上" },
  create: { label: "创作", defaultActivity: "专心做些创作" },
  observe: { label: "观察", defaultActivity: "留意周围发生的事" },
  communicate: { label: "通信", defaultActivity: "查看和回复消息" },
} as const;

export type WorldCapabilityId = keyof typeof worldCapabilities;
export type WorldStatus = "active" | "archived";
export type WorldConversationTurnStatus = "running" | "completed" | "partial" | "failed" | "cancelled";
export type WorldStoryEventStatus = "planned" | "active" | "resolved" | "cancelled";
export type WorldStoryTransitionType = "propose" | "begin" | "advance" | "resolve" | "cancel" | "undo";
export type WorldObservationKnowledge = "direct" | "heard" | "inferred";
export type CharacterAvailability = "free" | "busy" | "resting" | "traveling";
export type WorldEventType = "activity" | "interaction" | "travel" | "world_change";
export type WorldEventSource = "autonomy" | "agent_tool" | "manual" | "system";
export type ActivityPlanStatus = "planned" | "settled" | "cancelled";
export type ProactiveMessageStatus = "pending" | "delivered" | "skipped" | "failed";
export type ProactiveFeedbackType = "helpful" | "less_often" | "mute_topic" | "pause_24h";
export type ProactiveTopicMode = "normal" | "reduced" | "muted";
export type ProactiveDecisionCode =
  | "queued"
  | "candidate_ready"
  | "ranked_behind"
  | "quiet_hours"
  | "daily_limit"
  | "global_cooldown"
  | "topic_cooldown"
  | "recent_user_activity"
  | "conversation_busy"
  | "co_present"
  | "paused"
  | "retry_cooldown"
  | "low_score"
  | "topic_muted"
  | "stale"
  | "event_missing"
  | "policy_disabled"
  | "world_changed"
  | "character_declined"
  | "model_failed"
  | "delivered";

export type RoleWorld = {
  id: string;
  name: string;
  timezone: string;
  description: string;
  rulesMarkdown: string;
  directorModelProfileId?: string;
  analystModelProfileId?: string;
  status: WorldStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type WorldPlace = {
  id: string;
  worldId: string;
  name: string;
  description: string;
  capabilityIds: WorldCapabilityId[];
  createdAt: string;
  updatedAt: string;
};

export type CharacterWorldMembership = {
  characterId: string;
  worldId: string;
  homePlaceId?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorldAttributeDefinitionStatus = "active" | "archived";
export type WorldAttributeScope = "world" | "character";
export type WorldAttributeEventSource =
  | "user_control"
  | "post_turn_analysis"
  | "world_turn_analysis"
  | "agent_tool"
  | "system";

export type WorldAttributeAnalysisDirection = "increase" | "decrease";

export type WorldAttributeDefinition = {
  id: string;
  worldId: string;
  key: string;
  name: string;
  scope: WorldAttributeScope;
  description: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  analysisEnabled: boolean;
  increaseRule: string;
  increaseDelta: number;
  decreaseRule: string;
  decreaseDelta: number;
  visibleToAgent: boolean;
  status: WorldAttributeDefinitionStatus;
  createdAt: string;
  updatedAt: string;
};

export type CharacterWorldAttribute = WorldAttributeDefinition & {
  scope: "character";
  characterId: string;
  value: number;
  valueUpdatedAt?: string;
};

export type WorldSharedAttribute = WorldAttributeDefinition & {
  scope: "world";
  value: number;
  valueUpdatedAt?: string;
};

export type WorldAttributeEvent = {
  id: string;
  worldId: string;
  attributeScope: WorldAttributeScope;
  characterId?: string;
  attributeId: string;
  attributeKey: string;
  source: WorldAttributeEventSource;
  requestedDelta: number;
  appliedDelta: number;
  beforeValue: number;
  afterValue: number;
  summary: string;
  idempotencyKey: string;
  analysisDirection?: WorldAttributeAnalysisDirection;
  ruleSnapshot?: string;
  evidence?: string;
  confidence?: number;
  sourceReferenceId?: string;
  createdAt: string;
};

export type WorldAttributeAnalysisRule = {
  attributeId: string;
  key: string;
  name: string;
  scope: WorldAttributeScope;
  description: string;
  currentValue: number;
  definitionUpdatedAt: string;
  increaseRule?: string;
  increaseDelta: number;
  decreaseRule?: string;
  decreaseDelta: number;
};

export type WorldAttributeAnalysisContext = {
  worldId: string;
  characterId: string;
  attributes: WorldAttributeAnalysisRule[];
};

export type WorldAttributeAnalysisDecision = {
  characterId: string;
  key: string;
  direction: WorldAttributeAnalysisDirection;
  summary: string;
  evidence: string;
  confidence: number;
};

export type CharacterAutonomyPolicy = {
  characterId: string;
  enabled: boolean;
  proactiveEnabled: boolean;
  socialEnabled: boolean;
  dailyMessageLimit: number;
  socialDailyLimit: number;
  proactiveCooldownMinutes: number;
  socialCooldownMinutes: number;
  quietStart: string;
  quietEnd: string;
  proactivePausedUntil?: string;
  lastPlannedDate?: string;
  lastProactiveAt?: string;
  lastSocialAt?: string;
  updatedAt: string;
};

export type CharacterRuntimeState = {
  characterId: string;
  worldId: string;
  placeId?: string;
  activity: string;
  availability: CharacterAvailability;
  energy: number;
  stateSince: string;
  expectedUntil?: string;
  worldRevision: number;
  updatedAt: string;
};

export type CharacterActivityPlan = {
  id: string;
  scheduleItemId: string;
  worldId: string;
  characterId: string;
  placeId?: string;
  capabilityId: WorldCapabilityId;
  summary: string;
  salience: number;
  status: ActivityPlanStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
};

export type WorldEvent = {
  id: string;
  worldId: string;
  placeId?: string;
  type: WorldEventType;
  summary: string;
  salience: number;
  source: WorldEventSource;
  startsAt: string;
  endsAt?: string;
  idempotencyKey: string;
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProactiveMessage = {
  id: string;
  characterId: string;
  worldEventId: string;
  topicKey: string;
  topicLabel: string;
  candidateScore: number;
  decisionCode: ProactiveDecisionCode;
  decisionDetails: Record<string, unknown>;
  sessionId?: string;
  text?: string;
  status: ProactiveMessageStatus;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  readAt?: string;
  feedbackType?: ProactiveFeedbackType;
  feedbackAt?: string;
};

export type ProactiveTopicPolicy = {
  characterId: string;
  topicKey: string;
  topicLabel: string;
  mode: ProactiveTopicMode;
  helpfulCount: number;
  lessOftenCount: number;
  lastFeedbackAt?: string;
  updatedAt: string;
};

export type CharacterLifeSnapshot = {
  membership?: CharacterWorldMembership;
  world?: RoleWorld;
  places: WorldPlace[];
  runtime?: CharacterRuntimeState;
  policy: CharacterAutonomyPolicy;
  plans: CharacterActivityPlan[];
  events: WorldEvent[];
  attributes: CharacterWorldAttribute[];
  worldAttributes: WorldSharedAttribute[];
  attributeEvents: WorldAttributeEvent[];
  proactiveMessages: ProactiveMessage[];
  proactiveTopicPolicies: ProactiveTopicPolicy[];
};

export type CreateWorldAttributeDefinitionInput = {
  worldId: string;
  key: string;
  name: string;
  scope?: WorldAttributeScope;
  description?: string;
  minValue: number;
  maxValue: number;
  defaultValue: number;
  analysisEnabled?: boolean;
  increaseRule?: string;
  increaseDelta?: number;
  decreaseRule?: string;
  decreaseDelta?: number;
  visibleToAgent?: boolean;
};

export type UpdateWorldAttributeDefinitionInput = Partial<
  Pick<
    WorldAttributeDefinition,
    "name" | "description" | "minValue" | "maxValue" | "defaultValue" |
      "analysisEnabled" | "increaseRule" | "increaseDelta" | "decreaseRule" | "decreaseDelta" |
      "visibleToAgent"
  >
>;

export type CreateWorldInput = {
  name: string;
  timezone?: string;
  description?: string;
  rulesMarkdown?: string;
  directorModelProfileId?: string;
  analystModelProfileId?: string;
};

export type UpdateWorldInput = Partial<
  Pick<RoleWorld, "name" | "timezone" | "description" | "rulesMarkdown" | "status">
> & {
  directorModelProfileId?: string | null;
  analystModelProfileId?: string | null;
};

export type WorldConversation = {
  worldId: string;
  unreadCount: number;
  lastUnreadAt?: string;
  lastReadAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorldMeetingScene = {
  worldId: string;
  eventId: string;
  sessionId: string;
  characterId: string;
  participantIds: string[];
  location: string;
  placeId?: string;
  title: string;
  startedAt: string;
};

export type WorldConversationTurn = {
  id: string;
  worldId: string;
  status: WorldConversationTurnStatus;
  modelCalls: number;
  actorCount: number;
  startedAt: string;
  completedAt?: string;
};

export type WorldConversationAttachment = {
  path: string;
  name?: string;
  contentType?: string;
  size?: number;
};

export type WorldConversationMessage = {
  id: string;
  worldId: string;
  turnId: string;
  sequence: number;
  senderType: "user" | "director" | "character" | "system";
  senderId?: string;
  content: string;
  attachments: WorldConversationAttachment[];
  createdAt: string;
};

export type WorldConversationReset = {
  conversation: WorldConversation;
  resetAt: string;
  removedOpenEventId?: string;
  modelSessionIds: string[];
  deleted: {
    messages: number;
    turns: number;
    narrativeContexts: number;
    narrativePromptMessages: number;
    openEventObservations: number;
    openEventTransitions: number;
    openEvents: number;
  };
};

export type WorldNarrativeContext = {
  id: string;
  worldId: string;
  eventId?: string;
  modelProfileId: string;
  modelKey: string;
  modelSessionId: string;
  systemPrompt: string;
  stablePrefixHash: string;
  participantIds: string[];
  startMessageSequence: number;
  status: "active" | "closed";
  closeReason?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type WorldNarrativePromptMessage = {
  id: string;
  contextId: string;
  turnId: string;
  sequence: number;
  role: "user" | "assistant";
  payload: Record<string, unknown>;
  createdAt: string;
};

export type WorldStoryEvent = {
  id: string;
  worldId: string;
  meetingSessionId?: string;
  placeId?: string;
  title: string;
  summary: string;
  objective: string;
  status: WorldStoryEventStatus;
  revision: number;
  participantIds: string[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
  settlementSummary?: string;
  settledAt?: string;
};

export type WorldStoryTransition = {
  id: string;
  worldId: string;
  eventId?: string;
  turnId?: string;
  eventType: WorldStoryTransitionType;
  source: "world_director" | "world_analyzer" | "user_control" | "system";
  status: "applied" | "reverted";
  summary: string;
  beforeState?: WorldStoryEvent;
  afterState?: WorldStoryEvent;
  createdAt: string;
  revertedAt?: string;
};

export type WorldCharacterObservation = {
  id: string;
  worldId: string;
  eventId?: string;
  turnId?: string;
  characterId: string;
  knowledge: WorldObservationKnowledge;
  summary: string;
  salience: number;
  createdAt: string;
};

export type WorldCharacterRelationship = {
  worldId: string;
  subjectCharacterId: string;
  objectCharacterId: string;
  affinity: number;
  trust: number;
  tension: number;
  intimacy: number;
  romanceStatus?: "none" | "interested" | "dating" | "committed" | "former_partners";
  summary: string;
  revision: number;
  updatedAt: string;
};

export type WorldAnalysis = {
  event: {
    action: "none" | "propose" | "begin" | "advance" | "resolve" | "cancel";
    title?: string;
    summary?: string;
    objective?: string;
    placeId?: string;
    participantIds: string[];
    confidence: number;
  };
  runtimeUpdates: Array<{
    characterId: string;
    placeId?: string;
    activity?: string;
    availability?: CharacterAvailability;
    energy?: number;
    confidence: number;
  }>;
  observations: Array<{
    characterId: string;
    knowledge: WorldObservationKnowledge;
    summary: string;
    salience: number;
  }>;
  relationships: Array<{
    subjectCharacterId: string;
    objectCharacterId: string;
    affinityDelta: number;
    trustDelta: number;
    tensionDelta: number;
    intimacyDelta: number;
    summary: string;
    confidence: number;
  }>;
  attributeChanges: WorldAttributeAnalysisDecision[];
};

export type WorldTurnEvent =
  | {
      type: "director_state";
      phase: "planning" | "writing" | "failed";
      reasonCode?: WorldModelFailureReasonCode;
    }
  | { type: "participant_state"; characterId: string; phase: "typing" | "silent" | "failed"; reasonCode?: string }
  | { type: "message"; message: WorldConversationMessage }
  | {
      type: "analysis_state";
      phase: "analyzing" | "applied" | "failed";
      reasonCode?: WorldModelFailureReasonCode;
    }
  | { type: "turn_done"; turn: WorldConversationTurn };

export type WorldModelFailureReasonCode =
  | "cancelled"
  | "timeout"
  | "model_unavailable"
  | "invalid_output"
  | "generation_failed";

export type WorldTurnResult = {
  turn: WorldConversationTurn;
  userMessage: WorldConversationMessage;
  messages: WorldConversationMessage[];
  activeEvent?: WorldStoryEvent;
  meetingSessionId?: string;
  meetingEnded?: boolean;
};

export type CreatePlaceInput = {
  worldId: string;
  name: string;
  description?: string;
  capabilityIds?: WorldCapabilityId[];
};

export type UpdatePlaceInput = Partial<
  Pick<WorldPlace, "name" | "description" | "capabilityIds">
>;

export type CharacterWorldAssignmentInput = {
  worldId?: string | null;
  homePlaceId?: string | null;
  currentPlaceId?: string | null;
};

export type CharacterAutonomyPolicyPatch = Partial<
  Pick<
    CharacterAutonomyPolicy,
    "enabled" | "proactiveEnabled" | "socialEnabled" | "dailyMessageLimit" |
      "socialDailyLimit" | "proactiveCooldownMinutes" | "socialCooldownMinutes" |
      "quietStart" | "quietEnd"
  >
> & { proactivePausedUntil?: string | null };

export type CharacterRuntimePatch = Partial<
  Pick<CharacterRuntimeState, "placeId" | "activity" | "availability" | "energy">
> & { expectedUntil?: string | null };

export type PerformWorldActionInput = {
  characterId: string;
  placeId?: string;
  capabilityId: WorldCapabilityId;
  activity?: string;
  summary?: string;
  salience?: number;
  source: WorldEventSource;
  idempotencyKey: string;
};

export type WorldActivityProposal = {
  goalId?: string;
  title: string;
  placeId: string;
  capabilityId: WorldCapabilityId;
  startAt: string;
  endAt: string;
  summary: string;
  salience: number;
};

export type WorldPlannerInput = {
  wishes?: Array<{ id: string; title: string; nextStep: string }>;
  signal?: AbortSignal;
  characterId: string;
  characterName: string;
  soulMarkdown: string;
  world: RoleWorld;
  places: WorldPlace[];
  currentState: CharacterRuntimeState;
  homePlaceId?: string;
  existingSchedule: Array<{ title: string; startAt?: string; endAt?: string }>;
  recentEvents: Array<{ summary: string; startsAt: string; placeId?: string; participantIds: string[] }>;
  activeStoryEvent?: {
    id: string;
    title: string;
    summary: string;
    objective: string;
    status: WorldStoryEventStatus;
    placeId?: string;
    participantIds: string[];
  };
  worldCharacters: Array<{
    characterId: string;
    name: string;
    placeId?: string;
    activity: string;
    availability: CharacterAvailability;
  }>;
  now: string;
  localDate: string;
  localDateTime: string;
};

export type WorldPlanner = (input: WorldPlannerInput) => Promise<unknown>;

export type ProactiveMessageInput = {
  characterId: string;
  characterName: string;
  sessionId: string;
  event: WorldEvent;
  candidate: ProactiveMessage;
  world: RoleWorld;
  place?: WorldPlace;
  recentConversation: Array<{ role: "user" | "assistant"; text: string; sentAt?: string }>;
  currentTime: string;
  lastConversationAt?: string;
  lastConversationRole?: "user" | "assistant";
  elapsedSinceLastConversationSeconds?: number;
};

export type ProactiveMessageDelivery =
  | { sessionId: string; text: string; declined?: false }
  | { sessionId: string; declined: true; reason?: string };

export type ProactiveMessenger = (
  input: ProactiveMessageInput,
) => Promise<ProactiveMessageDelivery | undefined>;

export type WorldCharacterDirectoryEntry = {
  characterId: string;
  name: string;
  self: boolean;
  placeId?: string;
  placeName?: string;
  activity: string;
  availability: CharacterAvailability;
  contactable: boolean;
  peerReachable: boolean;
};

export type CharacterContactRequest = {
  sourceCharacterId: string;
  targetCharacterId: string;
  sourceSessionId: string;
  requestText: string;
  idempotencyKey: string;
};

export type CharacterContactRequestResult = {
  accepted: boolean;
  reason?: "target_proactive_disabled";
  event?: WorldEvent;
  proactiveMessage?: ProactiveMessage;
};

export type WorldAutonomyTickResult = {
  characters: number;
  planned: number;
  settled: number;
  delivered: number;
  socialEpisodes: number;
  failed: number;
};

export type CharacterChannelEpisodeKind = "social" | "collaboration" | "contact";
export type CharacterChannelEpisodeSource = "autonomy" | "agent_tool" | "manual" | "system";
export type CharacterChannelEpisodeStatus =
  | "queued"
  | "running"
  | "completed"
  | "declined"
  | "failed"
  | "cancelled";
export type CharacterChannelMessageKind = "message" | "task" | "result" | "status";
export type CharacterCollaborationJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
export type CharacterCollaborationReportStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "skipped"
  | "failed";
export type CharacterCollaborationStage =
  | "queued"
  | "executing"
  | "reporting"
  | "settled";

export type CharacterChannel = {
  id: string;
  worldId: string;
  firstCharacterId: string;
  secondCharacterId: string;
  unreadCount: number;
  lastUnreadAt?: string;
  lastReadAt?: string;
  lastMessageAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterChannelEpisode = {
  id: string;
  channelId: string;
  worldId: string;
  kind: CharacterChannelEpisodeKind;
  source: CharacterChannelEpisodeSource;
  initiatorCharacterId: string;
  targetCharacterId: string;
  parentSessionId?: string;
  title: string;
  objective: string;
  status: CharacterChannelEpisodeStatus;
  modelCalls: number;
  messageCount: number;
  idempotencyKey: string;
  resultText?: string;
  failureReason?: string;
  reportStatus?: CharacterCollaborationReportStatus;
  reportAttempts?: number;
  reportedAt?: string;
  reportError?: string;
  queuedAt?: string;
  startedAt?: string;
  settledAt?: string;
  targetExecutionMs?: number;
  reportQueuedAt?: string;
  reportStartedAt?: string;
  reportWaitMs?: number;
  reportGenerationMs?: number;
  reportDeliveryMs?: number;
  reportModelCalls?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CharacterChannelMessage = {
  id: string;
  channelId: string;
  episodeId: string;
  sequence: number;
  senderType: "character" | "system";
  senderCharacterId?: string;
  kind: CharacterChannelMessageKind;
  content: string;
  createdAt: string;
};

export type CharacterInteractionScene = {
  episodeId: string;
  channelId: string;
  worldId: string;
  narrativeText: string;
  eventSummary: string;
  createdAt: string;
  updatedAt: string;
};

export type CharacterInteractionReflection = {
  episodeId: string;
  channelId: string;
  worldId: string;
  characterId: string;
  peerCharacterId: string;
  summary: string;
  salience: number;
  createdAt: string;
};

export type CharacterChannelSummary = CharacterChannel & {
  characterIds: [string, string];
  characterNames: [string, string];
  preview: string;
  latestEpisodeStatus?: CharacterChannelEpisodeStatus;
};

export type CharacterChannelSnapshot = {
  channel: CharacterChannelSummary;
  episodes: CharacterChannelEpisode[];
  messages: CharacterChannelMessage[];
  scenes: CharacterInteractionScene[];
  reflections: CharacterInteractionReflection[];
};

export type CharacterCollaborationSummary = {
  episodeId: string;
  channelId: string;
  worldId: string;
  initiatorCharacterId: string;
  initiatorCharacterName: string;
  targetCharacterId: string;
  targetCharacterName: string;
  title: string;
  objective: string;
  status: CharacterChannelEpisodeStatus;
  stage: CharacterCollaborationStage;
  elapsedMs: number;
  messageCount: number;
  reportStatus?: CharacterCollaborationReportStatus;
  queuedAt: string;
  startedAt?: string;
  settledAt?: string;
  reportedAt?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CharacterInteractionPurpose =
  | "social_opening"
  | "social_reply"
  | "direct_reply"
  | "collaboration_result";

export type CharacterInteractionActorInput = {
  purpose: CharacterInteractionPurpose;
  channelId: string;
  episodeId: string;
  actorCharacterId: string;
  actorName: string;
  actorSoulMarkdown: string;
  peerCharacterId: string;
  peerName: string;
  world: RoleWorld;
  actorRuntime?: CharacterRuntimeState;
  peerRuntime?: CharacterRuntimeState;
  actorPlace?: WorldPlace;
  peerPlace?: WorldPlace;
  relationship?: WorldCharacterRelationship;
  recentMessages: CharacterChannelMessage[];
  recentReflections: CharacterInteractionReflection[];
  objective?: string;
  openingMessage?: string;
  taskIdentity?: CharacterTaskIdentity;
  taskSkill?: CharacterTaskSkill;
  currentTime: string;
  signal?: AbortSignal;
};

export type CharacterInteractionActor = (
  input: CharacterInteractionActorInput,
) => Promise<string>;

export type CharacterInteractionSceneParticipant = {
  characterId: string;
  name: string;
  soulMarkdown: string;
  runtime?: CharacterRuntimeState;
  place?: WorldPlace;
  relationshipToPeer?: WorldCharacterRelationship;
  recentReflections: CharacterInteractionReflection[];
};

export type CharacterInteractionSceneComposerInput = {
  episode: CharacterChannelEpisode;
  world: RoleWorld;
  source: CharacterInteractionSceneParticipant;
  target: CharacterInteractionSceneParticipant;
  messages: CharacterChannelMessage[];
  currentTime: string;
  signal?: AbortSignal;
};

export type CharacterInteractionSceneDraft = {
  narrativeText: string;
  eventSummary: string;
  sourcePerspectiveSummary: string;
  targetPerspectiveSummary: string;
};

export type CharacterInteractionSceneComposer = (
  input: CharacterInteractionSceneComposerInput,
) => Promise<CharacterInteractionSceneDraft>;

export type CharacterInteractionResult = {
  channel: CharacterChannel;
  episode: CharacterChannelEpisode;
  messages: CharacterChannelMessage[];
  scene?: CharacterInteractionScene;
  reflections: CharacterInteractionReflection[];
  responseText?: string;
  routing?: CharacterTaskRoute;
};

export type CharacterCollaborationJob = {
  episodeId: string;
  openingMessage: string;
  routing: CharacterTaskRoute;
  status: CharacterCollaborationJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError?: string;
  ownerId?: string;
  claimToken?: string;
  leaseExpiresAt?: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type CharacterCollaborationReportOutcome =
  (
    | { status: "delivered" }
    | { status: "skipped"; reason?: string }
    | { status: "failed"; error: string }
  ) & {
    metrics?: {
      reportQueueWaitMs: number;
      reportGenerationMs: number;
      reportDeliveryMs: number;
      reportModelCalls: number;
    };
  };

export type CharacterSocialTickResult = {
  created: number;
  failed: number;
};
