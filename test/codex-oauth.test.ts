import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type OAuthAuth, type OAuthCredential, type Context } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { CompanionKernel } from "../src/domain/kernel.js";
import { CompanionStore } from "../src/domain/store.js";
import { modelCredentialSecrets, redactModelCredentialValue } from "../src/model/credential-store.js";
import { CodexLoginManager } from "../src/model/codex-login.js";
import { firstPartyNativeModelProviderAdapters } from "../src/model/native-providers.js";
import { ModelProviderRegistry } from "../src/model/provider-adapter.js";
import { createHttpServer } from "../src/http/router.js";

const codexModel = openaiCodexProvider().getModels().find((model) => model.input.includes("image"))!.id;
const providerRegistry = () => new ModelProviderRegistry(firstPartyNativeModelProviderAdapters);
const options = { stateDir: false as const, startScheduler: false, startWorldCoordinator: false, startPrivateInboxCoordinator: false, characterSkillReflector: false as const };

function credential(label: string, expires = Date.now() + 3_600_000): OAuthCredential {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: `account-${label}` } })).toString("base64url");
  return { type: "oauth", access: `eyJhbGciOiJub25lIn0.${payload}.signature-${label}`, refresh: `refresh-${label}-private`, expires, accountId: `account-${label}` };
}

function configuredStore(stateDir: string | false = false) {
  const store = new CompanionStore({ stateDir });
  store.patchModelApiConfig({ enabled: true, provider: "openai-codex", baseUrl: "", model: codexModel, visionInputEnabled: true });
  return store;
}

async function runtimeFor(store: CompanionStore, id = "default") {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  await providerRegistry().registerModel(runtime, store.getRawModelApiProfile(id)!);
  return runtime;
}

async function until<T>(read: () => T | Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error("test condition timed out");
    await delay(10);
  }
}

test("Codex profiles isolate OAuth secrets, persist refresh tokens, and never copy them into snapshots", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-codex-store-"));
  const childDir = mkdtempSync(join(tmpdir(), "yourchar-codex-child-"));
  try {
    const store = configuredStore(stateDir);
    const auth = credential("first");
    const profile = store.setModelOAuthCredential("default", auth, 0);
    assert.equal(profile.credentialType, "oauth");
    assert.equal(profile.credentialStatus, "active");
    assert.equal(profile.credentialCanRollback, false);
    assert.equal(profile.apiKeySet, false);
    const raw = store.getRawModelApiConfig();
    assert.equal(raw.apiKey, undefined);
    assert.equal(providerRegistry().isConfigured(raw), true);
    assert.equal(JSON.stringify(raw).includes(auth.access), false);
    assert.equal(readFileSync(join(stateDir, "model-api.json"), "utf8").includes(auth.refresh), false);
    if (process.platform !== "win32") assert.equal(statSync(join(stateDir, "model-credentials.json")).mode & 0o777, 0o600);
    const loaded = new CompanionStore({ stateDir });
    assert.equal(loaded.getModelApiConfig().credentialType, "oauth");
    assert.deepEqual(modelCredentialSecrets(loaded.getRawModelApiConfig()), [auth.access, auth.refresh]);

    const resolver = store.scopedModelCredentialResolver(["default"]);
    assert.equal(resolver(profile.credentialRef!, "other")?.status, "missing");
    const child = new CompanionStore({ stateDir: childDir, modelCredentialResolver: resolver });
    child.installIsolatedModelApiProfile(profile);
    assert.equal(providerRegistry().isConfigured(child.getRawModelApiConfig()), true);
    assert.equal(existsSync(join(childDir, "model-credentials.json")), false);
    assert.equal(readFileSync(join(childDir, "model-api.json"), "utf8").includes(auth.access), false);
    assert.equal(JSON.stringify(redactModelCredentialValue({ token: auth.access, nested: [auth.refresh] }, modelCredentialSecrets(raw))).includes(auth.refresh), false);

    store.revokeModelApiCredential("default", profile.credentialRevision);
    assert.equal(child.getModelApiConfig().credentialStatus, "revoked");
    assert.equal(providerRegistry().isConfigured(child.getRawModelApiConfig()), false);
    const persisted = readFileSync(join(stateDir, "model-credentials.json"), "utf8");
    assert.equal(persisted.includes(auth.access), false);
    assert.equal(persisted.includes(auth.refresh), false);
    assert.throws(() => store.rollbackModelApiCredential("default", 2), /last-known-good/);
    assert.equal(new CompanionStore({ stateDir }).getModelApiConfig().credentialStatus, "revoked");
  } finally { rmSync(stateDir, { recursive: true, force: true }); rmSync(childDir, { recursive: true, force: true }); }
});

