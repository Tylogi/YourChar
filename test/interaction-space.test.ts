import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InteractionScope } from "../src/interaction/types.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime } from "../src/testing/index.js";

const normalScope = { conversationSpace: "normal" } as const satisfies InteractionScope;

test("secret SMS tools complete an isolated meeting lifecycle with free-text locations", async () => {
  const runtime = createTestRuntime({ seed: "interaction-secret-tool-flow" });
  try {
    const character = runtime.kernel.createCharacter({ name: "私密见面角色" });
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    runtime.model.enqueue([
      { kind: "tool_call", name: "propose_meeting", arguments: { location: "只有我们知道的屋顶" } },
      { kind: "assistant_text", text: "那就在屋顶见。" },
      { kind: "tool_call", name: "begin_meeting", arguments: {} },
      { kind: "assistant_text", text: "她已经站在屋顶等你。" },
      { kind: "tool_call", name: "end_meeting", arguments: { initiator: "user", summary: "用户离开屋顶" } },
      { kind: "assistant_text", text: "她目送你走下楼梯。" },
    ]);

    const proposed = await runtime.kernel.sendMessage(secret.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "我们在只有我们知道的屋顶见吧。",
    });
    assert.equal(proposed.actions.some((action) => action.actionType === "propose_meeting"), true);
    assert.equal(runtime.kernel.getConversationInteraction(secret.id).state.presence, "meeting_pending");

    const begun = await runtime.kernel.sendMessage(secret.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "我到了。",
    });
    assert.equal(begun.actions.some((action) => action.actionType === "begin_meeting"), true);
    assert.equal(runtime.kernel.getConversationInteraction(secret.id).state.presence, "co_present");

    const ended = await runtime.kernel.sendMessage(secret.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: character.id,
      text: "我先离开了。",
    });
    assert.equal(ended.actions.some((action) => action.actionType === "end_meeting"), true);
    const interaction = runtime.kernel.getConversationInteraction(secret.id);
    assert.equal(interaction.state.presence, "remote");
    assert.deepEqual(
      interaction.events.map((event) => [event.type, event.conversationSpace, event.secretOwnerCharacterId]),
      [
        ["propose_meeting", "secret", character.id],
        ["begin_meeting", "secret", character.id],
        ["end_meeting", "secret", character.id],
      ],
    );

    const secretRequests = runtime.model.requests.slice(-3);
    assert.equal(secretRequests.length, 3);
    for (const request of secretRequests) {
      assert.equal(
        ["propose_meeting", "begin_meeting", "end_meeting"].every((name) =>
          request.toolNames.includes(name)),
        true,
      );
      assert.match(JSON.stringify(request.messages), /conversation_space=\\"secret\\"/u);
    }
    const secretExport = await runtime.kernel.exportUserData("secret", character.id);
    assert.deepEqual(
      secretExport.interactionEvents.map((event) => event.type),
      ["propose_meeting", "begin_meeting", "end_meeting"],
    );
    assert.equal((await runtime.kernel.exportUserData()).interactionEvents.length, 0);
  } finally {
    runtime.dispose();
  }
});

