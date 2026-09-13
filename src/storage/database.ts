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
  {
    version: 23,
    sql: `
      CREATE TABLE user_insight_observations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL CHECK (source_type IN ('schedule', 'reminder')),
        source_id TEXT NOT NULL,
        source_session_id TEXT,
        observation_kind TEXT NOT NULL CHECK (observation_kind IN (
          'one_off_schedule', 'recurring_schedule', 'completed_schedule', 'reminder_snooze'
        )),
        claim_key TEXT NOT NULL,
        claim_type TEXT NOT NULL CHECK (claim_type IN ('user_fact', 'preference')),
        claim_text TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('low', 'sensitive')),
        decision TEXT NOT NULL CHECK (decision IN (
          'context_only', 'accumulating', 'promoted', 'blocked_sensitive',
          'write_disabled', 'conflicted', 'user_blocked', 'retracted'
        )),
        memory_id TEXT REFERENCES rp_memories(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_type, source_id, observation_kind)
      );
      CREATE INDEX user_insight_observations_claim_idx
        ON user_insight_observations(claim_key, decision, observed_at);
      CREATE INDEX user_insight_observations_recent_idx
        ON user_insight_observations(updated_at DESC, sequence DESC);
    `,
  },
  {
    version: 24,
    sql: `
      ALTER TABLE user_insight_observations RENAME TO user_insight_observations_legacy;
      CREATE TABLE user_insight_observations (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL CHECK (source_type IN ('schedule', 'reminder', 'conversation')),
        source_id TEXT NOT NULL,
        source_session_id TEXT,
        observation_kind TEXT NOT NULL CHECK (observation_kind IN (
          'one_off_schedule', 'recurring_schedule', 'completed_schedule', 'reminder_snooze',
          'conversation_statement'
        )),
        claim_key TEXT NOT NULL,
        claim_type TEXT NOT NULL CHECK (claim_type IN (
          'user_fact', 'preference', 'goal', 'person', 'project', 'boundary'
        )),
        claim_text TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        sensitivity TEXT NOT NULL CHECK (sensitivity IN ('low', 'sensitive')),
        decision TEXT NOT NULL CHECK (decision IN (
          'context_only', 'accumulating', 'promoted', 'blocked_sensitive',
          'write_disabled', 'conflicted', 'user_blocked', 'retracted'
        )),
        memory_id TEXT REFERENCES rp_memories(id) ON DELETE SET NULL,
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_type, source_id, observation_kind)
      );
      INSERT INTO user_insight_observations(
        sequence, id, source_type, source_id, source_session_id, observation_kind,
        claim_key, claim_type, claim_text, evidence_json, confidence,
        sensitivity, decision, memory_id, observed_at, created_at, updated_at
      )
      SELECT
        sequence, id, source_type, source_id, source_session_id, observation_kind,
        claim_key, claim_type, claim_text, evidence_json, confidence,
        sensitivity, decision, memory_id, observed_at, created_at, updated_at
      FROM user_insight_observations_legacy;
      DROP TABLE user_insight_observations_legacy;
      CREATE INDEX user_insight_observations_claim_idx
        ON user_insight_observations(claim_key, decision, observed_at);
      CREATE INDEX user_insight_observations_recent_idx
        ON user_insight_observations(updated_at DESC, sequence DESC);
    `,
  },
  {
    version: 25,
    sql: `
      ALTER TABLE character_autonomy_policies
        ADD COLUMN proactive_cooldown_minutes INTEGER NOT NULL DEFAULT 120
          CHECK (proactive_cooldown_minutes BETWEEN 15 AND 1440);
      ALTER TABLE character_autonomy_policies
        ADD COLUMN proactive_paused_until TEXT;

      ALTER TABLE proactive_messages
        ADD COLUMN topic_key TEXT NOT NULL DEFAULT 'world.general';
      ALTER TABLE proactive_messages
        ADD COLUMN topic_label TEXT NOT NULL DEFAULT '角色近况';
      ALTER TABLE proactive_messages
        ADD COLUMN candidate_score REAL NOT NULL DEFAULT 0
          CHECK (candidate_score BETWEEN 0 AND 1);
      ALTER TABLE proactive_messages
        ADD COLUMN decision_code TEXT NOT NULL DEFAULT 'queued';
      ALTER TABLE proactive_messages
        ADD COLUMN decision_json TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE proactive_messages
        ADD COLUMN last_attempt_at TEXT;
      ALTER TABLE proactive_messages
        ADD COLUMN feedback_type TEXT
          CHECK (feedback_type IN ('helpful', 'less_often', 'mute_topic', 'pause_24h'));
      ALTER TABLE proactive_messages
        ADD COLUMN feedback_at TEXT;

      CREATE TABLE proactive_topic_policies (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        topic_key TEXT NOT NULL,
        topic_label TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'normal'
          CHECK (mode IN ('normal', 'reduced', 'muted')),
        helpful_count INTEGER NOT NULL DEFAULT 0 CHECK (helpful_count >= 0),
        less_often_count INTEGER NOT NULL DEFAULT 0 CHECK (less_often_count >= 0),
        last_feedback_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(character_id, topic_key)
      );
      CREATE INDEX proactive_topic_policies_mode_idx
        ON proactive_topic_policies(character_id, mode, updated_at DESC);

      UPDATE proactive_messages
      SET candidate_score = COALESCE((
        SELECT salience FROM world_events WHERE world_events.id = proactive_messages.world_event_id
      ), 0),
      decision_code = CASE status
        WHEN 'delivered' THEN 'delivered'
        WHEN 'failed' THEN 'model_failed'
        WHEN 'skipped' THEN 'policy_disabled'
        ELSE 'queued'
      END;
    `,
  },
  {
    version: 26,
    sql: `
      ALTER TABLE role_worlds ADD COLUMN director_model_profile_id TEXT;
      ALTER TABLE role_worlds ADD COLUMN analyst_model_profile_id TEXT;

      CREATE TABLE world_conversations (
        world_id TEXT PRIMARY KEY REFERENCES role_worlds(id) ON DELETE CASCADE,
        unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
        last_unread_at TEXT,
        last_read_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE world_conversation_turns (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed', 'cancelled')),
        model_calls INTEGER NOT NULL DEFAULT 0,
        actor_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX world_conversation_turns_world_idx
        ON world_conversation_turns(world_id, started_at DESC, id DESC);

      CREATE TABLE world_conversation_messages (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES world_conversation_turns(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'director', 'character', 'system')),
        sender_id TEXT,
        content TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        UNIQUE(world_id, sequence)
      );
      CREATE INDEX world_conversation_messages_world_idx
        ON world_conversation_messages(world_id, sequence);

      CREATE TABLE world_story_events (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        place_id TEXT REFERENCES role_places(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        objective TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'resolved', 'cancelled')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        ended_at TEXT
      );
      CREATE UNIQUE INDEX world_story_events_open_idx
        ON world_story_events(world_id)
        WHERE status IN ('planned', 'active');
      CREATE INDEX world_story_events_world_idx
        ON world_story_events(world_id, updated_at DESC, id DESC);

      CREATE TABLE world_story_event_participants (
        event_id TEXT NOT NULL REFERENCES world_story_events(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT 'participant',
        PRIMARY KEY(event_id, character_id)
      );

      CREATE TABLE world_story_event_transitions (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES world_story_events(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES world_conversation_turns(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('propose', 'begin', 'resolve', 'cancel', 'undo')),
        source TEXT NOT NULL CHECK (source IN ('world_director', 'world_analyzer', 'user_control', 'system')),
        status TEXT NOT NULL CHECK (status IN ('applied', 'reverted')),
        summary TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reverted_at TEXT
      );
      CREATE INDEX world_story_event_transitions_world_idx
        ON world_story_event_transitions(world_id, created_at DESC, id DESC);

      CREATE TABLE world_character_observations (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES world_story_events(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES world_conversation_turns(id) ON DELETE SET NULL,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        knowledge TEXT NOT NULL CHECK (knowledge IN ('direct', 'heard', 'inferred')),
        summary TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.5 CHECK (salience BETWEEN 0 AND 1),
        created_at TEXT NOT NULL
      );
      CREATE INDEX world_character_observations_character_idx
        ON world_character_observations(character_id, created_at DESC, id DESC);

      CREATE TABLE world_character_relationships (
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        subject_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        object_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        affinity INTEGER NOT NULL DEFAULT 50 CHECK (affinity BETWEEN 0 AND 100),
        trust INTEGER NOT NULL DEFAULT 40 CHECK (trust BETWEEN 0 AND 100),
        tension INTEGER NOT NULL DEFAULT 0 CHECK (tension BETWEEN 0 AND 100),
        intimacy INTEGER NOT NULL DEFAULT 15 CHECK (intimacy BETWEEN 0 AND 100),
        summary TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
        updated_at TEXT NOT NULL,
        PRIMARY KEY(world_id, subject_character_id, object_character_id),
        CHECK (subject_character_id <> object_character_id)
      );

      DELETE FROM group_chats;

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
          'world_planning', 'proactive_message', 'world_director',
          'world_actor', 'world_analysis'
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
    version: 27,
    sql: `
      ALTER TABLE world_story_events
        ADD COLUMN settlement_summary TEXT NOT NULL DEFAULT '';
      ALTER TABLE world_story_events
        ADD COLUMN settled_at TEXT;

      ALTER TABLE world_story_event_transitions
        RENAME TO world_story_event_transitions_v26;
      CREATE TABLE world_story_event_transitions (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES world_story_events(id) ON DELETE SET NULL,
        turn_id TEXT REFERENCES world_conversation_turns(id) ON DELETE SET NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'propose', 'begin', 'advance', 'resolve', 'cancel', 'undo'
        )),
        source TEXT NOT NULL CHECK (source IN (
          'world_director', 'world_analyzer', 'user_control', 'system'
        )),
        status TEXT NOT NULL CHECK (status IN ('applied', 'reverted')),
        summary TEXT NOT NULL,
        before_state_json TEXT NOT NULL,
        after_state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reverted_at TEXT
      );
      INSERT INTO world_story_event_transitions(
        id, world_id, event_id, turn_id, event_type, source, status, summary,
        before_state_json, after_state_json, created_at, reverted_at
      )
      SELECT
        id, world_id, event_id, turn_id, event_type, source, status, summary,
        before_state_json, after_state_json, created_at, reverted_at
      FROM world_story_event_transitions_v26;
      DROP TABLE world_story_event_transitions_v26;
      CREATE INDEX world_story_event_transitions_world_idx
        ON world_story_event_transitions(world_id, created_at DESC, id DESC);
      CREATE INDEX world_character_observations_event_idx
        ON world_character_observations(event_id, character_id, created_at, id);
    `,
  },
  {
    version: 28,
    sql: `
      DROP INDEX context_economics_session_idx;
      ALTER TABLE context_economics RENAME TO context_economics_v27;
      CREATE TABLE context_economics (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN ('user', 'reminder_due', 'world_director')),
        system_hash TEXT NOT NULL,
        metrics_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        message_digests_json TEXT NOT NULL,
        actual_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO context_economics(
        sequence, id, session_id, mode, turn_kind, system_hash, metrics_json,
        plan_json, message_digests_json, actual_json, created_at
      )
      SELECT
        sequence, id, session_id, mode, turn_kind, system_hash, metrics_json,
        plan_json, message_digests_json, actual_json, created_at
      FROM context_economics_v27;
      DROP TABLE context_economics_v27;
      CREATE INDEX context_economics_session_idx
        ON context_economics(session_id, sequence DESC);

      CREATE TABLE world_narrative_contexts (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES world_story_events(id) ON DELETE SET NULL,
        model_profile_id TEXT NOT NULL,
        model_key TEXT NOT NULL,
        model_session_id TEXT NOT NULL,
        system_prompt TEXT NOT NULL,
        stable_prefix_hash TEXT NOT NULL,
        participant_ids_json TEXT NOT NULL DEFAULT '[]',
        start_message_sequence INTEGER NOT NULL CHECK (start_message_sequence >= 0),
        status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
        close_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT
      );
      CREATE UNIQUE INDEX world_narrative_contexts_active_idx
        ON world_narrative_contexts(world_id) WHERE status = 'active';
      CREATE INDEX world_narrative_contexts_event_idx
        ON world_narrative_contexts(event_id, created_at DESC);

      CREATE TABLE world_narrative_prompt_messages (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL REFERENCES world_narrative_contexts(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL REFERENCES world_conversation_turns(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(context_id, sequence)
      );
      CREATE INDEX world_narrative_prompt_messages_context_idx
        ON world_narrative_prompt_messages(context_id, sequence);
    `,
  },
  {
    version: 29,
    sql: `
      ALTER TABLE character_autonomy_policies
        ADD COLUMN social_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (social_enabled IN (0, 1));
      ALTER TABLE character_autonomy_policies
        ADD COLUMN social_daily_limit INTEGER NOT NULL DEFAULT 1
          CHECK (social_daily_limit BETWEEN 0 AND 5);
      ALTER TABLE character_autonomy_policies
        ADD COLUMN social_cooldown_minutes INTEGER NOT NULL DEFAULT 240
          CHECK (social_cooldown_minutes BETWEEN 30 AND 1440);
      ALTER TABLE character_autonomy_policies
        ADD COLUMN last_social_at TEXT;

      CREATE TABLE character_channels (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        first_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        second_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        unread_count INTEGER NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
        last_unread_at TEXT,
        last_read_at TEXT,
        last_message_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(world_id, first_character_id, second_character_id),
        CHECK (first_character_id < second_character_id)
      );
      CREATE INDEX character_channels_world_idx
        ON character_channels(world_id, updated_at DESC, id DESC);
      CREATE INDEX character_channels_first_idx
        ON character_channels(first_character_id, updated_at DESC);
      CREATE INDEX character_channels_second_idx
        ON character_channels(second_character_id, updated_at DESC);

      CREATE TABLE character_channel_episodes (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES character_channels(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('social', 'collaboration', 'contact')),
        source TEXT NOT NULL CHECK (source IN ('autonomy', 'agent_tool', 'manual', 'system')),
        initiator_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        target_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        parent_session_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        objective TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'completed', 'declined', 'failed', 'cancelled')
        ),
        model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
        message_count INTEGER NOT NULL DEFAULT 0 CHECK (message_count >= 0),
        idempotency_key TEXT NOT NULL UNIQUE,
        result_text TEXT,
        failure_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        CHECK (initiator_character_id <> target_character_id)
      );
      CREATE INDEX character_channel_episodes_channel_idx
        ON character_channel_episodes(channel_id, created_at DESC, id DESC);
      CREATE INDEX character_channel_episodes_world_idx
        ON character_channel_episodes(world_id, created_at DESC, id DESC);
      CREATE INDEX character_channel_episodes_initiator_idx
        ON character_channel_episodes(initiator_character_id, created_at DESC);

      CREATE TABLE character_channel_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES character_channels(id) ON DELETE CASCADE,
        episode_id TEXT NOT NULL REFERENCES character_channel_episodes(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        sender_type TEXT NOT NULL CHECK (sender_type IN ('character', 'system')),
        sender_character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'task', 'result', 'status')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(channel_id, sequence),
        CHECK (
          (sender_type = 'character' AND sender_character_id IS NOT NULL) OR
          (sender_type = 'system' AND sender_character_id IS NULL)
        )
      );
      CREATE INDEX character_channel_messages_channel_idx
        ON character_channel_messages(channel_id, sequence DESC);
      CREATE INDEX character_channel_messages_episode_idx
        ON character_channel_messages(episode_id, sequence);
    `,
  },
  {
    version: 30,
    sql: `
      CREATE TABLE character_function_profiles (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        public_role TEXT NOT NULL DEFAULT '',
        task_preferences TEXT NOT NULL DEFAULT '',
        avoided_tasks TEXT NOT NULL DEFAULT '',
        max_concurrent_tasks INTEGER NOT NULL DEFAULT 1
          CHECK (max_concurrent_tasks BETWEEN 1 AND 5),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE character_capabilities (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        capability_id TEXT NOT NULL CHECK (capability_id IN (
          'research.web',
          'research.analysis',
          'software.debug',
          'software.implementation',
          'planning.schedule',
          'organization.coordination',
          'communication.social',
          'creative.writing',
          'creative.visual',
          'world.knowledge'
        )),
        level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
        responsibility TEXT NOT NULL CHECK (responsibility IN ('primary', 'support')),
        auto_accept INTEGER NOT NULL DEFAULT 0 CHECK (auto_accept IN (0, 1)),
        module_ids_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(character_id, capability_id)
      );
      CREATE INDEX character_capabilities_capability_idx
        ON character_capabilities(capability_id, auto_accept, level DESC);

      CREATE TABLE character_capability_evidence (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        capability_id TEXT NOT NULL CHECK (capability_id IN (
          'research.web',
          'research.analysis',
          'software.debug',
          'software.implementation',
          'planning.schedule',
          'organization.coordination',
          'communication.social',
          'creative.writing',
          'creative.visual',
          'world.knowledge'
        )),
        source_task_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'declined', 'failed', 'cancelled')),
        functional_score REAL CHECK (
          functional_score IS NULL OR (functional_score >= 0 AND functional_score <= 100)
        ),
        judge_score REAL CHECK (
          judge_score IS NULL OR (judge_score >= 0 AND judge_score <= 100)
        ),
        summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(source_task_id, capability_id)
      );
      CREATE INDEX character_capability_evidence_character_idx
        ON character_capability_evidence(character_id, created_at DESC, id DESC);
      CREATE INDEX character_capability_evidence_capability_idx
        ON character_capability_evidence(capability_id, outcome, created_at DESC);
    `,
  },
  {
    version: 31,
    sql: `
      ALTER TABLE character_function_profiles
        ADD COLUMN manual_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_locked IN (0, 1));
      ALTER TABLE character_function_profiles
        ADD COLUMN inference_status TEXT NOT NULL DEFAULT 'uninitialized'
          CHECK (inference_status IN ('uninitialized', 'pending', 'ready', 'failed'));
      ALTER TABLE character_function_profiles
        ADD COLUMN source_soul_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE character_function_profiles
        ADD COLUMN inference_error TEXT NOT NULL DEFAULT '';
      ALTER TABLE character_function_profiles
        ADD COLUMN inference_started_at TEXT;
      ALTER TABLE character_function_profiles
        ADD COLUMN inferred_at TEXT;

      ALTER TABLE character_capabilities
        ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
          CHECK (source IN ('inferred', 'manual'));
      ALTER TABLE character_capabilities
        ADD COLUMN confidence REAL NOT NULL DEFAULT 1
          CHECK (confidence >= 0 AND confidence <= 1);

      ALTER TABLE character_capability_evidence
        ADD COLUMN lesson TEXT NOT NULL DEFAULT '';

      CREATE TABLE character_skill_versions (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected')),
        markdown TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('bootstrap', 'character_reflection', 'manual')),
        source_task_id TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        superseded_at TEXT,
        UNIQUE(character_id, version),
        UNIQUE(character_id, source_task_id)
      );
      CREATE UNIQUE INDEX character_skill_versions_active_idx
        ON character_skill_versions(character_id)
        WHERE status = 'active';
      CREATE INDEX character_skill_versions_history_idx
        ON character_skill_versions(character_id, version DESC);

      UPDATE character_function_profiles
      SET
        manual_locked = 1,
        inference_status = 'ready'
      WHERE
        public_role <> '' OR task_preferences <> '' OR avoided_tasks <> '' OR
        EXISTS (
          SELECT 1 FROM character_capabilities
          WHERE character_capabilities.character_id = character_function_profiles.character_id
        );

      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces RENAME TO model_context_traces_v30;
      CREATE TABLE model_context_traces (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        turn_kind TEXT NOT NULL CHECK (turn_kind IN (
          'user', 'reminder_due', 'group_gate', 'group_reply', 'subagent',
          'memory_extraction', 'relationship_extraction', 'post_turn_analysis',
          'world_planning', 'proactive_message', 'world_director',
          'world_actor', 'world_analysis', 'character_function_inference',
          'character_skill_reflection'
        )),
        request_text TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_context_traces(
        sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      )
      SELECT sequence, id, session_id, mode, turn_kind, request_text, payload_json, created_at
      FROM model_context_traces_v30;
      DROP TABLE model_context_traces_v30;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);
    `,
  },
  {
    version: 32,
    sql: `
      CREATE TABLE meeting_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('sillytavern_openai')),
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX meeting_presets_updated_idx
        ON meeting_presets(updated_at DESC, name, id);

      ALTER TABLE characters
        ADD COLUMN meeting_preset_id TEXT
        REFERENCES meeting_presets(id) ON DELETE SET NULL;
      CREATE INDEX characters_meeting_preset_idx
        ON characters(meeting_preset_id);
    `,
  },
  {
    version: 33,
    sql: `
      CREATE INDEX character_channel_episodes_parent_session_idx
        ON character_channel_episodes(
          parent_session_id, initiator_character_id, created_at DESC, id DESC
        )
        WHERE parent_session_id IS NOT NULL AND kind = 'collaboration';
    `,
  },
  {
    version: 34,
    sql: `
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_status TEXT
          CHECK (report_status IN ('pending', 'delivering', 'delivered', 'skipped', 'failed'));
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_attempts INTEGER NOT NULL DEFAULT 0
          CHECK (report_attempts >= 0);
      ALTER TABLE character_channel_episodes
        ADD COLUMN reported_at TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_error TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_owner_id TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_claim_token TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_lease_expires_at TEXT;

      CREATE TABLE character_collaboration_jobs (
        episode_id TEXT PRIMARY KEY
          REFERENCES character_channel_episodes(id) ON DELETE CASCADE,
        opening_message TEXT NOT NULL,
        routing_json TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
        last_error TEXT,
        owner_id TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        available_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX character_collaboration_jobs_runnable_idx
        ON character_collaboration_jobs(status, available_at, lease_expires_at, created_at);
      CREATE INDEX character_channel_episodes_report_idx
        ON character_channel_episodes(report_status, report_lease_expires_at, updated_at)
        WHERE report_status IN ('pending', 'delivering');
    `,
  },
  {
    version: 35,
    sql: `
      ALTER TABLE character_channel_episodes
        ADD COLUMN started_at TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN target_execution_ms INTEGER NOT NULL DEFAULT 0
          CHECK (target_execution_ms >= 0);
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_queued_at TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_started_at TEXT;
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_wait_ms INTEGER NOT NULL DEFAULT 0
          CHECK (report_wait_ms >= 0);
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_generation_ms INTEGER NOT NULL DEFAULT 0
          CHECK (report_generation_ms >= 0);
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_delivery_ms INTEGER NOT NULL DEFAULT 0
          CHECK (report_delivery_ms >= 0);
      ALTER TABLE character_channel_episodes
        ADD COLUMN report_model_calls INTEGER NOT NULL DEFAULT 0
          CHECK (report_model_calls >= 0);

      UPDATE character_channel_episodes
      SET report_queued_at = completed_at
      WHERE completed_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM character_collaboration_jobs
          WHERE episode_id = character_channel_episodes.id
        );
      UPDATE character_channel_episodes
      SET report_started_at = reported_at
      WHERE reported_at IS NOT NULL;
    `,
  },
  {
    version: 36,
    sql: `
      CREATE TABLE agent_skill_space_settings (
        module_id TEXT PRIMARY KEY,
        normal_enabled INTEGER NOT NULL DEFAULT 0 CHECK (normal_enabled IN (0, 1)),
        secret_enabled INTEGER NOT NULL DEFAULT 0 CHECK (secret_enabled IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      INSERT INTO agent_skill_space_settings(
        module_id, normal_enabled, secret_enabled, updated_at
      )
      SELECT module_id, enabled, 0, updated_at
      FROM agent_module_settings
      WHERE module_id LIKE 'skill:%';
    `,
  },
  {
    version: 37,
    sql: `
      ALTER TABLE rp_memories
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE rp_memories
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      UPDATE rp_memories
      SET idempotency_key = 'v37:normal:' || idempotency_key
      WHERE idempotency_key IS NOT NULL;

      DROP INDEX rp_memories_character_idx;
      DROP INDEX rp_memories_key_idx;
      DROP INDEX rp_memories_retrieval_idx;
      CREATE INDEX rp_memories_character_idx
        ON rp_memories(
          conversation_space, secret_owner_character_id, realm,
          character_id, validity, confirmed
        );
      CREATE INDEX rp_memories_key_idx
        ON rp_memories(
          conversation_space, secret_owner_character_id, realm,
          character_id, memory_key, validity
        );
      CREATE INDEX rp_memories_retrieval_idx
        ON rp_memories(
          conversation_space, secret_owner_character_id, realm,
          validity, confirmed, salience DESC, updated_at DESC
        );

      DROP TABLE rp_memories_fts;
      CREATE VIRTUAL TABLE rp_memories_fts USING fts5(
        memory_id UNINDEXED,
        conversation_space UNINDEXED,
        secret_owner_character_id UNINDEXED,
        content,
        tags,
        tokenize = 'unicode61'
      );
      INSERT INTO rp_memories_fts(
        memory_id, conversation_space, secret_owner_character_id, content, tags
      )
      SELECT
        id, conversation_space, secret_owner_character_id,
        content, replace(replace(tags_json, '[', ''), ']', '')
      FROM rp_memories
      WHERE validity NOT IN ('rejected', 'archived', 'deleted');

      ALTER TABLE memory_extraction_jobs
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE memory_extraction_jobs
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      DROP INDEX memory_extraction_jobs_work_idx;
      DROP INDEX memory_extraction_jobs_recent_idx;
      DROP INDEX memory_extraction_jobs_lease_idx;
      CREATE INDEX memory_extraction_jobs_work_idx
        ON memory_extraction_jobs(
          conversation_space, secret_owner_character_id, status, available_at, created_at
        );
      CREATE INDEX memory_extraction_jobs_recent_idx
        ON memory_extraction_jobs(
          conversation_space, secret_owner_character_id, updated_at DESC, id DESC
        );
      CREATE INDEX memory_extraction_jobs_lease_idx
        ON memory_extraction_jobs(
          conversation_space, secret_owner_character_id, status, lease_expires_at, available_at
        );

      ALTER TABLE context_economics
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE context_economics
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      DROP INDEX context_economics_session_idx;
      CREATE INDEX context_economics_session_idx
        ON context_economics(
          conversation_space, secret_owner_character_id, session_id, sequence DESC
        );

      ALTER TABLE memory_context_sessions
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE memory_context_sessions
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      ALTER TABLE memory_context_items
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE memory_context_items
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      DROP INDEX memory_context_items_session_idx;
      CREATE INDEX memory_context_items_session_idx
        ON memory_context_items(
          conversation_space, secret_owner_character_id, session_id, injected_at DESC
        );

      ALTER TABLE context_log_summaries
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE context_log_summaries
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      DROP INDEX context_log_summaries_created_idx;
      DROP INDEX context_log_summaries_session_idx;
      CREATE INDEX context_log_summaries_created_idx
        ON context_log_summaries(
          conversation_space, secret_owner_character_id, created_at DESC, id DESC
        );
      CREATE INDEX context_log_summaries_session_idx
        ON context_log_summaries(
          conversation_space, secret_owner_character_id, session_id, created_at DESC
        );

      ALTER TABLE model_context_traces
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE model_context_traces
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL)
          );
      DROP INDEX model_context_traces_session_idx;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(
          conversation_space, secret_owner_character_id, session_id, sequence DESC
        );
    `,
  },
  {
    version: 38,
    sql: `
      DROP INDEX character_skill_versions_active_idx;
      DROP INDEX character_skill_versions_history_idx;
      ALTER TABLE character_skill_versions RENAME TO character_skill_versions_v37;

      CREATE TABLE character_skill_versions (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        conversation_space TEXT NOT NULL
          CHECK (conversation_space IN ('normal', 'secret')),
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'rejected')),
        markdown TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (source IN ('bootstrap', 'character_reflection', 'manual')),
        source_task_id TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        superseded_at TEXT,
        UNIQUE(character_id, conversation_space, version),
        UNIQUE(character_id, conversation_space, source_task_id)
      );

      INSERT INTO character_skill_versions(
        id, character_id, conversation_space, version, status, markdown,
        change_summary, source, source_task_id, content_hash, created_at,
        activated_at, superseded_at
      )
      SELECT
        id, character_id, 'normal', version, status, markdown,
        change_summary, source, source_task_id, content_hash, created_at,
        activated_at, superseded_at
      FROM character_skill_versions_v37;

      DROP TABLE character_skill_versions_v37;
      CREATE UNIQUE INDEX character_skill_versions_active_idx
        ON character_skill_versions(character_id, conversation_space)
        WHERE status = 'active';
      CREATE INDEX character_skill_versions_history_idx
        ON character_skill_versions(character_id, conversation_space, version DESC);
    `,
  },
  {
    version: 39,
    sql: `
      CREATE TABLE im_character_routes (
        provider TEXT PRIMARY KEY CHECK (provider IN ('feishu', 'wechat')),
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX im_character_routes_character_idx
        ON im_character_routes(character_id, provider);

      CREATE TABLE im_bindings (
        provider TEXT PRIMARY KEY CHECK (provider IN ('feishu', 'wechat')),
        gateway_connection_id TEXT NOT NULL,
        binding_generation TEXT NOT NULL,
        account_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        display_name TEXT,
        domain TEXT CHECK (
          (provider = 'feishu' AND (domain IS NULL OR domain IN ('feishu', 'lark'))) OR
          (provider = 'wechat' AND domain IS NULL)
        ),
        connected_at TEXT NOT NULL,
        last_seen_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX im_bindings_provider_connection_idx
        ON im_bindings(provider, gateway_connection_id);

      CREATE TABLE im_binding_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('feishu', 'wechat')),
        status TEXT NOT NULL CHECK (status IN (
          'waiting_scan', 'scanned', 'connected', 'expired', 'cancelled', 'failed'
        )),
        domain TEXT CHECK (
          (provider = 'feishu' AND (domain IS NULL OR domain IN ('feishu', 'lark'))) OR
          (provider = 'wechat' AND domain IS NULL)
        ),
        gateway_connection_id TEXT,
        expires_at TEXT,
        message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX im_binding_sessions_provider_idx
        ON im_binding_sessions(provider, updated_at DESC, id DESC);

      CREATE TABLE im_inbound_events (
        provider TEXT NOT NULL CHECK (provider IN ('feishu', 'wechat')),
        event_id TEXT NOT NULL,
        gateway_connection_id TEXT NOT NULL,
        binding_generation TEXT NOT NULL,
        character_id TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        external_user_id TEXT NOT NULL,
        chat_type TEXT NOT NULL CHECK (chat_type IN ('direct', 'group')),
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
        reply_text TEXT,
        last_error TEXT,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        received_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (provider, event_id)
      );
      CREATE INDEX im_inbound_events_status_idx
        ON im_inbound_events(status, updated_at DESC);
      CREATE INDEX im_inbound_events_connection_idx
        ON im_inbound_events(
          provider, gateway_connection_id, binding_generation, created_at DESC
        );
      CREATE INDEX im_inbound_events_character_idx
        ON im_inbound_events(character_id, created_at DESC);

      CREATE TABLE im_outbox (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('feishu', 'wechat')),
        gateway_connection_id TEXT NOT NULL,
        binding_generation TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        inbound_event_id TEXT NOT NULL,
        text TEXT NOT NULL,
        attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        lease_token TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE (provider, inbound_event_id),
        FOREIGN KEY (provider, inbound_event_id)
          REFERENCES im_inbound_events(provider, event_id) ON DELETE CASCADE
      );
      CREATE INDEX im_outbox_pending_idx
        ON im_outbox(
          provider, gateway_connection_id, binding_generation, status, available_at,
          lease_expires_at, created_at, id
        );

      CREATE TABLE im_runtime_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        wechat_typing_enabled INTEGER NOT NULL DEFAULT 1
          CHECK (wechat_typing_enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO im_runtime_settings(
        singleton, wechat_typing_enabled, created_at, updated_at
      ) VALUES (
        1, 1,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    `,
  },
  {
    version: 40,
    sql: `
      ALTER TABLE conversation_interaction_states
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE conversation_interaction_states
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL
              AND secret_owner_character_id = character_id)
          );

      DROP INDEX conversation_interaction_single_meeting_idx;
      CREATE UNIQUE INDEX conversation_interaction_single_meeting_idx
        ON conversation_interaction_states(conversation_space, character_id)
        WHERE continuity = 'canonical' AND presence = 'co_present';
      CREATE INDEX conversation_interaction_scope_idx
        ON conversation_interaction_states(
          conversation_space, secret_owner_character_id, session_id
        );

      ALTER TABLE interaction_transition_events
        ADD COLUMN conversation_space TEXT NOT NULL DEFAULT 'normal'
          CHECK (conversation_space IN ('normal', 'secret'));
      ALTER TABLE interaction_transition_events
        ADD COLUMN secret_owner_character_id TEXT
          REFERENCES characters(id) ON DELETE CASCADE
          CHECK (
            (conversation_space = 'normal' AND secret_owner_character_id IS NULL) OR
            (conversation_space = 'secret' AND secret_owner_character_id IS NOT NULL
              AND secret_owner_character_id = character_id)
          );

      DROP INDEX interaction_transition_events_session_idx;
      CREATE INDEX interaction_transition_events_session_idx
        ON interaction_transition_events(
          conversation_space, secret_owner_character_id,
          session_id, created_at DESC, id DESC
      );
    `,
  },
  {
    version: 41,
    sql: `
      CREATE TABLE character_owned_skill_packages (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        conversation_space TEXT NOT NULL
          CHECK (conversation_space IN ('normal', 'secret')),
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        capability_ids_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'disabled')),
        auto_improve INTEGER NOT NULL DEFAULT 1 CHECK (auto_improve IN (0, 1)),
        created_by TEXT NOT NULL CHECK (created_by IN ('user', 'character', 'migration')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(character_id, conversation_space, slug),
        UNIQUE(id, character_id, conversation_space)
      );
      CREATE INDEX character_owned_skill_packages_owner_idx
        ON character_owned_skill_packages(
          character_id, conversation_space, status, updated_at DESC, id
        );

      CREATE TABLE character_owned_skill_versions (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        conversation_space TEXT NOT NULL
          CHECK (conversation_space IN ('normal', 'secret')),
        version INTEGER NOT NULL CHECK (version >= 1),
        status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'rejected')),
        markdown TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL CHECK (
          source IN ('manual', 'character_created', 'character_reflection', 'legacy_migration')
        ),
        source_task_id TEXT,
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT,
        superseded_at TEXT,
        UNIQUE(package_id, version),
        UNIQUE(package_id, source_task_id),
        UNIQUE(id, package_id, character_id, conversation_space),
        FOREIGN KEY (package_id, character_id, conversation_space)
          REFERENCES character_owned_skill_packages(id, character_id, conversation_space)
          ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX character_owned_skill_versions_active_idx
        ON character_owned_skill_versions(package_id)
        WHERE status = 'active';
      CREATE INDEX character_owned_skill_versions_history_idx
        ON character_owned_skill_versions(package_id, version DESC);

      CREATE TABLE character_owned_skill_evaluations (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        conversation_space TEXT NOT NULL
          CHECK (conversation_space IN ('normal', 'secret')),
        source_task_id TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'declined', 'failed', 'cancelled')),
        score REAL CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
        result_summary TEXT NOT NULL DEFAULT '',
        lesson TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(package_id, source_task_id),
        FOREIGN KEY (version_id, package_id, character_id, conversation_space)
          REFERENCES character_owned_skill_versions(
            id, package_id, character_id, conversation_space
          ) ON DELETE CASCADE,
        FOREIGN KEY (package_id, character_id, conversation_space)
          REFERENCES character_owned_skill_packages(id, character_id, conversation_space)
          ON DELETE CASCADE
      );
      CREATE INDEX character_owned_skill_evaluations_package_idx
        ON character_owned_skill_evaluations(package_id, created_at DESC, id DESC);

      CREATE TABLE character_owned_skill_proposals (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL,
        base_version_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        conversation_space TEXT NOT NULL
          CHECK (conversation_space IN ('normal', 'secret')),
        source_task_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'stale')),
        proposed_markdown TEXT NOT NULL,
        change_summary TEXT NOT NULL DEFAULT '',
        content_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        activated_version_id TEXT REFERENCES character_owned_skill_versions(id) ON DELETE SET NULL,
        UNIQUE(package_id, source_task_id),
        FOREIGN KEY (base_version_id, package_id, character_id, conversation_space)
          REFERENCES character_owned_skill_versions(
            id, package_id, character_id, conversation_space
          ) ON DELETE CASCADE,
        FOREIGN KEY (package_id, character_id, conversation_space)
          REFERENCES character_owned_skill_packages(id, character_id, conversation_space)
          ON DELETE CASCADE
      );
      CREATE INDEX character_owned_skill_proposals_status_idx
        ON character_owned_skill_proposals(
          character_id, conversation_space, status, created_at DESC, id DESC
        );
    `,
  },
  {
    version: 42,
    sql: `
      CREATE TABLE character_collaboration_profiles (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        introduction TEXT NOT NULL DEFAULT '',
        traits_json TEXT NOT NULL DEFAULT '[]',
        max_concurrent_tasks INTEGER NOT NULL DEFAULT 1
          CHECK (max_concurrent_tasks BETWEEN 1 AND 5),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO character_collaboration_profiles(
        character_id, introduction, traits_json, max_concurrent_tasks,
        created_at, updated_at
      )
      SELECT
        characters.id,
        COALESCE(character_function_profiles.public_role, ''),
        '[]',
        COALESCE(character_function_profiles.max_concurrent_tasks, 1),
        characters.created_at,
        COALESCE(character_function_profiles.updated_at, characters.updated_at)
      FROM characters
      LEFT JOIN character_function_profiles
        ON character_function_profiles.character_id = characters.id;

      INSERT INTO character_owned_skill_packages(
        id, character_id, conversation_space, slug, name, description,
        tags_json, capability_ids_json, status, auto_improve, created_by,
        created_at, updated_at
      )
      SELECT
        'legacy-owned-' || legacy.id,
        legacy.character_id,
        legacy.conversation_space,
        'general-working-method',
        characters.name || '的通用工作方法',
        COALESCE(NULLIF(character_function_profiles.public_role, ''),
          '从旧版角色工作方法迁移的专属 Skill。'),
        '["legacy"]',
        '[]',
        'active',
        0,
        'migration',
        legacy.created_at,
        COALESCE(legacy.activated_at, legacy.created_at)
      FROM character_skill_versions legacy
      JOIN characters ON characters.id = legacy.character_id
      LEFT JOIN character_function_profiles
        ON character_function_profiles.character_id = legacy.character_id
      WHERE legacy.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM character_owned_skill_packages package
          WHERE package.character_id = legacy.character_id
            AND package.conversation_space = legacy.conversation_space
        );

      INSERT INTO character_owned_skill_versions(
        id, package_id, character_id, conversation_space, version, status,
        markdown, change_summary, source, source_task_id, content_hash,
        created_at, activated_at, superseded_at
      )
      SELECT
        'legacy-owned-version-' || legacy.id,
        'legacy-owned-' || legacy.id,
        legacy.character_id,
        legacy.conversation_space,
        1,
        'active',
        legacy.markdown,
        '从旧版角色 SKILL.md 迁移',
        'legacy_migration',
        NULL,
        legacy.content_hash,
        legacy.created_at,
        COALESCE(legacy.activated_at, legacy.created_at),
        NULL
      FROM character_skill_versions legacy
      WHERE legacy.status = 'active'
        AND EXISTS (
          SELECT 1 FROM character_owned_skill_packages package
          WHERE package.id = 'legacy-owned-' || legacy.id
        );

      DROP TABLE character_capability_evidence;
      DROP TABLE character_capabilities;
      DROP TABLE character_skill_versions;
      DROP TABLE character_function_profiles;
    `,
  },
  {
    version: 43,
    sql: `
      ALTER TABLE character_relationship_states
        RENAME TO character_relationship_states_v42;

      CREATE TABLE character_relationship_states (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        trust INTEGER NOT NULL DEFAULT 35 CHECK (trust BETWEEN 0 AND 100),
        bond INTEGER NOT NULL DEFAULT 25 CHECK (bond BETWEEN 0 AND 100),
        tension INTEGER NOT NULL DEFAULT 0 CHECK (tension BETWEEN 0 AND 100),
        bond_facets_json TEXT NOT NULL DEFAULT '[]',
        romance_status TEXT NOT NULL DEFAULT 'none'
          CHECK (romance_status IN (
            'none', 'user_interest', 'character_interest', 'mutual_interest',
            'dating', 'committed', 'former_partners'
          )),
        semantic_updated_at TEXT,
        affect_valence REAL NOT NULL DEFAULT 0 CHECK (affect_valence BETWEEN -1 AND 1),
        affect_arousal REAL NOT NULL DEFAULT 0.2 CHECK (affect_arousal BETWEEN 0 AND 1),
        affect_control REAL NOT NULL DEFAULT 0.8 CHECK (affect_control BETWEEN 0 AND 1),
        affect_labels_json TEXT NOT NULL DEFAULT '[]',
        affect_updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      INSERT INTO character_relationship_states(
        character_id, trust, bond, tension,
        bond_facets_json, romance_status, semantic_updated_at,
        affect_valence, affect_arousal, affect_control, affect_labels_json,
        affect_updated_at, version, created_at, updated_at
      )
      SELECT
        character_id,
        trust,
        CAST(ROUND(closeness * 0.5 + affection * 0.4 + respect * 0.1) AS INTEGER),
        tension,
        bond_facets_json,
        romance_status,
        semantic_updated_at,
        affect_valence,
        affect_arousal,
        affect_control,
        affect_labels_json,
        affect_updated_at,
        version,
        created_at,
        updated_at
      FROM character_relationship_states_v42;

      DROP TABLE character_relationship_states_v42;

      UPDATE relationship_events
      SET delta_json = CASE
        WHEN json_valid(delta_json) THEN json_object(
          'trust', CAST(COALESCE(json_extract(delta_json, '$.trust'), 0) AS INTEGER),
          'bond', CAST(ROUND(
            CASE
              WHEN json_extract(delta_json, '$.bond') IS NOT NULL
                THEN CAST(json_extract(delta_json, '$.bond') AS REAL)
              ELSE
                COALESCE(CAST(json_extract(delta_json, '$.closeness') AS REAL), 0) * 0.5 +
                COALESCE(CAST(json_extract(delta_json, '$.affection') AS REAL), 0) * 0.4 +
                COALESCE(CAST(json_extract(delta_json, '$.respect') AS REAL), 0) * 0.1
            END
          ) AS INTEGER),
          'tension', CAST(COALESCE(json_extract(delta_json, '$.tension'), 0) AS INTEGER)
        )
        ELSE json_object('trust', 0, 'bond', 0, 'tension', 0)
      END;
    `,
  },
  {
    version: 44,
    sql: `
      CREATE TABLE world_attribute_definitions (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        attribute_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        min_value INTEGER NOT NULL CHECK (min_value BETWEEN -10000 AND 10000),
        max_value INTEGER NOT NULL CHECK (max_value BETWEEN -10000 AND 10000),
        default_value INTEGER NOT NULL,
        agent_mutable INTEGER NOT NULL DEFAULT 0 CHECK (agent_mutable IN (0, 1)),
        agent_can_increase INTEGER NOT NULL DEFAULT 1 CHECK (agent_can_increase IN (0, 1)),
        agent_can_decrease INTEGER NOT NULL DEFAULT 1 CHECK (agent_can_decrease IN (0, 1)),
        agent_max_delta INTEGER NOT NULL DEFAULT 5 CHECK (agent_max_delta BETWEEN 1 AND 1000),
        visible_to_agent INTEGER NOT NULL DEFAULT 1 CHECK (visible_to_agent IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (min_value < max_value),
        CHECK (default_value BETWEEN min_value AND max_value),
        UNIQUE(world_id, attribute_key),
        UNIQUE(id, world_id)
      );
      CREATE INDEX world_attribute_definitions_world_idx
        ON world_attribute_definitions(world_id, status, name, id);

      CREATE TABLE character_world_attribute_values (
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        attribute_id TEXT NOT NULL,
        value INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(world_id, character_id, attribute_id),
        FOREIGN KEY(attribute_id, world_id)
          REFERENCES world_attribute_definitions(id, world_id) ON DELETE CASCADE
      );
      CREATE INDEX character_world_attribute_values_character_idx
        ON character_world_attribute_values(character_id, world_id, attribute_id);

      CREATE TABLE world_attribute_events (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        attribute_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('user_control', 'agent_tool', 'system')),
        requested_delta INTEGER NOT NULL,
        applied_delta INTEGER NOT NULL,
        before_value INTEGER NOT NULL,
        after_value INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY(attribute_id, world_id)
          REFERENCES world_attribute_definitions(id, world_id) ON DELETE CASCADE
      );
      CREATE INDEX world_attribute_events_character_idx
        ON world_attribute_events(character_id, world_id, created_at DESC, id DESC);
    `,
  },
  {
    version: 45,
    sql: `
      ALTER TABLE world_attribute_definitions
        ADD COLUMN analysis_enabled INTEGER NOT NULL DEFAULT 0
          CHECK (analysis_enabled IN (0, 1));
      ALTER TABLE world_attribute_definitions
        ADD COLUMN increase_rule TEXT NOT NULL DEFAULT ''
          CHECK (length(increase_rule) <= 800);
      ALTER TABLE world_attribute_definitions
        ADD COLUMN increase_delta INTEGER NOT NULL DEFAULT 1
          CHECK (increase_delta BETWEEN 1 AND 1000);
      ALTER TABLE world_attribute_definitions
        ADD COLUMN decrease_rule TEXT NOT NULL DEFAULT ''
          CHECK (length(decrease_rule) <= 800);
      ALTER TABLE world_attribute_definitions
        ADD COLUMN decrease_delta INTEGER NOT NULL DEFAULT 1
          CHECK (decrease_delta BETWEEN 1 AND 1000);

      DROP INDEX world_attribute_events_character_idx;
      ALTER TABLE world_attribute_events RENAME TO world_attribute_events_v44;
      CREATE TABLE world_attribute_events (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        attribute_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'user_control', 'post_turn_analysis', 'world_turn_analysis', 'agent_tool', 'system'
        )),
        requested_delta INTEGER NOT NULL,
        applied_delta INTEGER NOT NULL,
        before_value INTEGER NOT NULL,
        after_value INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL UNIQUE,
        analysis_direction TEXT CHECK (analysis_direction IN ('increase', 'decrease')),
        rule_snapshot TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        source_reference_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(attribute_id, world_id)
          REFERENCES world_attribute_definitions(id, world_id) ON DELETE CASCADE
      );
      INSERT INTO world_attribute_events(
        id, world_id, character_id, attribute_id, source,
        requested_delta, applied_delta, before_value, after_value,
        summary, idempotency_key, created_at
      )
      SELECT
        id, world_id, character_id, attribute_id, source,
        requested_delta, applied_delta, before_value, after_value,
        summary, idempotency_key, created_at
      FROM world_attribute_events_v44;
      DROP TABLE world_attribute_events_v44;
      CREATE INDEX world_attribute_events_character_idx
        ON world_attribute_events(character_id, world_id, created_at DESC, id DESC);
      CREATE INDEX world_attribute_events_source_reference_idx
        ON world_attribute_events(source_reference_id, character_id, attribute_id);
    `,
  },
  {
    version: 46,
    sql: `
      ALTER TABLE world_attribute_definitions
        ADD COLUMN value_scope TEXT NOT NULL DEFAULT 'character'
          CHECK (value_scope IN ('world', 'character'));

      CREATE TRIGGER world_attribute_definition_scope_immutable
      BEFORE UPDATE OF value_scope ON world_attribute_definitions
      FOR EACH ROW WHEN NEW.value_scope <> OLD.value_scope
      BEGIN
        SELECT RAISE(ABORT, 'world attribute scope is immutable');
      END;

      CREATE TABLE world_attribute_values (
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        attribute_id TEXT NOT NULL,
        value INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(world_id, attribute_id),
        FOREIGN KEY(attribute_id, world_id)
          REFERENCES world_attribute_definitions(id, world_id) ON DELETE CASCADE
      );
      CREATE INDEX world_attribute_values_world_idx
        ON world_attribute_values(world_id, attribute_id);

      CREATE TRIGGER world_attribute_values_require_world_scope_insert
      BEFORE INSERT ON world_attribute_values
      FOR EACH ROW
      WHEN COALESCE((
        SELECT value_scope FROM world_attribute_definitions
        WHERE id = NEW.attribute_id AND world_id = NEW.world_id
      ), '') <> 'world'
      BEGIN
        SELECT RAISE(ABORT, 'world attribute value requires world scope');
      END;
      CREATE TRIGGER world_attribute_values_require_world_scope_update
      BEFORE UPDATE OF world_id, attribute_id ON world_attribute_values
      FOR EACH ROW
      WHEN COALESCE((
        SELECT value_scope FROM world_attribute_definitions
        WHERE id = NEW.attribute_id AND world_id = NEW.world_id
      ), '') <> 'world'
      BEGIN
        SELECT RAISE(ABORT, 'world attribute value requires world scope');
      END;
      CREATE TRIGGER character_world_attribute_values_require_character_scope_insert
      BEFORE INSERT ON character_world_attribute_values
      FOR EACH ROW
      WHEN COALESCE((
        SELECT value_scope FROM world_attribute_definitions
        WHERE id = NEW.attribute_id AND world_id = NEW.world_id
      ), '') <> 'character'
      BEGIN
        SELECT RAISE(ABORT, 'character attribute value requires character scope');
      END;
      CREATE TRIGGER character_world_attribute_values_require_character_scope_update
      BEFORE UPDATE OF world_id, attribute_id ON character_world_attribute_values
      FOR EACH ROW
      WHEN COALESCE((
        SELECT value_scope FROM world_attribute_definitions
        WHERE id = NEW.attribute_id AND world_id = NEW.world_id
      ), '') <> 'character'
      BEGIN
        SELECT RAISE(ABORT, 'character attribute value requires character scope');
      END;

      DROP INDEX world_attribute_events_character_idx;
      DROP INDEX world_attribute_events_source_reference_idx;
      ALTER TABLE world_attribute_events RENAME TO world_attribute_events_v45;
      CREATE TABLE world_attribute_events (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        character_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
        attribute_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN (
          'user_control', 'post_turn_analysis', 'world_turn_analysis', 'agent_tool', 'system'
        )),
        requested_delta INTEGER NOT NULL,
        applied_delta INTEGER NOT NULL,
        before_value INTEGER NOT NULL,
        after_value INTEGER NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        idempotency_key TEXT NOT NULL UNIQUE,
        analysis_direction TEXT CHECK (analysis_direction IN ('increase', 'decrease')),
        rule_snapshot TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        source_reference_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(attribute_id, world_id)
          REFERENCES world_attribute_definitions(id, world_id) ON DELETE CASCADE
      );
      INSERT INTO world_attribute_events(
        id, world_id, character_id, attribute_id, source,
        requested_delta, applied_delta, before_value, after_value,
        summary, idempotency_key, analysis_direction, rule_snapshot,
        evidence, confidence, source_reference_id, created_at
      )
      SELECT
        id, world_id, character_id, attribute_id, source,
        requested_delta, applied_delta, before_value, after_value,
        summary, idempotency_key, analysis_direction, rule_snapshot,
        evidence, confidence, source_reference_id, created_at
      FROM world_attribute_events_v45;
      DROP TABLE world_attribute_events_v45;
      CREATE INDEX world_attribute_events_character_idx
        ON world_attribute_events(character_id, world_id, created_at DESC, id DESC);
      CREATE INDEX world_attribute_events_world_idx
        ON world_attribute_events(world_id, created_at DESC, id DESC);
      CREATE INDEX world_attribute_events_source_reference_idx
        ON world_attribute_events(source_reference_id, character_id, attribute_id);
      CREATE TRIGGER world_attribute_events_require_character_actor_insert
      BEFORE INSERT ON world_attribute_events
      FOR EACH ROW
      WHEN NEW.character_id IS NULL AND COALESCE((
        SELECT value_scope FROM world_attribute_definitions
        WHERE id = NEW.attribute_id AND world_id = NEW.world_id
      ), '') = 'character'
      BEGIN
        SELECT RAISE(ABORT, 'character attribute event requires character');
      END;
      CREATE TRIGGER world_attribute_events_require_character_actor_update
      BEFORE UPDATE OF world_id, character_id, attribute_id ON world_attribute_events
      FOR EACH ROW
      WHEN NEW.character_id IS NULL AND COALESCE((
        SELECT value_scope FROM world_attribute_definitions
        WHERE id = NEW.attribute_id AND world_id = NEW.world_id
      ), '') = 'character'
      BEGIN
        SELECT RAISE(ABORT, 'character attribute event requires character');
      END;
    `,
  },
  {
    version: 47,
    sql: `
      CREATE TABLE character_agent_skill_packages (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        conversation_space TEXT NOT NULL
          CHECK (conversation_space IN ('normal', 'secret')),
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
        description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        source_requested_url TEXT NOT NULL,
        source_resolved_url TEXT NOT NULL,
        source_final_url TEXT NOT NULL,
        source_package_path TEXT,
        source_requested_ref TEXT,
        source_resolved_commit TEXT,
        archive_sha256 TEXT NOT NULL CHECK (length(archive_sha256) = 64),
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        manifest_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(character_id, conversation_space, name)
      );
      CREATE INDEX character_agent_skill_packages_enabled_idx
        ON character_agent_skill_packages(
          character_id, conversation_space, enabled, name
        );
      CREATE TRIGGER character_agent_skill_packages_limit_insert
      BEFORE INSERT ON character_agent_skill_packages
      FOR EACH ROW
      WHEN (
        SELECT COUNT(*)
        FROM character_agent_skill_packages
        WHERE character_id = NEW.character_id
          AND conversation_space = NEW.conversation_space
      ) >= 12
      BEGIN
        SELECT RAISE(ABORT, 'a character can install at most 12 private Skill packages per space');
      END;
    `,
  },
  {
    version: 48,
    sql: `
      CREATE TABLE subagent_runtime_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        max_concurrent_tasks INTEGER NOT NULL
          CHECK (max_concurrent_tasks BETWEEN 1 AND 8),
        max_work_model_calls INTEGER NOT NULL
          CHECK (max_work_model_calls BETWEEN 1 AND 64),
        max_output_tokens INTEGER NOT NULL
          CHECK (max_output_tokens BETWEEN 512 AND 65536),
        max_result_characters INTEGER NOT NULL
          CHECK (max_result_characters BETWEEN 1000 AND 200000),
        timeout_seconds INTEGER NOT NULL
          CHECK (timeout_seconds BETWEEN 60 AND 3600),
        revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO subagent_runtime_settings(
        singleton,
        max_concurrent_tasks,
        max_work_model_calls,
        max_output_tokens,
        max_result_characters,
        timeout_seconds,
        revision,
        created_at,
        updated_at
      ) VALUES (
        1, 4, 32, 16384, 64000, 1800, 0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      );
    `,
  },
  {
    version: 49,
    sql: `
      CREATE TABLE character_interaction_scenes (
        episode_id TEXT PRIMARY KEY
          REFERENCES character_channel_episodes(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL
          REFERENCES character_channels(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL
          REFERENCES role_worlds(id) ON DELETE CASCADE,
        narrative_text TEXT NOT NULL CHECK (length(narrative_text) BETWEEN 1 AND 8000),
        event_summary TEXT NOT NULL CHECK (length(event_summary) BETWEEN 1 AND 1200),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX character_interaction_scenes_channel_idx
        ON character_interaction_scenes(channel_id, created_at DESC, episode_id DESC);

      CREATE TABLE character_interaction_reflections (
        episode_id TEXT NOT NULL
          REFERENCES character_channel_episodes(id) ON DELETE CASCADE,
        channel_id TEXT NOT NULL
          REFERENCES character_channels(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL
          REFERENCES role_worlds(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL
          REFERENCES characters(id) ON DELETE CASCADE,
        peer_character_id TEXT NOT NULL
          REFERENCES characters(id) ON DELETE CASCADE,
        summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 600),
        salience REAL NOT NULL CHECK (salience >= 0 AND salience <= 1),
        created_at TEXT NOT NULL,
        PRIMARY KEY(episode_id, character_id),
        CHECK (character_id <> peer_character_id)
      );
      CREATE INDEX character_interaction_reflections_character_idx
        ON character_interaction_reflections(
          character_id, world_id, created_at DESC, episode_id DESC
        );
      CREATE INDEX character_interaction_reflections_peer_idx
        ON character_interaction_reflections(
          character_id, peer_character_id, created_at DESC, episode_id DESC
        );
    `,
  },
  {
    version: 50,
    sql: `
      CREATE TABLE task_bench_reports (
        id TEXT PRIMARY KEY,
        ran_at TEXT NOT NULL,
        name TEXT NOT NULL,
        report_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX task_bench_reports_ran_at_idx
        ON task_bench_reports(ran_at DESC, id DESC);

      CREATE TABLE task_bench_report_migrations (
        name TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 51,
    sql: `
      ALTER TABLE world_story_events
        ADD COLUMN meeting_session_id TEXT
          REFERENCES role_sessions(app_session_id) ON DELETE SET NULL;

      CREATE INDEX world_story_events_meeting_session_idx
        ON world_story_events(meeting_session_id, updated_at DESC)
        WHERE meeting_session_id IS NOT NULL;
    `,
  },
  {
    version: 52,
    sql: `
      CREATE TABLE character_diary_settings (
        character_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
        narrative_enabled INTEGER NOT NULL DEFAULT 1 CHECK (narrative_enabled IN (0,1)),
        preset TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE character_diary_entries (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('activity','interaction','world_event')),
        source_id TEXT NOT NULL,
        title TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        source_json TEXT NOT NULL,
        memory_json TEXT,
        narrative_text TEXT,
        created_at TEXT NOT NULL,
        invalidated_at TEXT
      );
      CREATE UNIQUE INDEX character_diary_source_idx ON character_diary_entries(character_id,source_kind,source_id) WHERE invalidated_at IS NULL;
      CREATE INDEX character_diary_entries_owner_idx
        ON character_diary_entries(character_id, occurred_at DESC, id DESC);
      CREATE TABLE character_diary_jobs (
        entry_id TEXT NOT NULL REFERENCES character_diary_entries(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('memory','narrative')),
        status TEXT NOT NULL CHECK (status IN ('pending','running','ready','failed','paused')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_id TEXT,
        lease_until TEXT,
        error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(entry_id, kind)
      );
      ALTER TABLE world_character_relationships ADD COLUMN romance_status TEXT NOT NULL DEFAULT 'none'
        CHECK (romance_status IN ('none','interested','dating','committed','former_partners'));
      CREATE TABLE character_diary_generations (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL REFERENCES character_diary_entries(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('memory','narrative')),
        started_at TEXT NOT NULL
      );
      CREATE TABLE world_character_romance_events (
        id TEXT PRIMARY KEY,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        subject_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        object_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        event_type TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(world_id, source_id, subject_character_id, object_character_id, event_type)
      );
    `,
  },
  {
    version: 53,
    sql: `
      ALTER TABLE character_diary_settings ADD COLUMN preset_mode TEXT NOT NULL DEFAULT 'inherit'
        CHECK (preset_mode IN ('inherit','custom','none'));
      ALTER TABLE character_diary_settings ADD COLUMN preset_id TEXT
        REFERENCES meeting_presets(id) ON DELETE SET NULL;
      -- Preserve existing custom writing instructions without silently adding a second preset.
      UPDATE character_diary_settings SET preset_mode='none' WHERE length(trim(preset)) > 0;
    `,
  },
  {
    version: 54,
    sql: `
      -- A departed identity is a historical reference, deliberately NOT a live-character FK.
      CREATE TABLE character_departure_memories (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        departed_character_id TEXT NOT NULL,
        departed_name TEXT NOT NULL,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        relationship_json TEXT,
        experiences_json TEXT NOT NULL DEFAULT '[]',
        occurred_at TEXT NOT NULL,
        memory_materialized_at TEXT,
        UNIQUE(character_id, departed_character_id, world_id)
      );
      CREATE INDEX character_departure_owner_idx ON character_departure_memories(character_id, world_id, occurred_at DESC);

      CREATE TABLE character_life_goals (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        conversation_space TEXT NOT NULL CHECK (conversation_space IN ('normal','secret')),
        kind TEXT NOT NULL CHECK (kind IN ('request','wish')),
        world_id TEXT REFERENCES role_worlds(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        next_step TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('active','paused','completed','cancelled')),
        revision INTEGER NOT NULL DEFAULT 1,
        completion_note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (kind <> 'wish' OR (conversation_space = 'normal' AND world_id IS NOT NULL))
      );
      CREATE UNIQUE INDEX character_life_goal_active_idx ON character_life_goals(character_id, conversation_space, kind)
        WHERE status IN ('active','paused');
      CREATE TABLE character_life_goal_steps (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES character_life_goals(id) ON DELETE CASCADE,
        schedule_item_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned','settled','cancelled')),
        source_event_id TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Planning had no durable execution record. Other task kinds keep their existing stores.
      CREATE TABLE character_planning_jobs (
        id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        world_id TEXT NOT NULL REFERENCES role_worlds(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled')),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX character_planning_jobs_owner_idx ON character_planning_jobs(character_id, created_at DESC);
      ALTER TABLE character_diary_jobs ADD COLUMN cancelled_at TEXT;
    `,
  },
  {
    version: 55,
    sql: `
      CREATE TABLE creator_turns (
        id TEXT PRIMARY KEY, text TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled')), created_at TEXT NOT NULL
      );
      CREATE TABLE creator_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), text TEXT NOT NULL,
        turn_id TEXT REFERENCES creator_turns(id), created_at TEXT NOT NULL
      );
      CREATE TABLE creator_proposals (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES creator_turns(id), tool_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','applied','rejected','stale','applying','interrupted','failed')),
        result TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX creator_proposals_status_idx ON creator_proposals(status);
    `,
  },
  {
    version: 56,
    sql: `
      ALTER TABLE schedule_items ADD COLUMN reminder_json TEXT;
      ALTER TABLE schedule_items ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE reminder_occurrences ADD COLUMN event_at TEXT;
      ALTER TABLE reminder_occurrences ADD COLUMN acknowledged_at TEXT;
      ALTER TABLE reminder_occurrences ADD COLUMN acknowledged_via TEXT;
      ALTER TABLE notification_outbox ADD COLUMN suppressed_at TEXT;
      CREATE TABLE reminder_drafts (
        occurrence_id TEXT PRIMARY KEY REFERENCES reminder_occurrences(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('preparing','ready','failed')),
        body TEXT, agent_generated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE im_outbox_next (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('feishu','wechat')),
        gateway_connection_id TEXT NOT NULL, binding_generation TEXT NOT NULL, external_chat_id TEXT NOT NULL,
        inbound_event_id TEXT, notification_outbox_id TEXT UNIQUE REFERENCES notification_outbox(id) ON DELETE CASCADE,
        text TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed','abandoned')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), available_at TEXT NOT NULL,
        lease_token TEXT, lease_expires_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT,
        UNIQUE(provider,inbound_event_id),
        CHECK((inbound_event_id IS NOT NULL) != (notification_outbox_id IS NOT NULL)),
        FOREIGN KEY(provider,inbound_event_id) REFERENCES im_inbound_events(provider,event_id) ON DELETE CASCADE
      );
      INSERT INTO im_outbox_next(id,provider,gateway_connection_id,binding_generation,external_chat_id,inbound_event_id,
        text,attachments_json,status,attempts,available_at,lease_token,lease_expires_at,last_error,created_at,updated_at,delivered_at)
        SELECT id,provider,gateway_connection_id,binding_generation,external_chat_id,inbound_event_id,
        text,attachments_json,status,attempts,available_at,lease_token,lease_expires_at,last_error,created_at,updated_at,delivered_at FROM im_outbox;
      DROP TABLE im_outbox;
      ALTER TABLE im_outbox_next RENAME TO im_outbox;
      CREATE INDEX im_outbox_pending_idx ON im_outbox(provider,gateway_connection_id,binding_generation,status,available_at,lease_expires_at,created_at,id);
    `,
  },
  {
    version: 57,
    sql: `
      ALTER TABLE im_runtime_settings ADD COLUMN wechat_reminders_enabled INTEGER NOT NULL DEFAULT 1 CHECK(wechat_reminders_enabled IN (0,1));
      ALTER TABLE im_runtime_settings ADD COLUMN feishu_reminders_enabled INTEGER NOT NULL DEFAULT 1 CHECK(feishu_reminders_enabled IN (0,1));
    `,
  },
  {
    version: 58,
    sql: `
      CREATE TABLE agent_runtime_configuration_snapshots (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        digest TEXT NOT NULL CHECK (length(digest) = 64),
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 59,
    sql: `
      CREATE TABLE agent_module_provider_settings (
        module_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        values_json TEXT NOT NULL CHECK (json_valid(values_json)),
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 60,
    sql: `
      CREATE TABLE subagent_jobs (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT NOT NULL,
        child_session_id TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('worker', 'researcher', 'planner', 'reviewer')),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'idle', 'completed', 'failed', 'cancelled')
        ),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        task_text TEXT NOT NULL,
        context_text TEXT,
        task_sha256 TEXT NOT NULL CHECK (
          length(task_sha256) = 64 AND task_sha256 NOT GLOB '*[^a-f0-9]*'
        ),
        task_characters INTEGER NOT NULL CHECK (task_characters BETWEEN 1 AND 4000),
        context_characters INTEGER NOT NULL CHECK (context_characters BETWEEN 0 AND 8000),
        mode TEXT NOT NULL CHECK (mode IN ('sms', 'rp')),
        conversation_space TEXT NOT NULL CHECK (conversation_space IN ('normal', 'secret')),
        character_id TEXT,
        secret_owner_character_id TEXT,
        budgets_json TEXT NOT NULL CHECK (json_valid(budgets_json)),
        grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
        result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
        failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
        recovery_count INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count >= 0),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (
          (conversation_space = 'normal' AND secret_owner_character_id IS NULL)
          OR
          (conversation_space = 'secret' AND character_id IS NOT NULL
            AND secret_owner_character_id = character_id)
        ),
        CHECK (
          (status = 'completed' AND result_json IS NOT NULL AND failure_json IS NULL)
          OR
          (status IN ('failed', 'cancelled') AND result_json IS NULL AND failure_json IS NOT NULL)
          OR
          (status IN ('queued', 'running', 'idle') AND result_json IS NULL AND failure_json IS NULL)
        )
      );
      CREATE INDEX subagent_jobs_parent_recent_idx
        ON subagent_jobs(parent_session_id, updated_at DESC, id DESC);
      CREATE INDEX subagent_jobs_recovery_idx
        ON subagent_jobs(status, updated_at, id);
    `,
  },
  {
    version: 61,
    sql: `
      ALTER TABLE subagent_jobs ADD COLUMN transcript_json TEXT
        CHECK (transcript_json IS NULL OR json_valid(transcript_json));
      ALTER TABLE subagent_jobs ADD COLUMN pending_input_text TEXT;
      ALTER TABLE subagent_jobs ADD COLUMN pending_input_sha256 TEXT
        CHECK (
          pending_input_sha256 IS NULL
          OR (length(pending_input_sha256) = 64 AND pending_input_sha256 NOT GLOB '*[^a-f0-9]*')
        );
      ALTER TABLE subagent_jobs ADD COLUMN pending_input_characters INTEGER NOT NULL DEFAULT 0
        CHECK (pending_input_characters BETWEEN 0 AND 4000);
      ALTER TABLE subagent_jobs ADD COLUMN followup_count INTEGER NOT NULL DEFAULT 0
        CHECK (followup_count BETWEEN 0 AND 8);
    `,
  },
  {
    version: 62,
    sql: `
      CREATE TABLE subagent_job_deliveries (
        job_id TEXT NOT NULL REFERENCES subagent_jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9),
        status TEXT NOT NULL CHECK (
          status IN ('waiting', 'pending', 'delivered', 'discarded')
        ),
        outcome_status TEXT CHECK (
          outcome_status IS NULL OR outcome_status IN ('completed', 'failed', 'cancelled')
        ),
        job_revision INTEGER CHECK (job_revision IS NULL OR job_revision >= 1),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        discarded_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (job_id, generation),
        CHECK (
          (status = 'waiting' AND outcome_status IS NULL AND job_revision IS NULL
            AND delivered_at IS NULL AND discarded_at IS NULL)
          OR
          (status = 'pending' AND outcome_status IS NOT NULL AND job_revision IS NOT NULL
            AND delivered_at IS NULL AND discarded_at IS NULL)
          OR
          (status = 'delivered' AND outcome_status IS NOT NULL AND job_revision IS NOT NULL
            AND delivered_at IS NOT NULL AND discarded_at IS NULL)
          OR
          (status = 'discarded' AND delivered_at IS NULL AND discarded_at IS NOT NULL)
        )
      );
      CREATE INDEX subagent_job_deliveries_pending_idx
        ON subagent_job_deliveries(status, created_at, job_id, generation);
    `,
  },
  {
    version: 63,
    sql: `
      CREATE TABLE subagent_job_runs (
        job_id TEXT NOT NULL REFERENCES subagent_jobs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'idle', 'completed', 'failed', 'cancelled')
        ),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
        model_calls INTEGER NOT NULL DEFAULT 0 CHECK (model_calls BETWEEN 0 AND 65),
        tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls BETWEEN 0 AND 1040),
        input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 272629760),
        output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 4259840),
        duration_ms INTEGER NOT NULL DEFAULT 0 CHECK (duration_ms BETWEEN 0 AND 2147483647),
        result_characters INTEGER NOT NULL DEFAULT 0
          CHECK (result_characters BETWEEN 0 AND 200000),
        checkpoint_at TEXT,
        owner_id TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        attempt_started_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        PRIMARY KEY (job_id, generation),
        CHECK (
          (status IN ('queued', 'idle') AND owner_id IS NULL AND claim_token IS NULL
            AND lease_expires_at IS NULL AND attempt_started_at IS NULL
            AND finished_at IS NULL)
          OR
          (status = 'running' AND attempt_started_at IS NOT NULL AND finished_at IS NULL
            AND (
              (owner_id IS NULL AND claim_token IS NULL AND lease_expires_at IS NULL)
              OR
              (owner_id IS NOT NULL AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL)
            ))
          OR
          (status IN ('completed', 'failed', 'cancelled') AND owner_id IS NULL
            AND claim_token IS NULL AND lease_expires_at IS NULL
            AND attempt_started_at IS NULL AND finished_at IS NOT NULL)
        )
      );
      CREATE INDEX subagent_job_runs_recovery_idx
        ON subagent_job_runs(status, lease_expires_at, updated_at, job_id, generation);

      INSERT INTO subagent_job_runs(
        job_id, generation, status, attempt_count,
        model_calls, tool_calls, input_tokens, output_tokens, duration_ms,
        result_characters, checkpoint_at, owner_id, claim_token, lease_expires_at,
        attempt_started_at, created_at, updated_at, finished_at
      )
      SELECT
        id,
        followup_count + 1,
        status,
        CASE WHEN status IN ('queued', 'idle') THEN 0 ELSE 1 END,
        MIN(65, COALESCE(
          json_extract(result_json, '$.modelCalls'),
          json_extract(failure_json, '$.modelCalls'),
          0
        )),
        MIN(1040, COALESCE(
          json_extract(result_json, '$.toolCalls'),
          json_extract(failure_json, '$.toolCalls'),
          0
        )),
        MIN(272629760, COALESCE(
          json_extract(result_json, '$.inputTokens'),
          json_extract(failure_json, '$.inputTokens'),
          0
        )),
        MIN(4259840, COALESCE(
          json_extract(result_json, '$.outputTokens'),
          json_extract(failure_json, '$.outputTokens'),
          0
        )),
        MIN(2147483647, COALESCE(
          json_extract(result_json, '$.durationMs'),
          json_extract(failure_json, '$.durationMs'),
          0
        )),
        CASE WHEN status = 'completed'
          THEN MIN(200000, length(COALESCE(json_extract(result_json, '$.output'), '')))
          ELSE 0
        END,
        CASE WHEN transcript_json IS NOT NULL THEN updated_at ELSE NULL END,
        NULL,
        NULL,
        NULL,
        CASE WHEN status = 'running' THEN COALESCE(started_at, updated_at) ELSE NULL END,
        created_at,
        updated_at,
        CASE WHEN status IN ('completed', 'failed', 'cancelled')
          THEN COALESCE(finished_at, updated_at)
          ELSE NULL
        END
      FROM subagent_jobs;
    `,
  },
];

export class AppDatabase {
  readonly connection: DatabaseSync;

  constructor(
    path: string,
    options: { maxMigrationVersion?: number; tempStoreMemory?: boolean } = {},
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.connection = new DatabaseSync(path);
    if (options.tempStoreMemory) {
      this.connection.exec("PRAGMA temp_store = MEMORY");
      const row = this.connection.prepare("PRAGMA temp_store").get() as { temp_store?: number } | undefined;
      if (Number(row?.temp_store) !== 2) {
        this.connection.close();
        throw new Error("failed to confine SQLite temporary state to memory");
      }
    }
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") {
      this.connection.exec("PRAGMA journal_mode = WAL");
    }
    this.migrate(options.maxMigrationVersion);
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

  private migrate(maxMigrationVersion = Number.POSITIVE_INFINITY): void {
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
    this.reconcileReusedPrivateMigrationMarkers(applied, maxMigrationVersion);
    for (const migration of migrations) {
      if (migration.version > maxMigrationVersion) continue;
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

  private reconcileReusedPrivateMigrationMarkers(
    applied: Set<number>,
    maxMigrationVersion: number,
  ): void {
    const staleVersions: number[] = [];
    if (
      maxMigrationVersion >= 36 && applied.has(36) &&
      !this.tableExists("agent_skill_space_settings")
    ) staleVersions.push(36);
    if (
      maxMigrationVersion >= 37 && applied.has(37) &&
      !this.columnExists("rp_memories", "conversation_space")
    ) staleVersions.push(37);
    if (
      maxMigrationVersion >= 38 && applied.has(38) &&
      !applied.has(42) &&
      !this.columnExists("character_skill_versions", "conversation_space")
    ) staleVersions.push(38);
    if (!staleVersions.length) return;
    this.transaction(() => {
      const remove = this.connection.prepare("DELETE FROM schema_migrations WHERE version = ?");
      for (const version of staleVersions) remove.run(version);
    });
    for (const version of staleVersions) applied.delete(version);
  }

  private tableExists(name: string): boolean {
    return Boolean(this.connection.prepare(`
      SELECT 1 AS present FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(name));
  }

  private columnExists(table: string, column: string): boolean {
    if (!this.tableExists(table)) return false;
    return (this.connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .some((entry) => entry.name === column);
  }
}
