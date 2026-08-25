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
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import {
  assertGitExternalPrivateKey,
  discardManagedGitIdentityKey,
  generateManagedGitIdentityKey,
  gitIdentityPublicKey,
  GitIdentityKeyError,
  resolveGitIdentityPrivateKey,
} from "./identity-key.js";
import {
  GitRepositoryConfigurationError,
  GitRepositoryOperationError,
} from "./service.js";
import type {
  GitAccessCommitResult,
  GitAccessConfig,
  GitAccessConfigPatch,
  GitAccessOpenResult,
  GitAccessPushResult,
  GitAccessRepository,
  GitCommandResult,
  GitIdentity,
  GitIdentityCredential,
  GitProxyMode,
} from "./types.js";

const accessVersion = "yourchar-git-access-v1" as const;
const maximumOutputBytes = 128 * 1024;
const maximumDiffBytes = 64 * 1024;
const maximumChangedFiles = 1_000;
const maximumChangedBytes = 64 * 1024 * 1024;
const maximumCommitMessageCharacters = 500;
const localOperationTimeoutMs = 120_000;
const remoteOperationTimeoutMs = 180_000;
const exactSshRemote = /^ssh:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})@([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/(.+)$/u;
const safeBranch = /^[A-Za-z0-9](?:[A-Za-z0-9._\/-]{0,126}[A-Za-z0-9])?$/u;
const sensitivePathPattern = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]+\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|kdbx)|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?)$/iu;
const forbiddenTrackedPathPattern = /(?:^|\/)(?:\.gitmodules|\.lfsconfig)$/iu;
const sensitiveContentPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|tvly-[A-Za-z0-9_-]{16,})\b/u,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+\/-]{12,}/iu,
];

type StoredGitAccessConfig = {
  version: typeof accessVersion;
  revision: number;
  identityStorageKey: string;
  credential: GitIdentityCredential;
  fingerprint?: string;
  proxyMode: GitProxyMode;
  proxyPort: number;
  updatedAt: string;
  migration?: { source: "git-registry-v2" | "git-repository-v1"; migratedAt: string };
};

type ApprovedLedger = {
  version: 1;
  repositories: Record<string, string[]>;
};

type ParsedRemote = {
  user: string;
  host: string;
  port: number;
  path: string;
  canonicalUrl: string;
  key: string;
};

export type GitAccessRunner = (input: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs: number;
  maxOutputBytes: number;
}) => Promise<GitCommandResult>;

export type GitAccessServiceOptions = {
  stateDir?: string;
  workspaceDir: string;
  clock?: Clock;
  runner?: GitAccessRunner;
  sshCommandOverride?: string;
};

/**
 * A personal-workstation Git adapter. The SSH identity is configured once;
 * repository URLs come directly from the user conversation and are checked
 * out below Workspace/repos. There is intentionally no repository ACL or
 * project/session registry in this service.
 */
export class GitAccessService {
  private readonly stateDir?: string;
  private readonly workspaceDir: string;
  private readonly gitStateDir: string;
  private readonly accessPath: string;
  private readonly runtimeDir: string;
  private readonly knownHostsPath: string;
  private readonly ledgerPath: string;
  private readonly reposDir: string;
  private readonly clock: Clock;
  private readonly runner: GitAccessRunner;
  private readonly sshCommandOverride?: string;
  private readonly mutex = new KeyedMutex();
  private config: StoredGitAccessConfig;
  private activeOperations = 0;
  private configurationMutationActive = false;

  constructor(options: GitAccessServiceOptions) {
    this.stateDir = options.stateDir ? ensureRootDirectory(options.stateDir, "Git state") : undefined;
    this.workspaceDir = options.stateDir
      ? ensureRootDirectory(options.workspaceDir, "Git Workspace")
      : resolve(options.workspaceDir);
    this.gitStateDir = this.stateDir ? ensureManagedDirectory(this.stateDir, "git", "Git state") : "";
    this.accessPath = join(this.gitStateDir, "access.json");
    this.runtimeDir = this.stateDir ? ensureManagedDirectory(this.gitStateDir, "access-runtime", "Git runtime") : "";
    this.knownHostsPath = join(this.runtimeDir, "known_hosts");
    this.ledgerPath = join(this.gitStateDir, "access-approved-commits.json");
    this.reposDir = this.stateDir ? ensureManagedDirectory(this.workspaceDir, "repos", "Git repository root") : join(this.workspaceDir, "repos");
    this.clock = options.clock ?? new SystemClock();
    this.runner = options.runner ?? spawnGitCommand;
    this.sshCommandOverride = options.sshCommandOverride;
    this.config = this.stateDir ? this.loadOrMigrate() : this.defaultConfig();
  }

  getConfig(): GitAccessConfig {
    return {
      revision: this.config.revision,
      credential: this.config.credential.kind === "external-file"
        ? { kind: "external-file", privateKeyPath: this.config.credential.privateKeyPath }
        : { kind: this.config.credential.kind },
      ...(this.config.fingerprint ? { fingerprint: this.config.fingerprint } : {}),
      proxyMode: this.config.proxyMode,
      proxyPort: this.config.proxyPort,
      configured: this.isConfigured(),
    };
  }

  patchConfig(patch: GitAccessConfigPatch, expectedRevision: number): GitAccessConfig {
    this.requirePersistentStateDir();
    this.assertMutable(expectedRevision);
    const next = structuredClone(this.config);
    if (patch.credential !== undefined) {
      if (patch.credential.kind === "unconfigured") {
        next.credential = { kind: "unconfigured" };
        next.identityStorageKey = "default";
        delete next.fingerprint;
      } else {
        next.credential = {
          kind: "external-file",
          privateKeyPath: requireExternalPrivateKey(patch.credential.privateKeyPath),
        };
        next.identityStorageKey = "default";
        delete next.fingerprint;
      }
    }
    if (patch.proxyMode !== undefined) next.proxyMode = requireProxyMode(patch.proxyMode);
    if (patch.proxyPort !== undefined) next.proxyPort = requireProxyPort(patch.proxyPort);
    next.revision += 1;
    next.updatedAt = this.clock.now().toISOString();
    this.persist(next);
    this.config = next;
    return this.getConfig();
  }

