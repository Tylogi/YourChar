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

test("world-builder instructions stay server-side and pending drafts can be edited before applying", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    runtime.model.enqueue([
      { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: { title: "新建角色", reason: "灵感主角", operation: { kind: "create_character", input: { name: "小杰", soulMarkdown: "直率的少年猎人。" } } } }] },
      { kind: "assistant_text", text: "已准备好角色草案。" },
    ]);
    const result = await kernel.creator.send("穿越到猎人世界", "creator-builder-request", { newSession: true, mode: "world_builder" });
    assert.equal(result.status, "completed");
    assert.ok(JSON.stringify(runtime.model.requests[0].messages).includes("一键建构模式"));
    const userMessages = kernel.creator.snapshot().messages.filter(message => message.role === "user");
    assert.deepEqual(userMessages.map(message => message.text), ["穿越到猎人世界"], "transcript keeps only the user's words");
    await assert.rejects(kernel.creator.send("x", "creator-bad-mode-request", { newSession: true, mode: "admin" as never }), /未知的创作模式/);

    const proposal = kernel.creator.snapshot().proposals[0];
    assert.throws(() => kernel.creator.review(proposal.id, proposal.digest, "apply", { modelProfileId: "x" }), /不能编辑字段/);
    assert.throws(() => kernel.creator.review(proposal.id, proposal.digest, "apply", { name: "" }), /不合法/);
    assert.equal(kernel.listCharacters().length, 0);
    const applied = kernel.creator.review(proposal.id, proposal.digest, "apply", { soulMarkdown: "用户改过的设定。" });
    assert.equal(applied.status, "applied");
    assert.notEqual(applied.digest, proposal.digest);
    assert.equal(kernel.listCharacters()[0].soulMarkdown, "用户改过的设定。");
    assert.equal(kernel.creator.review(proposal.id, proposal.digest, "apply").status, "applied", "retrying with the pre-edit digest is a no-op");
    assert.equal(kernel.listCharacters().length, 1);

    const world = kernel.createWorld({ name: "海岸" });
    runtime.model.enqueue([
      { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: { title: "改描述", reason: "测试", operation: { kind: "update_world", worldId: world.id, patch: { description: "草案描述" } } } }] },
      { kind: "assistant_text", text: "好了。" },
    ]);
    await kernel.creator.send("改一下海岸", "creator-stale-edit-request");
    const stale = kernel.creator.snapshot().proposals.find(value => value.status === "pending")!;
    kernel.updateWorld(world.id, { description: "用户手动改的" });
    assert.throws(() => kernel.creator.review(stale.id, stale.digest, "apply", { description: "用户在草案里改的" }), /目标已变化/);
    const after = kernel.creator.getProposal(stale.id);
    assert.equal(after.status, "stale");
    assert.equal(after.digest, stale.digest, "edits are not persisted when a pre-apply check fails");
    assert.equal(kernel.worldService.getWorld(world.id).description, "用户手动改的");
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

test("sessions isolate transcripts and drafts, world-builder applies only to the opening message, and the start page lists every pending draft", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const reply = (text: string, name?: string) => runtime.model.enqueue([
      ...(name ? [{ kind: "tool_calls" as const, calls: [{ name: "creator_propose", arguments: { title: name, reason: "测试", operation: { kind: "create_world" as const, input: { name } } } }] }] : []),
      { kind: "assistant_text" as const, text },
    ]);
    const send = async (...args: Parameters<typeof kernel.creator.send>) => {
      const result = await kernel.creator.send(...args);
      assert.ok("sessionId" in result);
      return result;
    };
    reply("聊聊书店。", "书店世界");
    const chat = await send("想要一间海边书店", "creator-session-a", { newSession: true });
    reply("猎人世界草案。", "猎人世界");
    const builder = await send("穿越到全职猎人", "creator-session-b", { newSession: true, mode: "world_builder" });
    assert.notEqual(chat.sessionId, builder.sessionId);
    assert.equal(builder.session?.mode, "world_builder");
    assert.deepEqual(builder.messages.filter(message => message.role === "user").map(message => message.text), ["穿越到全职猎人"]);
    assert.deepEqual(builder.proposals.map(proposal => proposal.title), ["猎人世界"], "drafts belong to their own session");
    assert.ok(JSON.stringify(runtime.model.requests.at(-2)?.messages).includes("一键建构模式"));
    assert.ok(!JSON.stringify(runtime.model.requests.at(-2)?.messages).includes("海边书店"), "other sessions' history is not sent");

    reply("继续补充。");
    await kernel.creator.send("继续", "creator-session-b2", { sessionId: builder.sessionId! });
    assert.ok(!JSON.stringify(runtime.model.requests.at(-1)?.messages).includes("一键建构模式"), "follow-ups are ordinary chat");
    assert.ok(JSON.stringify(runtime.model.requests.at(-1)?.messages).includes("穿越到全职猎人"), "follow-ups see their own session history");

    const chatView = kernel.creator.snapshot(undefined, chat.sessionId!);
    assert.deepEqual(chatView.messages.filter(message => message.role === "user").map(message => message.text), ["想要一间海边书店"]);
    const start = kernel.creator.snapshot(undefined, null);
    assert.equal(start.sessionId, null);
    assert.equal(start.messages.length, 0);
    assert.deepEqual(start.proposals.map(proposal => proposal.title).sort(), ["书店世界", "猎人世界"]);
    assert.deepEqual(start.sessions.map(session => session.id), [builder.sessionId, chat.sessionId], "most recently active first");
    assert.equal(start.sessions[0].pendingCount, 1);

    const draft = builder.proposals[0];
    kernel.creator.review(draft.id, draft.digest, "apply");
    assert.ok(kernel.creator.snapshot(undefined, builder.sessionId!).messages.some(message => message.text.includes("已确认并应用")));
    assert.ok(!kernel.creator.snapshot(undefined, chat.sessionId!).messages.some(message => message.text.includes("已确认并应用")));
    assert.throws(() => kernel.creator.snapshot(undefined, "missing"), /找不到这个会话/);
  } finally { runtime.dispose(); }
});