test("Pi refreshes once across concurrent runtimes and preserves each profile's account", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-codex-refresh-"));
  try {
    const store = configuredStore(stateDir);
    const old = credential("expired", Date.now() - 1);
    const fresh = credential("refreshed");
    store.setModelOAuthCredential("default", old, 0);
    const other = store.createModelApiProfile({ name: "other", enabled: true, provider: "openai-codex", model: codexModel });
    const separate = credential("other");
    store.setModelOAuthCredential(other.id, separate, 0);
    let refreshes = 0;
    t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
      assert.equal(String(input), "https://auth.openai.com/oauth/token");
      assert.equal(new URLSearchParams(String(init?.body)).get("refresh_token"), old.refresh);
      refreshes += 1;
      await delay(20);
      return Response.json({ access_token: fresh.access, refresh_token: fresh.refresh, expires_in: 3600 });
    });
    const a = await runtimeFor(store);
    const b = await runtimeFor(store);
    const c = await runtimeFor(store, other.id);
    const result = await Promise.all([a.getAuth("openai-codex"), b.getAuth("openai-codex"), c.getAuth("openai-codex")]);
    assert.deepEqual(result.map((entry) => entry?.auth.apiKey), [fresh.access, fresh.access, separate.access]);
    assert.equal(refreshes, 1);
    assert.equal(store.getModelApiConfig().credentialRevision, 1, "automatic refresh does not invalidate UI revision");
    const saved = readFileSync(join(stateDir, "model-credentials.json"), "utf8");
    assert.equal(saved.includes(fresh.refresh), true);
    assert.equal(saved.includes(old.refresh), false);
    assert.ok(modelCredentialSecrets(store.getRawModelApiConfig()).includes(old.access), "in-flight old tokens remain redactable");
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test("a refresh in flight cannot restore logged-out credentials or overwrite a new login", async (t) => {
  const store = configuredStore();
  store.setModelOAuthCredential("default", credential("expired", Date.now() - 1), 0);
  let release!: () => void;
  let refreshing = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    refreshing = true;
    await gate;
    const late = credential("late");
    return Response.json({ access_token: late.access, refresh_token: late.refresh, expires_in: 3600 });
  });
  const runtime = await runtimeFor(store);
  const pending = runtime.getAuth("openai-codex");
  const rejected = assert.rejects(pending, /Codex 登录已失效/);
  await until(() => refreshing, Boolean);
  store.revokeModelApiCredential("default", 1);
  const replacement = credential("replacement");
  store.setModelOAuthCredential("default", replacement, 2);
  release();
  await rejected;
  assert.equal((await runtime.getAuth("openai-codex"))?.auth.apiKey, replacement.access);
  store.revokeModelApiCredential("default", 3);
  await assert.rejects(runtime.getAuth("openai-codex"), /Codex 登录已失效/);
});

test("refresh failures retain the credential for retry and never expose token response bodies", async (t) => {
  const store = configuredStore();
  const auth = credential("expired", Date.now() - 1);
  store.setModelOAuthCredential("default", auth, 0);
  t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "new-secret-from-error", error: auth.refresh }, { status: 400 }));
  const runtime = await runtimeFor(store);
  await assert.rejects(runtime.getAuth("openai-codex"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /重新登录/);
    assert.equal(error.message.includes(auth.refresh), false);
    assert.equal(error.message.includes("new-secret-from-error"), false);
    return true;
  });
  assert.equal(store.getModelApiConfig().credentialStatus, "active");
});

