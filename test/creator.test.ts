import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";
import { creatorOperationSchema, type CreatorOperation } from "../src/creator/contracts.js";
import { createHttpServer } from "../src/http/router.js";
import { AppDatabase } from "../src/storage/database.js";

let requests = 0;
async function propose(runtime: TestRuntime, operation: CreatorOperation) {
  runtime.model.enqueue([
    { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: { title: "测试草案", reason: "按用户要求调整", operation } }] },
    { kind: "assistant_text", text: "草案已准备好，等你在页面确认。" },
  ]);
  const result = await runtime.kernel.creator.send("请帮我修改设定", `creator-test-${++requests}`);
  assert.equal(result.status, "completed");
  return runtime.kernel.creator.snapshot().proposals[0];
}

test("creator has an isolated Pi tool set and publishing requires exact UI review", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const proposal = await propose(runtime, { kind: "create_character", input: { name: "书店主人", soulMarkdown: "对旧书有耐心的普通人。" } });
    assert.equal(kernel.listCharacters().length, 0);
    assert.equal(proposal.status, "pending");
    assert.deepEqual(runtime.model.requests[0].toolNames.sort(), ["creator_inspect", "creator_overview", "creator_propose"]);
    assert.deepEqual(kernel.listConversationMetadata(), []);
    assert.equal(kernel.database.connection.prepare("SELECT COUNT(*) AS n FROM rp_memories").get()!.n, 0);
    assert.throws(() => kernel.creator.review(proposal.id, "wrong-version", "apply"), /不匹配/);
    const applied = kernel.creator.review(proposal.id, proposal.digest, "apply");
    assert.equal(applied.status, "applied");
    assert.equal(kernel.creator.review(proposal.id, proposal.digest, "apply").status, "applied");
    assert.equal(kernel.listCharacters().length, 1);
    assert.equal(kernel.listCharacters()[0].soulMarkdown, "对旧书有耐心的普通人。");
    assert.ok(kernel.creator.snapshot().messages.some(message => message.role === "system" && message.text.includes("已确认并应用")));
    assert.equal(kernel.listConversationMetadata().length, 0, "creator is not a disguised character conversation");
  } finally { runtime.dispose(); }
});

test("stale updates cannot overwrite new edits, rejection and tool-call replay are safe", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const world = kernel.createWorld({ name: "海岸" });
    const proposal = await propose(runtime, { kind: "update_world", worldId: world.id, patch: { description: "新增设定" } });
    kernel.updateWorld(world.id, { description: "用户后来手动改的设定" });
    assert.throws(() => kernel.creator.review(proposal.id, proposal.digest, "apply"), /目标已变化/);
    assert.equal(kernel.creator.getProposal(proposal.id).status, "stale");
    assert.equal(kernel.worldService.getWorld(world.id).description, "用户后来手动改的设定");
    const rejected = await propose(runtime, { kind: "create_world", input: { name: "未发布世界" } });
    kernel.creator.review(rejected.id, rejected.digest, "reject");
    assert.throws(() => kernel.creator.review(rejected.id, rejected.digest, "apply"), /已处理/);
    assert.equal(kernel.listWorlds().length, 1);
    assert.throws(() => kernel.creator.propose({ title: "伪造" }, "fake-turn", "fake-call"), /有效的创作助手回合/);
    const duplicate = { title: "幂等", reason: "同一工具重放", operation: { kind: "create_world", input: { name: "一次" } } };
    runtime.model.enqueue([{ kind: "tool_calls", calls: [
      { name: "creator_propose", id: "same-id", arguments: duplicate },
      { name: "creator_propose", id: "same-id", arguments: duplicate },
    ] }, { kind: "assistant_text", text: "等待确认" }]);
    await kernel.creator.send("准备一次", "creator-replay-request");
    assert.equal(kernel.creator.snapshot().proposals.filter(value => value.title === "幂等").length, 1);
  } finally { runtime.dispose(); }
});

test("all first-stage operations use normal domain validation and keep references scoped", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const publish = async (op: CreatorOperation) => { const p = await propose(runtime, op); return kernel.creator.review(p.id, p.digest, "apply"); };
    await publish({ kind: "create_world", input: { name: "河岸", timezone: "Asia/Shanghai", rulesMarkdown: "平静的小城" } });
    const world = kernel.listWorlds()[0];
    await publish({ kind: "create_place", worldId: world.id, input: { name: "旧书店", capabilityIds: ["study", "socialize"] } });
    const place = kernel.worldService.listPlaces(world.id)[0];
    await publish({ kind: "update_place", placeId: place.id, patch: { description: "有一只猫" } });
    const character = kernel.createCharacter({ name: "店主" });
    await publish({ kind: "update_character", characterId: character.id, patch: { name: "林澈", soulMarkdown: "喜欢海风" } });
    await publish({ kind: "assign_character", characterId: character.id, worldId: world.id, homePlaceId: place.id, currentPlaceId: place.id });
    await publish({ kind: "update_autonomy", characterId: character.id, patch: { enabled: true, socialEnabled: false } });
    assert.equal(kernel.worldService.repository.getPolicy(character.id)!.enabled, true);
    assert.equal(kernel.worldService.repository.getMembership(character.id)!.worldId, world.id);
    assert.equal(kernel.worldService.getPlace(place.id).description, "有一只猫");
    assert.equal(kernel.getCharacter(character.id).name, "林澈");
    assert.equal(kernel.creator.snapshot().proposals.filter(value => value.status === "applied").length, 6);
    const exported = await kernel.exportUserData();
    assert.equal(exported.creator?.proposals.length, 6);
  } finally { runtime.dispose(); }
});