test("normal and secret interaction state are owner-scoped and secret meetings never project World or Scene", () => {
  const runtime = createTestRuntime({ seed: "interaction-secret-core" });
  try {
    const character = runtime.kernel.createCharacter({ name: "双空间角色" });
    const other = runtime.kernel.createCharacter({ name: "其他私密主人" });
    const secretScope = {
      conversationSpace: "secret",
      secretOwnerCharacterId: character.id,
    } as const satisfies InteractionScope;
    const wrongSecretScope = {
      conversationSpace: "secret",
      secretOwnerCharacterId: other.id,
    } as const satisfies InteractionScope;
    const world = runtime.kernel.createWorld({ name: "普通空间世界" });
    const place = runtime.kernel.createWorldPlace({
      worldId: world.id,
      name: "普通空间地点哨兵",
      capabilityIds: ["observe", "communicate"],
    });
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
    runtime.kernel.updateCharacterRuntime(character.id, {
      activity: "普通空间活动哨兵",
      availability: "free",
      expectedUntil: null,
    });

    const normalSessionId = "interaction-space-normal";
    const secretSessionId = "interaction-space-secret";
    runtime.kernel.rpService.ensureRoleSession(normalSessionId, character.id, world.id);
    runtime.kernel.rpService.ensureRoleSession(secretSessionId, character.id);
    runtime.kernel.interactionService.ensure(normalSessionId, character.id, "sms", normalScope);
    runtime.kernel.interactionService.ensure(secretSessionId, character.id, "sms", secretScope);

    assert.throws(() => runtime.kernel.interactionService.proposeMeeting({
      sessionId: secretSessionId,
      characterId: character.id,
      mode: "sms",
      scope: secretScope,
      placeId: place.id,
      source: "user_control",
    }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INTERACTION_LOCATION_INVALID");
      return true;
    });

    runtime.kernel.interactionService.proposeMeeting({
      sessionId: secretSessionId,
      characterId: character.id,
      mode: "sms",
      scope: secretScope,
      location: "私密空间地点哨兵",
      source: "user_control",
    });
    runtime.kernel.interactionService.beginMeeting({
      sessionId: secretSessionId,
      characterId: character.id,
      mode: "sms",
      scope: secretScope,
      source: "user_control",
      userConfirmed: true,
    });

    const runtimeAfterSecretBegin = runtime.kernel.getCharacterLife(character.id).runtime;
    assert.equal(runtimeAfterSecretBegin?.activity, "普通空间活动哨兵");
    assert.equal(runtimeAfterSecretBegin?.availability, "free");
    assert.equal(runtime.kernel.rpService.repository.getScene(secretSessionId), undefined);
    assert.equal(runtime.kernel.interactionService.get(secretSessionId, normalScope), undefined);
    assert.equal(runtime.kernel.interactionService.get(secretSessionId, wrongSecretScope), undefined);
    assert.equal(
      runtime.kernel.interactionService.get(secretSessionId, secretScope)?.location,
      "私密空间地点哨兵",
    );
    assert.deepEqual(
      runtime.kernel.interactionService.listAllEvents(secretSessionId, secretScope)
        .map((event) => [event.conversationSpace, event.secretOwnerCharacterId, event.type]),
      [
        ["secret", character.id, "propose_meeting"],
        ["secret", character.id, "begin_meeting"],
      ],
    );
    assert.match(
      runtime.kernel.interactionService.runtimeContextFor(
        secretSessionId,
        character.id,
        "sms",
        secretScope,
      ),
      /conversation_space="secret"[\s\S]*私密空间地点哨兵/u,
    );

    runtime.kernel.interactionService.proposeMeeting({
      sessionId: normalSessionId,
      characterId: character.id,
      mode: "sms",
      scope: normalScope,
      placeId: place.id,
      source: "user_control",
    });
    runtime.kernel.interactionService.beginMeeting({
      sessionId: normalSessionId,
      characterId: character.id,
      mode: "sms",
      scope: normalScope,
      source: "user_control",
      userConfirmed: true,
    });
    assert.equal(
      runtime.kernel.interactionService.get(normalSessionId, normalScope)?.presence,
      "co_present",
    );
    assert.equal(
      runtime.kernel.interactionService.get(secretSessionId, secretScope)?.presence,
      "co_present",
    );
    assert.equal(runtime.kernel.getCharacterLife(character.id).runtime?.activity, "与用户见面");

    assert.throws(
      () => runtime.kernel.interactionService.ensure(
        secretSessionId,
        character.id,
        "sms",
        normalScope,
      ),
      /another scope or character/u,
    );
    assert.throws(
      () => runtime.kernel.interactionService.ensure(
        "interaction-space-owner-mismatch",
        character.id,
        "sms",
        wrongSecretScope,
      ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "INTERACTION_CONFLICT");
        return true;
      },
    );
  } finally {
    runtime.dispose();
  }
});

