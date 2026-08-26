import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitAccessService,
  GitRepositoryConfigurationError,
  GitRepositoryOperationError,
} from "../src/git/index.js";
import { __spawnGitCommandForTest } from "../src/git/access.js";

const remoteUrl = "ssh://git@example.test/owner/review.git";

test("GitAccessService opens arbitrary SSH repositories in a fixed safe root and commits/pushes", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = new GitAccessService({
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      sshCommandOverride: quote(fixture.fakeSsh),
    });
    const initial = service.getConfig();
    assert.equal(initial.configured, false);
    const configured = service.patchConfig({
      credential: { kind: "external-file", privateKeyPath: fixture.key },
    }, initial.revision);
    assert.equal(configured.configured, true);
    assert.deepEqual(configured.credential, { kind: "external-file", privateKeyPath: fixture.key });
    assert.throws(
      () => service.patchConfig({ proxyPort: 2222 }, initial.revision),
      (error: unknown) => error instanceof GitRepositoryOperationError && /changed/u.test(error.message),
    );

    const opened = await service.openRepository(remoteUrl);
    assert.equal(opened.cloned, true);
    assert.equal(opened.workspacePath, "repos/example.test/git/owner/review");
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "# Review\n");
    assert.match((await service.log({ remoteUrl, limit: 1 })).log, /seed/u);

    writeFileSync(join(checkout, "review.md"), "Reviewed safely.\n", "utf8");
    writeFileSync(join(checkout, "README.md"), "# Review\n\nReviewed safely.\n", "utf8");
    assert.equal((await service.status(remoteUrl)).clean, false);
    assert.match((await service.diff({ remoteUrl })).diff, /Reviewed safely/u);
    const committed = await service.commit({
      remoteUrl,
      message: "Add review",
      characterId: "character-nanami",
      characterName: "七海千秋",
    });
    assert.match(committed.commit, /^[a-f0-9]{40}$/u);
    assert.equal(execFileSync("git", ["show", "-s", "--format=%an", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(), "七海千秋 via YourChar");
    const pushed = await service.push(remoteUrl);
    assert.equal(pushed.pushedCommits, 1);
    assert.equal(execFileSync("git", ["show", `${committed.commit}:review.md`], { cwd: fixture.bare, encoding: "utf8" }), "Reviewed safely.\n");

    writeFileSync(join(checkout, ".env"), "TOKEN=github_pat_not-a-real-secret-but-long-value\n", "utf8");
    await assert.rejects(
      service.commit({ remoteUrl, message: "unsafe", characterId: "c", characterName: "C" }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /sensitive/u.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService commits pre-staged long-path renames without treating reused blobs as new content", { timeout: 120_000 }, async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const opened = await service.openRepository(remoteUrl);
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    const sourceName = `source-${"s".repeat(80)}`;
    const destinationName = `destination-${"d".repeat(80)}`;
    const source = join(checkout, sourceName);
    mkdirSync(source);
    const reusedPayload = Buffer.alloc(150 * 1024, 0x41);
    const fileNames: string[] = [];
    for (let index = 0; index < 450; index += 1) {
      const fileName = `${String(index).padStart(3, "0")}-${"f".repeat(70)}.bin`;
      fileNames.push(fileName);
      const uniquePayload = Buffer.from(reusedPayload);
      uniquePayload.writeUInt32BE(index, 0);
      writeFileSync(join(source, fileName), uniquePayload);
    }
    execFileSync("git", ["add", "--", sourceName], { cwd: checkout });
    execFileSync("git", [
      "-c", "user.name=Seed", "-c", "user.email=seed@example.test",
      "commit", "--quiet", "-m", "seed large rename tree",
    ], { cwd: checkout });
    execFileSync("git", ["push", fixture.bare, "HEAD:main"], { cwd: checkout, stdio: "ignore" });

    execFileSync("git", ["mv", "--", sourceName, destinationName], { cwd: checkout });
    const porcelain = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: checkout });
    assert.ok(porcelain.length > 128 * 1024, `expected status metadata above 128 KiB, received ${porcelain.length}`);
    assert.throws(
      () => execFileSync("git", ["diff", "--cached", "--quiet", "--exit-code", "--"], { cwd: checkout }),
      /Command failed/u,
      "the realistic git mv workload must already be staged",
    );
    assert.equal((await service.status(remoteUrl)).clean, false);
    assert.match((await service.log({ remoteUrl, limit: 1 })).log, /seed large rename tree/u);

    const renamed = await service.commit({
      remoteUrl,
      message: "Rename the large review tree",
      characterId: "character-reviewer",
      characterName: "Reviewer",
    });
    assert.equal(renamed.changedPaths, 900);
    assert.equal((await service.push(remoteUrl)).pushedCommits, 1);

    writeFileSync(join(checkout, destinationName, fileNames[0]!), "one small follow-up\n", "utf8");
    const followUp = await service.commit({
      remoteUrl,
      message: "Update one file in the large tree",
      characterId: "character-reviewer",
      characterName: "Reviewer",
    });
    assert.match(followUp.commit, /^[a-f0-9]{40}$/u);
    assert.equal((await service.push(remoteUrl)).pushedCommits, 1);

    const sharedBlobOne = join(checkout, "shared-large-one.bin");
    const sharedBlobTwo = join(checkout, "shared-large-two.bin");
    writeFileSync(sharedBlobOne, "", "utf8");
    truncateSync(sharedBlobOne, 40 * 1024 * 1024);
    linkSync(sharedBlobOne, sharedBlobTwo);
    const shared = await service.commit({
      remoteUrl,
      message: "Add one shared large object at two paths",
      characterId: "character-reviewer",
      characterName: "Reviewer",
    });
    assert.equal(shared.changedPaths, 2, "identical new blobs are scanned and charged once");
    assert.equal((await service.push(remoteUrl)).pushedCommits, 1);

    const preservedStagedPath = join(checkout, "preserved-staged.txt");
    writeFileSync(preservedStagedPath, "keep this exact staged state\n", "utf8");
    execFileSync("git", ["add", "--", "preserved-staged.txt"], { cwd: checkout });
    const intentToAddPath = join(checkout, "intent-to-add.txt");
    writeFileSync(intentToAddPath, "", "utf8");
    execFileSync("git", ["add", "--intent-to-add", "--", "intent-to-add.txt"], { cwd: checkout });
    execFileSync("git", ["update-index", "--assume-unchanged", "--", "README.md"], { cwd: checkout });
    const skippedPath = `${destinationName}/${fileNames[1]!}`;
    execFileSync("git", ["update-index", "--skip-worktree", "--", skippedPath], { cwd: checkout });
    const indexPath = join(checkout, ".git", "index");
    const originalIndexBytes = readFileSync(indexPath);
    const oversized = join(checkout, "genuinely-new-oversized.bin");
    writeFileSync(oversized, "", "utf8");
    truncateSync(oversized, 64 * 1024 * 1024 + 1);
    const headBeforeRejectedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
    await assert.rejects(
      service.commit({
        remoteUrl,
        message: "Must reject genuinely new oversized content",
        characterId: "character-reviewer",
        characterName: "Reviewer",
      }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /content exceeds/u.test(error.message),
    );
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(), headBeforeRejectedCommit);
    assert.deepEqual(readFileSync(indexPath), originalIndexBytes, "rollback must restore every index byte and extended flag");
    assert.equal(
      execFileSync("git", ["diff", "--cached", "--name-only", "--"], { cwd: checkout, encoding: "utf8" }).trim(),
      "preserved-staged.txt",
    );
    assert.match(
      execFileSync("git", ["status", "--porcelain=v1", "--", "genuinely-new-oversized.bin"], { cwd: checkout, encoding: "utf8" }),
      /^\?\? genuinely-new-oversized\.bin$/mu,
    );
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService rejects an in-progress merge before changing the index", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const opened = await service.openRepository(remoteUrl);
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    writeFileSync(join(checkout, "merge-change.md"), "must remain uncommitted\n", "utf8");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim();
    writeFileSync(join(checkout, ".git", "MERGE_HEAD"), `${head}\n`, "utf8");

    await assert.rejects(
      service.commit({
        remoteUrl,
        message: "Must not finish an ambient merge",
        characterId: "character-reviewer",
        characterName: "Reviewer",
      }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /in-progress/u.test(error.message),
    );
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(), head);
    execFileSync("git", ["diff", "--cached", "--quiet", "--exit-code", "--"], { cwd: checkout });
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService reconciles and approves a commit completed as cancellation arrives", async () => {
  const fixture = createRemoteFixture();
  const controller = new AbortController();
  let cancelledCompletedCommit = false;
  try {
    const service = new GitAccessService({
      stateDir: fixture.stateDir,
      workspaceDir: fixture.workspaceDir,
      sshCommandOverride: quote(fixture.fakeSsh),
      runner: async (input) => {
        const result = spawnSync(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
          encoding: "utf8",
          maxBuffer: input.maxOutputBytes + 1024,
        });
        if (result.error) throw result.error;
        if (!cancelledCompletedCommit && input.args.includes("commit") && result.status === 0) {
          cancelledCompletedCommit = true;
          controller.abort();
          throw new GitRepositoryOperationError("Git operation was cancelled");
        }
        return { stdout: result.stdout, stderr: result.stderr, exitCode: result.status ?? -1 };
      },
    });
    service.patchConfig({
      credential: { kind: "external-file", privateKeyPath: fixture.key },
    }, service.getConfig().revision);
    const opened = await service.openRepository(remoteUrl);
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    writeFileSync(join(checkout, "cancel-race.md"), "commit completed before cancellation\n", "utf8");

    const committed = await service.commit({
      remoteUrl,
      message: "Reconcile completed commit  \n\nwith body",
      characterId: "character-reviewer",
      characterName: "Reviewer",
    }, controller.signal);
    assert.equal(cancelledCompletedCommit, true);
    assert.equal(committed.clean, true);
    assert.equal((await service.push(remoteUrl)).pushedCommits, 1, "the reconciled commit must enter the approval ledger");
  } finally {
    fixture.cleanup();
  }
});

