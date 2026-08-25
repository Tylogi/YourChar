import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";

/**
 * A trusted repository-registry projection. The Agent never constructs this
 * object and GitWorkItemService never accepts a remote URL, ref, or checkout
 * path in an operation request.
 */
export type GitWorkRepository = {
  id: string;
  projectId: string;
  projectStorageKey: string;
  repositoryStorageKey: string;
  remoteUrl: string;
  defaultBranch: string;
};

export type GitWorkRepositoryResolver = (
  repositoryId: string,
  projectId: string,
) => GitWorkRepository | undefined | Promise<GitWorkRepository | undefined>;

/** Credentials stay in the host adapter. Only the final, trusted SSH command
 * needed by Git crosses this boundary; it is never persisted or returned. */
export type GitWorkRepositoryEnvironmentResolver = (
  repository: GitWorkRepository,
) => { GIT_SSH_COMMAND?: string } | Promise<{ GIT_SSH_COMMAND?: string }>;

export type GitWorkCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitWorkCommandRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}) => Promise<GitWorkCommandResult>;

export type GitWorkItemState = "active" | "closed";

export type GitWorkItem = {
  id: string;
  repositoryId: string;
  projectId: string;
  projectStorageKey: string;
  repositoryStorageKey: string;
  ownerSessionId: string;
  ownerCharacterId: string;
  branch: string;
  defaultBranch: string;
  workspacePath: string;
  baseOid: string;
  headOid: string;
  pushedHeadOid?: string;
  remoteBranch?: string;
  state: GitWorkItemState;
  handoffCount: number;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type GitWorkItemStatus = {
  workItem: GitWorkItem;
  clean: boolean;
  summary: string;
};

export type GitWorkItemCommitResult = {
  workItem: GitWorkItem;
  commit: string;
  changedPaths: number;
};

export type GitWorkItemPublishResult = {
  workItem: GitWorkItem;
  commit: string;
  remoteBranch: string;
};

export type GitWorkItemServiceOptions = {
  stateDir: string;
  workspaceDir: string;
  resolveRepository: GitWorkRepositoryResolver;
  resolveEnvironment?: GitWorkRepositoryEnvironmentResolver;
  runner?: GitWorkCommandRunner;
  clock?: Clock;
  idFactory?: () => string;
};

type StoredWorkItem = GitWorkItem & {
  repositoryFingerprint: string;
  branchOwnerCharacterId: string;
  approvedCommits: string[];
};

type StoredState = {
  version: 1;
  items: StoredWorkItem[];
};

const stateVersion = 1 as const;
const safeSlug = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const safeOpaqueId = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/u;
const safeGeneratedWorkItemId = /^work-[a-f0-9]{20,40}$/u;
const safeBranch = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const exactSshRemote = /^ssh:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/(.+)$/u;
const objectIdPattern = /^[a-f0-9]{40,64}$/u;
const maximumOutputBytes = 128 * 1024;
const maximumDiffBytes = 64 * 1024;
const maximumChangedFiles = 1_000;
const maximumChangedBytes = 64 * 1024 * 1024;
const maximumCommitMessageCharacters = 500;
const localOperationTimeoutMs = 120_000;
const remoteOperationTimeoutMs = 180_000;
const sensitivePathPattern = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|kdbx)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/iu;
const forbiddenTrackedPathPattern = /(?:^|\/)(?:\.gitmodules|\.lfsconfig)$/iu;
const sensitiveContentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|tvly-[A-Za-z0-9_-]{16,})\b/u,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/-]{12,}/iu,
];

export class GitWorkItemConfigurationError extends Error {
  readonly code = "GIT_WORK_ITEM_CONFIGURATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "GitWorkItemConfigurationError";
  }
}

export class GitWorkItemOperationError extends Error {
  readonly code: string = "GIT_WORK_ITEM_OPERATION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "GitWorkItemOperationError";
  }
}

export class GitWorkItemLeaseError extends GitWorkItemOperationError {
  override readonly code = "GIT_WORK_ITEM_LEASE_MISMATCH";

  constructor(message = "The active session and character do not own this Git work item") {
    super(message);
    this.name = "GitWorkItemLeaseError";
  }
}

/**
 * Owns task-scoped Git branches and worktrees. A durable, explicit
 * session+character lease is the sole writer for an item. Different work
 * items share only a hidden object store, never a mutable checkout or index.
 */
export class GitWorkItemService {
  private readonly stateDir: string;
  private readonly workspaceDir: string;
  private readonly runtimeDir: string;
  private readonly repositoriesDir: string;
  private readonly statePath: string;
  private readonly gitHome: string;
  private readonly resolveRepository: GitWorkRepositoryResolver;
  private readonly resolveEnvironment?: GitWorkRepositoryEnvironmentResolver;
  private readonly runner: GitWorkCommandRunner;
  private readonly clock: Clock;
  private readonly idFactory: () => string;
  private readonly repositoryMutex = new KeyedMutex();
  private readonly workItemMutex = new KeyedMutex();
  private readonly items = new Map<string, StoredWorkItem>();
  private activeOperations = 0;

  constructor(options: GitWorkItemServiceOptions) {
    this.stateDir = ensureRootDirectory(options.stateDir, "Git work-item state");
    this.workspaceDir = ensureRootDirectory(options.workspaceDir, "Git work-item Workspace");
    this.runtimeDir = join(this.stateDir, "git-worktrees");
    this.repositoriesDir = join(this.runtimeDir, "repositories");
    this.gitHome = join(this.runtimeDir, "home");
    this.statePath = join(this.stateDir, "git-work-items.json");
    this.resolveRepository = options.resolveRepository;
    this.resolveEnvironment = options.resolveEnvironment;
    this.runner = options.runner ?? spawnGitCommand;
    this.clock = options.clock ?? new SystemClock();
    this.idFactory = options.idFactory ?? (() => `work-${randomBytes(12).toString("hex")}`);

    ensureManagedDirectory(this.runtimeDir, this.stateDir, "Git work-item runtime");
    ensureManagedDirectory(this.repositoriesDir, this.runtimeDir, "Git repository object-store root");
    ensureManagedDirectory(this.gitHome, this.runtimeDir, "Git work-item HOME");
    this.load();
  }

