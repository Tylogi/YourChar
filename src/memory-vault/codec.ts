import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { MemoryVaultError } from "./errors.js";
import {
  MEMORY_VAULT_SCHEMA_VERSION,
  type VaultDocument,
  type VaultDocumentKind,
  type VaultFrontmatter,
  type VaultMemoryType,
  type VaultMemoryValidity,
  type VaultRealm,
  type VaultSceneData,
  type VaultScope,
} from "./types.js";

const r2FrontmatterKeys = [
  "schemaVersion", "id", "kind", "realm", "scope", "type", "characterId", "sessionId",
  "validity", "confirmed", "sourceSessionId", "sourceMessageId", "createdAt", "updatedAt",
  "lastUsedAt", "revision", "supersedes", "tags", "quarantineReasons", "contentHash",
  "memoryKey", "salience", "confidence", "idempotencyKey", "scene",
] as const;

const frontmatterKeys = [
  "schemaVersion", "id", "kind", "realm", "scope", "type", "characterId", "sessionId",
  "validity", "confirmed", "confirmationProvenance", "rejectedAt", "archivedAt", "deletedAt",
  "statusReason", "sourceSessionId", "sourceMessageId", "createdAt", "updatedAt", "lastUsedAt",
  "revision", "supersedes", "tags", "quarantineReasons", "contentHash", "memoryKey", "salience",
  "confidence", "idempotencyKey", "scene",
] as const;

export function parseVaultMarkdown(source: string, relativePath: string): VaultDocument {
  const normalized = source.replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) invalid(relativePath, "missing YAML frontmatter start");
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) invalid(relativePath, "missing YAML frontmatter end");
  const yaml = normalized.slice(4, end);
  const document = parseDocument(yaml, {
    schema: "core",
    strict: true,
    uniqueKeys: true,
    prettyErrors: true,
  });
  if (document.errors.length) {
    invalid(relativePath, document.errors.map((error) => error.message).join("; "));
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    invalid(relativePath, error instanceof Error ? error.message : String(error));
  }
  const metadata = validateFrontmatter(value, relativePath);
  const body = normalizeBody(normalized.slice(end + 5));
  const actualHash = hashVaultBody(body);
  return {
    metadata,
    body,
    relativePath,
    actualHash,
    documentHash: createHash("sha256").update(normalized).digest("hex"),
    externalModified: actualHash !== metadata.contentHash,
  };
}

export function serializeVaultMarkdown(metadata: VaultFrontmatter, body: string): string {
  const normalizedBody = normalizeBody(body);
  const stable = stableFrontmatter({
    ...metadata,
    contentHash: hashVaultBody(normalizedBody),
  });
  const yaml = stringify(stable, {
    schema: "core",
    lineWidth: 0,
    sortMapEntries: false,
  }).trimEnd();
  return `---\n${yaml}\n---\n${normalizedBody}`;
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

export function hashVaultBody(body: string): string {
  return createHash("sha256").update(normalizeBody(body)).digest("hex");
}

export function hashVaultEntries(entries: Array<{ relativePath: string; documentHash: string }>): string {
  return createHash("sha256").update(
    entries
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((entry) => `${entry.relativePath}\0${entry.documentHash}`)
      .join("\n"),
  ).digest("hex");
}

function validateFrontmatter(value: unknown, path: string): VaultFrontmatter {
  const record = object(value, path, "frontmatter must be a mapping");
  const schemaVersion = record.schemaVersion === 1 ? 1 : literal(
    record.schemaVersion,
    MEMORY_VAULT_SCHEMA_VERSION,
    path,
    "schemaVersion",
  );
  const keys = Object.keys(record).sort();
  const expected = [...(schemaVersion === 1 ? r2FrontmatterKeys : frontmatterKeys)].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    invalid(path, `frontmatter keys must be exactly: ${(schemaVersion === 1 ? r2FrontmatterKeys : frontmatterKeys).join(", ")}`);
  }
  const metadata: VaultFrontmatter = {
    schemaVersion: MEMORY_VAULT_SCHEMA_VERSION,
    id: identifier(record.id, path, "id"),
    kind: oneOf(record.kind, ["user_profile", "character_soul", "scene", "memory"], path, "kind"),
    realm: oneOf(record.realm, ["reality", "roleplay", "legacy"], path, "realm"),
    scope: oneOf(record.scope, ["global", "character", "session", "quarantine"], path, "scope"),
    type: nullableOneOf(record.type, ["user_fact", "preference", "goal", "person", "project", "relationship_event", "world_fact", "plot_event", "boundary"], path, "type"),
    characterId: nullableIdentifier(record.characterId, path, "characterId"),
    sessionId: nullableIdentifier(record.sessionId, path, "sessionId"),
    validity: nullableOneOf(record.validity, ["pending", "active", "superseded", "rejected", "archived", "deleted"], path, "validity"),
    confirmed: nullableBoolean(record.confirmed, path, "confirmed"),
    confirmationProvenance: schemaVersion === 1
      ? record.confirmed === true
        ? {
            kind: "trusted_control_plane",
            actor: "user",
            confirmedAt: timestamp(record.updatedAt, path, "updatedAt"),
            evidenceMessageId: record.sourceMessageId === null
              ? null
              : identifier(record.sourceMessageId, path, "sourceMessageId"),
          }
        : null
      : nullableConfirmationProvenance(record.confirmationProvenance, path),
    rejectedAt: schemaVersion === 1 ? null : nullableTimestamp(record.rejectedAt, path, "rejectedAt"),
    archivedAt: schemaVersion === 1 ? null : nullableTimestamp(record.archivedAt, path, "archivedAt"),
    deletedAt: schemaVersion === 1 ? null : nullableTimestamp(record.deletedAt, path, "deletedAt"),
    statusReason: schemaVersion === 1 ? null : nullableString(record.statusReason, path, "statusReason"),
    sourceSessionId: nullableIdentifier(record.sourceSessionId, path, "sourceSessionId"),
    sourceMessageId: nullableIdentifier(record.sourceMessageId, path, "sourceMessageId"),
    createdAt: timestamp(record.createdAt, path, "createdAt"),
    updatedAt: timestamp(record.updatedAt, path, "updatedAt"),
    lastUsedAt: nullableTimestamp(record.lastUsedAt, path, "lastUsedAt"),
    revision: positiveInteger(record.revision, path, "revision"),
    supersedes: nullableIdentifier(record.supersedes, path, "supersedes"),
    tags: stringArray(record.tags, path, "tags"),
    quarantineReasons: stringArray(record.quarantineReasons, path, "quarantineReasons"),
    contentHash: sha256(record.contentHash, path),
    memoryKey: nullableString(record.memoryKey, path, "memoryKey"),
    salience: nullableUnitNumber(record.salience, path, "salience"),
    confidence: nullableUnitNumber(record.confidence, path, "confidence"),
    idempotencyKey: nullableString(record.idempotencyKey, path, "idempotencyKey"),
    scene: nullableScene(record.scene, path),
  };
  validateKindContract(metadata, path, schemaVersion);
  return metadata;
}

