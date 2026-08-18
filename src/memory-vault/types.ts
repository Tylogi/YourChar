import type { ConversationSpace } from "../domain/types.js";

export const MEMORY_VAULT_SCHEMA_VERSION = 4 as const;

export type VaultDocumentKind = "user_profile" | "person_profile" | "character_soul" | "scene" | "memory";
export type VaultRealm = "reality" | "roleplay" | "legacy";
export type VaultScope = "global" | "character" | "session" | "quarantine";
export type PersonProfileVisibility = "global" | "selected_characters";
export type VaultMemoryType =
  | "user_fact"
  | "preference"
  | "goal"
  | "person"
  | "project"
  | "relationship_event"
  | "world_fact"
  | "plot_event"
  | "boundary";
export type VaultMemoryValidity = "pending" | "active" | "superseded" | "rejected" | "archived" | "deleted";

export type VaultConfirmationProvenance = {
  kind: "explicit_user_authorization" | "trusted_control_plane";
  actor: "user";
  confirmedAt: string;
  evidenceMessageId: string | null;
};

export type VaultSceneData = {
  location: string | null;
  inWorldTime: string | null;
  participants: string[];
  currentObjective: string | null;
  openThreads: string[];
};

export type VaultFrontmatter = {
  schemaVersion: typeof MEMORY_VAULT_SCHEMA_VERSION;
  id: string;
  kind: VaultDocumentKind;
  realm: VaultRealm;
  scope: VaultScope;
  conversationSpace: ConversationSpace;
  secretOwnerCharacterId: string | null;
  type: VaultMemoryType | null;
  characterId: string | null;
  sessionId: string | null;
  validity: VaultMemoryValidity | null;
  confirmed: boolean | null;
  confirmationProvenance: VaultConfirmationProvenance | null;
  rejectedAt: string | null;
  archivedAt: string | null;
  deletedAt: string | null;
  statusReason: string | null;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  revision: number;
  supersedes: string | null;
  tags: string[];
  quarantineReasons: string[];
  contentHash: string;
  memoryKey: string | null;
  salience: number | null;
  confidence: number | null;
  idempotencyKey: string | null;
  scene: VaultSceneData | null;
  personKey: string | null;
  displayName: string | null;
  aliases: string[];
  relationship: string | null;
  visibility: PersonProfileVisibility | null;
  visibleToCharacterIds: string[];
  sourceMemoryIds: string[];
  personConfidence: number | null;
};

export type PersonProfile = {
  id: string;
  personKey: string;
  displayName: string;
  aliases: string[];
  relationship?: string;
  visibility: PersonProfileVisibility;
  visibleToCharacterIds: string[];
  sourceMemoryIds: string[];
  confidence: number;
  markdown: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type UpdatePersonProfileInput = {
  displayName?: string;
  aliases?: string[];
  relationship?: string | null;
  visibility?: PersonProfileVisibility;
  visibleToCharacterIds?: string[];
  markdown?: string;
};

export type VaultDocument = {
  metadata: VaultFrontmatter;
  body: string;
  relativePath: string;
  actualHash: string;
  documentHash: string;
  externalModified: boolean;
};

export type VaultWriteInput = {
  metadata: Omit<VaultFrontmatter, "schemaVersion" | "revision" | "contentHash"> & {
    revision?: number;
  };
  body: string;
};

export type VaultCas = {
  expectedRevision?: number;
  expectedHash?: string;
};

export type VaultDocumentSummary = Pick<
  VaultFrontmatter,
  "id" | "kind" | "realm" | "scope" | "type" | "characterId" | "sessionId" |
  "conversationSpace" | "secretOwnerCharacterId" | "validity" | "confirmed" | "revision" |
  "updatedAt" | "contentHash" | "quarantineReasons"
> & {
  title: string;
  path: string;
  actualHash: string;
  documentHash: string;
  externalModified: boolean;
};

export type MemoryVaultStatus = {
  available: boolean;
  rootPath?: string;
  documentCount: number;
  counts: Record<VaultDocumentKind, number>;
  vaultHash: string;
  projectionHash?: string;
  inSync: boolean;
  externalModifiedCount: number;
  migrationStatus: "not_required" | "pending" | "in_progress" | "complete" | "failed";
  lastRebuiltAt?: string;
};

export type VaultMigrationAction = "create" | "unchanged" | "preserve_vault";

export type VaultMigrationItem = {
  id: string;
  kind: VaultDocumentKind;
  targetPath: string;
  action: VaultMigrationAction;
  sourceHash: string;
};

export type VaultMigrationManifest = {
  schemaVersion: 1;
  sourceHash: string;
  status: "pending" | "in_progress" | "complete" | "failed";
  generatedAt: string;
  updatedAt: string;
  completedIds: string[];
  items: VaultMigrationItem[];
  error?: string;
};

export type LegacyVaultSnapshot = {
  profile?: { markdown: string; updatedAt: string };
  characters: Array<{
    id: string;
    soulMarkdown: string;
    createdAt: string;
    updatedAt: string;
  }>;
  scenes: Array<{
    roleSessionId: string;
    characterId?: string;
    location?: string;
    inWorldTime?: string;
    participants: string[];
    currentObjective?: string;
    openThreads: string[];
    summary: string;
    updatedAt: string;
    idempotencyKey?: string;
  }>;
  memories: Array<{
    id: string;
    conversationSpace?: ConversationSpace;
    secretOwnerCharacterId?: string;
    realm: "reality" | "roleplay" | "legacy";
    scope: "global" | "character" | "quarantine";
    type: VaultMemoryType;
    key?: string;
    content: string;
    sourceSessionId?: string;
    sourceMessageId?: string;
    characterId?: string;
    salience: number;
    confidence: number;
    validity: VaultMemoryValidity;
    confirmed: boolean;
    confirmationProvenance?: VaultConfirmationProvenance;
    rejectedAt?: string;
    archivedAt?: string;
    deletedAt?: string;
    statusReason?: string;
    tags: string[];
    supersededById?: string;
    createdAt: string;
    updatedAt: string;
    lastUsedAt?: string;
    quarantineReasons?: string[];
    idempotencyKey?: string;
  }>;
};