test("the pending-draft limit is counted per session", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const draft = (title: string) => ({ name: "creator_propose", arguments: { title, reason: "测试", operation: { kind: "create_world" as const, input: { name: title } } } });
    runtime.model.enqueue([{ kind: "tool_calls", calls: [draft("A-0")] }, { kind: "assistant_text", text: "好。" }]);
    const first = await kernel.creator.send("会话 A", "creator-limit-a", { newSession: true });
    assert.ok("sessionId" in first && first.sessionId);
    const sessionA = first.sessionId;
    const turn = kernel.database.connection.prepare("SELECT turn_id FROM creator_proposals WHERE session_id=?").get(sessionA)!.turn_id as string;
    const payload = kernel.database.connection.prepare("SELECT payload FROM creator_proposals WHERE session_id=?").get(sessionA)!.payload as string;
    for (let i = 1; i < 20; i++) kernel.database.connection.prepare(`INSERT INTO creator_proposals(id,turn_id,tool_key,payload,status,created_at,updated_at,session_id)
      VALUES(?,?,?,?,'pending',?,?,?)`).run(`filler-${i}`, turn, `filler-${i}`, payload, new Date().toISOString(), new Date().toISOString(), sessionA);

    runtime.model.enqueue([{ kind: "tool_calls", calls: [draft("B-0")] }, { kind: "assistant_text", text: "好。" }]);
    const second = await kernel.creator.send("会话 B", "creator-limit-b", { newSession: true, mode: "world_builder" });
    assert.ok("proposals" in second);
    assert.deepEqual(second.proposals.map(proposal => proposal.title), ["B-0"], "a full session does not block another one");

    runtime.model.enqueue([{ kind: "tool_calls", calls: [draft("A-20")] }, { kind: "assistant_text", text: "已满。" }]);
    await kernel.creator.send("再来一份", "creator-limit-a2", { sessionId: sessionA });
    assert.equal(kernel.creator.snapshot(undefined, sessionA).proposals.filter(proposal => proposal.title === "A-20").length, 0);
    assert.match(JSON.stringify(runtime.model.requests.at(-1)?.messages), /这个会话最多保留 20 份/);
  } finally { runtime.dispose(); }
});

