import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { VirtualClock } from "../src/app/clock.js";
import type { ImGateway } from "../src/im/gateway.js";
import { LocalImSpool } from "../src/im/local-spool.js";
import { LocalWechatConnector, type PersistedWechatCredential } from "../src/im/local-wechat.js";
import { ImRepository } from "../src/im/repository.js";
import { ImIntegrationError, ImIntegrationService } from "../src/im/service.js";
import type { ImInboundEventInput } from "../src/im/types.js";
import { AppDatabase } from "../src/storage/database.js";

test("IM character routes pin inbound events to normal space and permit a safe missing-route retry", async (context) => {
  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  createImSchema(database);
  const now = "2026-08-19T00:00:00.000Z";
  database.connection.prepare(
    "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("character-a", "Alice", now, now);
  database.connection.prepare(
    "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("character-b", "Bob", now, now);

  const repository = new ImRepository(database);
  const service = new ImIntegrationService(
    repository,
    readyGateway(),
    new VirtualClock(now),
    new SeededIdGenerator("im-route"),
  );
  repository.upsertConnection({
    provider: "wechat",
    gatewayConnectionId: "wechat-connection",
    bindingGeneration: "wechat-generation",
    accountId: "wechat-bot",
    ownerId: "wechat-owner",
    connectedAt: now,
    now,
  });
  const firstEvent = inboundEvent("event-one");
  let handlerCalls = 0;

  await assert.rejects(
    service.startBinding("wechat"),
    (error: unknown) =>
      error instanceof ImIntegrationError && error.code === "IM_CHARACTER_ROUTE_REQUIRED",
  );

  await assert.rejects(
    service.receiveInboundEvent(firstEvent, async () => {
      handlerCalls += 1;
      return "must not run";
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImIntegrationError);
      assert.equal(error.code, "IM_CHARACTER_ROUTE_REQUIRED");
      assert.equal(error.httpStatus, 409);
      return true;
    },
  );
  assert.equal(handlerCalls, 0);
  assert.equal(repository.getInboundEvent("wechat", firstEvent.eventId), undefined);

  const assigned = service.setCharacterRoute("wechat", "character-a");
  assert.equal(assigned.characterId, "character-a");
  assert.equal(
    service.listChannels().channels.find((channel) => channel.provider === "wechat")?.characterId,
    "character-a",
  );

  const firstReceipt = await service.receiveInboundEvent(firstEvent, async (_event, target) => {
    handlerCalls += 1;
    assert.deepEqual(target, {
      provider: "wechat",
      characterId: "character-a",
      conversationSpace: "normal",
      connectionId: "wechat-connection",
      bindingGeneration: "wechat-generation",
      accountId: "wechat-bot",
      ownerId: "wechat-owner",
      externalChatId: "wechat-owner",
    });
    return "reply for Alice";
  });
  assert.equal(firstReceipt.duplicate, false);
  assert.equal(repository.getInboundEvent("wechat", firstEvent.eventId)?.characterId, "character-a");

  service.setCharacterRoute("wechat", "character-b");
  const duplicate = await service.receiveInboundEvent(firstEvent, async () => {
    assert.fail("a completed duplicate must not be delivered to the newly routed character");
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.delivery.id, firstReceipt.delivery.id);

  const secondEvent = inboundEvent("event-two");
  await service.receiveInboundEvent(secondEvent, async (_event, target) => {
    assert.equal(target.characterId, "character-b");
    assert.equal(target.conversationSpace, "normal");
    return "reply for Bob";
  });
  assert.equal(repository.getInboundEvent("wechat", secondEvent.eventId)?.characterId, "character-b");

  const foreignEvent = { ...inboundEvent("event-foreign"), externalUserId: "intruder" };
  await assert.rejects(
    service.receiveInboundEvent(foreignEvent, async () => "must not run"),
    (error: unknown) => error instanceof ImIntegrationError && error.code === "IM_SENDER_NOT_OWNER",
  );
  assert.equal(repository.getInboundEvent("wechat", foreignEvent.eventId), undefined);
});

test("the WeChat connector rejects a non-owner before context capture, media download, or persistence", async () => {
  let persisted: PersistedWechatCredential | undefined = {
    connectionId: "wechat-connection",
    accountId: "wechat-bot",
    ownerId: "wechat-owner",
    token: "wechat-token",
    baseUrl: "https://ilinkai.weixin.qq.com",
    connectedAt: "2026-08-19T00:00:00.000Z",
    contextTokens: {},
  };
  let updates = 0;
  let mediaDownloads = 0;
  let savedAttachments = 0;
  let inboundCalls = 0;
  const connector = new LocalWechatConnector({
    loadCredential: () => persisted ? structuredClone(persisted) : undefined,
    saveCredential: (credential) => {
      persisted = structuredClone(credential);
    },
    clearCredential: () => {
      persisted = undefined;
    },
    saveInboundAttachment: () => {
      savedAttachments += 1;
      throw new Error("non-owner media must never be persisted");
    },
    onInbound: () => {
      inboundCalls += 1;
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname === "/ilink/bot/getupdates") {
        updates += 1;
        if (updates === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "cursor-after-intruder",
            longpolling_timeout_ms: 5_000,
            msgs: [{
              message_type: 1,
              message_id: 99,
              seq: 1,
              from_user_id: "intruder",
              context_token: "intruder-context-token",
              item_list: [{
                type: 4,
                file_item: {
                  file_name: "private.pdf",
                  len: "16",
                  media: {
                    full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?file=intruder",
                    aes_key: Buffer.alloc(16, 7).toString("base64"),
                  },
                },
              }],
            }],
          });
        }
        return blockedResponse(init?.signal);
      }
      if (url.pathname === "/ilink/bot/msg/notifystop") return jsonResponse({ ret: 0 });
      if (url.hostname.endsWith("weixin.qq.com")) {
        mediaDownloads += 1;
        return new Response(Buffer.alloc(16));
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    },
  });

  await connector.restore();
  await waitFor(() => persisted?.syncBuf === "cursor-after-intruder" && updates >= 2);
  assert.equal(mediaDownloads, 0);
  assert.equal(savedAttachments, 0);
  assert.equal(inboundCalls, 0);
  assert.deepEqual(persisted?.contextTokens, {});
  await connector.dispose();
});

test("clearing a connected route drops owner media before download or spool and does not replay it", async (context) => {
  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  const root = mkdtempSync(join(tmpdir(), "yourchar-im-route-pause-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const spool = new LocalImSpool(root);
  const inboundEnabled = new Map<string, boolean>();
  const gateway: ImGateway = {
    ...readyGateway(),
    setInboundEnabled: (provider, enabled) => {
      inboundEnabled.set(provider, enabled);
    },
  };
  const now = "2026-08-19T00:30:00.000Z";
  const repository = new ImRepository(database);
  const service = new ImIntegrationService(
    repository,
    gateway,
    new VirtualClock(now),
    new SeededIdGenerator("im-route-pause"),
  );
  database.connection.prepare(
    "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("paused-character", "Paused Character", now, now);
  service.setCharacterRoute("wechat", "paused-character");
  repository.upsertConnection({
    provider: "wechat",
    gatewayConnectionId: "wechat-connection",
    bindingGeneration: "wechat-generation",
    accountId: "wechat-bot",
    ownerId: "wechat-owner",
    connectedAt: now,
    now,
  });
  assert.equal(inboundEnabled.get("wechat"), true);
  assert.deepEqual(service.clearCharacterRoute("wechat"), { cleared: true });
  assert.equal(inboundEnabled.get("wechat"), false);

  let persisted: PersistedWechatCredential | undefined = {
    connectionId: "wechat-connection",
    accountId: "wechat-bot",
    ownerId: "wechat-owner",
    token: "wechat-token",
    baseUrl: "https://ilinkai.weixin.qq.com",
    connectedAt: now,
    contextTokens: {},
  };
  let updates = 0;
  let mediaDownloads = 0;
  let savedAttachments = 0;
  let inboundCalls = 0;
  const connector = new LocalWechatConnector({
    loadCredential: () => persisted ? structuredClone(persisted) : undefined,
    saveCredential: (credential) => {
      persisted = structuredClone(credential);
    },
    clearCredential: () => {
      persisted = undefined;
    },
    shouldAcceptInbound: () => inboundEnabled.get("wechat") === true,
    saveInboundAttachment: () => {
      savedAttachments += 1;
      throw new Error("a paused provider must not persist media");
    },
    onInbound: async (event) => {
      inboundCalls += 1;
      spool.enqueue(event);
      await service.receiveInboundEvent(event, async () => "must not run while paused");
    },
    fetch: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname === "/ilink/bot/getupdates") {
        updates += 1;
        if (updates === 1) {
          return jsonResponse({
            ret: 0,
            get_updates_buf: "cursor-after-paused-event",
            longpolling_timeout_ms: 5_000,
            msgs: [{
              message_type: 1,
              message_id: 100,
              seq: 1,
              from_user_id: "wechat-owner",
              context_token: "paused-context-token",
              item_list: [{
                type: 4,
                file_item: {
                  file_name: "paused-private.pdf",
                  len: "16",
                  media: {
                    full_url: "https://novac2c.cdn.weixin.qq.com/c2c/download?file=paused",
                    aes_key: Buffer.alloc(16, 8).toString("base64"),
                  },
                },
              }],
            }],
          });
        }
        return blockedResponse(init?.signal);
      }
      if (url.pathname === "/ilink/bot/msg/notifystop") return jsonResponse({ ret: 0 });
      if (url.hostname.endsWith("weixin.qq.com")) {
        mediaDownloads += 1;
        return new Response(Buffer.alloc(16));
      }
      return jsonResponse({ error: "unexpected request" }, 404);
    },
  });
  context.after(async () => connector.dispose());

  await connector.restore();
  await waitFor(() => persisted?.syncBuf === "cursor-after-paused-event" && updates >= 2);
  assert.equal(mediaDownloads, 0);
  assert.equal(savedAttachments, 0);
  assert.equal(inboundCalls, 0);
  assert.deepEqual(spool.due(10, new Date(Date.now() + 1_000)), []);
  assert.equal(
    (database.connection.prepare("SELECT COUNT(*) AS count FROM im_inbound_events").get() as { count: number }).count,
    0,
  );
  assert.deepEqual(persisted?.contextTokens, {});

  service.setCharacterRoute("wechat", "paused-character");
  assert.equal(inboundEnabled.get("wechat"), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inboundCalls, 0, "advancing the paused cursor prevents later replay");
  assert.deepEqual(spool.due(10, new Date(Date.now() + 1_000)), []);
});

function readyGateway(): ImGateway {
  return {
    configured: true,
    supportsAttachments: true,
    getCapabilities: () => [
      { provider: "feishu", connectorKind: "feishu_personal_agent", state: "ready", domains: ["feishu", "lark"] },
      { provider: "wechat", connectorKind: "wechat_tencent_ilink", state: "ready" },
    ],
    startBinding: async () => { throw new Error("not used"); },
    getBindingSession: async () => { throw new Error("not used"); },
    cancelBindingSession: async () => { throw new Error("not used"); },
    disconnect: async () => undefined,
  };
}

function inboundEvent(eventId: string): ImInboundEventInput {
  return {
    eventId,
    provider: "wechat",
    connectionId: "wechat-connection",
    bindingGeneration: "wechat-generation",
    externalChatId: "wechat-owner",
    externalUserId: "wechat-owner",
    chatType: "direct",
    text: "hello",
  };
}

function createImSchema(database: AppDatabase): void {
  database.connection.exec(`
    CREATE TABLE IF NOT EXISTS im_runtime_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      wechat_typing_enabled INTEGER NOT NULL DEFAULT 1 CHECK (wechat_typing_enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO im_runtime_settings(singleton, wechat_typing_enabled, created_at, updated_at)
      VALUES (1, 1, '2026-08-19T00:00:00.000Z', '2026-08-19T00:00:00.000Z');

    CREATE TABLE IF NOT EXISTS im_bindings (
      provider TEXT PRIMARY KEY CHECK (provider IN ('feishu', 'wechat')),
      gateway_connection_id TEXT NOT NULL,
      binding_generation TEXT NOT NULL,
      account_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      display_name TEXT,
      domain TEXT,
      connected_at TEXT NOT NULL,
      last_seen_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS im_bindings_provider_connection_idx
      ON im_bindings(provider, gateway_connection_id);

    CREATE TABLE IF NOT EXISTS im_binding_sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('feishu', 'wechat')),
      status TEXT NOT NULL,
      domain TEXT,
      gateway_connection_id TEXT,
      expires_at TEXT,
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS im_character_routes (
      provider TEXT PRIMARY KEY CHECK (provider IN ('feishu', 'wechat')),
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS im_inbound_events (
      provider TEXT NOT NULL CHECK (provider IN ('feishu', 'wechat')),
      event_id TEXT NOT NULL,
      gateway_connection_id TEXT NOT NULL,
      binding_generation TEXT NOT NULL,
      character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      external_chat_id TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      chat_type TEXT NOT NULL CHECK (chat_type IN ('direct', 'group')),
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 1,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      reply_text TEXT,
      last_error TEXT,
      received_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY (provider, event_id)
    );

    CREATE TABLE IF NOT EXISTS im_outbox (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('feishu', 'wechat')),
      gateway_connection_id TEXT NOT NULL,
      binding_generation TEXT NOT NULL,
      external_chat_id TEXT NOT NULL,
      inbound_event_id TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'abandoned')),
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_token TEXT,
      lease_expires_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (provider, inbound_event_id)
    );
  `);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function blockedResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
