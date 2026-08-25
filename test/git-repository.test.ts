import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  GitRepositoryConfigurationError,
  GitRepositoryOperationError,
  GitRepositoryService,
  GitAccessService,
} from "../src/git/index.js";
import { createTestRuntime } from "../src/testing/runtime.js";

const remoteUrl = "ssh://git@example.test/owner/review.git";

test("fixed Git repository service clones, attributes a safe commit, and non-force pushes", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-service-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const bare = join(root, "remote.git");
  const seed = join(root, "seed");
  const key = join(root, "deploy-key");
  const fakeSsh = join(root, "fake-ssh.mjs");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(key, "test-only-key\n", { mode: 0o600 });
  writeFileSync(fakeSsh, `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const bare = process.argv[2];
const command = process.argv.at(-1) || "";
const service = command.includes("git-upload-pack") ? "upload-pack" : command.includes("git-receive-pack") ? "receive-pack" : "";
if (!service) process.exit(2);
const result = spawnSync("git", [service, bare], { stdio: "inherit" });
process.exit(result.status ?? 1);
`, { mode: 0o700 });
  try {
    execFileSync("git", ["init", "--bare", bare]);
    execFileSync("git", ["init", "-b", "main", seed]);
    writeFileSync(join(seed, "README.md"), "# Review\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: seed });
    execFileSync("git", ["-c", "user.name=Seed", "-c", "user.email=seed@example.test", "commit", "-m", "seed"], { cwd: seed });
    execFileSync("git", ["push", bare, "HEAD:main"], { cwd: seed });

    const service = new GitRepositoryService({
      stateDir,
      workspaceDir,
      sshCommandOverride: `${quote(fakeSsh)} ${quote(bare)}`,
    });
    const config = service.patchConfig({
      repositoryName: "Review",
      remoteUrl,
      branch: "main",
      privateKeyPath: key,
    });
    assert.equal(config.configured, true);
    assert.equal(JSON.stringify(config).includes("test-only-key"), false);
    const registry = JSON.parse(readFileSync(join(stateDir, "git", "registry.json"), "utf8")) as {
      identities: Array<{ credential: { kind: string; privateKeyPath?: string } }>;
      repositories: Array<{ checkoutRelativePath: string }>;
    };
    assert.equal(registry.identities[0]?.credential.kind, "external-file");
    assert.equal(registry.identities[0]?.credential.privateKeyPath, key);

    const connection = await service.testConnection();
    assert.equal(connection.ok, true);
    const cloned = await service.cloneOrSync();
    assert.equal(cloned.cloned, true);
    assert.equal(cloned.clean, true);
    const checkout = join(workspaceDir, registry.repositories[0]!.checkoutRelativePath);
    assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "# Review\n");

    writeFileSync(join(checkout, "review.md"), "LGTM with one revision.\n", "utf8");
    writeFileSync(join(checkout, "README.md"), "# Review\n\nReviewed by YourChar.\n", "utf8");
    const changed = await service.status();
    assert.equal(changed.clean, false);
    assert.match((await service.diff()).diff, /Reviewed by YourChar/u);
    const committed = await service.commit({
      message: "Add character review",
      characterId: "character-nanami",
      characterName: "七海千秋",
    });
    assert.match(committed.commit, /^[a-f0-9]{40}$/u);
    assert.equal(execFileSync("git", ["show", "-s", "--format=%an", "HEAD"], { cwd: checkout, encoding: "utf8" }).trim(), "七海千秋 via YourChar");
    await service.push();
    assert.equal(execFileSync("git", ["show", `${committed.commit}:review.md`], { cwd: bare, encoding: "utf8" }), "LGTM with one revision.\n");

    writeFileSync(join(checkout, "manual.md"), "bypassed connector\n", "utf8");
    execFileSync("git", ["add", "manual.md"], { cwd: checkout });
    execFileSync("git", ["-c", "user.name=Bypass", "-c", "user.email=bypass@example.test", "commit", "-m", "manual"], { cwd: checkout });
    await assert.rejects(
      service.push(),
      (error: unknown) => error instanceof GitRepositoryOperationError && /unapproved local commit/u.test(error.message),
    );
    execFileSync("git", ["reset", "--hard", committed.commit], { cwd: checkout });

    writeFileSync(join(checkout, ".env.production"), `OPENAI_API_KEY=${"sk"}-not-a-real-test-token-value\n`, "utf8");
    await assert.rejects(
      service.commit({ message: "unsafe", characterId: "character-nanami", characterName: "七海千秋" }),
      (error: unknown) => error instanceof GitRepositoryOperationError && /sensitive/u.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git repository configuration rejects unsafe URLs and key symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-config-"));
  const key = join(root, "key");
  const keyLink = join(root, "key-link");
  writeFileSync(key, "test", { mode: 0o600 });
  symlinkSync(key, keyLink);
  try {
    const service = new GitRepositoryService({ stateDir: root, workspaceDir: join(root, "workspace") });
    assert.throws(
      () => service.patchConfig({ remoteUrl: "file:///tmp/repository.git" }),
      (error: unknown) => error instanceof GitRepositoryConfigurationError,
    );
    assert.throws(
      () => service.patchConfig({ privateKeyPath: keyLink }),
      (error: unknown) => error instanceof GitRepositoryConfigurationError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Git MCP is global for normal characters but absent from secret and incognito sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-tools-"));
  const key = join(root, "key");
  writeFileSync(key, "test", { mode: 0o600 });
  const gitService = new GitAccessService({
    stateDir: root,
    workspaceDir: join(root, "workspace"),
    sshCommandOverride: "/bin/false",
  });
  gitService.patchConfig({ credential: { kind: "external-file", privateKeyPath: key } }, 0);
  const runtime = createTestRuntime({ stateDir: root, gitService, seed: "git-tools" });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:git", true);
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    const first = runtime.kernel.createCharacter({ name: "七海千秋" });
    const second = runtime.kernel.createCharacter({ name: "红莉栖" });
    const firstNormal = await runtime.kernel.sessionRuntime.getOrCreateCanonicalDirect("git-first-normal", first.id, "normal");
    const secondNormal = await runtime.kernel.sessionRuntime.getOrCreateCanonicalDirect("git-second-normal", second.id, "normal");
    const firstSecret = await runtime.kernel.sessionRuntime.getOrCreateCanonicalDirect("git-first-secret", first.id, "secret");
    for (const handle of [firstNormal, secondNormal]) {
      assert.ok(handle.toolNames.includes("git_status"));
      assert.ok(handle.toolNames.includes("git_commit"));
      assert.ok(handle.toolNames.includes("git_push"));
    }
    assert.equal(firstSecret.toolNames.some((name) => name.startsWith("git_")), false);
  } finally {
    runtime.kernel.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

function quote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}