test("cancelling a request after token exchange does not lose the rotated refresh token", async () => {
  const store = configuredStore();
  store.setModelOAuthCredential("default", credential("before-cancel"), 0);
  const credentials = store.getRawModelApiConfig().oauth!.credentials;
  const controller = new AbortController();
  const fresh = credential("after-cancel");
  await credentials.modify("openai-codex", async () => {
    controller.abort();
    return fresh;
  }, { signal: controller.signal });
  assert.deepEqual(await credentials.read("openai-codex"), fresh);
});

test("Codex uses Pi's Responses transport for images and tool calls with subscription parameters", async () => {
  const store = configuredStore();
  const auth = credential("stream");
  store.setModelOAuthCredential("default", auth, 0);
  const config = store.getRawModelApiConfig();
  const providers = providerRegistry();
  const descriptor = providers.list().find((item) => item.id === "openai-codex")!;
  assert.equal(descriptor.authentication, "oauth");
  assert.equal(descriptor.configurationFields.some((item) => item.key === "apiKey" || item.key === "temperature" || item.key === "maxTokens"), false);
  assert.equal(providers.createModel(config).api, "openai-codex-responses");
  assert.ok(providers.createModel(config).input.includes("image"));
  assert.equal(providers.isConfigured({ ...config, oauth: undefined }), false);
  assert.throws(() => providers.assertConfiguration({ ...config, apiKey: "api-key" }), /requires ChatGPT login/);
  const requests: Record<string, any>[] = [];
  const tool = { type: "function_call", id: "fc_lookup", call_id: "call_lookup", name: "lookup", arguments: '{"query":"image"}', status: "completed" };
  const reply = { id: "msg_done", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DONE", annotations: [] }] };
  const context: Context = {
    systemPrompt: "A character with memory.",
    messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: "Look up this image" }, { type: "image", mimeType: "image/png", data: "aGVsbG8=" }] }],
    tools: [{ name: "lookup", description: "Look up a detail", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } as any }],
  };
  const mockFetch: typeof fetch = async (input, init) => {
    assert.match(String(input), /chatgpt\.com\/backend-api\/codex\/responses/);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${auth.access}`);
    assert.equal(headers.get("chatgpt-account-id"), auth.accountId);
    const body = JSON.parse(headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(init?.body as Uint8Array).toString("utf8") : String(init?.body));
    requests.push(body);
    assert.equal(body.store, false);
    assert.equal(body.instructions, context.systemPrompt);
    assert.equal("max_output_tokens" in body, false);
    assert.equal("temperature" in body, false);
    assert.equal("messages" in body, false);
    return responseStream(requests.length === 1 ? tool : reply);
  };
  const call = () => providers.complete(config, context, {
    fetch: mockFetch, maxRetries: 0, temperature: 0.5, maxTokens: 10,
    onPayload: (payload) => providers.finalizePayload(config, providers.transformPayload(config, payload, { maxTokens: 10, temperature: 0.5 })),
  });
  const first = await call();
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  const toolCall = first.content.find((item) => item.type === "toolCall")!;
  assert.equal(toolCall.type, "toolCall");
  assert.equal(toolCall.name, "lookup");
  assert.deepEqual(toolCall.arguments, { query: "image" });
  assert.match(JSON.stringify(requests[0].input), /input_image/);
  assert.equal(requests[0].tools[0].name, "lookup");
  context.messages.push(first, { role: "toolResult", toolCallId: toolCall.id, toolName: "lookup", content: [{ type: "text", text: "found" }], isError: false, timestamp: Date.now() });
  const second = await call();
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.match(JSON.stringify(second.content), /DONE/);
  assert.match(JSON.stringify(requests[1].input), /function_call_output/);
});

test("Codex quota failures retain Pi's allowance and reset-time message", async () => {
  const store = configuredStore();
  store.setModelOAuthCredential("default", credential("quota"), 0);
  let requests = 0;
  const message = await providerRegistry().complete(store.getRawModelApiConfig(), {
    messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  }, {
    fetch: async () => {
      requests += 1;
      return Response.json({ error: { code: "usage_limit_reached", plan_type: "plus", resets_at: Math.floor(Date.now() / 1000) + 60 } }, { status: 429 });
    },
    maxRetries: 0,
  });
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /ChatGPT usage limit/);
  assert.match(message.errorMessage!, /Try again/);
  assert.equal(requests, 1);
});

test("interactive kernel sessions use the logged-in Codex profile and native image input", async (t) => {
  const kernel = new CompanionKernel({ ...options, memoryExtractor: async () => ({ candidates: [] }) });
  const auth = credential("interactive");
  const requests: Record<string, any>[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.match(String(input), /chatgpt\.com\/backend-api\/codex\/responses/);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${auth.access}`);
    const body = JSON.parse(headers.get("content-encoding") === "zstd"
      ? zstdDecompressSync(init?.body as Uint8Array).toString("utf8") : String(init?.body));
    requests.push(body);
    return responseStream({ id: "msg_kernel", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "DONE", annotations: [] }] });
  });
  try {
    kernel.patchModelApiConfig({ enabled: true, provider: "openai-codex", baseUrl: "", model: codexModel, visionInputEnabled: true });
    kernel.store.setModelOAuthCredential("default", auth, 0);
    kernel.setAgentModuleEnabled("mcp:vision", true);
    kernel.patchVisionConfig({ mode: "auto" });
    const image = kernel.uploadWorkspaceFile({ directory: "uploads", name: "pixel.png", bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
    const reply = await kernel.sendMessage("codex-interactive", { mode: "sms", text: "Describe the image.", attachments: [{ path: image.path, contentType: image.contentType, size: image.size }] });
    assert.equal(reply.reply, "DONE");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, codexModel);
    assert.equal(requests[0].store, false);
    assert.equal("max_output_tokens" in requests[0], false);
    assert.match(JSON.stringify(requests[0].input), /input_image/);
    assert.ok(requests[0].instructions.length > 0);
    assert.ok(requests[0].tools.length > 0);
    assert.equal(JSON.stringify(kernel.recentModelContextTraces()).includes(auth.access), false);
  } finally { kernel.dispose(); }
});

