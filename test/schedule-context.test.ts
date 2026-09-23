import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createScheduleMcpBridge } from "../src/mcp/schedule-server.js";
import type { McpPiBridge } from "../src/mcp/pi-adapter.js";
import type { ActionRecord } from "../src/domain/types.js";
import { createTestRuntime } from "../src/testing/index.js";

type ToolResponse = Awaited<ReturnType<McpPiBridge["client"]["callTool"]>>;
function data<T>(response: ToolResponse): T {
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  const text = (response.content as Array<{ type: string; text: string }>).map(part => part.text).join("\n");
  assert.deepEqual(JSON.parse(text), response.structuredContent);
  return response.structuredContent as T;
}
type Page = { items: Array<{ id: string; title: string; notesPreview?: string; truncatedFields: string[] }>;
  total: number; returned: number; hasMore: boolean; nextOffset?: number };
type Batch = { requested: number; created: number; existing: number; failed: number; conflictCount: number;
  failures: Array<{ index: number; title: string; time?: string; error: string }>; conflicts: Array<{ index: number; id: string; warning: string; additionalWarnings: number }> };

test("schedule pages bound large calendars and long text, and retain every result across pages", async () => {
  const runtime = createTestRuntime({ seed: "schedule-pages" });
  const character = runtime.kernel.createCharacter({ name: "课表角色" });
  const bridge = await createScheduleMcpBridge({ scheduleService: runtime.kernel.scheduleService,
    store: runtime.kernel.store, clock: runtime.clock, sessionId: "pages", characterId: character.id, actions: () => [] });
  try {
    for (let index = 0; index < 125; index++) runtime.kernel.createScheduleItem({
      kind: "event", title: `Course ${index} ` + '"'.repeat(600), notes: '"'.repeat(12_000) + "PRIVATE_NOTES_TAIL",
      startAt: "2026-09-01T09:00:00.000Z", endAt: "2026-09-01T10:00:00.000Z", timezone: "Asia/Shanghai",
    });
    runtime.kernel.createScheduleItem({ kind: "task", title: "CHARACTER_ONLY", timezone: "Asia/Shanghai",
      ownerType: "character", characterId: character.id });
    const first = data<Page>(await bridge.client.callTool({ name: "list_schedule_items", arguments: {} }));
    assert.equal(first.total, 125);
    assert.ok(first.items.length > 0 && first.items.length <= 20);
    assert.equal(first.nextOffset, first.items.length);
    assert.equal(first.hasMore, true);
    assert.doesNotMatch(JSON.stringify(first), /PRIVATE_NOTES_TAIL|CHARACTER_ONLY/);
    assert.deepEqual(first.items[0].truncatedFields, ["title", "notes"]);
    const ids: string[] = [];
    let offset = 0;
    for (let attempt = 0; attempt < 125; attempt++) {
      const page = data<Page>(await bridge.client.callTool({ name: "list_schedule_items", arguments: { limit: 50, offset } }));
      assert.ok(JSON.stringify(page).length < 21_000);
      assert.equal(page.returned, page.items.length);
      assert.ok(page.returned > 0 && page.returned <= 50);
      ids.push(...page.items.map(item => item.id));
      if (!page.hasMore) { assert.equal(page.nextOffset, undefined); break; }
      assert.equal(page.nextOffset, offset + page.items.length);
      offset = page.nextOffset!;
    }
    assert.deepEqual(ids, runtime.kernel.listScheduleItems({ ownerType: "user" }).map(item => item.id));
    assert.equal(new Set(ids).size, 125);
    const byNotes = data<Page>(await bridge.client.callTool({ name: "list_schedule_items", arguments: {
      query: "PRIVATE_NOTES_TAIL", from: "2026-09-01T17:00:00+08:00", to: "2026-09-01T17:01:00+08:00",
    } }));
    assert.equal(byNotes.total, 125);
    const empty = data<Page>(await bridge.client.callTool({ name: "list_schedule_items", arguments: { from: "2026-09-02T00:00:00Z" } }));
    assert.deepEqual(empty.items, []);
    assert.equal(empty.hasMore, false);
    for (const args of [{ limit: 51 }, { limit: 0 }, { offset: -1 }, { from: "invalid" },
      { from: "2026-09-02T00:00:00Z", to: "2026-09-01T00:00:00Z" }]) {
      assert.equal((await bridge.client.callTool({ name: "list_schedule_items", arguments: args })).isError, true);
    }
    const own = data<Page>(await bridge.client.callTool({ name: "list_schedule_items", arguments: { calendar: "character" } }));
    assert.equal(own.total, 1);
    assert.equal(own.items[0].title, "CHARACTER_ONLY");
  } finally { await bridge.close(); runtime.dispose(); }
});

