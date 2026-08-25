export type GitProxyMode = "direct" | "hclient";

/**
 * Persistent Git configuration is intentionally split into resources. A
 * credential may be shared by several repositories, and a repository may be
 * attached to several projects without duplicating its checkout.
 */
export type GitIdentityCredential =
  | { kind: "unconfigured" }
  | { kind: "external-file"; privateKeyPath: string }
  | { kind: "managed-ed25519"; keyRef: string };

export type GitIdentity = {
  id: string;
  name: string;
  /** Stable, filesystem-safe key. Renaming an identity never changes it. */
  storageKey: string;
  credential: GitIdentityCredential;
  fingerprint?: string;
  createdAt: string;
  updatedAt: string;
};

export type GitProject = {
  id: string;
  name: string;
  /** Stable, filesystem-safe key. Renaming a project never changes it. */
  storageKey: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type GitRepository = {
  id: string;
  name: string;
  /** Stable, filesystem-safe key. Renaming a repository never changes it. */
  storageKey: string;
  remoteUrl: string;
  defaultBranch: string;
  identityId: string;
  proxyMode: GitProxyMode;
  proxyPort: number;
  /** Workspace-relative path to the primary checkout. */
  checkoutRelativePath: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type GitProjectRepositoryBinding = {
  id: string;
  projectId: string;
  repositoryId: string;
  /** Editable project-local label, independent of both resource names. */
  name: string;
  role: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type GitRegistryMigration = {
  source: "yourchar-git-v1";
  sourceFile: "git-repository.json";
  sourceSha256: string;
  migratedAt: string;
};

export type GitRegistryV2 = {
  version: "yourchar-git-v2";
  revision: number;
  defaults: {
    identityId?: string;
    projectId?: string;
    repositoryId?: string;
  };
  identities: GitIdentity[];
  projects: GitProject[];
  repositories: GitRepository[];
  projectRepositories: GitProjectRepositoryBinding[];
  createdAt: string;
  updatedAt: string;
  migration?: GitRegistryMigration;
};

export type GitIdentityCreateInput = {
  name: string;
  credential?: GitIdentityCredential;
};

export type GitIdentityPatch = {
  name?: string;
  credential?: GitIdentityCredential;
};

export type GitProjectCreateInput = {
  name: string;
  description?: string;
};

export type GitProjectPatch = {
  name?: string;
  description?: string;
  archived?: boolean;
};

export type GitRepositoryCreateInput = {
  name: string;
  remoteUrl?: string;
  defaultBranch?: string;
  identityId: string;
  proxyMode?: GitProxyMode;
  proxyPort?: number;
};

export type GitRepositoryPatch = {
  name?: string;
  remoteUrl?: string;
  defaultBranch?: string;
  identityId?: string;
  proxyMode?: GitProxyMode;
  proxyPort?: number;
  archived?: boolean;
};

export type GitProjectRepositoryBindingCreateInput = {
  projectId: string;
  repositoryId: string;
  name?: string;
  role?: string;
  isDefault?: boolean;
};

export type GitProjectRepositoryBindingPatch = {
  name?: string;
  role?: string;
  isDefault?: boolean;
};

/** Unprefixed aliases make the registry's domain vocabulary convenient. */
export type Project = GitProject;
export type Repository = GitRepository;
export type ProjectRepositoryBinding = GitProjectRepositoryBinding;

export type GitRepositoryConfig = {
  repositoryName: string;
  remoteUrl: string;
  branch: string;
  privateKeyPath: string;
  proxyMode: GitProxyMode;
  proxyPort: number;
  configured: boolean;
  updatedAt?: string;
};

export type GitRepositoryConfigPatch = {
  repositoryName?: string;
  remoteUrl?: string;
  branch?: string;
  privateKeyPath?: string;
  proxyMode?: GitProxyMode;
  proxyPort?: number;
};

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type GitRepositoryStatus = {
  repositoryName: string;
  workspacePath: string;
  branch: string;
  head?: string;
  clean: boolean;
  summary: string;
};

export type GitRepositorySyncResult = GitRepositoryStatus & {
  cloned: boolean;
  changed: boolean;
};

export type GitCommitResult = {
  repositoryName: string;
  branch: string;
  commit: string;
  summary: string;
};

export type GitPushResult = {
  repositoryName: string;
  branch: string;
  commit: string;
  summary: string;
};

/**
 * The only user-facing Git configuration in the simplified runtime.  The
 * credential grants the same access as the user's normal SSH identity; remote
 * repositories are deliberately not duplicated into an application registry.
 */
export type GitAccessCredential =
  | { kind: "unconfigured" }
  | { kind: "external-file"; privateKeyPath: string }
  | { kind: "managed-ed25519" };

export type GitAccessConfig = {
  revision: number;
  credential: GitAccessCredential;
  fingerprint?: string;
  proxyMode: GitProxyMode;
  proxyPort: number;
  configured: boolean;
};

export type GitAccessConfigPatch = {
  credential?:
    | { kind: "unconfigured" }
    | { kind: "external-file"; privateKeyPath: string };
  proxyMode?: GitProxyMode;
  proxyPort?: number;
};

export type GitAccessRepository = {
  /** Canonical ssh:// URL. This is a selector, not an authorization record. */
  remoteUrl: string;
  host: string;
  owner: string;
  name: string;
  /** Workspace-relative and safe to show to the model. */
  workspacePath: string;
  branch: string;
  head: string;
  clean: boolean;
  summary: string;
};

export type GitAccessOpenResult = GitAccessRepository & {
  cloned: boolean;
  changed: boolean;
};

export type GitAccessCommitResult = GitAccessRepository & {
  commit: string;
  changedPaths: number;
};

export type GitAccessPushResult = GitAccessRepository & {
  commit: string;
  pushedCommits: number;
};
