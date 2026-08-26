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
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE singleton = 1;
        DELETE FROM notification_outbox;
        DELETE FROM reminder_occurrences;
        DELETE FROM proactive_messages;
        DELETE FROM proactive_topic_policies;
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
        DELETE FROM agent_skill_space_settings;
        DELETE FROM agent_module_settings;
        DELETE FROM memory_extraction_jobs;
        DELETE FROM context_economics;
        DELETE FROM memory_context_sessions;
        DELETE FROM memory_context_items;
        DELETE FROM memory_retrieval_stats;
        DELETE FROM model_context_traces;
        DELETE FROM context_log_summaries;
        DELETE FROM audit_actions;
      `);
    });
  }
}
