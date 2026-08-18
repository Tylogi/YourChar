import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";
import { TavilyApiError, TavilyService } from "../src/tavily/index.js";
import { createTestRuntime } from "../src/testing/index.js";

test("Tavily MCP requires both its module and API Key, then searches through Pi", async () => {
  let authorization = "";
  let searchBody: Record<string, unknown> | undefined;
  const tavilyServer = createServer(async (request, response) => {
    authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization.join(",")
      : request.headers.authorization ?? "";
    if (request.url === "/usage") {
      sendJson(response, 200, { key: { usage: 1, limit: 1_000 } });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    searchBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    sendJson(response, 200, {
      query: searchBody.query,
      results: [{
        title: "YourChar release notes",
        url: "https://example.test/rp-agent",
        content: "Current release information from a test source.",
        score: 0.92,
      }],
      response_time: "0.12",
      request_id: "tavily-request-1",
      usage: { credits: 1 },
    });
  });
  await new Promise<void>((resolve) => tavilyServer.listen(0, "127.0.0.1", resolve));
  const address = tavilyServer.address();
  assert.ok(address && typeof address === "object");
  const runtime = createTestRuntime({
    seed: "tavily-mcp",
    tavilyBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  try {
    runtime.model.enqueue([
      { kind: "assistant_text", text: "尚未启用" },
      {
        kind: "tool_call",
        name: "tavily_search",
        arguments: {
          query: "YourChar latest release",
          topic: "news",
          searchDepth: "basic",
          maxResults: 3,
          includeDomains: ["example.test"],
        },
      },
      { kind: "assistant_text", text: "已根据实时来源回答。" },
      { kind: "assistant_text", text: "Key 已清除" },
    ]);
    await runtime.kernel.sendMessage("tavily-session", { mode: "sms", text: "搜索最新版本" });
    assert.equal(runtime.model.requests[0].toolNames.includes("tavily_search"), false);
    assert.match(runtime.model.requests[0].systemPrompt, /Tavily Search MCP is disabled/);

    const safeConfig = runtime.kernel.patchTavilyConfig({ apiKey: "tvly-secret-test-key" });
    assert.equal(safeConfig.apiKeySet, true);
    assert.equal(JSON.stringify(safeConfig).includes("tvly-secret-test-key"), false);
    runtime.kernel.setAgentModuleEnabled("mcp:tavily-search", true);
    const searched = await runtime.kernel.sendMessage("tavily-session", {
      mode: "sms",
      text: "搜索 YourChar 最新版本",
    });
    assert.equal(runtime.model.requests[1].toolNames.includes("tavily_search"), true);
    assert.equal(authorization, "Bearer tvly-secret-test-key");
    assert.deepEqual(searchBody, {
      query: "YourChar latest release",
      search_depth: "basic",
      topic: "news",
      max_results: 3,
      include_domains: ["example.test"],
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_favicon: false,
      include_usage: true,
    });
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /https:\/\/example\.test\/rp-agent/);
    const action = searched.actions.find((entry) => entry.actionType === "tavily_search");
    assert.ok(action);
    assert.equal("query" in action.payload, false);
    assert.equal(action.payload.resultCount, 1);
    assert.equal(action.payload.credits, 1);

    runtime.kernel.patchTavilyConfig({ clearApiKey: true });
    await runtime.kernel.sendMessage("tavily-session", { mode: "sms", text: "再搜索一次" });
    assert.equal(runtime.model.requests[3].toolNames.includes("tavily_search"), false);
    assert.match(runtime.model.requests[3].systemPrompt, /has no API Key/);
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve, reject) => tavilyServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("character-bound RP can search, read SOUL.md, and replace it through MCPs", async () => {
  let searchQuery = "";
  const tavilyServer = createServer(async (request, response) => {
    if (request.url === "/usage") {
      sendJson(response, 200, { key: { usage: 1, limit: 1_000 } });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query?: string };
    searchQuery = body.query ?? "";
    sendJson(response, 200, {
      query: searchQuery,
      results: [{
        title: "STEINS;GATE official character profile",
        url: "https://steinsgate.example.test/characters/kurisu",
        content: "Makise Kurisu is a neuroscience researcher: rational, incisive, proud, and quietly caring.",
        score: 0.99,
      }],
      usage: { credits: 1 },
    });
  });
  await new Promise<void>((resolve) => tavilyServer.listen(0, "127.0.0.1", resolve));
  const address = tavilyServer.address();
  assert.ok(address && typeof address === "object");
  const runtime = createTestRuntime({
    seed: "tavily-soul-workflow",
    tavilyBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  try {
    const originalSoul = "# SOUL.md - 红莉栖\n\n## 核心身份\n\n理性的研究者。\n\n## 边界\n\n- 不编造来源。\n";
    const updatedSoul = "# SOUL.md - 红莉栖\n\n## 核心身份\n\n理性、敏锐的神经科学研究者。\n\n## 气质与表达\n\n自尊而直接，关心他人但不轻易表露。\n\n## 边界\n\n- 不编造来源。\n";
    const character = runtime.kernel.createCharacter({ name: "红莉栖", soulMarkdown: originalSoul });
    runtime.kernel.patchTavilyConfig({ apiKey: "tvly-soul-test-key" });
    runtime.kernel.setAgentModuleEnabled("mcp:tavily-search", true);
    runtime.kernel.patchAgentPermissions({ characterSoulWriteEnabled: true });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "tavily_search",
        arguments: { query: "牧濑红莉栖 官方 人物设定", maxResults: 3 },
      },
      { kind: "tool_call", name: "get_current_character_soul", arguments: {} },
      {
        kind: "tool_call",
        name: "update_current_character_soul",
        arguments: { markdown: updatedSoul, reason: "用户明确要求依据可信外部资料完善角色设定" },
      },
      { kind: "assistant_text", text: "已依据来源完善角色设定。" },
    ]);

    const response = await runtime.kernel.sendMessage("kurisu-rp", {
      mode: "rp",
      characterId: character.id,
      text: "搜索红莉栖的官方人设，然后更新你自己的 SOUL.md",
    });

    assert.equal(searchQuery, "牧濑红莉栖 官方 人物设定");
    assert.equal(runtime.kernel.getCharacter(character.id).soulMarkdown, updatedSoul);
    assert.deepEqual(
      runtime.model.requests.slice(0, 4).map((request) => request.toolNames.filter((name) =>
        ["tavily_search", "get_current_character_soul", "update_current_character_soul"].includes(name)
      )),
      Array(4).fill(["tavily_search", "get_current_character_soul", "update_current_character_soul"]),
    );
    assert.match(runtime.model.requests[0].systemPrompt, /依次调用 tavily_search、get_current_character_soul、update_current_character_soul/);
    assert.match(runtime.model.requests[0].systemPrompt, /只写入检索结果明确支持的事实/);
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /steinsgate\.example\.test/);
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /理性的研究者/);
    assert.deepEqual(
      response.actions.map((action) => action.actionType),
      ["tavily_search", "update_character_soul"],
    );
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve) => tavilyServer.close(() => resolve()));
  }
});

