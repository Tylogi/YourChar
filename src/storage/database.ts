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
