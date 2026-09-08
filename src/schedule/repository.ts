import type { SQLInputValue } from "node:sqlite";
import type { AppDatabase } from "../storage/database.js";
import type {
  NotificationOutboxEntry,
  ReminderOccurrence,
  ReminderOccurrenceStatus,
  ScheduleItem,
  ScheduleListFilter,
} from "./types.js";

type ScheduleItemRow = {
  id: string;
  kind: ScheduleItem["kind"];
  title: string;
  notes: string | null;
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  all_day: number;
  recurrence_rule: string | null;
  status: ScheduleItem["status"];
  owner_type: ScheduleItem["ownerType"];
  character_id: string | null;
  source_session_id: string | null;
  reminder_json: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

type OccurrenceRow = {
  id: string;
  schedule_item_id: string;
  due_at: string;
  status: ReminderOccurrence["status"];
  snoozed_from_id: string | null;
  event_at: string | null;
  acknowledged_at: string | null;
  acknowledged_via: string | null;
  created_at: string;
  updated_at: string;
};

type OutboxRow = {
  id: string;
  occurrence_id: string;
  channel: string;
  status: NotificationOutboxEntry["status"];
  attempts: number;
  available_at: string;
  last_error: string | null;
  delivery_title: string | null;
  delivery_body: string | null;
  agent_generated: number;
  composed_at: string | null;
  suppressed_at: string | null;
  created_at: string;
  updated_at: string;
};

export class ScheduleRepository {
  constructor(readonly database: AppDatabase) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation);
  }

  createItem(item: ScheduleItem, idempotencyKey?: string): ScheduleItem {
    this.database.connection
      .prepare(`
        INSERT INTO schedule_items(
          id, kind, title, notes, start_at, end_at, timezone, all_day,
          recurrence_rule, status, owner_type, character_id, source_session_id,
          idempotency_key, created_at, updated_at, reminder_json, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        item.id,
        item.kind,
        item.title,
        item.notes ?? null,
        item.startAt ?? null,
        item.endAt ?? null,
        item.timezone,
        item.allDay ? 1 : 0,
        item.recurrenceRule ?? null,
        item.status,
        item.ownerType,
        item.characterId ?? null,
        item.sourceSessionId ?? null,
        idempotencyKey ?? null,
        item.createdAt,
        item.updatedAt,
        item.reminder ? JSON.stringify(item.reminder) : null,
        item.revision ?? 0,
      );
    return item;
  }

  findByIdempotencyKey(key: string): ScheduleItem | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM schedule_items WHERE idempotency_key = ?")
      .get(key) as ScheduleItemRow | undefined;
    return row ? mapItem(row) : undefined;
  }

  getItem(id: string): ScheduleItem | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM schedule_items WHERE id = ?")
      .get(id) as ScheduleItemRow | undefined;
    return row ? mapItem(row) : undefined;
  }

  listItems(filter: ScheduleListFilter = {}): ScheduleItem[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (filter.from) {
      clauses.push("start_at >= ?");
      values.push(filter.from);
    }
    if (filter.to) {
      clauses.push("start_at < ?");
      values.push(filter.to);
    }
    if (filter.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    if (filter.kind) {
      clauses.push("kind = ?");
      values.push(filter.kind);
    }
    if (filter.ownerType) {
      clauses.push("owner_type = ?");
      values.push(filter.ownerType);
    }
    if (filter.characterId) {
      clauses.push("character_id = ?");
      values.push(filter.characterId);
    }
    if (filter.query) {
      clauses.push("(title LIKE ? OR notes LIKE ?)");
      const query = `%${filter.query}%`;
      values.push(query, query);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.connection
      .prepare(`SELECT * FROM schedule_items ${where} ORDER BY COALESCE(start_at, created_at), id`)
      .all(...values) as ScheduleItemRow[];
    return rows.map(mapItem);
  }

  updateItem(item: ScheduleItem): ScheduleItem {
    this.database.connection
      .prepare(`
        UPDATE schedule_items SET
          kind = ?, title = ?, notes = ?, start_at = ?, end_at = ?, timezone = ?,
          all_day = ?, recurrence_rule = ?, status = ?, owner_type = ?, character_id = ?,
          source_session_id = ?, updated_at = ?, reminder_json = ?, revision = ?
        WHERE id = ?
      `)
      .run(
        item.kind,
        item.title,
        item.notes ?? null,
        item.startAt ?? null,
        item.endAt ?? null,
        item.timezone,
        item.allDay ? 1 : 0,
        item.recurrenceRule ?? null,
        item.status,
        item.ownerType,
        item.characterId ?? null,
        item.sourceSessionId ?? null,
        item.updatedAt,
        item.reminder ? JSON.stringify(item.reminder) : null,
        item.revision ?? 0,
        item.id,
      );
    return item;
  }

  createOccurrence(occurrence: ReminderOccurrence): ReminderOccurrence {
    this.database.connection
      .prepare(`
        INSERT OR IGNORE INTO reminder_occurrences(
          id, schedule_item_id, due_at, status, snoozed_from_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        occurrence.id,
        occurrence.scheduleItemId,
        occurrence.dueAt,
        occurrence.status,
        occurrence.snoozedFromId ?? null,
        occurrence.createdAt,
        occurrence.updatedAt,
      );
    const stored = this.getOccurrenceByItemAndTime(occurrence.scheduleItemId, occurrence.dueAt) ?? occurrence;
    this.database.connection.prepare("UPDATE reminder_occurrences SET event_at=? WHERE id=?").run(occurrence.eventAt ?? null, stored.id);
    if (stored.status === "cancelled" && occurrence.dueAt > occurrence.createdAt) {
      this.database.connection.prepare("UPDATE reminder_occurrences SET status='scheduled',updated_at=? WHERE id=?").run(occurrence.updatedAt,stored.id);
    }
    return this.getOccurrence(stored.id)!;
  }

  getOccurrence(id: string): ReminderOccurrence | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM reminder_occurrences WHERE id = ?")
      .get(id) as OccurrenceRow | undefined;
    return row ? mapOccurrence(row) : undefined;
  }

  getOccurrenceByItemAndTime(scheduleItemId: string, dueAt: string): ReminderOccurrence | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM reminder_occurrences WHERE schedule_item_id = ? AND due_at = ?")
      .get(scheduleItemId, dueAt) as OccurrenceRow | undefined;
    return row ? mapOccurrence(row) : undefined;
  }

  listOccurrences(scheduleItemId?: string): ReminderOccurrence[] {
    const rows = scheduleItemId
      ? (this.database.connection
          .prepare("SELECT * FROM reminder_occurrences WHERE schedule_item_id = ? ORDER BY due_at, id")
          .all(scheduleItemId) as OccurrenceRow[])
      : (this.database.connection
          .prepare("SELECT * FROM reminder_occurrences ORDER BY due_at, id")
          .all() as OccurrenceRow[]);
    return rows.map(mapOccurrence);
  }

  listDueOccurrences(now: string, limit = 100): ReminderOccurrence[] {
    const rows = this.database.connection
      .prepare(`
        SELECT reminder_occurrences.* FROM reminder_occurrences
        JOIN schedule_items ON schedule_items.id = reminder_occurrences.schedule_item_id
        WHERE reminder_occurrences.status = 'scheduled'
          AND reminder_occurrences.due_at <= ?
          AND schedule_items.owner_type = 'user'
        ORDER BY reminder_occurrences.due_at, reminder_occurrences.id LIMIT ?
      `)
      .all(now, limit) as OccurrenceRow[];
    return rows.map(mapOccurrence);
  }

  setOccurrenceStatus(id: string, status: ReminderOccurrenceStatus, updatedAt: string): void {
    this.database.connection
      .prepare("UPDATE reminder_occurrences SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
  }

  cancelScheduledOccurrences(scheduleItemId: string, updatedAt: string): void {
    for (const occurrence of this.listOccurrences(scheduleItemId)) {
      this.suppressOccurrence(occurrence.id, updatedAt);
    }
    this.database.connection
      .prepare(`
        UPDATE reminder_occurrences SET status = 'cancelled', updated_at = ?
        WHERE schedule_item_id = ? AND status IN ('scheduled', 'processing')
      `)
      .run(updatedAt, scheduleItemId);
  }

  suppressOccurrence(id: string, now: string): void {
    // Preserve platform receipts that arrived before the scheduler's next poll.
    this.database.connection.prepare(`UPDATE notification_outbox SET status='delivered',updated_at=?,last_error=NULL
      WHERE occurrence_id=? AND status!='delivered' AND EXISTS (
        SELECT 1 FROM im_outbox m WHERE m.notification_outbox_id=notification_outbox.id AND m.status='delivered'
      )`).run(now,id);
    this.database.connection.prepare("UPDATE notification_outbox SET suppressed_at=? WHERE occurrence_id=? AND status!='delivered'").run(now,id);
    this.database.connection.prepare(`UPDATE im_outbox SET status='abandoned',lease_token=NULL,lease_expires_at=NULL,updated_at=?,last_error='reminder stopped'
      WHERE notification_outbox_id IN (SELECT id FROM notification_outbox WHERE occurrence_id=?) AND status!='delivered'`).run(now,id);
    this.database.connection.prepare("DELETE FROM reminder_drafts WHERE occurrence_id=?").run(id);
  }

  acknowledgeOccurrence(id: string, via: string, now: string): ReminderOccurrence {
    this.database.connection.prepare("UPDATE reminder_occurrences SET acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_via=COALESCE(acknowledged_via,?),updated_at=? WHERE id=?").run(now,via,now,id);
    this.suppressOccurrence(id,now);
    return this.getOccurrence(id)!;
  }

  listUpcomingOccurrences(until: string): ReminderOccurrence[] {
    return (this.database.connection.prepare(`SELECT o.* FROM reminder_occurrences o JOIN schedule_items i ON i.id=o.schedule_item_id
      WHERE o.status='scheduled' AND o.acknowledged_at IS NULL AND o.due_at<=? AND i.owner_type='user' AND i.status='scheduled'
      ORDER BY o.due_at LIMIT 100`).all(until) as OccurrenceRow[]).map(mapOccurrence);
  }

  getDraft(id: string): { revision: number; status: string; body?: string; agentGenerated: boolean } | undefined {
    const row = this.database.connection.prepare("SELECT * FROM reminder_drafts WHERE occurrence_id=?").get(id);
    return row ? { revision: Number(row.revision),status: String(row.status),body: row.body ? String(row.body) : undefined,agentGenerated: Boolean(row.agent_generated) } : undefined;
  }

  saveDraft(id: string, revision: number, status: string, now: string, body?: string, agentGenerated = false): void {
    this.database.connection.prepare(`INSERT INTO reminder_drafts(occurrence_id,revision,status,body,agent_generated,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(occurrence_id) DO UPDATE SET revision=excluded.revision,status=excluded.status,body=excluded.body,agent_generated=excluded.agent_generated,updated_at=excluded.updated_at`)
      .run(id,revision,status,body ?? null,agentGenerated ? 1 : 0,now,now);
  }

  createOutbox(entry: NotificationOutboxEntry): NotificationOutboxEntry {
    this.database.connection
      .prepare(`
        INSERT OR IGNORE INTO notification_outbox(
          id, occurrence_id, channel, status, attempts, available_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.occurrenceId,
        entry.channel,
        entry.status,
        entry.attempts,
        entry.availableAt,
        entry.lastError ?? null,
        entry.createdAt,
        entry.updatedAt,
      );
    return this.getOutboxByOccurrence(entry.occurrenceId, entry.channel) ?? entry;
  }

  getOutboxByOccurrence(occurrenceId: string, channel: string): NotificationOutboxEntry | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM notification_outbox WHERE occurrence_id = ? AND channel = ?")
      .get(occurrenceId, channel) as OutboxRow | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  getOutbox(id: string): NotificationOutboxEntry | undefined {
    const row = this.database.connection
      .prepare("SELECT * FROM notification_outbox WHERE id = ?")
      .get(id) as OutboxRow | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  listPendingOutbox(now: string, limit = 100): NotificationOutboxEntry[] {
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM notification_outbox
        WHERE status = 'pending' AND suppressed_at IS NULL AND available_at <= ?
        ORDER BY available_at, id LIMIT ?
      `)
      .all(now, limit) as OutboxRow[];
    return rows.map(mapOutbox);
  }

  listOutbox(): NotificationOutboxEntry[] {
    return (
      this.database.connection.prepare("SELECT * FROM notification_outbox ORDER BY created_at, id").all() as OutboxRow[]
    ).map(mapOutbox);
  }

  markOutboxProcessing(id: string, updatedAt: string): void {
    this.database.connection
      .prepare("UPDATE notification_outbox SET status = 'processing', updated_at = ? WHERE id = ?")
      .run(updatedAt, id);
  }

  requeueProcessingOutbox(updatedAt: string): void {
    this.database.connection
      .prepare(`
        UPDATE notification_outbox SET status = 'pending', updated_at = ?
        WHERE status = 'processing'
      `)
      .run(updatedAt);
  }

  deferOutbox(id: string, availableAt: string, updatedAt: string): void {
    this.database.connection
      .prepare(`
        UPDATE notification_outbox
        SET status = 'pending', available_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(availableAt, updatedAt, id);
  }

  setOutboxPayload(
    id: string,
    title: string,
    body: string,
    agentGenerated: boolean,
    composedAt: string,
  ): void {
    this.database.connection
      .prepare(`
        UPDATE notification_outbox
        SET delivery_title = ?, delivery_body = ?, agent_generated = ?, composed_at = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(title, body, agentGenerated ? 1 : 0, composedAt, composedAt, id);
  }

  retryOutbox(id: string, availableAt: string, updatedAt: string): void {
    this.database.connection.prepare("UPDATE im_outbox SET status='pending',attempts=0,available_at=?,last_error=NULL WHERE notification_outbox_id=? AND status='failed'").run(availableAt,id);
    this.database.connection
      .prepare(`
        UPDATE notification_outbox
        SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(availableAt, updatedAt, id);
  }

  setPendingDetail(id: string, detail?: string): void {
    this.database.connection.prepare("UPDATE notification_outbox SET last_error=? WHERE id=?").run(detail ?? null,id);
  }

  markOutboxDelivered(id: string, updatedAt: string): void {
    this.database.connection
      .prepare(`
        UPDATE notification_outbox
        SET status = 'delivered', attempts = attempts + 1, last_error = NULL, updated_at = ?
        WHERE id = ?
      `)
      .run(updatedAt, id);
  }

  markOutboxFailed(
    id: string,
    status: "pending" | "failed",
    availableAt: string,
    error: string,
    updatedAt: string,
  ): void {
    this.database.connection
      .prepare(`
        UPDATE notification_outbox
        SET status = ?, attempts = attempts + 1, available_at = ?, last_error = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(status, availableAt, error, updatedAt, id);
  }
}

function mapItem(row: ScheduleItemRow): ScheduleItem {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    notes: row.notes ?? undefined,
    startAt: row.start_at ?? undefined,
    endAt: row.end_at ?? undefined,
    timezone: row.timezone,
    allDay: Boolean(row.all_day),
    recurrenceRule: row.recurrence_rule ?? undefined,
    status: row.status,
    ownerType: row.owner_type,
    characterId: row.character_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    reminder: row.reminder_json ? JSON.parse(row.reminder_json) : undefined,
    revision: Number(row.revision ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOccurrence(row: OccurrenceRow): ReminderOccurrence {
  return {
    id: row.id,
    scheduleItemId: row.schedule_item_id,
    dueAt: row.due_at,
    status: row.status,
    snoozedFromId: row.snoozed_from_id ?? undefined,
    eventAt: row.event_at ?? undefined,
    acknowledgedAt: row.acknowledged_at ?? undefined,
    acknowledgedVia: row.acknowledged_via ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutbox(row: OutboxRow): NotificationOutboxEntry {
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    channel: row.channel,
    status: row.status,
    attempts: Number(row.attempts),
    availableAt: row.available_at,
    lastError: row.last_error ?? undefined,
    deliveryTitle: row.delivery_title ?? undefined,
    deliveryBody: row.delivery_body ?? undefined,
    agentGenerated: Boolean(row.agent_generated),
    composedAt: row.composed_at ?? undefined,
    suppressedAt: row.suppressed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
