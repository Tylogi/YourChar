import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { relationshipStateMcpModuleId } from "../src/modules/catalog.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";

async function establishMeeting(runtime: TestRuntime, sessionId: string, characterId: string, location = "湖边咖啡店") {
  runtime.model.enqueue([{ kind: "assistant_text", text: "好。" }]);
  await runtime.kernel.sendMessage(sessionId, {
    mode: "sms",
    characterId,
    text: "聊聊吧。",
  });
  await runtime.kernel.transitionConversationInteraction(sessionId, {
    action: "propose",
    location,
  });
  await runtime.kernel.transitionConversationInteraction(sessionId, {
    action: "begin",
    userConfirmed: true,
  });
}

test("one post-turn analysis applies relationship and high-confidence departure through separate services", async () => {
  let calls = 0;
  const runtime = createTestRuntime({
    seed: "post-turn-combined",
    postTurnAnalyzer: async (input) => {
      calls += 1;
      assert.deepEqual(input.requestedAnalyses, ["relationship", "interaction"]);
      assert.equal(input.interaction?.presenceAtTurnStart, "co_present");
      return {
        relationship: {
          significant: true,
          eventType: "support",
          impact: "minor",
          summary: "用户感谢角色陪伴",
          confidence: 0.95,
          initiator: "user",
        },
        interaction: {
          decision: "end",
          confidence: 0.96,
          initiator: "user",
          reasonCode: "explicit_departure",
          evidence: { user: "我先回家了" },
        },
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "回合后角色" });
    await establishMeeting(runtime, "post-turn-combined", character.id);
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "她把你送到门边，轻声说：\"到家告诉我。\"",
    }]);

    const response = await runtime.kernel.sendMessage("post-turn-combined", {
      mode: "sms",
      characterId: character.id,
      text: "谢谢你陪我，我先回家了。",
    });
    assert.equal(response.status, "completed");
    assert.equal(runtime.kernel.getConversationInteraction("post-turn-combined").state.presence, "co_present");

    await runtime.kernel.postTurnCoordinator.drain();

    assert.equal(calls, 1);
    const interaction = runtime.kernel.getConversationInteraction("post-turn-combined");
    assert.equal(interaction.state.presence, "remote");
    assert.equal(interaction.events.at(-1)?.source, "post_turn_coordinator");
    assert.equal(interaction.events.at(-1)?.evidenceKind, "post_turn_analysis");
    assert.equal(runtime.kernel.getCharacterRelationship(character.id).recentEvents.length, 1);
    const job = runtime.kernel.getPostTurnCoordinatorStatus().recentJobs[0];
    assert.deepEqual(job.analysisKinds, ["relationship", "interaction"]);
    assert.equal(job.relationshipResultCount, 1);
    assert.equal(job.interactionResultCount, 1);
    assert.equal(job.resultCount, 2);
  } finally {
    runtime.dispose();
  }
});

test("temporary movement remains co-present even when post-turn interaction analysis runs", async () => {
  const runtime = createTestRuntime({
    seed: "post-turn-keep",
    postTurnAnalyzer: async () => ({
      relationship: { significant: false, confidence: 0 },
      interaction: {
        decision: "keep",
        confidence: 0.98,
        initiator: "user",
        reasonCode: "temporary_absence",
        evidence: { user: "我去前台拿瓶水，马上回来" },
      },
    }),
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "留场角色" });
    await establishMeeting(runtime, "post-turn-keep", character.id);
    runtime.model.enqueue([{ kind: "assistant_text", text: "她点了点头：\"我在这里等你。\"" }]);
    await runtime.kernel.sendMessage("post-turn-keep", {
      mode: "sms",
      characterId: character.id,
      text: "我去前台拿瓶水，马上回来。",
    });
    await runtime.kernel.postTurnCoordinator.drain();

    assert.equal(runtime.kernel.getConversationInteraction("post-turn-keep").state.presence, "co_present");
    assert.equal(runtime.kernel.getPostTurnCoordinatorStatus().recentJobs[0].interactionResultCount, 0);
  } finally {
    runtime.dispose();
  }
});