test("schedule detail text is retrievable in bounded slices and respects calendar ownership", async () => {
  const runtime = createTestRuntime({ seed: "schedule-details" });
  const character = runtime.kernel.createCharacter({ name: "课表角色" });
  const bridge = await createScheduleMcpBridge({ scheduleService: runtime.kernel.scheduleService,
    store: runtime.kernel.store, clock: runtime.clock, sessionId: "details", characterId: character.id, actions: () => [] });
  try {
    const notes = "说明😀\n".repeat(2200) + "END_OF_NOTES";
    const item = runtime.kernel.createScheduleItem({ kind: "task", title: "课程说明", notes, timezone: "Asia/Shanghai" }).item;
    let offset = 0;
    let joined = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = data<{ text: string; hasMore: boolean; nextOffset?: number; totalCharacters: number }>(
        await bridge.client.callTool({ name: "get_schedule_item", arguments: { id: item.id, offset, limit: 3072 } }));
      assert.ok(JSON.stringify(result).length < 26_000);
      assert.equal(result.totalCharacters, notes.length);
      assert.doesNotMatch(result.text, /[\uD800-\uDBFF]$/u);
      joined += result.text;
      if (!result.hasMore) break;
      assert.ok(result.nextOffset! > offset);
      offset = result.nextOffset!;
    }
    assert.equal(joined, notes);
    const other = runtime.kernel.createScheduleItem({ kind: "task", title: "private", timezone: "Asia/Shanghai",
      ownerType: "character", characterId: character.id }).item;
    assert.equal((await bridge.client.callTool({ name: "get_schedule_item", arguments: { id: other.id } })).isError, true);
    assert.equal((await bridge.client.callTool({ name: "get_schedule_item", arguments: { id: item.id, calendar: "character" } })).isError, true);
  } finally { await bridge.close(); runtime.dispose(); }
});