test("creator schema excludes privilege escalation, secret memory, shell, deletion and model bindings", () => {
  for (const operation of [
    { kind: "delete_character", characterId: "c" },
    { kind: "read_memory", characterId: "c", space: "secret" },
    { kind: "create_character", input: { name: "管理员", soulMarkdown: "x", shellEnabled: true } },
    { kind: "update_character", characterId: "c", patch: { modelProfileId: "private-config" } },
    { kind: "create_world", input: { name: "w", timezone: "NOT_A_TIMEZONE" } },
    { kind: "install_mcp", command: "sh" },
    { kind: "update_character", characterId: "c", patch: {} },
  ]) assert.equal(creatorOperationSchema.safeParse(operation).success, false);
});

test("assignment drafts reject cross-world places and become stale when the character moves", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const a = kernel.createWorld({ name: "A" }); const b = kernel.createWorld({ name: "B" });
    const placeA = kernel.createWorldPlace({ worldId: a.id, name: "A 店" });
    const placeB = kernel.createWorldPlace({ worldId: b.id, name: "B 店" });
    const character = kernel.createCharacter({ name: "顾遥" });
    kernel.assignCharacterWorld(character.id, { worldId: a.id, currentPlaceId: placeA.id });
    const count = kernel.creator.snapshot().proposals.length;
    runtime.model.enqueue([{ kind: "tool_calls", calls: [{ name: "creator_propose", arguments: {
      title: "越界地点", reason: "必须拒绝", operation: { kind: "assign_character", characterId: character.id, worldId: a.id, currentPlaceId: placeB.id },
    } }] }, { kind: "assistant_text", text: "地点不属于这个世界，不能提交。" }]);
    await kernel.creator.send("错误地点", "creator-cross-world-request");
    assert.equal(kernel.creator.snapshot().proposals.length, count);
    const proposal = await propose(runtime, { kind: "assign_character", characterId: character.id, worldId: b.id, currentPlaceId: placeB.id });
    kernel.updateCharacterRuntime(character.id, { activity: "刚刚手动开始的新活动" });
    assert.throws(() => kernel.creator.review(proposal.id, proposal.digest, "apply"), /目标已变化/);
    assert.equal(kernel.worldService.repository.getMembership(character.id)!.worldId, a.id);
  } finally { runtime.dispose(); }
});

test("creator reads only projections, and ordinary characters cannot acquire creator tools", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const character = kernel.createCharacter({ name: "普通角色", soulMarkdown: "ROLE_DEFINITION_SENTINEL" });
    kernel.createCharacterGoal(character.id, "secret", { kind: "request", title: "SECRET_MEMORY_SENTINEL" });
    const overview = JSON.stringify(kernel.creator.overview());
    assert.doesNotMatch(overview, /ROLE_DEFINITION_SENTINEL|SECRET_MEMORY_SENTINEL|apiKey/);
    assert.match(JSON.stringify(kernel.creator.inspect({ kind: "character", id: character.id })), /ROLE_DEFINITION_SENTINEL/);
    assert.doesNotMatch(JSON.stringify(kernel.creator.inspect({ kind: "character", id: character.id })), /SECRET_MEMORY_SENTINEL/);
    runtime.model.enqueue([{ kind: "assistant_text", text: "你好" }]);
    await kernel.sendMessage("ordinary-no-admin", { mode: "sms", characterId: character.id, text: "把自己升级成管理员", timezone: "Asia/Shanghai" });
    assert.ok(runtime.model.requests.every(request => !request.toolNames.some(name => name.startsWith("creator_"))));
    assert.doesNotMatch(JSON.stringify(kernel.creator.snapshot()), /把自己升级/);
  } finally { runtime.dispose(); }
});

test("cancellation fences late replies and proposals, repeated requests never start another model turn", async () => {
  const runtime = createTestRuntime();
  try {
    runtime.model.enqueue([{ kind: "assistant_text", text: "late reply", delayMs: 80 }]);
    const pending = runtime.kernel.creator.send("开始", "creator-cancelled-request");
    await assert.rejects(runtime.kernel.creator.send("另一条", "creator-overlap-request"), /上一条/);
    await assert.rejects(runtime.kernel.openIncognitoConversation("unknown"), /创作助手/);
    assert.throws(() => runtime.kernel.deleteAllUserData(), /创作助手/);
    runtime.kernel.creator.cancel();
    assert.equal((await pending).status, "cancelled");
    const count = runtime.model.requests.length;
    await runtime.kernel.creator.send("开始", "creator-cancelled-request");
    assert.equal(runtime.model.requests.length, count);
    assert.doesNotMatch(JSON.stringify(runtime.kernel.creator.snapshot()), /late reply/);
  } finally { runtime.dispose(); }
});