function validateKindContract(metadata: VaultFrontmatter, path: string, sourceSchemaVersion: 1 | 2): void {
  if (metadata.kind === "user_profile") {
    if (metadata.id !== "user-profile" || metadata.realm !== "reality" || metadata.scope !== "global") {
      invalid(path, "user_profile must use id=user-profile, realm=reality, scope=global");
    }
    assertStaticDocumentFields(metadata, path);
  } else if (metadata.kind === "character_soul") {
    if (metadata.realm !== "roleplay" || metadata.scope !== "character" || !metadata.characterId) {
      invalid(path, "character_soul must be roleplay/character with characterId");
    }
    assertStaticDocumentFields(metadata, path);
  } else if (metadata.kind === "scene") {
    if (metadata.realm !== "roleplay" || metadata.scope !== "session" || !metadata.sessionId || !metadata.scene) {
      invalid(path, "scene must be roleplay/session with sessionId and scene data");
    }
    if (metadata.type || metadata.validity || metadata.confirmed !== null || metadata.supersedes ||
        metadata.confirmationProvenance || metadata.rejectedAt || metadata.archivedAt || metadata.deletedAt ||
        metadata.statusReason ||
        metadata.memoryKey || metadata.salience !== null || metadata.confidence !== null ||
        metadata.quarantineReasons.length) {
      invalid(path, "scene contains memory-only frontmatter");
    }
  } else {
    if (!metadata.type || !metadata.validity || metadata.confirmed === null ||
        metadata.salience === null || metadata.confidence === null || metadata.scene) {
      invalid(path, "memory requires type, validity, confirmed, salience, confidence, and scene=null");
    }
    if (metadata.realm === "roleplay") {
      if (metadata.scope !== "character" || !metadata.characterId ||
          !["relationship_event", "world_fact", "plot_event", "boundary"].includes(metadata.type) ||
          metadata.quarantineReasons.length) {
        invalid(path, "roleplay memory requires character scope and an RP-only type");
      }
    } else if (metadata.realm === "reality") {
      if (metadata.scope !== "global" || metadata.characterId ||
          !["user_fact", "preference", "goal", "person", "project", "boundary"].includes(metadata.type) ||
          metadata.quarantineReasons.length) {
        invalid(path, "reality memory requires global scope, no characterId, and a reality-only type");
      }
    } else if (metadata.scope !== "quarantine" || !metadata.quarantineReasons.length) {
      invalid(path, "non-roleplay memory must be legacy/quarantine with reasons");
    }
    if (metadata.confirmed && !metadata.confirmationProvenance && sourceSchemaVersion >= 2) {
      invalid(path, "confirmed memory requires confirmationProvenance");
    }
    if (!metadata.confirmed && metadata.confirmationProvenance) {
      invalid(path, "unconfirmed memory cannot have confirmationProvenance");
    }
    if (metadata.validity === "active" && !metadata.confirmed) {
      invalid(path, "active memory must be confirmed");
    }
  }
}

