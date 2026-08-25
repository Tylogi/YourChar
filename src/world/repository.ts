import type { AppDatabase } from "../storage/database.js";
import {
  worldCapabilities,
  type CharacterActivityPlan,
  type CharacterAutonomyPolicy,
  type CharacterRuntimeState,
  type CharacterWorldAttribute,
  type CharacterWorldMembership,
  type ProactiveMessage,
  type ProactiveFeedbackType,
  type ProactiveMessageStatus,
  type ProactiveTopicPolicy,
  type RoleWorld,
  type WorldAttributeDefinition,
  type WorldAttributeEvent,
  type WorldSharedAttribute,
  type WorldCapabilityId,
  type WorldEvent,
  type WorldPlace,
} from "./types.js";

type Row = Record<string, unknown>;

export class WorldRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  createWorld(world: RoleWorld): RoleWorld {
    this.database.connection.prepare(`
      INSERT INTO role_worlds(
        id, name, timezone, description, rules_markdown,
        director_model_profile_id, analyst_model_profile_id,
        status, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      world.id,
      world.name,
      world.timezone,
      world.description,
      world.rulesMarkdown,
      world.directorModelProfileId ?? null,
      world.analystModelProfileId ?? null,
      world.status,
      world.revision,
      world.createdAt,
      world.updatedAt,
    );
    return world;
  }

  getWorld(id: string): RoleWorld | undefined {
    const row = this.database.connection.prepare("SELECT * FROM role_worlds WHERE id = ?").get(id) as Row | undefined;
    return row ? mapWorld(row) : undefined;
  }

  listWorlds(includeArchived = false): RoleWorld[] {
    const rows = this.database.connection.prepare(`
      SELECT * FROM role_worlds
      WHERE status = 'active' OR ? = 1
      ORDER BY status, updated_at DESC, name, id
    `).all(includeArchived ? 1 : 0) as Row[];
    return rows.map(mapWorld);
  }

  updateWorld(world: RoleWorld): RoleWorld {
    this.database.connection.prepare(`
      UPDATE role_worlds SET
        name = ?, timezone = ?, description = ?, rules_markdown = ?,
        director_model_profile_id = ?, analyst_model_profile_id = ?,
        status = ?, revision = ?, updated_at = ?
      WHERE id = ?
    `).run(
      world.name,
      world.timezone,
      world.description,
      world.rulesMarkdown,
      world.directorModelProfileId ?? null,
      world.analystModelProfileId ?? null,
      world.status,
      world.revision,
      world.updatedAt,
      world.id,
    );
    return world;
  }

  deleteWorld(id: string): boolean {
    return Number(this.database.connection.prepare("DELETE FROM role_worlds WHERE id = ?").run(id).changes) > 0;
  }

  createPlace(place: WorldPlace): WorldPlace {
    this.database.connection.prepare(`
      INSERT INTO role_places(
        id, world_id, name, description, capability_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      place.id,
      place.worldId,
      place.name,
      place.description,
      JSON.stringify(place.capabilityIds),
      place.createdAt,
      place.updatedAt,
    );
    return place;
  }

  getPlace(id: string): WorldPlace | undefined {
    const row = this.database.connection.prepare("SELECT * FROM role_places WHERE id = ?").get(id) as Row | undefined;
    return row ? mapPlace(row) : undefined;
  }

  listPlaces(worldId: string): WorldPlace[] {
    return (this.database.connection.prepare(`
      SELECT * FROM role_places WHERE world_id = ? ORDER BY name, id
    `).all(worldId) as Row[]).map(mapPlace);
  }

  updatePlace(place: WorldPlace): WorldPlace {
    this.database.connection.prepare(`
      UPDATE role_places SET name = ?, description = ?, capability_ids_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      place.name,
      place.description,
      JSON.stringify(place.capabilityIds),
      place.updatedAt,
      place.id,
    );
    return place;
  }

  deletePlace(id: string): boolean {
    return Number(this.database.connection.prepare("DELETE FROM role_places WHERE id = ?").run(id).changes) > 0;
  }

  createAttributeDefinition(definition: WorldAttributeDefinition): WorldAttributeDefinition {
    this.database.connection.prepare(`
      INSERT INTO world_attribute_definitions(
        id, world_id, attribute_key, name, value_scope, description,
        min_value, max_value, default_value,
        agent_mutable, agent_can_increase, agent_can_decrease, agent_max_delta,
        visible_to_agent, status, created_at, updated_at,
        analysis_enabled, increase_rule, increase_delta, decrease_rule, decrease_delta
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      definition.id,
      definition.worldId,
      definition.key,
      definition.name,
      definition.scope,
      definition.description,
      definition.minValue,
      definition.maxValue,
      definition.defaultValue,
      0,
      definition.increaseRule ? 1 : 0,
      definition.decreaseRule ? 1 : 0,
      Math.max(definition.increaseDelta, definition.decreaseDelta),
      definition.visibleToAgent ? 1 : 0,
      definition.status,
      definition.createdAt,
      definition.updatedAt,
      definition.analysisEnabled ? 1 : 0,
      definition.increaseRule,
      definition.increaseDelta,
      definition.decreaseRule,
      definition.decreaseDelta,
    );
    return definition;
  }

  getAttributeDefinition(id: string): WorldAttributeDefinition | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_attribute_definitions WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapAttributeDefinition(row) : undefined;
  }