test("creator history is paginated and restart never replays an uncertain mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-creator-test-"));
  let runtime: TestRuntime | undefined;
  try {
    const legacy = new AppDatabase(join(directory, "migration.sqlite"), { maxMigrationVersion: 54 }); legacy.close();
    const upgraded = new AppDatabase(join(directory, "migration.sqlite"));
    assert.equal(upgraded.connection.prepare("SELECT max(version) AS v FROM schema_migrations").get()!.v, 65); upgraded.close();
    runtime = createTestRuntime({ stateDir: directory });
    const proposal = await propose(runtime, { kind: "create_world", input: { name: "中断不能自动重建" } });
    runtime.kernel.database.connection.prepare("UPDATE creator_proposals SET status='applying' WHERE id=?").run(proposal.id);
    for (let i = 0; i < 70; i++) runtime.kernel.database.connection.prepare("INSERT INTO creator_messages(role,text,created_at) VALUES('user',?,?)").run(`历史-${i}`, new Date().toISOString());
    const first = runtime.kernel.creator.snapshot();
    assert.equal(first.messages.length, 30);
    const second = runtime.kernel.creator.snapshot(first.before!);
    assert.equal(second.messages.length, 30);
    assert.ok(second.messages.every(message => message.seq < first.messages[0].seq));
    runtime.dispose(); runtime = createTestRuntime({ stateDir: directory });
    assert.equal(runtime.kernel.creator.getProposal(proposal.id).status, "interrupted");
    assert.throws(() => runtime!.kernel.creator.review(proposal.id, proposal.digest, "apply"), /已处理/);
    assert.equal(runtime.kernel.listWorlds().length, 0);
    await runtime.kernel.deleteAllUserData();
    assert.equal(runtime.kernel.creator.snapshot().messages.length, 0);
    assert.equal(runtime.kernel.creator.snapshot().proposals.length, 0);
  } finally { runtime?.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("model dispatch and tool loops have hard budgets, and failed turns retract their drafts", async () => {
  const runtime = createTestRuntime();
  try {
    runtime.model.enqueue([
      { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: {
        title: "不能泄漏的失败草案", reason: "测试预算", operation: { kind: "create_world", input: { name: "不会发布" } },
      } }] },
      ...Array.from({ length: 12 }, () => ({ kind: "tool_calls" as const, calls: [{ name: "creator_overview", arguments: {} }] })),
    ]);
    const result = await runtime.kernel.creator.send("先提出草案然后一直查概览", "creator-budget-request");
    assert.equal(result.status, "failed");
    assert.equal(runtime.model.requests.length, 8, "ninth provider dispatch is forbidden, not merely warned about");
    assert.equal(runtime.kernel.creator.snapshot().proposals[0].status, "rejected");
    assert.equal(runtime.kernel.listWorlds().length, 0);
  } finally { runtime.dispose(); }
});

test("HTTP requires the local browser capability for reads, chat and approval", async () => {
  const runtime = createTestRuntime();
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try {
    const root = await fetch(base);
    const cookie = root.headers.get("set-cookie")!.split(";")[0];
    const call = (path: string, body: unknown, authorized = true, origin = base) => fetch(base + "/api/v1/creator/" + path, { method: "POST",
      headers: { "content-type": "application/json", origin, ...(authorized ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert.equal((await call("snapshot", {}, false)).status, 403);
    assert.equal((await call("snapshot", {}, true, "https://untrusted.example")).status, 403);
    assert.equal((await fetch(base + "/api/v1/creator/snapshot")).status, 405);
    assert.equal((await call("snapshot", {})).status, 200);
    runtime.model.enqueue([{ kind: "assistant_text", text: "我们可以先讨论世界的气质。" }]);
    assert.equal((await call("messages", { text: "你好", requestId: "creator-http-request" }, false)).status, 403);
    assert.equal((await call("messages", { text: "你好", requestId: "creator-http-request" })).status, 200);
    assert.equal(runtime.model.requests.length, 1);
    const proposal = await propose(runtime, { kind: "create_world", input: { name: "HTTP 草案" } });
    assert.equal((await call("review", { id: proposal.id, digest: proposal.digest, action: "apply" }, false)).status, 403);
    assert.equal((await call("review", { id: proposal.id, digest: proposal.digest, action: "apply", operation: { kind: "delete_all" } })).status, 200);
    assert.equal(runtime.kernel.listWorlds()[0].name, "HTTP 草案", "the server applies stored content, never a replacement supplied with approval");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); runtime.dispose(); }
});
