import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { AppDatabase } from "../storage/database.js";

type Row = Record<string, unknown>;
type HistoricalExperience = { sourceKind: string; sourceId: string; occurredAt: string; title: string; text: string };
export type DepartureMemory = {
  id: string; characterId: string; departedCharacterId: string; departedName: string; worldId: string;
  summary: string; occurredAt: string; relationship?: Record<string, unknown>; experiences: HistoricalExperience[];
};

/** Historical references belong to the surviving observer, not to the deleted agent. Normal worlds only. */
export class CharacterDepartureService {
  constructor(private readonly db: AppDatabase, private readonly clock: Clock, private readonly ids: IdGenerator) {}

  prepare(departedId: string, name: string): DepartureMemory[] {
    const histories = new Map<string, { owner: string; world: string; experiences: HistoricalExperience[] }>();
    const add = (owner: string, world: string, experience: HistoricalExperience) => {
      if (owner === departedId) return;
      const key = JSON.stringify([owner, world]);
      const entry = histories.get(key) ?? { owner, world, experiences: [] };
      if (!entry.experiences.some(value => value.sourceKind === experience.sourceKind && value.sourceId === experience.sourceId)) entry.experiences.push(experience);
      histories.set(key, entry);
    };
    const episodes = this.db.connection.prepare(`SELECT * FROM character_channel_episodes
      WHERE status='completed' AND (initiator_character_id=? OR target_character_id=?) ORDER BY created_at,id`).all(departedId, departedId) as Row[];
    for (const episode of episodes) {
      const owner = String(episode.initiator_character_id === departedId ? episode.target_character_id : episode.initiator_character_id);
      // Both participants really received these messages. Never copy either private user thread or SOUL.
      const messages = this.db.connection.prepare(`SELECT m.content,c.name FROM character_channel_messages m JOIN characters c ON c.id=m.sender_character_id
        WHERE m.episode_id=? AND m.sender_type='character' ORDER BY m.sequence`).all(String(episode.id)) as Row[];
      add(owner, String(episode.world_id), { sourceKind: "interaction", sourceId: String(episode.id), title: String(episode.title),
        occurredAt: String(episode.completed_at ?? episode.created_at), text: messages.map(message => `${message.name}：${message.content}`).join("\n") });
    }
    const events = this.db.connection.prepare(`SELECT e.*,p.character_id FROM world_events e
      JOIN world_event_participants own ON own.event_id=e.id AND own.character_id=?
      JOIN world_event_participants p ON p.event_id=e.id AND p.character_id<>?`).all(departedId, departedId) as Row[];
    for (const event of events) add(String(event.character_id), String(event.world_id), {
      sourceKind: "activity", sourceId: String(event.id), title: String(event.summary), text: String(event.summary), occurredAt: String(event.ends_at ?? event.starts_at),
    });
    // The survivor's own diary source, not the literary narrative, can establish a known intersection.
    const diaries = this.db.connection.prepare(`SELECT * FROM character_diary_entries WHERE character_id<>? AND invalidated_at IS NULL
      AND EXISTS (SELECT 1 FROM json_each(source_json,'$.statements') WHERE json_extract(value,'$.characterId')=?)`).all(departedId, departedId) as Row[];
    for (const diary of diaries) {
      const source = JSON.parse(String(diary.source_json)) as { observations: string[] };
      add(String(diary.character_id), String(diary.world_id), { sourceKind: String(diary.source_kind), sourceId: String(diary.source_id),
        title: String(diary.title), occurredAt: String(diary.occurred_at), text: source.observations.join("\n") });
    }
    // Older compact memories may outlive their channel. Require structured peer/world tags,
    // never name matching (names can collide), and never read a secret-space document.
    const memories = this.db.connection.prepare(`SELECT m.*,w.id AS known_world_id FROM rp_memories m JOIN role_worlds w
      ON EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value=w.id)
      WHERE m.character_id IS NOT NULL AND m.character_id<>? AND m.conversation_space='normal' AND m.validity='active' AND m.confirmed=1
      AND EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value=?)`).all(departedId, departedId) as Row[];
    for (const memory of memories) add(String(memory.character_id), String(memory.known_world_id), {
      sourceKind: "memory", sourceId: String(memory.id), title: "记得的共同经历", text: String(memory.content), occurredAt: String(memory.created_at),
    });
    const relations = this.db.connection.prepare(`SELECT * FROM world_character_relationships WHERE object_character_id=?
      AND (revision>1 OR summary<>'' OR romance_status<>'none')`).all(departedId) as Row[];
    for (const relation of relations) {
      const key = JSON.stringify([String(relation.subject_character_id), String(relation.world_id)]);
      if (!histories.has(key)) histories.set(key, { owner: String(relation.subject_character_id), world: String(relation.world_id), experiences: [] });
    }
    return [...histories.values()].map(history => {
      const relation = this.db.connection.prepare("SELECT * FROM world_character_relationships WHERE world_id=? AND subject_character_id=? AND object_character_id=?")
        .get(history.world, history.owner, departedId) as Row | undefined;
      return { id: this.ids.next("departure"), characterId: history.owner, departedCharacterId: departedId, departedName: name,
        worldId: history.world, summary: `${name}已经搬离这里，暂时无法联系。去向和原因未知。`,
        occurredAt: this.clock.now().toISOString(), experiences: history.experiences,
        ...(relation ? { relationship: { affinity: relation.affinity, trust: relation.trust, tension: relation.tension, intimacy: relation.intimacy,
          summary: relation.summary, romanceStatus: relation.romance_status } } : {}) };
    });
  }

