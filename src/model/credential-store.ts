import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import type { Clock } from "../app/clock.js";
import { durableAtomicWrite } from "../memory-vault/durability.js";

export type ModelCredentialStatus = "active" | "missing" | "revoked";

export type ModelCredentialMetadata = {
  credentialRef: string;
  status: ModelCredentialStatus;
  revision?: number;
  masked: string;
  canRollback: boolean;
  createdAt?: string;
  updatedAt?: string;
  revokedAt?: string;
  authType?: "oauth";
};

/** A host-owned capability; no tokens are copied into model configurations. */
export type ModelOAuthBinding = {
  providerId: "openai-codex";
  credentials: CredentialStore;
  secrets(): readonly string[];
};

export type ModelCredentialResolution = ModelCredentialMetadata & {
  apiKey?: string;
  oauth?: ModelOAuthBinding;
};

export type ModelCredentialResolver = (
  credentialRef: string,
  ownerProfileId: string,
) => ModelCredentialResolution | undefined;

type StoredSecretVersion = {
  secret: string;
  masked: string;
  revision: number;
  activatedAt: string;
};

type StoredModelCredential = {
  credentialRef: string;
  ownerProfileId: string;
  status: "active" | "revoked";
  revision: number;
  masked: string;
  secret?: string;
  authType?: "oauth";
  oauth?: OAuthCredential;
  previous?: StoredSecretVersion;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

type StoredModelCredentialDocument = {
  version: 1;
  credentials: StoredModelCredential[];
};

export type ModelCredentialStoreOptions = {
  stateDir?: string;
  clock: Clock;
  externalResolver?: ModelCredentialResolver;
};

export class ModelCredentialValidationError extends Error {
  readonly code = "MODEL_CREDENTIAL_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ModelCredentialValidationError";
  }
}

export class ModelCredentialConflictError extends Error {
  readonly code = "MODEL_CREDENTIAL_CONFLICT";

  constructor(
    message: string,
    readonly expectedRevision?: number,
    readonly actualRevision?: number,
  ) {
    super(message);
    this.name = "ModelCredentialConflictError";
  }
}

export class ModelCredentialUnavailableError extends Error {
  readonly code = "MODEL_CREDENTIAL_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "ModelCredentialUnavailableError";
  }
}

export class ModelCredentialVerificationError extends Error {
  readonly code = "MODEL_CREDENTIAL_VERIFICATION_FAILED";

  constructor(message = "candidate model credential verification failed") {
    super(message);
    this.name = "ModelCredentialVerificationError";
  }
}

const credentialReferencePattern = /^model-credential-[0-9a-f]{32}$/;
const maximumSecretCharacters = 65_536;

