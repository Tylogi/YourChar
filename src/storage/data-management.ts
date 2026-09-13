import type { AppDatabase } from "./database.js";

export class DataManagementRepository {
  constructor(private readonly database: AppDatabase) {}

  check(): void {
    this.database.connection.prepare("SELECT 1").get();
  }

  deleteSessionObservability(sessionId: string): {
    contextLogs: number;
    modelTraces: number;
    contextEconomics: number;
    memoryContextItems: number;
    memoryContextSessions: number;
  } {
    return this.database.transaction(() => {
      this.database.connection.prepare("DELETE FROM memory_extraction_jobs WHERE session_id = ?").run(sessionId);
      this.database.connection.prepare("DELETE FROM relationship_extraction_jobs WHERE session_id = ?").run(sessionId);
      this.database.connection.prepare("DELETE FROM subagent_jobs WHERE parent_session_id = ?").run(sessionId);
      this.database.connection.prepare("DELETE FROM execution_jobs WHERE parent_session_id = ?").run(sessionId);
      const contextEconomics = Number(this.database.connection.prepare(
        "DELETE FROM context_economics WHERE session_id = ?",
      ).run(sessionId).changes);
      const memoryContextSessions = Number(this.database.connection.prepare(
        "DELETE FROM memory_context_sessions WHERE session_id = ?",
      ).run(sessionId).changes);
      const memoryContextItems = Number(this.database.connection.prepare(
        "DELETE FROM memory_context_items WHERE session_id = ?",
      ).run(sessionId).changes);
      return {
        contextLogs: Number(this.database.connection.prepare(
          "DELETE FROM context_log_summaries WHERE session_id = ?",
        ).run(sessionId).changes),
        modelTraces: Number(this.database.connection.prepare(
          "DELETE FROM model_context_traces WHERE session_id = ?",
        ).run(sessionId).changes),
        contextEconomics,
        memoryContextItems,
        memoryContextSessions,
      };
    });
  }

  deleteCharacter(characterId: string, sessionIds: string[], now: string, beforeDelete?: () => void): void {
    for (const sessionId of sessionIds) this.deleteSessionObservability(sessionId);
    this.database.transaction(() => {
      const connection = this.database.connection;
      beforeDelete?.();
      for (const sessionId of sessionIds) {
        connection.prepare("DELETE FROM pending_real_mutations WHERE session_id = ?").run(sessionId);
      }
      connection.prepare(`UPDATE world_narrative_contexts
        SET status = 'closed', close_reason = 'character_deleted', closed_at = ?, updated_at = ?
        WHERE status = 'active' AND EXISTS (
          SELECT 1 FROM json_each(participant_ids_json) WHERE value = ?
        )`).run(now, now, characterId);
      connection.prepare(`UPDATE world_story_events SET revision = revision + 1,
        status = CASE WHEN status IN ('planned', 'active') AND (
          meeting_session_id IN (SELECT app_session_id FROM role_sessions WHERE character_id = ?)
          OR NOT EXISTS (SELECT 1 FROM world_story_event_participants p WHERE p.event_id = world_story_events.id AND p.character_id <> ?)
          ) THEN 'cancelled' ELSE status END,
        updated_at = ?
        WHERE id IN (
          SELECT event_id FROM world_story_event_participants WHERE character_id = ?
        )`).run(characterId, characterId, now, characterId);
      connection.prepare(`UPDATE world_story_events SET ended_at = COALESCE(ended_at, ?)
        WHERE status = 'cancelled' AND id IN (
          SELECT event_id FROM world_story_event_participants WHERE character_id = ?
        )`).run(now, characterId);
      // Most character-owned rows cascade. Membership intentionally uses RESTRICT;
      // removing only this membership keeps the group and its shared messages intact.
      connection.prepare("DELETE FROM group_chat_members WHERE character_id = ?").run(characterId);
      connection.prepare("DELETE FROM memory_extraction_jobs WHERE character_id = ?").run(characterId);
      connection.prepare("DELETE FROM im_inbound_events WHERE character_id = ?").run(characterId);
      connection.prepare("DELETE FROM characters WHERE id = ?").run(characterId);
    });
  }