test("a delayed post-turn decision cannot end a newer meeting revision", async () => {
  let release!: () => void;
  let started!: () => void;
  const analyzing = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createTestRuntime({
    seed: "post-turn-stale-revision",
    postTurnAnalyzer: async () => {
      started();
      await blocked;
      return {
        relationship: { significant: false, confidence: 0 },
        interaction: {
          decision: "end",
          confidence: 1,
          initiator: "user",
          reasonCode: "explicit_departure",
          evidence: { user: "我先走了" },
        },
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "版本角色" });
    await establishMeeting(runtime, "post-turn-stale-revision", character.id, "旧地点");
    runtime.model.enqueue([{ kind: "assistant_text", text: "她在门边向你挥手。" }]);
    await runtime.kernel.sendMessage("post-turn-stale-revision", {
      mode: "sms",
      characterId: character.id,
      text: "我先走了。",
    });
    await analyzing;

    await runtime.kernel.transitionConversationInteraction("post-turn-stale-revision", {
      action: "end",
      userConfirmed: true,
    });
    await runtime.kernel.transitionConversationInteraction("post-turn-stale-revision", {
      action: "propose",
      location: "新地点",
    });
    await runtime.kernel.transitionConversationInteraction("post-turn-stale-revision", {
      action: "begin",
      userConfirmed: true,
    });
    release();
    await runtime.kernel.postTurnCoordinator.drain();

    const interaction = runtime.kernel.getConversationInteraction("post-turn-stale-revision");
    assert.equal(interaction.state.presence, "co_present");
    assert.equal(interaction.state.location, "新地点");
    assert.equal(interaction.events.filter((event) => event.source === "post_turn_coordinator").length, 0);
  } finally {
    release?.();
    runtime.dispose();
  }
});

test("relationship reset suppresses only that consumer while an in-flight departure can finish", async () => {
  let release!: () => void;
  let started!: () => void;
  const analyzing = new Promise<void>((resolve) => { started = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const runtime = createTestRuntime({
    seed: "post-turn-reset-isolation",
    postTurnAnalyzer: async () => {
      started();
      await blocked;
      return {
        relationship: {
          significant: true,
          eventType: "affection",
          impact: "major",
          summary: "must be fenced by reset",
          confidence: 1,
        },
        interaction: {
          decision: "end",
          confidence: 1,
          initiator: "user",
          reasonCode: "explicit_departure",
          evidence: { user: "我回去了" },
        },
      };
    },
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "隔离角色" });
    await establishMeeting(runtime, "post-turn-reset-isolation", character.id);
    runtime.kernel.setAgentModuleEnabled(relationshipStateMcpModuleId, true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "她送你走到门口。" }]);
    await runtime.kernel.sendMessage("post-turn-reset-isolation", {
      mode: "sms",
      characterId: character.id,
      text: "我回去了。",
    });
    await analyzing;
    runtime.kernel.resetCharacterRelationship(character.id);
    release();
    await runtime.kernel.postTurnCoordinator.drain();

    assert.equal(runtime.kernel.getCharacterRelationship(character.id).recentEvents.length, 0);
    assert.equal(runtime.kernel.getConversationInteraction("post-turn-reset-isolation").state.presence, "remote");
    const job = runtime.kernel.getPostTurnCoordinatorStatus().recentJobs[0];
    assert.deepEqual(job.analysisKinds, ["interaction"]);
    assert.equal(job.relationshipResultCount, 0);
    assert.equal(job.interactionResultCount, 1);
  } finally {
    release?.();
    runtime.dispose();
  }
});