  async openWorkItem(input: {
    projectId: string;
    repositoryId: string;
    sessionId: string;
    characterId: string;
    signal?: AbortSignal;
  }): Promise<GitWorkItem> {
    return this.trackOperation(async () => {
      const projectId = requireOpaqueId(input.projectId, "projectId");
      const repositoryId = requireOpaqueId(input.repositoryId, "repositoryId");
      const sessionId = requireOpaqueId(input.sessionId, "sessionId");
      const characterId = requireOpaqueId(input.characterId, "characterId");
      const workItemId = requireGeneratedWorkItemId(this.idFactory());

      return this.repositoryMutex.run(repositoryId, async () => {
        const repository = await this.requireRepository(repositoryId, projectId);
        const existing = [...this.items.values()].find((item) =>
          item.state === "active" &&
          item.projectId === projectId &&
          item.repositoryId === repositoryId &&
          item.ownerSessionId === sessionId &&
          item.ownerCharacterId === characterId
        );
        if (existing) return publicItem(existing);
        const worktreeParent = this.ensureWorktreeParent(repository);
        const workspacePath = generatedWorkspacePath(repository, workItemId);
        const checkout = resolve(worktreeParent, workItemId);
        if (checkout !== this.resolveWorkspacePath(workspacePath) || dirname(checkout) !== worktreeParent) {
          throw new GitWorkItemConfigurationError("Generated Git worktree path escapes its managed repository directory");
        }
        if (pathEntryExists(checkout)) {
          throw new GitWorkItemOperationError("Generated Git worktree path already exists");
        }

        const store = await this.ensureRepositoryStore(repository, input.signal);
        const baseOid = await this.fetchDefaultBranch(repository, store, input.signal);
        const branch = generatedBranch(characterId, workItemId);
        const now = this.clock.now().toISOString();

        // Recheck after the remote fetch. A local actor must not be able to
        // replace an intermediate Workspace directory while the operation is
        // awaiting I/O and redirect `git worktree add` elsewhere.
        const recheckedParent = this.assertWorktreeParent(repository);
        if (recheckedParent !== worktreeParent || pathEntryExists(checkout)) {
          throw new GitWorkItemOperationError("Generated Git worktree path changed while opening the work item");
        }

        try {
          await this.git(
            repository,
            ["--git-dir", store, "worktree", "add", "-b", branch, "--", checkout, baseOid],
            this.workspaceDir,
            input.signal,
          );
          chmodSync(checkout, 0o700);
          const item: StoredWorkItem = {
            id: workItemId,
            repositoryId,
            projectId: repository.projectId,
            projectStorageKey: repository.projectStorageKey,
            repositoryStorageKey: repository.repositoryStorageKey,
            repositoryFingerprint: repositoryFingerprint(repository),
            ownerSessionId: sessionId,
            ownerCharacterId: characterId,
            branchOwnerCharacterId: characterId,
            branch,
            defaultBranch: repository.defaultBranch,
            workspacePath,
            baseOid,
            headOid: baseOid,
            state: "active",
            handoffCount: 0,
            approvedCommits: [],
            createdAt: now,
            updatedAt: now,
          };
          await this.assertWorktree(item, repository, input.signal);
          this.items.set(item.id, item);
          this.persist();
          return publicItem(item);
        } catch (error) {
          await this.cleanupGeneratedWorktree(repository, store, checkout, worktreeParent);
          await this.git(repository, ["--git-dir", store, "branch", "-D", "--", branch], this.workspaceDir)
            .catch(() => undefined);
          throw error;
        }
      });
    });
  }