  async generateKey(expectedRevision: number, beforeCommit?: () => void): Promise<{
    config: GitAccessConfig;
    publicKey: string;
    fingerprint: string;
  }> {
    const stateDir = this.requirePersistentStateDir();
    this.assertMutable(expectedRevision);
    if (this.config.credential.kind === "managed-ed25519") {
      throw new GitRepositoryConfigurationError("The global Git identity already has a managed key");
    }
    this.configurationMutationActive = true;
    this.activeOperations += 1;
    const identity: GitIdentity = {
      id: "default",
      name: "Default SSH identity",
      storageKey: "default",
      credential: { kind: "unconfigured" },
      createdAt: this.config.updatedAt,
      updatedAt: this.config.updatedAt,
    };
    try {
      const generated = await generateManagedGitIdentityKey({ stateDir, identity });
      try {
        beforeCommit?.();
        this.assertRevision(expectedRevision);
        const next: StoredGitAccessConfig = {
          ...this.config,
          revision: this.config.revision + 1,
          identityStorageKey: "default",
          credential: { kind: "managed-ed25519", keyRef: generated.keyRef },
          fingerprint: generated.fingerprint,
          updatedAt: this.clock.now().toISOString(),
        };
        this.persist(next);
        this.config = next;
        return { config: this.getConfig(), publicKey: generated.publicKey, fingerprint: generated.fingerprint };
      } catch (error) {
        discardManagedGitIdentityKey({ stateDir, identity, keyRef: generated.keyRef });
        throw error;
      }
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
      this.configurationMutationActive = false;
    }
  }

  getPublicKey(): { publicKey?: string; fingerprint?: string } {
    const publicKey = gitIdentityPublicKey(this.stateDir, this.identity());
    return {
      ...(publicKey ? { publicKey } : {}),
      ...(this.config.fingerprint ? { fingerprint: this.config.fingerprint } : {}),
    };
  }

  isConfigured(): boolean {
    try {
      resolveGitIdentityPrivateKey(this.stateDir, this.identity());
      return true;
    } catch {
      return false;
    }
  }

  contextStatus(moduleEnabled: boolean): string {
    if (!moduleEnabled) {
      return "Capability status: Git MCP is disabled. Do not claim to inspect, commit, or push repositories.";
    }
    if (!this.isConfigured()) {
      return "Capability status: Git MCP is enabled but the global SSH identity is not configured. Do not claim to use remote Git.";
    }
    return "Capability status: Git MCP is enabled. You may open an ssh:// repository URL supplied by the user; repositories remain under Workspace/repos. Inspect status and diff before committing, never change remotes, and never force push.";
  }

  async listRepositories(signal?: AbortSignal): Promise<GitAccessRepository[]> {
    this.assertConfigured();
    if (this.configurationMutationActive) throw new GitRepositoryOperationError("The SSH identity is being changed; retry Git access");
    this.activeOperations += 1;
    try {
      const checkouts = await this.discoverCheckouts(signal);
      const repositories: GitAccessRepository[] = [];
      for (const checkout of checkouts) {
        const remote = await this.uniqueCheckoutRemote(checkout, signal);
        repositories.push(await this.mutex.run(remote.key, () => this.statusAt(remote, checkout, signal)));
      }
      return repositories.sort((left, right) => left.workspacePath.localeCompare(right.workspacePath));
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
    }
  }

  async openRepository(remoteUrl: string, signal?: AbortSignal): Promise<GitAccessOpenResult> {
    const remote = parseRemote(remoteUrl);
    return this.withRepository(remote, async () => {
      const existing = await this.findCheckout(remote, signal);
      if (existing) return this.syncExisting(remote, existing, signal);
      const target = this.deterministicCheckout(remote);
      if (pathEntryExists(target)) {
        throw new GitRepositoryOperationError("The deterministic repository path is already occupied by a different checkout");
      }
      return this.cloneFresh(remote, target, signal);
    });
  }

  async status(remoteUrl: string, signal?: AbortSignal): Promise<GitAccessRepository> {
    const remote = parseRemote(remoteUrl);
    return this.withRepository(remote, async () => this.statusAt(remote, await this.requireCheckout(remote, signal), signal));
  }

  async diff(
    input: { remoteUrl: string; staged?: boolean },
    signal?: AbortSignal,
  ): Promise<{ repository: GitAccessRepository; diff: string; truncated: boolean }> {
    const remote = parseRemote(input.remoteUrl);
    return this.withRepository(remote, async () => {
      const checkout = await this.requireCheckout(remote, signal);
      const repository = await this.statusAt(remote, checkout, signal);
      const result = await this.git(
        ["diff", "--no-ext-diff", "--no-textconv", ...(input.staged ? ["--cached"] : []), "--"],
        checkout,
        signal,
      );
      const bounded = boundText(result.stdout, maximumDiffBytes);
      return { repository, diff: bounded.text, truncated: bounded.truncated };
    });
  }

