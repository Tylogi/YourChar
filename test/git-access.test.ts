import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  GitAccessService,
  GitRepositoryConfigurationError,
  GitRepositoryOperationError,
} from "../src/git/index.js";

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
