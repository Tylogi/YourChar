import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import { createScheduleMcpBridge } from "../src/mcp/index.js";
import { AppDatabase } from "../src/storage/database.js";
import { DataManagementRepository } from "../src/storage/data-management.js";
import type { ImGateway, ImProvider } from "../src/im/index.js";
import type { ActionRecord } from "../src/domain/types.js";

const gateway: ImGateway = {
  configured: true,
  startBinding: async () => { throw new Error("not used"); },
  getBindingSession: async () => { throw new Error("not used"); },
  cancelBindingSession: async () => { throw new Error("not used"); }, disconnect: async () => {},
};

function setup(stateDir: string | false = false) {
  const clock = new VirtualClock("2026-09-09T04:00:00.000Z");
  const kernel = new CompanionKernel({ stateDir, clock, imGateway: gateway,
    startScheduler: false, startWorldCoordinator: false, startPrivateInboxCoordinator: false,
    reminderMessageComposer: false, conversationCheckpointSummarizer: false,
    characterSkillReflector: false, quietHours: false });
  return { kernel, clock };
}

function bind(kernel: CompanionKernel, clock: VirtualClock, provider: ImProvider, contact = true) {
  const repo = kernel.imIntegrations.repository, now = clock.now().toISOString();
  const character = kernel.createCharacter({ name: provider + "-fixture" });
  repo.setCharacterRoute(provider, character.id, now);
  repo.upsertConnection({ provider, gatewayConnectionId: provider + "-connection", bindingGeneration: "generation",
    accountId: "account", ownerId: "owner", connectedAt: now, now });
  if (contact) {
    repo.claimInboundEvent({ event: { provider, eventId: "hello", connectionId: provider + "-connection",
      bindingGeneration: "generation", externalChatId: provider + "-owner-chat", externalUserId: "owner",
      chatType: "direct", text: "hello" }, bindingGeneration: "generation", characterId: character.id, payloadDigest: "hello", now });
    repo.failInboundEvent(provider, "hello", "verified owner fixture", now);
  }
  return character;
}

function remind(kernel: CompanionKernel, clock: VirtualClock, title = "普通吃饭提醒") {
  return kernel.createScheduleItem({ kind: "reminder", title,
    startAt: new Date(clock.now().getTime() + 60_000).toISOString(), timezone: "Asia/Shanghai",
    reminder: { importance: "normal" } });
}

test("normal reminders follow settings and reach all bound IM providers independently", async () => {
  const { kernel, clock } = setup();
  try {
    bind(kernel, clock, "wechat"); bind(kernel, clock, "feishu");
    const item = remind(kernel, clock).item;
    assert.equal(item.reminder?.channelMode, "follow_settings");
    clock.advance(60_000); await kernel.scheduler.tick();
    const records = kernel.listNotificationHistory(item.id);
    assert.deepEqual(records.map(row => row.channel).sort(), ["feishu", "in_app", "wechat"]);
    assert.equal(records.find(row => row.channel === "in_app")?.status, "delivered");
    for (const provider of ["wechat", "feishu"] as const) {
      const [outgoing] = kernel.claimImPendingOutbox({ provider });
      assert.equal(outgoing.externalChatId, provider + "-owner-chat");
      assert.ok(outgoing.notificationOutboxId);
      kernel.acknowledgeImOutbox({ id: outgoing.id, leaseToken: outgoing.leaseToken!, delivered: true });
    }
    clock.advance(1000); await kernel.scheduler.tick();
    assert.ok(kernel.listNotificationHistory(item.id).every(row => row.status === "delivered"));
  } finally { kernel.dispose(); }
});

