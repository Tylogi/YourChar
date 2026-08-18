import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("RP v1 API supports characters, scenes, memory confirmation, correction, and deletion", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-12T09:00:00.000Z"),
  });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const json = (path: string, init?: RequestInit) => fetch(`${baseUrl}${path}`, init);

    const soulMarkdown = "# SOUL.md - 林澈\n\n## 核心身份\n\n林澈是长期伙伴。\n\n## 边界\n\n- 不替用户决定。";
    const created = await json("/api/v1/characters", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "林澈", soulMarkdown }),
    });
    const character = ((await created.json()) as {
      character: { id: string; soulMarkdown: string; soulCharacterCount: number };
    }).character;
    assert.equal(created.status, 201);
    assert.equal(character.soulMarkdown, soulMarkdown);
    assert.equal(character.soulCharacterCount, [...soulMarkdown].length);

    const updatedSoul = `${soulMarkdown}\n\n## 气质与表达\n\n克制、敏锐。`;
    const updated = await json(`/api/v1/characters/${character.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ soulMarkdown: updatedSoul }),
    });
    assert.equal(updated.status, 200);
    assert.equal(
      ((await updated.json()) as { character: { soulMarkdown: string } }).character.soulMarkdown,
      updatedSoul,
    );

    const overLimit = await json(`/api/v1/characters/${character.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ soulMarkdown: "角".repeat(8_001) }),
    });
    assert.equal(overLimit.status, 400);
    assert.equal((await overLimit.json() as { code: string }).code, "CHARACTER_SOUL_INVALID");

    await kernel.sessionRuntime.getOrCreate("api-rp", "rp", character.id);
    const scene = await json("/api/v1/sessions/api-rp/scene", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: character.id, location: "车站", summary: "准备出发" }),
    });
    assert.equal(((await scene.json()) as { scene: { location: string } }).scene.location, "车站");

    const memory = await json("/api/v1/memories", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "api-memory" },
      body: JSON.stringify({
        type: "relationship_event",
        key: "relationship.first_meeting",
        content: "角色与用户在杭州初次相识",
        characterId: character.id,
        confirmed: true,
        tags: ["relationship"],
      }),
    });
    const memoryBody = (await memory.json()) as {
      memory: { id: string; confirmed: boolean; realm: string; scope: string; characterId: string };
    };
    assert.equal(memory.status, 201);
    assert.equal(memoryBody.memory.confirmed, true);
    assert.equal(memoryBody.memory.realm, "roleplay");
    assert.equal(memoryBody.memory.scope, "character");
    assert.equal(memoryBody.memory.characterId, character.id);

    for (const type of ["user_fact", "preference"]) {
      const rejectedProfileType = await json("/api/v1/memories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          realm: "roleplay",
          scope: "character",
          type,
          content: `不得写入角色记忆的 ${type}`,
          characterId: character.id,
          confirmed: true,
        }),
      });
      assert.equal(rejectedProfileType.status, 400);
      assert.equal(
        ((await rejectedProfileType.json()) as { code: string }).code,
        "RP_MEMORY_TYPE_INVALID",
      );
    }

    const rejectedRealityMemory = await json("/api/v1/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        realm: "reality",
        scope: "global",
        type: "user_fact",
        content: "不得通过 RP Memory 写入的全局画像",
      }),
    });
    assert.equal(rejectedRealityMemory.status, 400);
    assert.equal(
      ((await rejectedRealityMemory.json()) as { code: string }).code,
      "RP_MEMORY_SCOPE_INVALID",
    );

    const rejectedUnboundMemory = await json("/api/v1/memories", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "plot_event",
        content: "没有角色绑定的记忆",
      }),
    });
    assert.equal(rejectedUnboundMemory.status, 400);
    assert.equal(
      ((await rejectedUnboundMemory.json()) as { code: string }).code,
      "RP_MEMORY_SCOPE_INVALID",
    );

    const search = await json(`/api/v1/memories?characterId=${encodeURIComponent(character.id)}&confirmedOnly=1`);
    assert.equal(((await search.json()) as { memories: unknown[] }).memories.length, 1);

    const rejectedRealmChange = await json(`/api/v1/memories/${memoryBody.memory.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ realm: "reality", scope: "global" }),
    });
    assert.equal(rejectedRealmChange.status, 400);
    assert.equal(
      ((await rejectedRealmChange.json()) as { code: string }).code,
      "RP_MEMORY_SCOPE_INVALID",
    );

    const rejectedTypeChange = await json(`/api/v1/memories/${memoryBody.memory.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "preference" }),
    });
    assert.equal(rejectedTypeChange.status, 400);
    assert.equal(
      ((await rejectedTypeChange.json()) as { code: string }).code,
      "RP_MEMORY_TYPE_INVALID",
    );

    const corrected = await json(`/api/v1/memories/${memoryBody.memory.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "角色与用户在杭州雨夜初次相识" }),
    });
    assert.equal(
      ((await corrected.json()) as { memory: { content: string } }).memory.content,
      "角色与用户在杭州雨夜初次相识",
    );

    const deleted = await json(`/api/v1/memories/${memoryBody.memory.id}`, { method: "DELETE" });
    assert.equal(((await deleted.json()) as { memory: { validity: string } }).memory.validity, "deleted");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});