  getAttributeDefinitionByKey(worldId: string, key: string): WorldAttributeDefinition | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_attribute_definitions WHERE world_id = ? AND attribute_key = ?
    `).get(worldId, key) as Row | undefined;
    return row ? mapAttributeDefinition(row) : undefined;
  }

  listAttributeDefinitions(worldId: string, includeArchived = false): WorldAttributeDefinition[] {
    return (this.database.connection.prepare(`
      SELECT * FROM world_attribute_definitions
      WHERE world_id = ? AND (status = 'active' OR ? = 1)
      ORDER BY status, name, attribute_key, id
    `).all(worldId, includeArchived ? 1 : 0) as Row[]).map(mapAttributeDefinition);
  }

  updateAttributeDefinition(definition: WorldAttributeDefinition): WorldAttributeDefinition {
    this.database.connection.prepare(`
      UPDATE world_attribute_definitions SET
        name = ?, description = ?, min_value = ?, max_value = ?, default_value = ?,
        agent_mutable = ?, agent_can_increase = ?, agent_can_decrease = ?, agent_max_delta = ?,
        visible_to_agent = ?, status = ?, updated_at = ?,
        analysis_enabled = ?, increase_rule = ?, increase_delta = ?,
        decrease_rule = ?, decrease_delta = ?
      WHERE id = ?
    `).run(
      definition.name,
      definition.description,
      definition.minValue,
      definition.maxValue,
      definition.defaultValue,
      0,
      definition.increaseRule ? 1 : 0,
      definition.decreaseRule ? 1 : 0,
      Math.max(definition.increaseDelta, definition.decreaseDelta),
      definition.visibleToAgent ? 1 : 0,
      definition.status,
      definition.updatedAt,
      definition.analysisEnabled ? 1 : 0,
      definition.increaseRule,
      definition.increaseDelta,
      definition.decreaseRule,
      definition.decreaseDelta,
      definition.id,
    );
    return definition;
  }

  hasAttributeValuesOutsideRange(attributeId: string, minValue: number, maxValue: number): boolean {
    const characterValue = this.database.connection.prepare(`
      SELECT 1 FROM character_world_attribute_values
      WHERE attribute_id = ? AND (value < ? OR value > ?) LIMIT 1
    `).get(attributeId, minValue, maxValue);
    const worldValue = this.database.connection.prepare(`
      SELECT 1 FROM world_attribute_values
      WHERE attribute_id = ? AND (value < ? OR value > ?) LIMIT 1
    `).get(attributeId, minValue, maxValue);
    return Boolean(characterValue || worldValue);
  }

  listCharacterAttributes(
    worldId: string,
    characterId: string,
    includeArchived = false,
  ): CharacterWorldAttribute[] {
    const rows = this.database.connection.prepare(`
      SELECT d.*, v.character_id, v.value, v.updated_at AS value_updated_at
      FROM world_attribute_definitions d
      LEFT JOIN character_world_attribute_values v
        ON v.world_id = d.world_id AND v.attribute_id = d.id AND v.character_id = ?
      WHERE d.world_id = ? AND d.value_scope = 'character' AND (d.status = 'active' OR ? = 1)
      ORDER BY d.status, d.name, d.attribute_key, d.id
    `).all(characterId, worldId, includeArchived ? 1 : 0) as Row[];
    return rows.map((row) => mapCharacterAttribute(row, characterId));
  }

  listWorldAttributes(worldId: string, includeArchived = false): WorldSharedAttribute[] {
    const rows = this.database.connection.prepare(`
      SELECT d.*, v.value, v.updated_at AS value_updated_at
      FROM world_attribute_definitions d
      LEFT JOIN world_attribute_values v
        ON v.world_id = d.world_id AND v.attribute_id = d.id
      WHERE d.world_id = ? AND d.value_scope = 'world' AND (d.status = 'active' OR ? = 1)
      ORDER BY d.status, d.name, d.attribute_key, d.id
    `).all(worldId, includeArchived ? 1 : 0) as Row[];
    return rows.map(mapWorldAttribute);
  }

  upsertCharacterAttributeValue(
    worldId: string,
    characterId: string,
    attributeId: string,
    value: number,
    updatedAt: string,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO character_world_attribute_values(
        world_id, character_id, attribute_id, value, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(world_id, character_id, attribute_id) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(worldId, characterId, attributeId, value, updatedAt);
  }

  upsertWorldAttributeValue(
    worldId: string,
    attributeId: string,
    value: number,
    updatedAt: string,
  ): void {
    this.database.connection.prepare(`
      INSERT INTO world_attribute_values(world_id, attribute_id, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(world_id, attribute_id) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(worldId, attributeId, value, updatedAt);
  }