test("the exact model-selected in_app-only regression cannot override IM settings", async () => {
  const { kernel, clock } = setup();
  const character = bind(kernel, clock, "wechat"); bind(kernel, clock, "feishu");
  const actions: ActionRecord[] = [];
  const bridge = await createScheduleMcpBridge({ scheduleService: kernel.scheduleService, store: kernel.store,
    clock, characterId: character.id, sessionId: "mcp-reminder", actions: () => actions });
  try {
    const tools = await bridge.client.listTools();
    const create = tools.tools.find(tool => tool.name === "create_schedule_item")!;
    assert.doesNotMatch(JSON.stringify(create.inputSchema), /"channels"|"channelMode"/);
    const result = await bridge.client.callTool({ name: "create_schedule_item", arguments: {
      calendar: "user", kind: "reminder", title: "该吃饭啦", timeExpression: "20分钟后",
      reminder: { enabled: true, importance: "normal", leadMinutes: 0, channels: ["in_app"], channelMode: "custom" },
    } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    const item = kernel.listScheduleItems()[0];
    assert.equal(item.reminder?.channelMode, "follow_settings");
    await bridge.client.callTool({ name: "update_schedule_item", arguments: { id: item.id,
      reminder: { importance: "normal", channels: ["in_app"], channelMode: "custom" } } });
    assert.equal(kernel.getScheduleItem(item.id).reminder?.channelMode, "follow_settings");
    clock.advance(20 * 60_000); await kernel.scheduler.tick();
    assert.deepEqual(kernel.listNotificationHistory(item.id).map(row => row.channel).sort(), ["feishu", "in_app", "wechat"]);
  } finally { await bridge.close(); kernel.dispose(); }
});

test("disabling one provider revokes its queued lease without suppressing UI or another provider", async () => {
  const { kernel, clock } = setup();
  try {
    bind(kernel, clock, "wechat"); bind(kernel, clock, "feishu");
    const first = remind(kernel, clock);
    clock.advance(60_000); await kernel.scheduler.tick();
    const wechat = kernel.claimImPendingOutbox({ provider: "wechat" })[0];
    const feishu = kernel.claimImPendingOutbox({ provider: "feishu" })[0];
    kernel.patchImRuntimeSettings({ wechatRemindersEnabled: false });
    assert.throws(() => kernel.authorizeImOutbox(wechat.id, wechat.leaseToken!), /lease/);
    assert.ok(kernel.authorizeImOutbox(feishu.id, feishu.leaseToken!));
    assert.ok(kernel.listNotificationHistory(first.item.id).find(row => row.channel === "wechat")?.suppressedAt);
    assert.equal(kernel.listNotificationHistory(first.item.id).find(row => row.channel === "in_app")?.suppressedAt, undefined);
    assert.equal(kernel.listReminderOccurrences(first.item.id)[0].acknowledgedAt, undefined);
    kernel.acknowledgeImOutbox({ id: feishu.id, leaseToken: feishu.leaseToken!, delivered: true });
    clock.advance(1000); await kernel.scheduler.tick();
    const second = remind(kernel, clock);
    clock.advance(60_000); await kernel.scheduler.tick();
    assert.deepEqual(kernel.listNotificationHistory(second.item.id).map(row => row.channel).sort(), ["feishu", "in_app"]);
    kernel.patchImRuntimeSettings({ wechatRemindersEnabled: true });
    clock.advance(1000); await kernel.scheduler.tick();
    assert.equal(kernel.claimImPendingOutbox({ provider: "wechat" }).length, 0, "re-enabling does not replay old reminders");
  } finally { kernel.dispose(); }
});

test("a platform receipt arriving before preference-off remains delivered", async () => {
  const { kernel, clock } = setup();
  try {
    bind(kernel, clock, "wechat");
    const created = remind(kernel, clock);
    clock.advance(60_000); await kernel.scheduler.tick();
    const outgoing = kernel.claimImPendingOutbox({ provider: "wechat" })[0];
    kernel.acknowledgeImOutbox({ id: outgoing.id, leaseToken: outgoing.leaseToken!, delivered: true });
    kernel.patchImRuntimeSettings({ wechatRemindersEnabled: false });
    const record = kernel.listNotificationHistory(created.item.id).find(row => row.channel === "wechat")!;
    assert.equal(record.status, "delivered"); assert.equal(record.suppressedAt, undefined);
  } finally { kernel.dispose(); }
});

test("explicit UI-only choices survive edits and IM global-off also gates custom channels", async () => {
  const { kernel, clock } = setup();
  try {
    bind(kernel, clock, "wechat");
    const created = remind(kernel, clock);
    kernel.updateScheduleItem(created.item.id, { reminder: { channels: ["in_app"] } });
    kernel.updateScheduleItem(created.item.id, { title: "用户明确选择仅站内" });
    assert.equal(kernel.getScheduleItem(created.item.id).reminder?.channelMode, "custom");
    clock.advance(60_000); await kernel.scheduler.tick();
    assert.deepEqual(kernel.listNotificationHistory(created.item.id).map(row => row.channel), ["in_app"]);
    const second = remind(kernel, clock);
    kernel.updateScheduleItem(second.item.id, { reminder: { channels: ["in_app", "wechat"] } });
    kernel.patchImRuntimeSettings({ wechatRemindersEnabled: false });
    clock.advance(60_000); await kernel.scheduler.tick();
    assert.deepEqual(kernel.listNotificationHistory(second.item.id).map(row => row.channel), ["in_app"]);
  } finally { kernel.dispose(); }
});

test("binding later does not backfill past reminders; a bound but unverified contact remains visible as an error", async () => {
  const { kernel, clock } = setup();
  try {
    const first = remind(kernel, clock);
    clock.advance(60_000); await kernel.scheduler.tick();
    bind(kernel, clock, "wechat", false);
    clock.advance(1000); await kernel.scheduler.tick();
    assert.deepEqual(kernel.listNotificationHistory(first.item.id).map(row => row.channel), ["in_app"]);
    const second = remind(kernel, clock);
    clock.advance(60_000); await kernel.scheduler.tick();
    assert.match(kernel.listNotificationHistory(second.item.id).find(row => row.channel === "wechat")?.lastError ?? "", /本人.*私聊/);
    assert.equal(kernel.listNotificationHistory(second.item.id).find(row => row.channel === "in_app")?.status, "delivered");
  } finally { kernel.dispose(); }
});

test("IM reminder preferences persist independently across restart and reset with user data", () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-im-preferences-"));
  let { kernel } = setup(directory);
  try {
    assert.equal(kernel.getImRuntimeSettings().wechatRemindersEnabled, true);
    assert.equal(kernel.getImRuntimeSettings().feishuRemindersEnabled, true);
    kernel.patchImRuntimeSettings({ wechatRemindersEnabled: false });
    kernel.patchImRuntimeSettings({ wechatTypingEnabled: false });
    assert.equal(kernel.getImRuntimeSettings().feishuRemindersEnabled, true);
    kernel.dispose(); kernel = setup(directory).kernel;
    assert.equal(kernel.getImRuntimeSettings().wechatRemindersEnabled, false);
    assert.equal(kernel.getImRuntimeSettings().wechatTypingEnabled, false);
    new DataManagementRepository(kernel.database).deleteAllUserData();
    assert.equal(kernel.getImRuntimeSettings().wechatRemindersEnabled, true);
    assert.equal(kernel.getImRuntimeSettings().feishuRemindersEnabled, true);
  } finally { kernel.dispose(); rmSync(directory, { recursive: true, force: true }); }
});

test("retrying a failed channel never expands the original fanout to newly bound providers", async () => {
  const { kernel, clock } = setup();
  try {
    bind(kernel, clock, "wechat", false);
    const created = remind(kernel, clock);
    for (const delay of [60_000, 60_000, 120_000]) { clock.advance(delay); await kernel.scheduler.tick(); }
    const failed = kernel.listNotificationHistory(created.item.id).find(row => row.channel === "wechat")!;
    assert.equal(failed.status, "failed");
    bind(kernel, clock, "wechat"); bind(kernel, clock, "feishu");
    kernel.retryNotification(failed.id);
    await kernel.scheduler.tick();
    assert.equal(kernel.claimImPendingOutbox({ provider: "wechat" }).length, 1);
    assert.equal(kernel.claimImPendingOutbox({ provider: "feishu" }).length, 0);
    assert.deepEqual(kernel.listNotificationHistory(created.item.id).map(row => row.channel).sort(), ["in_app", "wechat"]);
  } finally { kernel.dispose(); }
});

test("schema 57 adds default preferences without rewriting historical delivery policies", () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-im-preferences-migration-")), path = join(directory, "state.sqlite");
  try {
    const old = new AppDatabase(path, { maxMigrationVersion: 56 });
    old.connection.exec("UPDATE im_runtime_settings SET wechat_typing_enabled=0");
    old.connection.exec(`INSERT INTO schedule_items(id,kind,title,start_at,timezone,status,created_at,updated_at,reminder_json)
      VALUES('legacy','reminder','legacy','2027-01-01T00:00:00Z','Asia/Shanghai','scheduled','2026-01-01','2026-01-01',NULL)`);
    old.close();
    const current = new AppDatabase(path);
    try {
      const row = current.connection.prepare("SELECT wechat_typing_enabled,wechat_reminders_enabled,feishu_reminders_enabled FROM im_runtime_settings").get()!;
      assert.equal(row.wechat_typing_enabled, 0); assert.equal(row.wechat_reminders_enabled, 1); assert.equal(row.feishu_reminders_enabled, 1);
      assert.equal(current.connection.prepare("SELECT reminder_json FROM schedule_items WHERE id='legacy'").get()!.reminder_json, null);
      assert.deepEqual(current.connection.prepare("PRAGMA foreign_key_check").all(), []);
    } finally { current.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("IM preference HTTP updates require local authorization and supported boolean fields", async () => {
  const { kernel } = setup();
  const server = createHttpServer({ kernel });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const url = origin + "/api/v1/im/settings";
    const untrusted = await fetch(url, { method: "PATCH", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ wechatRemindersEnabled: false }) });
    assert.equal(untrusted.status, 403);
    const bootstrap = await fetch(origin), cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0];
    const patch = (body: unknown) => fetch(url, { method: "PATCH", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(body) });
    for (const body of [{ wechatRemindersEnabled: "false" }, { feishuRemindersEnabled: null }, { recipient: "stranger" }]) assert.equal((await patch(body)).status, 400);
    const response = await patch({ wechatRemindersEnabled: false }); assert.equal(response.status, 200);
    const data = await response.json() as Record<string, unknown>;
    assert.equal(data.wechatRemindersEnabled, false); assert.equal(data.feishuRemindersEnabled, true);
    assert.equal(data.wechatTypingEnabled, true);
    assert.doesNotMatch(JSON.stringify(data), /accountId|ownerId|token|secret/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); kernel.dispose(); }
});
