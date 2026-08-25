# Git Repository Access

YourChar's Git integration is intentionally shaped like a personal development
machine: configure one SSH identity, give a character an SSH repository URL,
and let it clone, edit, commit, and push inside a fixed Workspace directory.
There is no Project model, repository registry, binding table, deploy-key
requirement, or second application-level repository whitelist. The Git server
and the configured SSH identity remain the authority for repository access.

Git is available only to an explicitly enabled normal character conversation.
Secret and incognito conversations never receive Git tools, and generic
subagents do not inherit them.

## One-time settings

Open **Settings → Repository** and configure:

- either the absolute path to the user's existing SSH private key or one
  YourChar-managed Ed25519 key;
- direct SSH or the local hclient SSH transport.

An external key must be an absolute, regular, non-symlink file owned by the
YourChar service user without group or other permissions. It can be the same
ordinary SSH identity that the user already uses for Git; a per-repository
deploy key is optional, not required.

If requested, YourChar generates a managed key at
`<stateDir>/git/credentials/default/id_ed25519`. Private-key bytes are never
returned to the browser, model, MCP client, Agent sandbox, Workspace, or audit
payload. Only its public key and fingerprint can be copied out. The persisted
non-secret settings and external-key path live in
`<stateDir>/git/access.json`.

## Repository workflow

Give the character a canonical SSH URL in normal conversation, for example:

```text
请拉取 ssh://git@git.example.test/alice/review.git，修改论文评审文件，完成后 commit 并 push。
```

The URL selects the repository; it is not copied into a YourChar whitelist.
The host derives the checkout path from the canonical host and remote-path
components and keeps it below:

```text
<stateDir>/workspace/repos/<lowercase-host[-pPORT]>/<ssh-user>/<remote-path-without-.git>/
```

The model cannot choose another filesystem path. If the checkout does not
exist, YourChar clones it. If it already exists, YourChar verifies that its
origin still matches the requested canonical URL and safely fast-forwards a
clean checkout when possible. Dirty or diverged checkouts fail closed for the
user or character to resolve. The checkout is persistent and directly
inspectable by the user, so later tasks reuse it without a Project selection,
Work Item, or task Worktree.

The normal-conversation MCP provides:

- `git_list_repositories` to list checkouts already present below
  `Workspace/repos/`;
- `git_open_repository` to clone or reopen a strict
  `ssh://user@host[:port]/path/repository.git` URL;
- `git_status`, `git_diff`, and `git_log` for bounded inspection by URL;
- `git_commit` to scan and commit the current safe changes, attributed to the
  active character;
- `git_push` to non-force push the current branch.

Git commands on the same canonical repository are serialized by an internal
repository lock. The lock is an operation-safety mechanism and not a
user-visible task object. Ordinary Workspace edits occur between those Git
commands and are not covered by a task-long exclusive lease, so two characters
sharing the same checkout must coordinate concurrent edits. Different
repositories can be used independently.

## Safety and network boundary

Repository text, diffs, logs, filenames, and file contents are untrusted input.
Commit and push retain sensitive-path, credential-pattern, size/count,
regular-file, and repository-configuration checks. Hooks, submodules, LFS
smudge, credential helpers, ambient SSH agents, unsafe local Git
configuration, file/ext protocols, force push, caller-supplied refspecs, and
runtime replacement of `origin` remain unavailable. Repository-control paths
and symlinks fail closed, and only commits approved through `git_commit` can be
pushed.

SSH keys and known-hosts files stay in host-owned state. Git runs with an
isolated HOME and config, batch-only SSH, and strict host-key handling. The
Agent shell's network toggle does not control this connector: Git network
access is a separate, narrower host capability that uses the configured SSH
identity. Because this personal-use model deliberately has no repository
whitelist, enabling Git grants the character the same repository reachability
that this identity has. Use a more restricted SSH identity only when that is
the boundary you want.

## Legacy migration data

Earlier releases exposed Identities, Projects, registered Repositories,
bindings, task Work Items, and isolated Worktrees. On first use, the default V2
identity or older V1 identity settings are migrated into `git/access.json`;
the source files are not deleted. These resource types are no longer the
runtime interaction model. A legacy checkout is reused in place only when its
SSH `origin` uniquely matches the requested canonical URL; otherwise new work
uses the deterministic path under `workspace/repos/`.

## Backup and restore

Verified YourChar state backups include:

- `git/access.json`;
- `git/credentials/`, including a managed private key when configured;
- the active `git/access-approved-commits.json` ledger and isolated Git runtime
  data under `git/access-runtime/`;
- older registry, Work Item, object-store, configuration, and `git-runtime/`
  files when they still exist, solely as migration history.

The manifest reports `containsGitAccessConfig` and
`containsGitCredentials`. It also records
`excludesGitWorkspaceRepositories: true`. The older
`containsGitRegistry`, `containsGitWorkItems`, and
`containsGitRepositoryConfig` fields describe legacy payloads only. These
fields are optional so prior schema-v3 manifests remain valid.

External private-key **bytes are not backed up**. Only their absolute path is
stored, and a declared external key is excluded even if it lies below another
selected state tree. Restore that key separately with owner-only permissions.
In contrast, a YourChar-managed private key is included, making a backup with
`containsGitCredentials: true` credential-bearing and highly sensitive.
YourChar does not encrypt backups itself.

The complete `workspace/repos/` tree is deliberately excluded before backup
traversal. Repository objects, checked-out files, tracked symlinks, and
uncommitted changes are therefore not part of YourChar state. Push durable
commits to the remote or back up repositories separately. After restoring
YourChar state, reclone a repository by giving its URL to a character again, or
restore its checkout from that separate backup.
