import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, posix, resolve } from "node:path";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import type {
  GitIdentity,
  GitIdentityCreateInput,
  GitIdentityCredential,
  GitIdentityPatch,
  GitProject,
  GitProjectCreateInput,
  GitProjectPatch,
  GitProjectRepositoryBinding,
  GitProjectRepositoryBindingCreateInput,
  GitProjectRepositoryBindingPatch,
  GitProxyMode,
  GitRegistryV2,
  GitRepository,
  GitRepositoryConfig,
  GitRepositoryConfigPatch,
  GitRepositoryCreateInput,
  GitRepositoryPatch,
} from "./types.js";

export const gitRegistryVersion = "yourchar-git-v2" as const;
export const legacyGitIdentityId = "identity_legacy_default";
export const legacyGitProjectId = "project_legacy_default";
export const legacyGitRepositoryId = "repository_legacy_default";
export const legacyGitBindingId = "binding_legacy_default";

const legacyIdentityStorageKey = "identity-legacy-default";
const legacyProjectStorageKey = "project-legacy-default";
const legacyRepositoryStorageKey = "repository-legacy-default";
const maximumRegistryBytes = 2 * 1024 * 1024;
const safeOpaqueId = /^(?:identity|project|repository|binding)_[A-Za-z0-9_-]{4,80}$/u;
const safeStorageKey = /^[a-z0-9][a-z0-9._-]{0,95}$/u;
const safeLegacyRepositoryName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const safeBranchName = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,126}[A-Za-z0-9])?$/u;
const exactSshRemote = /^ssh:\/\/([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?\/(.+)$/u;

export type GitRegistryServiceOptions = {
  stateDir: string;
  clock?: Clock;
};

export type GitRegistryDefaults = {
  identity?: GitIdentity;
  project?: GitProject;
  repository?: GitRepository;
  binding?: GitProjectRepositoryBinding;
};

export type ResolvedGitRepository = {
  repository: GitRepository;
  identity: GitIdentity;
  projects: GitProject[];
  bindings: GitProjectRepositoryBinding[];
};

type LegacyGitRepositoryFile = {
  version?: string;
  repositoryName: string;
  remoteUrl: string;
  branch: string;
  privateKeyPath: string;
  proxyMode: GitProxyMode;
  proxyPort: number;
  updatedAt?: string;
};

export class GitRegistryError extends Error {
  readonly code: "GIT_REGISTRY_INVALID" | "GIT_REGISTRY_NOT_FOUND" | "GIT_REGISTRY_CONFLICT";

  constructor(
    message: string,
    code: "GIT_REGISTRY_INVALID" | "GIT_REGISTRY_NOT_FOUND" | "GIT_REGISTRY_CONFLICT" = "GIT_REGISTRY_INVALID",
  ) {
    super(message);
    this.name = "GitRegistryError";
    this.code = code;
  }
}

/**
 * Atomic v2 registry for Git identities, projects, repositories and their
 * bindings. It owns metadata only: deleting a record never deletes a key or a
 * Workspace checkout.
 */
export class GitRegistryService {
  readonly registryPath: string;
  readonly legacyConfigPath: string;
  private readonly stateDir: string;
  private readonly registryDir: string;
  private readonly clock: Clock;
  private registry: GitRegistryV2;

  constructor(options: GitRegistryServiceOptions) {
    if (!options.stateDir || !isAbsolute(resolve(options.stateDir))) {
      throw new GitRegistryError("stateDir is required");
    }
    this.stateDir = resolve(options.stateDir);
    this.registryDir = resolve(this.stateDir, "git");
    this.registryPath = resolve(this.registryDir, "registry.json");
    this.legacyConfigPath = resolve(this.stateDir, "git-repository.json");
    this.clock = options.clock ?? new SystemClock();
    ensurePrivateDirectory(this.registryDir);
    this.registry = this.loadOrMigrate();
  }

  snapshot(): GitRegistryV2 {
    return clone(this.registry);
  }

  getDefaults(): GitRegistryDefaults {
    const { defaults } = this.registry;
    const identity = defaults.identityId
      ? this.registry.identities.find((entry) => entry.id === defaults.identityId)
      : undefined;
    const project = defaults.projectId
      ? this.registry.projects.find((entry) => entry.id === defaults.projectId)
      : undefined;
    const repository = defaults.repositoryId
      ? this.registry.repositories.find((entry) => entry.id === defaults.repositoryId)
      : undefined;
    const binding = project && repository
      ? this.registry.projectRepositories.find((entry) =>
        entry.projectId === project.id && entry.repositoryId === repository.id
      )
      : undefined;
    return clone({ identity, project, repository, binding });
  }

  resolveRepository(repositoryId?: string): ResolvedGitRepository {
    const selectedId = repositoryId ?? this.registry.defaults.repositoryId;
    if (!selectedId) {
      throw new GitRegistryError("No default Git repository is configured", "GIT_REGISTRY_NOT_FOUND");
    }
    const repository = this.registry.repositories.find((entry) => entry.id === selectedId);
    if (!repository) throw new GitRegistryError(`Git repository not found: ${selectedId}`, "GIT_REGISTRY_NOT_FOUND");
    const identity = this.registry.identities.find((entry) => entry.id === repository.identityId);
    if (!identity) throw new GitRegistryError(`Git identity not found: ${repository.identityId}`, "GIT_REGISTRY_NOT_FOUND");
    const bindings = this.registry.projectRepositories.filter((entry) => entry.repositoryId === repository.id);
    const projectIds = new Set(bindings.map((entry) => entry.projectId));
    const projects = this.registry.projects.filter((entry) => projectIds.has(entry.id));
    return clone({ repository, identity, projects, bindings });
  }

  createIdentity(input: GitIdentityCreateInput): GitIdentity {
    const now = this.now();
    const id = opaqueId("identity");
    const identity: GitIdentity = {
      id,
      name: requireName(input.name, "identity.name"),
      storageKey: uniqueStorageKey(input.name, id, this.registry.identities.map((entry) => entry.storageKey)),
      credential: validateCredential(input.credential ?? { kind: "unconfigured" }),
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((draft) => {
      draft.identities.push(identity);
      if (!draft.defaults.identityId) draft.defaults.identityId = identity.id;
      return identity;
    });
  }

  updateIdentity(identityId: string, patch: GitIdentityPatch): GitIdentity {
    return this.mutate((draft) => {
      const identity = requireEntity(draft.identities, identityId, "identity");
      if (patch.name !== undefined) identity.name = requireName(patch.name, "identity.name");
      if (patch.credential !== undefined) identity.credential = validateCredential(patch.credential);
      identity.updatedAt = this.now();
      return identity;
    });
  }

  /**
   * Host-only credential hook. HTTP/MCP input types deliberately do not carry
   * a fingerprint; the key manager computes it from the actual public key and
   * records it through this method.
   */
  setIdentityCredential(
    identityId: string,
    credential: GitIdentityCredential,
    fingerprint?: string,
  ): GitIdentity {
    return this.mutate((draft) => {
      const identity = requireEntity(draft.identities, identityId, "identity");
      identity.credential = validateCredential(credential);
      if (fingerprint === undefined || credential.kind === "unconfigured") delete identity.fingerprint;
      else identity.fingerprint = requireFingerprint(fingerprint);
      identity.updatedAt = this.now();
      return identity;
    });
  }

  deleteIdentity(identityId: string): GitIdentity {
    return this.mutate((draft) => {
      const identity = requireEntity(draft.identities, identityId, "identity");
      if (draft.repositories.some((entry) => entry.identityId === identityId)) {
        throw new GitRegistryError("Cannot delete a Git identity that is used by a repository", "GIT_REGISTRY_CONFLICT");
      }
      draft.identities = draft.identities.filter((entry) => entry.id !== identityId);
      if (draft.defaults.identityId === identityId) draft.defaults.identityId = draft.identities[0]?.id;
      return identity;
    });
  }

  createProject(input: GitProjectCreateInput): GitProject {
    const now = this.now();
    const id = opaqueId("project");
    const project: GitProject = {
      id,
      name: requireName(input.name, "project.name"),
      storageKey: uniqueStorageKey(input.name, id, this.registry.projects.map((entry) => entry.storageKey)),
      description: requireDescription(input.description ?? ""),
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((draft) => {
      draft.projects.push(project);
      if (!draft.defaults.projectId) draft.defaults.projectId = project.id;
      return project;
    });
  }

  updateProject(projectId: string, patch: GitProjectPatch): GitProject {
    return this.mutate((draft) => {
      const project = requireEntity(draft.projects, projectId, "project");
      if (patch.name !== undefined) project.name = requireName(patch.name, "project.name");
      if (patch.description !== undefined) project.description = requireDescription(patch.description);
      if (patch.archived === true) project.archivedAt = this.now();
      else if (patch.archived === false) delete project.archivedAt;
      project.updatedAt = this.now();
      return project;
    });
  }

  deleteProject(projectId: string): GitProject {
    return this.mutate((draft) => {
      const project = requireEntity(draft.projects, projectId, "project");
      draft.projects = draft.projects.filter((entry) => entry.id !== projectId);
      draft.projectRepositories = draft.projectRepositories.filter((entry) => entry.projectId !== projectId);
      if (draft.defaults.projectId === projectId) {
        draft.defaults.projectId = draft.projects[0]?.id;
        if (draft.defaults.repositoryId && !draft.projectRepositories.some((entry) =>
          entry.projectId === draft.defaults.projectId && entry.repositoryId === draft.defaults.repositoryId
        )) {
          draft.defaults.repositoryId = draft.projectRepositories.find((entry) => entry.projectId === draft.defaults.projectId)?.repositoryId;
        }
      }
      return project;
    });
  }

  createRepository(input: GitRepositoryCreateInput): GitRepository {
    requireEntity(this.registry.identities, input.identityId, "identity");
    const now = this.now();
    const id = opaqueId("repository");
    const storageKey = uniqueStorageKey(input.name, id, this.registry.repositories.map((entry) => entry.storageKey));
    const repository: GitRepository = {
      id,
      name: requireName(input.name, "repository.name"),
      storageKey,
      remoteUrl: requireRemoteUrl(input.remoteUrl ?? ""),
      defaultBranch: requireBranch(input.defaultBranch ?? "main"),
      identityId: input.identityId,
      proxyMode: requireProxyMode(input.proxyMode ?? "direct"),
      proxyPort: requireProxyPort(input.proxyPort ?? 61090),
      checkoutRelativePath: requireCheckoutRelativePath(`repos/${storageKey}`),
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((draft) => {
      draft.repositories.push(repository);
      return repository;
    });
  }

  updateRepository(repositoryId: string, patch: GitRepositoryPatch): GitRepository {
    return this.mutate((draft) => {
      const repository = requireEntity(draft.repositories, repositoryId, "repository");
      if (patch.name !== undefined) repository.name = requireName(patch.name, "repository.name");
      if (patch.remoteUrl !== undefined) repository.remoteUrl = requireRemoteUrl(patch.remoteUrl);
      if (patch.defaultBranch !== undefined) repository.defaultBranch = requireBranch(patch.defaultBranch);
      if (patch.identityId !== undefined) {
        requireEntity(draft.identities, patch.identityId, "identity");
        repository.identityId = patch.identityId;
        if (draft.defaults.repositoryId === repository.id) draft.defaults.identityId = patch.identityId;
      }
      if (patch.proxyMode !== undefined) repository.proxyMode = requireProxyMode(patch.proxyMode);
      if (patch.proxyPort !== undefined) repository.proxyPort = requireProxyPort(patch.proxyPort);
      if (patch.archived === true) repository.archivedAt = this.now();
      else if (patch.archived === false) delete repository.archivedAt;
      repository.updatedAt = this.now();
      return repository;
    });
  }

  deleteRepository(repositoryId: string): GitRepository {
    return this.mutate((draft) => {
      const repository = requireEntity(draft.repositories, repositoryId, "repository");
      draft.repositories = draft.repositories.filter((entry) => entry.id !== repositoryId);
      draft.projectRepositories = draft.projectRepositories.filter((entry) => entry.repositoryId !== repositoryId);
      if (draft.defaults.repositoryId === repositoryId) {
        const defaultProjectId = draft.defaults.projectId;
        draft.defaults.repositoryId = draft.projectRepositories.find((entry) =>
          !defaultProjectId || entry.projectId === defaultProjectId
        )?.repositoryId ?? draft.repositories[0]?.id;
      }
      return repository;
    });
  }

  createBinding(input: GitProjectRepositoryBindingCreateInput): GitProjectRepositoryBinding {
    const project = requireEntity(this.registry.projects, input.projectId, "project");
    const repository = requireEntity(this.registry.repositories, input.repositoryId, "repository");
    if (project.archivedAt || repository.archivedAt) {
      throw new GitRegistryError("Archived Git projects or repositories cannot be bound", "GIT_REGISTRY_CONFLICT");
    }
    if (this.registry.projectRepositories.some((entry) =>
      entry.projectId === project.id && entry.repositoryId === repository.id
    )) {
      throw new GitRegistryError("Project is already bound to this repository", "GIT_REGISTRY_CONFLICT");
    }
    const now = this.now();
    const binding: GitProjectRepositoryBinding = {
      id: opaqueId("binding"),
      projectId: project.id,
      repositoryId: repository.id,
      name: requireName(input.name ?? repository.name, "binding.name"),
      role: requireRole(input.role ?? "primary"),
      isDefault: input.isDefault ?? !this.registry.projectRepositories.some((entry) => entry.projectId === project.id),
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((draft) => {
      if (binding.isDefault) {
        for (const entry of draft.projectRepositories) {
          if (entry.projectId === binding.projectId) entry.isDefault = false;
        }
      }
      draft.projectRepositories.push(binding);
      if (binding.isDefault && draft.defaults.projectId === binding.projectId && !draft.defaults.repositoryId) {
        draft.defaults.repositoryId = binding.repositoryId;
        draft.defaults.identityId = repository.identityId;
      }
      return binding;
    });
  }

  updateBinding(bindingId: string, patch: GitProjectRepositoryBindingPatch): GitProjectRepositoryBinding {
    return this.mutate((draft) => {
      const binding = requireEntity(draft.projectRepositories, bindingId, "binding");
      if (patch.name !== undefined) binding.name = requireName(patch.name, "binding.name");
      if (patch.role !== undefined) binding.role = requireRole(patch.role);
      if (patch.isDefault === true) {
        for (const entry of draft.projectRepositories) {
          if (entry.projectId === binding.projectId) entry.isDefault = false;
        }
        binding.isDefault = true;
      } else if (patch.isDefault === false) {
        binding.isDefault = false;
      }
      binding.updatedAt = this.now();
      return binding;
    });
  }

  deleteBinding(bindingId: string): GitProjectRepositoryBinding {
    return this.mutate((draft) => {
      const binding = requireEntity(draft.projectRepositories, bindingId, "binding");
      draft.projectRepositories = draft.projectRepositories.filter((entry) => entry.id !== bindingId);
      if (binding.isDefault) {
        const replacement = draft.projectRepositories.find((entry) => entry.projectId === binding.projectId);
        if (replacement) replacement.isDefault = true;
      }
      if (draft.defaults.projectId === binding.projectId && draft.defaults.repositoryId === binding.repositoryId) {
        draft.defaults.repositoryId = draft.projectRepositories.find((entry) => entry.projectId === binding.projectId)?.repositoryId;
      }
      return binding;
    });
  }

  setDefaults(input: { identityId?: string; projectId?: string; repositoryId?: string }): GitRegistryDefaults {
    this.mutate((draft) => {
      if (input.identityId !== undefined) {
        requireEntity(draft.identities, input.identityId, "identity");
        draft.defaults.identityId = input.identityId;
      }
      if (input.projectId !== undefined) {
        const project = requireEntity(draft.projects, input.projectId, "project");
        if (project.archivedAt) throw new GitRegistryError("Archived Git project cannot be the default", "GIT_REGISTRY_CONFLICT");
        draft.defaults.projectId = project.id;
      }
      if (input.repositoryId !== undefined) {
        const repository = requireEntity(draft.repositories, input.repositoryId, "repository");
        if (repository.archivedAt) throw new GitRegistryError("Archived Git repository cannot be the default", "GIT_REGISTRY_CONFLICT");
        draft.defaults.repositoryId = repository.id;
        draft.defaults.identityId = repository.identityId;
      }
      if (draft.defaults.projectId && draft.defaults.repositoryId && !draft.projectRepositories.some((entry) =>
        entry.projectId === draft.defaults.projectId && entry.repositoryId === draft.defaults.repositoryId
      )) {
        throw new GitRegistryError("Default repository must be bound to the default project", "GIT_REGISTRY_CONFLICT");
      }
      return undefined;
    });
    return this.getDefaults();
  }

  getLegacyConfig(): GitRepositoryConfig {
    const defaults = this.getDefaults();
    const repository = defaults.repository;
    const identity = repository
      ? this.registry.identities.find((entry) => entry.id === repository.identityId)
      : defaults.identity;
    const privateKeyPath = identity?.credential.kind === "external-file"
      ? identity.credential.privateKeyPath
      : "";
    return {
      repositoryName: repository?.name ?? "Review",
      remoteUrl: repository?.remoteUrl ?? "",
      branch: repository?.defaultBranch ?? "main",
      privateKeyPath,
      proxyMode: repository?.proxyMode ?? "direct",
      proxyPort: repository?.proxyPort ?? 61090,
      configured: Boolean(repository?.remoteUrl && identity && identity.credential.kind !== "unconfigured"),
      ...(repository?.updatedAt || identity?.updatedAt
        ? { updatedAt: latestTimestamp(repository?.updatedAt, identity?.updatedAt) }
        : {}),
    };
  }

  patchLegacyConfig(patch: GitRepositoryConfigPatch): GitRepositoryConfig {
    this.ensureLegacyFacadeResources();
    const defaults = this.getDefaults();
    if (!defaults.repository || !defaults.identity) {
      throw new GitRegistryError("Legacy Git defaults could not be initialized");
    }
    this.mutate((draft) => {
      const repository = requireEntity(draft.repositories, defaults.repository!.id, "repository");
      const identity = requireEntity(draft.identities, repository.identityId, "identity");
      const now = this.now();
      if (patch.repositoryName !== undefined) repository.name = requireName(patch.repositoryName, "repository.name");
      if (patch.remoteUrl !== undefined) repository.remoteUrl = requireRemoteUrl(patch.remoteUrl);
      if (patch.branch !== undefined) repository.defaultBranch = requireBranch(patch.branch);
      if (patch.proxyMode !== undefined) repository.proxyMode = requireProxyMode(patch.proxyMode);
      if (patch.proxyPort !== undefined) repository.proxyPort = requireProxyPort(patch.proxyPort);
      if (patch.privateKeyPath !== undefined) {
        const privateKeyPath = requirePrivateKeyPath(patch.privateKeyPath);
        identity.credential = privateKeyPath
          ? { kind: "external-file", privateKeyPath }
          : { kind: "unconfigured" };
        delete identity.fingerprint;
        identity.updatedAt = now;
      }
      repository.updatedAt = now;
      return undefined;
    });
    return this.getLegacyConfig();
  }

  private ensureLegacyFacadeResources(): void {
    if (this.registry.defaults.repositoryId) return;
    const identity = this.registry.defaults.identityId
      ? requireEntity(this.registry.identities, this.registry.defaults.identityId, "identity")
      : this.createIdentity({ name: "Default SSH identity" });
    const project = this.registry.defaults.projectId
      ? requireEntity(this.registry.projects, this.registry.defaults.projectId, "project")
      : this.createProject({ name: "Review" });
    const repository = this.createRepository({ name: "Review", identityId: identity.id });
    this.createBinding({ projectId: project.id, repositoryId: repository.id, isDefault: true });
    this.setDefaults({ identityId: identity.id, projectId: project.id, repositoryId: repository.id });
  }

  private loadOrMigrate(): GitRegistryV2 {
    if (existsSync(this.registryPath)) {
      const registry = parseRegistry(readSecureFile(this.registryPath, maximumRegistryBytes));
      chmodSync(this.registryPath, 0o600);
      return registry;
    }
    const registry = existsSync(this.legacyConfigPath)
      ? migrateLegacyRegistry(readSecureFile(this.legacyConfigPath, maximumRegistryBytes), this.now())
      : emptyRegistry(this.now());
    this.persist(registry);
    return registry;
  }

  private mutate<T>(operation: (draft: GitRegistryV2) => T): T {
    const draft = clone(this.registry);
    const result = operation(draft);
    draft.revision += 1;
    draft.updatedAt = this.now();
    const validated = validateRegistry(draft);
    this.persist(validated);
    this.registry = validated;
    return clone(result);
  }

  private persist(registry: GitRegistryV2): void {
    ensurePrivateDirectory(this.registryDir);
    const validated = validateRegistry(registry);
    atomicWriteJson(this.registryPath, validated);
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function emptyRegistry(now: string): GitRegistryV2 {
  return {
    version: gitRegistryVersion,
    revision: 0,
    defaults: {},
    identities: [],
    projects: [],
    repositories: [],
    projectRepositories: [],
    createdAt: now,
    updatedAt: now,
  };
}

function migrateLegacyRegistry(source: Buffer, migratedAt: string): GitRegistryV2 {
  const legacy = parseLegacyConfig(source);
  const identity: GitIdentity = {
    id: legacyGitIdentityId,
    name: `${legacy.repositoryName} SSH identity`,
    storageKey: legacyIdentityStorageKey,
    credential: legacy.privateKeyPath
      ? { kind: "external-file", privateKeyPath: legacy.privateKeyPath }
      : { kind: "unconfigured" },
    createdAt: legacy.updatedAt ?? migratedAt,
    updatedAt: legacy.updatedAt ?? migratedAt,
  };
  const project: GitProject = {
    id: legacyGitProjectId,
    name: legacy.repositoryName,
    storageKey: legacyProjectStorageKey,
    description: "Migrated from the legacy single-repository Git configuration.",
    createdAt: legacy.updatedAt ?? migratedAt,
    updatedAt: legacy.updatedAt ?? migratedAt,
  };
  const repository: GitRepository = {
    id: legacyGitRepositoryId,
    name: legacy.repositoryName,
    storageKey: legacyRepositoryStorageKey,
    remoteUrl: legacy.remoteUrl,
    defaultBranch: legacy.branch,
    identityId: identity.id,
    proxyMode: legacy.proxyMode,
    proxyPort: legacy.proxyPort,
    checkoutRelativePath: `repos/${legacy.repositoryName}`,
    createdAt: legacy.updatedAt ?? migratedAt,
    updatedAt: legacy.updatedAt ?? migratedAt,
  };
  const binding: GitProjectRepositoryBinding = {
    id: legacyGitBindingId,
    projectId: project.id,
    repositoryId: repository.id,
    name: repository.name,
    role: "primary",
    isDefault: true,
    createdAt: legacy.updatedAt ?? migratedAt,
    updatedAt: legacy.updatedAt ?? migratedAt,
  };
  return validateRegistry({
    version: gitRegistryVersion,
    revision: 1,
    defaults: { identityId: identity.id, projectId: project.id, repositoryId: repository.id },
    identities: [identity],
    projects: [project],
    repositories: [repository],
    projectRepositories: [binding],
    createdAt: migratedAt,
    updatedAt: migratedAt,
    migration: {
      source: "yourchar-git-v1",
      sourceFile: "git-repository.json",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      migratedAt,
    },
  });
}

function parseLegacyConfig(source: Buffer): LegacyGitRepositoryFile {
  let raw: unknown;
  try {
    raw = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new GitRegistryError(`Unable to parse legacy git-repository.json: ${errorMessage(error)}`);
  }
  const record = requireRecord(raw, "legacy Git configuration");
  assertOnlyKeys(record, [
    "version", "repositoryName", "remoteUrl", "branch", "privateKeyPath", "proxyMode", "proxyPort", "updatedAt",
  ], "legacy Git configuration");
  if (record.version !== undefined && record.version !== "yourchar-git-v1") {
    throw new GitRegistryError("Unsupported legacy Git configuration version");
  }
  const repositoryName = record.repositoryName === undefined ? "Review" : requireLegacyRepositoryName(record.repositoryName);
  return {
    ...(record.version === "yourchar-git-v1" ? { version: record.version } : {}),
    repositoryName,
    remoteUrl: requireRemoteUrl(record.remoteUrl ?? ""),
    branch: requireBranch(record.branch ?? "main"),
    privateKeyPath: requirePrivateKeyPath(record.privateKeyPath ?? ""),
    proxyMode: requireProxyMode(record.proxyMode ?? "direct"),
    proxyPort: requireProxyPort(record.proxyPort ?? 61090),
    ...(record.updatedAt === undefined ? {} : { updatedAt: requireTimestamp(record.updatedAt, "updatedAt") }),
  };
}

function parseRegistry(source: Buffer): GitRegistryV2 {
  let raw: unknown;
  try {
    raw = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new GitRegistryError(`Unable to parse Git registry: ${errorMessage(error)}`);
  }
  return validateRegistry(raw);
}

function validateRegistry(value: unknown): GitRegistryV2 {
  const raw = requireRecord(value, "Git registry");
  assertOnlyKeys(raw, [
    "version", "revision", "defaults", "identities", "projects", "repositories", "projectRepositories",
    "createdAt", "updatedAt", "migration",
  ], "Git registry");
  if (raw.version !== gitRegistryVersion) throw new GitRegistryError("Unsupported Git registry version");
  const revision = requireNonNegativeInteger(raw.revision, "registry.revision");
  const defaults = parseDefaults(raw.defaults);
  const identities = requireArray(raw.identities, "registry.identities").map(parseIdentity);
  const projects = requireArray(raw.projects, "registry.projects").map(parseProject);
  const repositories = requireArray(raw.repositories, "registry.repositories").map(parseRepository);
  const projectRepositories = requireArray(raw.projectRepositories, "registry.projectRepositories").map(parseBinding);
  assertUnique(identities, "identity");
  assertUnique(projects, "project");
  assertUnique(repositories, "repository", true);
  assertUnique(projectRepositories, "binding");
  const identityIds = new Set(identities.map((entry) => entry.id));
  const projectIds = new Set(projects.map((entry) => entry.id));
  const repositoryIds = new Set(repositories.map((entry) => entry.id));
  for (const identity of identities) {
    if (
      identity.credential.kind === "managed-ed25519" &&
      identity.credential.keyRef !== `credentials/${identity.storageKey}/id_ed25519`
    ) {
      throw new GitRegistryError(`Managed key reference does not belong to identity ${identity.id}`);
    }
  }
  for (const repository of repositories) {
    if (!identityIds.has(repository.identityId)) {
      throw new GitRegistryError(`Repository ${repository.id} references missing identity ${repository.identityId}`);
    }
  }
  const boundPairs = new Set<string>();
  const defaultProjects = new Set<string>();
  for (const binding of projectRepositories) {
    if (!projectIds.has(binding.projectId) || !repositoryIds.has(binding.repositoryId)) {
      throw new GitRegistryError(`Binding ${binding.id} references a missing project or repository`);
    }
    const pair = `${binding.projectId}\0${binding.repositoryId}`;
    if (boundPairs.has(pair)) throw new GitRegistryError("A repository may be bound to a project only once");
    boundPairs.add(pair);
    if (binding.isDefault) {
      if (defaultProjects.has(binding.projectId)) throw new GitRegistryError("A project may have only one default repository");
      defaultProjects.add(binding.projectId);
    }
  }
  if (defaults.identityId && !identityIds.has(defaults.identityId)) throw new GitRegistryError("Default Git identity does not exist");
  if (defaults.projectId && !projectIds.has(defaults.projectId)) throw new GitRegistryError("Default Git project does not exist");
  if (defaults.repositoryId && !repositoryIds.has(defaults.repositoryId)) throw new GitRegistryError("Default Git repository does not exist");
  if (defaults.projectId && defaults.repositoryId && !boundPairs.has(`${defaults.projectId}\0${defaults.repositoryId}`)) {
    throw new GitRegistryError("Default Git repository must be bound to the default project");
  }
  const migration = raw.migration === undefined ? undefined : parseMigration(raw.migration);
  return {
    version: gitRegistryVersion,
    revision,
    defaults,
    identities,
    projects,
    repositories,
    projectRepositories,
    createdAt: requireTimestamp(raw.createdAt, "registry.createdAt"),
    updatedAt: requireTimestamp(raw.updatedAt, "registry.updatedAt"),
    ...(migration ? { migration } : {}),
  };
}

function parseDefaults(value: unknown): GitRegistryV2["defaults"] {
  const raw = requireRecord(value, "registry.defaults");
  assertOnlyKeys(raw, ["identityId", "projectId", "repositoryId"], "registry.defaults");
  return {
    ...(raw.identityId === undefined ? {} : { identityId: requireOpaqueId(raw.identityId, "identity") }),
    ...(raw.projectId === undefined ? {} : { projectId: requireOpaqueId(raw.projectId, "project") }),
    ...(raw.repositoryId === undefined ? {} : { repositoryId: requireOpaqueId(raw.repositoryId, "repository") }),
  };
}

function parseIdentity(value: unknown): GitIdentity {
  const raw = requireRecord(value, "Git identity");
  assertOnlyKeys(raw, ["id", "name", "storageKey", "credential", "fingerprint", "createdAt", "updatedAt"], "Git identity");
  return {
    id: requireOpaqueId(raw.id, "identity"),
    name: requireName(raw.name, "identity.name"),
    storageKey: requireStorageKey(raw.storageKey, "identity.storageKey"),
    credential: validateCredential(raw.credential),
    ...(raw.fingerprint === undefined ? {} : { fingerprint: requireFingerprint(raw.fingerprint) }),
    createdAt: requireTimestamp(raw.createdAt, "identity.createdAt"),
    updatedAt: requireTimestamp(raw.updatedAt, "identity.updatedAt"),
  };
}

function parseProject(value: unknown): GitProject {
  const raw = requireRecord(value, "Git project");
  assertOnlyKeys(raw, ["id", "name", "storageKey", "description", "createdAt", "updatedAt", "archivedAt"], "Git project");
  return {
    id: requireOpaqueId(raw.id, "project"),
    name: requireName(raw.name, "project.name"),
    storageKey: requireStorageKey(raw.storageKey, "project.storageKey"),
    description: requireDescription(raw.description),
    createdAt: requireTimestamp(raw.createdAt, "project.createdAt"),
    updatedAt: requireTimestamp(raw.updatedAt, "project.updatedAt"),
    ...(raw.archivedAt === undefined ? {} : { archivedAt: requireTimestamp(raw.archivedAt, "project.archivedAt") }),
  };
}

function parseRepository(value: unknown): GitRepository {
  const raw = requireRecord(value, "Git repository");
  assertOnlyKeys(raw, [
    "id", "name", "storageKey", "remoteUrl", "defaultBranch", "identityId", "proxyMode", "proxyPort",
    "checkoutRelativePath", "createdAt", "updatedAt", "archivedAt",
  ], "Git repository");
  return {
    id: requireOpaqueId(raw.id, "repository"),
    name: requireName(raw.name, "repository.name"),
    storageKey: requireStorageKey(raw.storageKey, "repository.storageKey"),
    remoteUrl: requireRemoteUrl(raw.remoteUrl),
    defaultBranch: requireBranch(raw.defaultBranch),
    identityId: requireOpaqueId(raw.identityId, "identity"),
    proxyMode: requireProxyMode(raw.proxyMode),
    proxyPort: requireProxyPort(raw.proxyPort),
    checkoutRelativePath: requireCheckoutRelativePath(raw.checkoutRelativePath),
    createdAt: requireTimestamp(raw.createdAt, "repository.createdAt"),
    updatedAt: requireTimestamp(raw.updatedAt, "repository.updatedAt"),
    ...(raw.archivedAt === undefined ? {} : { archivedAt: requireTimestamp(raw.archivedAt, "repository.archivedAt") }),
  };
}

function parseBinding(value: unknown): GitProjectRepositoryBinding {
  const raw = requireRecord(value, "Git project/repository binding");
  assertOnlyKeys(raw, ["id", "projectId", "repositoryId", "name", "role", "isDefault", "createdAt", "updatedAt"], "Git project/repository binding");
  if (typeof raw.isDefault !== "boolean") throw new GitRegistryError("binding.isDefault must be a boolean");
  return {
    id: requireOpaqueId(raw.id, "binding"),
    projectId: requireOpaqueId(raw.projectId, "project"),
    repositoryId: requireOpaqueId(raw.repositoryId, "repository"),
    name: requireName(raw.name, "binding.name"),
    role: requireRole(raw.role),
    isDefault: raw.isDefault,
    createdAt: requireTimestamp(raw.createdAt, "binding.createdAt"),
    updatedAt: requireTimestamp(raw.updatedAt, "binding.updatedAt"),
  };
}

function parseMigration(value: unknown): NonNullable<GitRegistryV2["migration"]> {
  const raw = requireRecord(value, "registry.migration");
  assertOnlyKeys(raw, ["source", "sourceFile", "sourceSha256", "migratedAt"], "registry.migration");
  if (raw.source !== "yourchar-git-v1" || raw.sourceFile !== "git-repository.json" ||
      typeof raw.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sourceSha256)) {
    throw new GitRegistryError("Invalid Git registry migration metadata");
  }
  return {
    source: raw.source,
    sourceFile: raw.sourceFile,
    sourceSha256: raw.sourceSha256,
    migratedAt: requireTimestamp(raw.migratedAt, "migration.migratedAt"),
  };
}

function validateCredential(value: unknown): GitIdentityCredential {
  const raw = requireRecord(value, "Git identity credential");
  if (raw.kind === "unconfigured") {
    assertOnlyKeys(raw, ["kind"], "Git identity credential");
    return { kind: "unconfigured" };
  }
  if (raw.kind === "external-file") {
    assertOnlyKeys(raw, ["kind", "privateKeyPath"], "Git identity credential");
    return { kind: "external-file", privateKeyPath: requirePrivateKeyPath(raw.privateKeyPath, false) };
  }
  if (raw.kind === "managed-ed25519") {
    assertOnlyKeys(raw, ["kind", "keyRef"], "Git identity credential");
    return { kind: "managed-ed25519", keyRef: requireManagedKeyRef(raw.keyRef) };
  }
  throw new GitRegistryError("Unsupported Git identity credential kind");
}

function requireManagedKeyRef(value: unknown): string {
  if (typeof value !== "string" || !/^credentials\/[a-z0-9][a-z0-9._-]{0,95}\/id_ed25519$/u.test(value)) {
    throw new GitRegistryError("Managed Git key reference is invalid");
  }
  return value;
}

function requirePrivateKeyPath(value: unknown, allowEmpty = true): string {
  if (typeof value !== "string") throw new GitRegistryError("Git private key path must be a string");
  const normalized = value.trim();
  if (!normalized && allowEmpty) return "";
  if (!normalized || !isAbsolute(normalized) || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new GitRegistryError("Git private key path must be absolute");
  }
  return resolve(normalized);
}

function requireRemoteUrl(value: unknown): string {
  if (typeof value !== "string") throw new GitRegistryError("Git remote URL must be a string");
  const normalized = value.trim();
  if (!normalized) return "";
  if (/[?#\u0000-\u001f\u007f]/u.test(normalized)) throw new GitRegistryError("Git remote URL contains unsafe characters");
  const match = exactSshRemote.exec(normalized);
  if (!match) throw new GitRegistryError("Git remote URL must use ssh://user@host/path/repository.git");
  const port = match[3] ? Number(match[3]) : 22;
  const path = match[4];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !path.endsWith(".git") || path.startsWith("/") ||
      path.split("/").some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")) {
    throw new GitRegistryError("Git remote URL is not a normalized SSH repository URL");
  }
  return normalized;
}

function requireBranch(value: unknown): string {
  if (typeof value !== "string" || !safeBranchName.test(value) || value.includes("..") || value.includes("//") || value.endsWith(".lock")) {
    throw new GitRegistryError("Git default branch is invalid");
  }
  return value;
}

function requireCheckoutRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("repos/") || value.includes("\\") || posix.isAbsolute(value) ||
      posix.normalize(value) !== value || value.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitRegistryError("Repository checkout path must be a normalized Workspace-relative repos/... path");
  }
  return value;
}

function requireName(value: unknown, label: string): string {
  if (typeof value !== "string") throw new GitRegistryError(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new GitRegistryError(`${label} must contain 1-120 printable characters`);
  }
  return normalized;
}

function requireDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new GitRegistryError("project.description must contain at most 4000 safe characters");
  }
  return value;
}

function requireRole(value: unknown): string {
  if (typeof value !== "string") throw new GitRegistryError("binding.role must be a string");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) throw new GitRegistryError("binding.role is invalid");
  return normalized;
}

function requireFingerprint(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new GitRegistryError("Git identity fingerprint is invalid");
  }
  return value.trim();
}

function requireLegacyRepositoryName(value: unknown): string {
  if (typeof value !== "string" || !safeLegacyRepositoryName.test(value)) {
    throw new GitRegistryError("Legacy repositoryName is invalid");
  }
  return value;
}

function requireProxyMode(value: unknown): GitProxyMode {
  if (value !== "direct" && value !== "hclient") throw new GitRegistryError("Git proxy mode must be direct or hclient");
  return value;
}

function requireProxyPort(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 65535) throw new GitRegistryError("Git proxy port is invalid");
  return Number(value);
}

function requireOpaqueId(value: unknown, kind: "identity" | "project" | "repository" | "binding"): string {
  if (typeof value !== "string" || !safeOpaqueId.test(value) || !value.startsWith(`${kind}_`)) {
    throw new GitRegistryError(`Invalid ${kind} ID`);
  }
  return value;
}

function requireStorageKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !safeStorageKey.test(value) || value === "." || value === ".." || value.endsWith(".lock")) {
    throw new GitRegistryError(`${label} is invalid`);
  }
  return value;
}

