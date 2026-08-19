import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("readiness, model diagnostics, export, and confirmed deletion form a closed API", async () => {
  const provider = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/models") {
      response.end(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }));
      return;
    }
    const payload = JSON.parse(await readBody(request)) as {
      tools?: unknown[];
      messages?: Array<{ role?: string; content?: unknown }>;
      stream?: boolean;
    };
    const hasReminderRequest = JSON.stringify(payload.messages ?? []).includes("提醒我导出");
    const hasToolResult = payload.messages?.some((message) => message.role === "tool");
    if (payload.tools?.length && hasReminderRequest && !hasToolResult) {
      writeToolCallStream(response);
      return;
    }
    if (payload.stream) {
      writeTextStream(response, "OK");
      return;
    }
    response.end(JSON.stringify({
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");

  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-12T09:00:00.000Z"),
    characterFunctionInferer: false,
    characterSkillReflector: false,
  });
  kernel.patchModelApiConfig({
    enabled: true,
    baseUrl: `http://127.0.0.1:${providerAddress.port}/v1`,
    model: "model-a",
    apiKey: "export-must-not-contain-this",
  });
  const app = createHttpServer({ kernel });
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const address = app.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${baseUrl}/`);
    const controlCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(controlCookie);
    const controlHeaders = {
      "content-type": "application/json",
      cookie: controlCookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    };

    const readiness = await (await fetch(`${baseUrl}/api/v1/readiness`)).json() as { status: string; database: string };
    assert.deepEqual({ status: readiness.status, database: readiness.database }, { status: "ready", database: "ok" });
    const diagnostic = await fetch(`${baseUrl}/api/v1/diagnostics/model/test`, { method: "POST" });
    assert.equal(((await diagnostic.json()) as { ok: boolean }).ok, true);
    const models = await fetch(`${baseUrl}/api/v1/diagnostics/model/models`);
    assert.deepEqual(((await models.json()) as { models: string[] }).models, ["model-a", "model-b"]);

    const characterResponse = await fetch(`${baseUrl}/api/v1/characters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "待导出角色" }),
    });
    const characterId = ((await characterResponse.json()) as { character: { id: string } }).character.id;
    await fetch(`${baseUrl}/api/v1/sessions/export-session/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "sms", characterId, text: "5分钟后提醒我导出" }),
    });
    const tracesResponse = await fetch(`${baseUrl}/api/debug/model-traces?limit=20`);
    const tracesBody = await tracesResponse.json() as {
      traces: Array<{ requestText: string; payload: { messages?: unknown[]; tools?: unknown[] } }>;
    };
    assert.equal(tracesResponse.status, 200);
    assert.equal(tracesBody.traces.length, 2);
    assert.equal(tracesBody.traces[0].requestText, "5分钟后提醒我导出");
    assert.match(JSON.stringify(tracesBody.traces[0].payload.messages), /export-reminder-tool/);
    assert.ok((tracesBody.traces[0].payload.tools?.length ?? 0) > 0);

    const exported = await fetch(`${baseUrl}/api/v1/export`);
    const exportText = await exported.text();
    const exportBody = JSON.parse(exportText) as {
      characters: unknown[];
      scheduleItems: unknown[];
      actions: unknown[];
      modelContextTraces: unknown[];
    };
    assert.match(exported.headers.get("content-disposition") ?? "", /yourchar-export\.json/);
    assert.equal(exportBody.characters.length, 1);
    assert.equal(exportBody.scheduleItems.length, 1);
    assert.equal(exportBody.actions.length, 1);
    assert.equal(exportBody.modelContextTraces.length, 2);
    assert.equal(exportText.includes("export-must-not-contain-this"), false);

    const rejected = await fetch(`${baseUrl}/api/v1/data`, {
      method: "DELETE",
      headers: controlHeaders,
      body: JSON.stringify({ confirm: "no" }),
    });
    assert.equal(rejected.status, 400);
    const deleted = await fetch(`${baseUrl}/api/v1/data`, {
      method: "DELETE",
      headers: controlHeaders,
      body: JSON.stringify({ confirm: "DELETE_ALL_DATA" }),
    });
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/v1/characters`)).json(), { characters: [] });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/v1/sessions`)).json(), { sessions: [] });
    assert.deepEqual(await (await fetch(`${baseUrl}/api/debug/model-traces`)).json(), { traces: [] });

    const oversized = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "x".repeat(1024 * 1024) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await new Promise<void>((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8") || "{}";
}

function writeToolCallStream(response: import("node:http").ServerResponse): void {
  writeStreamChunks(response, [
    { delta: { role: "assistant" }, finish_reason: null },
    {
      delta: {
        tool_calls: [{
          index: 0,
          id: "export-reminder-tool",
          type: "function",
          function: {
            name: "create_schedule_item",
            arguments: JSON.stringify({
              kind: "reminder",
              title: "导出",
              timeExpression: "5分钟后",
              timezone: "Asia/Shanghai",
            }),
          },
        }],
      },
      finish_reason: null,
    },
    { delta: {}, finish_reason: "tool_calls" },
  ]);
}

function writeTextStream(response: import("node:http").ServerResponse, content: string): void {
  writeStreamChunks(response, [
    { delta: { role: "assistant" }, finish_reason: null },
    { delta: { content }, finish_reason: null },
    { delta: {}, finish_reason: "stop" },
  ]);
}

function writeStreamChunks(
  response: import("node:http").ServerResponse,
  choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>,
): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  for (const choice of choices) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-m4",
      object: "chat.completion.chunk",
      created: 1,
      model: "model-a",
      choices: [{ index: 0, ...choice }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

test("bounded audit summaries survive restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-audit-"));
  const clock = new VirtualClock("2026-07-12T09:00:00.000Z");
  try {
    const first = new CompanionKernel({ stateDir, clock, startScheduler: false });
    await first.sendMessage("audit", { mode: "sms", text: "5分钟后提醒我审计" });
    first.dispose();

    const second = new CompanionKernel({ stateDir, clock, startScheduler: false });
    assert.equal(second.recentContextLogs()[0].requestText, "5分钟后提醒我审计");
    assert.equal(second.store.allActions()[0].actionType, "create_schedule_item");
    second.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model context traces retain the latest ten per scope, redact credentials, and survive restart", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-traces-"));
  const clock = new VirtualClock("2026-07-12T09:00:00.000Z");
  try {
    const first = new CompanionKernel({ stateDir, clock, startScheduler: false });
    for (let index = 1; index <= 11; index += 1) {
      first.store.addModelContextTrace({
        sessionId: "trace-session",
        mode: "sms",
        turnKind: "user",
        requestText: `trace-${index}`,
        payload: {
          model: "model-a",
          authorization: "Bearer private",
          messages: [{ role: "user", content: `full-context-${index}` }],
        },
      });
      first.store.addModelContextTrace({
        sessionId: "character-function:trace-character",
        mode: "sms",
        turnKind: "character_function_inference",
        requestText: `background-${index}`,
        payload: {
          model: "model-a",
          messages: [{ role: "user", content: `background-context-${index}` }],
        },
      });
    }
    first.dispose();

    const second = new CompanionKernel({ stateDir, clock, startScheduler: false });
    const conversationTraces = second.recentModelContextTraces(100, "conversation");
    const backgroundTraces = second.recentModelContextTraces(100, "background");
    assert.equal(conversationTraces.length, 10);
    assert.equal(backgroundTraces.length, 10);
    assert.equal(second.recentModelContextTraces(100).length, 20);
    assert.equal(conversationTraces[0].requestText, "trace-11");
    assert.equal(conversationTraces[9].requestText, "trace-2");
    assert.equal(backgroundTraces[0].requestText, "background-11");
    assert.equal(backgroundTraces[9].requestText, "background-2");
    assert.equal(conversationTraces[0].scope, "conversation");
    assert.equal(backgroundTraces[0].scope, "background");
    assert.equal(conversationTraces[0].payload.authorization, "[REDACTED]");
    assert.match(JSON.stringify(conversationTraces[0].payload), /full-context-11/);

    second.store.addModelContextTrace({
      sessionId: "trace-session",
      mode: "sms",
      turnKind: "user",
      requestText: "trace-12",
      payload: { messages: [{ role: "user", content: "after-restart" }] },
    });
    const merged = second.recentModelContextTraces(10, "conversation");
    assert.equal(merged.length, 10);
    assert.equal(merged[0].requestText, "trace-12");
    assert.equal(merged[9].requestText, "trace-3");
    assert.equal(second.recentModelContextTraces(10, "background")[0].requestText, "background-11");
    second.dispose();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