  listWorkItems(input: {
    sessionId: string;
    characterId: string;
    includeClosed?: boolean;
  }): GitWorkItem[] {
    const sessionId = requireOpaqueId(input.sessionId, "sessionId");
    const characterId = requireOpaqueId(input.characterId, "characterId");
    return [...this.items.values()]
      .filter((item) =>
        item.ownerSessionId === sessionId &&
        item.ownerCharacterId === characterId &&
        (input.includeClosed === true || item.state === "active")
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(publicItem);
  }

  findActiveForOwner(input: {
    sessionId: string;
    characterId: string;
    repositoryId?: string;
  }): GitWorkItem | undefined {
    const sessionId = requireOpaqueId(input.sessionId, "sessionId");
    const characterId = requireOpaqueId(input.characterId, "characterId");
    const repositoryId = input.repositoryId === undefined
      ? undefined
      : requireOpaqueId(input.repositoryId, "repositoryId");
    const matches = [...this.items.values()]
      .filter((item) =>
        item.state === "active" &&
        item.ownerSessionId === sessionId &&
        item.ownerCharacterId === characterId &&
        (repositoryId === undefined || item.repositoryId === repositoryId)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return matches[0] ? publicItem(matches[0]) : undefined;
  }

  async status(input: {
    workItemId: string;
    sessionId: string;
    characterId: string;
    signal?: AbortSignal;
  }): Promise<GitWorkItemStatus> {
    return this.trackOperation(async () => {
      const binding = requireBinding(input);
      const repositoryId = this.requireItem(binding.workItemId).repositoryId;
      return this.repositoryMutex.run(repositoryId, async () =>
        this.workItemMutex.run(binding.workItemId, async () => {
          const { item, repository } = await this.requireOwnedActiveItem(binding);
          return this.statusUnlocked(item, repository, input.signal);
        })
      );
    });
  }

  async diff(input: {
    workItemId: string;
    sessionId: string;
    characterId: string;
    staged?: boolean;
    signal?: AbortSignal;
  }): Promise<{ workItem: GitWorkItem; diff: string; truncated: boolean }> {
    return this.trackOperation(async () => {
      const binding = requireBinding(input);
      const repositoryId = this.requireItem(binding.workItemId).repositoryId;
      return this.repositoryMutex.run(repositoryId, async () =>
      this.workItemMutex.run(binding.workItemId, async () => {
        const { item, repository } = await this.requireOwnedActiveItem(binding);
        const checkout = await this.assertWorktree(item, repository, input.signal);
        const result = await this.git(
          repository,
          ["-C", checkout, "diff", "--no-ext-diff", "--no-textconv", ...(input.staged ? ["--cached"] : []), "--"],
          checkout,
          input.signal,
        );
        const bounded = boundText(result.stdout, maximumDiffBytes);
        return { workItem: publicItem(item), diff: bounded.text, truncated: bounded.truncated };
      })
      );
    });
  }

  async log(input: {
    workItemId: string;
    sessionId: string;
    characterId: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ workItem: GitWorkItem; log: string; truncated: boolean }> {
    return this.trackOperation(async () => {
      const binding = requireBinding(input);
      const limit = input.limit === undefined ? 10 : input.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        throw new GitWorkItemConfigurationError("Git work-item log limit must be an integer from 1 to 50");
      }
      const repositoryId = this.requireItem(binding.workItemId).repositoryId;
      return this.repositoryMutex.run(repositoryId, async () =>
      this.workItemMutex.run(binding.workItemId, async () => {
        const { item, repository } = await this.requireOwnedActiveItem(binding);
        const checkout = await this.assertWorktree(item, repository, input.signal);
        const result = await this.git(
          repository,
          [
            "-C", checkout,
            "log", `-${limit}`, "--date=iso-strict",
            "--pretty=format:%H%x09%ad%x09%an%x09%s",
          ],
          checkout,
          input.signal,
        );
        const bounded = boundText(result.stdout, maximumDiffBytes);
        return { workItem: publicItem(item), log: bounded.text, truncated: bounded.truncated };
      })
      );
    });
  }

  async commit(input: {
    workItemId: string;
    sessionId: string;
    characterId: string;
    characterName: string;
    message: string;
    signal?: AbortSignal;
  }): Promise<GitWorkItemCommitResult> {
    return this.trackOperation(async () => {
      const binding = requireBinding(input);
      const message = requireCommitMessage(input.message);
      const repositoryId = this.requireItem(binding.workItemId).repositoryId;
      return this.repositoryMutex.run(repositoryId, async () => this.workItemMutex.run(binding.workItemId, async () => {
      const { item, repository } = await this.requireOwnedActiveItem(binding);
      const checkout = await this.assertWorktree(item, repository, input.signal);
      const staged = await this.git(repository, ["-C", checkout, "diff", "--cached", "--name-only", "--"], checkout, input.signal);
      if (staged.stdout.trim()) {
        throw new GitWorkItemOperationError("The Git work item already has staged changes");
      }
      const changed = await this.changedPaths(repository, checkout, input.signal);
      if (!changed.length) throw new GitWorkItemOperationError("The Git work item has no changes to commit");
      this.scanChangedFiles(checkout, changed);
      const previousHead = await this.head(repository, checkout, input.signal);
      item.headOid = previousHead;
      await this.git(repository, ["-C", checkout, "add", "-A", "--"], checkout, input.signal);
      try {
        const authorName = `${sanitizeAuthorName(input.characterName)} via YourChar`;
        const authorEmail = `${identitySlug(input.characterId)}@yourchar.local`;
        await this.git(
          repository,
          [
            "-C", checkout,
            "-c", `user.name=${authorName}`,
            "-c", `user.email=${authorEmail}`,
            "-c", "commit.gpgSign=false",
            "commit", "--no-gpg-sign", "--no-verify", "-m", message,
          ],
          checkout,
          input.signal,
        );
      } catch (error) {
        await this.git(repository, ["-C", checkout, "reset", "--mixed", "HEAD", "--"], checkout).catch(() => undefined);
        throw error;
      }
      item.headOid = await this.head(repository, checkout, input.signal);
      try {
        await this.scanCommitRange(repository, checkout, previousHead, item.headOid, input.signal);
      } catch (error) {
        await this.git(repository, ["-C", checkout, "reset", "--mixed", previousHead, "--"], checkout).catch(() => undefined);
        item.headOid = previousHead;
        throw error;
      }
      if (!item.approvedCommits.includes(item.headOid)) item.approvedCommits.push(item.headOid);
      item.updatedAt = this.clock.now().toISOString();
      this.persist();
      return { workItem: publicItem(item), commit: item.headOid, changedPaths: changed.length };
      }));
    });
  }

  async publish(input: {
    workItemId: string;
    sessionId: string;
    characterId: string;
    signal?: AbortSignal;
  }): Promise<GitWorkItemPublishResult> {
    return this.trackOperation(async () => {
      const binding = requireBinding(input);
      const repositoryId = this.requireItem(binding.workItemId).repositoryId;
      return this.repositoryMutex.run(repositoryId, async () =>
      this.workItemMutex.run(binding.workItemId, async () => {
        const { item, repository } = await this.requireOwnedActiveItem(binding);
        const checkout = await this.assertWorktree(item, repository, input.signal);
        const status = await this.statusUnlocked(item, repository, input.signal);
        if (!status.clean) throw new GitWorkItemOperationError("Commit all Git work item changes before publishing");
        const head = status.workItem.headOid;
        const remoteBranch = item.branch;
        const remoteHead = await this.remoteBranchHead(repository, remoteBranch, checkout, input.signal);
        const pendingBase = remoteHead ?? item.baseOid;
        if (!await this.gitExit(repository, ["-C", checkout, "merge-base", "--is-ancestor", pendingBase, head], checkout, input.signal)) {
          throw new GitWorkItemOperationError("The remote work branch is not an ancestor of the work item; force push is not allowed");
        }
        const pending = (await this.git(
          repository,
          ["-C", checkout, "rev-list", "--reverse", `${pendingBase}..${head}`],
          checkout,
          input.signal,
        )).stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).map(requireObjectId);
        if (pending.length > 100) throw new GitWorkItemOperationError("Too many local commits are pending publish");
        const approved = new Set(item.approvedCommits);
        const unapproved = pending.find((commit) => !approved.has(commit));
        if (unapproved) {
          throw new GitWorkItemOperationError(`Refusing to publish unapproved local commit ${unapproved.slice(0, 12)}`);
        }
        if (pending.length) await this.scanCommitRange(repository, checkout, pendingBase, head, input.signal);

        // Deliberately no '+', --force, --force-with-lease, or caller-supplied ref.
        await this.git(
          repository,
          ["-C", checkout, "push", "--porcelain", repository.remoteUrl, `${head}:refs/heads/${remoteBranch}`],
          checkout,
          input.signal,
          true,
        );
        item.headOid = head;
        item.pushedHeadOid = head;
        item.remoteBranch = remoteBranch;
        const published = new Set(pending);
        item.approvedCommits = item.approvedCommits.filter((commit) => !published.has(commit));
        item.updatedAt = this.clock.now().toISOString();
        this.persist();
        return { workItem: publicItem(item), commit: head, remoteBranch };
      })
      );
    });
  }

  async handoff(input: {
    workItemId: string;
    fromSessionId: string;
    fromCharacterId: string;
    toSessionId: string;
    toCharacterId: string;
  }): Promise<GitWorkItem> {
    return this.trackOperation(async () => {
      const workItemId = requireGeneratedWorkItemId(input.workItemId);
      const fromSessionId = requireOpaqueId(input.fromSessionId, "fromSessionId");
      const fromCharacterId = requireOpaqueId(input.fromCharacterId, "fromCharacterId");
      const toSessionId = requireOpaqueId(input.toSessionId, "toSessionId");
      const toCharacterId = requireOpaqueId(input.toCharacterId, "toCharacterId");
      if (fromSessionId === toSessionId && fromCharacterId === toCharacterId) {
        throw new GitWorkItemOperationError("Git work item handoff target must be a different lease owner");
      }
      return this.workItemMutex.run(workItemId, async () => {
        const item = this.requireItem(workItemId);
        this.assertActive(item);
        this.assertLease(item, fromSessionId, fromCharacterId);
        item.ownerSessionId = toSessionId;
        item.ownerCharacterId = toCharacterId;
        item.handoffCount += 1;
        item.updatedAt = this.clock.now().toISOString();
        this.persist();
        return publicItem(item);
      });
    });
  }

  async close(input: {
    workItemId: string;
    sessionId: string;
    characterId: string;
    signal?: AbortSignal;
  }): Promise<GitWorkItem> {
    return this.trackOperation(async () => {
      const binding = requireBinding(input);
      const itemForKey = this.requireItem(binding.workItemId);
      return this.repositoryMutex.run(itemForKey.repositoryId, async () =>
      this.workItemMutex.run(binding.workItemId, async () => {
        const { item, repository } = await this.requireOwnedActiveItem(binding);
        const checkout = await this.assertWorktree(item, repository, input.signal);
        const status = await this.statusUnlocked(item, repository, input.signal);
        if (!status.clean) {
          throw new GitWorkItemOperationError("Cannot close a Git work item with uncommitted changes");
        }
        if (item.headOid !== item.baseOid && item.pushedHeadOid !== item.headOid) {
          throw new GitWorkItemOperationError("Cannot close a Git work item with unpushed commits");
        }
        if (item.headOid !== item.baseOid) {
          if (!item.remoteBranch) {
            throw new GitWorkItemOperationError("Cannot close a changed Git work item without a published remote branch");
          }
          const remoteHead = await this.remoteBranchHead(
            repository,
            item.remoteBranch,
            checkout,
            input.signal,
          );
          if (remoteHead !== item.headOid) {
            throw new GitWorkItemOperationError(
              "Cannot close because the published remote work branch no longer points at this Work Item HEAD",
            );
          }
        }

        const store = this.repositoryStorePath(repository.id);
        await this.git(repository, ["--git-dir", store, "worktree", "remove", "--force", "--", checkout], this.workspaceDir, input.signal);
        // Once the Worktree is removed, branch cleanup is best-effort. A
        // retained local branch is safe recovery data; throwing here would
        // leave an active record whose checkout no longer exists.
        await this.git(repository, ["--git-dir", store, "branch", "-D", "--", item.branch], this.workspaceDir, input.signal)
          .catch(() => undefined);
        const now = this.clock.now().toISOString();
        item.state = "closed";
        item.closedAt = now;
        item.updatedAt = now;
        this.persist();
        return publicItem(item);
      })
      );
    });
  }

  assertIdle(): void {
    if (this.activeOperations > 0) {
      throw new GitWorkItemOperationError("Git work-item operations are active; repository configuration cannot change yet");
    }
  }

  assertNoActiveItems(input: { projectIds?: string[]; repositoryIds?: string[] }): void {
    const projects = new Set((input.projectIds ?? []).map((id) => requireOpaqueId(id, "projectId")));
    const repositories = new Set((input.repositoryIds ?? []).map((id) => requireOpaqueId(id, "repositoryId")));
    if (!projects.size && !repositories.size) return;
    const active = [...this.items.values()].find((item) =>
      item.state === "active" &&
      (projects.has(item.projectId) || repositories.has(item.repositoryId))
    );
    if (active) {
      throw new GitWorkItemOperationError(
        "Close active Git Work Items before changing their project, repository, or SSH identity",
      );
    }
  }

  assertNoActiveItemsForSession(sessionId: string): void {
    const ownerSessionId = requireOpaqueId(sessionId, "sessionId");
    const active = [...this.items.values()].find((item) =>
      item.state === "active" && item.ownerSessionId === ownerSessionId
    );
    if (active) {
      throw new GitWorkItemOperationError(
        "Close active Git Work Items before permanently deleting their conversation",
      );
    }
  }

  private trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1;
    let result: Promise<T>;
    try {
      result = operation();
    } catch (error) {
      this.activeOperations -= 1;
      throw error;
    }
    return result.finally(() => {
      this.activeOperations -= 1;
    });
  }

