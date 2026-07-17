import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("module details expose MCP documentation and complete skill Markdown", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = addressOf(server);
    const mcp = await fetch(`${baseUrl}/api/v1/agent-modules/${encodeURIComponent("mcp:schedule")}`);
    assert.equal(mcp.status, 200);
    const mcpBody = await mcp.json() as { detail: { content: string } };
    assert.match(mcpBody.detail.content, /create_schedule_item/);
    assert.match(mcpBody.detail.content, /timeExpression/);

    const skill = await fetch(`${baseUrl}/api/v1/agent-modules/${encodeURIComponent("skill:roleplay-continuity")}`);
    assert.equal(skill.status, 200);
    const skillBody = await skill.json() as { detail: { content: string } };
    assert.match(skillBody.detail.content, /# Roleplay Continuity/);
    assert.match(skillBody.detail.content, /durable world, relationship, and plot facts/);
  } finally {
    await closeServer(server);
    kernel.dispose();
  }
});

test("latest user message can be edited through a Pi branch and then retracted", async () => {
  const runtime = createTestRuntime();
  const character = runtime.kernel.createCharacter({
    name: "消息角色",
    soulMarkdown: "# SOUL.md\n\n你是消息角色本人，使用第一人称简洁回复。",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = addressOf(server);
    runtime.model.enqueue([{ kind: "assistant_text", text: "我收到了原消息。" }]);
    await runtime.kernel.sendMessage("revision-session", {
      mode: "sms",
      characterId: character.id,
      text: "原消息",
    });
    const original = await transcript(baseUrl, "revision-session");
    const originalUser = original.find((entry) => entry.role === "user");
    assert.ok(originalUser?.entryId);
    assert.equal(originalUser.latestUser, true);

    runtime.model.enqueue([{ kind: "assistant_text", text: "我收到了编辑后的消息。" }]);
    const edited = await fetch(
      `${baseUrl}/api/v1/sessions/revision-session/messages/${encodeURIComponent(originalUser.entryId)}/edit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "编辑后的消息" }),
      },
    );
    assert.equal(edited.status, 200);
    const afterEdit = await transcript(baseUrl, "revision-session");
    assert.deepEqual(textMessages(afterEdit, "user"), ["编辑后的消息"]);
    assert.deepEqual(textMessages(afterEdit, "assistant"), ["我收到了编辑后的消息。"]);

    const editedUser = afterEdit.find((entry) => entry.role === "user");
    assert.ok(editedUser?.entryId);
    const retracted = await fetch(
      `${baseUrl}/api/v1/sessions/revision-session/messages/${encodeURIComponent(editedUser.entryId)}/retract`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.equal(retracted.status, 200);
    const afterRetract = await transcript(baseUrl, "revision-session");
    assert.deepEqual(textMessages(afterRetract, "user"), []);
    assert.deepEqual(textMessages(afterRetract, "assistant"), []);
    assert.equal(textMessages(afterRetract, "custom").some((entry) => /撤回/.test(entry)), true);
  } finally {
    await closeServer(server);
    runtime.dispose();
  }
});

test("message revision is blocked after the turn records a completed mutation", async () => {
  const runtime = createTestRuntime();
  const character = runtime.kernel.createCharacter({ name: "副作用角色" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = addressOf(server);
    runtime.model.enqueue([{ kind: "assistant_text", text: "我已经处理。" }]);
    await runtime.kernel.sendMessage("mutation-session", {
      mode: "sms",
      characterId: character.id,
      text: "处理这件事",
    });
    const log = runtime.kernel.store.latestContextLog("mutation-session");
    assert.ok(log);
    log.actions.push(runtime.kernel.store.addAction("create_schedule_item", "completed", {
      scheduleItemId: "test-item",
    }));
    const messages = await transcript(baseUrl, "mutation-session");
    const user = messages.find((entry) => entry.role === "user");
    assert.ok(user?.entryId);
    const response = await fetch(
      `${baseUrl}/api/v1/sessions/mutation-session/messages/${encodeURIComponent(user.entryId)}/retract`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.equal(response.status, 409);
    const body = await response.json() as { code: string };
    assert.equal(body.code, "MESSAGE_REVISION_BLOCKED");
  } finally {
    await closeServer(server);
    runtime.dispose();
  }
});

test("feature test catalog is available and blocked preflight does not call a model", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const character = kernel.createCharacter({ name: "测试角色" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = addressOf(server);
    const catalog = await fetch(`${baseUrl}/api/v1/feature-tests`);
    assert.equal(catalog.status, 200);
    const catalogBody = await catalog.json() as { cases: Array<{ id: string }> };
    assert.equal(catalogBody.cases.length >= 10, true);
    assert.equal(catalogBody.cases.some((entry) => entry.id === "schedule-relative-reminder"), true);

    const run = await fetch(`${baseUrl}/api/v1/feature-tests/sms-character-voice/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: character.id }),
    });
    assert.equal(run.status, 200);
    const runBody = await run.json() as { result: { passed: boolean; status: string; modelRequests: number } };
    assert.equal(runBody.result.passed, false);
    assert.equal(runBody.result.status, "blocked");
    assert.equal(runBody.result.modelRequests, 0);
  } finally {
    await closeServer(server);
    kernel.dispose();
  }
});

test("user and character avatars validate, persist through the API, and appear in character listings", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const character = kernel.createCharacter({ name: "头像角色" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = addressOf(server);
    const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const userPut = await fetch(`${baseUrl}/api/v1/avatars/user`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    assert.equal(userPut.status, 200);
    const userProfile = await (await fetch(`${baseUrl}/api/v1/user-profile`)).json() as { avatarUrl?: string };
    assert.match(userProfile.avatarUrl ?? "", /^\/api\/v1\/avatars\/user\?v=/);
    const userAvatar = await fetch(`${baseUrl}${userProfile.avatarUrl}`);
    assert.equal(userAvatar.headers.get("content-type"), "image/png");
    assert.equal((await userAvatar.arrayBuffer()).byteLength > 0, true);

    const characterPut = await fetch(`${baseUrl}/api/v1/avatars/characters/${character.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl }),
    });
    assert.equal(characterPut.status, 200);
    const listing = await (await fetch(`${baseUrl}/api/v1/characters`)).json() as {
      characters: Array<{ id: string; avatarUrl?: string }>;
    };
    assert.match(listing.characters.find((entry) => entry.id === character.id)?.avatarUrl ?? "", /avatars\/characters/);

    const invalid = await fetch(`${baseUrl}/api/v1/avatars/user`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/png;base64,SGVsbG8=" }),
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json() as { code: string }).code, "AVATAR_INVALID");

    assert.equal((await fetch(`${baseUrl}/api/v1/avatars/user`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/v1/avatars/user`)).status, 404);
  } finally {
    await closeServer(server);
    kernel.dispose();
  }
});

type TranscriptMessage = {
  role: string;
  content?: string | Array<{ type: string; text?: string }>;
  entryId?: string;
  latestUser?: boolean;
};

async function transcript(baseUrl: string, sessionId: string): Promise<TranscriptMessage[]> {
  const response = await fetch(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`);
  assert.equal(response.status, 200);
  return await response.json() as TranscriptMessage[];
}

function textMessages(messages: TranscriptMessage[], role: string): string[] {
  return messages.filter((entry) => entry.role === role).map((entry) => {
    if (typeof entry.content === "string") return entry.content;
    return (entry.content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
  }).filter(Boolean);
}

function addressOf(server: ReturnType<typeof createHttpServer>): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createHttpServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
