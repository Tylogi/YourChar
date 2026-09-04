import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import {
  MemoryVaultService,
  MemoryVaultSimulatedCrashError,
  type MemoryVaultFailpoint,
} from "../src/memory-vault/index.js";
import type { RpMemory } from "../src/rp/types.js";
import { AppDatabase } from "../src/storage/database.js";

const now = "2026-09-01T08:00:00.000Z";

test("managed Git history checkpoints semantic Vault mutations, restores transactionally, and hard-purges old objects", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-vault-history-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const vault = new MemoryVaultService({ database, clock: new VirtualClock(now), stateDir });
  const historyPath = join(stateDir, "memory-vault-history.git");
  try {
    assert.equal(vault.listHistory().length, 1);
    assert.equal(vault.listHistory()[0].operation, "startup_reconcile");
    assert.equal(existsSync(join(stateDir, "memory-vault", ".git")), false);

    execFileSync("git", [
      `--git-dir=${historyPath}`,
      "config",
      "filter.history-test.clean",
      "/definitely/missing-history-filter",
    ]);
    execFileSync("git", [
      `--git-dir=${historyPath}`,
      "config",
      "filter.history-test.required",
      "true",
    ]);
    writeFileSync(join(stateDir, "memory-vault", ".gitattributes"), "*.md filter=history-test\n");

    vault.writeProfile("# User profile\n\nHISTORY_PROFILE_ALPHA");
    const alpha = vault.listHistory()[0];
    vault.writeProfile("# User profile\n\nHISTORY_PROFILE_BRAVO");
    assert.equal(vault.listHistory()[0].operation, "profile_write");

    const memory = historyMemory();
    vault.writeMemory(memory, "history-memory-create");
    const countBeforeTouch = vault.listHistory(100).length;
    vault.touchMemories([memory.id]);
    assert.equal(vault.listHistory(100).length, countBeforeTouch);
    assert.equal(vault.health().history.checkpointPending, true);

    const restored = vault.restoreHistoryCheckpoint(alpha.commitId);
    assert.match(vault.getProfile()!.markdown, /HISTORY_PROFILE_ALPHA/u);
    assert.equal(restored.vaultHash, alpha.vaultHash);
    assert.equal(vault.listHistory()[0].operation, "history_restore");
    assert.equal(vault.health().history.checkpointPending, false);

    const messages = execFileSync(
      "git",
      [`--git-dir=${historyPath}`, "log", "--format=%B"],
      { encoding: "utf8" },
    );
    assert.doesNotMatch(messages, /HISTORY_PROFILE_ALPHA|HISTORY_PROFILE_BRAVO|HISTORY_MEMORY_BODY/u);
    assert.match(messages, /operation-id: vault-op-/u);
    assert.doesNotMatch(execFileSync(
      "git",
      [`--git-dir=${historyPath}`, "ls-tree", "-r", "--name-only", "refs/heads/main"],
      { encoding: "utf8" },
    ), /\.gitattributes/u);

    const oldCommit = vault.listHistory().at(-1)!.commitId;
    assert.ok(vault.deleteAll() > 0);
    const afterPurge = vault.listHistory();
    assert.equal(afterPurge.length, 1);
    assert.equal(afterPurge[0].operation, "vault_delete_all");
    assert.equal(afterPurge[0].documentCount, 0);
    assert.notEqual(afterPurge[0].commitId, oldCommit);
    assert.notEqual(spawnSync(
      "git",
      [`--git-dir=${historyPath}`, "cat-file", "-e", `${oldCommit}^{commit}`],
      { stdio: "ignore" },
    ).status, 0);
  } finally {
    vault.dispose();
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a damaged secondary history layer never rolls back a completed authoritative Vault write and can recover", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-vault-history-degraded-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  const vault = new MemoryVaultService({ database, clock: new VirtualClock(now), stateDir });
  const headPath = join(stateDir, "memory-vault-history.git", "HEAD");
  try {
    vault.writeProfile("# User profile\n\nhealthy history");
    writeFileSync(headPath, "ref: refs/heads/untrusted\n");
    vault.writeProfile("# User profile\n\ncanonical write survives");
    assert.match(vault.getProfile()!.markdown, /canonical write survives/u);
    assert.equal(vault.health().projectionConsistent, true);
    assert.equal(vault.health().history.available, false);
    assert.match(vault.health().history.lastError ?? "", /HEAD is not main/u);

    writeFileSync(headPath, "ref: refs/heads/main\n");
    vault.writeProfile("# User profile\n\nrecovered history");
    assert.equal(vault.health().history.available, true);
    assert.equal(vault.health().history.lastError, null);
    assert.equal(vault.listHistory()[0].operation, "profile_write");
  } finally {
    vault.dispose();
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a durable purge intent destroys pre-delete commits after crash recovery", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-vault-history-purge-recovery-"));
  const database = new AppDatabase(join(stateDir, "rp-agent.sqlite"));
  let armed = false;
  const failpoint: MemoryVaultFailpoint = (name) => {
    if (armed && name === "journal.after_state_committed") {
      throw new MemoryVaultSimulatedCrashError(name);
    }
  };
  let vault: MemoryVaultService | undefined = new MemoryVaultService({
    database,
    clock: new VirtualClock(now),
    stateDir,
    failpoint,
  });
  try {
    vault.writeProfile("# User profile\n\nPURGE_CRASH_SECRET");
    const oldCommit = vault.listHistory()[0].commitId;
    armed = true;
    assert.throws(() => vault!.deleteAll(), MemoryVaultSimulatedCrashError);
    assert.equal(existsSync(join(stateDir, "memory-vault-history-purge.json")), true);
    vault.dispose();
    vault = undefined;

    const recovered = new MemoryVaultService({
      database,
      clock: new VirtualClock(now),
      stateDir,
    });
    vault = recovered;
    assert.equal(recovered.listHistory().length, 1);
    assert.equal(recovered.listHistory()[0].operation, "vault_delete_all");
    assert.equal(recovered.listHistory()[0].documentCount, 0);
    assert.equal(existsSync(join(stateDir, "memory-vault-history-purge.json")), false);
    assert.notEqual(spawnSync(
      "git",
      [`--git-dir=${join(stateDir, "memory-vault-history.git")}`, "cat-file", "-e", `${oldCommit}^{commit}`],
      { stdio: "ignore" },
    ).status, 0);
  } finally {
    vault?.dispose();
    database.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("history HTTP metadata omits bodies and restore requires the local control capability plus confirmation", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-vault-history-http-"));
  const kernel = new CompanionKernel({
    stateDir,
    clock: new VirtualClock(now),
    idGenerator: new SeededIdGenerator("vault-history-http"),
    startScheduler: false,
    quietHours: false,
  });
  const server = createHttpServer({ kernel });
  try {
    kernel.updateUserProfile("# User profile\n\nHTTP_HISTORY_ALPHA");
    const alpha = kernel.listMemoryVaultHistory()[0];
    kernel.updateUserProfile("# User profile\n\nHTTP_HISTORY_BRAVO");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;

    const historyResponse = await fetch(`${origin}/api/v1/memory-vault/history?limit=10`);
    assert.equal(historyResponse.status, 200);
    const historyBody = await historyResponse.json() as Record<string, unknown>;
    assert.doesNotMatch(JSON.stringify(historyBody), /HTTP_HISTORY_ALPHA|HTTP_HISTORY_BRAVO/u);

    const denied = await fetch(`${origin}/api/v1/memory-vault/history/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ commitId: alpha.commitId, confirm: "RESTORE_MEMORY_VAULT" }),
    });
    assert.equal(denied.status, 403);

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const headers = {
      "content-type": "application/json",
      cookie,
      origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "sec-fetch-dest": "empty",
    };
    const unconfirmed = await fetch(`${origin}/api/v1/memory-vault/history/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ commitId: alpha.commitId, confirm: "wrong" }),
    });
    assert.equal(unconfirmed.status, 400);

    const restored = await fetch(`${origin}/api/v1/memory-vault/history/restore`, {
      method: "POST",
      headers,
      body: JSON.stringify({ commitId: alpha.commitId, confirm: "RESTORE_MEMORY_VAULT" }),
    });
    assert.equal(restored.status, 200, await restored.text());
    assert.match(kernel.getUserProfile().markdown, /HTTP_HISTORY_ALPHA/u);
  } finally {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function historyMemory(): RpMemory {
  return {
    id: "history_memory",
    conversationSpace: "normal",
    realm: "reality",
    scope: "global",
    type: "user_fact",
    content: "HISTORY_MEMORY_BODY",
    normalizedContent: "historymemorybody",
    sourceSessionId: "history-session",
    sourceMessageId: "history-message",
    salience: 0.8,
    confidence: 0.95,
    validity: "active",
    confirmed: true,
    confirmationProvenance: {
      kind: "trusted_control_plane",
      actor: "user",
      confirmedAt: now,
      evidenceMessageId: "history-message",
    },
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}