function assertStaticDocumentFields(metadata: VaultFrontmatter, path: string): void {
  if (metadata.type || metadata.sessionId || metadata.validity || metadata.confirmed !== null ||
      metadata.confirmationProvenance || metadata.rejectedAt || metadata.archivedAt || metadata.deletedAt ||
      metadata.statusReason ||
      metadata.sourceSessionId || metadata.sourceMessageId || metadata.lastUsedAt || metadata.supersedes ||
      metadata.quarantineReasons.length || metadata.memoryKey || metadata.salience !== null ||
      metadata.confidence !== null || metadata.idempotencyKey || metadata.scene) {
    invalid(path, `${metadata.kind} contains memory or scene-only frontmatter`);
  }
}

function stableFrontmatter(value: VaultFrontmatter): VaultFrontmatter {
  const canonical: VaultFrontmatter = {
    ...value,
    tags: [...new Set(value.tags.map((item) => item.trim()).filter(Boolean))].sort(),
    quarantineReasons: [...new Set(value.quarantineReasons.map((item) => item.trim()).filter(Boolean))].sort(),
  };
  return Object.fromEntries(frontmatterKeys.map((key) => [key, canonical[key]])) as VaultFrontmatter;
}

function object(value: unknown, path: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, message);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) invalid(path, `${field} must be a safe identifier`);
  return value;
}

function nullableIdentifier(value: unknown, path: string, field: string): string | null {
  return value === null ? null : identifier(value, path, field);
}

function nullableString(value: unknown, path: string, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") invalid(path, `${field} must be a string or null`);
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T, path: string, field: string): T {
  if (value !== expected) invalid(path, `${field} must equal ${String(expected)}`);
  return expected;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string, field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalid(path, `${field} is invalid`);
  return value as T;
}

function nullableOneOf<T extends string>(value: unknown, allowed: readonly T[], path: string, field: string): T | null {
  return value === null ? null : oneOf(value, allowed, path, field);
}

function nullableBoolean(value: unknown, path: string, field: string): boolean | null {
  if (value !== null && typeof value !== "boolean") invalid(path, `${field} must be boolean or null`);
  return value as boolean | null;
}

function positiveInteger(value: unknown, path: string, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) invalid(path, `${field} must be a positive integer`);
  return Number(value);
}

function nullableUnitNumber(value: unknown, path: string, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(path, `${field} must be between 0 and 1 or null`);
  }
  return value;
}

function stringArray(value: unknown, path: string, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) invalid(path, `${field} must be a string array`);
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function timestamp(value: unknown, path: string, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    invalid(path, `${field} must be a canonical UTC ISO timestamp`);
  }
  return value;
}

function nullableTimestamp(value: unknown, path: string, field: string): string | null {
  return value === null ? null : timestamp(value, path, field);
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) invalid(path, "contentHash must be SHA-256 hex");
  return value;
}

function nullableScene(value: unknown, path: string): VaultSceneData | null {
  if (value === null) return null;
  const scene = object(value, path, "scene must be a mapping or null");
  const keys = Object.keys(scene).sort().join(",");
  if (keys !== ["currentObjective", "inWorldTime", "location", "openThreads", "participants"].sort().join(",")) {
    invalid(path, "scene keys are invalid");
  }
  return {
    location: nullableString(scene.location, path, "scene.location"),
    inWorldTime: nullableString(scene.inWorldTime, path, "scene.inWorldTime"),
    participants: stringArray(scene.participants, path, "scene.participants"),
    currentObjective: nullableString(scene.currentObjective, path, "scene.currentObjective"),
    openThreads: stringArray(scene.openThreads, path, "scene.openThreads"),
  };
}

function nullableConfirmationProvenance(
  value: unknown,
  path: string,
): VaultFrontmatter["confirmationProvenance"] {
  if (value === null) return null;
  const record = object(value, path, "confirmationProvenance must be a mapping or null");
  const keys = Object.keys(record).sort().join(",");
  if (keys !== ["actor", "confirmedAt", "evidenceMessageId", "kind"].sort().join(",")) {
    invalid(path, "confirmationProvenance keys are invalid");
  }
  return {
    kind: oneOf(record.kind, ["explicit_user_authorization", "trusted_control_plane"], path, "confirmationProvenance.kind"),
    actor: literal(record.actor, "user", path, "confirmationProvenance.actor"),
    confirmedAt: timestamp(record.confirmedAt, path, "confirmationProvenance.confirmedAt"),
    evidenceMessageId: nullableIdentifier(record.evidenceMessageId, path, "confirmationProvenance.evidenceMessageId"),
  };
}

function invalid(path: string, message: string): never {
  throw new MemoryVaultError(`${path}: ${message}`, "MEMORY_VAULT_INVALID_DOCUMENT");
}