function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new GitRegistryError(`${label} must be an ISO timestamp`);
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new GitRegistryError(`${label} must be a non-negative integer`);
  return Number(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitRegistryError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new GitRegistryError(`${label} must be an array`);
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unexpected) throw new GitRegistryError(`${label} contains unsupported field ${unexpected}`);
}

function assertUnique(
  entries: Array<{ id: string; storageKey?: string; checkoutRelativePath?: string }>,
  label: string,
  checkCheckout = false,
): void {
  const ids = new Set<string>();
  const storageKeys = new Set<string>();
  const checkoutPaths = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new GitRegistryError(`Duplicate ${label} ID ${entry.id}`);
    ids.add(entry.id);
    if (entry.storageKey) {
      if (storageKeys.has(entry.storageKey)) throw new GitRegistryError(`Duplicate ${label} storageKey ${entry.storageKey}`);
      storageKeys.add(entry.storageKey);
    }
    if (checkCheckout && entry.checkoutRelativePath) {
      if (checkoutPaths.has(entry.checkoutRelativePath)) throw new GitRegistryError(`Duplicate repository checkout path ${entry.checkoutRelativePath}`);
      checkoutPaths.add(entry.checkoutRelativePath);
    }
  }
}

function requireEntity<T extends { id: string }>(entries: T[], id: string, kind: string): T {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) throw new GitRegistryError(`Git ${kind} not found: ${id}`, "GIT_REGISTRY_NOT_FOUND");
  return entry;
}