  async log(
    input: { remoteUrl: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<{ repository: GitAccessRepository; log: string; truncated: boolean }> {
    const remote = parseRemote(input.remoteUrl);
    return this.withRepository(remote, async () => {
      const checkout = await this.requireCheckout(remote, signal);
      const repository = await this.statusAt(remote, checkout, signal);
      const limit = Number.isInteger(input.limit) ? Math.max(1, Math.min(50, input.limit!)) : 10;
      const result = await this.git(
        ["log", `-${limit}`, "--no-show-signature", "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%an%x09%s"],
        checkout,
        signal,
      );
      const bounded = boundText(result.stdout, maximumDiffBytes);
      return { repository, log: bounded.text, truncated: bounded.truncated };
    });
  }

  async commit(input: {
    remoteUrl: string;
    message: string;
    characterId: string;
    characterName: string;
  }, signal?: AbortSignal): Promise<GitAccessCommitResult> {
    const remote = parseRemote(input.remoteUrl);
    return this.withRepository(remote, async () => {
      const checkout = await this.requireCheckout(remote, signal);
      const message = requireCommitMessage(input.message);
      const before = await this.statusAt(remote, checkout, signal);
      const staged = await this.git(["diff", "--cached", "--name-only", "--"], checkout, signal);
      if (staged.stdout.trim()) {
        throw new GitRepositoryOperationError("The repository already has staged changes; resolve them before an Agent commit");
      }
      const paths = await this.changedPaths(checkout, signal);
      if (!paths.length) throw new GitRepositoryOperationError("Repository has no changes to commit");
      this.scanChangedFiles(checkout, paths);
      await this.git(["add", "-A", "--"], checkout, signal);
      try {
        await this.git([
          "-c", `user.name=${sanitizeAuthorName(input.characterName)} via YourChar`,
          "-c", `user.email=${slugIdentity(input.characterId)}@yourchar.local`,
          "-c", "commit.gpgSign=false",
          "commit", "--no-gpg-sign", "--no-verify", "-m", message,
        ], checkout, signal);
      } catch (error) {
        await this.git(["reset", "--mixed", "HEAD", "--"], checkout).catch(() => undefined);
        throw error;
      }
      const commit = await this.revParse(checkout, "HEAD", signal);
      try {
        await this.scanCommitRange(checkout, before.head, commit, signal);
        this.approveCommit(remote.key, commit);
      } catch (error) {
        await this.git(["reset", "--mixed", "HEAD^", "--"], checkout).catch(() => undefined);
        throw error;
      }
      const after = await this.statusAt(remote, checkout, signal);
      return { ...after, commit, changedPaths: paths.length };
    });
  }

  async push(remoteUrl: string, signal?: AbortSignal): Promise<GitAccessPushResult> {
    const remote = parseRemote(remoteUrl);
    return this.withRepository(remote, async () => {
      const checkout = await this.requireCheckout(remote, signal);
      const status = await this.statusAt(remote, checkout, signal);
      if (!status.clean) throw new GitRepositoryOperationError("Commit all local changes before pushing");
      const remoteRef = accessRemoteRef(status.branch);
      await this.git([
        "fetch", "--no-tags", "--no-recurse-submodules", "--", remote.canonicalUrl,
        `refs/heads/${status.branch}:${remoteRef}`,
      ], checkout, signal, { remote: true });
      const remoteHead = await this.revParse(checkout, remoteRef, signal);
      if (!await this.gitExit(["merge-base", "--is-ancestor", remoteHead, status.head], checkout, signal)) {
        throw new GitRepositoryOperationError("Remote history diverged from local HEAD; force push is not allowed");
      }
      const pending = (await this.git(["rev-list", "--reverse", `${remoteHead}..${status.head}`], checkout, signal))
        .stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).map(requireObjectId);
      if (pending.length > 100) throw new GitRepositoryOperationError("Too many local commits are pending push");
      const approved = new Set(this.loadLedger().repositories[remote.key] ?? []);
      const unapproved = pending.find((entry) => !approved.has(entry));
      if (unapproved) {
        throw new GitRepositoryOperationError(`Refusing to push unapproved local commit ${unapproved.slice(0, 12)}; use git_commit`);
      }
      if (pending.length) await this.scanCommitRange(checkout, remoteHead, status.head, signal);
      await this.git([
        "push", "--porcelain", "--no-signed", "--", remote.canonicalUrl,
        `${status.head}:refs/heads/${status.branch}`,
      ], checkout, signal, { remote: true });
      if (pending.length) this.removeApprovedCommits(remote.key, pending);
      return { ...status, commit: status.head, pushedCommits: pending.length };
    });
  }

  private async withRepository<T>(remote: ParsedRemote, operation: () => Promise<T>): Promise<T> {
    this.assertConfigured();
    if (this.configurationMutationActive) throw new GitRepositoryOperationError("The SSH identity is being changed; retry the Git operation");
    this.activeOperations += 1;
    try {
      return await this.mutex.run(remote.key, operation);
    } finally {
      this.activeOperations = Math.max(0, this.activeOperations - 1);
    }
  }

  private async cloneFresh(remote: ParsedRemote, target: string, signal?: AbortSignal): Promise<GitAccessOpenResult> {
    const parent = this.ensureCheckoutParent(remote);
    if (dirname(target) !== parent) throw new GitRepositoryOperationError("Repository checkout target changed unexpectedly");
    const staging = join(parent, `.git-stage-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      await this.git([
        "clone", "--single-branch", "--no-tags", "--no-recurse-submodules",
        "--origin", "origin", "--", remote.canonicalUrl, staging,
      ], parent, signal, { remote: true, trustOnFirstUse: true });
      chmodSync(staging, 0o700);
      this.assertCheckout(staging);
      await this.assertCheckoutRemote(staging, remote, signal);
      await this.assertSafeLocalConfiguration(staging, signal);
      if (pathEntryExists(target)) throw new GitRepositoryOperationError("Repository checkout target appeared during clone");
      renameSync(staging, target);
      const status = await this.statusAt(remote, target, signal);
      return { ...status, cloned: true, changed: true };
    } catch (error) {
      safeRemoveStaging(staging, parent);
      throw error;
    }
  }

  private async syncExisting(remote: ParsedRemote, checkout: string, signal?: AbortSignal): Promise<GitAccessOpenResult> {
    const before = await this.statusAt(remote, checkout, signal);
    if (!before.clean) {
      throw new GitRepositoryOperationError("Repository has local changes; commit them before syncing");
    }
    const remoteRef = accessRemoteRef(before.branch);
    await this.git([
      "fetch", "--no-tags", "--no-recurse-submodules", "--", remote.canonicalUrl,
      `refs/heads/${before.branch}:${remoteRef}`,
    ], checkout, signal, { remote: true, trustOnFirstUse: true });
    const remoteHead = await this.revParse(checkout, remoteRef, signal);
    if (before.head !== remoteHead) {
      if (await this.gitExit(["merge-base", "--is-ancestor", before.head, remoteHead], checkout, signal)) {
        await this.git(["merge", "--ff-only", remoteHead], checkout, signal);
      } else if (!await this.gitExit(["merge-base", "--is-ancestor", remoteHead, before.head], checkout, signal)) {
        throw new GitRepositoryOperationError("Local and remote history diverged; manual reconciliation is required");
      }
    }
    const after = await this.statusAt(remote, checkout, signal);
    return { ...after, cloned: false, changed: before.head !== after.head };
  }

  private async statusAt(remote: ParsedRemote, checkout: string, signal?: AbortSignal): Promise<GitAccessRepository> {
    this.assertCheckout(checkout);
    await this.assertCheckoutRemote(checkout, remote, signal);
    await this.assertSafeLocalConfiguration(checkout, signal);
    const branch = requireBranch((await this.git(["branch", "--show-current"], checkout, signal)).stdout.trim());
    const head = await this.revParse(checkout, "HEAD", signal);
    const porcelain = await this.git(["status", "--porcelain=v1", "--untracked-files=all"], checkout, signal);
    const workspacePath = relative(this.workspaceDir, checkout).split(sep).join("/");
    return {
      remoteUrl: remote.canonicalUrl,
      host: remote.host,
      owner: remote.path.split("/").slice(0, -1).join("/"),
      name: remote.path.split("/").at(-1)!.slice(0, -4),
      workspacePath,
      branch,
      head,
      clean: !porcelain.stdout.trim(),
      summary: boundText(porcelain.stdout || "clean", maximumDiffBytes).text,
    };
  }

  private async requireCheckout(remote: ParsedRemote, signal?: AbortSignal): Promise<string> {
    const checkout = await this.findCheckout(remote, signal);
    if (!checkout) throw new GitRepositoryOperationError("Repository is not cloned; run git_open_repository first");
    return checkout;
  }

  private async findCheckout(remote: ParsedRemote, signal?: AbortSignal): Promise<string | undefined> {
    const matches: string[] = [];
    for (const checkout of await this.discoverCheckouts(signal)) {
      const urls = await this.checkoutRemoteUrls(checkout, signal);
      if (urls.some((entry) => entry.key === remote.key)) matches.push(checkout);
    }
    if (matches.length > 1) {
      throw new GitRepositoryOperationError("More than one checkout matches this remote URL; remove the ambiguity manually");
    }
    return matches[0];
  }

  private async discoverCheckouts(_signal?: AbortSignal): Promise<string[]> {
    assertRealDirectory(this.reposDir, "Git repository root");
    const found: string[] = [];
    const visit = (directory: string, depth: number) => {
      if (depth > 16) throw new GitRepositoryOperationError("Repository directory nesting exceeds the safety limit");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const candidate = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new GitRepositoryOperationError("Symbolic links are not allowed below Workspace/repos");
        if (!entry.isDirectory()) continue;
        if (entry.name === ".git") continue;
        assertRealDirectory(candidate, "Repository directory");
        if (pathEntryExists(join(candidate, ".git"))) {
          this.assertCheckout(candidate);
          found.push(candidate);
        } else if (!entry.name.startsWith(".git-stage-")) {
          visit(candidate, depth + 1);
        }
      }
    };
    visit(this.reposDir, 0);
    return found;
  }

  private async uniqueCheckoutRemote(checkout: string, signal?: AbortSignal): Promise<ParsedRemote> {
    const remotes = await this.checkoutRemoteUrls(checkout, signal);
    const unique = new Map(remotes.map((entry) => [entry.key, entry]));
    if (unique.size !== 1) {
      throw new GitRepositoryOperationError(`Checkout ${relative(this.workspaceDir, checkout)} does not have one unambiguous SSH remote`);
    }
    return [...unique.values()][0]!;
  }

  private async checkoutRemoteUrls(checkout: string, signal?: AbortSignal): Promise<ParsedRemote[]> {
    this.assertCheckout(checkout);
    const names = (await this.git(["remote"], checkout, signal)).stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
    if (!names.length || names.length > 20) throw new GitRepositoryOperationError("Checkout has no usable Git remote");
    const urls: ParsedRemote[] = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(name)) throw new GitRepositoryOperationError("Checkout has an unsafe remote name");
      const result = await this.git(["remote", "get-url", "--", name], checkout, signal);
      urls.push(parseRemote(result.stdout.trim()));
      const all = (await this.git(["remote", "get-url", "--all", "--push", name], checkout, signal)).stdout
        .split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
      if (all.some((entry) => parseRemote(entry).key !== urls.at(-1)!.key)) {
        throw new GitRepositoryOperationError("Separate Git push URLs are not allowed");
      }
    }
    return urls;
  }

  private async assertCheckoutRemote(checkout: string, remote: ParsedRemote, signal?: AbortSignal): Promise<void> {
    const remotes = await this.checkoutRemoteUrls(checkout, signal);
    const unique = new Set(remotes.map((entry) => entry.key));
    if (unique.size !== 1 || !unique.has(remote.key)) {
      throw new GitRepositoryOperationError("Checkout remotes do not unambiguously match the requested repository");
    }
  }

  private deterministicCheckout(remote: ParsedRemote): string {
    const segments = remote.path.split("/");
    segments[segments.length - 1] = segments.at(-1)!.slice(0, -4);
    const hostDirectory = remote.port === 22 ? remote.host : `${remote.host}-p${remote.port}`;
    const target = resolve(this.reposDir, hostDirectory, remote.user, ...segments);
    if (!isWithin(this.reposDir, target)) throw new GitRepositoryConfigurationError("Repository checkout escapes Workspace/repos");
    return target;
  }

  private ensureCheckoutParent(remote: ParsedRemote): string {
    const target = this.deterministicCheckout(remote);
    const nested = relative(this.reposDir, dirname(target)).split(sep).filter(Boolean);
    let current = this.reposDir;
    for (const segment of nested) {
      const next = join(current, segment);
      if (!pathEntryExists(next)) mkdirSync(next, { mode: 0o700 });
      assertRealDirectory(next, "Git checkout parent");
      current = next;
    }
    return current;
  }

  private assertCheckout(checkout: string): void {
    if (!isWithin(this.reposDir, checkout)) throw new GitRepositoryOperationError("Repository path escapes Workspace/repos");
    assertRealDirectory(checkout, "Repository checkout");
    assertRealDirectory(join(checkout, ".git"), "Repository .git directory");
  }

  private async assertSafeLocalConfiguration(checkout: string, signal?: AbortSignal): Promise<void> {
    // Explicit-file reads ignore includes. A strict allowlist is intentional:
    // Git has many command-valued keys (and gains new ones over time), so an
    // executable-key blacklist cannot be a durable host security boundary.
    const result = await this.git(["config", "--local", "--no-includes", "--null", "--list"], checkout, signal);
    for (const entry of result.stdout.split("\0").filter(Boolean)) {
      const separator = entry.indexOf("\n");
      if (separator <= 0) throw new GitRepositoryOperationError("Git returned an invalid local configuration entry");
      const key = entry.slice(0, separator);
      const value = entry.slice(separator + 1);
      if (!isBenignLocalGitConfiguration(key, value)) {
        throw new GitRepositoryOperationError(`Unsafe local Git configuration is not allowed: ${key}`);
      }
    }
  }

  private async changedPaths(checkout: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], checkout, signal);
    const records = result.stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.length < 4) throw new GitRepositoryOperationError("Git returned an invalid status record");
      const status = record.slice(0, 2);
      paths.push(record.slice(3));
      if (status[0] === "R" || status[0] === "C") {
        const renamed = records[++index];
        if (!renamed) throw new GitRepositoryOperationError("Git returned an incomplete rename record");
        paths.push(renamed);
      }
    }
    return [...new Set(paths)];
  }

  private scanChangedFiles(checkout: string, paths: string[]): void {
    if (paths.length > maximumChangedFiles) throw new GitRepositoryOperationError("Commit changes too many paths");
    const realCheckout = realpathSync(checkout);
    let total = 0;
    for (const path of paths) {
      assertRelativeGitPath(path);
      if (sensitivePathPattern.test(path) || forbiddenTrackedPathPattern.test(path)) {
        throw new GitRepositoryOperationError(`Refusing to commit sensitive or control file: ${path}`);
      }
      const candidate = resolve(checkout, path);
      if (!isWithin(checkout, candidate) || !pathEntryExists(candidate)) continue;
      const stats = lstatSync(candidate);
      if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
        throw new GitRepositoryOperationError(`Refusing to commit non-regular path: ${path}`);
      }
      const realCandidate = realpathSync(candidate);
      if (realCandidate !== realCheckout && !realCandidate.startsWith(`${realCheckout}${sep}`)) {
        throw new GitRepositoryOperationError(`Changed path resolves outside repository: ${path}`);
      }
      if (!stats.isFile()) continue;
      total += stats.size;
      if (total > maximumChangedBytes) throw new GitRepositoryOperationError("Commit content exceeds the safety limit");
      if (stats.size <= 2 * 1024 * 1024) scanCredentialContent(readFileSync(candidate), path);
    }
  }

  private async scanCommitRange(checkout: string, base: string, head: string, signal?: AbortSignal): Promise<void> {
    requireObjectId(base);
    requireObjectId(head);
    const changed = await this.git(["diff", "--name-only", "-z", `${base}..${head}`, "--"], checkout, signal);
    const changedPaths = new Set(changed.stdout.split("\0").filter(Boolean));
    if (changedPaths.size > maximumChangedFiles) throw new GitRepositoryOperationError("Commit changes too many paths");
    const tree = await this.git(["ls-tree", "-r", "-z", head], checkout, signal);
    let total = 0;
    for (const entry of tree.stdout.split("\0").filter(Boolean)) {
      const match = /^(\d{6})\s+(?:blob|commit)\s+([a-f0-9]{40,64})\t(.+)$/u.exec(entry);
      if (!match) throw new GitRepositoryOperationError("Git returned an invalid tree entry");
      const [, mode, objectId, path] = match;
      if (!changedPaths.has(path!)) continue;
      assertRelativeGitPath(path!);
      if (mode !== "100644" && mode !== "100755") throw new GitRepositoryOperationError(`Refusing to push non-regular entry: ${path}`);
      if (sensitivePathPattern.test(path!) || forbiddenTrackedPathPattern.test(path!)) throw new GitRepositoryOperationError(`Refusing to push sensitive or control file: ${path}`);
      const size = Number((await this.git(["cat-file", "-s", objectId!], checkout, signal)).stdout.trim());
      if (!Number.isSafeInteger(size) || size < 0) throw new GitRepositoryOperationError("Git returned an invalid blob size");
      total += size;
      if (total > maximumChangedBytes) throw new GitRepositoryOperationError("Commit content exceeds the safety limit");
      if (size <= 2 * 1024 * 1024) {
        const blob = await this.git(["cat-file", "blob", objectId!], checkout, signal, { maxOutputBytes: 2 * 1024 * 1024 + 1024 });
        scanCredentialContent(Buffer.from(blob.stdout, "utf8"), path!);
      }
    }
    for (const path of changedPaths) assertRelativeGitPath(path);
  }

  private approveCommit(repositoryKey: string, commit: string): void {
    const ledger = this.loadLedger();
    const commits = ledger.repositories[repositoryKey] ?? [];
    if (!commits.includes(commit)) commits.push(commit);
    ledger.repositories[repositoryKey] = commits;
    this.persistLedger(ledger);
  }

  private removeApprovedCommits(repositoryKey: string, commits: string[]): void {
    const ledger = this.loadLedger();
    const removed = new Set(commits);
    ledger.repositories[repositoryKey] = (ledger.repositories[repositoryKey] ?? []).filter((entry) => !removed.has(entry));
    this.persistLedger(ledger);
  }

  private loadLedger(): ApprovedLedger {
    if (!pathEntryExists(this.ledgerPath)) return { version: 1, repositories: {} };
    assertRegularFile(this.ledgerPath, "Git approval ledger");
    try {
      const raw = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as Partial<ApprovedLedger>;
      if (raw.version !== 1 || !raw.repositories || typeof raw.repositories !== "object" || Array.isArray(raw.repositories)) throw new Error("invalid schema");
      const repositories: Record<string, string[]> = {};
      for (const [key, value] of Object.entries(raw.repositories)) {
        if (!/^.{1,1024}$/u.test(key) || !Array.isArray(value) || value.length > 100 || value.some((entry) => typeof entry !== "string" || !/^[a-f0-9]{40,64}$/u.test(entry))) throw new Error("invalid entry");
        repositories[key] = [...new Set(value)];
      }
      return { version: 1, repositories };
    } catch (error) {
      throw new GitRepositoryOperationError(`Git approval ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persistLedger(ledger: ApprovedLedger): void {
    atomicWriteJson(this.ledgerPath, ledger, "Git approval ledger");
  }

  private async revParse(checkout: string, ref: string, signal?: AbortSignal): Promise<string> {
    return requireObjectId((await this.git(["rev-parse", "--verify", ref], checkout, signal)).stdout.trim());
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

  private async git(args: string[], cwd: string, signal?: AbortSignal, options: {
    remote?: boolean;
    trustOnFirstUse?: boolean;
    maxOutputBytes?: number;
  } = {}): Promise<GitCommandResult> {
    const result = await this.runner({
      command: "git",
      args: [
        "-c", "core.hooksPath=/dev/null",
        "-c", "core.fsmonitor=false",
        "-c", "core.pager=cat",
        "-c", "pager.log=false",
        "-c", "pager.diff=false",
        "-c", "log.showSignature=false",
        "-c", "maintenance.auto=false",
        "-c", "maintenance.autoDetach=false",
        "-c", "gc.auto=0",
        "-c", "gc.autoDetach=false",
        "-c", "diff.external=",
        "-c", "diff.trustExitCode=false",
        "-c", "protocol.file.allow=never",
        "-c", "protocol.ext.allow=never",
        "-c", "credential.helper=",
        "-c", "submodule.recurse=false",
        "-c", "fetch.recurseSubmodules=false",
        ...args,
      ],
      cwd,
      env: this.gitEnvironment(options.trustOnFirstUse === true),
      signal,
      timeoutMs: options.remote ? remoteOperationTimeoutMs : localOperationTimeoutMs,
      maxOutputBytes: options.maxOutputBytes ?? maximumOutputBytes,
    });
    if (result.exitCode !== 0) {
      const detail = boundText(result.stderr || result.stdout, 4_000).text.trim();
      throw new GitRepositoryOperationError(`git ${args[0]} exited with ${result.exitCode}${detail ? `: ${detail}` : ""}`);
    }
    return result;
  }

  private gitEnvironment(trustOnFirstUse: boolean): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: this.runtimeDir,
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: "/bin/false",
      GIT_SEQUENCE_EDITOR: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_SSH_VARIANT: "ssh",
      GIT_SSH_COMMAND: this.sshCommand(trustOnFirstUse),
    };
  }

  private sshCommand(trustOnFirstUse: boolean): string {
    if (this.sshCommandOverride) return this.sshCommandOverride;
    const privateKey = resolveGitIdentityPrivateKey(this.stateDir, this.identity());
    ensureKnownHosts(this.knownHostsPath, this.runtimeDir);
    const proxy = this.config.proxyMode === "hclient"
      ? ` -o ProxyCommand=${shellQuote(`${process.execPath} ${shellQuote(fileURLToPath(new URL("./hclient-proxy.js", import.meta.url)))} ${this.config.proxyPort} %h %p`)}`
      : "";
    return [
      "ssh", "-F", "/dev/null", "-i", privateKey,
      "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
      "-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
      "-o", "ConnectTimeout=15",
      "-o", `StrictHostKeyChecking=${trustOnFirstUse ? "accept-new" : "yes"}`,
      "-o", `UserKnownHostsFile=${this.knownHostsPath}`,
    ].map(shellQuote).join(" ") + proxy;
  }

  private identity(): GitIdentity {
    return {
      id: "default",
      name: "Default SSH identity",
      storageKey: this.config.identityStorageKey,
      credential: structuredClone(this.config.credential),
      ...(this.config.fingerprint ? { fingerprint: this.config.fingerprint } : {}),
      createdAt: this.config.updatedAt,
      updatedAt: this.config.updatedAt,
    };
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) throw new GitRepositoryConfigurationError("Configure the global SSH identity before using Git");
  }

  private requirePersistentStateDir(): string {
    if (!this.stateDir) throw new GitRepositoryConfigurationError("Persistent state is required to configure Git access");
    return this.stateDir;
  }

  private assertMutable(expectedRevision: number): void {
    if (this.activeOperations > 0) throw new GitRepositoryConfigurationError("Wait for active Git operations before changing the SSH identity");
    this.assertRevision(expectedRevision);
  }

  private assertRevision(expectedRevision: number): void {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new GitRepositoryConfigurationError("expectedRevision must be a non-negative integer");
    }
    if (expectedRevision !== this.config.revision) {
      throw new GitRepositoryOperationError("Git access configuration changed; reload settings and retry");
    }
  }

