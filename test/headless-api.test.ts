import assert from "node:assert/strict";
import type { IncomingMessage, Server } from "node:http";
import test from "node:test";
import { CompanionKernel } from "../src/domain/kernel.js";
import {
  authenticateHeadlessApiRequest,
  HeadlessApiRequestError,
  mappedHeadlessApiPath,
  resolveHeadlessApiToken,
} from "../src/http/headless-auth.js";
import { createHttpServer } from "../src/http/router.js";

const token = "headless-test-token-0123456789abcdef";

test("headless API configuration is explicit, bounded, and versioned", () => {
  assert.equal(resolveHeadlessApiToken(undefined, {}), undefined);
  assert.equal(resolveHeadlessApiToken(false, { YOURCHAR_HEADLESS_API_TOKEN: token }), undefined);
  assert.equal(resolveHeadlessApiToken(undefined, { YOURCHAR_HEADLESS_API_TOKEN: token }), token);
  assert.equal(resolveHeadlessApiToken(undefined, { RP_AGENT_HEADLESS_API_TOKEN: token }), token);
  assert.throws(() => resolveHeadlessApiToken(""), /must not be empty/u);
  assert.throws(() => resolveHeadlessApiToken("too-short"), /32-512/u);
  assert.throws(() => resolveHeadlessApiToken(`${token} unsafe`), /visible token characters/u);
  assert.equal(mappedHeadlessApiPath("/api/headless/v1"), "/api");
  assert.equal(mappedHeadlessApiPath("/api/headless/v1/sessions"), "/api/v1/sessions");
  assert.equal(mappedHeadlessApiPath("/api/headless/v2/sessions"), undefined);
  assert.equal(mappedHeadlessApiPath("/api/headless/v1evil"), undefined);
});

test("headless Bearer authentication rejects remote peers and ambiguous headers", () => {
  for (const [request, code] of [
    [authRequest([`Bearer ${token}`], "192.0.2.10"), "HEADLESS_API_REMOTE_PEER_REJECTED"],
    [authRequest(undefined), "HEADLESS_API_AUTH_REQUIRED"],
    [authRequest(["Basic ignored"]), "HEADLESS_API_AUTH_REQUIRED"],
    [authRequest([`Bearer ${token}`, `Bearer ${token}`]), "HEADLESS_API_AUTH_REQUIRED"],
  ] as const) {
    assert.throws(
      () => authenticateHeadlessApiRequest(request, token),
      (error) => error instanceof HeadlessApiRequestError && error.code === code,
    );
  }
  assert.doesNotThrow(() => authenticateHeadlessApiRequest(authRequest([`Bearer ${token}`]), token));
});

test("headless API is disabled by default and fails with a stable response", async () => {
  await withServer(false, async ({ origin }) => {
    const response = await fetch(`${origin}/api/headless/v1/health`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("x-yourchar-api-version"), "1");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), {
      code: "HEADLESS_API_DISABLED",
      error: "the headless API is disabled",
    });
  });
});

test("headless API requires one exact Bearer token without browser bootstrap", async () => {
  await withServer(token, async ({ origin }) => {
    const wrongAuthorization = ["Bearer", "wrong-token-wrong-token-wrong-token"].join(" ");
    for (const authorization of [undefined, wrongAuthorization, `bearer ${token}`]) {
      const response = await fetch(`${origin}/api/headless/v1/health`, {
        headers: authorization ? { authorization } : {},
      });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="YourChar Headless API"');
      assert.equal(((await response.json()) as { code: string }).code, "HEADLESS_API_AUTH_REQUIRED");
    }

    const health = await headlessFetch(origin, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-yourchar-api-version"), "1");
    assert.deepEqual(await health.json(), { status: "ok" });

    const descriptor = await headlessFetch(origin, "");
    assert.equal(descriptor.status, 200);
    assert.equal(((await descriptor.json()) as { name: string }).name, "YourChar");

    const sessions = await headlessFetch(origin, "/sessions");
    assert.equal(sessions.status, 200);
    assert.deepEqual(await sessions.json(), { sessions: [] });
  });
});

test("authenticated headless mutations reuse trusted lifecycle policy without a cookie", async () => {
  await withServer(token, async ({ origin }) => {
    const changed = await headlessFetch(origin, "/agent-permissions", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shellEnabled: true }),
    });
    assert.equal(changed.status, 200);
    assert.equal(
      ((await changed.json()) as { permissions: { shellEnabled: boolean } }).permissions.shellEnabled,
      true,
    );

    const wrongContentType = await headlessFetch(origin, "/agent-permissions", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    assert.equal(wrongContentType.status, 415);
    assert.equal(
      ((await wrongContentType.json()) as { code: string }).code,
      "LOCAL_CONTROL_CONTENT_TYPE_REJECTED",
    );

    const browserRouteWithoutCapability = await fetch(`${origin}/api/v1/agent-permissions`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shellEnabled: false }),
    });
    assert.equal(browserRouteWithoutCapability.status, 403);
    assert.match(
      ((await browserRouteWithoutCapability.json()) as { code: string }).code,
      /^LOCAL_CONTROL_/u,
    );
  });
});