  deleteAllUserData(): void {
    this.database.transaction(() => {
      this.database.connection.exec(`
        DELETE FROM im_outbox;
        DELETE FROM im_inbound_events;
        DELETE FROM im_binding_sessions;
        DELETE FROM im_bindings;
        DELETE FROM im_character_routes;
        UPDATE im_runtime_settings
        SET wechat_typing_enabled = 1,
            wechat_reminders_enabled = 1,
            feishu_reminders_enabled = 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE singleton = 1;
        UPDATE subagent_runtime_settings
        SET max_concurrent_tasks = 4,
            max_work_model_calls = 32,
            max_output_tokens = 16384,
            max_result_characters = 64000,
            timeout_seconds = 1800,
            revision = revision + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE singleton = 1;
        DELETE FROM notification_outbox;
        DELETE FROM reminder_drafts;
        DELETE FROM reminder_occurrences;
        DELETE FROM proactive_messages;
        DELETE FROM proactive_topic_policies;
        DELETE FROM character_diary_generations;
        DELETE FROM character_departure_memories;
        DELETE FROM character_life_goal_steps;
        DELETE FROM character_life_goals;
        DELETE FROM character_planning_jobs;
        DELETE FROM creator_proposals;
        DELETE FROM creator_messages;
        DELETE FROM creator_turns;
        DELETE FROM character_diary_jobs;
        DELETE FROM character_diary_entries;
        DELETE FROM character_diary_settings;
        DELETE FROM world_character_romance_events;
        DELETE FROM character_interaction_reflections;
        DELETE FROM character_interaction_scenes;
        DELETE FROM character_channel_messages;
        DELETE FROM character_channel_episodes;
        DELETE FROM character_channels;
        DELETE FROM world_narrative_prompt_messages;
        DELETE FROM world_narrative_contexts;
        DELETE FROM world_story_event_transitions;
        DELETE FROM world_character_observations;
        DELETE FROM world_character_relationships;
        DELETE FROM world_story_event_participants;
        DELETE FROM world_story_events;
        DELETE FROM world_conversation_messages;
        DELETE FROM world_conversation_turns;
        DELETE FROM world_conversations;
        DELETE FROM world_event_participants;
        DELETE FROM world_events;
        DELETE FROM world_attribute_events;
        DELETE FROM world_attribute_values;
        DELETE FROM character_world_attribute_values;
        DELETE FROM world_attribute_definitions;
        DELETE FROM character_activity_plans;
        DELETE FROM character_runtime_states;
        DELETE FROM character_autonomy_policies;
        DELETE FROM character_world_memberships;
        DELETE FROM role_places;
        DELETE FROM role_worlds;
        DELETE FROM schedule_items;
        DELETE FROM user_insight_observations;
        DELETE FROM pending_real_mutations;
        DELETE FROM group_chats;
        DELETE FROM private_message_inbox;
        DELETE FROM interaction_transition_events;
        DELETE FROM conversation_interaction_states;
        DELETE FROM character_agent_skill_packages;
        DELETE FROM character_owned_skill_proposals;
        DELETE FROM character_owned_skill_evaluations;
        DELETE FROM character_owned_skill_versions;
        DELETE FROM character_owned_skill_packages;
        DELETE FROM character_collaboration_profiles;
        DELETE FROM rp_memories_fts;
        DELETE FROM rp_memories;
        DELETE FROM scene_states;
        DELETE FROM role_sessions;
        DELETE FROM characters;
        DELETE FROM meeting_presets;
        DELETE FROM user_profiles;
        DELETE FROM agent_module_provider_settings;
        DELETE FROM execution_jobs;
        DELETE FROM subagent_jobs;
        DELETE FROM agent_skill_space_settings;
        DELETE FROM agent_module_settings;
        DELETE FROM memory_extraction_jobs;
        DELETE FROM context_economics;
        DELETE FROM memory_context_sessions;
        DELETE FROM memory_context_items;
        DELETE FROM memory_retrieval_stats;
        DELETE FROM task_bench_reports;
        DELETE FROM model_context_traces;
        DELETE FROM context_log_summaries;
        DELETE FROM audit_actions;
      `);
    });
  }
}
