import { spawn } from "node:child_process";
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
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import type {
  GitCommandResult,
  GitCommitResult,
  GitIdentity,
  GitIdentityCreateInput,
  GitIdentityPatch,
  GitProject,
  GitProjectCreateInput,
  GitProjectPatch,
  GitProjectRepositoryBinding,
  GitProjectRepositoryBindingCreateInput,
  GitProjectRepositoryBindingPatch,
  GitProxyMode,
  GitPushResult,
  GitRegistryV2,
  GitRepository,
  GitRepositoryConfig,
  GitRepositoryConfigPatch,
  GitRepositoryCreateInput,
  GitRepositoryPatch,
  GitRepositoryStatus,
  GitRepositorySyncResult,
} from "./types.js";
import { GitRegistryError, GitRegistryService } from "./registry.js";
import {
  assertGitExternalPrivateKey,
  discardManagedGitIdentityKey,
  generateManagedGitIdentityKey,
  gitIdentityPublicKey,
  GitIdentityKeyError,
  resolveGitIdentityPrivateKey,
} from "./identity-key.js";
import {
  GitWorkItemService,
  type GitWorkRepository,
  type GitWorkItem,
} from "./work-items.js";

type StoredGitRepositoryConfig = Omit<GitRepositoryConfig, "configured">;
type ApprovedCommitLedger = {
  version: 1;
  repositoryName: string;
  branch: string;
  commits: string[];
};
type GitRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}) => Promise<GitCommandResult>;

export type GitRepositoryServiceOptions = {
  stateDir?: string;
  workspaceDir: string;
  clock?: Clock;
  runner?: GitRunner;
  sshCommandOverride?: string;
};

const defaultConfig: StoredGitRepositoryConfig = {
  repositoryName: "Review",
  remoteUrl: "",
  branch: "main",
  privateKeyPath: "",
  proxyMode: "direct",
  proxyPort: 61090,
};
const configVersion = "yourchar-git-v1";
const maximumOutputBytes = 128 * 1024;
const maximumDiffBytes = 64 * 1024;
const maximumChangedFiles = 1_000;
const maximumChangedBytes = 64 * 1024 * 1024;
const maximumCommitMessageCharacters = 500;
const operationTimeoutMs = 120_000;
const remoteOperationTimeoutMs = 180_000;
const safeRepositoryName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const safeBranchName = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const exactSshRemote = /^ssh:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/(.+)$/u;
const sensitivePathPattern = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|kdbx)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/iu;
const forbiddenTrackedPathPattern = /(?:^|\/)(?:\.gitmodules|\.lfsconfig)$/iu;
const sensitiveContentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|tvly-[A-Za-z0-9_-]{16,})\b/u,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/-]{12,}/iu,
];

export class GitRepositoryConfigurationError extends Error {
  readonly code = "GIT_REPOSITORY_CONFIGURATION_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "GitRepositoryConfigurationError";
  }
}

export class GitRepositoryOperationError extends Error {
  readonly code = "GIT_REPOSITORY_OPERATION_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "GitRepositoryOperationError";
  }
}

export class GitRepositoryService {
  private readonly stateDir?: string;
  private readonly workspaceDir: string;
  private readonly configPath?: string;
  private readonly gitHome?: string;
  private readonly knownHostsPath?: string;
  private readonly approvedCommitsPath?: string;
  private readonly clock: Clock;
  private readonly runner: GitRunner;
  private readonly sshCommandOverride?: string;
  private readonly registry?: GitRegistryService;
  readonly workItems?: GitWorkItemService;
  private config: StoredGitRepositoryConfig;
  private checkoutRelativePath: string;
  private operationTail: Promise<unknown> = Promise.resolve();
  private pendingOperations = 0;

  constructor(options: GitRepositoryServiceOptions) {
    this.stateDir = options.stateDir ? resolve(options.stateDir) : undefined;
    this.workspaceDir = resolve(options.workspaceDir);
    this.configPath = this.stateDir ? join(this.stateDir, "git-repository.json") : undefined;
    this.gitHome = this.stateDir ? join(this.stateDir, "git-runtime") : undefined;
    this.knownHostsPath = this.gitHome ? join(this.gitHome, "known_hosts") : undefined;
    this.approvedCommitsPath = this.gitHome ? join(this.gitHome, "approved-commits.json") : undefined;
    this.clock = options.clock ?? new SystemClock();
    this.runner = options.runner ?? spawnGitCommand;
    this.sshCommandOverride = options.sshCommandOverride;
    mkdirSync(this.workspaceDir, { recursive: true, mode: 0o700 });
    this.registry = this.stateDir ? new GitRegistryService({ stateDir: this.stateDir, clock: this.clock }) : undefined;
    this.config = this.registry ? this.runtimeDefaultConfig() : this.load();
    this.checkoutRelativePath = this.registry?.getDefaults().repository?.checkoutRelativePath ??
      `repos/${this.config.repositoryName}`;
    this.workItems = this.stateDir && this.registry ? new GitWorkItemService({
      stateDir: this.stateDir,
      workspaceDir: this.workspaceDir,
      clock: this.clock,
      runner: this.runner,
      resolveRepository: (repositoryId, projectId) => this.resolveWorkRepository(repositoryId, projectId),
      resolveEnvironment: (repository) => this.workRepositoryEnvironment(repository),
    }) : undefined;
  }

  getConfig(): GitRepositoryConfig {
    if (this.registry) return { ...this.registry.getLegacyConfig(), configured: this.isConfigured() };
    return { ...this.config, configured: this.isConfigured() };
  }

  patchConfig(patch: GitRepositoryConfigPatch): GitRepositoryConfig {
    this.assertConfigurationMutable();
    if (this.registry) {
      const defaultRepository = this.registry.getDefaults().repository;
      if (defaultRepository) this.assertRepositoryConfigurationMutable(defaultRepository.id);
      if (patch.privateKeyPath?.trim()) requireExternalIdentityKey(patch.privateKeyPath.trim());
      try {
        this.registry.patchLegacyConfig(patch);
      } catch (error) {
        if (error instanceof GitRegistryError) throw new GitRepositoryConfigurationError(error.message);
        throw error;
      }
      this.refreshRuntimeDefaultConfig();
      return this.getConfig();
    }
    const next = { ...this.config };
    if (patch.repositoryName !== undefined) next.repositoryName = requireRepositoryName(patch.repositoryName);
    if (patch.remoteUrl !== undefined) next.remoteUrl = normalizeRemoteUrl(patch.remoteUrl);
    if (patch.branch !== undefined) next.branch = requireBranchName(patch.branch);
    if (patch.privateKeyPath !== undefined) next.privateKeyPath = normalizePrivateKeyPath(patch.privateKeyPath);
    if (patch.proxyMode !== undefined) next.proxyMode = requireProxyMode(patch.proxyMode);
    if (patch.proxyPort !== undefined) next.proxyPort = requireProxyPort(patch.proxyPort);
    if (next.remoteUrl) parseRemote(next.remoteUrl);
    if (next.privateKeyPath) assertPrivateKey(next.privateKeyPath);
    next.updatedAt = this.clock.now().toISOString();
    this.config = next;
    this.persist();
    return this.getConfig();
  }