test("default Git runner kills the full process group before reporting an output-limit failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-runner-lifecycle-"));
  const marker = join(root, "descendant-survived");
  const pidFile = join(root, "descendant.pid");
  const descendant = join(root, "descendant.mjs");
  const parent = join(root, "parent.mjs");
  writeFileSync(descendant, `
import { writeFileSync } from "node:fs";
const [marker, pidFile] = process.argv.slice(2);
process.on("SIGTERM", () => {});
writeFileSync(pidFile, String(process.pid));
process.stdout.write("ready");
setTimeout(() => writeFileSync(marker, "survived"), 500);
setInterval(() => {}, 1_000);
`, "utf8");
  writeFileSync(parent, `
import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(descendant)}, ...process.argv.slice(2)], {
  stdio: ["ignore", "pipe", "ignore"],
});
process.on("SIGTERM", () => process.exit(0));
child.stdout.once("data", () => process.stdout.write("x".repeat(2_048)));
setInterval(() => {}, 1_000);
`, "utf8");
  try {
    await assert.rejects(
      __spawnGitCommandForTest({
        command: process.execPath,
        args: [parent, marker, pidFile],
        cwd: root,
        env: process.env,
        timeoutMs: 5_000,
        maxOutputBytes: 1_024,
      }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /output exceeded/u.test(error.message),
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 800));
    assert.equal(existsSync(marker), false, "a TERM-ignoring descendant must not outlive the rejected runner promise");
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (Number.isInteger(pid) && pid > 1) {
        try { process.kill(pid, "SIGKILL"); } catch { /* Already killed by the runner. */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitAccessService reuses a unique legacy checkout and keeps user/port repository identities separate", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const first = await service.openRepository(remoteUrl);
    const expected = join(fixture.workspaceDir, first.workspacePath);
    const legacy = join(fixture.workspaceDir, "repos", "Review");
    renameSync(expected, legacy);

    const reopened = await service.openRepository(remoteUrl);
    assert.equal(reopened.cloned, false);
    assert.equal(reopened.workspacePath, "repos/Review");

    const secondUser = await service.openRepository("ssh://reviewer@example.test/owner/review.git");
    const secondPort = await service.openRepository("ssh://git@example.test:2222/owner/review.git");
    assert.equal(secondUser.workspacePath, "repos/example.test/reviewer/owner/review");
    assert.equal(secondPort.workspacePath, "repos/example.test-p2222/git/owner/review");
    assert.notEqual(secondUser.workspacePath, secondPort.workspacePath);
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService fails closed for symlinks below Workspace/repos", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const outside = join(fixture.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(fixture.workspaceDir, "repos", "escape"));
    await assert.rejects(
      service.openRepository(remoteUrl),
      (error: unknown) => error instanceof GitRepositoryOperationError && /Symbolic links/u.test(error.message),
    );
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService accepts only normalized option-safe SSH repository URLs", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const invalidRemotes = [
      "git@example.test:owner/review.git",
      "https://example.test/owner/review.git",
      "ssh://-user@example.test/owner/review.git",
      "ssh://git@-example.test/owner/review.git",
      "ssh://git@example..test/owner/review.git",
      "ssh://git@example.test/-owner/review.git",
      "ssh://git@example.test/owner/../review.git",
      "ssh://git@example.test/owner/review%2egit",
      "ssh://git@example.test:0/owner/review.git",
      "ssh://git@example.test:65536/owner/review.git",
      "ssh://git@example.test/owner/review.git?ref=main",
    ];
    for (const invalidRemote of invalidRemotes) {
      await assert.rejects(
        service.openRepository(invalidRemote),
        (error: unknown) => error instanceof GitRepositoryConfigurationError,
        invalidRemote,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService rejects executable local filters before they can run with host credentials", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const opened = await service.openRepository(remoteUrl);
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    const marker = join(fixture.root, "filter-executed");
    const filter = join(fixture.root, "malicious-filter.mjs");
    writeFileSync(filter, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "executed");\n`, "utf8");
    chmodSync(filter, 0o700);
    execFileSync("git", ["config", "--local", "filter.exfil.clean", `${process.execPath} ${filter}`], { cwd: checkout });
    writeFileSync(join(checkout, ".gitattributes"), "*.txt filter=exfil\n", "utf8");
    writeFileSync(join(checkout, "payload.txt"), "do not execute filters\n", "utf8");
    await assert.rejects(
      service.commit({ remoteUrl, message: "unsafe filter", characterId: "c", characterName: "C" }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /Unsafe local Git configuration/u.test(error.message),
    );
    assert.equal(existsSync(marker), false, "the configured clean filter must never execute");
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService rejects signature programs before git_log can execute them", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const opened = await service.openRepository(remoteUrl);
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    const marker = join(fixture.root, "gpg-executed");
    const fakeGpg = join(fixture.root, "fake-gpg.mjs");
    writeFileSync(fakeGpg, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "executed");
process.exit(1);
`, { mode: 0o700 });

    const original = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd: checkout, encoding: "utf8" });
    const headerEnd = original.indexOf("\n\n");
    assert.ok(headerEnd > 0);
    const signed = `${original.slice(0, headerEnd)}\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake-test-signature\n -----END PGP SIGNATURE-----${original.slice(headerEnd)}`;
    const signedCommit = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], {
      cwd: checkout,
      encoding: "utf8",
      input: signed,
    }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", signedCommit], { cwd: checkout });
    execFileSync("git", ["config", "--local", "log.showSignature", "true"], { cwd: checkout });
    execFileSync("git", ["config", "--local", "gpg.program", fakeGpg], { cwd: checkout });

    try {
      execFileSync("git", ["log", "-1", "--show-signature"], { cwd: checkout, stdio: "ignore" });
    } catch {
      // The fake verifier deliberately fails; execution of it is the control.
    }
    assert.equal(existsSync(marker), true, "plain git log should demonstrate that the configured verifier is executable");
    rmSync(marker);

    await assert.rejects(
      service.log({ remoteUrl, limit: 1 }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /Unsafe local Git configuration/u.test(error.message),
    );
    assert.equal(existsSync(marker), false, "git_log must reject local executable configuration before running log");
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService denies command-valued maintenance, diff, merge, ref, and push configuration", async () => {
  const fixture = createRemoteFixture();
  try {
    const service = configuredService(fixture);
    const opened = await service.openRepository(remoteUrl);
    const checkout = join(fixture.workspaceDir, opened.workspacePath);
    const executableKeys = [
      "core.alternateRefsCommand",
      "gc.recentObjectsHook",
      "maintenance.repo-maintenance.task",
      "diff.external",
      "diff.exfil.command",
      "merge.exfil.driver",
      "push.gpgSign",
      "gpg.program",
    ];
    for (const key of executableKeys) {
      execFileSync("git", ["config", "--local", key, key === "push.gpgSign" ? "true" : "/bin/false"], { cwd: checkout });
      await assert.rejects(
        service.status(remoteUrl),
        (error: unknown) => error instanceof GitRepositoryOperationError &&
          error.message.toLowerCase().includes(`unsafe local git configuration is not allowed: ${key.toLowerCase()}`),
      );
      execFileSync("git", ["config", "--local", "--unset-all", key], { cwd: checkout });
    }
  } finally {
    fixture.cleanup();
  }
});

