import {
  existsSync,
  lstatSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { hashVaultEntries, parseVaultMarkdown, serializeVaultMarkdown } from "./codec.js";
import { MemoryVaultCasError, MemoryVaultError } from "./errors.js";
import { MemoryVaultPaths, relativePathForMetadata } from "./paths.js";
import {
  MEMORY_VAULT_SCHEMA_VERSION,
  type VaultCas,
  type VaultDocument,
  type VaultDocumentSummary,
  type VaultFrontmatter,
  type VaultWriteInput,
} from "./types.js";
import { durableAtomicWrite, fsyncDirectory, runFailpoint, type MemoryVaultFailpoint } from "./durability.js";
import type { VaultRawEntry } from "./journal.js";

const ROOT_README = `# RP Agent Memory Vault

This directory is the human-readable source of truth for RP Agent memory and can be opened directly as an Obsidian vault.

- \`reality/user-profile.md\`: the bounded high-signal user summary.
- \`reality/people/\`: structured, user-readable profiles for real people mentioned by the user.
- \`reality/memories/\`: confirmed and review-state global reality memories.
- \`roleplay/characters/<id>/\`: character SOUL and character-scoped roleplay memories.
- \`roleplay/scenes/\`: current roleplay scene state by application session.
- \`legacy/quarantine/\`: preserved legacy records that are never injected into roleplay context.
- \`archive/\`: reserved for explicit archival workflows.

The SQLite database and FTS tables are derived indexes and can be rebuilt from these Markdown files. Credentials, provider payloads, transcripts, and the database are deliberately stored outside this directory.

Safe application reads automatically validate and synchronize Obsidian edits and record an audit event. Use Vault Sync to validate immediately. Frontmatter is schema-controlled; invalid or duplicate metadata causes sync to fail without replacing the current SQLite projection.
`;

export class MemoryVaultStore {
  readonly rootPath?: string;
  private readonly paths?: MemoryVaultPaths;
  private readonly inMemory = new Map<string, string>();

  constructor(
    stateDir?: string,
    private readonly failpoint?: MemoryVaultFailpoint,
    private readonly beforeCommit?: () => void,
  ) {
    if (stateDir) {
      this.paths = new MemoryVaultPaths(stateDir);
      this.rootPath = this.paths.root;
      this.ensureLayout();
    }
  }

  ensureLayout(): void {
    if (!this.paths) return;
    this.paths.ensureLayout();
    const readme = this.paths.resolveRelative("README.md");
    if (!existsSync(readme)) atomicWrite(this.paths, readme, ROOT_README, this.failpoint, undefined, this.beforeCommit);
  }

  list(): VaultDocument[] {
    this.ensureLayout();
    const documents = this.paths
      ? this.paths.listMarkdownFiles().map((path) => {
          this.paths!.assertNoSymlink(path);
          return parseVaultMarkdown(readFileSync(path, "utf8"), this.paths!.relativePath(path));
        })
      : [...this.inMemory.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([relativePath, source]) => parseVaultMarkdown(source, relativePath));
    const ids = new Map<string, string>();
    for (const document of documents) {
      const previous = ids.get(document.metadata.id);
      if (previous) {
        throw new MemoryVaultError(
          `duplicate vault id ${document.metadata.id}: ${previous}, ${document.relativePath}`,
          "MEMORY_VAULT_DUPLICATE_ID",
        );
      }
      ids.set(document.metadata.id, document.relativePath);
    }
    for (const document of documents) {
      const expectedPath = relativePathForMetadata(document.metadata);
      if (expectedPath !== document.relativePath) {
        throw new MemoryVaultError(
          `${document.relativePath}: document belongs at ${expectedPath}`,
          "MEMORY_VAULT_PATH_INVALID",
        );
      }
    }
    return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  }

  get(id: string): VaultDocument | undefined {
    return this.list().find((document) => document.metadata.id === id);
  }

  getByKind(kind: VaultFrontmatter["kind"]): VaultDocument[] {
    return this.list().filter((document) => document.metadata.kind === kind);
  }

  write(input: VaultWriteInput, cas: VaultCas = {}): VaultDocument {
    const relativePath = relativePathForMetadata(input.metadata);
    const existing = this.readRelative(relativePath);
    if (existing && existing.metadata.id !== input.metadata.id) {
      throw new MemoryVaultError(
        `${relativePath}: target contains id ${existing.metadata.id}, not ${input.metadata.id}`,
        "MEMORY_VAULT_DUPLICATE_ID",
      );
    }
    assertCas(existing, cas, relativePath);
    const nowRevision = existing ? existing.metadata.revision + 1 : input.metadata.revision ?? 1;
    const metadata: VaultFrontmatter = {
      ...input.metadata,
      schemaVersion: MEMORY_VAULT_SCHEMA_VERSION,
      revision: nowRevision,
      contentHash: "0".repeat(64),
    };
    const source = serializeVaultMarkdown(metadata, input.body);
    this.writeRelative(relativePath, source);
    return parseVaultMarkdown(source, relativePath);
  }

  import(input: VaultWriteInput): VaultDocument {
    const relativePath = relativePathForMetadata(input.metadata);
    const existing = this.readRelative(relativePath);
    if (existing) return existing;
    return this.write(input);
  }

  normalizeExternalEdits(now: string): VaultDocument[] {
    const changed = this.list().filter((document) => document.externalModified);
    for (const document of changed) {
      const metadata = {
        ...document.metadata,
        updatedAt: now,
      };
      this.write({ metadata, body: document.body }, {
        expectedRevision: document.metadata.revision,
        expectedHash: document.documentHash,
      });
    }
    return this.list();
  }

  remove(id: string): boolean {
    const document = this.get(id);
    if (!document) return false;
    if (this.paths) {
      const path = this.paths.resolveRelative(document.relativePath);
      this.paths.assertNoSymlink(path);
      runFailpoint(this.failpoint, "vault_file.before_delete", { relativePath: document.relativePath });
      this.beforeCommit?.();
      unlinkSync(path);
      fsyncDirectory(dirname(path));
      runFailpoint(this.failpoint, "vault_file.after_delete", { relativePath: document.relativePath });
    } else {
      this.inMemory.delete(document.relativePath);
    }
    return true;
  }

  deleteAll(): number {
    const count = this.list().length;
    if (this.paths) {
      for (const path of this.paths.listMarkdownFiles()) {
        this.paths.assertNoSymlink(path);
        this.beforeCommit?.();
        unlinkSync(path);
        fsyncDirectory(dirname(path));
      }
      this.ensureLayout();
    } else {
      this.inMemory.clear();
    }
    return count;
  }

  summaries(): VaultDocumentSummary[] {
    return this.list().map((document) => ({
      id: document.metadata.id,
      title: documentTitle(document.metadata),
      kind: document.metadata.kind,
      realm: document.metadata.realm,
      scope: document.metadata.scope,
      type: document.metadata.type,
      characterId: document.metadata.characterId,
      sessionId: document.metadata.sessionId,
      validity: document.metadata.validity,
      confirmed: document.metadata.confirmed,
      revision: document.metadata.revision,
      updatedAt: document.metadata.updatedAt,
      contentHash: document.metadata.contentHash,
      quarantineReasons: document.metadata.quarantineReasons,
      path: document.relativePath,
      actualHash: document.actualHash,
      documentHash: document.documentHash,
      externalModified: document.externalModified,
    }));
  }

  hash(documents = this.list()): string {
    return hashVaultEntries(documents.map((document) => ({
      relativePath: document.relativePath,
      documentHash: document.documentHash,
    })));
  }

  atomicMutation<T>(operation: () => T): T {
    const checkpoint = this.snapshotRawEntries();
    try {
      return operation();
    } catch (error) {
      try {
        this.restoreRawEntries(checkpoint);
      } catch (rollbackError) {
        throw new MemoryVaultError(
          `vault mutation failed and rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          "MEMORY_VAULT_REBUILD_FAILED",
        );
      }
      throw error;
    }
  }

  private readRelative(relativePath: string): VaultDocument | undefined {
    if (this.paths) {
      const path = this.paths.resolveRelative(relativePath);
      if (!existsSync(path)) return undefined;
      this.paths.assertNoSymlink(path);
      if (!lstatSync(path).isFile()) {
        throw new MemoryVaultError(`${relativePath}: expected a regular file`, "MEMORY_VAULT_PATH_INVALID");
      }
      return parseVaultMarkdown(readFileSync(path, "utf8"), relativePath);
    }
    const source = this.inMemory.get(relativePath);
    return source === undefined ? undefined : parseVaultMarkdown(source, relativePath);
  }

  private writeRelative(relativePath: string, source: string): void {
    if (this.paths) {
      atomicWrite(this.paths, this.paths.resolveRelative(relativePath), source, this.failpoint, relativePath, this.beforeCommit);
    } else {
      this.inMemory.set(relativePath, source);
    }
  }

  snapshotRawEntries(): VaultRawEntry[] {
    if (!this.paths) {
      return [...this.inMemory.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([relativePath, source]) => ({ relativePath, source }));
    }
    return this.paths.listMarkdownFiles().map((path) => ({
      relativePath: this.paths!.relativePath(path),
      source: readFileSync(path, "utf8"),
    }));
  }

  restoreRawEntries(entries: VaultRawEntry[]): void {
    if (!this.paths) {
      this.inMemory.clear();
      for (const entry of entries) this.inMemory.set(entry.relativePath, entry.source);
      return;
    }
    for (const path of this.paths.listMarkdownFiles()) {
      this.paths.assertNoSymlink(path);
      this.beforeCommit?.();
      unlinkSync(path);
      fsyncDirectory(dirname(path));
    }
    for (const entry of entries) {
      atomicWrite(this.paths, this.paths.resolveRelative(entry.relativePath), entry.source, undefined, undefined, this.beforeCommit);
    }
  }
}

function documentTitle(metadata: VaultFrontmatter): string {
  if (metadata.kind === "user_profile") return "User Profile";
  if (metadata.kind === "character_soul") return `SOUL · ${metadata.characterId}`;
  if (metadata.kind === "scene") return `Scene · ${metadata.sessionId}`;
  if (metadata.realm === "legacy") return `Quarantine · ${metadata.id}`;
  return `${metadata.type ?? "Memory"} · ${metadata.id}`;
}

function assertCas(existing: VaultDocument | undefined, cas: VaultCas, path: string): void {
  if (cas.expectedRevision !== undefined && existing?.metadata.revision !== cas.expectedRevision) {
    throw new MemoryVaultCasError(
      `${path}: revision changed (expected ${cas.expectedRevision}, actual ${existing?.metadata.revision ?? "missing"})`,
    );
  }
  if (cas.expectedHash !== undefined && existing?.documentHash !== cas.expectedHash) {
    throw new MemoryVaultCasError(
      `${path}: document changed (expected ${cas.expectedHash}, actual ${existing?.documentHash ?? "missing"})`,
    );
  }
}

function atomicWrite(
  paths: MemoryVaultPaths,
  target: string,
  source: string,
  failpoint?: MemoryVaultFailpoint,
  relativePath = paths.relativePath(target),
  beforeCommit?: () => void,
): void {
  paths.ensureParent(target);
  paths.assertNoSymlink(target);
  durableAtomicWrite(target, source, {
    mode: 0o600,
    failpoint,
    failpointPrefix: "vault_file",
    metadata: { relativePath },
    beforeCommit,
  });
}