  private async statusUnlocked(
    item: StoredWorkItem,
    repository: GitWorkRepository,
    signal?: AbortSignal,
  ): Promise<GitWorkItemStatus> {
    const checkout = await this.assertWorktree(item, repository, signal);
    const result = await this.git(
      repository,
      ["-C", checkout, "status", "--porcelain=v1", "--untracked-files=all"],
      checkout,
      signal,
    );
    item.headOid = await this.head(repository, checkout, signal);
    item.updatedAt = this.clock.now().toISOString();
    this.persist();
    return {
      workItem: publicItem(item),
      clean: !result.stdout.trim(),
      summary: boundText(result.stdout, maximumDiffBytes).text,
    };
  }

  private async requireOwnedActiveItem(binding: {
    workItemId: string;
    sessionId: string;
    characterId: string;
  }): Promise<{ item: StoredWorkItem; repository: GitWorkRepository }> {
    const item = this.requireItem(binding.workItemId);
    this.assertActive(item);
    this.assertLease(item, binding.sessionId, binding.characterId);
    const repository = await this.requireRepository(item.repositoryId, item.projectId);
    if (repositoryFingerprint(repository) !== item.repositoryFingerprint || repository.defaultBranch !== item.defaultBranch) {
      throw new GitWorkItemConfigurationError("The registered repository changed while this Git work item was active");
    }
    return { item, repository };
  }

  private requireItem(workItemId: string): StoredWorkItem {
    const item = this.items.get(requireGeneratedWorkItemId(workItemId));
    if (!item) throw new GitWorkItemOperationError("Git work item was not found");
    return item;
  }

  private assertActive(item: StoredWorkItem): void {
    if (item.state !== "active") throw new GitWorkItemOperationError("Git work item is closed");
  }

  private assertLease(item: StoredWorkItem, sessionId: string, characterId: string): void {
    if (item.ownerSessionId !== sessionId || item.ownerCharacterId !== characterId) {
      throw new GitWorkItemLeaseError();
    }
  }

  private async requireRepository(repositoryId: string, projectId: string): Promise<GitWorkRepository> {
    const resolved = await this.resolveRepository(repositoryId, projectId);
    if (!resolved) throw new GitWorkItemConfigurationError("Registered Git repository was not found");
    const repository: GitWorkRepository = {
      id: requireOpaqueId(resolved.id, "repository.id"),
      projectId: requireOpaqueId(resolved.projectId, "repository.projectId"),
      projectStorageKey: requireSlug(resolved.projectStorageKey, "projectStorageKey"),
      repositoryStorageKey: requireSlug(resolved.repositoryStorageKey, "repositoryStorageKey"),
      remoteUrl: requireSshRemote(resolved.remoteUrl),
      defaultBranch: requireBranch(resolved.defaultBranch),
    };
    if (repository.id !== repositoryId || repository.projectId !== projectId) {
      throw new GitWorkItemConfigurationError("Repository resolver returned a mismatched repository or project ID");
    }
    return repository;
  }