test("schema 40 migrates existing interaction rows to normal and survives later schema upgrades", () => {
  const directory = mkdtempSync(join(tmpdir(), "yourchar-interaction-v40-"));
  const path = join(directory, "state.sqlite");
  try {
    const legacy = new AppDatabase(path, { maxMigrationVersion: 39 });
    try {
      const now = "2026-08-20T00:00:00.000Z";
      legacy.connection.prepare(`
        INSERT INTO characters(id, name, created_at, updated_at)
        VALUES ('character-v39', '迁移角色', ?, ?)
      `).run(now, now);
      legacy.connection.prepare(`
        INSERT INTO role_sessions(app_session_id, character_id, created_at, updated_at)
        VALUES ('session-v39', 'character-v39', ?, ?)
      `).run(now, now);
      legacy.connection.prepare(`
        INSERT INTO conversation_interaction_states(
          session_id, character_id, continuity, presence, narrative_lens,
          revision, created_at, updated_at
        ) VALUES (
          'session-v39', 'character-v39', 'canonical', 'meeting_pending',
          'message', 2, ?, ?
        )
      `).run(now, now);
      legacy.connection.prepare(`
        INSERT INTO interaction_transition_events(
          id, session_id, character_id, event_type, source, status, evidence_kind,
          from_presence, to_presence, summary, before_state_json, after_state_json,
          created_at, applied_at
        ) VALUES (
          'event-v39', 'session-v39', 'character-v39', 'propose_meeting',
          'user_control', 'applied', 'ui_confirmation', 'remote', 'meeting_pending',
          'legacy event', '{}', '{}', ?, ?
        )
      `).run(now, now);
    } finally {
      legacy.close();
    }

    const migrated = new AppDatabase(path);
    try {
      assert.equal(
        Number((migrated.connection.prepare(
          "SELECT MAX(version) AS version FROM schema_migrations",
        ).get() as { version: number }).version),
        71,
      );
      const state = migrated.connection.prepare(`
        SELECT conversation_space, secret_owner_character_id
        FROM conversation_interaction_states WHERE session_id = 'session-v39'
      `).get() as Record<string, unknown>;
      assert.equal(state.conversation_space, "normal");
      assert.equal(state.secret_owner_character_id, null);
      const event = migrated.connection.prepare(`
        SELECT conversation_space, secret_owner_character_id
        FROM interaction_transition_events WHERE id = 'event-v39'
      `).get() as Record<string, unknown>;
      assert.equal(event.conversation_space, "normal");
      assert.equal(event.secret_owner_character_id, null);
      assert.deepEqual(
        migrated.connection.prepare(
          "PRAGMA index_info(conversation_interaction_single_meeting_idx)",
        ).all().map((entry) => String((entry as Record<string, unknown>).name)),
        ["conversation_space", "character_id"],
      );

      const now = "2026-08-20T00:01:00.000Z";
      migrated.connection.prepare(`
        INSERT INTO role_sessions(app_session_id, character_id, created_at, updated_at)
        VALUES ('session-secret-null-owner', 'character-v39', ?, ?)
      `).run(now, now);
      assert.throws(() => migrated.connection.prepare(`
        INSERT INTO conversation_interaction_states(
          session_id, character_id, continuity, presence, narrative_lens,
          revision, created_at, updated_at, conversation_space,
          secret_owner_character_id
        ) VALUES (
          'session-secret-null-owner', 'character-v39', 'canonical', 'remote',
          'message', 1, ?, ?, 'secret', NULL
        )
      `).run(now, now), /CHECK constraint failed/u);
      assert.throws(() => migrated.connection.prepare(`
        INSERT INTO interaction_transition_events(
          id, session_id, character_id, event_type, source, status, evidence_kind,
          from_presence, to_presence, summary, before_state_json, after_state_json,
          created_at, applied_at, conversation_space, secret_owner_character_id
        ) VALUES (
          'event-secret-null-owner', 'session-v39', 'character-v39',
          'propose_meeting', 'user_control', 'applied', 'ui_confirmation',
          'remote', 'meeting_pending', 'invalid owner', '{}', '{}', ?, ?, 'secret', NULL
        )
      `).run(now, now), /CHECK constraint failed/u);
    } finally {
      migrated.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