export class ModelCredentialStore {
  readonly path?: string;
  private document: StoredModelCredentialDocument;
  private readonly externalResolver?: ModelCredentialResolver;
  private readonly oauthBindings = new Map<string, ModelOAuthBinding>();
  private readonly oauthWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly options: ModelCredentialStoreOptions) {
    this.path = options.stateDir
      ? join(options.stateDir, "model-credentials.json")
      : undefined;
    this.externalResolver = options.externalResolver;
    this.document = this.load();
  }

  resolve(
    credentialRef: string,
    ownerProfileId: string,
  ): ModelCredentialResolution {
    const entry = this.document.credentials.find((candidate) =>
      candidate.credentialRef === credentialRef
    );
    if (entry) {
      if (entry.ownerProfileId !== ownerProfileId) return missingCredential(credentialRef);
      return this.resolveEntry(entry);
    }
    return normalizeExternalResolution(
      credentialRef,
      this.externalResolver?.(credentialRef, ownerProfileId),
    );
  }

  metadata(
    credentialRef: string,
    ownerProfileId: string,
  ): ModelCredentialMetadata {
    return safeCredentialMetadata(this.resolve(credentialRef, ownerProfileId));
  }

  findReferenceForOwner(ownerProfileId: string): string | undefined {
    return this.document.credentials.find((entry) =>
      entry.ownerProfileId === ownerProfileId
    )?.credentialRef;
  }

  create(
    ownerProfileId: string,
    apiKey: string,
    credentialRef = newCredentialReference(),
  ): ModelCredentialMetadata {
    const owner = requiredOwnerProfileId(ownerProfileId);
    const secret = requiredApiKey(apiKey);
    assertCredentialReference(credentialRef);
    if (this.document.credentials.some((entry) => entry.credentialRef === credentialRef)) {
      throw new ModelCredentialConflictError("model credential reference already exists");
    }
    if (this.document.credentials.some((entry) => entry.ownerProfileId === owner)) {
      throw new ModelCredentialConflictError("model profile already owns a credential reference");
    }
    const now = this.options.clock.now().toISOString();
    const entry: StoredModelCredential = {
      credentialRef,
      ownerProfileId: owner,
      status: "active",
      revision: 1,
      masked: maskModelCredential(secret),
      secret,
      createdAt: now,
      updatedAt: now,
    };
    this.commit({
      version: 1,
      credentials: [...this.document.credentials, entry],
    });
    return safeCredentialMetadata(resolutionForEntry(entry));
  }

  replaceMissingReference(
    ownerProfileId: string,
    apiKey: string,
  ): ModelCredentialMetadata {
    const owner = requiredOwnerProfileId(ownerProfileId);
    const secret = requiredApiKey(apiKey);
    const credentialRef = newCredentialReference();
    const now = this.options.clock.now().toISOString();
    const entry: StoredModelCredential = {
      credentialRef,
      ownerProfileId: owner,
      status: "active",
      revision: 1,
      masked: maskModelCredential(secret),
      secret,
      createdAt: now,
      updatedAt: now,
    };
    this.commit({
      version: 1,
      credentials: [
        ...this.document.credentials.filter((candidate) =>
          candidate.ownerProfileId !== owner
        ),
        entry,
      ],
    });
    return safeCredentialMetadata(resolutionForEntry(entry));
  }

  rotate(
    credentialRef: string,
    ownerProfileId: string,
    apiKey: string,
    expectedRevision?: number,
  ): ModelCredentialMetadata {
    const secret = requiredApiKey(apiKey);
    const { next, entry } = this.mutableEntry(
      credentialRef,
      ownerProfileId,
      expectedRevision,
    );
    const now = this.options.clock.now().toISOString();
    const previous = currentSecretVersion(entry);
    entry.status = "active";
    entry.revision += 1;
    entry.secret = secret;
    delete entry.oauth;
    delete entry.authType;
    entry.masked = maskModelCredential(secret);
    entry.updatedAt = now;
    delete entry.revokedAt;
    if (previous) entry.previous = previous;
    else delete entry.previous;
    this.commit(next);
    this.oauthBindings.delete(credentialRef);
    return safeCredentialMetadata(resolutionForEntry(entry));
  }

  revoke(
    credentialRef: string,
    ownerProfileId: string,
    expectedRevision?: number,
  ): ModelCredentialMetadata {
    const { next, entry } = this.mutableEntry(
      credentialRef,
      ownerProfileId,
      expectedRevision,
    );
    if (entry.status === "revoked") {
      return safeCredentialMetadata(resolutionForEntry(entry));
    }
    const now = this.options.clock.now().toISOString();
    const previous = currentSecretVersion(entry);
    entry.status = "revoked";
    entry.revision += 1;
    delete entry.secret;
    delete entry.oauth;
    if (previous) entry.previous = previous;
    entry.updatedAt = now;
    entry.revokedAt = now;
    this.commit(next);
    this.oauthBindings.delete(credentialRef);
    return safeCredentialMetadata(resolutionForEntry(entry));
  }

  rollback(
    credentialRef: string,
    ownerProfileId: string,
    expectedRevision?: number,
  ): ModelCredentialMetadata {
    const { next, entry } = this.mutableEntry(
      credentialRef,
      ownerProfileId,
      expectedRevision,
    );
    if (entry.authType === "oauth" || !entry.previous) {
      throw new ModelCredentialConflictError(
        "model credential has no last-known-good version",
        expectedRevision,
        entry.revision,
      );
    }
    const now = this.options.clock.now().toISOString();
    const previous = entry.previous;
    entry.status = "active";
    entry.revision += 1;
    entry.secret = previous.secret;
    entry.masked = previous.masked;
    entry.updatedAt = now;
    delete entry.previous;
    delete entry.revokedAt;
    this.commit(next);
    return safeCredentialMetadata(resolutionForEntry(entry));
  }

  remove(credentialRef: string, ownerProfileId: string): boolean {
    const entry = this.document.credentials.find((candidate) =>
      candidate.credentialRef === credentialRef && candidate.ownerProfileId === ownerProfileId
    );
    if (!entry) return false;
    this.commit({
      version: 1,
      credentials: this.document.credentials.filter((candidate) => candidate !== entry),
    });
    this.oauthBindings.delete(credentialRef);
    return true;
  }

  scopedResolver(
    bindings: readonly { credentialRef: string; ownerProfileId: string }[],
  ): ModelCredentialResolver {
    const allowed = new Map(bindings.filter((entry) =>
      credentialReferencePattern.test(entry.credentialRef) && entry.ownerProfileId.trim()
    ).map((entry) => [entry.credentialRef, entry.ownerProfileId]));
    return (credentialRef, ownerProfileId) => {
      if (allowed.get(credentialRef) !== ownerProfileId) {
        return missingCredential(credentialRef);
      }
      const entry = this.document.credentials.find((candidate) =>
        candidate.credentialRef === credentialRef &&
        candidate.ownerProfileId === ownerProfileId
      );
      if (entry) return this.resolveEntry(entry);
      return normalizeExternalResolution(
        credentialRef,
        this.externalResolver?.(credentialRef, ownerProfileId),
      );
    };
  }

  setOAuth(
    ownerProfileId: string,
    credential: OAuthCredential,
    expectedRevision: number,
    credentialRef?: string,
  ): ModelCredentialMetadata {
    const owner = requiredOwnerProfileId(ownerProfileId);
    const oauth = normalizeModelOAuthCredential(credential);
    const current = credentialRef
      ? this.document.credentials.find((entry) => entry.credentialRef === credentialRef)
      : undefined;
    if (current && current.ownerProfileId !== owner) {
      throw new ModelCredentialUnavailableError("model credential owner mismatch");
    }
    if (current) assertExpectedRevision(current, expectedRevision);
    else if (expectedRevision !== 0) throw new ModelCredentialConflictError("model credential revision changed");
    const now = this.options.clock.now().toISOString();
    const entry: StoredModelCredential = {
      credentialRef: current?.credentialRef ?? newCredentialReference(),
      ownerProfileId: owner,
      status: "active",
      revision: (current?.revision ?? 0) + 1,
      authType: "oauth",
      masked: "ChatGPT",
      oauth,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    this.commit({
      version: 1,
      credentials: [...this.document.credentials.filter((item) => item.ownerProfileId !== owner), entry],
    });
    return safeCredentialMetadata(this.resolveEntry(entry));
  }

  private resolveEntry(entry: StoredModelCredential): ModelCredentialResolution {
    const metadata = resolutionForEntry(entry);
    if (entry.authType !== "oauth" || entry.status !== "active" || !entry.oauth) return metadata;
    let binding = this.oauthBindings.get(entry.credentialRef);
    if (!binding) {
      const ref = entry.credentialRef;
      const owner = entry.ownerProfileId;
      const secrets = new Set<string>();
      const read = () => {
        const current = this.document.credentials.find((item) => item.credentialRef === ref && item.ownerProfileId === owner);
        const oauth = current?.status === "active" && current.authType === "oauth" ? current.oauth : undefined;
        if (oauth) {
          secrets.add(oauth.access);
          secrets.add(oauth.refresh);
        }
        return oauth ? { ...oauth } : undefined;
      };
      const credentials: CredentialStore = {
        read: async (providerId, options) => {
          options?.signal?.throwIfAborted();
          return providerId === "openai-codex" ? read() : undefined;
        },
        list: async (options) => {
          options?.signal?.throwIfAborted();
          return read() ? [{ providerId: "openai-codex", type: "oauth" }] : [];
        },
        modify: async (providerId, fn, options) => {
          if (providerId !== "openai-codex") throw new ModelCredentialUnavailableError("OAuth provider mismatch");
          return this.serializeOAuthWrite(ref, async () => {
            options?.signal?.throwIfAborted();
            const current = read();
            const revision = this.resolve(ref, owner).revision;
            if (!current) throw new ModelCredentialUnavailableError("Codex is signed out");
            const updated = await fn(current);
            // Once the issuer rotates a refresh token, persist the successful
            // response even if this request was cancelled in the meantime.
            // Explicit logout/re-login still wins through the revision guard.
            if (!updated) return read();
            const oauth = normalizeModelOAuthCredential(updated);
            const latest = this.resolve(ref, owner);
            if (latest.status !== "active" || latest.authType !== "oauth" || latest.revision !== revision) {
              throw new ModelCredentialConflictError("Codex login changed during refresh");
            }
            const next = cloneCredentialDocument(this.document);
            const target = next.credentials.find((item) => item.credentialRef === ref)!;
            target.oauth = oauth;
            // Rotation of access tokens is not a user credential revision.
            target.updatedAt = this.options.clock.now().toISOString();
            this.commit(next);
            return read();
          });
        },
        delete: async (providerId, options) => {
          if (providerId !== "openai-codex") return;
          await this.serializeOAuthWrite(ref, async () => {
            options?.signal?.throwIfAborted();
            if (read()) this.revoke(ref, owner);
          });
        },
      };
      binding = { providerId: "openai-codex", credentials, secrets: () => { read(); return [...secrets]; } };
      this.oauthBindings.set(ref, binding);
    }
    binding.secrets();
    return { ...metadata, oauth: binding };
  }

  private async serializeOAuthWrite<T>(ref: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.oauthWrites.get(ref) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(operation);
    this.oauthWrites.set(ref, write);
    try { return await write; }
    finally { if (this.oauthWrites.get(ref) === write) this.oauthWrites.delete(ref); }
  }

  private mutableEntry(
    credentialRef: string,
    ownerProfileId: string,
    expectedRevision?: number,
  ): { next: StoredModelCredentialDocument; entry: StoredModelCredential } {
    const next = cloneCredentialDocument(this.document);
    const entry = next.credentials.find((candidate) =>
      candidate.credentialRef === credentialRef
    );
    if (!entry || entry.ownerProfileId !== ownerProfileId) {
      throw new ModelCredentialUnavailableError("model credential reference is missing");
    }
    assertExpectedRevision(entry, expectedRevision);
    return { next, entry };
  }

  private load(): StoredModelCredentialDocument {
    if (!this.path || !existsSync(this.path)) return emptyCredentialDocument();
    const stats = lstatSync(this.path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ModelCredentialValidationError(
        "model credential store must be a regular non-symlink file",
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    } catch {
      throw new ModelCredentialValidationError("model credential store is not valid JSON");
    }
    const document = normalizeCredentialDocument(parsed);
    chmodSync(this.path, 0o600);
    return document;
  }

  private commit(next: StoredModelCredentialDocument): void {
    if (this.path) {
      mkdirSync(this.options.stateDir!, { recursive: true, mode: 0o700 });
      durableAtomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`, {
        mode: 0o600,
        failpointPrefix: "model_credentials",
      });
    }
    this.document = next;
  }
}

function emptyCredentialDocument(): StoredModelCredentialDocument {
  return { version: 1, credentials: [] };
}

function cloneCredentialDocument(
  document: StoredModelCredentialDocument,
): StoredModelCredentialDocument {
  return {
    version: 1,
    credentials: document.credentials.map((entry) => ({
      ...entry,
      ...(entry.previous ? { previous: { ...entry.previous } } : {}),
    })),
  };
}

function normalizeCredentialDocument(value: unknown): StoredModelCredentialDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.credentials)) {
    throw new ModelCredentialValidationError("model credential store has an unsupported schema");
  }
  const references = new Set<string>();
  const owners = new Set<string>();
  const credentials = value.credentials.map((candidate) => {
    if (!isRecord(candidate)) invalidCredentialStore();
    const credentialRef = stringField(candidate, "credentialRef");
    const ownerProfileId = stringField(candidate, "ownerProfileId");
    const status = candidate.status;
    const revision = candidate.revision;
    const masked = stringField(candidate, "masked");
    const createdAt = isoTimestampField(candidate, "createdAt");
    const updatedAt = isoTimestampField(candidate, "updatedAt");
    if (
      !credentialReferencePattern.test(credentialRef) ||
      !ownerProfileId || ownerProfileId.length > 256 ||
      (status !== "active" && status !== "revoked") ||
      !Number.isInteger(revision) || Number(revision) < 1 ||
      !masked || masked.length > 32 ||
      references.has(credentialRef) || owners.has(ownerProfileId)
    ) invalidCredentialStore();
    references.add(credentialRef);
    owners.add(ownerProfileId);
    const secret = typeof candidate.secret === "string"
      ? requiredApiKey(candidate.secret)
      : undefined;
    const authType = candidate.authType === "oauth" ? "oauth" as const : undefined;
    if (candidate.authType !== undefined && !authType) invalidCredentialStore();
    const oauth = candidate.oauth === undefined ? undefined : normalizeModelOAuthCredential(candidate.oauth);
    if (authType === "oauth") {
      if (secret || candidate.previous || (status === "active") !== Boolean(oauth) || masked !== "ChatGPT") invalidCredentialStore();
    } else if (oauth || (status === "active") !== Boolean(secret)) invalidCredentialStore();
    const previous = candidate.previous === undefined
      ? undefined
      : normalizeSecretVersion(candidate.previous);
    const revokedAt = candidate.revokedAt === undefined
      ? undefined
      : isoTimestampField(candidate, "revokedAt");
    if ((status === "revoked") !== Boolean(revokedAt)) invalidCredentialStore();
    if (
      !authType && ((status === "active" && masked !== maskModelCredential(secret!)) ||
      (status === "revoked" && (!previous || masked !== previous.masked)))
    ) invalidCredentialStore();
    return {
      credentialRef,
      ownerProfileId,
      status,
      revision: Number(revision),
      masked,
      ...(secret ? { secret } : {}),
      ...(authType ? { authType } : {}),
      ...(oauth ? { oauth } : {}),
      ...(previous ? { previous } : {}),
      createdAt,
      updatedAt,
      ...(revokedAt ? { revokedAt } : {}),
    } satisfies StoredModelCredential;
  });
  return { version: 1, credentials };
}

function normalizeSecretVersion(value: unknown): StoredSecretVersion {
  if (!isRecord(value)) invalidCredentialStore();
  const secret = requiredApiKey(stringField(value, "secret"));
  const masked = stringField(value, "masked");
  const revision = value.revision;
  const activatedAt = isoTimestampField(value, "activatedAt");
  if (!masked || masked.length > 32 || !Number.isInteger(revision) || Number(revision) < 1) {
    invalidCredentialStore();
  }
  if (masked !== maskModelCredential(secret)) invalidCredentialStore();
  return { secret, masked, revision: Number(revision), activatedAt };
}

function resolutionForEntry(entry: StoredModelCredential): ModelCredentialResolution {
  return {
    credentialRef: entry.credentialRef,
    status: entry.status,
    revision: entry.revision,
    masked: entry.masked,
    canRollback: Boolean(entry.previous),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.revokedAt ? { revokedAt: entry.revokedAt } : {}),
    ...(entry.status === "active" && entry.secret ? { apiKey: entry.secret } : {}),
    ...(entry.authType ? { authType: entry.authType } : {}),
  };
}

function normalizeExternalResolution(
  credentialRef: string,
  resolution: ModelCredentialResolution | undefined,
): ModelCredentialResolution {
  if (!resolution || resolution.credentialRef !== credentialRef) {
    return missingCredential(credentialRef);
  }
  if (
    resolution.status !== "active" &&
    resolution.status !== "missing" &&
    resolution.status !== "revoked"
  ) return missingCredential(credentialRef);
  if (resolution.status === "active" && !resolution.apiKey && !resolution.oauth) {
    return missingCredential(credentialRef);
  }
  const apiKey = resolution.status === "active" && resolution.apiKey
    ? requiredApiKey(resolution.apiKey)
    : undefined;
  return {
    credentialRef,
    status: resolution.status,
    ...(Number.isInteger(resolution.revision) && Number(resolution.revision) > 0
      ? { revision: Number(resolution.revision) }
      : {}),
    masked: apiKey ? maskModelCredential(apiKey) : "",
    canRollback: resolution.canRollback === true,
    ...(validOptionalTimestamp(resolution.createdAt)
      ? { createdAt: resolution.createdAt }
      : {}),
    ...(validOptionalTimestamp(resolution.updatedAt)
      ? { updatedAt: resolution.updatedAt }
      : {}),
    ...(resolution.status === "revoked" && validOptionalTimestamp(resolution.revokedAt)
      ? { revokedAt: resolution.revokedAt }
      : {}),
    ...(apiKey
      ? { apiKey }
      : {}),
    ...(resolution.authType === "oauth" ? { authType: "oauth" as const } : {}),
    ...(resolution.status === "active" && resolution.oauth ? { oauth: resolution.oauth } : {}),
  };
}

function validOptionalTimestamp(value: string | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function missingCredential(credentialRef: string): ModelCredentialResolution {
  return {
    credentialRef,
    status: "missing",
    masked: "",
    canRollback: false,
  };
}

function safeCredentialMetadata(
  resolution: ModelCredentialResolution,
): ModelCredentialMetadata {
  const { apiKey: _apiKey, oauth: _oauth, ...metadata } = resolution;
  return metadata;
}

function currentSecretVersion(
  entry: StoredModelCredential,
): StoredSecretVersion | undefined {
  if (entry.status === "active" && entry.secret) {
    return {
      secret: entry.secret,
      masked: entry.masked,
      revision: entry.revision,
      activatedAt: entry.updatedAt,
    };
  }
  return entry.previous ? { ...entry.previous } : undefined;
}

function assertExpectedRevision(
  entry: StoredModelCredential,
  expectedRevision: number | undefined,
): void {
  if (expectedRevision === undefined) return;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ModelCredentialValidationError(
      "expectedRevision must be a non-negative integer",
    );
  }
  if (expectedRevision !== entry.revision) {
    throw new ModelCredentialConflictError(
      "model credential revision changed",
      expectedRevision,
      entry.revision,
    );
  }
}

function requiredApiKey(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ModelCredentialValidationError("apiKey is required");
  if (normalized.length > maximumSecretCharacters) {
    throw new ModelCredentialValidationError(
      `apiKey must be at most ${maximumSecretCharacters} characters`,
    );
  }
  return normalized;
}

function requiredOwnerProfileId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new ModelCredentialValidationError(
      "credential owner profile id must contain 1 to 256 characters",
    );
  }
  return normalized;
}

function assertCredentialReference(value: string): void {
  if (!credentialReferencePattern.test(value)) {
    throw new ModelCredentialValidationError("model credential reference is invalid");
  }
}

function newCredentialReference(): string {
  return `model-credential-${randomUUID().replaceAll("-", "")}`;
}

export function maskModelCredential(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function redactModelCredentialText(
  value: string,
  secret: ModelCredentialSecrets,
): string {
  if (Array.isArray(secret)) return secret.reduce((text, item) => redactModelCredentialText(text, item), value);
  return secret ? value.split(secret as string).join("[redacted-model-credential]") : value;
}

export type ModelCredentialSecrets = string | readonly string[] | undefined;

export function modelCredentialSecrets(config: { apiKey?: string; oauth?: ModelOAuthBinding }): readonly string[] {
  return [...(config.apiKey ? [config.apiKey] : []), ...(config.oauth?.secrets() ?? [])];
}

export function redactModelCredentialValue<T>(value: T, secret: ModelCredentialSecrets): T {
  if (Array.isArray(secret)) return secret.reduce((result, item) => redactModelCredentialValue(result, item), value);
  if (!secret) return value;
  return redactCredentialValue(value, secret as string, new WeakMap<object, unknown>()) as T;
}

export function containsModelCredentialValue(
  value: unknown,
  secret: ModelCredentialSecrets,
): boolean {
  if (Array.isArray(secret)) return secret.some((item) => containsModelCredentialValue(value, item));
  if (!secret) return false;
  return credentialValueContains(value, secret as string, new WeakSet<object>());
}

export function normalizeModelOAuthCredential(value: unknown): OAuthCredential {
  if (!isRecord(value) || value.type !== "oauth" ||
      typeof value.access !== "string" || !value.access.trim() || value.access.length > maximumSecretCharacters ||
      typeof value.refresh !== "string" || !value.refresh.trim() || value.refresh.length > maximumSecretCharacters ||
      typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires <= 0 ||
      typeof value.accountId !== "string" || !value.accountId.trim() || value.accountId.length > 256) {
    throw new ModelCredentialValidationError("invalid Codex OAuth credential");
  }
  return { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires, accountId: value.accountId };
}

function credentialValueContains(
  value: unknown,
  secret: string,
  seen: WeakSet<object>,
): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((field) =>
    credentialValueContains(field, secret, seen)
  );
}

function redactCredentialValue(
  value: unknown,
  secret: string,
  seen: WeakMap<object, unknown>,
): unknown {
  if (typeof value === "string") return redactModelCredentialText(value, secret);
  if (!value || typeof value !== "object") return value;
  const previous = seen.get(value);
  if (previous) return previous;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (let index = 0; index < value.length; index += 1) {
      output[index] = redactCredentialValue(value[index], secret, seen);
    }
    return output;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, field] of Object.entries(value)) {
    output[key] = redactCredentialValue(field, secret, seen);
  }
  return output;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") invalidCredentialStore();
  return field;
}

function isoTimestampField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key);
  if (!Number.isFinite(Date.parse(field))) invalidCredentialStore();
  return field;
}

function invalidCredentialStore(): never {
  throw new ModelCredentialValidationError("model credential store is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