test("GitAccessService migrates the V2 default identity and generates a restart-safe default managed key", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-access-migration-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const key = join(root, "key");
  mkdirSync(join(stateDir, "git"), { recursive: true, mode: 0o700 });
  mkdirSync(workspaceDir, { mode: 0o700 });
  writeFileSync(key, "test key\n", { mode: 0o600 });
  const registryPath = join(stateDir, "git", "registry.json");
  writeFileSync(registryPath, JSON.stringify({
    version: "yourchar-git-v2",
    defaults: { identityId: "identity_default", repositoryId: "repository_default" },
    identities: [{
      id: "identity_default",
      storageKey: "default-old",
      credential: { kind: "external-file", privateKeyPath: key },
    }],
    repositories: [{
      id: "repository_default",
      identityId: "identity_default",
      proxyMode: "hclient",
      proxyPort: 61234,
    }],
  }), { mode: 0o600 });
  try {
    const service = new GitAccessService({ stateDir, workspaceDir });
    assert.deepEqual(service.getConfig().credential, { kind: "external-file", privateKeyPath: key });
    assert.equal(service.getConfig().proxyMode, "hclient");
    assert.equal(service.getConfig().proxyPort, 61234);
    assert.equal(existsSync(registryPath), true);
    const stored = JSON.parse(readFileSync(join(stateDir, "git", "access.json"), "utf8")) as { migration?: { source?: string } };
    assert.equal(stored.migration?.source, "git-registry-v2");
    const generated = await service.generateKey(service.getConfig().revision);
    assert.equal(generated.config.credential.kind, "managed-ed25519");
    assert.equal(generated.config.configured, true);
    assert.equal(existsSync(join(stateDir, "git", "credentials", "default", "id_ed25519")), true);
    const restarted = new GitAccessService({ stateDir, workspaceDir });
    assert.deepEqual(restarted.getConfig().credential, { kind: "managed-ed25519" });
    assert.equal(restarted.getConfig().configured, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitAccessService with no state is unconfigured and performs no writes", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-access-disabled-"));
  const workspaceDir = join(root, "missing-workspace");
  try {
    const service = new GitAccessService({ workspaceDir });
    assert.equal(service.getConfig().configured, false);
    assert.equal(existsSync(workspaceDir), false);
    assert.throws(
      () => service.patchConfig({ credential: { kind: "unconfigured" } }, 0),
      (error: unknown) => error instanceof GitRepositoryConfigurationError && /Persistent state/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed key generation rolls back if an Agent turn starts before publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-access-key-race-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(workspaceDir, { mode: 0o700 });
  try {
    const service = new GitAccessService({ stateDir, workspaceDir });
    await assert.rejects(
      service.generateKey(0, () => { throw new Error("Agent turn started"); }),
      /Agent turn started/u,
    );
    assert.deepEqual(service.getConfig().credential, { kind: "unconfigured" });
    assert.equal(service.getConfig().revision, 0);
    assert.equal(existsSync(join(stateDir, "git", "credentials", "default", "id_ed25519")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function configuredService(fixture: ReturnType<typeof createRemoteFixture>): GitAccessService {
  const service = new GitAccessService({
    stateDir: fixture.stateDir,
    workspaceDir: fixture.workspaceDir,
    sshCommandOverride: quote(fixture.fakeSsh),
  });
  const config = service.getConfig();
  if (!config.configured) {
    service.patchConfig({ credential: { kind: "external-file", privateKeyPath: fixture.key } }, config.revision);
  }
  return service;
}

function createRemoteFixture() {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-access-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const key = join(root, "key");
  const fakeSsh = join(root, "fake-ssh.mjs");
  mkdirSync(stateDir, { mode: 0o700 });
  mkdirSync(workspaceDir, { mode: 0o700 });
  writeFileSync(key, "test-only-key\n", { mode: 0o600 });
  writeFileSync(fakeSsh, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const bare = ${JSON.stringify(bare)};
const command = process.argv.at(-1) || "";
const service = command.includes("git-upload-pack") ? "upload-pack" : command.includes("git-receive-pack") ? "receive-pack" : "";
if (!service) process.exit(2);
const result = spawnSync("git", [service, bare], { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  execFileSync("git", ["init", "--bare", bare]);
  execFileSync("git", ["init", "-b", "main", seed]);
  writeFileSync(join(seed, "README.md"), "# Review\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: seed });
  execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.test", "commit", "-m", "seed"], { cwd: seed });
  execFileSync("git", ["push", bare, "HEAD:main"], { cwd: seed });
  execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: bare });
  return { root, stateDir, workspaceDir, bare, key, fakeSsh, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function quote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