  isConfigured(): boolean {
    if (this.registry) {
      try {
        const { repository, identity } = this.registry.resolveRepository();
        if (!repository.remoteUrl || identity.credential.kind === "unconfigured") return false;
        resolveGitIdentityPrivateKey(this.stateDir, identity);
        return true;
      } catch {
        return false;
      }
    }
    return Boolean(this.config.remoteUrl && this.config.privateKeyPath);
  }

  contextStatus(moduleEnabled: boolean, projectId?: string): string {
    if (!moduleEnabled) {
      return "Capability status: Git Repository MCP is disabled. Do not claim to inspect, commit, or push a repository.";
    }
    if (this.registry) {
      try {
        const context = this.projectContext(projectId);
        const configured = context.repositories.filter((repository) => {
          try {
            const resolved = this.registry!.resolveRepository(repository.id);
            return Boolean(repository.remoteUrl) &&
              resolved.identity.credential.kind !== "unconfigured" &&
              Boolean(resolveGitIdentityPrivateKey(this.stateDir, resolved.identity));
          } catch {
            return false;
          }
        });
        if (!configured.length) {
          return `Capability status: Git Projects MCP is enabled for the selected project ${context.project.name}, but it has no usable repository and SSH identity. Do not claim to use Git remotely.`;
        }
        return `Capability status: Git Projects MCP is enabled for the selected project ${context.project.name} with ${configured.length} usable repository/repositories. Work that changes files must use a task-isolated Worktree owned by this conversation and character. Never request a remote URL, refspec, checkout path, or credential from the user.`;
      } catch {
        return "Capability status: Git Projects MCP is enabled, but this conversation has no valid selected project. Do not claim to inspect, commit, or push a repository until the project selection is repaired in Settings.";
      }
    }
    if (!this.isConfigured()) {
      return "Capability status: Git Repository MCP is enabled but its fixed repository or SSH key is not configured. Do not claim to use Git remotely.";
    }
    return `Capability status: Git Repository MCP is enabled for the configured ${this.config.repositoryName} checkout. It may clone/sync, inspect, commit, and non-force push only that configured repository. Never request a remote URL or credential from the user.`;
  }

  getRegistrySnapshot(): GitRegistryV2 {
    if (!this.registry) {
      throw new GitRepositoryConfigurationError("Persistent state is required for Git projects");
    }
    return this.registry.snapshot();
  }