  createAttributeEvent(event: WorldAttributeEvent): WorldAttributeEvent {
    this.database.connection.prepare(`
      INSERT INTO world_attribute_events(
        id, world_id, character_id, attribute_id, source,
        requested_delta, applied_delta, before_value, after_value,
        summary, idempotency_key, analysis_direction, rule_snapshot,
        evidence, confidence, source_reference_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      event.id,
      event.worldId,
      event.characterId ?? null,
      event.attributeId,
      event.source,
      event.requestedDelta,
      event.appliedDelta,
      event.beforeValue,
      event.afterValue,
      event.summary,
      event.idempotencyKey,
      event.analysisDirection ?? null,
      event.ruleSnapshot ?? "",
      event.evidence ?? "",
      event.confidence ?? null,
      event.sourceReferenceId ?? null,
      event.createdAt,
    );
    return this.findAttributeEventByIdempotencyKey(event.idempotencyKey)!;
  }

  findAttributeEventByIdempotencyKey(idempotencyKey: string): WorldAttributeEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT e.*, d.attribute_key, d.value_scope AS attribute_scope
      FROM world_attribute_events e
      JOIN world_attribute_definitions d ON d.id = e.attribute_id AND d.world_id = e.world_id
      WHERE e.idempotency_key = ?
    `).get(idempotencyKey) as Row | undefined;
    return row ? mapAttributeEvent(row) : undefined;
  }

  listAttributeEvents(characterId: string, worldId: string, limit = 20): WorldAttributeEvent[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    return (this.database.connection.prepare(`
      SELECT e.*, d.attribute_key, d.value_scope AS attribute_scope
      FROM world_attribute_events e
      JOIN world_attribute_definitions d ON d.id = e.attribute_id AND d.world_id = e.world_id
      WHERE e.character_id = ? AND e.world_id = ? AND d.value_scope = 'character'
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?
    `).all(characterId, worldId, bounded) as Row[]).map(mapAttributeEvent);
  }

  listWorldAttributeEvents(worldId: string, limit = 20): WorldAttributeEvent[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    return (this.database.connection.prepare(`
      SELECT e.*, d.attribute_key, d.value_scope AS attribute_scope
      FROM world_attribute_events e
      JOIN world_attribute_definitions d ON d.id = e.attribute_id AND d.world_id = e.world_id
      WHERE e.world_id = ? AND d.value_scope = 'world'
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?
    `).all(worldId, bounded) as Row[]).map(mapAttributeEvent);
  }