test("Tavily settings API masks, tests, persists, and clears its API Key", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-tavily-settings-"));
  let usageAuthorization = "";
  const tavilyServer = createServer((request, response) => {
    usageAuthorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization.join(",")
      : request.headers.authorization ?? "";
    sendJson(response, 200, { key: { usage: 2, limit: 1_000 } });
  });
  await new Promise<void>((resolve) => tavilyServer.listen(0, "127.0.0.1", resolve));
  const address = tavilyServer.address();
  assert.ok(address && typeof address === "object");
  const tavilyBaseUrl = `http://127.0.0.1:${address.port}`;
  let kernel: CompanionKernel | undefined;
  let app: ReturnType<typeof createHttpServer> | undefined;
  try {
    kernel = new CompanionKernel({ stateDir, tavilyBaseUrl, startScheduler: false });
    app = createHttpServer({ kernel });
    await new Promise<void>((resolve) => app!.listen(0, "127.0.0.1", resolve));
    const appAddress = app.address();
    assert.ok(appAddress && typeof appAddress === "object");
    const baseUrl = `http://127.0.0.1:${appAddress.port}`;

    const missing = await fetch(`${baseUrl}/api/v1/diagnostics/tavily/test`, { method: "POST" });
    assert.equal(missing.status, 400);
    const saved = await fetch(`${baseUrl}/api/settings/tavily`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "tvly-persisted-secret" }),
    });
    const savedBody = await saved.json() as { apiKeySet: boolean; apiKeyMasked: string };
    assert.equal(saved.status, 200);
    assert.equal(savedBody.apiKeySet, true);
    assert.equal(JSON.stringify(savedBody).includes("tvly-persisted-secret"), false);
    assert.match(savedBody.apiKeyMasked, /^tvly\.\.\./);

    const tested = await fetch(`${baseUrl}/api/v1/diagnostics/tavily/test`, { method: "POST" });
    assert.equal(tested.status, 200);
    assert.equal(usageAuthorization, "Bearer tvly-persisted-secret");
    const proxySaved = await fetch(`${baseUrl}/api/settings/tavily`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proxyUrl: "http://proxy-user:proxy-pass@127.0.0.1:7890" }),
    });
    const proxyBody = await proxySaved.json() as { proxyUrlSet: boolean; proxyUrlMasked: string };
    assert.equal(proxySaved.status, 200);
    assert.equal(proxyBody.proxyUrlSet, true);
    assert.equal(JSON.stringify(proxyBody).includes("proxy-pass"), false);
    assert.equal(proxyBody.proxyUrlMasked, "http://***:***@127.0.0.1:7890");
    const configPath = join(stateDir, "tavily.json");
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.match(readFileSync(configPath, "utf8"), /tvly-persisted-secret/);

    await new Promise<void>((resolve, reject) => app!.close((error) => error ? reject(error) : resolve()));
    app = undefined;
    kernel.dispose();
    kernel = undefined;
    const restarted = new CompanionKernel({ stateDir, tavilyBaseUrl, startScheduler: false });
    assert.equal(restarted.getTavilyConfig().apiKeySet, true);
    assert.equal(restarted.getTavilyConfig().proxyUrlSet, true);
    assert.equal(JSON.stringify(await restarted.exportUserData()).includes("tvly-persisted-secret"), false);
    assert.equal(JSON.stringify(await restarted.exportUserData()).includes("proxy-pass"), false);
    restarted.patchTavilyConfig({ clearApiKey: true, clearProxyUrl: true });
    assert.equal(restarted.getTavilyConfig().apiKeySet, false);
    assert.equal(restarted.getTavilyConfig().proxyUrlSet, false);
    assert.equal(readFileSync(configPath, "utf8").includes("tvly-persisted-secret"), false);
    restarted.dispose();
  } finally {
    if (app) await new Promise<void>((resolve) => app!.close(() => resolve()));
    kernel?.dispose();
    await new Promise<void>((resolve) => tavilyServer.close(() => resolve()));
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Tavily upstream errors cannot echo the configured API Key", async () => {
  const apiKey = "tvly-upstream-error-secret";
  const tavilyServer = createServer((_request, response) => {
    sendJson(response, 500, { error: `upstream accidentally echoed ${apiKey}` });
  });
  await new Promise<void>((resolve) => tavilyServer.listen(0, "127.0.0.1", resolve));
  const address = tavilyServer.address();
  assert.ok(address && typeof address === "object");
  try {
    const service = new TavilyService({ baseUrl: `http://127.0.0.1:${address.port}` });
    service.patchConfig({ apiKey });
    await assert.rejects(
      service.search({ query: "redaction test" }),
      (error: unknown) => {
        assert.ok(error instanceof TavilyApiError);
        assert.equal(error.status, 500);
        assert.equal(error.message.includes(apiKey), false);
        assert.match(error.message, /\[REDACTED\]/);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => tavilyServer.close(() => resolve()));
  }
});

test("Tavily applies a configured HTTP proxy dispatcher without exposing credentials", async () => {
  let dispatcherSet = false;
  const service = new TavilyService({
    fetch: async (_input, init) => {
      dispatcherSet = Boolean(init?.dispatcher);
      return new Response(JSON.stringify({ key: { usage: 1, limit: 1_000 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const config = service.patchConfig({
      apiKey: "tvly-proxy-test-key",
      proxyUrl: "http://proxy-user:proxy-password@127.0.0.1:7890",
    });
    assert.equal(config.proxyUrlSet, true);
    assert.equal(config.proxyUrlMasked, "http://***:***@127.0.0.1:7890");
    assert.equal(JSON.stringify(config).includes("proxy-password"), false);
    await service.testConnection();
    assert.equal(dispatcherSet, true);
  } finally {
    service.dispose();
  }
});

function sendJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