  private loadOrMigrate(): StoredGitAccessConfig {
    if (pathEntryExists(this.accessPath)) return this.load();
    const now = this.clock.now().toISOString();
    const migrated = this.migrateV2(now) ?? this.migrateLegacy(now) ?? this.defaultConfig(now);
    this.persist(migrated);
    return migrated;
  }

  private defaultConfig(now = this.clock.now().toISOString()): StoredGitAccessConfig {
    return {
      version: accessVersion,
      revision: 0,
      identityStorageKey: "default",
      credential: { kind: "unconfigured" },
      proxyMode: "direct",
      proxyPort: 61090,
      updatedAt: now,
    };
  }

  private load(): StoredGitAccessConfig {
    assertRegularFile(this.accessPath, "Git access configuration");
    try {
      return validateStoredConfig(JSON.parse(readFileSync(this.accessPath, "utf8")));
    } catch (error) {
      if (error instanceof GitRepositoryConfigurationError) throw error;
      throw new GitRepositoryConfigurationError(`Unable to load git/access.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private migrateV2(now: string): StoredGitAccessConfig | undefined {
    const path = join(this.gitStateDir, "registry.json");
    if (!pathEntryExists(path)) return undefined;
    assertRegularFile(path, "Legacy Git registry");
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        version?: string;
        defaults?: { identityId?: string; repositoryId?: string };
        identities?: Array<{ id?: string; storageKey?: string; credential?: GitIdentityCredential; fingerprint?: string }>;
        repositories?: Array<{ id?: string; identityId?: string; proxyMode?: GitProxyMode; proxyPort?: number }>;
      };
      if (raw.version !== "yourchar-git-v2" || !Array.isArray(raw.identities)) return undefined;
      const defaultRepository = raw.repositories?.find((entry) => entry.id === raw.defaults?.repositoryId);
      const identityId = raw.defaults?.identityId ?? defaultRepository?.identityId;
      const identity = raw.identities.find((entry) => entry.id === identityId) ?? raw.identities[0];
      if (!identity?.credential || !identity.storageKey) return undefined;
      const credential = validateCredential(identity.credential, identity.storageKey);
      return {
        version: accessVersion,
        revision: 0,
        identityStorageKey: requireStorageKey(identity.storageKey),
        credential,
        ...(typeof identity.fingerprint === "string" ? { fingerprint: identity.fingerprint } : {}),
        proxyMode: requireProxyMode(defaultRepository?.proxyMode ?? "direct"),
        proxyPort: requireProxyPort(defaultRepository?.proxyPort ?? 61090),
        updatedAt: now,
        migration: { source: "git-registry-v2", migratedAt: now },
      };
    } catch (error) {
      if (error instanceof GitRepositoryConfigurationError) throw error;
      throw new GitRepositoryConfigurationError(`Unable to migrate git/registry.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private migrateLegacy(now: string): StoredGitAccessConfig | undefined {
    const path = join(this.requirePersistentStateDir(), "git-repository.json");
    if (!pathEntryExists(path)) return undefined;
    assertRegularFile(path, "Legacy Git configuration");
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { privateKeyPath?: unknown; proxyMode?: unknown; proxyPort?: unknown };
      const keyPath = typeof raw.privateKeyPath === "string" ? raw.privateKeyPath.trim() : "";
      return {
        version: accessVersion,
        revision: 0,
        identityStorageKey: "default",
        credential: keyPath ? { kind: "external-file", privateKeyPath: normalizePrivateKeyPath(keyPath) } : { kind: "unconfigured" },
        proxyMode: requireProxyMode(raw.proxyMode ?? "direct"),
        proxyPort: requireProxyPort(raw.proxyPort ?? 61090),
        updatedAt: now,
        migration: { source: "git-repository-v1", migratedAt: now },
      };
    } catch (error) {
      if (error instanceof GitRepositoryConfigurationError) throw error;
      throw new GitRepositoryConfigurationError(`Unable to migrate git-repository.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private persist(config: StoredGitAccessConfig): void {
    atomicWriteJson(this.accessPath, config, "Git access configuration");
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = prior.then(() => gate, () => gate);
    this.tails.set(key, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function validateStoredConfig(raw: unknown): StoredGitAccessConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new GitRepositoryConfigurationError("Git access configuration is invalid");
  const value = raw as Partial<StoredGitAccessConfig>;
  if (value.version !== accessVersion || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.updatedAt !== "string") {
    throw new GitRepositoryConfigurationError("Git access configuration schema is invalid");
  }
  const storageKey = requireStorageKey(value.identityStorageKey);
  return {
    version: accessVersion,
    revision: Number(value.revision),
    identityStorageKey: storageKey,
    credential: validateCredential(value.credential, storageKey),
    ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
    proxyMode: requireProxyMode(value.proxyMode),
    proxyPort: requireProxyPort(value.proxyPort),
    updatedAt: value.updatedAt,
    ...(value.migration ? { migration: value.migration } : {}),
  };
}

function validateCredential(value: unknown, storageKey: string): GitIdentityCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitRepositoryConfigurationError("Git credential is invalid");
  const credential = value as Partial<GitIdentityCredential> & { privateKeyPath?: unknown; keyRef?: unknown };
  if (credential.kind === "unconfigured") return { kind: "unconfigured" };
  if (credential.kind === "external-file") return { kind: "external-file", privateKeyPath: normalizePrivateKeyPath(credential.privateKeyPath) };
  if (credential.kind === "managed-ed25519") {
    const expected = `credentials/${storageKey}/id_ed25519`;
    if (credential.keyRef !== expected) throw new GitRepositoryConfigurationError("Managed Git key reference does not match its identity");
    return { kind: "managed-ed25519", keyRef: expected };
  }
  throw new GitRepositoryConfigurationError("Git credential kind is invalid");
}

function isBenignLocalGitConfiguration(key: string, value: string): boolean {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey === "core.repositoryformatversion") return value === "0";
  if (normalizedKey === "core.bare") return value === "false";
  if (normalizedKey === "core.logallrefupdates") return isGitBoolean(value);
  if ([
    "core.filemode",
    "core.ignorecase",
    "core.precomposeunicode",
    "core.symlinks",
  ].includes(normalizedKey)) return isGitBoolean(value);

  if (normalizedKey === "user.name" || normalizedKey === "user.email") {
    return value.length <= 254 && !/[\u0000-\u001f\u007f]/u.test(value);
  }

  const remote = /^remote\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.(url|fetch|tagopt)$/iu.exec(key);
  if (remote) {
    const [, remoteName, field] = remote;
    if (field!.toLowerCase() === "url") {
      try {
        parseRemote(value);
        return true;
      } catch {
        return false;
      }
    }
    if (field!.toLowerCase() === "tagopt") return value === "--no-tags";
    const refspec = /^\+?refs\/heads\/(\*|[^:]+):refs\/remotes\/([^/]+)\/(\*|.+)$/u.exec(value);
    if (!refspec || refspec[2] !== remoteName) return false;
    return isSafeConfiguredBranch(refspec[1]!) && isSafeConfiguredBranch(refspec[3]!);
  }

  const branch = /^branch\.(.+)\.(remote|merge)$/iu.exec(key);
  if (branch && isSafeConfiguredBranch(branch[1]!)) {
    if (branch[2]!.toLowerCase() === "remote") {
      return branchRemoteName(value);
    }
    return value.startsWith("refs/heads/") && isSafeConfiguredBranch(value.slice("refs/heads/".length));
  }
  return false;
}

function isGitBoolean(value: string): boolean {
  return /^(?:true|false|yes|no|on|off|0|1)$/iu.test(value);
}

function isSafeConfiguredBranch(value: string): boolean {
  return value === "*" || (
    safeBranch.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".lock")
  );
}

function branchRemoteName(value: string): boolean {
  return value === "." || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value);
}

function parseRemote(value: unknown): ParsedRemote {
  if (typeof value !== "string" || /[?#\u0000-\u001f\u007f]/u.test(value)) throw new GitRepositoryConfigurationError("Repository URL must be a safe ssh:// URL");
  const match = exactSshRemote.exec(value.trim());
  if (!match) throw new GitRepositoryConfigurationError("Repository URL must be ssh://user@host/owner/repository.git");
  const user = match[1]!;
  const host = match[2]!.toLowerCase();
  const port = match[3] ? Number(match[3]) : 22;
  const path = match[4]!;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new GitRepositoryConfigurationError("Repository SSH port is invalid");
  if (
    host.length > 253 ||
    host.split(".").some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
  ) {
    throw new GitRepositoryConfigurationError("Repository SSH host is invalid");
  }
  if (
    !path.endsWith(".git") ||
    path.startsWith("/") ||
    path.split("/").length < 2 ||
    path.split("/").some((part) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(part))
  ) {
    throw new GitRepositoryConfigurationError("Repository path must be normalized owner/repository.git components");
  }
  const canonicalUrl = `ssh://${user}@${host}${port === 22 ? "" : `:${port}`}/${path}`;
  return { user, host, port, path, canonicalUrl, key: `${user}@${host}:${port}/${path}` };
}

function requireExternalPrivateKey(value: unknown): string {
  const normalized = normalizePrivateKeyPath(value);
  try {
    return assertGitExternalPrivateKey(normalized);
  } catch (error) {
    if (error instanceof GitIdentityKeyError) throw new GitRepositoryConfigurationError(error.message);
    throw error;
  }
}

function normalizePrivateKeyPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value.trim())) throw new GitRepositoryConfigurationError("SSH private key path must be absolute");
  return resolve(value.trim());
}

function requireStorageKey(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value)) throw new GitRepositoryConfigurationError("Git identity storage key is invalid");
  return value;
}