test("bulk schedule creation returns a partial-success summary and persists retry keys across restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-schedule-batch-"));
  let runtime = createTestRuntime({ stateDir, seed: "schedule-batch", now: "2026-08-01T00:00:00Z" });
  let actions: ActionRecord[] = [];
  const connect = () => createScheduleMcpBridge({ scheduleService: runtime.kernel.scheduleService,
    store: runtime.kernel.store, clock: runtime.clock, sessionId: "semester", mode: "sms", actions: () => actions });
  let bridge = await connect();
  const items = [
    { kind: "event", title: "数学", notes: "DO_NOT_ECHO_NOTES".repeat(1000), startAt: "2026-09-01T09:00:00Z", endAt: "2026-09-01T10:00:00Z" },
    { kind: "event", title: "物理", startAt: "2026-09-01T09:30:00Z", endAt: "2026-09-01T10:30:00Z" },
    { kind: "reminder", title: "过去的提醒", startAt: "2020-01-01T00:00:00Z" },
    { kind: "event", title: "时间错误", startAt: "invalid-time" },
    { kind: "reminder", title: "准备课表", timeExpression: "十分钟后" },
  ];
  try {
    const args = { batchId: "semester-chunk-1", items };
    const result = data<Batch>(await bridge.client.callTool({ name: "create_schedule_items", arguments: args }));
    assert.equal(result.requested, 5);
    assert.equal(result.created, 3);
    assert.equal(result.existing, 0);
    assert.equal(result.failed, 2);
    assert.equal(result.conflictCount, 1);
    assert.deepEqual(result.failures.map(f => f.index), [3, 4]);
    assert.equal(result.failures[1].title, "时间错误");
    assert.equal(result.failures[1].time, "invalid-time");
    assert.equal(result.conflicts[0].index, 2);
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_ECHO_NOTES|"items"|"startAt"/);
    assert.ok(JSON.stringify(result).length < 2000);
    assert.equal(runtime.kernel.listScheduleItems().length, 3);
    assert.equal(runtime.kernel.listReminderOccurrences().length, 1);
    assert.equal(actions.filter(action => action.actionType === "create_schedule_item").length, 3);
    const original = runtime.kernel.listScheduleItems().map(item => [item.id, item.startAt]);
    await bridge.close(); runtime.dispose();
    runtime = createTestRuntime({ stateDir, seed: "schedule-batch-restart", now: "2026-08-02T00:00:00Z" });
    actions = []; bridge = await connect();
    const replay = data<Batch>(await bridge.client.callTool({ name: "create_schedule_items", arguments: args }));
    assert.equal(replay.created, 0);
    assert.equal(replay.existing, 3);
    assert.equal(replay.failed, 2);
    assert.equal(replay.conflictCount, 2);
    assert.deepEqual(runtime.kernel.listScheduleItems().map(item => [item.id, item.startAt]), original);
    assert.equal(runtime.kernel.listReminderOccurrences().length, 1);
    assert.ok(actions.some(action => action.actionType === "create_schedule_items" && action.status === "completed"));
    const changed = data<Batch>(await bridge.client.callTool({ name: "create_schedule_items", arguments: {
      ...args, items: [{ ...items[0], title: "试图复用批次改标题" }, ...items.slice(1)],
    } }));
    assert.ok(changed.failures.some(f => f.index === 1 && /batchId/.test(f.error)));
    assert.equal(runtime.kernel.listScheduleItems().length, 3);
    const corrected = data<Batch>(await bridge.client.callTool({ name: "create_schedule_items", arguments: {
      batchId: "semester-corrections", items: [{ kind: "event", title: "改正课程", startAt: "2026-09-02T09:00:00Z" }],
    } }));
    assert.equal(corrected.created, 1);
    assert.equal(runtime.kernel.listScheduleItems().length, 4);
    const tooMany = await bridge.client.callTool({ name: "create_schedule_items", arguments: {
      batchId: "oversized", items: Array.from({ length: 51 }, () => ({ kind: "task", title: "不应写入" })),
    } });
    assert.equal(tooMany.isError, true);
    assert.equal(runtime.kernel.listScheduleItems().length, 4);
  } finally { await bridge.close(); runtime.dispose(); rmSync(stateDir, { recursive: true, force: true }); }
});

test("semester batches reach the model as compact receipts instead of echoing stored records", async () => {
  const runtime = createTestRuntime({ seed: "semester-model-context" });
  try {
    const character = runtime.kernel.createCharacter({ name: "课表角色" });
    const items = Array.from({ length: 120 }, (_, index) => ({
      kind: "event", title: `Lesson ${index}`, startAt: new Date(Date.UTC(2026, 8, 1 + index, 9)).toISOString(),
      notes: "FULL_STORED_CLASS_NOTES".repeat(100),
    }));
    runtime.model.enqueue([
      ...[0, 1, 2].map(page => ({ kind: "tool_call" as const, name: "create_schedule_items",
        arguments: { batchId: `term-page-${page}`, items: items.slice(page * 50, (page + 1) * 50) } })),
      { kind: "assistant_text", text: "已建立 120 节课。" },
    ]);
    const response = await runtime.kernel.sendMessage("semester-context", {
      mode: "sms", characterId: character.id, text: "建立这批课程。",
    });
    assert.equal(response.status, "completed");
    assert.equal(runtime.kernel.listScheduleItems().length, 120);
    assert.equal(runtime.model.requests.length, 4);
    const results = runtime.model.requests[3].messages.filter(message =>
      (message as { role?: string }).role === "toolResult");
    assert.equal(results.length, 3);
    const serialized = JSON.stringify(results);
    assert.ok(serialized.length < 4000);
    assert.match(serialized, /"created":50/);
    assert.match(serialized, /"created":20/);
    assert.doesNotMatch(serialized, /FULL_STORED_CLASS_NOTES|"startAt"/);
  } finally { runtime.dispose(); }
});

