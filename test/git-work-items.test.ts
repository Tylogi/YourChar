import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitRepositoryOperationError,
  GitRepositoryService,
} from "../src/git/service.js";
import {
  GitWorkItemConfigurationError,
  GitWorkItemLeaseError,
  GitWorkItemOperationError,
  GitWorkItemService,
  type GitWorkCommandRunner,
  type GitWorkRepository,
} from "../src/git/work-items.js";

const remoteUrl = "ssh://git@example.test/owner/review.git";
const projectId = "project-review";
const repositoryId = "repository-paper";

type Fixture = {
  root: string;
  remoteRoot: string;
  stateDir: string;
  workspaceDir: string;
  bare: string;
  fakeSsh: string;
  baseOid: string;
  repository: GitWorkRepository;
  service: GitWorkItemService;
  dispose: () => void;
};

test("separate work items prevent two characters from committing each other's changes", async () => {
  const fixture = createFixture();
  try {
    const nanami = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-nanami",
      characterId: "character-nanami",
    });
    const kurisu = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-kurisu",
      characterId: "character-kurisu",
    });
    assert.notEqual(nanami.id, kurisu.id);
    assert.notEqual(nanami.branch, kurisu.branch);
    assert.notEqual(nanami.workspacePath, kurisu.workspacePath);
    assert.match(nanami.workspacePath, /^projects\/review\/paper\/worktrees\/work-[a-f0-9]+$/u);

    const nanamiCheckout = join(fixture.workspaceDir, nanami.workspacePath);
    const kurisuCheckout = join(fixture.workspaceDir, kurisu.workspacePath);
    writeFileSync(join(nanamiCheckout, "nanami.md"), "Nanami task\n", "utf8");
    writeFileSync(join(kurisuCheckout, "kurisu.md"), "Kurisu task\n", "utf8");

    const kurisuCommit = await fixture.service.commit({
      workItemId: kurisu.id,
      sessionId: "session-kurisu",
      characterId: "character-kurisu",
      characterName: "红莉栖",
      message: "Add Kurisu review",
    });
    assert.equal(treeHasPath(kurisuCheckout, kurisuCommit.commit, "kurisu.md"), true);
    assert.equal(treeHasPath(kurisuCheckout, kurisuCommit.commit, "nanami.md"), false);
    const nanamiDirty = await fixture.service.status({
      workItemId: nanami.id,
      sessionId: "session-nanami",
      characterId: "character-nanami",
    });
    assert.equal(nanamiDirty.clean, false);
    assert.match(nanamiDirty.summary, /nanami\.md/u);

    const nanamiCommit = await fixture.service.commit({
      workItemId: nanami.id,
      sessionId: "session-nanami",
      characterId: "character-nanami",
      characterName: "七海千秋",
      message: "Add Nanami review",
    });
    assert.equal(treeHasPath(nanamiCheckout, nanamiCommit.commit, "nanami.md"), true);
    assert.equal(treeHasPath(nanamiCheckout, nanamiCommit.commit, "kurisu.md"), false);
    assert.match((await fixture.service.log({
      workItemId: nanami.id,
      sessionId: "session-nanami",
      characterId: "character-nanami",
      limit: 5,
    })).log, /Add Nanami review/u);

    assert.equal(fixture.service.listWorkItems({
      sessionId: "session-nanami",
      characterId: "character-nanami",
    }).length, 1);
    assert.equal(fixture.service.findActiveForOwner({
      repositoryId,
      sessionId: "session-nanami",
      characterId: "character-nanami",
    })?.id, nanami.id);

    const publishedNanami = await fixture.service.publish({
      workItemId: nanami.id,
      sessionId: "session-nanami",
      characterId: "character-nanami",
    });
    const publishedKurisu = await fixture.service.publish({
      workItemId: kurisu.id,
      sessionId: "session-kurisu",
      characterId: "character-kurisu",
    });
    assert.equal(publishedNanami.remoteBranch, nanami.branch);
    assert.equal(publishedKurisu.remoteBranch, kurisu.branch);
    assert.equal(refOid(fixture.bare, `refs/heads/${nanami.branch}`), nanamiCommit.commit);
    assert.equal(refOid(fixture.bare, `refs/heads/${kurisu.branch}`), kurisuCommit.commit);
    assert.equal(refOid(fixture.bare, "refs/heads/main"), fixture.baseOid);
  } finally {
    fixture.dispose();
  }
});