  createIdentity(input: GitIdentityCreateInput, expectedRevision?: number): GitIdentity {
    if (input.credential?.kind === "managed-ed25519") {
      throw new GitRepositoryConfigurationError("Managed Git keys can only be created through host key generation");
    }
    if (input.credential?.kind === "external-file") {
      requireExternalIdentityKey(input.credential.privateKeyPath);
    }
    const registry = this.mutableRegistry(expectedRevision);
    const result = registry.createIdentity(input);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  updateIdentity(identityId: string, patch: GitIdentityPatch, expectedRevision?: number): GitIdentity {
    this.assertIdentityConfigurationMutable(identityId);
    const registry = this.mutableRegistry(expectedRevision);
    if (patch.credential?.kind === "managed-ed25519") {
      throw new GitRepositoryConfigurationError("Managed Git keys can only be selected through host key generation");
    }
    if (patch.credential?.kind === "external-file") {
      requireExternalIdentityKey(patch.credential.privateKeyPath);
    }
    const result = registry.updateIdentity(identityId, patch);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  deleteIdentity(identityId: string, expectedRevision?: number): GitIdentity {
    this.assertIdentityConfigurationMutable(identityId);
    const result = this.mutableRegistry(expectedRevision).deleteIdentity(identityId);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  async generateIdentityKey(
    identityId: string,
    expectedRevision?: number,
    beforePublish?: () => void,
  ) {
    this.assertConfigurationMutable();
    this.assertIdentityConfigurationMutable(identityId);
    if (!this.registry) throw new GitRepositoryConfigurationError("Persistent state is required for Git identities");
    this.assertRegistryRevision(expectedRevision);
    return this.serial(async () => {
      const identity = this.registry!.snapshot().identities.find((entry) => entry.id === identityId);
      if (!identity) throw new GitRegistryError(`Git identity not found: ${identityId}`, "GIT_REGISTRY_NOT_FOUND");
      const generated = await generateManagedGitIdentityKey({ stateDir: this.stateDir, identity });
      try {
        beforePublish?.();
        this.assertRegistryRevision(expectedRevision);
        const updated = this.registry!.setIdentityCredential(
          identity.id,
          { kind: "managed-ed25519", keyRef: generated.keyRef },
          generated.fingerprint,
        );
        this.refreshRuntimeDefaultConfig();
        return { identity: updated, publicKey: generated.publicKey, fingerprint: generated.fingerprint };
      } catch (error) {
        try {
          discardManagedGitIdentityKey({
            stateDir: this.stateDir,
            identity,
            keyRef: generated.keyRef,
          });
        } catch (cleanupError) {
          throw new GitIdentityKeyError(
            `Git identity registry update failed and generated-key cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        throw error;
      }
    });
  }

  getIdentityPublicKey(identityId: string): { identityId: string; publicKey?: string; fingerprint?: string } {
    if (!this.registry) throw new GitRepositoryConfigurationError("Persistent state is required for Git identities");
    const identity = this.registry.snapshot().identities.find((entry) => entry.id === identityId);
    if (!identity) throw new GitRegistryError(`Git identity not found: ${identityId}`, "GIT_REGISTRY_NOT_FOUND");
    const publicKey = gitIdentityPublicKey(this.stateDir, identity);
    return {
      identityId,
      ...(publicKey ? { publicKey } : {}),
      ...(identity.fingerprint ? { fingerprint: identity.fingerprint } : {}),
    };
  }

  createProject(input: GitProjectCreateInput, expectedRevision?: number): GitProject {
    return this.mutableRegistry(expectedRevision).createProject(input);
  }

  updateProject(projectId: string, patch: GitProjectPatch, expectedRevision?: number): GitProject {
    this.assertProjectConfigurationMutable(projectId);
    const result = this.mutableRegistry(expectedRevision).updateProject(projectId, patch);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  deleteProject(projectId: string, expectedRevision?: number): GitProject {
    this.assertProjectConfigurationMutable(projectId);
    const result = this.mutableRegistry(expectedRevision).deleteProject(projectId);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  createRepository(input: GitRepositoryCreateInput, expectedRevision?: number): GitRepository {
    return this.mutableRegistry(expectedRevision).createRepository(input);
  }

  updateRepository(repositoryId: string, patch: GitRepositoryPatch, expectedRevision?: number): GitRepository {
    this.assertRepositoryConfigurationMutable(repositoryId);
    const result = this.mutableRegistry(expectedRevision).updateRepository(repositoryId, patch);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  deleteRepository(repositoryId: string, expectedRevision?: number): GitRepository {
    this.assertRepositoryConfigurationMutable(repositoryId);
    const result = this.mutableRegistry(expectedRevision).deleteRepository(repositoryId);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  createProjectRepositoryBinding(
    input: GitProjectRepositoryBindingCreateInput,
    expectedRevision?: number,
  ): GitProjectRepositoryBinding {
    const result = this.mutableRegistry(expectedRevision).createBinding(input);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  updateProjectRepositoryBinding(
    bindingId: string,
    patch: GitProjectRepositoryBindingPatch,
    expectedRevision?: number,
  ): GitProjectRepositoryBinding {
    const result = this.mutableRegistry(expectedRevision).updateBinding(bindingId, patch);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  deleteProjectRepositoryBinding(bindingId: string, expectedRevision?: number): GitProjectRepositoryBinding {
    this.assertBindingConfigurationMutable(bindingId);
    const result = this.mutableRegistry(expectedRevision).deleteBinding(bindingId);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  setRegistryDefaults(
    input: { identityId?: string; projectId?: string; repositoryId?: string },
    expectedRevision?: number,
  ) {
    const result = this.mutableRegistry(expectedRevision).setDefaults(input);
    this.refreshRuntimeDefaultConfig();
    return result;
  }

  projectContext(projectId?: string): {
    revision: number;
    project: GitProject;
    bindings: GitProjectRepositoryBinding[];
    repositories: GitRepository[];
  } {
    if (!this.registry) throw new GitRepositoryConfigurationError("Persistent state is required for Git projects");
    const snapshot = this.registry.snapshot();
    const selectedId = projectId ?? snapshot.defaults.projectId;
    if (!selectedId) throw new GitRegistryError("No default Git project is configured", "GIT_REGISTRY_NOT_FOUND");
    const project = snapshot.projects.find((entry) => entry.id === selectedId);
    if (!project || project.archivedAt) {
      throw new GitRegistryError(`Git project not found or archived: ${selectedId}`, "GIT_REGISTRY_NOT_FOUND");
    }
    const bindings = snapshot.projectRepositories.filter((entry) => entry.projectId === project.id);
    const repositoryIds = new Set(bindings.map((entry) => entry.repositoryId));
    const repositories = snapshot.repositories.filter((entry) => repositoryIds.has(entry.id) && !entry.archivedAt);
    return { revision: snapshot.revision, project, bindings, repositories };
  }

  projectIsConfigured(projectId?: string): boolean {
    try {
      const context = this.projectContext(projectId);
      return context.repositories.some((repository) => {
        try {
          const resolved = this.registry!.resolveRepository(repository.id);
          return Boolean(repository.remoteUrl) &&
            resolved.identity.credential.kind !== "unconfigured" &&
            Boolean(resolveGitIdentityPrivateKey(this.stateDir, resolved.identity));
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  resolveProjectRepository(projectId: string, repositoryId?: string): {
    project: GitProject;
    binding: GitProjectRepositoryBinding;
    repository: GitRepository;
    identity: GitIdentity;
  } {
    const context = this.projectContext(projectId);
    const candidateBindings = context.bindings.filter((binding) =>
      context.repositories.some((repository) => repository.id === binding.repositoryId)
    );
    const binding = repositoryId
      ? candidateBindings.find((entry) => entry.repositoryId === repositoryId)
      : candidateBindings.find((entry) => entry.isDefault) ??
        (candidateBindings.length === 1 ? candidateBindings[0] : undefined);
    if (!binding) {
      throw new GitRegistryError(
        repositoryId
          ? "The selected repository is not part of the current Git project"
          : "The Git project has no unambiguous default repository",
        repositoryId ? "GIT_REGISTRY_NOT_FOUND" : "GIT_REGISTRY_CONFLICT",
      );
    }
    const resolved = this.registry!.resolveRepository(binding.repositoryId);
    if (!resolved.projects.some((entry) => entry.id === context.project.id)) {
      throw new GitRegistryError("Git project/repository binding is invalid");
    }
    if (!resolved.repository.remoteUrl || resolved.identity.credential.kind === "unconfigured") {
      throw new GitRepositoryConfigurationError("The selected Git repository or SSH identity is not configured");
    }
    resolveGitIdentityPrivateKey(this.stateDir, resolved.identity);
    return { project: context.project, binding, repository: resolved.repository, identity: resolved.identity };
  }

  async openWork(input: {
    projectId: string;
    repositoryId?: string;
    sessionId: string;
    characterId: string;
    signal?: AbortSignal;
  }): Promise<GitWorkItem> {
    const service = this.requireWorkItems();
    const target = this.resolveProjectRepository(input.projectId, input.repositoryId);
    const existing = service.findActiveForOwner({
      sessionId: input.sessionId,
      characterId: input.characterId,
      repositoryId: target.repository.id,
    });
    if (existing?.projectId === target.project.id) return existing;
    return service.openWorkItem({
      projectId: target.project.id,
      repositoryId: target.repository.id,
      sessionId: input.sessionId,
      characterId: input.characterId,
      signal: input.signal,
    });
  }

  listWork(input: { sessionId: string; characterId: string; includeClosed?: boolean }): GitWorkItem[] {
    return this.requireWorkItems().listWorkItems(input);
  }

  resolveOwnedWorkItem(input: {
    projectId: string;
    sessionId: string;
    characterId: string;
    workItemId?: string;
    repositoryId?: string;
  }): GitWorkItem {
    const service = this.requireWorkItems();
    const items = service.listWorkItems({ sessionId: input.sessionId, characterId: input.characterId })
      .filter((entry) =>
        entry.projectId === input.projectId &&
        (!input.repositoryId || entry.repositoryId === input.repositoryId)
      );
    if (input.workItemId) {
      const selected = items.find((entry) => entry.id === input.workItemId);
      if (!selected) throw new GitRepositoryOperationError("The requested Git work item is not active for this session and character");
      return selected;
    }
    if (items.length !== 1) {
      throw new GitRepositoryOperationError(
        items.length ? "Multiple Git work items are active; provide workItemId" : "No Git work item is active; run git_clone_or_sync first",
      );
    }
    return items[0];
  }

  assertConversationDeletable(sessionId: string): void {
    try {
      this.workItems?.assertNoActiveItemsForSession(sessionId);
    } catch (error) {
      throw new GitRepositoryOperationError(error instanceof Error ? error.message : String(error));
    }
  }

  private requireWorkItems(): GitWorkItemService {
    if (!this.workItems) throw new GitRepositoryConfigurationError("Persistent state is required for Git work items");
    return this.workItems;
  }

  testConnection(signal?: AbortSignal): Promise<{ ok: true; repositoryName: string; branch: string; head: string; remoteHost: string }> {
    if (this.registry) {
      const repositoryId = this.registry.getDefaults().repository?.id;
      if (!repositoryId) {
        return Promise.reject(new GitRepositoryConfigurationError("Configure a Git repository before testing the connection"));
      }
      return this.testRepositoryConnection(repositoryId, signal);
    }
    return this.serial(async () => {
      this.assertConfigured();
      const remote = parseRemote(this.config.remoteUrl);
      const result = await this.git(
        ["ls-remote", "--exit-code", this.config.remoteUrl, `refs/heads/${this.config.branch}`],
        this.workspaceDir,
        signal,
        { remote: true, trustOnFirstUse: true },
      );
      const head = requireObjectId(result.stdout.split(/\r?\n/u)[0]?.split(/\s+/u)[0]);
      return {
        ok: true,
        repositoryName: this.config.repositoryName,
        branch: this.config.branch,
        head,
        remoteHost: remote.host,
      };
    });
  }

  testRepositoryConnection(
    repositoryId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; repositoryId: string; repositoryName: string; branch: string; head: string; remoteHost: string }> {
    if (!this.registry) {
      throw new GitRepositoryConfigurationError("Persistent state is required for registered Git repositories");
    }
    const snapshot = this.registry.resolveRepository(repositoryId);
    const repository = structuredClone(snapshot.repository);
    const identity = structuredClone(snapshot.identity);
    return this.serial(async () => {
      if (repository.archivedAt) throw new GitRepositoryConfigurationError("Archived Git repositories cannot be tested");
      if (!repository.remoteUrl) throw new GitRepositoryConfigurationError("Configure the repository SSH URL before testing");
      const remote = parseRemote(repository.remoteUrl);
      const result = await this.gitRegistered(
        repository,
        identity,
        ["ls-remote", "--exit-code", repository.remoteUrl, `refs/heads/${repository.defaultBranch}`],
        this.workspaceDir,
        signal,
        { remote: true, trustOnFirstUse: true },
      );
      const head = requireObjectId(result.stdout.split(/\r?\n/u)[0]?.split(/\s+/u)[0]);
      return {
        ok: true,
        repositoryId: repository.id,
        repositoryName: repository.name,
        branch: repository.defaultBranch,
        head,
        remoteHost: remote.host,
      };
    });
  }

  cloneOrSync(signal?: AbortSignal): Promise<GitRepositorySyncResult> {
    return this.serial(async () => {
      this.assertConfigured();
      const target = this.repositoryPath();
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      if (!existsSync(target)) return this.cloneFresh(target, signal);
      this.assertRepository(target);
      await this.assertSafeLocalConfiguration(target, signal);
      const before = await this.head(target, signal);
      const status = await this.statusUnlocked(target, signal);
      if (!status.clean) {
        throw new GitRepositoryOperationError("Repository has local changes; commit or discard them before syncing");
      }
      await this.git(
        ["fetch", "--no-tags", this.config.remoteUrl, `+refs/heads/${this.config.branch}:refs/remotes/yourchar/${this.config.branch}`],
        target,
        signal,
        { remote: true },
      );
      const remoteHead = await this.revParse(target, `refs/remotes/yourchar/${this.config.branch}`, signal);
      const ancestor = await this.gitExit(
        ["merge-base", "--is-ancestor", before, remoteHead],
        target,
        signal,
      );
      if (!ancestor) {
        throw new GitRepositoryOperationError("Remote history diverged from the shared checkout; manual reconciliation is required");
      }
      if (before !== remoteHead) {
        await this.git(["merge", "--ff-only", remoteHead], target, signal);
      }
      const after = await this.statusUnlocked(target, signal);
      return { ...after, cloned: false, changed: before !== after.head };
    });
  }

  status(signal?: AbortSignal): Promise<GitRepositoryStatus> {
    return this.serial(async () => {
      const target = this.readyRepository();
      return this.statusUnlocked(target, signal);
    });
  }

  diff(input: { staged?: boolean } = {}, signal?: AbortSignal): Promise<{ repositoryName: string; diff: string; truncated: boolean }> {
    return this.serial(async () => {
      const target = this.readyRepository();
      const result = await this.git(
        ["diff", "--no-ext-diff", "--no-textconv", ...(input.staged ? ["--cached"] : []), "--"],
        target,
        signal,
      );
      const bounded = boundText(result.stdout, maximumDiffBytes);
      return { repositoryName: this.config.repositoryName, diff: bounded.text, truncated: bounded.truncated };
    });
  }

  log(limit = 10, signal?: AbortSignal): Promise<{ repositoryName: string; log: string }> {
    return this.serial(async () => {
      const target = this.readyRepository();
      const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 10;
      const result = await this.git(
        ["log", `-${boundedLimit}`, "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%an%x09%s"],
        target,
        signal,
      );
      return { repositoryName: this.config.repositoryName, log: boundText(result.stdout, maximumDiffBytes).text };
    });
  }

  commit(
    input: { message: string; characterId: string; characterName: string },
    signal?: AbortSignal,
  ): Promise<GitCommitResult> {
    return this.serial(async () => {
      const target = this.readyRepository();
      const message = requireCommitMessage(input.message);
      const staged = await this.git(["diff", "--cached", "--name-only", "--"], target, signal);
      if (staged.stdout.trim()) {
        throw new GitRepositoryOperationError("The shared checkout already has staged changes; resolve them before an Agent commit");
      }
      const paths = await this.changedPaths(target, signal);
      if (!paths.length) throw new GitRepositoryOperationError("Repository has no changes to commit");
      this.scanChangedFiles(target, paths);
      await this.git(["add", "-A", "--"], target, signal);
      try {
        const authorName = `${sanitizeAuthorName(input.characterName)} via YourChar`;
        const authorEmail = `${slugIdentity(input.characterId)}@yourchar.local`;
        await this.git(
          [
            "-c", `user.name=${authorName}`,
            "-c", `user.email=${authorEmail}`,
            "-c", "commit.gpgSign=false",
            "commit", "--no-gpg-sign", "--no-verify", "-m", message,
          ],
          target,
          signal,
        );
      } catch (error) {
        await this.git(["reset", "--mixed", "HEAD", "--"], target, undefined).catch(() => undefined);
        throw error;
      }
      const commit = await this.head(target, signal);
      try {
        const parent = await this.revParse(target, `${commit}^`, signal);
        await this.scanCommitRange(target, parent, commit, signal);
        this.approveCommit(commit);
      } catch (error) {
        await this.git(["reset", "--mixed", "HEAD^", "--"], target, undefined).catch(() => undefined);
        throw error;
      }
      return {
        repositoryName: this.config.repositoryName,
        branch: this.config.branch,
        commit,
        summary: `${paths.length} changed path(s) committed by ${sanitizeAuthorName(input.characterName)}`,
      };
    });
  }

  push(signal?: AbortSignal): Promise<GitPushResult> {
    return this.serial(async () => {
      const target = this.readyRepository();
      const status = await this.statusUnlocked(target, signal);
      if (!status.clean) throw new GitRepositoryOperationError("Commit all local changes before pushing");
      const head = status.head ?? await this.head(target, signal);
      await this.git(
        ["fetch", "--no-tags", this.config.remoteUrl, `+refs/heads/${this.config.branch}:refs/remotes/yourchar/${this.config.branch}`],
        target,
        signal,
        { remote: true },
      );
      const remoteHead = await this.revParse(target, `refs/remotes/yourchar/${this.config.branch}`, signal);
      if (!await this.gitExit(["merge-base", "--is-ancestor", remoteHead, head], target, signal)) {
        throw new GitRepositoryOperationError("The configured remote branch is not an ancestor of local HEAD; force push is not allowed");
      }
      const pending = (await this.git(["rev-list", "--reverse", `${remoteHead}..${head}`], target, signal))
        .stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).map(requireObjectId);
      if (pending.length > 100) throw new GitRepositoryOperationError("Too many local commits are pending push");
      const approved = new Set(this.loadApprovedCommits().commits);
      const unapproved = pending.find((commit) => !approved.has(commit));
      if (unapproved) {
        throw new GitRepositoryOperationError(`Refusing to push unapproved local commit ${unapproved.slice(0, 12)}; commits must be created through git_commit`);
      }
      if (pending.length) await this.scanCommitRange(target, remoteHead, head, signal);
      await this.git(
        ["push", "--porcelain", this.config.remoteUrl, `${head}:refs/heads/${this.config.branch}`],
        target,
        signal,
        { remote: true },
      );
      if (pending.length) this.removeApprovedCommits(pending);
      return {
        repositoryName: this.config.repositoryName,
        branch: this.config.branch,
        commit: head,
        summary: `Pushed ${head.slice(0, 12)} to ${this.config.branch}`,
      };
    });
  }

  private async cloneFresh(target: string, signal?: AbortSignal): Promise<GitRepositorySyncResult> {
    const staging = join(dirname(target), `.git-stage-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      await this.git(
        [
          "clone", "--single-branch", "--no-tags", "--branch", this.config.branch,
          "--origin", "yourchar", "--", this.config.remoteUrl, staging,
        ],
        dirname(target),
        signal,
        { remote: true },
      );
      chmodSync(staging, 0o700);
      this.assertRepository(staging);
      await this.assertSafeLocalConfiguration(staging, signal);
      renameSync(staging, target);
      const status = await this.statusUnlocked(target, signal);
      return { ...status, cloned: true, changed: true };
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private async statusUnlocked(target: string, signal?: AbortSignal): Promise<GitRepositoryStatus> {
    this.assertRepository(target);
    await this.assertSafeLocalConfiguration(target, signal);
    const branch = (await this.git(["branch", "--show-current"], target, signal)).stdout.trim();
    if (branch !== this.config.branch) {
      throw new GitRepositoryOperationError(`Shared checkout must remain on configured branch ${this.config.branch}`);
    }
    const head = await this.head(target, signal);
    const result = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], target, signal);
    return {
      repositoryName: this.config.repositoryName,
      workspacePath: this.checkoutRelativePath,
      branch,
      head,
      clean: !result.stdout.trim(),
      summary: boundText(result.stdout || "clean", maximumDiffBytes).text,
    };
  }

  private async changedPaths(target: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], target, signal);
    const records = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 4) throw new GitRepositoryOperationError("Git returned an invalid status record");
      const status = record.slice(0, 2);
      const path = record.slice(3);
      paths.push(path);
      if (status[0] === "R" || status[0] === "C") {
        const renamedPath = records[++index];
        if (!renamedPath) throw new GitRepositoryOperationError("Git returned an incomplete rename record");
        paths.push(renamedPath);
      }
    }
    return [...new Set(paths)];
  }

  private scanChangedFiles(target: string, paths: string[]): void {
    if (paths.length > maximumChangedFiles) {
      throw new GitRepositoryOperationError(`Commit changes too many paths (${paths.length}; maximum ${maximumChangedFiles})`);
    }
    let totalBytes = 0;
    const realTarget = realpathSync(target);
    for (const path of paths) {
      assertRelativeGitPath(path);
      if (sensitivePathPattern.test(path) || forbiddenTrackedPathPattern.test(path)) {
        throw new GitRepositoryOperationError(`Refusing to commit sensitive or control file: ${path}`);
      }
      const candidate = resolve(target, path);
      if (candidate !== target && !candidate.startsWith(`${target}${sep}`)) {
        throw new GitRepositoryOperationError(`Changed path escapes repository: ${path}`);
      }
      if (!existsSync(candidate)) continue;
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new GitRepositoryOperationError(`Refusing to commit non-regular path: ${path}`);
      }
      const realCandidate = realpathSync(candidate);
      if (realCandidate !== realTarget && !realCandidate.startsWith(`${realTarget}${sep}`)) {
        throw new GitRepositoryOperationError(`Changed path resolves outside repository: ${path}`);
      }
      if (!stats.isFile()) continue;
      totalBytes += stats.size;
      if (totalBytes > maximumChangedBytes) {
        throw new GitRepositoryOperationError(`Commit content exceeds ${maximumChangedBytes} bytes`);
      }
      if (stats.size <= 2 * 1024 * 1024) {
        const bytes = readFileSync(candidate);
        if (!bytes.includes(0)) {
          const content = bytes.toString("utf8");
          if (sensitiveContentPatterns.some((pattern) => pattern.test(content))) {
            throw new GitRepositoryOperationError(`Refusing to commit credential-like content: ${path}`);
          }
        }
      }
    }
  }

  private async scanCommitRange(target: string, base: string, head: string, signal?: AbortSignal): Promise<void> {
    const changed = await this.git(["diff", "--name-only", "-z", `${base}..${head}`, "--"], target, signal);
    const paths = changed.stdout.split("\0").filter(Boolean);
    if (paths.length > maximumChangedFiles) {
      throw new GitRepositoryOperationError(`Commit changes too many paths (${paths.length}; maximum ${maximumChangedFiles})`);
    }
    const changedPaths = new Set(paths);
    const tree = await this.git(["ls-tree", "-r", "-z", head], target, signal);
    let totalBytes = 0;
    for (const entry of tree.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d{6})\s+(?:blob|commit)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(entry);
      if (!match) throw new GitRepositoryOperationError("Git returned an invalid tree entry");
      const [, mode, objectId, path] = match;
      assertRelativeGitPath(path);
      if (!changedPaths.has(path)) continue;
      if (mode !== "100644" && mode !== "100755") {
        throw new GitRepositoryOperationError(`Refusing to push non-regular Git tree entry: ${path}`);
      }
      if (sensitivePathPattern.test(path) || forbiddenTrackedPathPattern.test(path)) {
        throw new GitRepositoryOperationError(`Refusing to push sensitive or control file: ${path}`);
      }
      const sizeResult = await this.git(["cat-file", "-s", objectId], target, signal);
      const size = Number(sizeResult.stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new GitRepositoryOperationError(`Git returned an invalid blob size: ${path}`);
      totalBytes += size;
      if (totalBytes > maximumChangedBytes) throw new GitRepositoryOperationError(`Commit content exceeds ${maximumChangedBytes} bytes`);
      if (size <= 2 * 1024 * 1024) {
        const blob = await this.git(["cat-file", "blob", objectId], target, signal, {
          maxOutputBytes: 2 * 1024 * 1024 + 1_024,
        });
        const bytes = Buffer.from(blob.stdout, "utf8");
        if (!bytes.includes(0) && sensitiveContentPatterns.some((pattern) => pattern.test(blob.stdout))) {
          throw new GitRepositoryOperationError(`Refusing to push credential-like content: ${path}`);
        }
      }
    }
    for (const path of changedPaths) assertRelativeGitPath(path);
  }

  private approveCommit(commit: string): void {
    const ledger = this.loadApprovedCommits();
    if (!ledger.commits.includes(commit)) ledger.commits.push(commit);
    this.persistApprovedCommits(ledger);
  }

  private removeApprovedCommits(commits: string[]): void {
    const removed = new Set(commits);
    const ledger = this.loadApprovedCommits();
    ledger.commits = ledger.commits.filter((commit) => !removed.has(commit));
    this.persistApprovedCommits(ledger);
  }

  private loadApprovedCommits(): ApprovedCommitLedger {
    const empty = (): ApprovedCommitLedger => ({
      version: 1,
      repositoryName: this.config.repositoryName,
      branch: this.config.branch,
      commits: [],
    });
    if (!this.approvedCommitsPath || !existsSync(this.approvedCommitsPath)) return empty();
    try {
      const raw = JSON.parse(readFileSync(this.approvedCommitsPath, "utf8")) as Partial<ApprovedCommitLedger>;
      if (raw.version !== 1 || raw.repositoryName !== this.config.repositoryName || raw.branch !== this.config.branch ||
          !Array.isArray(raw.commits) || raw.commits.some((commit) => typeof commit !== "string" || !/^[a-f0-9]{40,64}$/u.test(commit))) {
        return empty();
      }
      return { version: 1, repositoryName: raw.repositoryName, branch: raw.branch, commits: [...new Set(raw.commits)] };
    } catch {
      throw new GitRepositoryOperationError("Approved Git commit ledger is unreadable");
    }
  }

  private persistApprovedCommits(ledger: ApprovedCommitLedger): void {
    if (!this.approvedCommitsPath || !this.gitHome) {
      throw new GitRepositoryOperationError("Persistent state is required to approve Git commits");
    }
    mkdirSync(this.gitHome, { recursive: true, mode: 0o700 });
    const temporary = `${this.approvedCommitsPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.approvedCommitsPath);
    chmodSync(this.approvedCommitsPath, 0o600);
  }

  private readyRepository(): string {
    this.assertConfigured();
    const target = this.repositoryPath();
    if (!existsSync(target)) {
      throw new GitRepositoryOperationError("Repository is not cloned yet; run git_clone_or_sync first");
    }
    this.assertRepository(target);
    return target;
  }

  private repositoryPath(): string {
    const target = resolve(this.workspaceDir, this.checkoutRelativePath);
    if (target !== this.workspaceDir && !target.startsWith(`${this.workspaceDir}${sep}`)) {
      throw new GitRepositoryConfigurationError("Repository path escapes Workspace");
    }
    return target;
  }

  private assertRepository(target: string): void {
    const targetStats = lstatSync(target);
    if (!targetStats.isDirectory() || targetStats.isSymbolicLink()) {
      throw new GitRepositoryOperationError("Shared repository path must be a real directory");
    }
    const gitDir = join(target, ".git");
    const gitStats = lstatSync(gitDir);
    if (!gitStats.isDirectory() || gitStats.isSymbolicLink()) {
      throw new GitRepositoryOperationError("Shared checkout .git must be a real directory");
    }
    const realTarget = realpathSync(target);
    const realRoot = realpathSync(dirname(target));
    if (!realTarget.startsWith(`${realRoot}${sep}`)) {
      throw new GitRepositoryOperationError("Shared repository resolves outside Workspace repos");
    }
  }

  private async assertSafeLocalConfiguration(target: string, signal?: AbortSignal): Promise<void> {
    const result = await this.git(["config", "--local", "--null", "--list"], target, signal);
    const forbidden = /^(?:include\.|includeif\.|credential\.|filter\.|submodule\.|url\.|core\.(?:hookspath|fsmonitor|sshcommand))/iu;
    for (const entry of result.stdout.split("\0").filter(Boolean)) {
      const key = entry.split("\n", 1)[0] ?? entry.split("=", 1)[0];
      if (forbidden.test(key)) {
        throw new GitRepositoryOperationError(`Unsafe local Git configuration is not allowed: ${key}`);
      }
    }
  }

  private async head(target: string, signal?: AbortSignal): Promise<string> {
    return this.revParse(target, "HEAD", signal);
  }

  private async revParse(target: string, ref: string, signal?: AbortSignal): Promise<string> {
    const result = await this.git(["rev-parse", "--verify", ref], target, signal);
    return requireObjectId(result.stdout.trim());
  }

  private async gitExit(args: string[], cwd: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.git(args, cwd, signal);
      return true;
    } catch (error) {
      if (error instanceof GitRepositoryOperationError && /exited with 1\b/u.test(error.message)) return false;
      throw error;
    }
  }

  private async git(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    options: { remote?: boolean; trustOnFirstUse?: boolean; maxOutputBytes?: number } = {},
  ): Promise<GitCommandResult> {
    const env = this.gitEnvironment(options.trustOnFirstUse === true);
    const hardenedArgs = [
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.fsmonitor=false",
      "-c", "protocol.file.allow=never",
      "-c", "protocol.ext.allow=never",
      ...args,
    ];
    const result = await this.runner({
      command: "git",
      args: hardenedArgs,
      cwd,
      env,
      signal,
      timeoutMs: options.remote ? remoteOperationTimeoutMs : operationTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? maximumOutputBytes,
    });
    if (result.exitCode !== 0) {
      const detail = boundText(result.stderr || result.stdout, 4_000).text.trim();
      throw new GitRepositoryOperationError(`git ${args[0]} exited with ${result.exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  private async gitRegistered(
    repository: GitRepository,
    identity: GitIdentity,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    options: { remote?: boolean; trustOnFirstUse?: boolean; maxOutputBytes?: number } = {},
  ): Promise<GitCommandResult> {
    const env = this.registeredGitEnvironment(repository, identity, options.trustOnFirstUse === true);
    const result = await this.runner({
      command: "git",
      args: [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "protocol.file.allow=never",
        "-c", "protocol.ext.allow=never",
        "-c", "credential.helper=",
        "-c", "submodule.recurse=false",
        "-c", "fetch.recurseSubmodules=false",
        ...args,
      ],
      cwd,
      env,
      signal,
      timeoutMs: options.remote ? remoteOperationTimeoutMs : operationTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? maximumOutputBytes,
    });
    if (result.exitCode !== 0) {
      const detail = boundText(result.stderr || result.stdout, 4_000).text.trim();
      throw new GitRepositoryOperationError(`git ${args[0]} exited with ${result.exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  private registeredGitEnvironment(
    repository: GitRepository,
    identity: GitIdentity,
    trustOnFirstUse: boolean,
  ): NodeJS.ProcessEnv {
    const home = this.identityRuntimeDirectory(identity);
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_SSH_COMMAND: this.registeredSshCommand(repository, identity, trustOnFirstUse),
    };
  }

  private registeredSshCommand(repository: GitRepository, identity: GitIdentity, trustOnFirstUse: boolean): string {
    if (this.sshCommandOverride) return this.sshCommandOverride;
    if (!repository.remoteUrl) throw new GitRepositoryConfigurationError("Registered Git repository has no SSH URL");
    parseRemote(repository.remoteUrl);
    const privateKeyPath = resolveGitIdentityPrivateKey(this.stateDir, identity);
    const runtime = this.identityRuntimeDirectory(identity);
    const knownHosts = join(runtime, "known_hosts");
    if (!existsSync(knownHosts)) {
      const descriptor = openSync(knownHosts, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(descriptor);
    }
    const stats = lstatSync(knownHosts);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new GitRepositoryConfigurationError("Git identity known_hosts must be a regular non-symlink file");
    }
    chmodSync(knownHosts, 0o600);
    const proxy = repository.proxyMode === "hclient"
      ? ` -o ProxyCommand=${shellQuote(`${process.execPath} ${shellQuote(fileURLToPath(new URL("./hclient-proxy.js", import.meta.url)))} ${repository.proxyPort} %h %p`)}`
      : "";
    return [
      "ssh",
      "-F", "/dev/null",
      "-i", privateKeyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "ConnectTimeout=15",
      "-o", `StrictHostKeyChecking=${trustOnFirstUse ? "accept-new" : "yes"}`,
      "-o", `UserKnownHostsFile=${knownHosts}`,
    ].map(shellQuote).join(" ") + proxy;
  }

  private identityRuntimeDirectory(identity: GitIdentity): string {
    if (!this.stateDir) throw new GitRepositoryConfigurationError("Persistent state is required for Git identity runtime");
    if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(identity.storageKey)) {
      throw new GitRepositoryConfigurationError("Git identity storage key is invalid");
    }
    const gitRoot = resolve(this.stateDir, "git");
    assertPrivateRuntimeDirectory(gitRoot);
    const root = resolve(gitRoot, "identities");
    ensurePrivateRuntimeChild(gitRoot, root);
    const target = resolve(root, identity.storageKey);
    if (!target.startsWith(`${root}${sep}`)) throw new GitRepositoryConfigurationError("Git identity runtime escapes state");
    ensurePrivateRuntimeChild(root, target);
    return target;
  }

  private gitEnvironment(trustOnFirstUse: boolean): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_SSH_COMMAND: this.sshCommand(trustOnFirstUse),
    };
    if (this.gitHome) env.HOME = this.gitHome;
    return env;
  }

  private sshCommand(trustOnFirstUse: boolean): string {
    if (this.sshCommandOverride) return this.sshCommandOverride;
    this.assertConfigured();
    assertPrivateKey(this.config.privateKeyPath);
    if (!this.gitHome || !this.knownHostsPath) {
      throw new GitRepositoryConfigurationError("Persistent state is required for safe SSH host verification");
    }
    mkdirSync(this.gitHome, { recursive: true, mode: 0o700 });
    chmodSync(this.gitHome, 0o700);
    if (!existsSync(this.knownHostsPath)) {
      const descriptor = openSync(this.knownHostsPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      closeSync(descriptor);
    }
    chmodSync(this.knownHostsPath, 0o600);
    const proxy = this.config.proxyMode === "hclient"
      ? ` -o ProxyCommand=${shellQuote(`${process.execPath} ${shellQuote(fileURLToPath(new URL("./hclient-proxy.js", import.meta.url)))} ${this.config.proxyPort} %h %p`)}`
      : "";
    return [
      "ssh",
      "-F", "/dev/null",
      "-i", this.config.privateKeyPath,
      "-o", "IdentitiesOnly=yes",
      "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no",
      "-o", "KbdInteractiveAuthentication=no",
      "-o", "ConnectTimeout=15",
      "-o", `StrictHostKeyChecking=${trustOnFirstUse ? "accept-new" : "yes"}`,
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
    ].map(shellQuote).join(" ") + proxy;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new GitRepositoryConfigurationError("Configure a fixed SSH repository and private key before using Git");
    }
    parseRemote(this.config.remoteUrl);
    assertPrivateKey(this.config.privateKeyPath);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.pendingOperations = Math.max(0, this.pendingOperations - 1);
    });
  }

  assertConfigurationMutable(): void {
    if (this.pendingOperations > 0) {
      throw new GitRepositoryConfigurationError("Wait for active Git operations before changing Git configuration");
    }
    this.workItems?.assertIdle();
  }

  private resolveWorkRepository(repositoryId: string, projectId: string): GitWorkRepository | undefined {
    if (this.pendingOperations > 0) return undefined;
    if (!this.registry) return undefined;
    const snapshot = this.registry.snapshot();
    const project = snapshot.projects.find((entry) => entry.id === projectId && !entry.archivedAt);
    const repository = snapshot.repositories.find((entry) => entry.id === repositoryId && !entry.archivedAt);
    const binding = snapshot.projectRepositories.find((entry) =>
      entry.projectId === projectId && entry.repositoryId === repositoryId
    );
    if (!project || !repository || !binding || !repository.remoteUrl) return undefined;
    return {
      id: repository.id,
      projectId: project.id,
      projectStorageKey: project.storageKey,
      repositoryStorageKey: repository.storageKey,
      remoteUrl: repository.remoteUrl,
      defaultBranch: repository.defaultBranch,
    };
  }

  private workRepositoryEnvironment(repository: GitWorkRepository): { GIT_SSH_COMMAND: string } {
    if (this.pendingOperations > 0) {
      throw new GitRepositoryConfigurationError("Git configuration is being updated; retry the work-item operation");
    }
    if (!this.registry) throw new GitRepositoryConfigurationError("Persistent state is required for Git work items");
    const resolved = this.registry.resolveRepository(repository.id);
    if (!resolved.projects.some((entry) => entry.id === repository.projectId && !entry.archivedAt)) {
      throw new GitRepositoryConfigurationError("Git work item project/repository binding is no longer available");
    }
    return { GIT_SSH_COMMAND: this.registeredSshCommand(resolved.repository, resolved.identity, false) };
  }

  private mutableRegistry(expectedRevision?: number): GitRegistryService {
    this.assertConfigurationMutable();
    if (!this.registry) throw new GitRepositoryConfigurationError("Persistent state is required for Git projects");
    this.assertRegistryRevision(expectedRevision);
    return this.registry;
  }

  private assertIdentityConfigurationMutable(identityId: string): void {
    if (!this.registry || !this.workItems) return;
    const repositories = this.registry.snapshot().repositories
      .filter((entry) => entry.identityId === identityId)
      .map((entry) => entry.id);
    this.assertWorkItemConfigurationUnreferenced({ repositoryIds: repositories });
  }

  private assertProjectConfigurationMutable(projectId: string): void {
    this.assertWorkItemConfigurationUnreferenced({ projectIds: [projectId] });
  }

  private assertRepositoryConfigurationMutable(repositoryId: string): void {
    this.assertWorkItemConfigurationUnreferenced({ repositoryIds: [repositoryId] });
  }

  private assertBindingConfigurationMutable(bindingId: string): void {
    if (!this.registry) return;
    const binding = this.registry.snapshot().projectRepositories.find((entry) => entry.id === bindingId);
    if (!binding) return;
    this.assertWorkItemConfigurationUnreferenced({
      projectIds: [binding.projectId],
      repositoryIds: [binding.repositoryId],
    });
  }

  private assertWorkItemConfigurationUnreferenced(input: {
    projectIds?: string[];
    repositoryIds?: string[];
  }): void {
    try {
      this.workItems?.assertNoActiveItems(input);
    } catch (error) {
      throw new GitRepositoryOperationError(error instanceof Error ? error.message : String(error));
    }
  }

  private assertRegistryRevision(expectedRevision?: number): void {
    if (expectedRevision === undefined) return;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new GitRegistryError("expectedRevision must be a non-negative integer");
    }
    if (!this.registry || this.registry.snapshot().revision !== expectedRevision) {
      throw new GitRegistryError("Git registry changed; reload settings and retry", "GIT_REGISTRY_CONFLICT");
    }
  }

  private runtimeDefaultConfig(): StoredGitRepositoryConfig {
    if (!this.registry) return this.load();
    const legacy = this.registry.getLegacyConfig();
    const defaults = this.registry.getDefaults();
    let privateKeyPath = legacy.privateKeyPath;
    if (defaults.identity && defaults.identity.credential.kind !== "unconfigured") {
      try {
        privateKeyPath = resolveGitIdentityPrivateKey(this.stateDir, defaults.identity);
      } catch (error) {
        if (!(error instanceof GitIdentityKeyError)) throw error;
        privateKeyPath = "";
      }
    }
    return {
      repositoryName: legacy.repositoryName,
      remoteUrl: legacy.remoteUrl,
      branch: legacy.branch,
      privateKeyPath,
      proxyMode: legacy.proxyMode,
      proxyPort: legacy.proxyPort,
      ...(legacy.updatedAt ? { updatedAt: legacy.updatedAt } : {}),
    };
  }

  private refreshRuntimeDefaultConfig(): void {
    if (!this.registry) return;
    this.config = this.runtimeDefaultConfig();
    this.checkoutRelativePath = this.registry.getDefaults().repository?.checkoutRelativePath ??
      `repos/${this.config.repositoryName}`;
  }

  private load(): StoredGitRepositoryConfig {
    if (!this.configPath || !existsSync(this.configPath)) return { ...defaultConfig };
    try {
      const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as Partial<StoredGitRepositoryConfig> & { version?: string };
      return {
        repositoryName: requireRepositoryName(raw.repositoryName ?? defaultConfig.repositoryName),
        remoteUrl: normalizeRemoteUrl(raw.remoteUrl ?? ""),
        branch: requireBranchName(raw.branch ?? defaultConfig.branch),
        privateKeyPath: normalizePrivateKeyPath(raw.privateKeyPath ?? ""),
        proxyMode: requireProxyMode(raw.proxyMode ?? defaultConfig.proxyMode),
        proxyPort: requireProxyPort(raw.proxyPort ?? defaultConfig.proxyPort),
        ...(typeof raw.updatedAt === "string" ? { updatedAt: raw.updatedAt } : {}),
      };
    } catch (error) {
      throw new GitRepositoryConfigurationError(`Unable to load git-repository.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(): void {
    if (!this.configPath) return;
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify({ version: configVersion, ...this.config }, null, 2)}\n`, "utf8");
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) throw new GitRepositoryConfigurationError("Git configuration target is not a regular file");
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.configPath);
    chmodSync(this.configPath, 0o600);
  }
}

function assertPrivateRuntimeDirectory(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new GitRepositoryConfigurationError("Git runtime parent directory does not exist");
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GitRepositoryConfigurationError("Git runtime parent must be a real directory");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new GitRepositoryConfigurationError("Git runtime directory must be owned by the YourChar process user");
  }
}

function ensurePrivateRuntimeChild(parent: string, target: string): void {
  if (dirname(target) !== resolve(parent)) {
    throw new GitRepositoryConfigurationError("Git runtime directory escapes its managed parent");
  }
  assertPrivateRuntimeDirectory(parent);
  try {
    const stats = lstatSync(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new GitRepositoryConfigurationError("Git runtime target must be a real directory");
    }
  } catch (error) {
    if (error instanceof GitRepositoryConfigurationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new GitRepositoryConfigurationError(
        `Unable to inspect Git runtime target: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    mkdirSync(target, { mode: 0o700 });
  }
  const stats = lstatSync(target);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new GitRepositoryConfigurationError("Git runtime target must be a real directory");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new GitRepositoryConfigurationError("Git runtime target must be owned by the YourChar process user");
  }
  chmodSync(target, 0o700);
}

async function spawnGitCommand(input: Parameters<GitRunner>[0]): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: GitCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolvePromise(result as GitCommandResult);
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(new GitRepositoryOperationError("Git operation was cancelled"));
    };
    const capture = (chunks: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > input.maxOutputBytes) {
        child.kill("SIGTERM");
        finish(new GitRepositoryOperationError("Git command output exceeded the safety limit"));
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => finish(new GitRepositoryOperationError(`Unable to run git: ${error.message}`)));
    child.once("close", (code) => finish(undefined, {
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      exitCode: code ?? -1,
    }));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new GitRepositoryOperationError(`Git command timed out after ${input.timeoutMs} ms`));
    }, input.timeoutMs);
    timer.unref?.();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener("abort", abort, { once: true });
  });
}