function requireProxyMode(value: unknown): GitProxyMode {
  if (value !== "direct" && value !== "hclient") throw new GitRepositoryConfigurationError("proxyMode must be direct or hclient");
  return value;
}

function requireProxyPort(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new GitRepositoryConfigurationError("proxyPort must be between 1 and 65535");
  return Number(value);
}

function requireBranch(value: string): string {
  if (!safeBranch.test(value) || value.includes("..") || value.includes("//") || value.endsWith(".lock")) throw new GitRepositoryOperationError("Checkout is not on a safe branch");
  return value;
}

function accessRemoteRef(branch: string): string {
  return `refs/remotes/yourchar-access/${requireBranch(branch)}`;
}

function requireCommitMessage(value: unknown): string {
  if (typeof value !== "string") throw new GitRepositoryOperationError("Commit message must be a string");
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumCommitMessageCharacters || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) throw new GitRepositoryOperationError("Commit message is invalid");
  return normalized;
}

function requireObjectId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) throw new GitRepositoryOperationError("Git returned an invalid object ID");
  return value;
}

function assertRelativeGitPath(path: string): void {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new GitRepositoryOperationError(`Unsafe changed path: ${path}`);
}

function scanCredentialContent(bytes: Buffer, path: string): void {
  if (bytes.includes(0)) return;
  const content = bytes.toString("utf8");
  if (sensitiveContentPatterns.some((pattern) => pattern.test(content))) throw new GitRepositoryOperationError(`Refusing credential-like content: ${path}`);
}