test("durable owner lease requires explicit handoff", async () => {
  const fixture = createFixture();
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    await assert.rejects(
      fixture.service.status({ workItemId: item.id, sessionId: "session-b", characterId: "character-b" }),
      (error: unknown) => error instanceof GitWorkItemLeaseError,
    );
    const handedOff = await fixture.service.handoff({
      workItemId: item.id,
      fromSessionId: "session-a",
      fromCharacterId: "character-a",
      toSessionId: "session-b",
      toCharacterId: "character-b",
    });
    assert.equal(handedOff.ownerSessionId, "session-b");
    assert.equal(handedOff.ownerCharacterId, "character-b");
    assert.equal(handedOff.branch, item.branch);
    assert.equal(handedOff.handoffCount, 1);
    await assert.rejects(
      fixture.service.status({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemLeaseError,
    );
    assert.equal((await fixture.service.status({
      workItemId: item.id,
      sessionId: "session-b",
      characterId: "character-b",
    })).clean, true);
  } finally {
    fixture.dispose();
  }
});

test("conversation deletion guard rejects only sessions with active work items", async () => {
  const fixture = createFixture();
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-delete-guard",
      characterId: "character-delete-guard",
    });

    assert.throws(
      () => fixture.service.assertNoActiveItemsForSession("session-delete-guard"),
      (error: unknown) =>
        error instanceof GitWorkItemOperationError && /permanently deleting their conversation/u.test(error.message),
    );
    assert.doesNotThrow(() => fixture.service.assertNoActiveItemsForSession("another-session"));

    await fixture.service.close({
      workItemId: item.id,
      sessionId: "session-delete-guard",
      characterId: "character-delete-guard",
    });
    assert.doesNotThrow(() => fixture.service.assertNoActiveItemsForSession("session-delete-guard"));
  } finally {
    fixture.dispose();
  }
});

test("assertIdle covers queued work and an asynchronous repository resolver", async () => {
  const fixture = createFixture();
  let releaseResolver!: () => void;
  const resolverGate = new Promise<void>((resolvePromise) => {
    releaseResolver = resolvePromise;
  });
  const service = new GitWorkItemService({
    stateDir: join(fixture.root, "idle-state"),
    workspaceDir: join(fixture.root, "idle-workspace"),
    resolveRepository: async (requestedRepositoryId, requestedProjectId) => {
      await resolverGate;
      return requestedRepositoryId === repositoryId && requestedProjectId === projectId
        ? fixture.repository
        : undefined;
    },
    resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
  });
  try {
    const opening = service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    assert.throws(
      () => service.assertIdle(),
      (error: unknown) => error instanceof GitWorkItemOperationError && /operations are active/u.test(error.message),
    );
    releaseResolver();
    await opening;
    service.assertIdle();
  } finally {
    releaseResolver();
    fixture.dispose();
  }
});

test("concurrent opens for one owner, project, and repository are idempotent", async () => {
  const fixture = createFixture();
  try {
    const opened = await Promise.all(Array.from({ length: 6 }, () => fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-one-owner",
      characterId: "character-one-owner",
    })));
    assert.equal(new Set(opened.map((item) => item.id)).size, 1);
    assert.equal(new Set(opened.map((item) => item.workspacePath)).size, 1);
    assert.equal(fixture.service.listWorkItems({
      sessionId: "session-one-owner",
      characterId: "character-one-owner",
    }).length, 1);
  } finally {
    fixture.dispose();
  }
});