test("schema 21 upgrades coordinator state through schema 26 world conversations", () => {
  const directory = mkdtempSync(join(tmpdir(), "rp-agent-post-turn-migration-"));
  const path = join(directory, "state.sqlite");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE characters(id TEXT PRIMARY KEY);
      CREATE TABLE role_sessions(app_session_id TEXT PRIMARY KEY);
      CREATE TABLE role_worlds(id TEXT PRIMARY KEY);
      CREATE TABLE role_places(id TEXT PRIMARY KEY);
      CREATE TABLE rp_memories(id TEXT PRIMARY KEY);
      CREATE TABLE group_chats(id TEXT PRIMARY KEY);
      CREATE TABLE character_autonomy_policies(
        character_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
        proactive_enabled INTEGER NOT NULL, daily_message_limit INTEGER NOT NULL,
        quiet_start TEXT NOT NULL, quiet_end TEXT NOT NULL,
        last_planned_date TEXT, last_proactive_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE world_events(id TEXT PRIMARY KEY, salience REAL NOT NULL DEFAULT 0);
      CREATE TABLE proactive_messages(
        id TEXT PRIMARY KEY, character_id TEXT NOT NULL, world_event_id TEXT NOT NULL UNIQUE,
        session_id TEXT, text TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        delivered_at TEXT, read_at TEXT
      );
      INSERT INTO characters(id) VALUES ('character');
      INSERT INTO role_sessions(app_session_id) VALUES ('session');
      INSERT INTO group_chats(id) VALUES ('legacy-group');
      CREATE TABLE relationship_extraction_jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        source_context_log_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
        character_id TEXT NOT NULL, mode TEXT NOT NULL, trigger_reason TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        input_token_estimate INTEGER NOT NULL, duration_ms INTEGER,
        result_count INTEGER NOT NULL, last_error TEXT, owner_id TEXT, claim_token TEXT,
        lease_expires_at TEXT, available_at TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE interaction_transition_events (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, character_id TEXT NOT NULL,
        event_type TEXT NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL,
        evidence_kind TEXT NOT NULL, from_presence TEXT NOT NULL, to_presence TEXT NOT NULL,
        place_id TEXT, location_text TEXT, summary TEXT NOT NULL,
        before_state_json TEXT NOT NULL, after_state_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, applied_at TEXT, reverted_at TEXT
      );
      CREATE INDEX interaction_transition_events_session_idx
        ON interaction_transition_events(session_id, created_at DESC, id DESC);
      CREATE INDEX interaction_transition_events_pending_idx
        ON interaction_transition_events(status, created_at, id);
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL, mode TEXT NOT NULL, turn_kind TEXT NOT NULL,
        request_text TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `);
    const migration = legacy.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)");
    for (let version = 1; version <= 21; version += 1) migration.run(version, "2026-01-01T00:00:00.000Z");
    legacy.prepare(`
      INSERT INTO relationship_extraction_jobs(
        id, idempotency_key, source_context_log_id, session_id, character_id, mode,
        trigger_reason, status, attempts, max_attempts, input_token_estimate,
        result_count, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-job", "turn:legacy", "legacy-log", "session", "character", "sms",
      "private_turn_review", "completed", 1, 3, 100, 1,
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    );
    legacy.prepare(`
      INSERT INTO interaction_transition_events(
        id, session_id, character_id, event_type, source, status, evidence_kind,
        from_presence, to_presence, summary, before_state_json, after_state_json, created_at, applied_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-event", "session", "character", "end_meeting", "system", "applied", "system",
      "co_present", "remote", "legacy", "{}", "{}",
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    );
    legacy.prepare(`
      INSERT INTO model_context_traces(id, session_id, mode, turn_kind, request_text, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "legacy-trace", "session", "sms", "relationship_extraction", "hello", "{}",
      "2026-01-01T00:00:00.000Z",
    );
  } finally {
    legacy.close();
  }

  const upgraded = new AppDatabase(path);
  try {
    assert.equal(
      Number((upgraded.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version),
      26,
    );
    assert.equal(
      (upgraded.connection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'user_insight_observations'
      `).get() as { name?: string } | undefined)?.name,
      "user_insight_observations",
    );
    const job = upgraded.connection.prepare(`
      SELECT analysis_kinds_json, relationship_result_count, interaction_result_count
      FROM relationship_extraction_jobs WHERE id = 'legacy-job'
    `).get() as Record<string, unknown>;
    assert.equal(job.analysis_kinds_json, '["relationship"]');
    assert.equal(job.relationship_result_count, 1);
    assert.equal(job.interaction_result_count, 0);
    assert.equal(
      (upgraded.connection.prepare("SELECT source FROM interaction_transition_events WHERE id = 'legacy-event'").get() as { source: string }).source,
      "system",
    );
    assert.equal(
      Number((upgraded.connection.prepare("SELECT COUNT(*) AS count FROM group_chats").get() as { count: number }).count),
      0,
    );
    upgraded.connection.prepare(`
      INSERT INTO model_context_traces(id, session_id, mode, turn_kind, request_text, payload_json, created_at)
      VALUES ('new-trace', 'session', 'sms', 'post_turn_analysis', 'bye', '{}', '2026-01-01T00:00:01.000Z')
    `).run();
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