function requireRepositoryName(value: unknown): string {
  if (typeof value !== "string" || !safeRepositoryName.test(value)) {
    throw new GitRepositoryConfigurationError("repositoryName must be 1-64 safe filename characters");
  }
  return value;
}

function requireBranchName(value: unknown): string {
  if (typeof value !== "string" || !safeBranchName.test(value) || value.includes("..") || value.includes("//") || value.endsWith(".lock")) {
    throw new GitRepositoryConfigurationError("branch is not a safe branch name");
  }
  return value;
}

function normalizeRemoteUrl(value: unknown): string {
  if (typeof value !== "string") throw new GitRepositoryConfigurationError("remoteUrl must be a string");
  const normalized = value.trim();
  if (!normalized) return "";
  parseRemote(normalized);
  return normalized;
}

function parseRemote(value: string): { user: string; host: string; port: number; path: string } {
  if (/[?#\u0000-\u001f\u007f]/u.test(value)) throw new GitRepositoryConfigurationError("Remote URL cannot contain query, fragment, or control characters");
  const match = exactSshRemote.exec(value);
  if (!match) throw new GitRepositoryConfigurationError("Remote URL must be an ssh://user@host/owner/repository.git URL");
  const port = match[3] ? Number(match[3]) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GitRepositoryConfigurationError("Remote SSH port is invalid");
  const path = match[4];
  if (!path.endsWith(".git") || path.startsWith("/") || path.split("/").some((part) =>
    !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === ".."
  )) {
    throw new GitRepositoryConfigurationError("Remote path must be a normalized repository.git path");
  }
  return { user: match[1], host: match[2].toLowerCase(), port, path };
}

function normalizePrivateKeyPath(value: unknown): string {
  if (typeof value !== "string") throw new GitRepositoryConfigurationError("privateKeyPath must be a string");
  const normalized = value.trim();
  if (!normalized) return "";
  if (!isAbsolute(normalized)) throw new GitRepositoryConfigurationError("privateKeyPath must be absolute");
  return resolve(normalized);
}

function requireExternalIdentityKey(path: string): string {
  try {
    return assertGitExternalPrivateKey(path);
  } catch (error) {
    if (error instanceof GitIdentityKeyError) {
      throw new GitRepositoryConfigurationError(error.message);
    }
    throw error;
  }
}

function assertPrivateKey(path: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new GitRepositoryConfigurationError("Configured SSH private key does not exist");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) throw new GitRepositoryConfigurationError("SSH private key must be a regular non-symlink file");
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new GitRepositoryConfigurationError("SSH private key must be owned by the YourChar process user");
  }
  if ((stats.mode & 0o077) !== 0) throw new GitRepositoryConfigurationError("SSH private key permissions must not allow group or other access");
}

function requireProxyMode(value: unknown): GitProxyMode {
  if (value !== "direct" && value !== "hclient") throw new GitRepositoryConfigurationError("proxyMode must be direct or hclient");
  return value;
}

function requireProxyPort(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new GitRepositoryConfigurationError("proxyPort must be an integer between 1 and 65535");
  }
  return Number(value);
}

function requireCommitMessage(value: unknown): string {
  if (typeof value !== "string") throw new GitRepositoryOperationError("Commit message must be a string");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumCommitMessageCharacters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    throw new GitRepositoryOperationError(`Commit message must contain 1-${maximumCommitMessageCharacters} printable characters`);
  }
  return normalized;
}

function requireObjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new GitRepositoryOperationError("Remote did not return a valid Git object ID");
  }
  return value;
}

function assertRelativeGitPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new GitRepositoryOperationError(`Unsafe changed path: ${path}`);
  }
}

function sanitizeAuthorName(value: string): string {
  const normalized = String(value).replace(/[\r\n<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80);
  return normalized || "Character";
}

function slugIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function boundText(value: string, bytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= bytes) return { text: value, truncated: false };
  return { text: `${buffer.subarray(0, bytes).toString("utf8")}\n...[truncated]`, truncated: true };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