function opaqueId(kind: "identity" | "project" | "repository" | "binding"): string {
  return `${kind}_${randomBytes(12).toString("base64url")}`;
}

function uniqueStorageKey(name: string, id: string, existing: string[]): string {
  const base = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^[._-]+|[._-]+$/gu, "").slice(0, 72) || "git";
  const suffix = id.slice(-8).toLowerCase();
  let candidate = `${base}-${suffix}`;
  let counter = 2;
  while (existing.includes(candidate)) candidate = `${base.slice(0, 68)}-${suffix}-${counter++}`;
  return requireStorageKey(candidate, "storageKey");
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new GitRegistryError(`Git registry directory is not a real directory: ${path}`);
  chmodSync(path, 0o700);
}

function readSecureFile(path: string, maximumBytes: number): Buffer {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new GitRegistryError(`Git registry source is not a regular file: ${path}`);
  if (stats.size > maximumBytes) throw new GitRegistryError(`Git registry source exceeds ${maximumBytes} bytes`);
  return readFileSync(path);
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new GitRegistryError("Git registry temporary target is not a regular file");
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(descriptor);
  try {
    const parent = dirname(path);
    ensurePrivateDirectory(parent);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
    const directoryDescriptor = openSync(parent, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function latestTimestamp(first?: string, second?: string): string {
  if (!first) return second as string;
  if (!second) return first;
  return Date.parse(first) >= Date.parse(second) ? first : second;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
