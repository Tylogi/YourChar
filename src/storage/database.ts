import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Migration = {
  version: number;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE schedule_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('event', 'task', 'reminder')),
        title TEXT NOT NULL,
        notes TEXT,
        start_at TEXT,
        end_at TEXT,
        timezone TEXT NOT NULL,
        all_day INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),
        recurrence_rule TEXT,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'completed', 'cancelled')),
        source_session_id TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX schedule_items_start_idx ON schedule_items(start_at);
      CREATE INDEX schedule_items_status_idx ON schedule_items(status);

      CREATE TABLE reminder_occurrences (
        id TEXT PRIMARY KEY,
        schedule_item_id TEXT NOT NULL REFERENCES schedule_items(id) ON DELETE CASCADE,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'processing', 'delivered', 'snoozed', 'cancelled', 'failed')),
        snoozed_from_id TEXT REFERENCES reminder_occurrences(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(schedule_item_id, due_at)
      );

      CREATE INDEX reminder_occurrences_due_idx ON reminder_occurrences(status, due_at);

      CREATE TABLE notification_outbox (
        id TEXT PRIMARY KEY,
        occurrence_id TEXT NOT NULL REFERENCES reminder_occurrences(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(occurrence_id, channel)
      );

      CREATE INDEX notification_outbox_pending_idx
        ON notification_outbox(status, available_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE characters (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        identity TEXT NOT NULL DEFAULT '',
        voice TEXT NOT NULL DEFAULT '',
        narrative_perspective TEXT NOT NULL DEFAULT 'third_person',
        behavior TEXT NOT NULL DEFAULT '',
        relationship_defaults TEXT NOT NULL DEFAULT '',
        boundaries_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE role_sessions (
        app_session_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        world_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        continuity_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX role_sessions_character_idx ON role_sessions(character_id, status);

      CREATE TABLE scene_states (
        role_session_id TEXT PRIMARY KEY REFERENCES role_sessions(app_session_id) ON DELETE CASCADE,
        location TEXT,
        in_world_time TEXT,
        participants_json TEXT NOT NULL DEFAULT '[]',
        current_objective TEXT,
        open_threads_json TEXT NOT NULL DEFAULT '[]',
        summary TEXT NOT NULL DEFAULT '',
        last_tool_call_id TEXT UNIQUE,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE rp_memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN (
          'user_fact', 'preference', 'relationship_event', 'world_fact', 'plot_event', 'boundary'
        )),
        memory_key TEXT,
        content TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        source_session_id TEXT,
        source_message_id TEXT,
        character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        salience REAL NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        validity TEXT NOT NULL CHECK (validity IN ('pending', 'active', 'superseded', 'deleted')),
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
        tags_json TEXT NOT NULL DEFAULT '[]',
        superseded_by_id TEXT REFERENCES rp_memories(id),
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE INDEX rp_memories_character_idx ON rp_memories(character_id, validity, confirmed);
      CREATE INDEX rp_memories_key_idx ON rp_memories(character_id, memory_key, validity);
      CREATE INDEX rp_memories_retrieval_idx ON rp_memories(validity, confirmed, salience DESC, updated_at DESC);

      CREATE VIRTUAL TABLE rp_memories_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tags,
        tokenize = 'unicode61'
      );

      CREATE TABLE pending_real_mutations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'executed', 'rejected')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX pending_real_mutations_session_idx
        ON pending_real_mutations(session_id, action_type, status, updated_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE audit_actions (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX audit_actions_created_idx ON audit_actions(created_at DESC);

      CREATE TABLE context_log_summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        request_text TEXT NOT NULL,
        system_prompt_excerpt TEXT NOT NULL,
        message_count_before INTEGER NOT NULL,
        tool_names_json TEXT NOT NULL,
        reply TEXT NOT NULL,
        actions_json TEXT NOT NULL,
        event_types_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX context_log_summaries_created_idx ON context_log_summaries(created_at DESC);
      CREATE INDEX context_log_summaries_session_idx ON context_log_summaries(session_id, created_at DESC);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE notification_outbox ADD COLUMN delivery_title TEXT;
      ALTER TABLE notification_outbox ADD COLUMN delivery_body TEXT;
      ALTER TABLE notification_outbox ADD COLUMN agent_generated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE notification_outbox ADD COLUMN composed_at TEXT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN ('user', 'reminder_due')),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE agent_module_settings (
        module_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE user_profiles (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        preferred_name TEXT NOT NULL DEFAULT '',
        pronouns TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        locale TEXT NOT NULL DEFAULT 'zh-CN',
        communication_style TEXT NOT NULL DEFAULT '',
        about TEXT NOT NULL DEFAULT '',
        interests_json TEXT NOT NULL DEFAULT '[]',
        goals_json TEXT NOT NULL DEFAULT '[]',
        boundaries_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE context_log_summaries
        ADD COLUMN turn_status TEXT NOT NULL DEFAULT 'completed'
        CHECK (turn_status IN ('completed', 'failed', 'cancelled', 'blocked'));
      ALTER TABLE context_log_summaries
        ADD COLUMN can_retry INTEGER NOT NULL DEFAULT 0 CHECK (can_retry IN (0, 1));
    `,
  },
  {
    version: 8,
    sql: `
      DROP TABLE rp_memories_fts;
      DROP INDEX rp_memories_character_idx;
      DROP INDEX rp_memories_key_idx;
      DROP INDEX rp_memories_retrieval_idx;
      ALTER TABLE rp_memories RENAME TO rp_memories_r2;

      CREATE TABLE rp_memories (
        id TEXT PRIMARY KEY,
        realm TEXT NOT NULL DEFAULT 'legacy' CHECK (realm IN ('reality', 'roleplay', 'legacy')),
        scope TEXT NOT NULL DEFAULT 'quarantine' CHECK (scope IN ('global', 'character', 'quarantine')),
        type TEXT NOT NULL CHECK (type IN (
          'user_fact', 'preference', 'goal', 'person', 'project',
          'relationship_event', 'world_fact', 'plot_event', 'boundary'
        )),
        memory_key TEXT,
        content TEXT NOT NULL,
        normalized_content TEXT NOT NULL,
        source_session_id TEXT,
        source_message_id TEXT,
        character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        salience REAL NOT NULL DEFAULT 0.5 CHECK (salience >= 0 AND salience <= 1),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
        validity TEXT NOT NULL CHECK (validity IN (
          'pending', 'active', 'superseded', 'rejected', 'archived', 'deleted'
        )),
        confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
        confirmation_kind TEXT CHECK (confirmation_kind IN ('explicit_user_authorization', 'trusted_control_plane')),
        confirmed_at TEXT,
        confirmation_evidence_message_id TEXT,
        rejected_at TEXT,
        archived_at TEXT,
        deleted_at TEXT,
        status_reason TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        superseded_by_id TEXT,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        CHECK (
          (realm = 'reality' AND scope = 'global' AND character_id IS NULL AND type IN ('user_fact', 'preference', 'goal', 'person', 'project', 'boundary')) OR
          (realm = 'roleplay' AND scope = 'character' AND character_id IS NOT NULL AND type IN ('relationship_event', 'world_fact', 'plot_event', 'boundary')) OR
          (realm = 'legacy' AND scope = 'quarantine')
        )
      );

      INSERT INTO rp_memories(
        id, realm, scope, type, memory_key, content, normalized_content,
        source_session_id, source_message_id, character_id, salience, confidence,
        validity, confirmed, confirmation_kind, confirmed_at,
        confirmation_evidence_message_id, tags_json, superseded_by_id,
        idempotency_key, created_at, updated_at, last_used_at
      )
      SELECT
        id,
        CASE
          WHEN character_id IS NULL OR type IN ('user_fact', 'preference') THEN 'legacy'
          ELSE 'roleplay'
        END,
        CASE
          WHEN character_id IS NULL OR type IN ('user_fact', 'preference') THEN 'quarantine'
          ELSE 'character'
        END,
        type, memory_key, content, normalized_content, source_session_id,
        source_message_id, character_id, salience, confidence, validity, confirmed,
        CASE WHEN confirmed = 1 THEN 'trusted_control_plane' ELSE NULL END,
        CASE WHEN confirmed = 1 THEN updated_at ELSE NULL END,
        CASE WHEN confirmed = 1 THEN source_message_id ELSE NULL END,
        tags_json, superseded_by_id, idempotency_key, created_at, updated_at, last_used_at
      FROM rp_memories_r2;

      DROP TABLE rp_memories_r2;

      CREATE INDEX rp_memories_character_idx ON rp_memories(realm, character_id, validity, confirmed);
      CREATE INDEX rp_memories_key_idx ON rp_memories(realm, character_id, memory_key, validity);
      CREATE INDEX rp_memories_retrieval_idx ON rp_memories(realm, validity, confirmed, salience DESC, updated_at DESC);

      CREATE VIRTUAL TABLE rp_memories_fts USING fts5(
        memory_id UNINDEXED,
        content,
        tags,
        tokenize = 'unicode61'
      );
      INSERT INTO rp_memories_fts(memory_id, content, tags)
        SELECT id, content, replace(replace(tags_json, '[', ''), ']', '')
        FROM rp_memories
        WHERE validity NOT IN ('rejected', 'archived', 'deleted');

      CREATE TABLE memory_extraction_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source_context_log_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        realm TEXT NOT NULL CHECK (realm IN ('reality', 'roleplay')),
        character_id TEXT,
        trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('explicit', 'durable_signal', 'none')),
        trigger_reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        input_token_estimate INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        result_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_extraction_jobs_work_idx
        ON memory_extraction_jobs(status, available_at, created_at);
      CREATE INDEX memory_extraction_jobs_recent_idx
        ON memory_extraction_jobs(updated_at DESC, id DESC);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE context_economics (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN ('user', 'reminder_due')),
        system_hash TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        message_digests_json TEXT NOT NULL,
        actual_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX context_economics_session_idx
        ON context_economics(session_id, sequence DESC);

      CREATE TABLE memory_context_sessions (
        session_id TEXT PRIMARY KEY,
        bootstrap_completed_at TEXT NOT NULL
      );

      CREATE TABLE memory_context_items (
        session_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        memory_version TEXT NOT NULL,
        injected_at TEXT NOT NULL,
        PRIMARY KEY(session_id, memory_id)
      );
      CREATE INDEX memory_context_items_session_idx
        ON memory_context_items(session_id, injected_at DESC);

      CREATE TABLE memory_retrieval_stats (
        memory_id TEXT PRIMARY KEY,
        hit_count INTEGER NOT NULL DEFAULT 0,
        last_hit_at TEXT
      );
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE memory_vault_writer_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner_id TEXT,
        fence_token INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        process_identity TEXT,
        heartbeat_at TEXT
      );
      INSERT INTO memory_vault_writer_lease(singleton, fence_token) VALUES (1, 0);

      ALTER TABLE memory_extraction_jobs ADD COLUMN owner_id TEXT;
      ALTER TABLE memory_extraction_jobs ADD COLUMN claim_token TEXT;
      ALTER TABLE memory_extraction_jobs ADD COLUMN lease_expires_at TEXT;
      CREATE INDEX memory_extraction_jobs_lease_idx
        ON memory_extraction_jobs(status, lease_expires_at, available_at);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE schedule_items ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'user'
        CHECK (owner_type IN ('user', 'character'));
      ALTER TABLE schedule_items ADD COLUMN character_id TEXT REFERENCES characters(id) ON DELETE CASCADE;
      CREATE INDEX schedule_items_owner_idx
        ON schedule_items(owner_type, character_id, status, start_at);
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE characters ADD COLUMN model_profile_id TEXT;
      CREATE INDEX characters_model_profile_idx ON characters(model_profile_id);
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE group_chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        max_speakers INTEGER NOT NULL DEFAULT 3 CHECK (max_speakers >= 1 AND max_speakers <= 8),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE group_chat_members (
        group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL,
        joined_at TEXT NOT NULL,
        PRIMARY KEY(group_id, character_id),
        UNIQUE(group_id, position)
      );
      CREATE INDEX group_chat_members_character_idx ON group_chat_members(character_id, group_id);

      CREATE TABLE group_chat_turns (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
        model_calls INTEGER NOT NULL DEFAULT 0,
        speaker_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX group_chat_turns_group_idx ON group_chat_turns(group_id, started_at DESC);

      CREATE TABLE group_chat_messages (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES group_chat_turns(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'character', 'system')),
        sender_id TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(group_id, sequence)
      );
      CREATE INDEX group_chat_messages_group_idx ON group_chat_messages(group_id, sequence);

      CREATE TABLE group_chat_decisions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES group_chat_turns(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('speak', 'silent', 'failed')),
        reason_code TEXT NOT NULL,
        model_profile_id TEXT,
        model TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(turn_id, character_id)
      );
    `,
  },
  {
    version: 14,
    sql: `
      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces RENAME TO model_context_traces_legacy;
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN ('user', 'reminder_due', 'group_gate', 'group_reply')),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_context_traces(
        sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      )
      SELECT sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      FROM model_context_traces_legacy;
      DROP TABLE model_context_traces_legacy;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE group_chat_turns ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
      UPDATE group_chat_turns
      SET message_count = (
        SELECT COUNT(*) FROM group_chat_messages
        WHERE group_chat_messages.turn_id = group_chat_turns.id
          AND group_chat_messages.sender_type = 'character'
      );

      ALTER TABLE group_chat_decisions RENAME TO group_chat_decisions_legacy;
      CREATE TABLE group_chat_decisions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES group_chat_turns(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('speak', 'silent', 'failed')),
        reason_code TEXT NOT NULL,
        model_profile_id TEXT,
        model TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO group_chat_decisions(
        id, turn_id, character_id, outcome, reason_code, model_profile_id, model, created_at
      )
      SELECT id, turn_id, character_id, outcome, reason_code, model_profile_id, model, created_at
      FROM group_chat_decisions_legacy;
      DROP TABLE group_chat_decisions_legacy;
      CREATE INDEX group_chat_decisions_turn_idx
        ON group_chat_decisions(turn_id, created_at, id);
    `,
  },
  {
    version: 16,
    sql: `
      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces RENAME TO model_context_traces_legacy;
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN ('user', 'reminder_due', 'group_gate', 'group_reply', 'subagent')),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_context_traces(
        sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      )
      SELECT sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      FROM model_context_traces_legacy;
      DROP TABLE model_context_traces_legacy;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE character_relationship_states (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        trust INTEGER NOT NULL DEFAULT 35 CHECK (trust BETWEEN 0 AND 100),
        closeness INTEGER NOT NULL DEFAULT 20 CHECK (closeness BETWEEN 0 AND 100),
        affection INTEGER NOT NULL DEFAULT 25 CHECK (affection BETWEEN 0 AND 100),
        respect INTEGER NOT NULL DEFAULT 50 CHECK (respect BETWEEN 0 AND 100),
        tension INTEGER NOT NULL DEFAULT 5 CHECK (tension BETWEEN 0 AND 100),
        affect_valence REAL NOT NULL DEFAULT 0 CHECK (affect_valence BETWEEN -1 AND 1),
        affect_arousal REAL NOT NULL DEFAULT 0.2 CHECK (affect_arousal BETWEEN 0 AND 1),
        affect_control REAL NOT NULL DEFAULT 0.8 CHECK (affect_control BETWEEN 0 AND 1),
        affect_labels_json TEXT NOT NULL DEFAULT '[]',
        affect_updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE relationship_events (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        source_session_id TEXT NOT NULL,
        source_context_log_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'support', 'reliability', 'vulnerability', 'shared_success',
          'conflict', 'boundary_violation', 'repair', 'affection'
        )),
        impact TEXT NOT NULL CHECK (impact IN ('minor', 'moderate', 'major')),
        summary TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        delta_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX relationship_events_character_idx
        ON relationship_events(character_id, created_at DESC, id DESC);

      CREATE TABLE relationship_extraction_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        source_context_log_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        trigger_reason TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        input_token_estimate INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        result_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        owner_id TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX relationship_extraction_jobs_work_idx
        ON relationship_extraction_jobs(status, available_at, created_at);
      CREATE INDEX relationship_extraction_jobs_recent_idx
        ON relationship_extraction_jobs(updated_at DESC, id DESC);
      CREATE INDEX relationship_extraction_jobs_lease_idx
        ON relationship_extraction_jobs(status, lease_expires_at, available_at);

      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces RENAME TO model_context_traces_legacy;
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN (
          'user', 'reminder_due', 'group_gate', 'group_reply', 'subagent', 'relationship_extraction'
        )),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_context_traces(
        sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      )
      SELECT sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      FROM model_context_traces_legacy;
      DROP TABLE model_context_traces_legacy;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
  {
    version: 18,
    sql: `
      ALTER TABLE character_relationship_states
        ADD COLUMN bond_facets_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE character_relationship_states
        ADD COLUMN romance_status TEXT NOT NULL DEFAULT 'none'
        CHECK (romance_status IN (
          'none', 'user_interest', 'character_interest', 'mutual_interest',
          'dating', 'committed', 'former_partners'
        ));
      ALTER TABLE character_relationship_states
        ADD COLUMN semantic_updated_at TEXT;

      DROP INDEX relationship_events_character_idx;
      ALTER TABLE relationship_events RENAME TO relationship_events_legacy;
      CREATE TABLE relationship_events (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        source_session_id TEXT NOT NULL,
        source_context_log_id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'support', 'reliability', 'vulnerability', 'shared_success',
          'conflict', 'boundary_violation', 'repair', 'affection',
          'bond_defined', 'confession', 'confession_accepted',
          'confession_rejected', 'relationship_confirmed', 'commitment',
          'jealousy', 'shared_secret', 'breakup', 'reconciliation'
        )),
        impact TEXT NOT NULL CHECK (impact IN ('minor', 'moderate', 'major')),
        summary TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
        delta_json TEXT NOT NULL,
        initiator TEXT CHECK (initiator IN ('user', 'character', 'mutual')),
        bond_facet TEXT CHECK (bond_facet IN (
          'friendship', 'confidant', 'companionship', 'partnership',
          'mentorship', 'rivalry', 'familial'
        )),
        evidence_json TEXT,
        semantic_change_json TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO relationship_events(
        id, character_id, source_session_id, source_context_log_id,
        event_type, impact, summary, confidence, delta_json, created_at
      )
      SELECT
        id, character_id, source_session_id, source_context_log_id,
        event_type, impact, summary, confidence, delta_json, created_at
      FROM relationship_events_legacy;
      DROP TABLE relationship_events_legacy;
      CREATE INDEX relationship_events_character_idx
        ON relationship_events(character_id, created_at DESC, id DESC);
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE role_worlds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        rules_markdown TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE role_places (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        capability_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX role_places_world_idx ON role_places(world_id, name, id);

      CREATE TABLE character_world_memberships (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        home_place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX character_world_memberships_world_idx
        ON character_world_memberships(world_id, character_id);

      CREATE TABLE character_autonomy_policies (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        enabled INTEGER NOT NULL DEFAULT 0,
        proactive_enabled INTEGER NOT NULL DEFAULT 0,
        daily_message_limit INTEGER NOT NULL DEFAULT 1 CHECK (daily_message_limit BETWEEN 0 AND 5),
        quiet_start TEXT NOT NULL DEFAULT '23:00',
        quiet_end TEXT NOT NULL DEFAULT '08:00',
        last_planned_date TEXT,
        last_proactive_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE character_runtime_states (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        activity TEXT NOT NULL DEFAULT '自由活动',
        availability TEXT NOT NULL DEFAULT 'free'
          CHECK (availability IN ('free', 'busy', 'resting', 'traveling')),
        energy INTEGER NOT NULL DEFAULT 70 CHECK (energy BETWEEN 0 AND 100),
        state_since TEXT NOT NULL,
        expected_until TEXT,
        world_revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX character_runtime_states_world_place_idx
        ON character_runtime_states(world_id, place_id, updated_at DESC);

      CREATE TABLE character_activity_plans (
        id TEXT PRIMARY KEY,
        schedule_item_id TEXT NOT NULL UNIQUE REFERENCES schedule_items(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        capability_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.5 CHECK (salience BETWEEN 0 AND 1),
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'settled', 'cancelled')),
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT
      );
      CREATE INDEX character_activity_plans_due_idx
        ON character_activity_plans(status, character_id, updated_at);

      CREATE TABLE world_events (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('activity', 'interaction', 'travel', 'world_change')),
        summary TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.5 CHECK (salience BETWEEN 0 AND 1),
        source TEXT NOT NULL CHECK (source IN ('autonomy', 'agent_tool', 'manual', 'system')),
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX world_events_world_time_idx
        ON world_events(world_id, starts_at DESC, id DESC);

      CREATE TABLE world_event_participants (
        event_id TEXT NOT NULL REFERENCES world_events(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        perspective_summary TEXT,
        PRIMARY KEY(event_id, character_id)
      );
      CREATE INDEX world_event_participants_character_idx
        ON world_event_participants(character_id, event_id);

      CREATE TABLE proactive_messages (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        world_event_id TEXT NOT NULL UNIQUE REFERENCES world_events(id) ON DELETE CASCADE,
        session_id TEXT,
        text TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'delivered', 'skipped', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT
      );
      CREATE INDEX proactive_messages_pending_idx
        ON proactive_messages(status, created_at, id);
      CREATE INDEX proactive_messages_session_idx
        ON proactive_messages(session_id, delivered_at DESC, id DESC);

      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces RENAME TO model_context_traces_legacy;
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN (
          'user', 'reminder_due', 'group_gate', 'group_reply', 'subagent',
          'memory_extraction', 'relationship_extraction',
          'world_planning', 'proactive_message'
        )),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_context_traces(
        sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      )
      SELECT sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      FROM model_context_traces_legacy;
      DROP TABLE model_context_traces_legacy;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE conversation_interaction_states (
        session_id TEXT PRIMARY KEY REFERENCES role_sessions(app_session_id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        continuity TEXT NOT NULL CHECK (continuity IN ('canonical', 'sandbox')),
        presence TEXT NOT NULL CHECK (presence IN ('remote', 'meeting_pending', 'co_present')),
        narrative_lens TEXT NOT NULL CHECK (narrative_lens IN ('message', 'observable_scene', 'close_third')),
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        location_text TEXT,
        meeting_note TEXT,
        pending_event_id TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX conversation_interaction_single_meeting_idx
        ON conversation_interaction_states(character_id)
        WHERE continuity = 'canonical' AND presence = 'co_present';

      CREATE TABLE interaction_transition_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES role_sessions(app_session_id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'propose_meeting', 'begin_meeting', 'end_meeting', 'cancel_meeting', 'undo_transition'
        )),
        source TEXT NOT NULL CHECK (source IN ('agent_tool', 'user_control', 'system')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'reverted', 'cancelled')),
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
          'user_message', 'ui_confirmation', 'character_action', 'system'
        )),
        from_presence TEXT NOT NULL CHECK (from_presence IN ('remote', 'meeting_pending', 'co_present')),
        to_presence TEXT NOT NULL CHECK (to_presence IN ('remote', 'meeting_pending', 'co_present')),
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        location_text TEXT,
        summary TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        reverted_at TEXT
      );
      CREATE INDEX interaction_transition_events_session_idx
        ON interaction_transition_events(session_id, created_at DESC, id DESC);
      CREATE INDEX interaction_transition_events_pending_idx
        ON interaction_transition_events(status, created_at, id);
    `,
  },
  {
    version: 21,
    sql: `
      CREATE TABLE private_message_inbox (
        id TEXT PRIMARY KEY,
        client_message_id TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES role_sessions(app_session_id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        text TEXT NOT NULL,
        timezone TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'cancelled')),
        burst_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(session_id, client_message_id)
      );
      CREATE INDEX private_message_inbox_queue_idx
        ON private_message_inbox(session_id, status, created_at, id);
      CREATE INDEX private_message_inbox_burst_idx
        ON private_message_inbox(burst_id, status);
    `,
  },
  {
    version: 22,
    sql: `
      ALTER TABLE relationship_extraction_jobs
        ADD COLUMN analysis_kinds_json TEXT NOT NULL DEFAULT '["relationship"]';
      ALTER TABLE relationship_extraction_jobs
        ADD COLUMN interaction_presence TEXT CHECK (interaction_presence IN ('co_present'));
      ALTER TABLE relationship_extraction_jobs
        ADD COLUMN interaction_revision INTEGER CHECK (interaction_revision >= 1);
      ALTER TABLE relationship_extraction_jobs
        ADD COLUMN relationship_result_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE relationship_extraction_jobs
        ADD COLUMN interaction_result_count INTEGER NOT NULL DEFAULT 0;
      UPDATE relationship_extraction_jobs
        SET relationship_result_count = result_count;

      DROP INDEX interaction_transition_events_session_idx;
      DROP INDEX interaction_transition_events_pending_idx;
      ALTER TABLE interaction_transition_events RENAME TO interaction_transition_events_legacy;
      CREATE TABLE interaction_transition_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES role_sessions(app_session_id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'propose_meeting', 'begin_meeting', 'end_meeting', 'cancel_meeting', 'undo_transition'
        )),
        source TEXT NOT NULL CHECK (source IN (
          'agent_tool', 'user_control', 'system', 'post_turn_coordinator'
        )),
        status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'reverted', 'cancelled')),
        evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
          'user_message', 'ui_confirmation', 'character_action', 'system', 'post_turn_analysis'
        )),
        from_presence TEXT NOT NULL CHECK (from_presence IN ('remote', 'meeting_pending', 'co_present')),
        to_presence TEXT NOT NULL CHECK (to_presence IN ('remote', 'meeting_pending', 'co_present')),
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        location_text TEXT,
        summary TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        applied_at TEXT,
        reverted_at TEXT
      );
      INSERT INTO interaction_transition_events(
        id, session_id, character_id, event_type, source, status, evidence_kind,
        from_presence, to_presence, place_id, location_text, summary,
        before_state_json, after_state_json, idempotency_key,
        created_at, applied_at, reverted_at
      )
      SELECT
        id, session_id, character_id, event_type, source, status, evidence_kind,
        from_presence, to_presence, place_id, location_text, summary,
        before_state_json, after_state_json, idempotency_key,
        created_at, applied_at, reverted_at
      FROM interaction_transition_events_legacy;
      DROP TABLE interaction_transition_events_legacy;
      CREATE INDEX interaction_transition_events_session_idx
        ON interaction_transition_events(session_id, created_at DESC, id DESC);
      CREATE INDEX interaction_transition_events_pending_idx
        ON interaction_transition_events(status, created_at, id);

      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces RENAME TO model_context_traces_legacy;
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN (
          'user', 'reminder_due', 'group_gate', 'group_reply', 'subagent',
          'memory_extraction', 'relationship_extraction', 'post_turn_analysis',
          'world_planning', 'proactive_message'
        )),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_context_traces(
        sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      )
      SELECT sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      FROM model_context_traces_legacy;
      DROP TABLE model_context_traces_legacy;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
];

export class AppDatabase {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.connection = new DatabaseSync(path);
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.connection.exec("PRAGMA journal_mode = WAL");
    }
    this.migrate();
  }

  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.connection.close();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const rows = this.connection.prepare("SELECT version FROM schema_migrations").all() as Array<{
      version: number;
    }>;
    const applied = new Set(rows.map((row) => Number(row.version)));
    for (const migration of migrations) {
      if (applied.has(migration.version)) {
        continue;
      }
      this.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection
          .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
      });
    }
  }
}
