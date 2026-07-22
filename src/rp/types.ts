export type NarrativePerspective = "first_person" | "third_person";

export type CharacterProfile = {
  id: string;
  name: string;
  modelProfileId?: string;
  soulMarkdown: string;
  soulCharacterCount: number;
  soulMaxCharacters: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateCharacterInput = {
  name: string;
  modelProfileId?: string | null;
  soulMarkdown?: string;
  // Legacy fields remain accepted so existing API clients migrate without data loss.
  identity?: string;
  voice?: string;
  narrativePerspective?: NarrativePerspective;
  behavior?: string;
  relationshipDefaults?: string;
  boundaries?: string[];
};
export type UpdateCharacterInput = Partial<CreateCharacterInput>;

export type RoleSession = {
  appSessionId: string;
  characterId: string;
  worldId?: string;
  status: "active" | "archived";
  continuity: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type SceneState = {
  roleSessionId: string;
  location?: string;
  inWorldTime?: string;
  participants: string[];
  currentObjective?: string;
  openThreads: string[];
  summary: string;
  updatedAt: string;
};

export type UpdateSceneInput = Partial<
  Pick<SceneState, "location" | "inWorldTime" | "participants" | "currentObjective" | "openThreads" | "summary">
>;

export type RealityMemoryType =
  | "user_fact"
  | "preference"
  | "goal"
  | "person"
  | "project"
  | "boundary";

export type LegacyProfileMemoryType = "user_fact" | "preference";

export type RoleplayMemoryType =
  | "relationship_event"
  | "world_fact"
  | "plot_event"
  | "boundary";

export type MemoryType = RealityMemoryType | RoleplayMemoryType;

export type MemoryValidity = "pending" | "active" | "superseded" | "rejected" | "archived" | "deleted";

export const RP_MEMORY_REALM = "roleplay" as const;
export const RP_MEMORY_SCOPE = "character" as const;
export const LEGACY_MEMORY_REALM = "legacy" as const;
export const LEGACY_MEMORY_SCOPE = "quarantine" as const;
export const REALITY_MEMORY_REALM = "reality" as const;
export const REALITY_MEMORY_SCOPE = "global" as const;

export type RpMemoryRealm = typeof RP_MEMORY_REALM;
export type RpMemoryScope = typeof RP_MEMORY_SCOPE;
export type MemoryRealm = RpMemoryRealm | typeof REALITY_MEMORY_REALM | typeof LEGACY_MEMORY_REALM;
export type MemoryScope = RpMemoryScope | typeof REALITY_MEMORY_SCOPE | typeof LEGACY_MEMORY_SCOPE;
export type LegacyMemoryQuarantineReason = "missing_character" | "disallowed_profile_type";

export const ROLEPLAY_MEMORY_TYPES = [
  "relationship_event",
  "world_fact",
  "plot_event",
  "boundary",
] as const satisfies readonly RoleplayMemoryType[];

export const REALITY_MEMORY_TYPES = [
  "user_fact",
  "preference",
  "goal",
  "person",
  "project",
  "boundary",
] as const satisfies readonly RealityMemoryType[];

export function isRoleplayMemoryType(value: unknown): value is RoleplayMemoryType {
  return ROLEPLAY_MEMORY_TYPES.some((type) => type === value);
}

export function isRealityMemoryType(value: unknown): value is RealityMemoryType {
  return REALITY_MEMORY_TYPES.some((type) => type === value);
}

export type MemoryConfirmationProvenance = {
  kind: "explicit_user_authorization" | "trusted_control_plane";
  actor: "user";
  confirmedAt: string;
  evidenceMessageId: string | null;
};

export type RpMemory = {
  id: string;
  realm: MemoryRealm;
  scope: MemoryScope;
  type: MemoryType;
  key?: string;
  content: string;
  normalizedContent: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  characterId?: string;
  quarantineReasons?: LegacyMemoryQuarantineReason[];
  salience: number;
  confidence: number;
  validity: MemoryValidity;
  confirmed: boolean;
  confirmationProvenance?: MemoryConfirmationProvenance;
  rejectedAt?: string;
  archivedAt?: string;
  deletedAt?: string;
  statusReason?: string;
  tags: string[];
  supersededById?: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type CreateMemoryInput = {
  realm: RpMemoryRealm;
  scope: RpMemoryScope;
  type: RoleplayMemoryType;
  key?: string;
  content: string;
  sourceSessionId?: string;
  sourceMessageId?: string;
  characterId: string;
  salience?: number;
  confidence?: number;
  confirmed: boolean;
  tags?: string[];
  idempotencyKey?: string;
};

export type ProposeMemoryInput = Omit<CreateMemoryInput, "confirmed">;

export type UpdateMemoryInput = Partial<
  Pick<RpMemory, "type" | "key" | "content" | "salience" | "confidence" | "confirmed" | "tags" | "validity">
>;

export type MemorySearchFilter = {
  query?: string;
  characterId?: string;
  realm?: MemoryRealm;
  type?: MemoryType;
  types?: MemoryType[];
  validity?: MemoryValidity;
  validities?: MemoryValidity[];
  confirmedOnly?: boolean;
  limit?: number;
};

export type MemoryWriteResult = {
  memory?: RpMemory;
  duplicate?: RpMemory;
  conflict?: RpMemory;
  needsConfirmation: boolean;
};

export type PendingRealMutation = {
  id: string;
  sessionId: string;
  actionType: string;
  payload: Record<string, unknown>;
  status: "pending" | "confirmed" | "executed" | "rejected";
  createdAt: string;
  updatedAt: string;
};