test("legacy single transcript migrates into one session", () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-creator-legacy-"));
  try {
    const legacy = new AppDatabase(join(directory, "legacy.sqlite"), { maxMigrationVersion: 72 });
    legacy.connection.prepare("INSERT INTO creator_turns(id,text,status,created_at) VALUES('turn-1','旧消息','completed','2026-10-01T00:00:00.000Z')").run();
    legacy.connection.prepare("INSERT INTO creator_messages(role,text,turn_id,created_at) VALUES('user','旧消息','turn-1','2026-10-01T00:00:00.000Z')").run();
    legacy.close();
    const upgraded = new AppDatabase(join(directory, "legacy.sqlite"));
    assert.deepEqual(upgraded.connection.prepare("SELECT id,title FROM creator_sessions").all().map(row => ({ ...row })), [{ id: "creator-session-legacy", title: "早期记录" }]);
    assert.equal(upgraded.connection.prepare("SELECT session_id FROM creator_messages").get()!.session_id, "creator-session-legacy");
    upgraded.close();
    const empty = new AppDatabase(join(directory, "empty.sqlite"));
    assert.equal(empty.connection.prepare("SELECT COUNT(*) AS n FROM creator_sessions").get()!.n, 0, "no placeholder session without history");
    empty.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("creator history is paginated and restart never replays an uncertain mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-creator-test-"));
  let runtime: TestRuntime | undefined;
  try {
    const legacy = new AppDatabase(join(directory, "migration.sqlite"), { maxMigrationVersion: 54 }); legacy.close();
    const upgraded = new AppDatabase(join(directory, "migration.sqlite"));
    assert.equal(upgraded.connection.prepare("SELECT max(version) AS v FROM schema_migrations").get()!.v, 73); upgraded.close();
    runtime = createTestRuntime({ stateDir: directory });
    const proposal = await propose(runtime, { kind: "create_world", input: { name: "中断不能自动重建" } });
    runtime.kernel.database.connection.prepare("UPDATE creator_proposals SET status='applying' WHERE id=?").run(proposal.id);
    for (let i = 0; i < 70; i++) runtime.kernel.database.connection.prepare("INSERT INTO creator_messages(role,text,created_at,session_id) VALUES('user',?,?,?)").run(`历史-${i}`, new Date().toISOString(), proposal.sessionId!);
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

test("model dispatch and tool loops have hard budgets, and a budget stop keeps drafts for review", async () => {
  const runtime = createTestRuntime();
  try {
    runtime.model.enqueue([
      { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: {
        title: "预算内提出的草案", reason: "测试预算", operation: { kind: "create_world", input: { name: "待确认" } },
      } }] },
      ...Array.from({ length: 16 }, () => ({ kind: "tool_calls" as const, calls: [{ name: "creator_overview", arguments: {} }] })),
    ]);
    const result = await runtime.kernel.creator.send("先提出草案然后一直查概览", "creator-budget-request");
    assert.equal(result.status, "partial");
    assert.equal(runtime.model.requests.length, 12, "thirteenth provider dispatch is forbidden, not merely warned about");
    const snapshot = runtime.kernel.creator.snapshot();
    assert.equal(snapshot.proposals[0].status, "pending", "drafts still need explicit review and are not discarded");
    assert.ok(snapshot.messages.some(message => message.role === "system" && message.text.includes("继续")));
    assert.equal(runtime.kernel.listWorlds().length, 0, "nothing is applied without review");
  } finally { runtime.dispose(); }
});

test("unusable final replies are re-asked once, and drafts survive a second unusable reply", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    runtime.model.enqueue([
      { kind: "assistant_text", text: "The user says retry. We need to redo the last request." },
      { kind: "assistant_text", text: "好的，我重新整理了一遍。" },
    ]);
    const recovered = await kernel.creator.send("retry", "creator-reask-request");
    assert.equal(recovered.status, "completed");
    assert.equal(runtime.model.requests.length, 2);
    assert.equal(kernel.creator.snapshot().messages.at(-1)?.text, "好的，我重新整理了一遍。");

    runtime.model.enqueue([
      { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: { title: "友克鑫市", reason: "主舞台", operation: { kind: "create_world", input: { name: "友克鑫" } } } }] },
      { kind: "assistant_text", text: "The user wants places. Let me check." },
      { kind: "assistant_text", text: "" },
    ]);
    const kept = await kernel.creator.send("继续", "creator-fallback-request");
    assert.equal(kept.status, "completed");
    assert.match(kernel.creator.snapshot().messages.at(-1)!.text, /已提出 1 份草案/);
    assert.equal(kernel.creator.snapshot().proposals[0].status, "pending");

    runtime.model.enqueue([{ kind: "assistant_text", text: "" }, { kind: "assistant_text", text: "" }]);
    const failed = await kernel.creator.send("retry", "creator-empty-request");
    assert.equal(failed.status, "failed");
    assert.match(kernel.creator.snapshot().messages.at(-1)!.text, /无可展示的回复/);
  } finally { runtime.dispose(); }
});

test("applying one place draft does not invalidate sibling drafts in the same world", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const world = kernel.createWorld({ name: "猎人世界" });
    const character = kernel.createCharacter({ name: "酷拉皮卡", soulMarkdown: "克制。" });
    runtime.model.enqueue([
      { kind: "tool_calls", calls: [
        { name: "creator_propose", arguments: { title: "友克鑫市", reason: "主舞台", operation: { kind: "create_place", worldId: world.id, input: { name: "友克鑫市" } } } },
        { name: "creator_propose", arguments: { title: "地下拍卖会场", reason: "拍卖", operation: { kind: "create_place", worldId: world.id, input: { name: "地下拍卖会场" } } } },
        { name: "creator_propose", arguments: { title: "酷拉皮卡入住", reason: "归属", operation: { kind: "assign_character", characterId: character.id, worldId: world.id } } },
      ] },
      { kind: "assistant_text", text: "三份草案已准备好。" },
    ]);
    await kernel.creator.send("拍卖篇", "creator-sibling-request");
    const drafts = kernel.creator.snapshot().proposals.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.title.localeCompare(right.title));
    for (const draft of [...drafts].reverse()) assert.equal(kernel.creator.review(draft.id, draft.digest, "apply").status, "applied");
    assert.equal(kernel.worldService.listPlaces(world.id).length, 2);
    assert.equal(kernel.worldService.repository.getMembership(character.id)?.worldId, world.id);
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
