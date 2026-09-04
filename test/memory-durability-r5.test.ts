import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import {
  durableAtomicWrite,
  MemoryVaultError,
  MemoryVaultService,
  MemoryVaultSimulatedCrashError,
  type MemoryVaultFailpoint,
} from "../src/memory-vault/index.js";
import { MemoryCoordinatorRepository } from "../src/memory-coordinator/repository.js";
import type { MemoryExtractionJob } from "../src/memory-coordinator/types.js";
import { AppDatabase } from "../src/storage/database.js";

const now = "2026-07-16T08:00:00.000Z";

test("durableAtomicWrite completes partial Uint8Array writes and creates durable private parents", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r5-short-write-"));
  const target = join(root, "nested", "state.bin");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  let chunks = 0;
  try {
    const expected = Buffer.from("partial-write-contract", "utf8");
    durableAtomicWrite(target, new Uint8Array(expected), {
      writeChunk: (descriptor, bytes, offset, length) => {
        chunks += 1;
        return writeSync(descriptor, bytes, offset, Math.min(length, 3));
      },
    });
    assert.deepEqual(readFileSync(target), expected);
    assert.ok(chunks > 1);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writer lease fences a second process, expires after crash, and permits immediate graceful restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r5-writer-process-"));
  const stateDir = join(root, "nested", "state");
  const childSource = `
    import { AppDatabase } from './dist/src/storage/database.js';
    import { SystemClock } from './dist/src/app/clock.js';
    import { MemoryVaultService } from './dist/src/memory-vault/service.js';
    import { join } from 'node:path';
    const stateDir = process.argv[1];
    const db = new AppDatabase(join(stateDir, 'rp-agent.sqlite'));
    const vault = new MemoryVaultService({ database: db, clock: new SystemClock(), stateDir });
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", childSource, stateDir], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let database: AppDatabase | undefined;
  let recovered: MemoryVaultService | undefined;
  try {
    await waitForReady(child);
    assert.equal(existsSync(stateDir), true);
    database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
    assert.throws(
      () => new MemoryVaultService({ database: database!, clock: new VirtualClock(now), stateDir }),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_WRITER_BUSY",
    );
    const held = database.connection.prepare(
      "SELECT fence_token, process_identity FROM memory_vault_writer_lease WHERE singleton = 1",
    ).get() as { fence_token: number; process_identity: string };
    assert.match(held.process_identity, /^\d+:/);

    child.kill("SIGKILL");
    await waitForExit(child);
    assert.throws(
      () => new MemoryVaultService({ database: database!, clock: new VirtualClock(now), stateDir }),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_WRITER_BUSY",
    );
    database.connection.prepare(
      "UPDATE memory_vault_writer_lease SET expires_at = ? WHERE singleton = 1",
    ).run("2000-01-01T00:00:00.000Z");
    recovered = new MemoryVaultService({ database, clock: new VirtualClock(now), stateDir });
    assert.ok(recovered.health().writer.fenceToken > held.fence_token);
    recovered.dispose();
    recovered = undefined;
    const immediate = new MemoryVaultService({ database, clock: new VirtualClock(now), stateDir });
    immediate.dispose();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    recovered?.dispose();
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("constructor recovery failure releases the writer lease and heartbeat immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r5-constructor-release-"));
  const stateDir = join(root, "state");
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const broken = join(stateDir, "memory-vault-journal", "vault-op-broken");
  mkdirSync(broken, { recursive: true, mode: 0o700 });
  writeFileSync(join(broken, "journal.json"), "not-json", { mode: 0o600 });
  try {
    assert.throws(
      () => new MemoryVaultService({ database, clock: new VirtualClock(now), stateDir }),
      (error) => error instanceof MemoryVaultError && error.code === "MEMORY_VAULT_RECOVERY_FAILED",
    );
    rmSync(broken, { recursive: true, force: true });
    const service = new MemoryVaultService({ database, clock: new VirtualClock(now), stateDir });
    service.dispose();
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("expired takeover fences the old writer at its next Vault rename", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r5-stale-commit-"));
  const stateDir = join(root, "state");
  const databasePath = join(stateDir, "rp-agent.sqlite");
  const firstDb = new AppDatabase(databasePath);
  const secondDb = new AppDatabase(databasePath);
  let armed = false;
  let second: MemoryVaultService | undefined;
  const failpoint: MemoryVaultFailpoint = (name) => {
    if (!armed || name !== "vault_file.before_fence") return;
    armed = false;
    secondDb.connection.prepare(
      "UPDATE memory_vault_writer_lease SET expires_at = ? WHERE singleton = 1",
    ).run("2000-01-01T00:00:00.000Z");
    second = new MemoryVaultService({ database: secondDb, clock: new VirtualClock(now), stateDir });
  };
  const first = new MemoryVaultService({ database: firstDb, clock: new VirtualClock(now), stateDir, failpoint });
  try {
    first.writeProfile("# 用户画像\n\n- old writer baseline");
    const oldFence = first.health().writer.fenceToken;
    armed = true;
    assert.throws(
      () => first.writeProfile("# 用户画像\n\n- stale writer must not commit"),
      (error) => error instanceof MemoryVaultError &&
        ["MEMORY_VAULT_STALE_WRITER", "MEMORY_VAULT_RECOVERY_FAILED"].includes(error.code),
    );
    assert.ok(second);
    assert.ok(second!.health().writer.fenceToken > oldFence);
    assert.match(second!.getProfile()!.markdown, /old writer baseline/);
    assert.doesNotMatch(readFileSync(join(stateDir, "memory-vault", "reality", "user-profile.md"), "utf8"), /stale writer must not commit/);
  } finally {
    first.dispose();
    second?.dispose();
    firstDb.close();
    secondDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const profileCrashCases = [
  { failpoint: "journal_snapshot.after_rename", expected: "before" },
  { failpoint: "journal_file.before_rename", expected: "before" },
  { failpoint: "journal_file.after_rename", expected: "before" },
  { failpoint: "journal.after_prepare", expected: "before" },
  { failpoint: "vault_file.before_rename", expected: "before" },
  { failpoint: "vault_file.after_rename", expected: "before" },
  { failpoint: "journal.after_files_committed", expected: "after" },
  { failpoint: "projection.before_commit", expected: "after" },
  { failpoint: "journal.after_projection_committed", expected: "after" },
  { failpoint: "projection.after_commit", expected: "after" },
  { failpoint: "projection_state.before_write", expected: "after" },
  { failpoint: "projection_state_file.before_rename", expected: "after" },
  { failpoint: "projection_state_file.after_rename", expected: "after" },
  { failpoint: "journal.after_state_committed", expected: "after" },
  { failpoint: "profile_mirror_file.before_rename", expected: "after" },
  { failpoint: "profile_mirror_file.after_rename", expected: "after" },
] as const;

test("journal recovery converges profile/projection/mirror at every durable phase", async (context) => {
  for (const scenario of profileCrashCases) {
    await context.test(scenario.failpoint, () => {
      const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r5-journal-phase-"));
      let armed: string | undefined;
      const failpoint: MemoryVaultFailpoint = (name) => {
        if (name !== armed) return;
        armed = undefined;
        throw new MemoryVaultSimulatedCrashError(name);
      };
      let kernel: CompanionKernel | undefined;
      let restarted: CompanionKernel | undefined;
      try {
        kernel = createKernel(stateDir, `phase-${scenario.failpoint}`, failpoint);
        kernel.updateUserProfile("# 用户画像\n\n- before checkpoint");
        armed = scenario.failpoint;
        assert.throws(
          () => kernel!.updateUserProfile("# 用户画像\n\n- after checkpoint"),
          MemoryVaultSimulatedCrashError,
        );
        kernel.dispose();
        kernel = undefined;

        restarted = createKernel(stateDir, `restart-${scenario.failpoint}`);
        const expected = scenario.expected === "after" ? "after checkpoint" : "before checkpoint";
        assert.match(restarted.getUserProfile().markdown, new RegExp(expected));
        assert.match(readFileSync(join(stateDir, "user-profile.md"), "utf8"), new RegExp(expected));
        const health = restarted.getMemoryVaultHealth();
        assert.equal(health.journal.pendingCount, 0);
        assert.equal(health.projectionConsistent, true);
      } finally {
        kernel?.dispose();
        restarted?.dispose();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test("mid-pair correction and multi-touch crashes recover without half documents or revisions", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r5-multi-file-"));
  let vaultRenames = 0;
  let crashOnRename = 0;
  const failpoint: MemoryVaultFailpoint = (name) => {
    if (name !== "vault_file.after_rename" || crashOnRename === 0) return;
    vaultRenames += 1;
    if (vaultRenames === crashOnRename) {
      crashOnRename = 0;
      throw new MemoryVaultSimulatedCrashError(name);
    }
  };
  let kernel: CompanionKernel | undefined;
  let restarted: CompanionKernel | undefined;
  try {
    kernel = createKernel(stateDir, "multi", failpoint);
    const character = kernel.createCharacter({ name: "事务角色" });
    const first = kernel.writeRpMemory({
      realm: "roleplay", scope: "character", type: "world_fact", key: "world.color",
      content: "门是蓝色", characterId: character.id, confirmed: true,
    }).memory!;
    const second = kernel.writeRpMemory({
      realm: "roleplay", scope: "character", type: "plot_event",
      content: "钟声已经响起", characterId: character.id, confirmed: true,
    }).memory!;
    const firstSource = readMemorySource(stateDir, character.id, first.id);
    const secondSource = readMemorySource(stateDir, character.id, second.id);
    const replacement = {
      ...first,
      id: "memory_r5_replacement",
      content: "门是红色",
      normalizedContent: "门是红色",
      createdAt: now,
      updatedAt: now,
    };
    vaultRenames = 0;
    crashOnRename = 2;
    assert.throws(() => kernel!.memoryVault.writeMemoryPair(replacement, {
      ...first, validity: "superseded", supersededById: replacement.id, updatedAt: now,
    }), MemoryVaultSimulatedCrashError);
    kernel.dispose();
    kernel = undefined;
    restarted = createKernel(stateDir, "multi-restart-pair");
    assert.equal(readMemorySource(stateDir, character.id, first.id), firstSource);
    assert.equal(existsSync(memoryPath(stateDir, character.id, replacement.id)), false);
    assert.equal(restarted.rpService.repository.getMemory(first.id)?.validity, "active");

    restarted.dispose();
    restarted = undefined;
    kernel = createKernel(stateDir, "multi-touch", failpoint);
    vaultRenames = 0;
    crashOnRename = 2;
    assert.throws(() => kernel!.memoryVault.touchMemories([first.id, second.id]), MemoryVaultSimulatedCrashError);
    kernel.dispose();
    kernel = undefined;
    restarted = createKernel(stateDir, "multi-restart-touch");
    assert.equal(readMemorySource(stateDir, character.id, first.id), firstSource);
    assert.equal(readMemorySource(stateDir, character.id, second.id), secondSource);
    assert.equal(restarted.rpService.repository.getMemory(first.id)?.lastUsedAt, undefined);
    assert.equal(restarted.rpService.repository.getMemory(second.id)?.lastUsedAt, undefined);
  } finally {
    kernel?.dispose();
    restarted?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("scene deletion crash recovery chooses a complete before or after state", async (context) => {
  for (const scenario of [
    { failpoint: "vault_file.before_delete", deleted: false },
    { failpoint: "vault_file.after_delete", deleted: false },
    { failpoint: "journal.after_files_committed", deleted: true },
  ]) {
    await context.test(scenario.failpoint, () => {
      const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r5-scene-delete-"));
      let armed: string | undefined;
      const failpoint: MemoryVaultFailpoint = (name) => {
        if (name !== armed) return;
        armed = undefined;
        throw new MemoryVaultSimulatedCrashError(name);
      };
      let kernel: CompanionKernel | undefined;
      let restarted: CompanionKernel | undefined;
      try {
        kernel = createKernel(stateDir, `scene-${scenario.failpoint}`, failpoint);
        const character = kernel.createCharacter({ name: "场景事务角色" });
        kernel.updateScene("scene-r5-delete", { location: "旧站台", summary: "场景必须完整" }, character.id);
        armed = scenario.failpoint;
        assert.throws(() => kernel!.memoryVault.removeScene("scene-r5-delete"), MemoryVaultSimulatedCrashError);
        kernel.dispose();
        kernel = undefined;
        restarted = createKernel(stateDir, `scene-restart-${scenario.failpoint}`);
        const vaultScene = restarted.memoryVault.getScene("scene-r5-delete");
        const sqliteScene = restarted.database.connection.prepare(
          "SELECT role_session_id FROM scene_states WHERE role_session_id = ?",
        ).get("scene-r5-delete");
        const scenePath = join(stateDir, "memory-vault", "roleplay", "scenes", "scene-r5-delete.md");
        assert.equal(vaultScene === undefined, scenario.deleted);
        assert.equal(sqliteScene === undefined, scenario.deleted);
        assert.equal(existsSync(scenePath), !scenario.deleted);
        assert.equal(restarted.getMemoryVaultHealth().projectionConsistent, true);
      } finally {
        kernel?.dispose();
        restarted?.dispose();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test("reality forget and managed profile mirror recover atomically", async (context) => {
  for (const scenario of [
    { failpoint: "vault_file.after_rename", deleted: false },
    { failpoint: "journal.after_files_committed", deleted: true },
  ]) {
    await context.test(scenario.failpoint, () => {
      const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r5-forget-"));
      let armed: string | undefined;
      let vaultRenameCount = 0;
      const failpoint: MemoryVaultFailpoint = (name) => {
        if (!armed) return;
        if (name === "vault_file.after_rename") {
          vaultRenameCount += 1;
          if (armed !== name || vaultRenameCount !== 2) return;
        } else if (name !== armed) return;
        armed = undefined;
        throw new MemoryVaultSimulatedCrashError(name);
      };
      let kernel: CompanionKernel | undefined;
      let restarted: CompanionKernel | undefined;
      try {
        kernel = createKernel(stateDir, `forget-${scenario.failpoint}`, failpoint);
        kernel.patchAgentPermissions({ userProfileWriteEnabled: true });
        const memory = kernel.memoryLifecycle.captureAuthorized({
          realm: "reality",
          type: "preference",
          key: "user.r5.atomic",
          content: "用户偏好 R5 原子遗忘验证",
          sourceSessionId: "r5-forget",
          sourceMessageId: "r5-forget-message",
          idempotencyKey: `r5-forget-${scenario.failpoint}`,
        });
        assert.match(kernel.getUserProfile().markdown, /R5 原子遗忘验证/);
        vaultRenameCount = 0;
        armed = scenario.failpoint;
        assert.throws(() => kernel!.memoryLifecycle.forget(memory.id), MemoryVaultSimulatedCrashError);
        kernel.dispose();
        kernel = undefined;
        restarted = createKernel(stateDir, `forget-restart-${scenario.failpoint}`);
        const recovered = restarted.memoryLifecycle.get(memory.id);
        assert.equal(recovered.validity === "deleted", scenario.deleted);
        const profile = restarted.getUserProfile().markdown;
        if (scenario.deleted) assert.doesNotMatch(profile, /R5 原子遗忘验证/);
        else assert.match(profile, /R5 原子遗忘验证/);
        assert.equal(readFileSync(join(stateDir, "user-profile.md"), "utf8"), profile);
      } finally {
        kernel?.dispose();
        restarted?.dispose();
        rmSync(stateDir, { recursive: true, force: true });
      }
    });
  }
});

test("Coordinator claims are owner-leased, fenced on completion, and only expire once", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r5-job-lease-"));
  const databasePath = join(root, "state.sqlite");
  const firstDb = new AppDatabase(databasePath);
  const secondDb = new AppDatabase(databasePath);
  const first = new MemoryCoordinatorRepository(firstDb);
  const second = new MemoryCoordinatorRepository(secondDb);
  try {
    const job = extractionJob();
    first.createJob(job);
    const claimed = first.claim(job.id, "owner-a", "token-a", now, "2026-07-16T08:01:00.000Z");
    assert.equal(claimed?.attempts, 1);
    assert.equal(second.claim(job.id, "owner-b", "token-b", "2026-07-16T08:00:30.000Z", "2026-07-16T08:02:00.000Z"), undefined);
    assert.equal(second.listRunnable("2026-07-16T08:00:30.000Z").length, 0);

    const takeover = second.claim(job.id, "owner-b", "token-b", "2026-07-16T08:01:00.001Z", "2026-07-16T08:02:00.000Z");
    assert.equal(takeover?.attempts, 2);
    assert.match(takeover?.triggerReason ?? "", /expired_lease_recovery/);
    assert.equal(first.finish(job.id, "completed", { resultCount: 1 }, now, { ownerId: "owner-a", claimToken: "token-a" }), false);
    assert.equal(second.finish(job.id, "completed", { resultCount: 1 }, "2026-07-16T08:01:01.000Z", { ownerId: "owner-b", claimToken: "token-b" }), true);
    assert.equal(second.getJob(job.id)?.status, "completed");
    assert.equal(second.listRunnable("2030-01-01T00:00:00.000Z").length, 0);
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup v3 preserves Vault v4 secret memories and staged restore rejects corruption without touching target", () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-r5-backup-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const protectedDir = join(root, "protected");
  let kernel: CompanionKernel | undefined;
  try {
    kernel = createKernel(stateDir, "backup");
    kernel.updateUserProfile("# 用户画像\n\n- R5 backup source");
    const backedUpSubagentSettings = kernel.patchSubagentSettings({
      maxConcurrentTasks: 5,
      maxWorkModelCalls: 40,
      maxOutputTokens: 24_000,
      maxResultCharacters: 90_000,
      timeoutSeconds: 2_400,
    }, 0);
    const secretOwner = kernel.createCharacter({ name: "R5 Secret Backup Owner" });
    const secretMemory = kernel.memoryLifecycle.captureAuthorized({
      conversationSpace: "secret",
      secretOwnerCharacterId: secretOwner.id,
      realm: "reality",
      type: "user_fact",
      content: "R5_SECRET_BACKUP_SENTINEL",
      sourceSessionId: "r5-secret-backup",
      sourceMessageId: "r5-secret-backup-message",
      idempotencyKey: "r5-secret-backup",
    });
    kernel.dispose();
    kernel = undefined;
    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], { cwd: process.cwd() });
    const sourceAfterBackup = createKernel(stateDir, "backup-health");
    assert.equal(sourceAfterBackup.getMemoryVaultHealth().backup.valid, true);
    assert.ok(sourceAfterBackup.getMemoryVaultHealth().backup.verifiedAt);
    sourceAfterBackup.dispose();
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.database.schemaVersion, 51);
    assert.equal(manifest.database.integrityCheck, "ok");
    assert.equal(manifest.vault.projectionConsistent, true);
    assert.equal(manifest.containsMemoryVaultHistory, true);
    assert.ok(manifest.files.some((entry: { path: string }) => entry.path === "memory-vault/reality/user-profile.md"));
    assert.ok(manifest.files.some((entry: { path: string }) => entry.path === "memory-vault-history.git/HEAD"));
    const secretVaultPath = `memory-vault/secret/characters/${secretOwner.id}/memories/${secretMemory.id}.md`;
    assert.ok(manifest.files.some((entry: { path: string }) => entry.path === secretVaultPath));
    assert.match(readFileSync(join(backupDir, secretVaultPath), "utf8"), /schemaVersion: 4[\s\S]*conversationSpace: secret/);
    const verify = JSON.parse(execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir, "--verify"], { cwd: process.cwd(), encoding: "utf8" }));
    const dryRun = JSON.parse(execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir, "--dry-run"], { cwd: process.cwd(), encoding: "utf8" }));
    assert.equal(verify.valid, true);
    assert.equal(dryRun.valid, true);
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], { cwd: process.cwd() });
    const restored = createKernel(restoredDir, "backup-restored");
    assert.match(restored.getUserProfile().markdown, /R5 backup source/);
    assert.deepEqual(restored.getSubagentSettings(), backedUpSubagentSettings);
    assert.deepEqual(restored.memoryLifecycle.list({
      query: "R5_SECRET_BACKUP_SENTINEL",
      realm: "reality",
      validity: "active",
      conversationSpace: "secret",
      secretOwnerCharacterId: secretOwner.id,
    }).map((entry) => entry.id), [secretMemory.id]);
    assert.equal(restored.memoryLifecycle.list({
      query: "R5_SECRET_BACKUP_SENTINEL",
      realm: "reality",
      validity: "active",
      conversationSpace: "normal",
    }).length, 0);
    assert.equal(restored.getMemoryVaultHealth().projectionConsistent, true);
    assert.equal(restored.getMemoryVaultHealth().history.available, true);
    assert.ok(restored.listMemoryVaultHistory().length > 0);
    restored.dispose();

    mkdirSync(protectedDir, { recursive: true });
    writeFileSync(join(protectedDir, "sentinel.txt"), "untouched");
    const profileBackup = join(backupDir, "memory-vault", "reality", "user-profile.md");
    writeFileSync(profileBackup, `${readFileSync(profileBackup, "utf8")}tampered`);
    assert.throws(() => execFileSync(
      process.execPath,
      ["scripts/restore-state.mjs", backupDir, protectedDir, "--force"],
      { cwd: process.cwd(), stdio: "pipe" },
    ));
    assert.equal(readFileSync(join(protectedDir, "sentinel.txt"), "utf8"), "untouched");
  } finally {
    kernel?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vault health/recovery APIs expose metadata only and documents have readable titles and paths", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-r5-health-api-"));
  const kernel = createKernel(stateDir, "health-api");
  const server = createHttpServer({ kernel });
  try {
    kernel.updateUserProfile("# 用户画像\n\n- HEALTH_BODY_MUST_NOT_LEAK");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const health = await (await fetch(`${base}/api/v1/memory-vault/health`)).json() as Record<string, unknown>;
    const recovery = await (await fetch(`${base}/api/v1/memory-vault/recovery`)).json() as Record<string, unknown>;
    const documents = await (await fetch(`${base}/api/v1/memory-vault/documents`)).json() as {
      documents: Array<{ title: string; path: string }>;
    };
    for (const value of [health, recovery, documents]) {
      const serialized = JSON.stringify(value);
      assert.doesNotMatch(serialized, /HEALTH_BODY_MUST_NOT_LEAK/);
      assert.doesNotMatch(serialized, /apiKey|provider.*content/i);
    }
    assert.equal((health.health as { writer: { mode: string } }).writer.mode, "writer");
    assert.equal((health.health as { projectionConsistent: boolean }).projectionConsistent, true);
    assert.ok(documents.documents.some((entry) => entry.title === "User Profile" && entry.path === "reality/user-profile.md"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function createKernel(stateDir: string, seed: string, failpoint?: MemoryVaultFailpoint): CompanionKernel {
  return new CompanionKernel({
    stateDir,
    clock: new VirtualClock(now),
    idGenerator: new SeededIdGenerator(seed),
    startScheduler: false,
    quietHours: false,
    memoryVaultFailpoint: failpoint,
  });
}

function extractionJob(): MemoryExtractionJob {
  return {
    id: "job-r5-lease",
    idempotencyKey: "turn:r5-lease",
    sourceContextLogId: "context-r5-lease",
    sessionId: "session-r5-lease",
    sourceMessageId: "message-r5-lease",
    mode: "sms",
    conversationSpace: "normal",
    realm: "reality",
    triggerKind: "durable_signal",
    triggerReason: "durable_signal_detected",
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    inputTokenEstimate: 100,
    resultCount: 0,
    availableAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function memoryPath(stateDir: string, characterId: string, id: string): string {
  return join(stateDir, "memory-vault", "roleplay", "characters", characterId, "memories", `${id}.md`);
}

function readMemorySource(stateDir: string, characterId: string, id: string): string {
  return readFileSync(memoryPath(stateDir, characterId, id), "utf8");
}

async function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("writer child did not become ready")), 5_000);
    child.stdout!.on("data", (chunk) => {
      output += String(chunk);
      if (!output.includes("READY")) return;
      clearTimeout(timer);
      resolve();
    });
    child.stderr!.on("data", (chunk) => {
      output += String(chunk);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`writer child exited early (${String(code)}): ${output}`));
    });
  });
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