test("work item paths accept the registry's maximum-length storage keys", async () => {
  const fixture = createFixture();
  try {
    const repository: GitWorkRepository = {
      ...fixture.repository,
      projectStorageKey: `p${"a".repeat(95)}`,
      repositoryStorageKey: `r${"b".repeat(95)}`,
    };
    const service = createService(fixture, repository);
    const item = await service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-long-storage",
      characterId: "character-long-storage",
    });
    assert.match(item.workspacePath, new RegExp(
      `^projects/${repository.projectStorageKey}/${repository.repositoryStorageKey}/worktrees/${item.id}$`,
      "u",
    ));
    assert.equal((await service.status({
      workItemId: item.id,
      sessionId: "session-long-storage",
      characterId: "character-long-storage",
    })).clean, true);
  } finally {
    fixture.dispose();
  }
});

test("active work items block destructive project, repository, identity, and binding changes", async () => {
  const fixture = createFixture();
  try {
    const stateDir = join(fixture.root, "configuration-guard-state");
    const workspaceDir = join(fixture.root, "configuration-guard-workspace");
    const key = join(fixture.root, "configuration-guard-key");
    const replacementKey = join(fixture.root, "configuration-guard-replacement-key");
    writeFileSync(key, "test-only-key\n", { mode: 0o600 });
    writeFileSync(replacementKey, "test-only-replacement-key\n", { mode: 0o600 });
    const service = new GitRepositoryService({
      stateDir,
      workspaceDir,
      sshCommandOverride: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}`,
    });
    service.patchConfig({
      repositoryName: "Review",
      remoteUrl,
      branch: "main",
      privateKeyPath: key,
    });
    const registry = service.getRegistrySnapshot();
    const project = registry.projects.find((entry) => entry.id === registry.defaults.projectId);
    const repository = registry.repositories.find((entry) => entry.id === registry.defaults.repositoryId);
    const identity = registry.identities.find((entry) => entry.id === repository?.identityId);
    const binding = registry.projectRepositories.find((entry) =>
      entry.projectId === project?.id && entry.repositoryId === repository?.id
    );
    assert.ok(project && repository && identity && binding);

    const item = await service.openWork({
      projectId: project.id,
      repositoryId: repository.id,
      sessionId: "session-configuration-guard",
      characterId: "character-configuration-guard",
    });
    const revision = service.getRegistrySnapshot().revision;
    const destructiveMutations: Array<() => unknown> = [
      () => service.updateProject(project.id, { archived: true }),
      () => service.deleteProject(project.id),
      () => service.updateRepository(repository.id, { remoteUrl: "ssh://git@example.test/owner/replacement.git" }),
      () => service.deleteRepository(repository.id),
      () => service.updateIdentity(identity.id, {
        credential: { kind: "external-file", privateKeyPath: replacementKey },
      }),
      () => service.deleteIdentity(identity.id),
      () => service.deleteProjectRepositoryBinding(binding.id),
    ];
    for (const mutate of destructiveMutations) {
      assert.throws(
        mutate,
        (error: unknown) => error instanceof GitRepositoryOperationError && /active Git Work Items/u.test(error.message),
      );
      assert.equal(service.getRegistrySnapshot().revision, revision, "a rejected mutation must not advance the registry");
    }
    assert.equal((await service.workItems!.status({
      workItemId: item.id,
      sessionId: "session-configuration-guard",
      characterId: "character-configuration-guard",
    })).clean, true);
  } finally {
    fixture.dispose();
  }
});

test("publish rejects unapproved commits and divergent remote branches without force", async () => {
  const fixture = createFixture();
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    const checkout = join(fixture.workspaceDir, item.workspacePath);
    writeFileSync(join(checkout, "first.md"), "first\n", "utf8");
    const first = await fixture.service.commit({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
      characterName: "角色 A",
      message: "First safe commit",
    });
    await fixture.service.publish({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
    });

    writeFileSync(join(checkout, "manual.md"), "bypassed service\n", "utf8");
    git(["add", "manual.md"], checkout);
    git(["-c", "user.name=Bypass", "-c", "user.email=bypass@example.test", "commit", "-m", "manual"], checkout);
    await assert.rejects(
      fixture.service.publish({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /unapproved local commit/u.test(error.message),
    );
    git(["reset", "--hard", first.commit], checkout);

    writeFileSync(join(checkout, "second.md"), "second\n", "utf8");
    await fixture.service.commit({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
      characterName: "角色 A",
      message: "Second safe commit",
    });
    const tree = refOid(fixture.bare, `${fixture.baseOid}^{tree}`);
    const rewritten = git([
      "--git-dir", fixture.bare,
      "-c", "user.name=External",
      "-c", "user.email=external@example.test",
      "commit-tree", tree,
      "-m", "external rewrite",
    ]).trim();
    git(["--git-dir", fixture.bare, "update-ref", `refs/heads/${item.branch}`, rewritten]);

    await assert.rejects(
      fixture.service.publish({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /force push is not allowed/u.test(error.message),
    );
    assert.equal(refOid(fixture.bare, `refs/heads/${item.branch}`), rewritten);
  } finally {
    fixture.dispose();
  }
});

test("close preserves dirty and unpushed work, then removes only a clean published worktree", async () => {
  const fixture = createFixture();
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    const checkout = join(fixture.workspaceDir, item.workspacePath);
    writeFileSync(join(checkout, "work.md"), "valuable work\n", "utf8");
    await assert.rejects(
      fixture.service.close({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /uncommitted/u.test(error.message),
    );
    assert.equal(readFileSync(join(checkout, "work.md"), "utf8"), "valuable work\n");

    await fixture.service.commit({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
      characterName: "角色 A",
      message: "Preserve work",
    });
    await assert.rejects(
      fixture.service.close({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /unpushed/u.test(error.message),
    );
    assert.equal(existsSync(checkout), true);

    await fixture.service.publish({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" });
    const closed = await fixture.service.close({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
    });
    assert.equal(closed.state, "closed");
    assert.equal(existsSync(checkout), false);
    assert.equal(fixture.service.listWorkItems({
      sessionId: "session-a",
      characterId: "character-a",
    }).length, 0);
    assert.equal(fixture.service.listWorkItems({
      sessionId: "session-a",
      characterId: "character-a",
      includeClosed: true,
    }).length, 1);
  } finally {
    fixture.dispose();
  }
});

test("close revalidates a deleted or rewritten remote work branch and preserves local work", async () => {
  const fixture = createFixture();
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-remote-close",
      characterId: "character-remote-close",
    });
    const checkout = join(fixture.workspaceDir, item.workspacePath);
    writeFileSync(join(checkout, "published.md"), "published work\n", "utf8");
    const committed = await fixture.service.commit({
      workItemId: item.id,
      sessionId: "session-remote-close",
      characterId: "character-remote-close",
      characterName: "角色 A",
      message: "Publish before close",
    });
    await fixture.service.publish({
      workItemId: item.id,
      sessionId: "session-remote-close",
      characterId: "character-remote-close",
    });
    const remoteRef = `refs/heads/${item.branch}`;

    git(["--git-dir", fixture.bare, "update-ref", "-d", remoteRef]);
    await assert.rejects(
      fixture.service.close({
        workItemId: item.id,
        sessionId: "session-remote-close",
        characterId: "character-remote-close",
      }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /no longer points/u.test(error.message),
    );
    assert.equal(existsSync(checkout), true);
    assert.equal(git(["rev-parse", "HEAD"], checkout).trim(), committed.commit);

    git(["--git-dir", fixture.bare, "update-ref", remoteRef, fixture.baseOid]);
    await assert.rejects(
      fixture.service.close({
        workItemId: item.id,
        sessionId: "session-remote-close",
        characterId: "character-remote-close",
      }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /no longer points/u.test(error.message),
    );
    assert.equal(existsSync(checkout), true);
    assert.equal(git(["rev-parse", "HEAD"], checkout).trim(), committed.commit);

    git(["--git-dir", fixture.bare, "update-ref", remoteRef, committed.commit]);
    const closed = await fixture.service.close({
      workItemId: item.id,
      sessionId: "session-remote-close",
      characterId: "character-remote-close",
    });
    assert.equal(closed.state, "closed");
    assert.equal(existsSync(checkout), false);
  } finally {
    fixture.dispose();
  }
});

test("a local branch cleanup failure still records a removed worktree as closed", async () => {
  const fixture = createFixture();
  try {
    const stateDir = join(fixture.root, "branch-cleanup-state");
    const workspaceDir = join(fixture.root, "branch-cleanup-workspace");
    let rejectBranchCleanup = false;
    const runner: GitWorkCommandRunner = async (input) => {
      if (rejectBranchCleanup && input.args.includes("branch") && input.args.includes("-D")) {
        return { stdout: "", stderr: "injected branch cleanup failure", exitCode: 1 };
      }
      return runNativeGit(input);
    };
    const service = new GitWorkItemService({
      stateDir,
      workspaceDir,
      runner,
      resolveRepository: (requestedRepositoryId, requestedProjectId) =>
        requestedRepositoryId === repositoryId && requestedProjectId === projectId ? fixture.repository : undefined,
      resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
    });
    const item = await service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-branch-cleanup",
      characterId: "character-branch-cleanup",
    });
    const checkout = join(workspaceDir, item.workspacePath);
    rejectBranchCleanup = true;
    const closed = await service.close({
      workItemId: item.id,
      sessionId: "session-branch-cleanup",
      characterId: "character-branch-cleanup",
    });
    assert.equal(closed.state, "closed");
    assert.equal(existsSync(checkout), false);

    const storeName = readdirSync(join(stateDir, "git-worktrees", "repositories"))
      .find((entry) => entry.endsWith(".git"));
    assert.ok(storeName);
    assert.equal(refOid(join(stateDir, "git-worktrees", "repositories", storeName), `refs/heads/${item.branch}`), item.headOid);

    const restored = new GitWorkItemService({
      stateDir,
      workspaceDir,
      resolveRepository: (requestedRepositoryId, requestedProjectId) =>
        requestedRepositoryId === repositoryId && requestedProjectId === projectId ? fixture.repository : undefined,
      resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
    });
    assert.equal(restored.listWorkItems({
      sessionId: "session-branch-cleanup",
      characterId: "character-branch-cleanup",
      includeClosed: true,
    })[0]?.state, "closed");
  } finally {
    fixture.dispose();
  }
});

test("registry and generated path boundaries reject arbitrary project, path, ref, and worktree pointers", async () => {
  const fixture = createFixture();
  try {
    await assert.rejects(
      fixture.service.openWorkItem({
        projectId,
        repositoryId: "../repository",
        sessionId: "session-a",
        characterId: "character-a",
      }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError,
    );
    const unsafeStorage = createService(fixture, {
      ...fixture.repository,
      projectStorageKey: "../escape",
    });
    await assert.rejects(
      unsafeStorage.openWorkItem({ projectId, repositoryId, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError,
    );
    const unsafeRef = createService(fixture, {
      ...fixture.repository,
      defaultBranch: "main:refs/heads/escape",
    });
    await assert.rejects(
      unsafeRef.openWorkItem({ projectId, repositoryId, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError,
    );
    const mismatchedProject = new GitWorkItemService({
      stateDir: join(fixture.root, "mismatch-state"),
      workspaceDir: join(fixture.root, "mismatch-workspace"),
      resolveRepository: () => ({ ...fixture.repository, projectId: "another-project" }),
      resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
    });
    await assert.rejects(
      mismatchedProject.openWorkItem({ projectId, repositoryId, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError && /mismatched/u.test(error.message),
    );

    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    const checkout = join(fixture.workspaceDir, item.workspacePath);
    writeFileSync(join(checkout, ".git"), "gitdir: /tmp/another.git/worktrees/evil\n", "utf8");
    await assert.rejects(
      fixture.service.status({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /another repository/u.test(error.message),
    );
    assert.equal(existsSync(checkout), true);
  } finally {
    fixture.dispose();
  }
});

test("managed state directories reject real and dangling symlinks without touching their targets", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-state-boundary-"));
  try {
    const stateDir = join(root, "state");
    const workspaceDir = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, "sentinel.txt"), "keep\n", "utf8");
    symlinkSync(outside, join(stateDir, "git-worktrees"), "dir");

    assert.throws(
      () => new GitWorkItemService({ stateDir, workspaceDir, resolveRepository: () => undefined }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError && /non-symlink/u.test(error.message),
    );
    assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);

    const danglingState = join(root, "dangling-state");
    mkdirSync(danglingState, { recursive: true, mode: 0o700 });
    const danglingRuntime = join(danglingState, "git-worktrees");
    symlinkSync(join(root, "missing-runtime"), danglingRuntime, "dir");
    assert.throws(
      () => new GitWorkItemService({ stateDir: danglingState, workspaceDir, resolveRepository: () => undefined }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError && /non-symlink/u.test(error.message),
    );
    assert.equal(lstatSync(danglingRuntime).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Workspace intermediate symlinks are rejected before Git creates a checkout", async () => {
  const fixture = createFixture();
  try {
    const outside = join(fixture.root, "outside-workspace");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, "sentinel.txt"), "keep\n", "utf8");
    symlinkSync(outside, join(fixture.workspaceDir, "projects"), "dir");

    await assert.rejects(
      fixture.service.openWorkItem({
        projectId,
        repositoryId,
        sessionId: "session-a",
        characterId: "character-a",
      }),
      (error: unknown) => error instanceof GitWorkItemConfigurationError && /non-symlink/u.test(error.message),
    );
    assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
    assert.equal(lstatSync(join(fixture.workspaceDir, "projects")).isSymbolicLink(), true);
  } finally {
    fixture.dispose();
  }
});

test("a dangling generated target and a symlink introduced by failed Git cleanup are preserved", async () => {
  const fixture = createFixture();
  try {
    const danglingId = "work-aaaaaaaaaaaaaaaaaaaa";
    const danglingState = join(fixture.root, "dangling-target-state");
    const danglingWorkspace = join(fixture.root, "dangling-target-workspace");
    const danglingParent = join(danglingWorkspace, "projects", "review", "paper", "worktrees");
    const danglingCheckout = join(danglingParent, danglingId);
    mkdirSync(danglingParent, { recursive: true, mode: 0o700 });
    symlinkSync(join(fixture.root, "missing-checkout"), danglingCheckout, "dir");
    const danglingService = new GitWorkItemService({
      stateDir: danglingState,
      workspaceDir: danglingWorkspace,
      idFactory: () => danglingId,
      resolveRepository: (requestedRepositoryId, requestedProjectId) =>
        requestedRepositoryId === repositoryId && requestedProjectId === projectId ? fixture.repository : undefined,
      resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
    });
    await assert.rejects(
      danglingService.openWorkItem({ projectId, repositoryId, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /already exists/u.test(error.message),
    );
    assert.equal(lstatSync(danglingCheckout).isSymbolicLink(), true);

    const cleanupId = "work-bbbbbbbbbbbbbbbbbbbb";
    const cleanupState = join(fixture.root, "cleanup-state");
    const cleanupWorkspace = join(fixture.root, "cleanup-workspace");
    const cleanupCheckout = join(cleanupWorkspace, "projects", "review", "paper", "worktrees", cleanupId);
    const outside = join(fixture.root, "cleanup-outside");
    mkdirSync(outside, { recursive: true, mode: 0o700 });
    writeFileSync(join(outside, "sentinel.txt"), "keep\n", "utf8");
    let injectedSymlink = false;
    const cleanupService = new GitWorkItemService({
      stateDir: cleanupState,
      workspaceDir: cleanupWorkspace,
      idFactory: () => cleanupId,
      resolveRepository: (requestedRepositoryId, requestedProjectId) =>
        requestedRepositoryId === repositoryId && requestedProjectId === projectId ? fixture.repository : undefined,
      resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
      runner: async (input) => {
        if (input.args.includes("worktree") && input.args.includes("add")) {
          symlinkSync(outside, cleanupCheckout, "dir");
          injectedSymlink = true;
          return { stdout: "", stderr: "injected worktree failure", exitCode: 1 };
        }
        const result = spawnSync(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
          encoding: "utf8",
        });
        return {
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? result.error?.message ?? "",
          exitCode: result.status ?? -1,
        };
      },
    });
    await assert.rejects(
      cleanupService.openWorkItem({ projectId, repositoryId, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /injected worktree failure/u.test(error.message),
    );
    assert.equal(injectedSymlink, true);
    assert.equal(lstatSync(cleanupCheckout).isSymbolicLink(), true);
    assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
  } finally {
    fixture.dispose();
  }
});

test("commit applies the existing sensitive path and credential-content guard", async () => {
  const fixture = createFixture();
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    const checkout = join(fixture.workspaceDir, item.workspacePath);
    writeFileSync(join(checkout, ".env.production"), "TOKEN=test-only-value\n", "utf8");
    await assert.rejects(
      fixture.service.commit({
        workItemId: item.id,
        sessionId: "session-a",
        characterId: "character-a",
        characterName: "角色 A",
        message: "Unsafe path",
      }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /sensitive or control file/u.test(error.message),
    );
    rmSync(join(checkout, ".env.production"));
    writeFileSync(join(checkout, "notes.md"), `Authorization: Bearer ${"x".repeat(40)}\n`, "utf8");
    await assert.rejects(
      fixture.service.commit({
        workItemId: item.id,
        sessionId: "session-a",
        characterId: "character-a",
        characterName: "角色 A",
        message: "Unsafe content",
      }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /credential-like content/u.test(error.message),
    );
  } finally {
    fixture.dispose();
  }
});

test("relocated state and Workspace repair managed worktree links without losing unpushed commits", async () => {
  const fixture = createFixture();
  const movedRoot = `${fixture.root}-moved`;
  try {
    const item = await fixture.service.openWorkItem({
      projectId,
      repositoryId,
      sessionId: "session-a",
      characterId: "character-a",
    });
    const oldCheckout = join(fixture.workspaceDir, item.workspacePath);
    writeFileSync(join(oldCheckout, "relocated.md"), "survives relocation\n", "utf8");
    const committed = await fixture.service.commit({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
      characterName: "角色 A",
      message: "Keep relocation work",
    });

    renameSync(fixture.root, movedRoot);
    const movedState = join(movedRoot, "state");
    const movedWorkspace = join(movedRoot, "workspace");
    const restored = new GitWorkItemService({
      stateDir: movedState,
      workspaceDir: movedWorkspace,
      resolveRepository: (requestedRepositoryId, requestedProjectId) =>
        requestedRepositoryId === repositoryId && requestedProjectId === projectId ? fixture.repository : undefined,
      resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
    });
    const status = await restored.status({
      workItemId: item.id,
      sessionId: "session-a",
      characterId: "character-a",
    });
    assert.equal(status.clean, true);
    assert.equal(status.workItem.headOid, committed.commit);
    assert.equal(readFileSync(join(movedWorkspace, item.workspacePath, "relocated.md"), "utf8"), "survives relocation\n");
    assert.match(readFileSync(join(movedWorkspace, item.workspacePath, ".git"), "utf8"), new RegExp(escapeRegExp(movedState), "u"));
    await assert.rejects(
      restored.close({ workItemId: item.id, sessionId: "session-a", characterId: "character-a" }),
      (error: unknown) => error instanceof GitWorkItemOperationError && /unpushed/u.test(error.message),
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(movedRoot, { recursive: true, force: true });
    rmSync(fixture.remoteRoot, { recursive: true, force: true });
  }
});

function createFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-work-items-"));
  const remoteRoot = mkdtempSync(join(tmpdir(), "yourchar-git-work-items-remote-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const bare = join(remoteRoot, "remote.git");
  const seed = join(remoteRoot, "seed");
  const fakeSsh = join(remoteRoot, "fake-ssh.mjs");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(fakeSsh, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const bare = process.argv[2];
const command = process.argv.at(-1) || "";
const service = command.includes("git-upload-pack") ? "upload-pack" : command.includes("git-receive-pack") ? "receive-pack" : "";
if (!service) process.exit(2);
const result = spawnSync("git", [service, bare], { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  git(["init", "--bare", bare]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"], bare);
  git(["init", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "# Review\n", "utf8");
  git(["add", "README.md"], seed);
  git(["-c", "user.name=Seed", "-c", "user.email=seed@example.test", "commit", "-m", "seed"], seed);
  git(["push", bare, "HEAD:main"], seed);
  const baseOid = git(["rev-parse", "HEAD"], seed).trim();
  const repository: GitWorkRepository = {
    id: repositoryId,
    projectId,
    projectStorageKey: "review",
    repositoryStorageKey: "paper",
    remoteUrl,
    defaultBranch: "main",
  };
  const fixtureBase = { root, remoteRoot, stateDir, workspaceDir, bare, fakeSsh, baseOid, repository };
  const service = new GitWorkItemService({
    stateDir,
    workspaceDir,
    resolveRepository: (requestedRepositoryId, requestedProjectId) =>
      requestedRepositoryId === repositoryId && requestedProjectId === projectId ? repository : undefined,
    resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fakeSsh)} ${quote(bare)}` }),
  });
  return {
    ...fixtureBase,
    service,
    dispose: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(remoteRoot, { recursive: true, force: true });
    },
  };
}

