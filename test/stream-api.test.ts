import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("SSE messages expose text deltas and a canonical final response", async () => {
  const server = createHttpServer({ kernel: new CompanionKernel({ stateDir: false }), testMode: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const run = await fetch(`${baseUrl}/api/_test/v1/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seed: "stream" }),
    });
    const runId = ((await run.json()) as { runId: string }).runId;
    const headers = { "content-type": "application/json", "x-rp-test-run-id": runId };
    const missingCharacter = await fetch(`${baseUrl}/api/v1/sessions/missing/messages/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "sms", text: "hello" }),
    });
    assert.equal(missingCharacter.status, 422);
    assert.match(missingCharacter.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(((await missingCharacter.json()) as { code: string }).code, "CHARACTER_REQUIRED");

    const characterResponse = await fetch(`${baseUrl}/api/v1/characters`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "流式测试角色" }),
    });
    const characterId = ((await characterResponse.json()) as { character: { id: string } }).character.id;
    await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/model/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses: [{ kind: "stream_chunks", chunks: ["流式", "回复"] }] }),
    });

    const response = await fetch(`${baseUrl}/api/v1/sessions/stream/messages/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "sms", characterId, text: "hello" }),
    });
    const body = await response.text();
    assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.match(body, /"type":"delta"/);
    assert.match(body, /流式/);
    assert.match(body, /"type":"done"/);
    assert.match(body, /流式回复/);
    assert.match(body, /"status":"completed"/);
    assert.match(body, /"canRetry":false/);

    await fetch(`${baseUrl}/api/_test/v1/runs/${runId}/model/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses: [
        { kind: "tool_call", name: "list_schedule_items", arguments: {} },
        { kind: "assistant_text", text: "工具查询完成" },
      ] }),
    });
    const toolResponse = await fetch(`${baseUrl}/api/v1/sessions/stream-tool/messages/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "sms", characterId, text: "查看当前日程" }),
    });
    const toolBody = await toolResponse.text();
    assert.match(toolBody, /"type":"tool_start"/);
    assert.match(toolBody, /"type":"tool_end"/);
    assert.match(toolBody, /"toolName":"list_schedule_items"/);
    assert.match(toolBody, /"result":\{"content":/);

    const completedRetry = await fetch(`${baseUrl}/api/v1/sessions/stream/messages/retry`, {
      method: "POST",
      headers: { "x-rp-test-run-id": runId },
    });
    assert.equal(completedRetry.status, 409);
    assert.equal(((await completedRetry.json()) as { code: string }).code, "TURN_NOT_RETRYABLE");

    const modeMismatch = await fetch(`${baseUrl}/api/v1/sessions/stream/messages/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "rp", characterId, text: "change mode" }),
    });
    assert.equal(modeMismatch.status, 409);
    assert.equal(((await modeMismatch.json()) as { code: string }).code, "SESSION_MODE_MISMATCH");

    const otherCharacterResponse = await fetch(`${baseUrl}/api/v1/characters`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "另一个角色" }),
    });
    const otherCharacterId = ((await otherCharacterResponse.json()) as { character: { id: string } }).character.id;
    const characterMismatch = await fetch(`${baseUrl}/api/v1/sessions/stream/messages/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "sms", characterId: otherCharacterId, text: "change character" }),
    });
    assert.equal(characterMismatch.status, 409);
    assert.equal(((await characterMismatch.json()) as { code: string }).code, "SESSION_CHARACTER_MISMATCH");

    const cancel = await fetch(`${baseUrl}/api/v1/sessions/stream/messages/cancel`, {
      method: "POST",
      headers: { "x-rp-test-run-id": runId },
    });
    assert.deepEqual(await cancel.json(), { cancelled: false });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("manual retry is allowed only after a side-effect-free failed turn", async () => {
  const server = createHttpServer({ kernel: new CompanionKernel({ stateDir: false }), testMode: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const runId = ((await (await fetch(`${baseUrl}/api/_test/v1/runs`, { method: "POST" })).json()) as { runId: string }).runId;
    const queue = (responses: unknown[]) => fetch(`${baseUrl}/api/_test/v1/runs/${runId}/model/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ responses }),
    });
    const headers = { "content-type": "application/json", "x-rp-test-run-id": runId };
    const characterResponse = await fetch(`${baseUrl}/api/v1/characters`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "重试测试角色" }),
    });
    const characterId = ((await characterResponse.json()) as { character: { id: string } }).character.id;
    await queue([{ kind: "provider_error", message: "temporary outage" }]);
    const failed = await fetch(`${baseUrl}/api/v1/sessions/retry/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ mode: "sms", characterId, text: "retry me" }),
    });
    const failedBody = (await failed.json()) as {
      reply: string;
      messageType?: string;
      status?: string;
      canRetry?: boolean;
    };
    assert.match(failedBody.reply, /temporary outage/);
    assert.equal(failedBody.messageType, "system");
    assert.equal(failedBody.status, "failed");
    assert.equal(failedBody.canRetry, true);
    const failedMessages = (await (await fetch(`${baseUrl}/api/v1/sessions/retry/messages`, {
      headers: { "x-rp-test-run-id": runId },
    })).json()) as Array<{ role: string; customType?: string }>;
    assert.equal(failedMessages.at(-1)?.role, "custom");
    assert.equal(failedMessages.at(-1)?.customType, "rp-agent/system_event");

    await queue([{ kind: "assistant_text", text: "recovered" }]);
    const retried = await fetch(`${baseUrl}/api/v1/sessions/retry/messages/retry`, {
      method: "POST",
      headers: { "x-rp-test-run-id": runId },
    });
    assert.equal(((await retried.json()) as { reply: string }).reply, "recovered");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
