import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { MemoryVaultError } from "./errors.js";
import type { VaultFrontmatter } from "./types.js";

const safeIdentifier = /^[A-Za-z0-9_-]+$/;

export class MemoryVaultPaths {
  readonly root: string;

  constructor(stateDir: string) {
    this.root = resolve(stateDir, "memory-vault");
  }

  ensureLayout(): void {
    this.ensureDirectory(this.root);
    for (const relativePath of [
      "reality",
      "reality/memories",
      "reality/people",
      "roleplay",
      "roleplay/characters",
      "roleplay/scenes",
      "secret",
      "secret/characters",
      "legacy",
      "legacy/quarantine",
      "archive",
    ]) {
      this.ensureDirectory(this.resolveRelative(relativePath));
    }
  }

  pathFor(metadata: Pick<
    VaultFrontmatter,
    "id" | "kind" | "realm" | "characterId" | "sessionId" |
      "conversationSpace" | "secretOwnerCharacterId"
  >): string {
    return this.resolveRelative(relativePathForMetadata(metadata));
  }

  relativePath(path: string): string {
    const result = relative(this.root, path).split(sep).join("/");
    if (!result || result.startsWith("../") || result === "..") pathError(path, "path escapes memory vault");
    return result;
  }

  resolveRelative(relativePath: string): string {
    if (relativePath.includes("\0") || relativePath.split(/[\\/]/).some((part) => part === "..")) {
      pathError(relativePath, "unsafe relative path");
    }
    const target = resolve(this.root, relativePath);
    const prefix = `${this.root}${sep}`;
    if (target !== this.root && !target.startsWith(prefix)) pathError(relativePath, "path escapes memory vault");
    this.assertNoSymlink(target);
    return target;
  }

  listMarkdownFiles(): string[] {
    this.ensureLayout();
    const files: string[] = [];
    const visit = (directory: string) => {
      this.assertNoSymlink(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) pathError(path, "symbolic links are not allowed in memory vault");
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") files.push(path);
      }
    };
    visit(this.root);
    return files.sort();
  }

  ensureParent(path: string): void {
    this.assertWithinRoot(path);
    this.ensureDirectory(dirname(path));
    this.assertNoSymlink(path);
  }

  assertWithinRoot(path: string): void {
    const target = resolve(path);
    if (target !== this.root && !target.startsWith(`${this.root}${sep}`)) pathError(path, "path escapes memory vault");
  }

  assertNoSymlink(target: string): void {
    const resolvedTarget = resolve(target);
    this.assertWithinRoot(resolvedTarget);
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) pathError(this.root, "memory vault root cannot be a symlink");
    const relativeParts = relative(this.root, resolvedTarget).split(sep).filter(Boolean);
    let current = this.root;
    for (const part of relativeParts) {
      current = join(current, part);
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) pathError(current, "symbolic links are not allowed in memory vault");
    }
    if (existsSync(this.root)) {
      const realRoot = realpathSync(this.root);
      const nearest = nearestExisting(resolvedTarget);
      const realNearest = realpathSync(nearest);
      if (realNearest !== realRoot && !realNearest.startsWith(`${realRoot}${sep}`)) pathError(target, "resolved path escapes memory vault");
    }
  }

  private ensureDirectory(path: string): void {
    this.assertWithinRoot(path);
    this.assertNoSymlink(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
}

export function relativePathForMetadata(
  metadata: Pick<
    VaultFrontmatter,
    "id" | "kind" | "realm" | "characterId" | "sessionId" |
      "conversationSpace" | "secretOwnerCharacterId"
  >,
): string {
  assertIdentifier(metadata.id, "id");
  if (metadata.kind === "memory" && metadata.conversationSpace === "secret") {
    assertIdentifier(metadata.secretOwnerCharacterId, "secretOwnerCharacterId");
    return `secret/characters/${metadata.secretOwnerCharacterId}/memories/${metadata.id}.md`;
  }
  if (metadata.kind === "user_profile") return "reality/user-profile.md";
  if (metadata.kind === "person_profile") return `reality/people/${metadata.id}.md`;
  if (metadata.kind === "character_soul") {
    assertIdentifier(metadata.characterId, "characterId");
    return `roleplay/characters/${metadata.characterId}/SOUL.md`;
  }
  if (metadata.kind === "scene") {
    assertIdentifier(metadata.sessionId, "sessionId");
    return `roleplay/scenes/${metadata.sessionId}.md`;
  }
  if (metadata.realm === "legacy") return `legacy/quarantine/${metadata.id}.md`;
  if (metadata.realm === "reality") return `reality/memories/${metadata.id}.md`;
  assertIdentifier(metadata.characterId, "characterId");
  return `roleplay/characters/${metadata.characterId}/memories/${metadata.id}.md`;
}

function nearestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) current = dirname(current);
  return current;
}

function assertIdentifier(value: string | null, field: string): asserts value is string {
  if (!value || !safeIdentifier.test(value)) pathError(String(value), `${field} is not a safe identifier`);
}

function pathError(path: string, message: string): never {
  throw new MemoryVaultError(`${message}: ${path}`, "MEMORY_VAULT_PATH_INVALID");
}
