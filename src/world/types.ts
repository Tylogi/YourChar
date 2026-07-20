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
export type CharacterAvailability = "free" | "busy" | "resting" | "traveling";
export type WorldEventType = "activity" | "interaction" | "travel" | "world_change";
export type WorldEventSource = "autonomy" | "agent_tool" | "manual" | "system";
export type ActivityPlanStatus = "planned" | "settled" | "cancelled";
export type ProactiveMessageStatus = "pending" | "delivered" | "skipped" | "failed";

export type RoleWorld = {
  id: string;
  name: string;
  timezone: string;
  description: string;
  rulesMarkdown: string;
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

export type CharacterAutonomyPolicy = {
  characterId: string;
  enabled: boolean;
  proactiveEnabled: boolean;
  dailyMessageLimit: number;
  quietStart: string;
  quietEnd: string;
  lastPlannedDate?: string;
  lastProactiveAt?: string;
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
  sessionId?: string;
  text?: string;
  status: ProactiveMessageStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  readAt?: string;
};

export type CharacterLifeSnapshot = {
  membership?: CharacterWorldMembership;
  world?: RoleWorld;
  places: WorldPlace[];
  runtime?: CharacterRuntimeState;
  policy: CharacterAutonomyPolicy;
  plans: CharacterActivityPlan[];
  events: WorldEvent[];
  proactiveMessages: ProactiveMessage[];
};

export type CreateWorldInput = {
  name: string;
  timezone?: string;
  description?: string;
  rulesMarkdown?: string;
};

export type UpdateWorldInput = Partial<
  Pick<RoleWorld, "name" | "timezone" | "description" | "rulesMarkdown" | "status">
>;

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
    "enabled" | "proactiveEnabled" | "dailyMessageLimit" | "quietStart" | "quietEnd"
  >
>;

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
  title: string;
  placeId: string;
  capabilityId: WorldCapabilityId;
  startAt: string;
  endAt: string;
  summary: string;
  salience: number;
};

export type WorldPlannerInput = {
  characterId: string;
  characterName: string;
  soulMarkdown: string;
  world: RoleWorld;
  places: WorldPlace[];
  currentState: CharacterRuntimeState;
  existingSchedule: Array<{ title: string; startAt?: string; endAt?: string }>;
  now: string;
  localDate: string;
};

export type WorldPlanner = (input: WorldPlannerInput) => Promise<unknown>;

export type ProactiveMessageInput = {
  characterId: string;
  characterName: string;
  sessionId: string;
  event: WorldEvent;
  world: RoleWorld;
  place?: WorldPlace;
  recentConversation: Array<{ role: "user" | "assistant"; text: string }>;
};

export type ProactiveMessageDelivery = {
  sessionId: string;
  text: string;
};

export type ProactiveMessenger = (
  input: ProactiveMessageInput,
) => Promise<ProactiveMessageDelivery | undefined>;

export type WorldAutonomyTickResult = {
  characters: number;
  planned: number;
  settled: number;
  delivered: number;
  failed: number;
};