test("bulk schedule tools retain RP confirmation and disable turn retry after a committed write", async () => {
  for (const calendar of ["user", "character"] as const) {
    const runtime = createTestRuntime({ seed: `batch-rp-${calendar}` });
    try {
      const character = runtime.kernel.createCharacter({ name: "课表角色" });
      runtime.model.enqueue([
        { kind: "tool_call", name: "create_schedule_items", arguments: {
          calendar, batchId: "role-plan", items: [{ kind: "event", title: "安排课程", startAt: "2026-09-01T09:00:00Z" }],
        } },
        { kind: "assistant_text", text: "她核对了日程安排。" },
      ]);
      const response = await runtime.kernel.sendMessage(`batch-rp-${calendar}`, { mode: "rp", characterId: character.id, text: "安排课程。" });
      assert.equal(runtime.kernel.listScheduleItems().length, calendar === "character" ? 1 : 0);
      assert.equal(response.actions.some(action => action.actionType === "request_real_world_confirmation"), calendar === "user");
    } finally { runtime.dispose(); }
  }
  const runtime = createTestRuntime({ seed: "batch-write-error" });
  try {
    runtime.model.enqueue([
      { kind: "tool_call", name: "create_schedule_items", arguments: {
        batchId: "saved-before-error", items: [{ kind: "task", title: "已保存" }],
      } },
      { kind: "provider_error", message: "temporary outage" },
    ]);
    const response = await runtime.kernel.sendMessage("batch-write-error", { mode: "sms", text: "建立任务。" });
    assert.equal(response.status, "failed");
    assert.equal(response.canRetry, false);
    assert.equal(runtime.kernel.listScheduleItems().length, 1);
  } finally { runtime.dispose(); }
});

test("schedule conflict queries respect adjacent times, point events, status, and calendar ownership", () => {
  const runtime = createTestRuntime({ seed: "schedule-conflicts" });
  try {
    const character = runtime.kernel.createCharacter({ name: "另一份日程" });
    const create = (title: string, startAt: string, endAt?: string) => runtime.kernel.createScheduleItem({
      kind: "event", title, startAt, endAt, timezone: "Asia/Shanghai",
    });
    const first = create("第一节", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z");
    assert.deepEqual(create("第二节", "2026-09-01T10:00:00Z", "2026-09-01T11:00:00Z").warnings, []);
    assert.deepEqual(create("整点事项", "2026-09-01T10:00:00Z").warnings, ["与“第二节”时间重叠"]);
    assert.deepEqual(runtime.kernel.createScheduleItem({
      kind: "event", title: "角色的课", startAt: "2026-09-01T09:00:00Z", endAt: "2026-09-01T10:00:00Z",
      timezone: "Asia/Shanghai", ownerType: "character", characterId: character.id,
    }).warnings, []);
    runtime.kernel.cancelScheduleItem(first.item.id);
    assert.deepEqual(create("取消后安排", "2026-09-01T09:00:00Z").warnings, []);
  } finally { runtime.dispose(); }
});

test("maximal batch receipts remain bounded even with long escaped titles and errors", async () => {
  const runtime = createTestRuntime({ seed: "batch-receipt-limit" });
  const actions: ActionRecord[] = [];
  const bridge = await createScheduleMcpBridge({ scheduleService: runtime.kernel.scheduleService,
    store: runtime.kernel.store, clock: runtime.clock, sessionId: "receipt-limit", actions: () => actions });
  try {
    const title = '"'.repeat(600);
    const failed = data<Batch>(await bridge.client.callTool({ name: "create_schedule_items", arguments: {
      batchId: "invalid-times", items: Array.from({ length: 50 }, () => ({ kind: "event", title, startAt: title })),
    } }));
    assert.equal(failed.failed, 50);
    assert.equal(failed.failures.length, 50);
    assert.ok(JSON.stringify(failed).length < 32_000);
    const conflicts = data<Batch>(await bridge.client.callTool({ name: "create_schedule_items", arguments: {
      batchId: "overlaps", items: Array.from({ length: 50 }, () => ({
        kind: "event", title, startAt: "2026-09-01T09:00:00Z", endAt: "2026-09-01T10:00:00Z",
      })),
    } }));
    assert.equal(conflicts.created, 50);
    assert.equal(conflicts.conflictCount, 49);
    assert.equal(conflicts.conflicts.length, 49);
    assert.equal(conflicts.conflicts.at(-1)?.additionalWarnings, 48);
    assert.ok(JSON.stringify(conflicts).length < 24_000);
  } finally { await bridge.close(); runtime.dispose(); }
});