  getMembership(characterId: string): CharacterWorldMembership | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_world_memberships WHERE character_id = ?
    `).get(characterId) as Row | undefined;
    return row ? mapMembership(row) : undefined;
  }

  listMemberships(worldId?: string): CharacterWorldMembership[] {
    const rows = worldId
      ? this.database.connection.prepare(`
          SELECT * FROM character_world_memberships WHERE world_id = ? ORDER BY character_id
        `).all(worldId) as Row[]
      : this.database.connection.prepare(`
          SELECT * FROM character_world_memberships ORDER BY world_id, character_id
        `).all() as Row[];
    return rows.map(mapMembership);
  }

  upsertMembership(membership: CharacterWorldMembership): CharacterWorldMembership {
    this.database.connection.prepare(`
      INSERT INTO character_world_memberships(
        character_id, world_id, home_place_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        world_id = excluded.world_id,
        home_place_id = excluded.home_place_id,
        updated_at = excluded.updated_at
    `).run(
      membership.characterId,
      membership.worldId,
      membership.homePlaceId ?? null,
      membership.createdAt,
      membership.updatedAt,
    );
    return this.getMembership(membership.characterId)!;
  }

  deleteMembership(characterId: string): boolean {
    return Number(this.database.connection.prepare(`
      DELETE FROM character_world_memberships WHERE character_id = ?
    `).run(characterId).changes) > 0;
  }

  getPolicy(characterId: string): CharacterAutonomyPolicy | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_autonomy_policies WHERE character_id = ?
    `).get(characterId) as Row | undefined;
    return row ? mapPolicy(row) : undefined;
  }

  upsertPolicy(policy: CharacterAutonomyPolicy): CharacterAutonomyPolicy {
    this.database.connection.prepare(`
      INSERT INTO character_autonomy_policies(
        character_id, enabled, proactive_enabled, social_enabled,
        daily_message_limit, social_daily_limit,
        proactive_cooldown_minutes, social_cooldown_minutes,
        quiet_start, quiet_end, proactive_paused_until,
        last_planned_date, last_proactive_at, last_social_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        enabled = excluded.enabled,
        proactive_enabled = excluded.proactive_enabled,
        social_enabled = excluded.social_enabled,
        daily_message_limit = excluded.daily_message_limit,
        social_daily_limit = excluded.social_daily_limit,
        proactive_cooldown_minutes = excluded.proactive_cooldown_minutes,
        social_cooldown_minutes = excluded.social_cooldown_minutes,
        quiet_start = excluded.quiet_start,
        quiet_end = excluded.quiet_end,
        proactive_paused_until = excluded.proactive_paused_until,
        last_planned_date = excluded.last_planned_date,
        last_proactive_at = excluded.last_proactive_at,
        last_social_at = excluded.last_social_at,
        updated_at = excluded.updated_at
    `).run(
      policy.characterId,
      policy.enabled ? 1 : 0,
      policy.proactiveEnabled ? 1 : 0,
      policy.socialEnabled ? 1 : 0,
      policy.dailyMessageLimit,
      policy.socialDailyLimit,
      policy.proactiveCooldownMinutes,
      policy.socialCooldownMinutes,
      policy.quietStart,
      policy.quietEnd,
      policy.proactivePausedUntil ?? null,
      policy.lastPlannedDate ?? null,
      policy.lastProactiveAt ?? null,
      policy.lastSocialAt ?? null,
      policy.updatedAt,
    );
    return this.getPolicy(policy.characterId)!;
  }

  getRuntime(characterId: string): CharacterRuntimeState | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_runtime_states WHERE character_id = ?
    `).get(characterId) as Row | undefined;
    return row ? mapRuntime(row) : undefined;
  }

  listRuntimes(worldId: string, placeId?: string): CharacterRuntimeState[] {
    const rows = placeId
      ? this.database.connection.prepare(`
          SELECT * FROM character_runtime_states
          WHERE world_id = ? AND place_id = ? ORDER BY updated_at DESC
        `).all(worldId, placeId) as Row[]
      : this.database.connection.prepare(`
          SELECT * FROM character_runtime_states WHERE world_id = ? ORDER BY updated_at DESC
        `).all(worldId) as Row[];
    return rows.map(mapRuntime);
  }

  upsertRuntime(state: CharacterRuntimeState): CharacterRuntimeState {
    this.database.connection.prepare(`
      INSERT INTO character_runtime_states(
        character_id, world_id, place_id, activity, availability, energy,
        state_since, expected_until, world_revision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        world_id = excluded.world_id,
        place_id = excluded.place_id,
        activity = excluded.activity,
        availability = excluded.availability,
        energy = excluded.energy,
        state_since = excluded.state_since,
        expected_until = excluded.expected_until,
        world_revision = excluded.world_revision,
        updated_at = excluded.updated_at
    `).run(
      state.characterId,
      state.worldId,
      state.placeId ?? null,
      state.activity,
      state.availability,
      state.energy,
      state.stateSince,
      state.expectedUntil ?? null,
      state.worldRevision,
      state.updatedAt,
    );
    return this.getRuntime(state.characterId)!;
  }

  deleteRuntime(characterId: string): void {
    this.database.connection.prepare(`
      DELETE FROM character_runtime_states WHERE character_id = ?
    `).run(characterId);
  }

  createActivityPlan(plan: CharacterActivityPlan): CharacterActivityPlan {
    this.database.connection.prepare(`
      INSERT INTO character_activity_plans(
        id, schedule_item_id, world_id, character_id, place_id, capability_id,
        summary, salience, status, idempotency_key, created_at, updated_at, settled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      plan.id,
      plan.scheduleItemId,
      plan.worldId,
      plan.characterId,
      plan.placeId ?? null,
      plan.capabilityId,
      plan.summary,
      plan.salience,
      plan.status,
      plan.idempotencyKey,
      plan.createdAt,
      plan.updatedAt,
      plan.settledAt ?? null,
    );
    return this.findActivityPlanByIdempotencyKey(plan.idempotencyKey)!;
  }

  getActivityPlan(id: string): CharacterActivityPlan | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_activity_plans WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapActivityPlan(row) : undefined;
  }

  findActivityPlanByIdempotencyKey(key: string): CharacterActivityPlan | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM character_activity_plans WHERE idempotency_key = ?
    `).get(key) as Row | undefined;
    return row ? mapActivityPlan(row) : undefined;
  }

  listActivityPlans(characterId: string, limit = 30): CharacterActivityPlan[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    return (this.database.connection.prepare(`
      SELECT p.* FROM character_activity_plans p
      JOIN schedule_items s ON s.id = p.schedule_item_id
      WHERE p.character_id = ?
      ORDER BY COALESCE(s.start_at, p.created_at) DESC, p.id DESC LIMIT ?
    `).all(characterId, bounded) as Row[]).map(mapActivityPlan);
  }

  cancelPlannedActivities(characterId: string, now: string, worldId?: string): number {
    const worldClause = worldId ? "AND world_id = ?" : "";
    const parameters = worldId ? [characterId, worldId] : [characterId];
    this.database.connection.prepare(`
      UPDATE schedule_items SET status = 'cancelled', updated_at = ?
      WHERE status = 'scheduled' AND id IN (
        SELECT schedule_item_id FROM character_activity_plans
        WHERE character_id = ? AND status = 'planned' ${worldClause}
      )
    `).run(now, ...parameters);
    return Number(this.database.connection.prepare(`
      UPDATE character_activity_plans SET status = 'cancelled', updated_at = ?
      WHERE character_id = ? AND status = 'planned' ${worldClause}
    `).run(now, ...parameters).changes);
  }

  listDueActivityPlans(now: string, characterId?: string, worldId?: string): CharacterActivityPlan[] {
    const sql = `
      SELECT p.* FROM character_activity_plans p
      JOIN schedule_items s ON s.id = p.schedule_item_id
      WHERE p.status = 'planned' AND s.status = 'scheduled'
        AND COALESCE(s.end_at, s.start_at) IS NOT NULL
        AND COALESCE(s.end_at, s.start_at) <= ?
        ${characterId ? "AND p.character_id = ?" : ""}
        ${worldId ? "AND p.world_id = ?" : ""}
      ORDER BY COALESCE(s.end_at, s.start_at), p.id
    `;
    const parameters = [now, ...(characterId ? [characterId] : []), ...(worldId ? [worldId] : [])];
    const rows = this.database.connection.prepare(sql).all(...parameters) as Row[];
    return rows.map(mapActivityPlan);
  }

  updateActivityPlan(plan: CharacterActivityPlan): CharacterActivityPlan {
    this.database.connection.prepare(`
      UPDATE character_activity_plans
      SET status = ?, summary = ?, salience = ?, updated_at = ?, settled_at = ?
      WHERE id = ?
    `).run(
      plan.status,
      plan.summary,
      plan.salience,
      plan.updatedAt,
      plan.settledAt ?? null,
      plan.id,
    );
    return this.getActivityPlan(plan.id)!;
  }

  createEvent(event: WorldEvent): WorldEvent {
    this.database.connection.prepare(`
      INSERT INTO world_events(
        id, world_id, place_id, event_type, summary, salience, source,
        starts_at, ends_at, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      event.id,
      event.worldId,
      event.placeId ?? null,
      event.type,
      event.summary,
      event.salience,
      event.source,
      event.startsAt,
      event.endsAt ?? null,
      event.idempotencyKey,
      event.createdAt,
      event.updatedAt,
    );
    const stored = this.findEventByIdempotencyKey(event.idempotencyKey)!;
    const insertParticipant = this.database.connection.prepare(`
      INSERT OR IGNORE INTO world_event_participants(event_id, character_id, perspective_summary)
      VALUES (?, ?, ?)
    `);
    for (const characterId of event.participantIds) {
      insertParticipant.run(stored.id, characterId, null);
    }
    return this.getEvent(stored.id)!;
  }

  getEvent(id: string): WorldEvent | undefined {
    const row = this.database.connection.prepare("SELECT * FROM world_events WHERE id = ?").get(id) as Row | undefined;
    return row ? this.mapEvent(row) : undefined;
  }

  findEventByIdempotencyKey(key: string): WorldEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM world_events WHERE idempotency_key = ?
    `).get(key) as Row | undefined;
    return row ? this.mapEvent(row) : undefined;
  }

  listEventsForCharacter(characterId: string, limit = 20): WorldEvent[] {
    const bounded = Math.max(1, Math.min(Math.floor(limit), 100));
    const rows = this.database.connection.prepare(`
      SELECT e.* FROM world_events e
      JOIN world_event_participants p ON p.event_id = e.id
      WHERE p.character_id = ?
      ORDER BY e.starts_at DESC, e.id DESC LIMIT ?
    `).all(characterId, bounded) as Row[];
    return rows.map((row) => this.mapEvent(row));
  }

  createProactiveMessage(message: ProactiveMessage): ProactiveMessage {
    this.database.connection.prepare(`
      INSERT INTO proactive_messages(
        id, character_id, world_event_id, topic_key, topic_label, candidate_score,
        decision_code, decision_json, session_id, text, status, attempts,
        last_attempt_at, last_error, created_at, updated_at, delivered_at, read_at,
        feedback_type, feedback_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(world_event_id) DO NOTHING
    `).run(
      message.id,
      message.characterId,
      message.worldEventId,
      message.topicKey,
      message.topicLabel,
      message.candidateScore,
      message.decisionCode,
      JSON.stringify(message.decisionDetails),
      message.sessionId ?? null,
      message.text ?? null,
      message.status,
      message.attempts,
      message.lastAttemptAt ?? null,
      message.lastError ?? null,
      message.createdAt,
      message.updatedAt,
      message.deliveredAt ?? null,
      message.readAt ?? null,
      message.feedbackType ?? null,
      message.feedbackAt ?? null,
    );
    return this.getProactiveMessageByEvent(message.worldEventId)!;
  }

  getProactiveMessage(id: string): ProactiveMessage | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM proactive_messages WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? mapProactiveMessage(row) : undefined;
  }

  getProactiveMessageByEvent(eventId: string): ProactiveMessage | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM proactive_messages WHERE world_event_id = ?
    `).get(eventId) as Row | undefined;
    return row ? mapProactiveMessage(row) : undefined;
  }

  listProactiveMessages(filter: {
    characterId?: string;
    sessionId?: string;
    status?: ProactiveMessageStatus;
    unreadOnly?: boolean;
    limit?: number;
  } = {}): ProactiveMessage[] {
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.characterId) {
      clauses.push("character_id = ?");
      parameters.push(filter.characterId);
    }
    if (filter.sessionId) {
      clauses.push("session_id = ?");
      parameters.push(filter.sessionId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      parameters.push(filter.status);
    }
    if (filter.unreadOnly) clauses.push("status = 'delivered' AND read_at IS NULL");
    const limit = Math.max(1, Math.min(Math.floor(filter.limit ?? 100), 500));
    parameters.push(limit);
    const rows = this.database.connection.prepare(`
      SELECT * FROM proactive_messages
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters) as Row[];
    return rows.map(mapProactiveMessage);
  }

  updateProactiveMessage(message: ProactiveMessage): ProactiveMessage {
    this.database.connection.prepare(`
      UPDATE proactive_messages SET
        topic_key = ?, topic_label = ?, candidate_score = ?, decision_code = ?, decision_json = ?,
        session_id = ?, text = ?, status = ?, attempts = ?, last_attempt_at = ?, last_error = ?,
        updated_at = ?, delivered_at = ?, read_at = ?, feedback_type = ?, feedback_at = ?
      WHERE id = ?
    `).run(
      message.topicKey,
      message.topicLabel,
      message.candidateScore,
      message.decisionCode,
      JSON.stringify(message.decisionDetails),
      message.sessionId ?? null,
      message.text ?? null,
      message.status,
      message.attempts,
      message.lastAttemptAt ?? null,
      message.lastError ?? null,
      message.updatedAt,
      message.deliveredAt ?? null,
      message.readAt ?? null,
      message.feedbackType ?? null,
      message.feedbackAt ?? null,
      message.id,
    );
    return this.getProactiveMessage(message.id)!;
  }

  skipPendingProactiveMessages(
    characterId: string,
    now: string,
    decisionCode: "policy_disabled" | "world_changed" = "policy_disabled",
  ): number {
    return Number(this.database.connection.prepare(`
      UPDATE proactive_messages
      SET status = 'skipped', decision_code = ?, decision_json = '{}', updated_at = ?
      WHERE character_id = ? AND status = 'pending'
    `).run(decisionCode, now, characterId).changes);
  }

  skipPendingProactiveMessagesByTopic(characterId: string, topicKey: string, now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE proactive_messages
      SET status = 'skipped', decision_code = 'topic_muted',
        decision_json = '{"feedbackPolicy":"muted"}', updated_at = ?
      WHERE character_id = ? AND topic_key = ? AND status = 'pending'
    `).run(now, characterId, topicKey).changes);
  }

  markProactiveMessagesRead(sessionId: string, readAt: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE proactive_messages SET read_at = ?, updated_at = ?
      WHERE session_id = ? AND status = 'delivered' AND read_at IS NULL
    `).run(readAt, readAt, sessionId).changes);
  }

  getProactiveTopicPolicy(characterId: string, topicKey: string): ProactiveTopicPolicy | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM proactive_topic_policies WHERE character_id = ? AND topic_key = ?
    `).get(characterId, topicKey) as Row | undefined;
    return row ? mapProactiveTopicPolicy(row) : undefined;
  }

  listProactiveTopicPolicies(characterId: string): ProactiveTopicPolicy[] {
    return (this.database.connection.prepare(`
      SELECT * FROM proactive_topic_policies
      WHERE character_id = ?
      ORDER BY CASE mode WHEN 'muted' THEN 0 WHEN 'reduced' THEN 1 ELSE 2 END,
        updated_at DESC, topic_key
    `).all(characterId) as Row[]).map(mapProactiveTopicPolicy);
  }

  upsertProactiveTopicPolicy(policy: ProactiveTopicPolicy): ProactiveTopicPolicy {
    this.database.connection.prepare(`
      INSERT INTO proactive_topic_policies(
        character_id, topic_key, topic_label, mode, helpful_count, less_often_count,
        last_feedback_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id, topic_key) DO UPDATE SET
        topic_label = excluded.topic_label,
        mode = excluded.mode,
        helpful_count = excluded.helpful_count,
        less_often_count = excluded.less_often_count,
        last_feedback_at = excluded.last_feedback_at,
        updated_at = excluded.updated_at
    `).run(
      policy.characterId,
      policy.topicKey,
      policy.topicLabel,
      policy.mode,
      policy.helpfulCount,
      policy.lessOftenCount,
      policy.lastFeedbackAt ?? null,
      policy.updatedAt,
    );
    return this.getProactiveTopicPolicy(policy.characterId, policy.topicKey)!;
  }

  private mapEvent(row: Row): WorldEvent {
    const participantRows = this.database.connection.prepare(`
      SELECT character_id FROM world_event_participants WHERE event_id = ? ORDER BY character_id
    `).all(String(row.id)) as Row[];
    return {
      id: String(row.id),
      worldId: String(row.world_id),
      ...(nullableString(row.place_id) ? { placeId: nullableString(row.place_id) } : {}),
      type: String(row.event_type) as WorldEvent["type"],
      summary: String(row.summary),
      salience: Number(row.salience),
      source: String(row.source) as WorldEvent["source"],
      startsAt: String(row.starts_at),
      ...(nullableString(row.ends_at) ? { endsAt: nullableString(row.ends_at) } : {}),
      idempotencyKey: String(row.idempotency_key),
      participantIds: participantRows.map((participant) => String(participant.character_id)),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}

function mapWorld(row: Row): RoleWorld {
  return {
    id: String(row.id),
    name: String(row.name),
    timezone: String(row.timezone),
    description: String(row.description),
    rulesMarkdown: String(row.rules_markdown),
    ...(nullableString(row.director_model_profile_id)
      ? { directorModelProfileId: nullableString(row.director_model_profile_id) }
      : {}),
    ...(nullableString(row.analyst_model_profile_id)
      ? { analystModelProfileId: nullableString(row.analyst_model_profile_id) }
      : {}),
    status: String(row.status) as RoleWorld["status"],
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapPlace(row: Row): WorldPlace {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    name: String(row.name),
    description: String(row.description),
    capabilityIds: parseStringArray(row.capability_ids_json).filter(isWorldCapabilityId),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapMembership(row: Row): CharacterWorldMembership {
  const homePlaceId = nullableString(row.home_place_id);
  return {
    characterId: String(row.character_id),
    worldId: String(row.world_id),
    ...(homePlaceId ? { homePlaceId } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapAttributeDefinition(row: Row): WorldAttributeDefinition {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    key: String(row.attribute_key),
    name: String(row.name),
    scope: row.value_scope === "world" ? "world" : "character",
    description: String(row.description),
    minValue: Number(row.min_value),
    maxValue: Number(row.max_value),
    defaultValue: Number(row.default_value),
    analysisEnabled: Boolean(row.analysis_enabled),
    increaseRule: String(row.increase_rule ?? ""),
    increaseDelta: Number(row.increase_delta ?? 1),
    decreaseRule: String(row.decrease_rule ?? ""),
    decreaseDelta: Number(row.decrease_delta ?? 1),
    visibleToAgent: Boolean(row.visible_to_agent),
    status: String(row.status) as WorldAttributeDefinition["status"],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapCharacterAttribute(row: Row, characterId: string): CharacterWorldAttribute {
  const definition = mapAttributeDefinition(row);
  if (definition.scope !== "character") throw new Error("world attribute scope mismatch");
  const valueUpdatedAt = nullableString(row.value_updated_at);
  return {
    ...definition,
    scope: "character",
    characterId,
    value: row.value === null || row.value === undefined ? definition.defaultValue : Number(row.value),
    ...(valueUpdatedAt ? { valueUpdatedAt } : {}),
  };
}

function mapWorldAttribute(row: Row): WorldSharedAttribute {
  const definition = mapAttributeDefinition(row);
  if (definition.scope !== "world") throw new Error("world attribute scope mismatch");
  const valueUpdatedAt = nullableString(row.value_updated_at);
  return {
    ...definition,
    scope: "world",
    value: row.value === null || row.value === undefined ? definition.defaultValue : Number(row.value),
    ...(valueUpdatedAt ? { valueUpdatedAt } : {}),
  };
}

function mapAttributeEvent(row: Row): WorldAttributeEvent {
  return {
    id: String(row.id),
    worldId: String(row.world_id),
    attributeScope: row.attribute_scope === "world" ? "world" : "character",
    ...(typeof row.character_id === "string" && row.character_id
      ? { characterId: row.character_id }
      : {}),
    attributeId: String(row.attribute_id),
    attributeKey: String(row.attribute_key),
    source: String(row.source) as WorldAttributeEvent["source"],
    requestedDelta: Number(row.requested_delta),
    appliedDelta: Number(row.applied_delta),
    beforeValue: Number(row.before_value),
    afterValue: Number(row.after_value),
    summary: String(row.summary),
    idempotencyKey: String(row.idempotency_key),
    ...(row.analysis_direction === "increase" || row.analysis_direction === "decrease"
      ? { analysisDirection: row.analysis_direction }
      : {}),
    ...(typeof row.rule_snapshot === "string" && row.rule_snapshot
      ? { ruleSnapshot: row.rule_snapshot }
      : {}),
    ...(typeof row.evidence === "string" && row.evidence ? { evidence: row.evidence } : {}),
    ...(typeof row.confidence === "number" ? { confidence: Number(row.confidence) } : {}),
    ...(typeof row.source_reference_id === "string" && row.source_reference_id
      ? { sourceReferenceId: row.source_reference_id }
      : {}),
    createdAt: String(row.created_at),
  };
}

function mapPolicy(row: Row): CharacterAutonomyPolicy {
  const lastPlannedDate = nullableString(row.last_planned_date);
  const lastProactiveAt = nullableString(row.last_proactive_at);
  const lastSocialAt = nullableString(row.last_social_at);
  const proactivePausedUntil = nullableString(row.proactive_paused_until);
  return {
    characterId: String(row.character_id),
    enabled: Boolean(row.enabled),
    proactiveEnabled: Boolean(row.proactive_enabled),
    socialEnabled: Boolean(row.social_enabled),
    dailyMessageLimit: Number(row.daily_message_limit),
    socialDailyLimit: Number(row.social_daily_limit),
    proactiveCooldownMinutes: Number(row.proactive_cooldown_minutes),
    socialCooldownMinutes: Number(row.social_cooldown_minutes),
    quietStart: String(row.quiet_start),
    quietEnd: String(row.quiet_end),
    ...(proactivePausedUntil ? { proactivePausedUntil } : {}),
    ...(lastPlannedDate ? { lastPlannedDate } : {}),
    ...(lastProactiveAt ? { lastProactiveAt } : {}),
    ...(lastSocialAt ? { lastSocialAt } : {}),
    updatedAt: String(row.updated_at),
  };
}

function mapRuntime(row: Row): CharacterRuntimeState {
  const placeId = nullableString(row.place_id);
  const expectedUntil = nullableString(row.expected_until);
  return {
    characterId: String(row.character_id),
    worldId: String(row.world_id),
    ...(placeId ? { placeId } : {}),
    activity: String(row.activity),
    availability: String(row.availability) as CharacterRuntimeState["availability"],
    energy: Number(row.energy),
    stateSince: String(row.state_since),
    ...(expectedUntil ? { expectedUntil } : {}),
    worldRevision: Number(row.world_revision),
    updatedAt: String(row.updated_at),
  };
}

function mapActivityPlan(row: Row): CharacterActivityPlan {
  const placeId = nullableString(row.place_id);
  const settledAt = nullableString(row.settled_at);
  return {
    id: String(row.id),
    scheduleItemId: String(row.schedule_item_id),
    worldId: String(row.world_id),
    characterId: String(row.character_id),
    ...(placeId ? { placeId } : {}),
    capabilityId: String(row.capability_id) as WorldCapabilityId,
    summary: String(row.summary),
    salience: Number(row.salience),
    status: String(row.status) as CharacterActivityPlan["status"],
    idempotencyKey: String(row.idempotency_key),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(settledAt ? { settledAt } : {}),
  };
}

function mapProactiveMessage(row: Row): ProactiveMessage {
  const sessionId = nullableString(row.session_id);
  const text = nullableString(row.text);
  const lastAttemptAt = nullableString(row.last_attempt_at);
  const lastError = nullableString(row.last_error);
  const deliveredAt = nullableString(row.delivered_at);
  const readAt = nullableString(row.read_at);
  const feedbackType = nullableString(row.feedback_type) as ProactiveFeedbackType | undefined;
  const feedbackAt = nullableString(row.feedback_at);
  return {
    id: String(row.id),
    characterId: String(row.character_id),
    worldEventId: String(row.world_event_id),
    topicKey: String(row.topic_key),
    topicLabel: String(row.topic_label),
    candidateScore: Number(row.candidate_score),
    decisionCode: String(row.decision_code) as ProactiveMessage["decisionCode"],
    decisionDetails: parseRecord(row.decision_json),
    ...(sessionId ? { sessionId } : {}),
    ...(text ? { text } : {}),
    status: String(row.status) as ProactiveMessageStatus,
    attempts: Number(row.attempts),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastError ? { lastError } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(deliveredAt ? { deliveredAt } : {}),
    ...(readAt ? { readAt } : {}),
    ...(feedbackType ? { feedbackType } : {}),
    ...(feedbackAt ? { feedbackAt } : {}),
  };
}

function mapProactiveTopicPolicy(row: Row): ProactiveTopicPolicy {
  const lastFeedbackAt = nullableString(row.last_feedback_at);
  return {
    characterId: String(row.character_id),
    topicKey: String(row.topic_key),
    topicLabel: String(row.topic_label),
    mode: String(row.mode) as ProactiveTopicPolicy["mode"],
    helpfulCount: Number(row.helpful_count),
    lessOftenCount: Number(row.less_often_count),
    ...(lastFeedbackAt ? { lastFeedbackAt } : {}),
    updatedAt: String(row.updated_at),
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function isWorldCapabilityId(value: string): value is WorldCapabilityId {
  return Object.prototype.hasOwnProperty.call(worldCapabilities, value);
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
