import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { CompanionStore } from "../src/domain/store.js";
import { createHttpServer } from "../src/http/router.js";

test("trace archive is opt-in, sanitized, append-only across restart, and cleared with user data", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-trace-archive-"));
  const clock = new VirtualClock("2026-07-18T08:30:00.000Z");
  try {
    let store = new CompanionStore({ stateDir, clock });
    assert.equal(store.getTraceArchiveStatus().enabled, false);
    addTrace(store, 0);
    const archiveDir = join(stateDir, "trace-archive");
    assert.equal(existsSync(archiveDir), false);

    const enabled = store.patchTraceArchiveConfig({ enabled: true });
    assert.equal(enabled.enabled, true);
    for (let index = 1; index <= 12; index += 1) addTrace(store, index);

    const file = join(archiveDir, "model-traces-2026-07-18.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 12);
    assert.equal(statSync(archiveDir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const first = JSON.parse(lines[0]) as {
      schemaVersion: number;
      trace: { payload: Record<string, unknown>; requestText: string };
    };
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.trace.payload.apiKey, "[REDACTED]");
    assert.equal((first.trace.payload.headers as Record<string, unknown>).authorization, "[REDACTED]");
    assert.match(JSON.stringify(first.trace.payload), /Binary data URL omitted: image\/png/);
    assert.doesNotMatch(JSON.stringify(first.trace.payload), /aGVsbG8=/);
    assert.match(first.trace.requestText, /正文中的 secret-1/);
    assert.equal(store.recentModelContextTraces(20).length, 10);

    store = new CompanionStore({ stateDir, clock });
    assert.equal(store.getTraceArchiveStatus().enabled, true);
    addTrace(store, 13);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 13);

    store.patchTraceArchiveConfig({ enabled: false });
    addTrace(store, 14);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 13);
    store.patchTraceArchiveConfig({ enabled: true });
    store.clearRuntimeData();
    assert.equal(existsSync(archiveDir), false);
    assert.equal(store.getTraceArchiveStatus().enabled, true);

    const ephemeral = new CompanionStore({ stateDir: false, clock });
    assert.throws(() => ephemeral.patchTraceArchiveConfig({ enabled: true }), /persistent state directory/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("trace archive setting is exposed through the HTTP API", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-trace-http-"));
  const kernel = new CompanionKernel({ stateDir, startScheduler: false });
  const app = createHttpServer({ kernel });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const initial = await (await fetch(`${baseUrl}/api/settings/trace-archive`)).json() as { enabled: boolean };
    assert.equal(initial.enabled, false);
    const response = await fetch(`${baseUrl}/api/settings/trace-archive`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { enabled: boolean }).enabled, true);
    const invalid = await fetch(`${baseUrl}/api/settings/trace-archive`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    assert.equal(invalid.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an unserializable API result returns JSON without crashing the HTTP server", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const original = kernel.recentModelContextTraces.bind(kernel);
  (kernel as unknown as { recentModelContextTraces: () => unknown[] }).recentModelContextTraces = () => [
    { payload: { unsupported: 1n } },
  ];
  const app = createHttpServer({ kernel });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const failed = await fetch(`${baseUrl}/api/debug/model-traces`);
    assert.equal(failed.status, 500);
    assert.match(failed.headers.get("content-type") ?? "", /application\/json/);
    assert.match(((await failed.json()) as { error: string }).error, /BigInt/);

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
  } finally {
    (kernel as unknown as { recentModelContextTraces: typeof original }).recentModelContextTraces = original;
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});

function addTrace(store: CompanionStore, index: number): void {
  store.addModelContextTrace({
    sessionId: "trace-session",
    mode: "sms",
    turnKind: "user",
    requestText: `正文中的 secret-${index}`,
    payload: {
      apiKey: `key-${index}`,
      headers: { authorization: `Bearer ${index}` },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: `message-${index}` },
          { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } },
        ],
      }],
    },
  });
}