function createService(
  fixture: Pick<Fixture, "root" | "bare" | "fakeSsh">,
  repository: GitWorkRepository,
): GitWorkItemService {
  const suffix = Math.random().toString(16).slice(2);
  return new GitWorkItemService({
    stateDir: join(fixture.root, `isolated-state-${suffix}`),
    workspaceDir: join(fixture.root, `isolated-workspace-${suffix}`),
    resolveRepository: (requestedRepositoryId, requestedProjectId) =>
      requestedRepositoryId === repository.id && requestedProjectId === repository.projectId ? repository : undefined,
    resolveEnvironment: () => ({ GIT_SSH_COMMAND: `${quote(fixture.fakeSsh)} ${quote(fixture.bare)}` }),
  });
}

function runNativeGit(input: Parameters<GitWorkCommandRunner>[0]): Promise<Awaited<ReturnType<GitWorkCommandRunner>>> {
  const result = spawnSync(input.command, input.args, {
    cwd: input.cwd,
    env: input.env,
    encoding: "utf8",
  });
  return Promise.resolve({
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
    exitCode: result.status ?? -1,
  });
}

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { ...(cwd ? { cwd } : {}), encoding: "utf8" });
}

function refOid(bare: string, ref: string): string {
  return git(["--git-dir", bare, "rev-parse", "--verify", ref]).trim();
}

function treeHasPath(checkout: string, commit: string, path: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${path}`], { cwd: checkout, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
