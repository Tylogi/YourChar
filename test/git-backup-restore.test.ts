import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("backup preserves simplified Git access state but excludes repository checkouts and external keys", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-backup-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const externalKey = join(stateDir, "git", "external-deploy-key");
  const externalKeySentinel = "EXTERNAL_GIT_PRIVATE_KEY_BYTES_MUST_NOT_BE_BACKED_UP";
  const accessExternalKey = join(stateDir, "git", "access-external-key");
  const accessExternalKeySentinel = "ACCESS_PRIVATE_KEY_BYTES_MUST_NOT_BE_BACKED_UP";
  const managedKey = join(stateDir, "git", "credentials", "default", "id_ed25519");
  const managedKeyContents = "MANAGED_GIT_PRIVATE_KEY_BACKUP_SENTINEL\n";
  const workItemContents = `${JSON.stringify({
    version: 1,
    items: [{
      id: "work-0123456789abcdef01234567",
      projectId: "project_fixture",
      repositoryId: "repository_fixture",
      state: "active",
      workspacePath: "projects/project-fixture/repository-fixture/worktrees/work-0123456789abcdef01234567",
    }],
  }, null, 2)}\n`;
  const bareRef = "0123456789abcdef0123456789abcdef01234567\n";
  const worktreePointer = "gitdir: /old/state/git-worktrees/repositories/repository.git/worktrees/work-fixture\n";
  const reverseGitdir = "/old/state/workspace/projects/project-fixture/repository-fixture/worktrees/work-fixture/.git\n";

  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "git", "credentials", "default"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(externalKey, `${externalKeySentinel}\n`, { mode: 0o600 });
    writeFileSync(accessExternalKey, `${accessExternalKeySentinel}\n`, { mode: 0o600 });
    writeFileSync(managedKey, managedKeyContents, { mode: 0o600 });
    writeFileSync(`${managedKey}.pub`, "ssh-ed25519 managed-public-key yourchar:test\n", { mode: 0o644 });
    writeFileSync(join(stateDir, "git", "access.json"), `${JSON.stringify({
      version: "yourchar-git-access-v1",
      revision: 2,
      identityStorageKey: "default",
      credential: { kind: "external-file", privateKeyPath: accessExternalKey },
      proxyMode: "direct",
      proxyPort: 61090,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }, null, 2)}\n`, { mode: 0o600 });
    writeFileSync(
      join(stateDir, "git", "access-approved-commits.json"),
      '{"version":1,"repositories":{"git@example.test:22/owner/review.git":["0123456789abcdef0123456789abcdef01234567"]}}\n',
      { mode: 0o600 },
    );
    writeFileSync(join(stateDir, "git", "registry.json"), `${JSON.stringify({
      version: "yourchar-git-v2",
      revision: 4,
      identities: [
        {
          id: "identity_managed",
          credential: { kind: "managed-ed25519", keyRef: "credentials/identity-managed/id_ed25519" },
        },
        {
          id: "identity_external",
          credential: { kind: "external-file", privateKeyPath: externalKey },
        },
      ],
      projects: [{ id: "project_fixture" }],
      repositories: [{ id: "repository_fixture", identityId: "identity_managed" }],
      projectRepositories: [],
    }, null, 2)}\n`, { mode: 0o600 });

    const bareRoot = join(stateDir, "git-worktrees", "repositories", "repository.git");
    mkdirSync(join(bareRoot, "refs", "heads", "yourchar", "fixture"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(bareRoot, "worktrees", "work-fixture"), { recursive: true, mode: 0o700 });
    writeFileSync(join(bareRoot, "refs", "heads", "yourchar", "fixture", "task"), bareRef, { mode: 0o600 });
    writeFileSync(join(bareRoot, "worktrees", "work-fixture", "gitdir"), reverseGitdir, { mode: 0o600 });
    writeFileSync(join(bareRoot, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
    mkdirSync(join(stateDir, "git-worktrees", "home"), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateDir, "git-worktrees", "home", "known_hosts"), "example.test ssh-ed25519 host-key\n", { mode: 0o600 });
    writeFileSync(join(stateDir, "git-work-items.json"), workItemContents, { mode: 0o600 });

    const checkout = join(
      stateDir,
      "workspace",
      "projects",
      "project-fixture",
      "repository-fixture",
      "worktrees",
      "work-fixture",
    );
    mkdirSync(checkout, { recursive: true, mode: 0o700 });
    writeFileSync(join(checkout, ".git"), worktreePointer, { mode: 0o600 });
    writeFileSync(join(checkout, "draft.md"), "unpublished work survives restore\n", { mode: 0o600 });

    const repositoryCheckout = join(stateDir, "workspace", "repos", "example.test", "owner", "review");
    mkdirSync(repositoryCheckout, { recursive: true, mode: 0o700 });
    writeFileSync(join(repositoryCheckout, "tracked.md"), "repository content is not state backup payload\n", { mode: 0o600 });
    symlinkSync(accessExternalKey, join(repositoryCheckout, "tracked-key-link"));

    mkdirSync(join(stateDir, "git-runtime"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(stateDir, "git-runtime", "approved-commits.json"),
      '{"version":1,"commits":["0123456789abcdef0123456789abcdef01234567"]}\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(stateDir, "git-repository.json"),
      `${JSON.stringify({
        version: "yourchar-git-v1",
        repositoryName: "Legacy",
        remoteUrl: "ssh://git@example.test/owner/legacy.git",
        branch: "main",
        privateKeyPath: externalKey,
        proxyMode: "direct",
        proxyPort: 61090,
      })}\n`,
      { mode: 0o600 },
    );

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    const manifestPath = join(backupDir, "backup-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      containsGitRegistry?: boolean;
      containsGitAccessConfig?: boolean;
      containsGitCredentials?: boolean;
      containsGitWorkItems?: boolean;
      containsGitRepositoryConfig?: boolean;
      excludesGitWorkspaceRepositories?: boolean;
      files: Array<{ path: string; sha256: string; size: number }>;
    };
    assert.equal(manifest.containsGitAccessConfig, true);
    assert.equal(manifest.containsGitRegistry, true);
    assert.equal(manifest.containsGitCredentials, true);
    assert.equal(manifest.containsGitWorkItems, true);
    assert.equal(manifest.containsGitRepositoryConfig, true);
    assert.equal(manifest.excludesGitWorkspaceRepositories, true);
    for (const expected of [
      "git/access.json",
      "git/access-approved-commits.json",
      "git/registry.json",
      "git/credentials/default/id_ed25519",
      "git/credentials/default/id_ed25519.pub",
      "git-work-items.json",
      "git-worktrees/repositories/repository.git/refs/heads/yourchar/fixture/task",
      "git-worktrees/repositories/repository.git/worktrees/work-fixture/gitdir",
      "git-runtime/approved-commits.json",
    ]) {
      assert.ok(manifest.files.some((file) => file.path === expected), expected);
    }
    assert.equal(manifest.files.some((file) => file.path.includes("external-deploy-key")), false);
    assert.equal(manifest.files.some((file) => file.path.includes("access-external-key")), false);
    assert.equal(manifest.files.some((file) => file.path.startsWith("workspace/repos/")), false);
    for (const file of manifest.files) {
      assert.equal(readFileSync(join(backupDir, file.path)).includes(externalKeySentinel), false, file.path);
      assert.equal(readFileSync(join(backupDir, file.path)).includes(accessExternalKeySentinel), false, file.path);
    }

    for (const field of [
      "containsGitAccessConfig",
      "containsGitRegistry",
      "containsGitCredentials",
      "containsGitWorkItems",
      "containsGitRepositoryConfig",
      "excludesGitWorkspaceRepositories",
    ] as const) {
      writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, [field]: false }, null, 2)}\n`, { mode: 0o600 });
      assert.throws(() => execFileSync(
        process.execPath,
        ["scripts/restore-state.mjs", backupDir, restoredDir, "--verify"],
        { cwd: process.cwd(), stdio: "pipe" },
      ));
    }
    const oldRepositoryPayload = "old schema-v3 backups could contain repository checkouts\n";
    const oldRepositoryRelativePath = "workspace/repos/example.test/owner/old/README.md";
    const oldRepositoryBackupPath = join(backupDir, oldRepositoryRelativePath);
    mkdirSync(join(backupDir, "workspace", "repos", "example.test", "owner", "old"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(oldRepositoryBackupPath, oldRepositoryPayload, { mode: 0o600 });
    const legacyCompatibleManifest = {
      ...manifest,
      files: [
        ...manifest.files,
        {
          path: oldRepositoryRelativePath,
          sha256: createHash("sha256").update(oldRepositoryPayload).digest("hex"),
          size: Buffer.byteLength(oldRepositoryPayload),
        },
      ].sort((left, right) => left.path.localeCompare(right.path)),
    };
    delete legacyCompatibleManifest.containsGitRegistry;
    delete legacyCompatibleManifest.containsGitAccessConfig;
    delete legacyCompatibleManifest.containsGitCredentials;
    delete legacyCompatibleManifest.containsGitWorkItems;
    delete legacyCompatibleManifest.excludesGitWorkspaceRepositories;
    writeFileSync(manifestPath, `${JSON.stringify(legacyCompatibleManifest, null, 2)}\n`, { mode: 0o600 });
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir, "--verify"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    rmSync(join(backupDir, "workspace", "repos"), { recursive: true, force: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    assert.equal(readFileSync(join(restoredDir, "git", "registry.json"), "utf8"), readFileSync(join(stateDir, "git", "registry.json"), "utf8"));
    assert.equal(readFileSync(join(restoredDir, "git", "credentials", "default", "id_ed25519"), "utf8"), managedKeyContents);
    assert.equal(statSync(join(restoredDir, "git", "credentials", "default", "id_ed25519")).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(restoredDir, "git", "access.json"), "utf8"), readFileSync(join(stateDir, "git", "access.json"), "utf8"));
    assert.equal(
      readFileSync(join(restoredDir, "git", "access-approved-commits.json"), "utf8"),
      readFileSync(join(stateDir, "git", "access-approved-commits.json"), "utf8"),
    );
    assert.equal(statSync(join(restoredDir, "workspace", "repos"), { throwIfNoEntry: false }), undefined);
    assert.equal(readFileSync(join(restoredDir, "git-work-items.json"), "utf8"), workItemContents);
    assert.equal(readFileSync(join(restoredDir, "git-worktrees", "repositories", "repository.git", "refs", "heads", "yourchar", "fixture", "task"), "utf8"), bareRef);
    assert.equal(readFileSync(join(restoredDir, "git-worktrees", "repositories", "repository.git", "worktrees", "work-fixture", "gitdir"), "utf8"), reverseGitdir);
    assert.equal(readFileSync(join(restoredDir, "workspace", "projects", "project-fixture", "repository-fixture", "worktrees", "work-fixture", ".git"), "utf8"), worktreePointer);
    assert.equal(
      readFileSync(join(restoredDir, "git-runtime", "approved-commits.json"), "utf8"),
      readFileSync(join(stateDir, "git-runtime", "approved-commits.json"), "utf8"),
    );
  } finally {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});