test("browser login validates callback state, clears challenges, and cancellation prevents late completion", async () => {
  let completed = 0;
  const manager = new CodexLoginManager({
    name: "test",
    login: async (interaction) => {
      assert.equal(await interaction.prompt({ type: "select", message: "method", options: [] }), "browser");
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?state=expected-state" });
      await interaction.prompt({ type: "manual_code", message: "callback" });
      return credential("login");
    },
  } as OAuthAuth);
  try {
    const started = manager.start("profile", "browser", () => { completed += 1; });
    await until(() => manager.status("profile", started.id), (value) => Boolean(value.manualCode));
    assert.throws(() => manager.submit("profile", started.id, "bare-code"), /完整/);
    assert.throws(() => manager.submit("profile", started.id, "http://localhost:1455/auth/callback?code=abc&state=wrong"), /不匹配/);
    assert.throws(() => manager.status("other", started.id), /失效/);
    manager.submit("profile", started.id, "http://localhost:1455/auth/callback?code=abc&state=expected-state");
    const done = await until(() => manager.status("profile", started.id), (value) => value.status === "complete");
    assert.equal(done.authUrl, undefined);
    assert.equal(done.manualCode, undefined);
    assert.equal(completed, 1);
    const next = manager.start("profile", "browser", () => { completed += 1; });
    manager.cancel("profile", next.id);
    await delay(5);
    assert.equal(manager.status("profile", next.id).status, "cancelled");
    assert.equal(completed, 1);
  } finally { manager.dispose(); }
});

test("login timeout closes pending prompts and raw OAuth failures stay private", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let completed = false;
  const manager = new CodexLoginManager({ name: "test", login: async (interaction) => {
    await interaction.prompt({ type: "manual_code", message: "callback" });
    return credential("late");
  } } as OAuthAuth);
  const login = manager.start("profile", "browser", () => { completed = true; });
  t.mock.timers.tick(15 * 60_000);
  await Promise.resolve();
  assert.equal(manager.status("profile", login.id).status, "failed");
  assert.equal(completed, false);
  manager.dispose();
  const failing = new CodexLoginManager({ name: "test", login: async () => { throw new Error("token response private-access-token private-refresh-token"); } } as unknown as OAuthAuth);
  const failed = failing.start("profile", "browser", () => {});
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(failing.status("profile", failed.id).status, "failed");
  assert.equal(JSON.stringify(failing.status("profile", failed.id)).includes("private-"), false);
  failing.dispose();
});

