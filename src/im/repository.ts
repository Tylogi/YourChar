import type { AppDatabase } from "../storage/database.js";
import type {
  FeishuDomain,
  ImBindingSession,
  ImCharacterRoute,
  ImConnection,
  ImAttachment,
  ImInboundEvent,
  ImInboundEventInput,
  ImOutboxItem,
  ImProvider,
  ImRuntimeSettings,
  ImRuntimeSettingsPatch,
} from "./types.js";

type Row = Record<string, unknown>;

export type ImInboundClaim =
  | { kind: "new"; event: ImInboundEvent }
  | { kind: "completed"; event: ImInboundEvent; delivery: ImOutboxItem }
  | { kind: "processing" | "failed"; event: ImInboundEvent };

export class ImRepository {
  constructor(readonly database: AppDatabase) {}

  getRuntimeSettings(): ImRuntimeSettings {
    const row = this.database.connection.prepare(`
      SELECT wechat_typing_enabled, wechat_reminders_enabled, feishu_reminders_enabled, updated_at
      FROM im_runtime_settings
      WHERE singleton = 1
    `).get() as { wechat_typing_enabled: number; wechat_reminders_enabled: number; feishu_reminders_enabled: number; updated_at: string } | undefined;
    if (!row) throw new Error("IM runtime settings are missing");
    return {
      wechatTypingEnabled: Boolean(row.wechat_typing_enabled),
      wechatRemindersEnabled: Boolean(row.wechat_reminders_enabled),
      feishuRemindersEnabled: Boolean(row.feishu_reminders_enabled),
      updatedAt: row.updated_at,
    };
  }

  patchRuntimeSettings(patch: ImRuntimeSettingsPatch, updatedAt: string): ImRuntimeSettings {
    return this.database.transaction(() => {
      const next = { ...this.getRuntimeSettings(), ...patch };
      this.database.connection.prepare(`UPDATE im_runtime_settings
        SET wechat_typing_enabled=?, wechat_reminders_enabled=?, feishu_reminders_enabled=?, updated_at=? WHERE singleton=1`)
        .run(Number(next.wechatTypingEnabled), Number(next.wechatRemindersEnabled), Number(next.feishuRemindersEnabled), updatedAt);
      // Re-enabling is never permission to replay an already suppressed reminder.
      for (const provider of ["wechat", "feishu"] as const) {
        if (next[provider === "wechat" ? "wechatRemindersEnabled" : "feishuRemindersEnabled"]) continue;
        this.database.connection.prepare(`UPDATE notification_outbox SET status='delivered',updated_at=?,last_error=NULL
          WHERE channel=? AND status!='delivered' AND EXISTS (
            SELECT 1 FROM im_outbox m WHERE m.notification_outbox_id=notification_outbox.id AND m.status='delivered')`).run(updatedAt, provider);
        this.database.connection.prepare(`UPDATE notification_outbox SET suppressed_at=COALESCE(suppressed_at,?),updated_at=?,last_error='此 IM 通道的日程提醒已关闭'
          WHERE channel=? AND status!='delivered'`).run(updatedAt, updatedAt, provider);
      }
      this.invalidateReminderOutbox(updatedAt);
      return this.getRuntimeSettings();
    });
  }

  isReminderChannelEnabled(provider: ImProvider): boolean {
    const settings = this.getRuntimeSettings();
    return provider === "wechat" ? settings.wechatRemindersEnabled : settings.feishuRemindersEnabled;
  }

  reminderChannels(): ImProvider[] {
    return this.listConnections().filter(binding => this.isReminderChannelEnabled(binding.provider)).map(binding => binding.provider);
  }

  listCharacterRoutes(): ImCharacterRoute[] {
    return (this.database.connection.prepare(
      "SELECT * FROM im_character_routes ORDER BY provider",
    ).all() as Row[]).map(mapCharacterRoute);
  }

