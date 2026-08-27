import assert from "node:assert/strict";
import type { Server } from "node:http";
import test from "node:test";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import type { SubagentSettings } from "../src/modules/index.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("Subagent settings HTTP API is locally protected, bounded, partial, and revision-safe", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const server = createHttpServer({ kernel });
  await listen(server);
  try {
    const origin = originOf(server);
    const initialResponse = await fetch(`${origin}/api/v1/subagent-settings`);
    assert.equal(initialResponse.status, 200);
    const initial = (await initialResponse.json() as { settings: SubagentSettings }).settings;
    assert.deepEqual(
      {
        maxConcurrentTasks: initial.maxConcurrentTasks,
        maxWorkModelCalls: initial.maxWorkModelCalls,
        maxOutputTokens: initial.maxOutputTokens,
        maxResultCharacters: initial.maxResultCharacters,
        timeoutSeconds: initial.timeoutSeconds,
        revision: initial.revision,
      },
      {
        maxConcurrentTasks: 4,
        maxWorkModelCalls: 32,
        maxOutputTokens: 16_384,
        maxResultCharacters: 64_000,
        timeoutSeconds: 1_800,
        revision: 0,
      },
    );
    assert.match(initial.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

    const untrusted = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ expectedRevision: 0, maxConcurrentTasks: 5 }),
    });
    assert.equal(untrusted.status, 403);
    assert.equal(kernel.getSubagentSettings().revision, 0);

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const trustedHeaders = {
      "content-type": "application/json",
      cookie,
      origin,
    };

    const belowMinimum = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({ expectedRevision: 0, maxOutputTokens: 511 }),
    });
    assert.equal(belowMinimum.status, 400, await belowMinimum.clone().text());
    assert.equal(
      (await belowMinimum.json() as { code: string }).code,
      "SUBAGENT_SETTINGS_INVALID",
    );
    assert.equal(kernel.getSubagentSettings().revision, 0);

    const updatedResponse = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({
        expectedRevision: 0,
        maxConcurrentTasks: 5,
        maxWorkModelCalls: 33,
        maxOutputTokens: 20_000,
        maxResultCharacters: 70_000,
        timeoutSeconds: 1_900,
      }),
    });
    assert.equal(updatedResponse.status, 200, await updatedResponse.clone().text());
    const updated = (await updatedResponse.json() as { settings: SubagentSettings }).settings;
    assert.equal(updated.revision, 1);
    assert.equal(updated.maxConcurrentTasks, 5);
    assert.equal(updated.maxWorkModelCalls, 33);
    assert.equal(updated.maxOutputTokens, 20_000);
    assert.equal(updated.maxResultCharacters, 70_000);
    assert.equal(updated.timeoutSeconds, 1_900);

    const staleResponse = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({ expectedRevision: 0, maxConcurrentTasks: 6 }),
    });
    assert.equal(staleResponse.status, 409, await staleResponse.clone().text());
    const stale = await staleResponse.json() as {
      code: string;
      expectedRevision: number;
      actualRevision: number;
    };
    assert.equal(stale.code, "SUBAGENT_SETTINGS_CONFLICT");
    assert.equal(stale.expectedRevision, 0);
    assert.equal(stale.actualRevision, 1);

    const partialResponse = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({ expectedRevision: 1, timeoutSeconds: 2_000 }),
    });
    assert.equal(partialResponse.status, 200, await partialResponse.clone().text());
    const partial = (await partialResponse.json() as { settings: SubagentSettings }).settings;
    assert.equal(partial.revision, 2);
    assert.equal(partial.maxConcurrentTasks, 5);
    assert.equal(partial.maxWorkModelCalls, 33);
    assert.equal(partial.maxOutputTokens, 20_000);
    assert.equal(partial.maxResultCharacters, 70_000);
    assert.equal(partial.timeoutSeconds, 2_000);

    const current = (await (await fetch(`${origin}/api/v1/subagent-settings`)).json() as {
      settings: SubagentSettings;
    }).settings;
    assert.deepEqual(current, partial);
  } finally {
    await close(server);
    kernel.dispose();
  }
});

test("Subagent settings HTTP PATCH waits for an active Agent turn boundary", async () => {
  const runtime = createTestRuntime({ seed: "subagent-settings-http-busy" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await listen(server);
  try {
    const origin = originOf(server);
    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const trustedHeaders = {
      "content-type": "application/json",
      cookie,
      origin,
    };
    const before = runtime.kernel.getSubagentSettings();
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "活动回合已完成。",
      delayMs: 1_000,
    }]);
    const activeTurn = runtime.kernel.streamMessage(
      "subagent-settings-http-busy",
      { mode: "sms", text: "保持这个回合运行，直到设置冲突已验证。" },
      () => undefined,
    );
    await waitUntil(() => runtime.model.requests.length >= 1);

    const busyResponse = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({
        expectedRevision: before.revision,
        maxConcurrentTasks: before.maxConcurrentTasks + 1,
      }),
    });
    assert.equal(busyResponse.status, 409, await busyResponse.clone().text());
    assert.equal(
      (await busyResponse.json() as { code: string }).code,
      "CONTROL_PLANE_BUSY",
    );
    assert.deepEqual(runtime.kernel.getSubagentSettings(), before);

    const completed = await activeTurn;
    assert.equal(completed.status, "completed");
    const acceptedResponse = await fetch(`${origin}/api/v1/subagent-settings`, {
      method: "PATCH",
      headers: trustedHeaders,
      body: JSON.stringify({
        expectedRevision: before.revision,
        maxConcurrentTasks: before.maxConcurrentTasks + 1,
      }),
    });
    assert.equal(acceptedResponse.status, 200, await acceptedResponse.clone().text());
    const accepted = (await acceptedResponse.json() as { settings: SubagentSettings }).settings;
    assert.equal(accepted.revision, before.revision + 1);
    assert.equal(accepted.maxConcurrentTasks, before.maxConcurrentTasks + 1);
  } finally {
    await close(server);
    runtime.dispose();
  }
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function originOf(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