test("HTTP device login uses real Pi OAuth, protects status, and supports sign-out and re-login", async (t) => {
  const kernel = new CompanionKernel(options);
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const actualFetch = globalThis.fetch;
  let authorized = false;
  let authRequests = 0;
  const auth = credential("http");
  t.mock.method(globalThis, "fetch", async (input: any, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(origin)) return actualFetch(input, init);
    assert.ok(url.startsWith("https://auth.openai.com/"), `unexpected outbound request: ${url}`);
    authRequests += 1;
    if (url.endsWith("/usercode")) return Response.json({ device_auth_id: "test-device-id", user_code: "TEST-CODE", interval: 1 });
    if (url.endsWith("/deviceauth/token")) return authorized
      ? Response.json({ authorization_code: "test-code", code_verifier: "test-verifier" })
      : Response.json({}, { status: 403 });
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("code"), "test-code");
    return Response.json({ access_token: auth.access, refresh_token: auth.refresh, expires_in: 3600 });
  });
  try {
    kernel.patchModelApiConfig({ provider: "openai-codex", model: codexModel, baseUrl: "", enabled: true });
    const bootstrap = await actualFetch(origin);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0];
    const request = async (operation: string, body: object, protectedRequest = true) => {
      const response = await actualFetch(`${origin}/api/v1/model-profiles/default/oauth/${operation}`, {
        method: "POST", headers: { "content-type": "application/json", ...(protectedRequest ? { cookie, origin, "sec-fetch-site": "same-origin" } : {}) }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any, headers: response.headers };
    };
    assert.equal((await request("start", { method: "device_code", expectedRevision: 0 }, false)).status, 403);
    assert.equal(authRequests, 0);
    assert.equal((await request("start", { method: "invalid", expectedRevision: 0 })).status, 400);
    const start = await request("start", { method: "device_code", expectedRevision: 0 });
    assert.equal(start.status, 202);
    const loginId = start.body.login.id;
    assert.equal((await request("status", { loginId }, false)).status, 403);
    const waiting = await until(() => request("status", { loginId }), (value) => Boolean(value.body.login?.userCode));
    assert.equal(waiting.body.login.userCode, "TEST-CODE");
    assert.equal(waiting.headers.get("cache-control"), "no-store");
    authorized = true;
    const done = await until(() => request("status", { loginId }), (value) => value.body.login?.status === "complete");
    assert.equal(done.body.login.userCode, undefined);
    const profiles = await (await actualFetch(`${origin}/api/v1/model-profiles`)).json();
    assert.equal(JSON.stringify(profiles).includes(auth.access), false);
    assert.equal(JSON.stringify(profiles).includes(auth.refresh), false);
    assert.equal(kernel.getModelApiConfig().credentialStatus, "active");
    assert.equal((await request("logout", { expectedRevision: 0 })).status, 409);
    assert.equal((await request("logout", { expectedRevision: 1 })).status, 200);
    assert.equal(kernel.getModelApiConfig().credentialStatus, "revoked");
    assert.equal(providerRegistry().isConfigured(kernel.store.getRawModelApiConfig()), false);
    const restart = await request("start", { method: "device_code", expectedRevision: 2 });
    await until(() => request("status", { loginId: restart.body.login.id }), (value) => value.body.login?.status === "complete");
    assert.equal(kernel.getModelApiConfig().credentialRevision, 3);
  } finally {
    kernel.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function responseStream(item: Record<string, unknown>): Response {
  const events = [
    { type: "response.created", response: { id: "resp_test", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", arguments: "", ...(item.type === "message" ? { content: [] } : {}) } },
    ...(item.type === "message"
      ? [{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "DONE" }]
      : [{ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments }]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } } },
  ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