  getCharacterRoute(provider: ImProvider): ImCharacterRoute | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM im_character_routes WHERE provider = ?",
    ).get(provider) as Row | undefined;
    return row ? mapCharacterRoute(row) : undefined;
  }

  setCharacterRoute(provider: ImProvider, characterId: string, now: string): ImCharacterRoute {
    return this.database.transaction(() => {
      const character = this.database.connection.prepare(
        "SELECT 1 FROM characters WHERE id = ? LIMIT 1",
      ).get(characterId);
      if (!character) throw new ImRepositoryCharacterNotFoundError(characterId);
      this.database.connection.prepare(`
        INSERT INTO im_character_routes(provider, character_id, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          character_id = excluded.character_id,
          updated_at = excluded.updated_at
      `).run(provider, characterId, now, now);
      return this.getCharacterRoute(provider)!;
    });
  }

  clearCharacterRoute(provider: ImProvider): ImCharacterRoute | undefined {
    const route = this.getCharacterRoute(provider);
    if (!route) return undefined;
    this.database.connection.prepare(
      "DELETE FROM im_character_routes WHERE provider = ?",
    ).run(provider);
    return route;
  }

  listConnections(): ImConnection[] {
    return (this.database.connection.prepare(
      "SELECT * FROM im_bindings ORDER BY provider",
    ).all() as Row[]).map(mapConnection);
  }

  getConnection(provider: ImProvider): ImConnection | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM im_bindings WHERE provider = ?",
    ).get(provider) as Row | undefined;
    return row ? mapConnection(row) : undefined;
  }

  getConnectionByGatewayId(provider: ImProvider, connectionId: string): ImConnection | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM im_bindings
      WHERE provider = ? AND gateway_connection_id = ?
    `).get(provider, connectionId) as Row | undefined;
    return row ? mapConnection(row) : undefined;
  }

  upsertConnection(input: {
    provider: ImProvider;
    gatewayConnectionId: string;
    bindingGeneration: string;
    accountId: string;
    ownerId: string;
    displayName?: string;
    domain?: FeishuDomain;
    connectedAt: string;
    lastSeenAt?: string;
    now: string;
  }): ImConnection {
    this.database.connection.prepare(`
      INSERT INTO im_bindings(
        provider, gateway_connection_id, binding_generation, account_id, owner_id, display_name, domain,
        connected_at, last_seen_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET
        gateway_connection_id = excluded.gateway_connection_id,
        binding_generation = excluded.binding_generation,
        account_id = excluded.account_id,
        owner_id = excluded.owner_id,
        display_name = excluded.display_name,
        domain = excluded.domain,
        connected_at = excluded.connected_at,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run(
      input.provider,
      input.gatewayConnectionId,
      input.bindingGeneration,
      input.accountId,
      input.ownerId,
      input.displayName ?? null,
      input.domain ?? null,
      input.connectedAt,
      input.lastSeenAt ?? null,
      input.now,
      input.now,
    );
    this.database.connection.prepare(`
      UPDATE im_outbox
      SET status = 'abandoned', lease_token = NULL, lease_expires_at = NULL,
          last_error = 'binding replaced before delivery', updated_at = ?
      WHERE provider = ? AND status IN ('pending', 'failed')
        AND NOT (gateway_connection_id = ? AND binding_generation = ?)
    `).run(
      input.now,
      input.provider,
      input.gatewayConnectionId,
      input.bindingGeneration,
    );
    return this.getConnection(input.provider)!;
  }

  touchConnection(provider: ImProvider, connectionId: string, now: string): ImConnection | undefined {
    const result = this.database.connection.prepare(`
      UPDATE im_bindings SET last_seen_at = ?, updated_at = ?
      WHERE provider = ? AND gateway_connection_id = ?
    `).run(now, now, provider, connectionId);
    return Number(result.changes) ? this.getConnection(provider) : undefined;
  }

  deleteConnection(provider: ImProvider, now: string): ImConnection | undefined {
    return this.database.transaction(() => {
      const connection = this.getConnection(provider);
      if (!connection) return undefined;
      this.abandonOutboxForConnection(provider, connection.gatewayConnectionId, now);
      this.database.connection.prepare("DELETE FROM im_bindings WHERE provider = ?").run(provider);
      return connection;
    });
  }

  upsertBindingSession(input: {
    id: string;
    provider: ImProvider;
    status: ImBindingSession["status"];
    domain?: FeishuDomain;
    gatewayConnectionId?: string;
    expiresAt?: string;
    message?: string;
    createdAt: string;
    updatedAt: string;
  }): ImBindingSession {
    this.database.connection.prepare(`
      INSERT INTO im_binding_sessions(
        id, provider, status, domain, gateway_connection_id, expires_at, message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        domain = COALESCE(excluded.domain, im_binding_sessions.domain),
        gateway_connection_id = COALESCE(excluded.gateway_connection_id, im_binding_sessions.gateway_connection_id),
        expires_at = excluded.expires_at,
        message = excluded.message,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.provider,
      input.status,
      input.domain ?? null,
      input.gatewayConnectionId ?? null,
      input.expiresAt ?? null,
      input.message ?? null,
      input.createdAt,
      input.updatedAt,
    );
    return this.getBindingSession(input.id)!;
  }

  getBindingSession(id: string): ImBindingSession | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM im_binding_sessions WHERE id = ?",
    ).get(id) as Row | undefined;
    if (!row) return undefined;
    const provider = String(row.provider) as ImProvider;
    const connectionId = row.gateway_connection_id ? String(row.gateway_connection_id) : undefined;
    return mapBindingSession(
      row,
      connectionId ? this.getConnectionByGatewayId(provider, connectionId) : undefined,
    );
  }

  latestBindingSession(provider: ImProvider): ImBindingSession | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM im_binding_sessions
      WHERE provider = ? ORDER BY updated_at DESC, id DESC LIMIT 1
    `).get(provider) as Row | undefined;
    if (!row) return undefined;
    const connectionId = row.gateway_connection_id ? String(row.gateway_connection_id) : undefined;
    return mapBindingSession(
      row,
      connectionId ? this.getConnectionByGatewayId(provider, connectionId) : undefined,
    );
  }

  hasConnectionGenerationConflict(
    provider: ImProvider,
    connectionId: string,
    bindingGeneration: string,
  ): boolean {
    const row = this.database.connection.prepare(`
      SELECT 1
      FROM (
        SELECT id AS binding_generation
        FROM im_binding_sessions
        WHERE provider = ? AND gateway_connection_id = ? AND id <> ?
        UNION ALL
        SELECT binding_generation
        FROM im_inbound_events
        WHERE provider = ? AND gateway_connection_id = ?
          AND binding_generation IS NOT NULL AND binding_generation <> ?
      )
      LIMIT 1
    `).get(
      provider,
      connectionId,
      bindingGeneration,
      provider,
      connectionId,
      bindingGeneration,
    ) as Row | undefined;
    return Boolean(row);
  }

  claimInboundEvent(input: {
    event: ImInboundEventInput;
    bindingGeneration: string;
    characterId: string;
    payloadDigest: string;
    now: string;
  }): ImInboundClaim {
    return this.database.transaction(() => {
      const connection = this.getConnectionByGatewayId(
        input.event.provider,
        input.event.connectionId,
      );
      if (!connection || connection.bindingGeneration !== input.bindingGeneration) {
        throw new ImRepositoryConflictError("inbound event binding generation is no longer current");
      }
      if (
        input.event.bindingGeneration !== undefined &&
        input.event.bindingGeneration !== input.bindingGeneration
      ) {
        throw new ImRepositoryConflictError("inbound event binding generation does not match claim");
      }
      const existing = this.getInboundEvent(input.event.provider, input.event.eventId);
      if (existing) {
        if (existing.bindingGeneration !== input.bindingGeneration) {
          throw new ImRepositoryConflictError("event id was reused across binding generations");
        }
        if (existing.payloadDigest !== input.payloadDigest) {
          throw new ImRepositoryConflictError("event id was reused with a different payload");
        }
        if (existing.characterId !== input.characterId) {
          throw new ImRepositoryConflictError("event id was reused with a different character route");
        }
        if (existing.status === "completed") {
          const delivery = this.getOutboxByInboundEvent(existing.provider, existing.eventId);
          if (!delivery) throw new Error("completed IM event is missing its outbox delivery");
          return { kind: "completed", event: existing, delivery };
        }
        return { kind: existing.status, event: existing };
      }
      const characterRoute = this.getCharacterRoute(input.event.provider);
      if (!characterRoute || characterRoute.characterId !== input.characterId) {
        throw new ImRepositoryConflictError("inbound event character route is no longer current");
      }
      this.database.connection.prepare(`
        INSERT INTO im_inbound_events(
          provider, event_id, gateway_connection_id, external_chat_id, external_user_id,
          chat_type, binding_generation, character_id, payload_digest, status, attempts,
          attachments_json, received_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?, ?)
      `).run(
        input.event.provider,
        input.event.eventId,
        input.event.connectionId,
        input.event.externalChatId,
        input.event.externalUserId,
        input.event.chatType,
        input.bindingGeneration,
        input.characterId,
        input.payloadDigest,
        serializeAttachments(input.event.attachments ?? []),
        input.event.receivedAt ?? null,
        input.now,
        input.now,
      );
      return {
        kind: "new",
        event: this.getInboundEvent(input.event.provider, input.event.eventId)!,
      };
    });
  }

  completeInboundEvent(input: {
    provider: ImProvider;
    eventId: string;
    outboxId: string;
    replyText: string;
    attachments: ImAttachment[];
    now: string;
  }): ImOutboxItem {
    const result = this.database.transaction((): {
      kind: "delivery";
      delivery: ImOutboxItem;
    } | { kind: "binding_stale" } => {
      const event = this.getInboundEvent(input.provider, input.eventId);
      if (!event) throw new Error("IM inbound event not found");
      const connection = this.getConnectionByGatewayId(event.provider, event.connectionId);
      if (!connection || connection.bindingGeneration !== event.bindingGeneration) {
        this.database.connection.prepare(`
          UPDATE im_inbound_events
          SET status = 'failed',
              last_error = 'binding changed before reply completion',
              updated_at = ?, completed_at = ?
          WHERE provider = ? AND event_id = ? AND status = 'processing'
        `).run(input.now, input.now, input.provider, input.eventId);
        this.database.connection.prepare(`
          UPDATE im_outbox
          SET status = 'abandoned', lease_token = NULL, lease_expires_at = NULL,
              last_error = 'binding changed before reply completion', updated_at = ?
          WHERE provider = ? AND inbound_event_id = ?
            AND status IN ('pending', 'failed')
        `).run(input.now, input.provider, input.eventId);
        return { kind: "binding_stale" };
      }
      if (event.status === "completed") {
        const existing = this.getOutboxByInboundEvent(input.provider, input.eventId);
        if (!existing) throw new Error("completed IM event is missing its outbox delivery");
        return { kind: "delivery", delivery: existing };
      }
      if (event.status !== "processing") throw new Error("IM inbound event is not processing");
      this.database.connection.prepare(`
        UPDATE im_inbound_events
        SET status = 'completed', reply_text = ?, last_error = NULL,
            updated_at = ?, completed_at = ?
        WHERE provider = ? AND event_id = ? AND status = 'processing'
      `).run(input.replyText, input.now, input.now, input.provider, input.eventId);
      this.database.connection.prepare(`
        INSERT INTO im_outbox(
          id, provider, gateway_connection_id, binding_generation,
          external_chat_id, inbound_event_id, text, attachments_json,
          status, attempts, available_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(
        input.outboxId,
        event.provider,
        event.connectionId,
        event.bindingGeneration,
        event.externalChatId,
        event.eventId,
        input.replyText,
        serializeAttachments(input.attachments),
        input.now,
        input.now,
        input.now,
      );
      return { kind: "delivery", delivery: this.getOutbox(input.outboxId)! };
    });
    if (result.kind === "binding_stale") {
      throw new ImRepositoryBindingStaleError();
    }
    return result.delivery;
  }

  failInboundEvent(provider: ImProvider, eventId: string, error: string, now: string): void {
    this.database.connection.prepare(`
      UPDATE im_inbound_events
      SET status = 'failed', last_error = ?, updated_at = ?, completed_at = ?
      WHERE provider = ? AND event_id = ? AND status = 'processing'
    `).run(error, now, now, provider, eventId);
  }

  retryFailedInboundEvent(
    provider: ImProvider,
    eventId: string,
    expectedError: string,
    now: string,
  ): boolean {
    return Number(this.database.connection.prepare(`
      UPDATE im_inbound_events
      SET status = 'processing', attempts = attempts + 1, last_error = NULL,
          updated_at = ?, completed_at = NULL
      WHERE provider = ? AND event_id = ? AND status = 'failed' AND last_error = ?
    `).run(now, provider, eventId, expectedError).changes) === 1;
  }

  recoverInterruptedInboundEvents(now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE im_inbound_events
      SET status = 'failed',
          last_error = 'service restarted while this IM event was processing',
          updated_at = ?, completed_at = ?
      WHERE status = 'processing'
    `).run(now, now).changes);
  }

  getInboundEvent(provider: ImProvider, eventId: string): ImInboundEvent | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM im_inbound_events WHERE provider = ? AND event_id = ?
    `).get(provider, eventId) as Row | undefined;
    return row ? mapInboundEvent(row) : undefined;
  }

  getOutbox(id: string): ImOutboxItem | undefined {
    const row = this.database.connection.prepare("SELECT * FROM im_outbox WHERE id = ?")
      .get(id) as Row | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  enqueueNotification(input: { id: string; provider: ImProvider; notificationId: string; text: string; now: string }): ImOutboxItem {
    if (!this.isReminderChannelEnabled(input.provider)) throw new Error("此 IM 通道的日程提醒已关闭");
    const existing = this.database.connection.prepare("SELECT * FROM im_outbox WHERE notification_outbox_id=?").get(input.notificationId) as Row | undefined;
    if (existing) return mapOutbox(existing);
    const target = this.database.connection.prepare(`SELECT b.gateway_connection_id,b.binding_generation,e.external_chat_id
      FROM im_bindings b JOIN im_inbound_events e ON e.provider=b.provider AND e.gateway_connection_id=b.gateway_connection_id
        AND e.binding_generation=b.binding_generation AND e.external_user_id=b.owner_id AND e.chat_type='direct'
      WHERE b.provider=? ORDER BY e.created_at DESC,e.event_id DESC LIMIT 1`).get(input.provider) as Row | undefined;
    if (!target) throw new Error("请先绑定此通道，并由本人发送一条私聊消息以确认提醒目标");
    this.database.connection.prepare(`INSERT INTO im_outbox(id,provider,gateway_connection_id,binding_generation,external_chat_id,
      notification_outbox_id,text,attachments_json,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'[]','pending',?,?,?)`)
      .run(input.id,input.provider,String(target.gateway_connection_id),String(target.binding_generation),String(target.external_chat_id),input.notificationId,input.text,input.now,input.now,input.now);
    return this.getOutbox(input.id)!;
  }

  reminderTargets(provider: ImProvider, connectionId: string, bindingGeneration: string, externalChatId: string): string[] {
    return (this.database.connection.prepare(`SELECT DISTINCT n.occurrence_id FROM im_outbox m JOIN notification_outbox n ON n.id=m.notification_outbox_id
      JOIN reminder_occurrences o ON o.id=n.occurrence_id WHERE m.provider=? AND m.gateway_connection_id=? AND m.binding_generation=?
      AND m.external_chat_id=? AND m.status='delivered' AND o.acknowledged_at IS NULL AND o.status NOT IN ('cancelled','snoozed')
      ORDER BY o.due_at DESC LIMIT 20`).all(provider,connectionId,bindingGeneration,externalChatId) as Row[]).map(row => String(row.occurrence_id));
  }

  getOutboxByInboundEvent(provider: ImProvider, eventId: string): ImOutboxItem | undefined {
    const row = this.database.connection.prepare(`
      SELECT * FROM im_outbox WHERE provider = ? AND inbound_event_id = ?
    `).get(provider, eventId) as Row | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  claimPendingOutbox(input: {
    provider?: ImProvider;
    connectionId?: string;
    now: string;
    leaseToken: string;
    leaseExpiresAt: string;
    limit?: number;
    allowAttachments?: boolean;
  }): ImOutboxItem[] {
    return this.database.transaction(() => {
      this.invalidateReminderOutbox(input.now);
      this.database.connection.prepare(`
        UPDATE im_outbox
        SET status = 'abandoned', lease_token = NULL, lease_expires_at = NULL,
            last_error = 'binding is no longer current', updated_at = ?
        WHERE status IN ('pending', 'failed')
          AND NOT EXISTS (
            SELECT 1 FROM im_bindings AS binding
            WHERE binding.provider = im_outbox.provider
              AND binding.gateway_connection_id = im_outbox.gateway_connection_id
              AND binding.binding_generation = im_outbox.binding_generation
          )
      `).run(input.now);
      const clauses = [
        "status IN ('pending', 'failed')",
        "(notification_outbox_id IS NULL OR attempts < 3)",
        "available_at <= ?",
        "(lease_expires_at IS NULL OR lease_expires_at <= ?)",
        `EXISTS (
          SELECT 1 FROM im_bindings AS binding
          WHERE binding.provider = im_outbox.provider
            AND binding.gateway_connection_id = im_outbox.gateway_connection_id
            AND binding.binding_generation = im_outbox.binding_generation
        )`,
      ];
      if (input.allowAttachments === false) clauses.push("attachments_json = '[]'");
      const values: Array<string | number> = [input.now, input.now];
      if (input.provider) {
        clauses.push("provider = ?");
        values.push(input.provider);
      }
      if (input.connectionId) {
        clauses.push("gateway_connection_id = ?");
        values.push(input.connectionId);
      }
      values.push(Math.max(1, Math.min(200, Math.floor(input.limit ?? 50))));
      const ids = (this.database.connection.prepare(`
        SELECT id FROM im_outbox
        WHERE ${clauses.join(" AND ")}
        ORDER BY available_at, created_at, id LIMIT ?
      `).all(...values) as Row[]).map((row) => String(row.id));
      const update = this.database.connection.prepare(`
        UPDATE im_outbox
        SET lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'failed')
          AND available_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
          AND EXISTS (
            SELECT 1 FROM im_bindings AS binding
            WHERE binding.provider = im_outbox.provider
              AND binding.gateway_connection_id = im_outbox.gateway_connection_id
              AND binding.binding_generation = im_outbox.binding_generation
          )
      `);
      const claimed: ImOutboxItem[] = [];
      for (const id of ids) {
        const result = update.run(
          input.leaseToken,
          input.leaseExpiresAt,
          input.now,
          id,
          input.now,
          input.now,
        );
        if (Number(result.changes)) claimed.push(this.getOutbox(id)!);
      }
      return claimed;
    });
  }

  acknowledgeOutbox(input: {
    id: string;
    leaseToken: string;
    delivered: boolean;
    error?: string;
    retryAt?: string;
    now: string;
  }): ImOutboxItem | undefined {
    const existingRow = this.database.connection.prepare(`
      SELECT im_outbox.* FROM im_outbox
      WHERE id = ? AND lease_token = ?
        AND EXISTS (
          SELECT 1 FROM im_bindings AS binding
          WHERE binding.provider = im_outbox.provider
            AND binding.gateway_connection_id = im_outbox.gateway_connection_id
            AND binding.binding_generation = im_outbox.binding_generation
        )
    `).get(input.id, input.leaseToken) as Row | undefined;
    const existing = existingRow ? mapOutbox(existingRow) : undefined;
    if (!existing || existing.status === "abandoned") return undefined;
    if (existing.status === "delivered") return existing;
    const result = this.database.connection.prepare(`
      UPDATE im_outbox
      SET status = ?, available_at = ?, lease_token = ?, lease_expires_at = NULL,
          last_error = ?, updated_at = ?, delivered_at = ?
      WHERE id = ? AND lease_token = ? AND status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1 FROM im_bindings AS binding
          WHERE binding.provider = im_outbox.provider
            AND binding.gateway_connection_id = im_outbox.gateway_connection_id
            AND binding.binding_generation = im_outbox.binding_generation
        )
    `).run(
      input.delivered ? "delivered" : "failed",
      input.retryAt ?? input.now,
      input.delivered ? input.leaseToken : null,
      input.delivered ? null : input.error ?? "gateway delivery failed",
      input.now,
      input.delivered ? input.now : null,
      input.id,
      input.leaseToken,
    );
    if (!Number(result.changes)) return undefined;
    return this.getOutbox(input.id);
  }

  authorizeOutbox(id: string, leaseToken: string): ImOutboxItem | undefined {
    this.invalidateReminderOutbox();
    const row = this.database.connection.prepare(`
      SELECT im_outbox.* FROM im_outbox
      WHERE id = ? AND lease_token = ? AND status IN ('pending', 'failed')
        AND EXISTS (
          SELECT 1 FROM im_bindings AS binding
          WHERE binding.provider = im_outbox.provider
            AND binding.gateway_connection_id = im_outbox.gateway_connection_id
            AND binding.binding_generation = im_outbox.binding_generation
        )
    `).get(id, leaseToken) as Row | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  private invalidateReminderOutbox(now = new Date().toISOString()): void {
    this.database.connection.prepare(`UPDATE im_outbox SET status='abandoned',lease_token=NULL,lease_expires_at=NULL,
      updated_at=?,last_error='reminder cancelled, acknowledged, or disabled'
      WHERE notification_outbox_id IS NOT NULL AND status IN ('pending','failed') AND EXISTS (
        SELECT 1 FROM notification_outbox n JOIN reminder_occurrences o ON o.id=n.occurrence_id JOIN schedule_items i ON i.id=o.schedule_item_id
        WHERE n.id=im_outbox.notification_outbox_id AND (n.suppressed_at IS NOT NULL OR o.acknowledged_at IS NOT NULL
          OR o.status IN ('cancelled','snoozed') OR i.status!='scheduled' OR i.owner_type!='user'
          OR EXISTS (SELECT 1 FROM im_runtime_settings s WHERE s.singleton=1 AND
            ((im_outbox.provider='wechat' AND s.wechat_reminders_enabled=0) OR (im_outbox.provider='feishu' AND s.feishu_reminders_enabled=0))))
      )`).run(now);
  }

  abandonOutboxForConnection(provider: ImProvider, connectionId: string, now: string): number {
    return Number(this.database.connection.prepare(`
      UPDATE im_outbox
      SET status = 'abandoned', lease_token = NULL, lease_expires_at = NULL,
          last_error = 'binding disconnected before delivery', updated_at = ?
      WHERE provider = ? AND gateway_connection_id = ? AND status IN ('pending', 'failed')
    `).run(now, provider, connectionId).changes);
  }
}

export class ImRepositoryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImRepositoryConflictError";
  }
}

export class ImRepositoryBindingStaleError extends Error {
  constructor() {
    super("binding changed before reply completion");
    this.name = "ImRepositoryBindingStaleError";
  }
}

export class ImRepositoryCharacterNotFoundError extends Error {
  constructor(readonly characterId: string) {
    super(`character ${characterId} does not exist`);
    this.name = "ImRepositoryCharacterNotFoundError";
  }
}

function mapCharacterRoute(row: Row): ImCharacterRoute {
  return {
    provider: String(row.provider) as ImProvider,
    characterId: String(row.character_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapConnection(row: Row): ImConnection {
  return {
    provider: String(row.provider) as ImProvider,
    gatewayConnectionId: String(row.gateway_connection_id),
    bindingGeneration: String(row.binding_generation),
    accountId: String(row.account_id),
    ownerId: String(row.owner_id),
    ...(row.display_name ? { displayName: String(row.display_name) } : {}),
    ...(row.domain ? { domain: String(row.domain) as FeishuDomain } : {}),
    connectedAt: String(row.connected_at),
    updatedAt: String(row.updated_at),
    ...(row.last_seen_at ? { lastSeenAt: String(row.last_seen_at) } : {}),
  };
}

function mapBindingSession(row: Row, connection?: ImConnection): ImBindingSession {
  return {
    id: String(row.id),
    provider: String(row.provider) as ImProvider,
    status: String(row.status) as ImBindingSession["status"],
    ...(row.domain ? { domain: String(row.domain) as FeishuDomain } : {}),
    ...(row.expires_at ? { expiresAt: String(row.expires_at) } : {}),
    ...(row.message ? { message: String(row.message) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(String(row.status) === "connected" && connection ? { connection } : {}),
  };
}

function mapInboundEvent(row: Row): ImInboundEvent {
  return {
    eventId: String(row.event_id),
    provider: String(row.provider) as ImProvider,
    connectionId: String(row.gateway_connection_id),
    characterId: String(row.character_id),
    ...(row.binding_generation ? { bindingGeneration: String(row.binding_generation) } : {}),
    externalChatId: String(row.external_chat_id),
    externalUserId: String(row.external_user_id),
    chatType: String(row.chat_type) === "group" ? "group" : "direct",
    ...(row.received_at ? { receivedAt: String(row.received_at) } : {}),
    payloadDigest: String(row.payload_digest),
    status: String(row.status) as ImInboundEvent["status"],
    attempts: Number(row.attempts),
    ...(row.reply_text ? { replyText: String(row.reply_text) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function mapOutbox(row: Row): ImOutboxItem {
  return {
    id: String(row.id),
    provider: String(row.provider) as ImProvider,
    connectionId: String(row.gateway_connection_id),
    bindingGeneration: String(row.binding_generation),
    externalChatId: String(row.external_chat_id),
    ...(row.inbound_event_id ? { inboundEventId: String(row.inbound_event_id) } : {}),
    ...(row.notification_outbox_id ? { notificationOutboxId: String(row.notification_outbox_id) } : {}),
    text: String(row.text),
    attachments: parseAttachments(row.attachments_json),
    status: String(row.status) as ImOutboxItem["status"],
    attempts: Number(row.attempts),
    availableAt: String(row.available_at),
    ...(row.lease_token ? { leaseToken: String(row.lease_token) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}),
    ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
  };
}

function serializeAttachments(attachments: readonly ImAttachment[]): string {
  return JSON.stringify(attachments.map((attachment) => ({
    kind: attachment.kind,
    path: attachment.path,
    name: attachment.name,
    contentType: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
  })));
}

function parseAttachments(value: unknown): ImAttachment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof value === "string" ? value : "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 8).flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const item = entry as Record<string, unknown>;
    if (
      (item.kind !== "image" && item.kind !== "file") ||
      typeof item.path !== "string" || !item.path ||
      typeof item.name !== "string" || !item.name ||
      typeof item.contentType !== "string" || !item.contentType ||
      typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 0 ||
      typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.sha256)
    ) return [];
    return [{
      kind: item.kind,
      path: item.path,
      name: item.name,
      contentType: item.contentType,
      size: item.size,
      sha256: item.sha256,
    }];
  });
}
