import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { AppDatabase } from "../src/storage/database.js";
import { ScriptedModelController } from "../src/testing/runtime.js";

const legacyMarker = "LEGACY_GLOBAL_DO_NOT_INJECT";

test("R0 null-character memories stay quarantined through management, export, backup, and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "rp-agent-legacy-memory-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const clock = new VirtualClock("2026-07-16T08:00:00.000Z");
  let kernel: CompanionKernel | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    seedR0MemoryFixture(stateDir);
    const model = new ScriptedModelController("legacy-memory-quarantine");
    model.enqueue([{ kind: "assistant_text", text: "剧情继续。" }]);
    kernel = new CompanionKernel({
      stateDir,
      clock,
      modelResolver: model.resolver,
      startScheduler: false,
      quietHours: false,
    });
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: "http://test.invalid/v1",
      model: "scripted-model",
    });

    const initialLegacy = kernel.rpService.listAllMemories();
    assert.equal(initialLegacy.length, 4);
    assert.deepEqual(
      initialLegacy.map((memory) => [memory.id, memory.validity]),
      [
        ["legacy_active", "active"],
        ["legacy_deleted", "deleted"],
        ["legacy_pending", "pending"],
        ["legacy_superseded", "superseded"],
      ],
    );
    for (const memory of initialLegacy) {
      assert.equal(memory.realm, "legacy");
      assert.equal(memory.scope, "quarantine");
      assert.equal(memory.characterId, undefined);
      assert.ok(memory.quarantineReasons?.includes("missing_character"));
    }

    const character = kernel.createCharacter({ name: "隔离测试角色" });
    kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "plot_event",
      content: "角色正在调查旧站台",
      characterId: character.id,
      confirmed: true,
    });

    server = createHttpServer({ kernel });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const validity of ["active", "pending", "superseded", "deleted"]) {
      const response = await fetch(`${baseUrl}/api/v1/memories?realm=legacy&validity=${validity}`);
      assert.equal(response.status, 200);
      const body = await response.json() as { memories: Array<{ id: string; realm: string; scope: string }> };
      assert.equal(body.memories.length, 1);
      assert.equal(body.memories[0].id, `legacy_${validity}`);
      assert.equal(body.memories[0].realm, "legacy");
      assert.equal(body.memories[0].scope, "quarantine");
    }

    const corrected = await fetch(`${baseUrl}/api/v1/memories/legacy_active`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${legacyMarker}: corrected` }),
    });
    assert.equal(corrected.status, 200);
    assert.equal(
      ((await corrected.json()) as { memory: { realm: string; content: string } }).memory.realm,
      "legacy",
    );
    const deleted = await fetch(`${baseUrl}/api/v1/memories/legacy_pending`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(
      ((await deleted.json()) as { memory: { realm: string; validity: string } }).memory.validity,
      "deleted",
    );

    const exported = await fetch(`${baseUrl}/api/v1/export`);
    assert.equal(exported.status, 200);
    const exportBody = await exported.json() as {
      memories: Array<{ id: string; realm: string; scope: string }>;
    };
    assert.equal(exportBody.memories.length, 5);
    assert.equal(exportBody.memories.filter((memory) => memory.realm === "legacy").length, 4);
    assert.equal(exportBody.memories.filter((memory) => memory.scope === "quarantine").length, 4);

    await kernel.sendMessage("legacy-isolation", {
      mode: "rp",
      characterId: character.id,
      text: "继续调查站台。",
    });
    const providerContext = `${model.requests[0].systemPrompt}\n${JSON.stringify(model.requests[0].messages)}`;
    assert.match(providerContext, /角色正在调查旧站台/);
    assert.doesNotMatch(providerContext, new RegExp(legacyMarker));

    await closeServer(server);
    server = undefined;
    kernel.dispose();
    kernel = undefined;

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    kernel = new CompanionKernel({ stateDir: restoredDir, clock, startScheduler: false });
    const restored = kernel.rpService.listAllMemories();
    assert.equal(restored.length, 5);
    assert.equal(restored.filter((memory) => memory.realm === "legacy").length, 4);
    assert.equal(kernel.rpService.getMemory("legacy_active").content, `${legacyMarker}: corrected`);
    assert.equal(kernel.rpService.getMemory("legacy_pending").validity, "deleted");
    assert.equal(kernel.deleteRpMemory("legacy_active").validity, "deleted");
    kernel.dispose();
    kernel = new CompanionKernel({ stateDir: restoredDir, clock, startScheduler: false });
    assert.equal(kernel.rpService.getMemory("legacy_active").realm, "legacy");
    assert.equal(kernel.rpService.getMemory("legacy_active").validity, "deleted");

    const raw = new DatabaseSync(join(restoredDir, "rp-agent.sqlite"), { readOnly: true });
    try {
      const count = raw.prepare("SELECT COUNT(*) AS count FROM rp_memories WHERE character_id IS NULL").get() as {
        count: number;
      };
      assert.equal(Number(count.count), 4);
    } finally {
      raw.close();
    }
  } finally {
    if (server) await closeServer(server);
    kernel?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedR0MemoryFixture(stateDir: string): void {
  const databasePath = join(stateDir, "rp-agent.sqlite");
  const database = new AppDatabase(databasePath);
  database.close();
  const raw = new DatabaseSync(databasePath);
  try {
    const insert = raw.prepare(`
      INSERT INTO rp_memories(
        id, type, memory_key, content, normalized_content, source_session_id,
        source_message_id, character_id, salience, confidence, validity,
        confirmed, tags_json, superseded_by_id, idempotency_key,
        created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const rows = [
      ["legacy_active", "user_fact", "user.city", `${legacyMarker}: active`, "legacyglobaldonotinjectactive", "active", 1, null],
      ["legacy_pending", "preference", "user.drink", `${legacyMarker}: pending`, "legacyglobaldonotinjectpending", "pending", 0, null],
      ["legacy_superseded", "world_fact", "world.old", `${legacyMarker}: superseded`, "legacyglobaldonotinjectsuperseded", "superseded", 1, "legacy_active"],
      ["legacy_deleted", "boundary", "boundary.old", `${legacyMarker}: deleted`, "legacyglobaldonotinjectdeleted", "deleted", 1, null],
    ] as const;
    for (const [id, type, key, content, normalized, validity, confirmed, supersededById] of rows) {
      insert.run(
        id,
        type,
        key,
        content,
        normalized,
        "r0-session",
        `${id}-message`,
        0.8,
        0.9,
        validity,
        confirmed,
        JSON.stringify(["r0", "legacy"]),
        supersededById,
        `${id}-idempotency`,
        "2025-01-01T00:00:00.000Z",
        "2025-01-01T00:00:00.000Z",
        null,
      );
      raw.prepare("INSERT INTO rp_memories_fts(memory_id, content, tags) VALUES (?, ?, ?)")
        .run(id, content, "r0 legacy");
    }
  } finally {
    raw.close();
  }
}

async function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
