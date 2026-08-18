import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ConversationSpace } from "../domain/types.js";
import { WorkspaceFileService } from "./file-service.js";

export type WorkspaceConversationScope = {
  conversationSpace: ConversationSpace;
  characterId?: string;
};

export type ScopedWorkspace = Readonly<{
  key: string;
  cacheNamespace: string;
  conversationSpace: ConversationSpace;
  characterId?: string;
  dir: string;
  files: WorkspaceFileService;
}>;

/**
 * Resolves the filesystem capability for one conversation space.
 *
 * The existing Workspace remains the normal, shared root for backwards
 * compatibility. A secret Workspace is both outside that root and isolated by
 * character, so a relative path can never cross between the two modes.
 */
export class WorkspaceScopeRegistry {
  readonly normalDir: string;
  readonly secretRootDir: string;
  private readonly normalWorkspace: ScopedWorkspace;
  private readonly secretWorkspaces = new Map<string, ScopedWorkspace>();

  constructor(
    normalWorkspaceDir: string,
    normalFiles = new WorkspaceFileService(normalWorkspaceDir),
  ) {
    this.normalDir = resolve(normalWorkspaceDir);
    if (resolve(normalFiles.rootDir) !== this.normalDir) {
      throw new Error("normal Workspace service must use the configured normal Workspace directory");
    }
    this.secretRootDir = resolve(
      dirname(this.normalDir),
      `${basename(this.normalDir) || "workspace"}-secret`,
    );
    if (isWithin(this.normalDir, this.secretRootDir)) {
      throw new Error("secret Workspace root must be outside the normal Workspace root");
    }
    this.normalWorkspace = {
      key: "normal",
      cacheNamespace: "workspace:normal",
      conversationSpace: "normal",
      dir: this.normalDir,
      files: normalFiles,
    };
  }

  normal(): ScopedWorkspace {
    return this.normalWorkspace;
  }

  resolve(scope: WorkspaceConversationScope): ScopedWorkspace {
    if (scope.conversationSpace === "normal") return this.normalWorkspace;
    const characterId = scope.characterId?.trim();
    if (!characterId) throw new Error("secret Workspace requires a character-bound conversation");
    const characterKey = createHash("sha256").update(characterId).digest("hex");
    const existing = this.secretWorkspaces.get(characterKey);
    if (existing) return existing;

    mkdirSync(this.secretRootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.secretRootDir, 0o700);
    const dir = join(this.secretRootDir, characterKey);
    const workspace: ScopedWorkspace = {
      key: `secret:${characterKey}`,
      cacheNamespace: `workspace:secret:${characterKey}`,
      conversationSpace: "secret",
      characterId,
      dir,
      files: new WorkspaceFileService(dir),
    };
    this.secretWorkspaces.set(characterKey, workspace);
    return workspace;
  }
}

function isWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}
