import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CompanionKernel } from "../src/domain/kernel.js";

const now = "2026-08-19T08:00:00.000Z";
const restoreReason = "restored backup: pending IM delivery quarantined";

test("restore preserves IM credentials but quarantines queued delivery state", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-im-restore-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  let sourceDatabase: DatabaseSync | undefined;
  let restoredDatabase: DatabaseSync | undefined;
  try {
    const kernel = new CompanionKernel({
      stateDir,
      startScheduler: false,
      imGateway: false,
      skillInstaller: false,
    });
    const character = kernel.createCharacter({
      name: "IM restore character",
      soulMarkdown: "# SOUL.md\n\nRestore fixture.\n",
    });
    kernel.dispose();

    sourceDatabase = new DatabaseSync(join(stateDir, "rp-agent.sqlite"));
    sourceDatabase.exec("PRAGMA foreign_keys = ON");
    const insertInbound = sourceDatabase.prepare(`
      INSERT INTO im_inbound_events(
        provider, event_id, gateway_connection_id, binding_generation, character_id,
        external_chat_id, external_user_id, chat_type, payload_digest, status,
        attachments_json, received_at, created_at, updated_at, completed_at
      ) VALUES (?, ?, 'connection-secret', 'generation-secret', ?,
        'chat-secret', 'owner-secret', 'direct', ?, 'completed', '[]', ?, ?, ?, ?)
    `);
    const insertOutbox = sourceDatabase.prepare(`
      INSERT INTO im_outbox(
        id, provider, gateway_connection_id, binding_generation,
        external_chat_id, inbound_event_id,
        text, attachments_json, status, attempts, available_at, lease_token,
        lease_expires_at, last_error, created_at, updated_at, delivered_at
      ) VALUES (?, ?, 'connection-secret', 'generation-secret',
        'chat-secret', ?, ?, '[]', ?, 1, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const fixture of [
      { id: "pending", provider: "wechat", status: "pending", lease: "lease-pending", deliveredAt: null },
      { id: "failed", provider: "feishu", status: "failed", lease: "lease-failed", deliveredAt: null },
      { id: "delivered", provider: "wechat", status: "delivered", lease: "lease-delivered", deliveredAt: now },
    ]) {
      const eventId = `event-${fixture.id}`;
      insertInbound.run(
        fixture.provider,
        eventId,
        character.id,
        `digest-${fixture.id}`,
        now,
        now,
        now,
        now,
      );
      insertOutbox.run(
        `outbox-${fixture.id}`,
        fixture.provider,
        eventId,
        `sensitive body ${fixture.id}`,
        fixture.status,
        now,
        fixture.lease,
        "2099-01-01T00:00:00.000Z",
        `platform error ${fixture.id}`,
        now,
        now,
        fixture.deliveredAt,
      );
    }
    sourceDatabase.close();
    sourceDatabase = undefined;

    const runtimeDir = join(stateDir, "im-runtime");
    mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(runtimeDir, "credentials.json"),
      '{"refreshToken":"credential-must-survive"}\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(runtimeDir, "spool.json"),
      '{"pending":[{"text":"stale inbound body"}]}\n',
      { mode: 0o600 },
    );

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    const manifest = JSON.parse(readFileSync(join(backupDir, "backup-manifest.json"), "utf8"));
    assert.equal(manifest.containsImRuntime, true);
    assert.equal(manifest.containsImCredentials, true);
    assert.equal(manifest.credentials.imRuntimeCredentialsPresent, true);

    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    assert.equal(
      readFileSync(join(restoredDir, "im-runtime", "credentials.json"), "utf8"),
      '{"refreshToken":"credential-must-survive"}\n',
    );
    assert.equal(existsSync(join(restoredDir, "im-runtime", "spool.json")), false);
    assert.equal(existsSync(join(backupDir, "im-runtime", "spool.json")), true);

    restoredDatabase = new DatabaseSync(join(restoredDir, "rp-agent.sqlite"), { readOnly: true });
    const restoredRows = restoredDatabase.prepare(`
      SELECT id, status, lease_token, lease_expires_at, last_error
      FROM im_outbox ORDER BY id
    `).all().map((row) => ({ ...row })) as Array<Record<string, unknown>>;
    assert.deepEqual(restoredRows, [
      {
        id: "outbox-delivered",
        status: "delivered",
        lease_token: "lease-delivered",
        lease_expires_at: "2099-01-01T00:00:00.000Z",
        last_error: "platform error delivered",
      },
      {
        id: "outbox-failed",
        status: "abandoned",
        lease_token: null,
        lease_expires_at: null,
        last_error: restoreReason,
      },
      {
        id: "outbox-pending",
        status: "abandoned",
        lease_token: null,
        lease_expires_at: null,
        last_error: restoreReason,
      },
    ]);
    assert.doesNotMatch(JSON.stringify(restoredRows), /sensitive body|connection-secret|owner-secret/);
    restoredDatabase.close();
    restoredDatabase = undefined;

    sourceDatabase = new DatabaseSync(join(backupDir, "rp-agent.sqlite"), { readOnly: true });
    const sourceStatuses = sourceDatabase.prepare(
      "SELECT id, status FROM im_outbox ORDER BY id",
    ).all().map((row) => ({ ...row }));
    assert.deepEqual(sourceStatuses, [
      { id: "outbox-delivered", status: "delivered" },
      { id: "outbox-failed", status: "failed" },
      { id: "outbox-pending", status: "pending" },
    ]);
  } finally {
    restoredDatabase?.close();
    sourceDatabase?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