function sanitizeAuthorName(value: string): string {
  return String(value).replace(/[\r\n<>]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80) || "Character";
}

function slugIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function ensureRootDirectory(path: string, label: string): string {
  const target = resolve(path);
  if (!pathEntryExists(target)) mkdirSync(target, { recursive: true, mode: 0o700 });
  assertRealDirectory(target, label);
  return target;
}

function ensureManagedDirectory(parent: string, name: string, label: string): string {
  assertRealDirectory(parent, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(name)) throw new GitRepositoryConfigurationError(`${label} directory name is invalid`);
  const target = join(parent, name);
  if (!pathEntryExists(target)) mkdirSync(target, { mode: 0o700 });
  assertRealDirectory(target, label);
  chmodSync(target, 0o700);
  return target;
}

function assertRealDirectory(path: string, label: string): void {
  let stats;
  try { stats = lstatSync(path); } catch { throw new GitRepositoryConfigurationError(`${label} does not exist`); }
  if (!stats.isDirectory() || stats.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new GitRepositoryConfigurationError(`${label} must be a real non-symlink directory`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new GitRepositoryConfigurationError(`${label} must be owned by the YourChar process user`);
}

function assertRegularFile(path: string, label: string): void {
  let stats;
  try { stats = lstatSync(path); } catch { throw new GitRepositoryConfigurationError(`${label} does not exist`); }
  if (!stats.isFile() || stats.isSymbolicLink() || realpathSync(path) !== resolve(path)) throw new GitRepositoryConfigurationError(`${label} must be a regular non-symlink file`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) throw new GitRepositoryConfigurationError(`${label} must be owned by the YourChar process user`);
}

function ensureKnownHosts(path: string, parent: string): void {
  assertRealDirectory(parent, "Git runtime");
  if (!pathEntryExists(path)) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    closeSync(descriptor);
  }
  assertRegularFile(path, "Git known_hosts");
  chmodSync(path, 0o600);
}

function atomicWriteJson(path: string, value: unknown, label: string): void {
  assertRealDirectory(dirname(path), dirname(path));
  if (pathEntryExists(path)) assertRegularFile(path, label);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(5).toString("hex")}`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (!fstatSync(descriptor).isFile()) throw new GitRepositoryConfigurationError(`${label} temporary target is invalid`);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function safeRemoveStaging(staging: string, parent: string): void {
  if (dirname(staging) !== parent || !staging.startsWith(`${parent}${sep}.git-stage-`)) return;
  if (!pathEntryExists(staging)) return;
  const stats = lstatSync(staging);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new GitRepositoryOperationError("Refusing to clean an unsafe clone staging path");
  rmSync(staging, { recursive: true, force: false });
}

function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const nested = relative(resolve(parent), resolve(child));
  return Boolean(nested) && nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function boundText(value: string, bytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= bytes) return { text: value, truncated: false };
  return { text: `${buffer.subarray(0, bytes).toString("utf8")}\n...[truncated]`, truncated: true };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

async function spawnGitCommand(input: Parameters<GitAccessRunner>[0]): Promise<GitCommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: GitCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolvePromise(result!);
    };
    const abort = () => { child.kill("SIGTERM"); finish(new GitRepositoryOperationError("Git operation was cancelled")); };
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) { child.kill("SIGTERM"); finish(new GitRepositoryOperationError("Git command output exceeded the safety limit")); return; }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => finish(new GitRepositoryOperationError(`Unable to run git: ${error.message}`)));
    child.once("close", (code) => finish(undefined, { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode: code ?? -1 }));
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish(new GitRepositoryOperationError(`Git command timed out after ${input.timeoutMs} ms`)); }, input.timeoutMs);
    timer.unref?.();
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
  });
}