test("headless idempotency keys replay one JSON mutation and reject conflicting reuse", async () => {
  await withServer(token, async ({ origin, kernel }) => {
    const character = kernel.createCharacter({ name: "幂等测试角色" });
    const session = await kernel.openCanonicalPrivateConversation(character.id);
    const path = `/sessions/${encodeURIComponent(session.id)}/goals`;
    const body = JSON.stringify({
      title: "只创建一次",
      successCriteria: "重复请求返回同一个目标",
    });
    const options = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "goal-create-request-0001",
      },
      body,
    } satisfies RequestInit;

    const [first, concurrentReplay] = await Promise.all([
      headlessFetch(origin, path, options),
      headlessFetch(origin, path, options),
    ]);
    assert.equal(first.status, 201);
    assert.equal(concurrentReplay.status, 201);
    const firstGoal = ((await first.json()) as { goal: { id: string } }).goal;
    const replayGoal = ((await concurrentReplay.json()) as { goal: { id: string } }).goal;
    assert.equal(replayGoal.id, firstGoal.id);
    assert.equal(
      [first, concurrentReplay].filter((response) => response.headers.get("idempotency-replayed") === "true").length,
      1,
    );

    const laterReplay = await headlessFetch(origin, path, options);
    assert.equal(laterReplay.status, 201);
    assert.equal(laterReplay.headers.get("idempotency-replayed"), "true");
    assert.equal(((await laterReplay.json()) as { goal: { id: string } }).goal.id, firstGoal.id);

    const listed = await headlessFetch(origin, `${path}?includeTerminal=true`);
    assert.equal(((await listed.json()) as { goals: unknown[] }).goals.length, 1);

    const conflict = await headlessFetch(origin, path, {
      ...options,
      body: JSON.stringify({ title: "另一个目标", successCriteria: "不应创建" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      ((await conflict.json()) as { code: string }).code,
      "HEADLESS_IDEMPOTENCY_CONFLICT",
    );
    assert.equal(kernel.listSessionGoals(session.id, { includeTerminal: true }).length, 1);
  });
});

test("headless idempotency fails closed for invalid, read-only, and streaming uses", async () => {
  await withServer(token, async ({ origin }) => {
    const invalid = await headlessFetch(origin, "/agent-permissions", {
      method: "PATCH",
      headers: { "content-type": "application/json", "idempotency-key": "short" },
      body: "{}",
    });
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { code: string }).code,
      "HEADLESS_IDEMPOTENCY_KEY_INVALID",
    );

    const read = await headlessFetch(origin, "/sessions", {
      headers: { "idempotency-key": "read-request-0001" },
    });
    assert.equal(read.status, 422);
    assert.equal(
      ((await read.json()) as { code: string }).code,
      "HEADLESS_IDEMPOTENCY_UNSUPPORTED",
    );

    const stream = await headlessFetch(origin, "/sessions/missing/messages/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "stream-request-0001",
      },
      body: JSON.stringify({ text: "不会执行" }),
    });
    assert.equal(stream.status, 422);
    assert.equal(
      ((await stream.json()) as { code: string }).code,
      "HEADLESS_IDEMPOTENCY_UNSUPPORTED",
    );
  });
});

function authRequest(
  authorization: string[] | undefined,
  remoteAddress = "127.0.0.1",
): IncomingMessage {
  return {
    headers: { authorization: authorization?.[0] },
    headersDistinct: { authorization },
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function headlessFetch(origin: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(`${origin}/api/headless/v1${path}`, { ...init, headers });
}

async function withServer(
  headlessApiToken: string | false,
  run: (context: { origin: string; server: Server; kernel: CompanionKernel }) => Promise<void>,
): Promise<void> {
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const server = createHttpServer({ kernel, headlessApiToken });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run({ origin: `http://127.0.0.1:${address.port}`, server, kernel });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    kernel.dispose();
  }
}