  private async ensureRepositoryStore(repository: GitWorkRepository, signal?: AbortSignal): Promise<string> {
    const store = this.repositoryStorePath(repository.id);
    if (!pathEntryExists(store)) {
      await this.git(repository, ["init", "--bare", "--", store], this.repositoriesDir, signal);
      chmodSync(store, 0o700);
    }
    const stats = lstatSync(store);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GitWorkItemConfigurationError("Git repository object store must be a real directory");
    }
    const canonical = realpathSync(store);
    const root = realpathSync(this.repositoriesDir);
    if (!isWithin(root, canonical)) {
      throw new GitWorkItemConfigurationError("Git repository object store escapes the managed state directory");
    }
    return canonical;
  }

  private ensureWorktreeParent(
    repository: Pick<GitWorkRepository, "projectStorageKey" | "repositoryStorageKey">,
  ): string {
    const components = [
      "projects",
      requireSlug(repository.projectStorageKey, "projectStorageKey"),
      requireSlug(repository.repositoryStorageKey, "repositoryStorageKey"),
      "worktrees",
    ];
    let parent = assertRootDirectory(this.workspaceDir, "Git work-item Workspace");
    for (const component of components) {
      const child = join(parent, component);
      parent = ensureManagedDirectory(child, parent, `Git worktree ${component} directory`);
    }
    return parent;
  }

  private assertWorktreeParent(
    repository: Pick<GitWorkRepository, "projectStorageKey" | "repositoryStorageKey">,
  ): string {
    const components = [
      "projects",
      requireSlug(repository.projectStorageKey, "projectStorageKey"),
      requireSlug(repository.repositoryStorageKey, "repositoryStorageKey"),
      "worktrees",
    ];
    let parent = assertRootDirectory(this.workspaceDir, "Git work-item Workspace");
    for (const component of components) {
      const child = join(parent, component);
      parent = assertManagedDirectory(child, parent, `Git worktree ${component} directory`);
    }
    return parent;
  }

  private async cleanupGeneratedWorktree(
    repository: GitWorkRepository,
    store: string,
    checkout: string,
    expectedParent: string,
  ): Promise<void> {
    const safeCheckout = exactManagedChildDirectory(checkout, expectedParent);
    if (!safeCheckout) return;
    try {
      await this.git(
        repository,
        ["--git-dir", store, "worktree", "remove", "--force", "--", safeCheckout],
        this.workspaceDir,
      );
      return;
    } catch {
      // Git can leave a partially-created checkout behind. The filesystem
      // fallback is allowed only after repeating the no-symlink/canonical
      // parent check; unsafe or replaced paths are deliberately preserved.
    }
    const stillSafeCheckout = exactManagedChildDirectory(checkout, expectedParent);
    if (stillSafeCheckout) rmSync(stillSafeCheckout, { recursive: true, force: true });
  }

  private async fetchDefaultBranch(
    repository: GitWorkRepository,
    store: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const trackingRef = defaultTrackingRef(repository.defaultBranch);
    await this.git(
      repository,
      [
        "--git-dir", store,
        "fetch", "--no-tags", repository.remoteUrl,
        `refs/heads/${repository.defaultBranch}:${trackingRef}`,
      ],
      this.workspaceDir,
      signal,
      true,
    );
    const result = await this.git(repository, ["--git-dir", store, "rev-parse", "--verify", trackingRef], this.workspaceDir, signal);
    return requireObjectId(result.stdout.trim());
  }

  private async assertWorktree(
    item: StoredWorkItem,
    repository: GitWorkRepository,
    signal?: AbortSignal,
  ): Promise<string> {
    const expectedPath = generatedWorkspacePath({
      projectStorageKey: item.projectStorageKey,
      repositoryStorageKey: item.repositoryStorageKey,
    }, item.id);
    if (item.workspacePath !== expectedPath || item.branch !== generatedBranchFromStoredItem(item)) {
      throw new GitWorkItemConfigurationError("Stored Git work item path or branch is invalid");
    }
    const worktreeParent = this.assertWorktreeParent(item);
    const checkout = resolve(worktreeParent, item.id);
    if (checkout !== this.resolveWorkspacePath(item.workspacePath) || dirname(checkout) !== worktreeParent) {
      throw new GitWorkItemConfigurationError("Stored Git worktree path escapes its managed repository directory");
    }
    let stats;
    let gitPointer;
    try {
      stats = lstatSync(checkout);
      gitPointer = lstatSync(join(checkout, ".git"));
    } catch {
      throw new GitWorkItemOperationError("Git worktree is missing");
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GitWorkItemOperationError("Git worktree must be a real directory");
    }
    if (!gitPointer.isFile() || gitPointer.isSymbolicLink()) {
      throw new GitWorkItemOperationError("Git worktree metadata pointer must be a regular file");
    }
    const canonicalCheckout = realpathSync(checkout);
    const canonicalWorkspace = realpathSync(this.workspaceDir);
    if (!isWithin(canonicalWorkspace, canonicalCheckout)) {
      throw new GitWorkItemOperationError("Git worktree resolves outside Workspace");
    }
    await this.repairMovedWorktree(item, repository, canonicalCheckout, signal);
    const common = await this.git(
      repository,
      ["-C", checkout, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      checkout,
      signal,
    );
    if (resolve(common.stdout.trim()) !== this.repositoryStorePath(repository.id)) {
      throw new GitWorkItemOperationError("Git worktree points at an unexpected object store");
    }
    const branch = (await this.git(repository, ["-C", checkout, "branch", "--show-current"], checkout, signal)).stdout.trim();
    if (branch !== item.branch) {
      throw new GitWorkItemOperationError("Git worktree is on an unexpected branch");
    }
    return canonicalCheckout;
  }

  private async repairMovedWorktree(
    item: StoredWorkItem,
    repository: GitWorkRepository,
    checkout: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const store = this.repositoryStorePath(repository.id);
    let storeStats;
    try {
      storeStats = lstatSync(store);
    } catch {
      throw new GitWorkItemOperationError("Git worktree object store is missing; retained work files were not modified");
    }
    if (!storeStats.isDirectory() || storeStats.isSymbolicLink()) {
      throw new GitWorkItemOperationError("Git worktree object store is unsafe; retained work files were not modified");
    }
    const pointerPath = join(checkout, ".git");
    const pointer = readFileSync(pointerPath, "utf8").trim();
    const match = /^gitdir: (\/.+\/([^/]+\.git)\/worktrees\/([A-Za-z0-9._-]+))$/u.exec(pointer);
    if (!match) {
      throw new GitWorkItemOperationError("Git worktree metadata pointer is invalid; retained work files were not modified");
    }
    const expectedStoreName = `${createHash("sha256").update(item.repositoryId).digest("hex").slice(0, 32)}.git`;
    if (match[2] !== expectedStoreName) {
      throw new GitWorkItemOperationError("Git worktree metadata points at another repository; retained work files were not modified");
    }
    const currentMetadataRoot = resolve(store, "worktrees");
    if (resolve(match[1]).startsWith(`${currentMetadataRoot}${sep}`)) return;

    // The only accepted mismatch is the same generated repository store under
    // an old absolute root. This is the normal backup/restore or state move
    // case. Git repairs both the worktree .git pointer and the common store's
    // reverse gitdir link for this one exact managed checkout.
    try {
      await this.git(
        repository,
        ["--git-dir", store, "worktree", "repair", "--", checkout],
        this.workspaceDir,
        signal,
      );
    } catch (error) {
      throw new GitWorkItemOperationError(
        `Unable to repair relocated Git worktree; retained work files were not modified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const repaired = readFileSync(pointerPath, "utf8").trim();
    if (!repaired.startsWith(`gitdir: ${currentMetadataRoot}${sep}`)) {
      throw new GitWorkItemOperationError("Relocated Git worktree repair did not restore its managed object-store link");
    }
  }

  private async changedPaths(repository: GitWorkRepository, checkout: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git(
      repository,
      ["-C", checkout, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      checkout,
      signal,
    );
    const records = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 4) throw new GitWorkItemOperationError("Git returned an invalid status record");
      const status = record.slice(0, 2);
      const path = record.slice(3);
      assertRelativeGitPath(path);
      paths.push(path);
      if (status.includes("R") || status.includes("C")) {
        const secondPath = records[index + 1];
        if (!secondPath) throw new GitWorkItemOperationError("Git returned an incomplete rename record");
        assertRelativeGitPath(secondPath);
        paths.push(secondPath);
        index += 1;
      }
    }
    return [...new Set(paths)];
  }

  private scanChangedFiles(checkout: string, paths: string[]): void {
    if (paths.length > maximumChangedFiles) {
      throw new GitWorkItemOperationError(`Commit changes too many paths (${paths.length}; maximum ${maximumChangedFiles})`);
    }
    let totalBytes = 0;
    const canonicalCheckout = realpathSync(checkout);
    for (const relativePath of paths) {
      assertRelativeGitPath(relativePath);
      if (sensitivePathPattern.test(relativePath) || forbiddenTrackedPathPattern.test(relativePath)) {
        throw new GitWorkItemOperationError(`Refusing to commit sensitive or control file: ${relativePath}`);
      }
      const candidate = resolve(checkout, relativePath);
      if (!isWithin(checkout, candidate)) {
        throw new GitWorkItemOperationError(`Changed path escapes Git worktree: ${relativePath}`);
      }
      if (!existsSync(candidate)) continue;
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new GitWorkItemOperationError(`Changed path is not a safe regular path: ${relativePath}`);
      }
      const canonical = realpathSync(candidate);
      if (!isWithin(canonicalCheckout, canonical)) {
        throw new GitWorkItemOperationError(`Changed path resolves outside Git worktree: ${relativePath}`);
      }
      if (!stats.isFile()) continue;
      totalBytes += stats.size;
      if (totalBytes > maximumChangedBytes) {
        throw new GitWorkItemOperationError(`Commit content exceeds ${maximumChangedBytes} bytes`);
      }
      if (stats.size <= 2 * 1024 * 1024) {
        const bytes = readFileSync(candidate);
        if (!bytes.includes(0)) {
          const content = bytes.toString("utf8");
          if (sensitiveContentPatterns.some((pattern) => pattern.test(content))) {
            throw new GitWorkItemOperationError(`Refusing to commit credential-like content: ${relativePath}`);
          }
        }
      }
    }
  }

  private async scanCommitRange(
    repository: GitWorkRepository,
    checkout: string,
    base: string,
    head: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const changed = await this.git(
      repository,
      ["-C", checkout, "diff", "--name-only", "-z", `${base}..${head}`, "--"],
      checkout,
      signal,
    );
    const paths = [...new Set(changed.stdout.split("\0").filter(Boolean))];
    if (paths.length > maximumChangedFiles) {
      throw new GitWorkItemOperationError(`Commit changes too many paths (${paths.length}; maximum ${maximumChangedFiles})`);
    }
    for (const path of paths) {
      assertRelativeGitPath(path);
      if (sensitivePathPattern.test(path) || forbiddenTrackedPathPattern.test(path)) {
        throw new GitWorkItemOperationError(`Refusing to publish sensitive or control file: ${path}`);
      }
    }
    if (!paths.length) return;
    const tree = await this.git(
      repository,
      ["-C", checkout, "ls-tree", "-r", "-z", head, "--", ...paths],
      checkout,
      signal,
      false,
      512 * 1024,
    );
    let totalBytes = 0;
    for (const entry of tree.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d{6})\s+(?:blob|commit)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(entry);
      if (!match) throw new GitWorkItemOperationError("Git returned an invalid tree entry");
      const [, mode, objectId, path] = match;
      assertRelativeGitPath(path);
      if (mode !== "100644" && mode !== "100755") {
        throw new GitWorkItemOperationError(`Refusing to publish non-regular Git tree entry: ${path}`);
      }
      if (sensitivePathPattern.test(path) || forbiddenTrackedPathPattern.test(path)) {
        throw new GitWorkItemOperationError(`Refusing to publish sensitive or control file: ${path}`);
      }
      const sizeResult = await this.git(
        repository,
        ["-C", checkout, "cat-file", "-s", objectId],
        checkout,
        signal,
      );
      const size = Number(sizeResult.stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new GitWorkItemOperationError(`Git returned an invalid blob size: ${path}`);
      }
      totalBytes += size;
      if (totalBytes > maximumChangedBytes) {
        throw new GitWorkItemOperationError(`Commit content exceeds ${maximumChangedBytes} bytes`);
      }
      if (size <= 2 * 1024 * 1024) {
        const blob = await this.git(
          repository,
          ["-C", checkout, "cat-file", "blob", objectId],
          checkout,
          signal,
          false,
          2 * 1024 * 1024 + 1_024,
        );
        const bytes = Buffer.from(blob.stdout, "utf8");
        if (!bytes.includes(0) && sensitiveContentPatterns.some((pattern) => pattern.test(blob.stdout))) {
          throw new GitWorkItemOperationError(`Refusing to publish credential-like content: ${path}`);
        }
      }
    }
  }

  private async remoteBranchHead(
    repository: GitWorkRepository,
    branch: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.git(
      repository,
      ["ls-remote", "--heads", repository.remoteUrl, `refs/heads/${requireBranch(branch)}`],
      cwd,
      signal,
      true,
    );
    const lines = result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return undefined;
    if (lines.length !== 1) throw new GitWorkItemOperationError("Remote returned an ambiguous work branch");
    const [objectId, ref] = lines[0].split(/\s+/u);
    if (ref !== `refs/heads/${branch}`) throw new GitWorkItemOperationError("Remote returned an unexpected work branch");
    const advertised = requireObjectId(objectId);
    await this.git(
      repository,
      ["-C", cwd, "fetch", "--no-tags", repository.remoteUrl, `refs/heads/${branch}`],
      cwd,
      signal,
      true,
    );
    const fetched = requireObjectId((await this.git(
      repository,
      ["-C", cwd, "rev-parse", "--verify", "FETCH_HEAD"],
      cwd,
      signal,
    )).stdout.trim());
    if (fetched !== advertised) {
      throw new GitWorkItemOperationError("Remote work branch changed while it was being inspected; retry publishing");
    }
    return fetched;
  }

  private async head(repository: GitWorkRepository, checkout: string, signal?: AbortSignal): Promise<string> {
    const result = await this.git(repository, ["-C", checkout, "rev-parse", "--verify", "HEAD"], checkout, signal);
    return requireObjectId(result.stdout.trim());
  }

  private repositoryStorePath(repositoryId: string): string {
    const name = createHash("sha256").update(requireOpaqueId(repositoryId, "repositoryId")).digest("hex").slice(0, 32);
    const candidate = resolve(this.repositoriesDir, `${name}.git`);
    if (!isWithin(this.repositoriesDir, candidate)) {
      throw new GitWorkItemConfigurationError("Repository object-store path escapes managed state");
    }
    return candidate;
  }

  private resolveWorkspacePath(relativePath: string): string {
    const candidate = resolve(this.workspaceDir, relativePath);
    if (!isWithin(this.workspaceDir, candidate)) {
      throw new GitWorkItemConfigurationError("Git worktree path escapes Workspace");
    }
    return candidate;
  }

  private async git(
    repository: GitWorkRepository,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    remote = false,
    maxOutputBytes = maximumOutputBytes,
  ): Promise<GitWorkCommandResult> {
    const transport = this.resolveEnvironment ? await this.resolveEnvironment(repository) : {};
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      HOME: this.gitHome,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      GCM_INTERACTIVE: "never",
      ...(transport.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: transport.GIT_SSH_COMMAND } : {}),
    };
    const hardenedArgs = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "protocol.file.allow=never",
      "-c", "protocol.ext.allow=never",
      "-c", "credential.helper=",
      "-c", "submodule.recurse=false",
      "-c", "fetch.recurseSubmodules=false",
      "-c", "push.recurseSubmodules=check",
      ...args,
    ];
    const result = await this.runner({
      command: "git",
      args: hardenedArgs,
      cwd,
      env,
      ...(signal ? { signal } : {}),
      timeoutMs: remote ? remoteOperationTimeoutMs : localOperationTimeoutMs,
      maxOutputBytes,
    });
    if (result.exitCode !== 0) {
      const detail = boundText((result.stderr || result.stdout).trim(), 4_096).text;
      throw new GitWorkItemOperationError(`git ${primaryGitCommand(args)} exited with ${result.exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  private async gitExit(
    repository: GitWorkRepository,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      await this.git(repository, args, cwd, signal);
      return true;
    } catch (error) {
      if (error instanceof GitWorkItemOperationError && /exited with 1\b/u.test(error.message)) return false;
      throw error;
    }
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    let raw: unknown;
    try {
      const stats = lstatSync(this.statePath);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new GitWorkItemConfigurationError("Git work-item state must be a regular non-symlink file");
      }
      raw = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if (error instanceof GitWorkItemConfigurationError) throw error;
      throw new GitWorkItemConfigurationError(`Unable to read Git work-item state: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(raw) || raw.version !== stateVersion || !Array.isArray(raw.items)) {
      throw new GitWorkItemConfigurationError("Git work-item state version is invalid");
    }
    for (const candidate of raw.items) {
      const item = parseStoredItem(candidate);
      if (this.items.has(item.id)) throw new GitWorkItemConfigurationError("Git work-item state contains duplicate IDs");
      this.items.set(item.id, item);
    }
  }

  private persist(): void {
    const payload: StoredState = { version: stateVersion, items: [...this.items.values()] };
    mkdirSync(dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) throw new GitWorkItemConfigurationError("Git work-item state target is invalid");
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.statePath);
    chmodSync(this.statePath, 0o600);
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new GitWorkItemConfigurationError(
      `Unable to inspect managed Git path ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function ensureRootDirectory(path: string, label: string): string {
  const requested = resolve(path);
  if (!pathEntryExists(requested)) {
    try {
      mkdirSync(requested, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new GitWorkItemConfigurationError(
        `Unable to create ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return assertRootDirectory(requested, label);
}

function assertRootDirectory(path: string, label: string): string {
  const requested = resolve(path);
  let stats;
  try {
    stats = lstatSync(requested);
  } catch (error) {
    throw new GitWorkItemConfigurationError(
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GitWorkItemConfigurationError(`${label} must be a real non-symlink directory`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch (error) {
    throw new GitWorkItemConfigurationError(
      `Unable to resolve ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonical !== requested) {
    throw new GitWorkItemConfigurationError(`${label} must not traverse a symbolic link`);
  }
  return canonical;
}

function ensureManagedDirectory(path: string, parent: string, label: string): string {
  const canonicalParent = assertRootDirectory(parent, `${label} parent`);
  const candidate = resolve(path);
  if (dirname(candidate) !== canonicalParent) {
    throw new GitWorkItemConfigurationError(`${label} escapes its managed parent`);
  }
  if (!pathEntryExists(candidate)) {
    try {
      mkdirSync(candidate, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new GitWorkItemConfigurationError(
          `Unable to create ${label}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const canonical = assertManagedDirectory(candidate, canonicalParent, label);
  chmodSync(canonical, 0o700);
  return canonical;
}

function assertManagedDirectory(path: string, parent: string, label: string): string {
  const canonicalParent = assertRootDirectory(parent, `${label} parent`);
  const candidate = resolve(path);
  if (dirname(candidate) !== canonicalParent) {
    throw new GitWorkItemConfigurationError(`${label} escapes its managed parent`);
  }
  let stats;
  try {
    stats = lstatSync(candidate);
  } catch (error) {
    throw new GitWorkItemConfigurationError(
      `${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GitWorkItemConfigurationError(`${label} must be a real non-symlink directory`);
  }
  let canonical: string;
  try {
    canonical = realpathSync(candidate);
  } catch (error) {
    throw new GitWorkItemConfigurationError(
      `Unable to resolve ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonical !== candidate || dirname(canonical) !== canonicalParent) {
    throw new GitWorkItemConfigurationError(`${label} escapes its managed parent`);
  }
  return canonical;
}

function exactManagedChildDirectory(path: string, expectedParent: string): string | undefined {
  try {
    const canonicalParent = assertRootDirectory(expectedParent, "Git worktree cleanup parent");
    const candidate = resolve(path);
    if (dirname(candidate) !== canonicalParent) return undefined;
    const stats = lstatSync(candidate);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    const canonical = realpathSync(candidate);
    if (canonical !== candidate || dirname(canonical) !== canonicalParent) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

async function spawnGitCommand(input: Parameters<GitWorkCommandRunner>[0]): Promise<GitWorkCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: GitWorkCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise(result as GitWorkCommandResult);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new GitWorkItemOperationError("Git work-item operation was cancelled"));
    };
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) {
        child.kill("SIGTERM");
        finish(new GitWorkItemOperationError("Git work-item command output exceeded its safety limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => finish(new GitWorkItemOperationError(`Unable to run git: ${error.message}`)));
    child.once("close", (code) => finish(undefined, {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode: code ?? -1,
    }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new GitWorkItemOperationError(`Git work-item command timed out after ${input.timeoutMs} ms`));
    }, input.timeoutMs);
    timer.unref?.();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
  });
}

function requireBinding(input: { workItemId: string; sessionId: string; characterId: string }) {
  return {
    workItemId: requireGeneratedWorkItemId(input.workItemId),
    sessionId: requireOpaqueId(input.sessionId, "sessionId"),
    characterId: requireOpaqueId(input.characterId, "characterId"),
  };
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !safeOpaqueId.test(value)) {
    throw new GitWorkItemConfigurationError(`${label} must be an opaque ID without path separators`);
  }
  return value;
}

function requireGeneratedWorkItemId(value: unknown): string {
  if (typeof value !== "string" || !safeGeneratedWorkItemId.test(value)) {
    throw new GitWorkItemConfigurationError("workItemId must be generated by GitWorkItemService");
  }
  return value;
}

function requireSlug(value: unknown, label: string): string {
  if (typeof value !== "string" || !safeSlug.test(value) || value === "." || value === "..") {
    throw new GitWorkItemConfigurationError(`${label} must be a safe Workspace path component`);
  }
  return value;
}

function requireBranch(value: unknown): string {
  if (
    typeof value !== "string" ||
    !safeBranch.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith(".lock") ||
    value.startsWith("-") ||
    value.includes("@{")
  ) {
    throw new GitWorkItemConfigurationError("defaultBranch is not a safe Git branch name");
  }
  return value;
}

function requireSshRemote(value: unknown): string {
  if (typeof value !== "string" || /[?#\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitWorkItemConfigurationError("Repository registry remote must be a fixed SSH URL");
  }
  const match = exactSshRemote.exec(value);
  if (!match) throw new GitWorkItemConfigurationError("Repository registry remote must be ssh://user@host/path.git");
  const port = match[3] ? Number(match[3]) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new GitWorkItemConfigurationError("Repository registry SSH port is invalid");
  }
  const path = match[4];
  if (
    !path.endsWith(".git") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")
  ) {
    throw new GitWorkItemConfigurationError("Repository registry remote path must be normalized and end in .git");
  }
  return value;
}

function requireCommitMessage(value: unknown): string {
  if (typeof value !== "string") throw new GitWorkItemOperationError("Commit message must be a string");
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximumCommitMessageCharacters ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    throw new GitWorkItemOperationError(`Commit message must contain 1-${maximumCommitMessageCharacters} printable characters`);
  }
  return normalized;
}

function requireObjectId(value: unknown): string {
  if (typeof value !== "string" || !objectIdPattern.test(value)) {
    throw new GitWorkItemOperationError("Git returned an invalid object ID");
  }
  return value;
}

function generatedBranch(characterId: string, workItemId: string): string {
  return `yourchar/${identitySlug(characterId).slice(0, 12)}/${workItemId.slice("work-".length)}`;
}

function generatedBranchFromStoredItem(item: StoredWorkItem): string {
  return generatedBranch(item.branchOwnerCharacterId, item.id);
}

function generatedWorkspacePath(
  repository: Pick<GitWorkRepository, "projectStorageKey" | "repositoryStorageKey">,
  workItemId: string,
): string {
  return join(
    "projects",
    requireSlug(repository.projectStorageKey, "projectStorageKey"),
    requireSlug(repository.repositoryStorageKey, "repositoryStorageKey"),
    "worktrees",
    requireGeneratedWorkItemId(workItemId),
  );
}

function defaultTrackingRef(branch: string): string {
  return `refs/remotes/yourchar/${requireBranch(branch)}`;
}

function repositoryFingerprint(repository: GitWorkRepository): string {
  return createHash("sha256")
    .update(JSON.stringify({
      id: repository.id,
      projectId: repository.projectId,
      projectStorageKey: repository.projectStorageKey,
      repositoryStorageKey: repository.repositoryStorageKey,
      remoteUrl: repository.remoteUrl,
      defaultBranch: repository.defaultBranch,
    }))
    .digest("hex");
}

function publicItem(item: StoredWorkItem): GitWorkItem {
  const {
    repositoryFingerprint: _repositoryFingerprint,
    branchOwnerCharacterId: _branchOwnerCharacterId,
    approvedCommits: _approvedCommits,
    ...result
  } = item;
  return { ...result };
}

function parseStoredItem(value: unknown): StoredWorkItem {
  if (!isRecord(value)) throw new GitWorkItemConfigurationError("Git work-item state entry is invalid");
  const state = value.state;
  if (state !== "active" && state !== "closed") throw new GitWorkItemConfigurationError("Git work-item state is invalid");
  const item: StoredWorkItem = {
    id: requireGeneratedWorkItemId(value.id),
    repositoryId: requireOpaqueId(value.repositoryId, "repositoryId"),
    projectId: requireOpaqueId(value.projectId, "projectId"),
    projectStorageKey: requireSlug(value.projectStorageKey, "projectStorageKey"),
    repositoryStorageKey: requireSlug(value.repositoryStorageKey, "repositoryStorageKey"),
    repositoryFingerprint: requireFingerprint(value.repositoryFingerprint),
    ownerSessionId: requireOpaqueId(value.ownerSessionId, "ownerSessionId"),
    ownerCharacterId: requireOpaqueId(value.ownerCharacterId, "ownerCharacterId"),
    branchOwnerCharacterId: requireOpaqueId(value.branchOwnerCharacterId, "branchOwnerCharacterId"),
    branch: requireBranch(value.branch),
    defaultBranch: requireBranch(value.defaultBranch),
    workspacePath: requireStoredWorkspacePath(value.workspacePath),
    baseOid: requireObjectId(value.baseOid),
    headOid: requireObjectId(value.headOid),
    ...(value.pushedHeadOid ? { pushedHeadOid: requireObjectId(value.pushedHeadOid) } : {}),
    ...(value.remoteBranch ? { remoteBranch: requireBranch(value.remoteBranch) } : {}),
    state,
    handoffCount: requireNonNegativeInteger(value.handoffCount, "handoffCount"),
    approvedCommits: requireApprovedCommits(value.approvedCommits),
    createdAt: requireDate(value.createdAt, "createdAt"),
    updatedAt: requireDate(value.updatedAt, "updatedAt"),
    ...(value.closedAt ? { closedAt: requireDate(value.closedAt, "closedAt") } : {}),
  };
  const expectedPath = generatedWorkspacePath(item, item.id);
  if (item.workspacePath !== expectedPath) {
    throw new GitWorkItemConfigurationError("Stored Git work-item Workspace path is invalid");
  }
  if (item.branch !== generatedBranch(item.branchOwnerCharacterId, item.id)) {
    throw new GitWorkItemConfigurationError("Stored Git work-item branch is invalid");
  }
  return item;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new GitWorkItemConfigurationError("Git work-item repository fingerprint is invalid");
  }
  return value;
}

function requireApprovedCommits(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || !objectIdPattern.test(entry))) {
    throw new GitWorkItemConfigurationError("Git work-item approved commit ledger is invalid");
  }
  return [...new Set(value as string[])];
}

function requireStoredWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/") || value.split(/[\\/]/u).some((part) => !part || part === "." || part === "..")) {
    throw new GitWorkItemConfigurationError("Stored Git work-item Workspace path is unsafe");
  }
  return value;
}

function requireDate(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(new Date(value).getTime())) {
    throw new GitWorkItemConfigurationError(`${label} is not a valid timestamp`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new GitWorkItemConfigurationError(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function assertRelativeGitPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new GitWorkItemOperationError(`Unsafe changed path: ${path}`);
  }
}

function sanitizeAuthorName(value: string): string {
  const normalized = String(value).replace(/[\r\n<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80);
  return normalized || "Character";
}

function identitySlug(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function isWithin(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function boundText(value: string, maximumBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maximumBytes) return { text: value, truncated: false };
  return { text: `${buffer.subarray(0, maximumBytes).toString("utf8")}\n...[truncated]`, truncated: true };
}

function primaryGitCommand(args: string[]): string {
  const command = args.find((entry) => !entry.startsWith("-") && entry !== "--");
  return command ?? "command";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
