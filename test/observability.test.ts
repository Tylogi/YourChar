import assert from "node:assert/strict";
import test from "node:test";
import type { ContextLogEntry } from "../src/domain/types.js";
import { AppDatabase } from "../src/storage/database.js";
import { ObservabilityRepository } from "../src/storage/observability.js";

test("context logs tolerate legacy truncated event data and keep new event summaries as arrays", () => {
  const database = new AppDatabase(":memory:");
  const repository = new ObservabilityRepository(database);
  try {
    database.connection.prepare(`
      INSERT INTO context_log_summaries(
        id, session_id, mode, request_text, system_prompt_excerpt, message_count_before,
        tool_names_json, reply, actions_json, event_types_json, turn_status, can_retry, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-truncated-events",
      "revision-session",
      "sms",
      "old message",
      "prompt",
      1,
      "[]",
      "old reply",
      "[]",
      JSON.stringify({ truncated: true, preview: "[\"message_update\"" }),
      "completed",
      0,
      "2026-07-19T00:00:00.000Z",
    );

    const repeatedEvents = Array.from(
      { length: 2_000 },
      () => ({ type: "message_update" }),
    ) as ContextLogEntry["events"];
    repository.recordContextLog({
      id: "new-event-summary",
      sessionId: "revision-session",
      mode: "sms",
      requestText: "new message",
      systemPrompt: "prompt",
      messageCountBefore: 2,
      toolNames: [],
      reply: "new reply",
      status: "completed",
      canRetry: false,
      actions: [{
        id: "large-side-effect",
        actionType: "create_schedule_item",
        status: "completed",
        payload: { output: "x".repeat(40_000) },
        createdAt: "2026-07-19T00:01:00.000Z",
      }],
      events: repeatedEvents,
      createdAt: "2026-07-19T00:01:00.000Z",
    });

    const logs = repository.recentContextLogs(10);
    assert.equal(logs.length, 2);
    assert.deepEqual(logs[0].events.map((event) => event.type), ["message_update"]);
    assert.equal(logs[0].actions[0].actionType, "create_schedule_item");
    assert.equal(logs[0].actions[0].status, "completed");
    assert.deepEqual(logs[0].actions[0].payload, { truncated: true });
    assert.deepEqual(logs[1].events, []);

    const row = database.connection.prepare(
      "SELECT event_types_json, actions_json FROM context_log_summaries WHERE id = ?",
    ).get("new-event-summary") as { event_types_json: string; actions_json: string };
    assert.deepEqual(JSON.parse(row.event_types_json), ["message_update"]);
    assert.equal(Array.isArray(JSON.parse(row.actions_json)), true);
  } finally {
    database.close();
  }
});