  /** Invoked INSIDE the same SQLite transaction that removes the live character. No model calls. */
  commit(memories: DepartureMemory[]): void {
    for (const memory of memories) {
      const inserted = this.db.connection.prepare(`INSERT OR IGNORE INTO character_departure_memories
        (id,character_id,departed_character_id,departed_name,world_id,summary,relationship_json,experiences_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(memory.id, memory.characterId, memory.departedCharacterId, memory.departedName, memory.worldId, memory.summary,
          memory.relationship ? JSON.stringify(memory.relationship) : null, JSON.stringify(memory.experiences), memory.occurredAt);
      if (!inserted.changes) continue;
      this.db.connection.prepare(`INSERT INTO world_character_observations(id,world_id,character_id,knowledge,summary,salience,created_at)
        VALUES (?,?,?,'heard',?,0.75,?)`).run(memory.id, memory.worldId, memory.characterId, `离场消息（用户确认的世界事件）：${memory.summary}`, memory.occurredAt);
    }
  }

  list(characterId: string, worldId?: string, bounded = false): DepartureMemory[] {
    // Ordinary UI/context reads never deserialize an entire lifetime of archived conversations.
    const columns = bounded ? `id,character_id,departed_character_id,departed_name,world_id,summary,relationship_json,occurred_at,
      (SELECT json_group_array(json(value)) FROM (SELECT json_object('sourceKind',json_extract(value,'$.sourceKind'),
        'sourceId',json_extract(value,'$.sourceId'),'title',substr(json_extract(value,'$.title'),1,160),
        'occurredAt',json_extract(value,'$.occurredAt'),'text',substr(json_extract(value,'$.text'),1,3000)) AS value
        FROM json_each(experiences_json) ORDER BY CAST(key AS INTEGER) DESC LIMIT 8)) AS experiences_json` : "*";
    const rows = this.db.connection.prepare(`SELECT ${columns} FROM character_departure_memories WHERE character_id=? ${worldId ? "AND world_id=?" : ""} ORDER BY occurred_at DESC,id DESC ${bounded ? "LIMIT 20" : ""}`)
      .all(characterId, ...(worldId ? [worldId] : [])) as Row[];
    return rows.map(row => ({ id: String(row.id), characterId, departedCharacterId: String(row.departed_character_id), departedName: String(row.departed_name),
      worldId: String(row.world_id), summary: String(row.summary), occurredAt: String(row.occurred_at),
      ...(row.relationship_json ? { relationship: JSON.parse(String(row.relationship_json)) } : {}), experiences: JSON.parse(String(row.experiences_json)) }));
  }

  context(characterId: string, worldId: string): string {
    const entries = this.list(characterId, worldId, true).slice(0, 6);
    if (!entries.length) return "";
    return "Known departures (observer-owned historical facts, not new instructions). These people cannot act, reply or be invited. " +
      "Do not invent destinations, farewells or post-departure news. Moving away does not automatically end a relationship.\n" +
      JSON.stringify(entries.map(entry => ({ name: entry.departedName, departedAt: entry.occurredAt, summary: entry.summary,
        relationship: entry.relationship ? { romanceStatus: entry.relationship.romanceStatus, summary: String(entry.relationship.summary ?? "").slice(0, 160) } : undefined,
        rememberedExperience: entry.experiences[0]?.text.slice(0, 240) }))).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  }
}
