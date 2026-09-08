import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import type { ImGateway } from "../src/im/gateway.js";
import { ImGatewayError } from "../src/im/gateway.js";
import { LocalImGateway, type LocalImCore } from "../src/im/local-gateway.js";
import { LocalImSpool } from "../src/im/local-spool.js";
import { LocalImCredentialStore } from "../src/im/local-store.js";
import { ImRepository } from "../src/im/repository.js";
import { ImIntegrationError, ImIntegrationService } from "../src/im/service.js";
import type {
  ImInboundEventInput,
  ImInboundReceipt,
  ImOutboxItem,
  ImProvider,
} from "../src/im/types.js";
import { AppDatabase } from "../src/storage/database.js";

type GatewayInternals = {
  core?: LocalImCore;
  spool: LocalImSpool;
  runWorker(): Promise<void>;
  flushOutbox(provider: ImProvider, connectionId: string | undefined): Promise<void>;
};

test("local IM credentials and spool use private modes and survive restart", (context) => {
  const root = temporaryDirectory(context, "yourchar-local-im-state-");
  const credentials = new LocalImCredentialStore(root);
  const spool = new LocalImSpool(root);
  const event = inboundEvent("wechat", "restart-event");
  const savedCredential = {
    connectionId: "wechat-connection",
    ownerId: "wechat-owner",
    token: "credential-secret",
    nested: { cursor: "cursor-1" },
  };

  credentials.set("wechat", savedCredential);
  spool.enqueue(event);
  spool.recordDelivery({
    outboxId: "outbox-restart",
    partId: "text",
    provider: "wechat",
    platformMessageId: "platform-message-1",
    deliveredAt: "2026-08-19T01:00:00.000Z",
  });

  assert.equal(statSync(join(root, "im-runtime")).mode & 0o777, 0o700);
  assert.equal(statSync(credentials.path).mode & 0o777, 0o600);
  assert.equal(statSync(spool.path).mode & 0o777, 0o600);

  const restoredCredentials = new LocalImCredentialStore(root);
  const restoredSpool = new LocalImSpool(root);
  assert.deepEqual(restoredCredentials.get("wechat"), savedCredential);
  assert.deepEqual(
    restoredSpool.due(10, new Date(Date.now() + 1_000)).map((entry) => entry.event),
    [event],
  );
  assert.equal(restoredSpool.delivery("outbox-restart", "text")?.platformMessageId, "platform-message-1");
  restoredSpool.clearInboundProvider("wechat");
  assert.deepEqual(restoredSpool.due(10, new Date(Date.now() + 1_000)), []);
  assert.equal(
    restoredSpool.delivery("outbox-restart", "text")?.platformMessageId,
    "platform-message-1",
    "pausing ingress must retain delivery receipts",
  );
  assert.equal(statSync(restoredCredentials.path).mode & 0o777, 0o600);
  assert.equal(statSync(restoredSpool.path).mode & 0o777, 0o600);
});

test("the durable inbound spool deduplicates identical events and rejects digest conflicts", (context) => {
  const root = temporaryDirectory(context, "yourchar-local-im-spool-");
  const spool = new LocalImSpool(root);
  const event = inboundEvent("feishu", "duplicate-event");

  spool.enqueue(event);
  spool.enqueue(structuredClone(event));
  assert.equal(spool.due(10, new Date(Date.now() + 1_000)).length, 1);
  assert.throws(
    () => spool.enqueue({ ...event, text: "same id, changed payload" }),
    /event id was reused with different content/u,
  );

  const restored = new LocalImSpool(root);
  assert.equal(restored.due(10, new Date(Date.now() + 1_000)).length, 1);
  assert.throws(
    () => restored.enqueue({ ...event, externalUserId: "intruder" }),
    /event id was reused with different content/u,
  );
});

test("outbox leases fence authorize and ACK across expiry and reclaim", async (context) => {
  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  const clock = new VirtualClock("2026-08-19T02:00:00.000Z");
  const repository = new ImRepository(database);
  const service = new ImIntegrationService(
    repository,
    readyGateway(),
    clock,
    new SeededIdGenerator("im-lease-fence"),
  );
  const now = clock.now().toISOString();
  database.connection.prepare(
    "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("character-owner", "Owner Character", now, now);
  service.setCharacterRoute("wechat", "character-owner");
  repository.upsertConnection({
    provider: "wechat",
    gatewayConnectionId: "wechat-connection",
    bindingGeneration: "wechat-generation",
    accountId: "wechat-account",
    ownerId: "wechat-owner",
    connectedAt: now,
    now,
  });

  const receipt = await service.receiveInboundEvent(
    inboundEvent("wechat", "lease-event"),
    async (event, target) => {
      assert.equal(event.chatType, "direct");
      assert.equal(event.externalUserId, "wechat-owner");
      assert.equal(target.ownerId, "wechat-owner");
      assert.equal(target.characterId, "character-owner");
      assert.equal(target.conversationSpace, "normal");
      return "owner-only reply";
    },
  );
  assert.equal(receipt.duplicate, false);

  const [firstLease] = service.claimPendingOutbox({
    provider: "wechat",
    connectionId: "wechat-connection",
  });
  assert.ok(firstLease?.leaseToken);
  assert.equal(firstLease.id, receipt.delivery.id);
  assert.deepEqual(
    service.claimPendingOutbox({ provider: "wechat", connectionId: "wechat-connection" }),
    [],
    "an active lease must exclude a second worker",
  );
  assertLeaseRejected(() => service.authorizeOutbox(firstLease.id, "wrong-lease"));
  assertLeaseRejected(() => service.acknowledgeOutbox({
    id: firstLease.id,
    leaseToken: "wrong-lease",
    delivered: true,
  }));
  assert.equal(
    service.authorizeOutbox(firstLease.id, firstLease.leaseToken).leaseToken,
    firstLease.leaseToken,
  );

  clock.advance(60_001);
  const [secondLease] = service.claimPendingOutbox({
    provider: "wechat",
    connectionId: "wechat-connection",
  });
  assert.ok(secondLease?.leaseToken);
  assert.equal(secondLease.id, firstLease.id);
  assert.notEqual(secondLease.leaseToken, firstLease.leaseToken);
  assertLeaseRejected(() => service.authorizeOutbox(firstLease.id, firstLease.leaseToken!));
  assertLeaseRejected(() => service.acknowledgeOutbox({
    id: firstLease.id,
    leaseToken: firstLease.leaseToken!,
    delivered: true,
  }));

  assert.equal(
    service.authorizeOutbox(secondLease.id, secondLease.leaseToken).leaseToken,
    secondLease.leaseToken,
  );
  const delivered = service.acknowledgeOutbox({
    id: secondLease.id,
    leaseToken: secondLease.leaseToken,
    delivered: true,
  });
  assert.equal(delivered.status, "delivered");
  assert.deepEqual(
    service.claimPendingOutbox({ provider: "wechat", connectionId: "wechat-connection" }),
    [],
  );
  assertLeaseRejected(() => service.authorizeOutbox(secondLease.id, secondLease.leaseToken!));

  const generationReceipt = await service.receiveInboundEvent(
    inboundEvent("wechat", "generation-fence-event"),
    async () => "reply that must remain bound to its generation",
  );
  const [generationLease] = service.claimPendingOutbox({
    provider: "wechat",
    connectionId: "wechat-connection",
  });
  assert.ok(generationLease?.leaseToken);
  assert.equal(generationLease.id, generationReceipt.delivery.id);
  database.connection.prepare(`
    UPDATE im_bindings
    SET binding_generation = 'replacement-generation', owner_id = 'replacement-owner'
    WHERE provider = 'wechat'
  `).run();
  assertLeaseRejected(() => service.authorizeOutbox(
    generationLease.id,
    generationLease.leaseToken!,
  ));
  assertLeaseRejected(() => service.acknowledgeOutbox({
    id: generationLease.id,
    leaseToken: generationLease.leaseToken!,
    delivered: true,
  }));
  clock.advance(60_001);
  assert.deepEqual(
    service.claimPendingOutbox({ provider: "wechat", connectionId: "wechat-connection" }),
    [],
  );
  assert.equal(repository.getOutbox(generationLease.id)?.status, "abandoned");
});

test("a model completion after disconnect and same-id rebind cannot create an old outbox", async (context) => {
  const database = new AppDatabase(":memory:");
  context.after(() => database.close());
  const clock = new VirtualClock("2026-08-19T02:30:00.000Z");
  const repository = new ImRepository(database);
  const service = new ImIntegrationService(
    repository,
    readyGateway(),
    clock,
    new SeededIdGenerator("im-binding-race"),
  );
  const now = clock.now().toISOString();
  database.connection.prepare(
    "INSERT INTO characters(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run("race-character", "Race Character", now, now);
  service.setCharacterRoute("wechat", "race-character");
  repository.upsertConnection({
    provider: "wechat",
    gatewayConnectionId: "wechat-connection",
    bindingGeneration: "wechat-generation",
    accountId: "old-account",
    ownerId: "wechat-owner",
    connectedAt: now,
    now,
  });
  const handlerStarted = deferred();
  const releaseHandler = deferred();
  const operation = service.receiveInboundEvent(
    inboundEvent("wechat", "disconnect-race-event"),
    async (_event, target) => {
      assert.equal(target.bindingGeneration, "wechat-generation");
      assert.equal(target.ownerId, "wechat-owner");
      handlerStarted.resolve();
      await releaseHandler.promise;
      return "must never become deliverable";
    },
  );
  await handlerStarted.promise;

  assert.deepEqual(await service.disconnect("wechat"), { disconnected: true });
  repository.upsertConnection({
    provider: "wechat",
    gatewayConnectionId: "wechat-connection",
    bindingGeneration: "replacement-generation",
    accountId: "replacement-account",
    ownerId: "replacement-owner",
    connectedAt: clock.now().toISOString(),
    now: clock.now().toISOString(),
  });
  releaseHandler.resolve();

  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof ImIntegrationError && error.code === "IM_BINDING_GENERATION_STALE",
  );
  const failed = repository.getInboundEvent("wechat", "disconnect-race-event");
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.lastError, "binding changed before reply completion");
  assert.equal(repository.getOutboxByInboundEvent("wechat", "disconnect-race-event"), undefined);
  assert.deepEqual(
    service.claimPendingOutbox({ provider: "wechat", connectionId: "wechat-connection" }),
    [],
  );
});

test("the local gateway delivers an owner direct reply in order and dispose fails closed", async (context) => {
  const root = temporaryDirectory(context, "yourchar-local-im-gateway-");
  const gateway = new LocalImGateway(root, join(root, "workspace"));
  context.after(async () => gateway.dispose());
  const order: string[] = [];
  const delivery = leasedOutbox("wechat", "owner-direct-reply");
  const core = oneReplyCore(delivery, order);

  gateway.wechat.beginTyping = (chatId) => {
    assert.equal(chatId, "wechat-owner");
    order.push("typing:begin");
    return { stop: async () => { order.push("typing:stop"); } };
  };
  gateway.wechat.send = async (item) => {
    assert.equal(item.id, delivery.id);
    order.push("wechat:send");
  };

  const internals = gateway as unknown as GatewayInternals;
  internals.core = core;
  gateway.setInboundEnabled("wechat", true);
  internals.spool.enqueue(inboundEvent("wechat", "owner-direct-event"));
  await internals.runWorker();
  assert.deepEqual(order, [
    "typing:begin",
    "core:receive",
    "core:claim",
    "core:authorize",
    "wechat:send",
    "core:ack:true",
    "typing:stop",
  ]);

  await gateway.dispose();
  await gateway.dispose();
  await assert.rejects(
    gateway.startBinding("wechat"),
    (error: unknown) => error instanceof ImGatewayError && error.code === "IM_GATEWAY_UNAVAILABLE",
  );
});

test("the outbound timer delivers a reminder while an inbound model turn is still waiting", { timeout: 6000 }, async (context) => {
  const root = temporaryDirectory(context, "yourchar-local-im-reminder-timer-");
  new LocalImCredentialStore(root).set("wechat", { connectionId: "wechat-connection" });
  const gateway = new LocalImGateway(root, join(root, "workspace"));
  const releaseModel = deferred(), modelStarted = deferred(), sent = deferred();
  const keepAlive = setInterval(() => undefined, 1000);
  context.after(() => clearInterval(keepAlive));
  context.after(async () => { releaseModel.resolve(); await gateway.dispose(); });
  // No connector restoration or platform network request is permitted in this test.
  gateway.wechat.restore = async () => undefined;
  gateway.feishu.restore = async () => undefined;
  gateway.wechat.send = async () => { sent.resolve(); };
  const order: string[] = [];
  const delivery = { ...leasedOutbox("wechat", "independent-reminder"), notificationOutboxId: "notification" };
  const core = oneReplyCore(delivery, order);
  const receive = core.receiveInboundEvent;
  core.isWechatTypingEnabled = () => false;
  let waiting = false;
  core.receiveInboundEvent = async event => {
    waiting = true; modelStarted.resolve(); await releaseModel.promise; waiting = false;
    return receive(event);
  };
  await gateway.attachCore(core);
  const internals = gateway as unknown as GatewayInternals;
  gateway.setInboundEnabled("wechat", true);
  internals.spool.enqueue(inboundEvent("wechat", "slow-model-turn"));
  await modelStarted.promise;
  await sent.promise;
  assert.equal(waiting, true, "outbound delivery must not await model completion");
  assert.ok(order.includes("core:authorize"));
  releaseModel.resolve();
});

test("local gateway disconnect waits for an already-authorized platform send", async (context) => {
  const root = temporaryDirectory(context, "yourchar-local-im-disconnect-send-");
  const gateway = new LocalImGateway(root, join(root, "workspace"));
  context.after(async () => gateway.dispose());
  const delivery = leasedOutbox("wechat", "in-flight-send");
  const sendStarted = deferred();
  const releaseSend = deferred();
  let claimed = false;
  let acknowledged = false;
  const core: LocalImCore = {
    isWechatTypingEnabled: () => false,
    receiveInboundEvent: async () => assert.fail("this test only flushes outbox"),
    claimPendingOutbox: () => {
      if (claimed) return [];
      claimed = true;
      return [structuredClone(delivery)];
    },
    authorizeOutbox: (id, leaseToken) => {
      assert.equal(id, delivery.id);
      assert.equal(leaseToken, delivery.leaseToken);
      return structuredClone(delivery);
    },
    acknowledgeOutbox: (input) => {
      assert.equal(input.id, delivery.id);
      assert.equal(input.delivered, true);
      acknowledged = true;
      return structuredClone(delivery);
    },
  };
  gateway.wechat.send = async () => {
    sendStarted.resolve();
    await releaseSend.promise;
  };
  const internals = gateway as unknown as GatewayInternals;
  internals.core = core;

  const flush = internals.flushOutbox("wechat", "wechat-connection");
  await sendStarted.promise;
  let disconnectSettled = false;
  const disconnect = gateway.disconnect("wechat", "wechat-connection").then(() => {
    disconnectSettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disconnectSettled, false, "disconnect must wait for the authorized send boundary");

  releaseSend.resolve();
  await Promise.all([flush, disconnect]);
  assert.equal(acknowledged, true);
  assert.equal(disconnectSettled, true);
});

function temporaryDirectory(context: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function assertLeaseRejected(operation: () => unknown): void {
  assert.throws(
    operation,
    (error: unknown) =>
      error instanceof ImIntegrationError && error.code === "IM_OUTBOX_LEASE_INVALID",
  );
}

function readyGateway(): ImGateway {
  return {
    configured: true,
    supportsAttachments: true,
    getCapabilities: () => [
      {
        provider: "wechat",
        connectorKind: "wechat_tencent_ilink",
        state: "ready",
      },
    ],
    startBinding: async () => { throw new Error("not used"); },
    getBindingSession: async () => { throw new Error("not used"); },
    cancelBindingSession: async () => { throw new Error("not used"); },
    disconnect: async () => undefined,
  };
}

function oneReplyCore(delivery: ImOutboxItem, order: string[]): LocalImCore {
  let claimed = false;
  return {
    isWechatTypingEnabled: () => true,
    receiveInboundEvent: async (event): Promise<ImInboundReceipt> => {
      assert.equal(event.chatType, "direct");
      assert.equal(event.externalChatId, "wechat-owner");
      assert.equal(event.externalUserId, "wechat-owner");
      order.push("core:receive");
      return {
        duplicate: false,
        eventId: event.eventId,
        status: "completed",
        delivery: structuredClone(delivery),
      };
    },
    claimPendingOutbox: (input) => {
      if (
        claimed || input.provider !== delivery.provider ||
        input.connectionId !== delivery.connectionId
      ) return [];
      claimed = true;
      order.push("core:claim");
      return [structuredClone(delivery)];
    },
    authorizeOutbox: (id, leaseToken) => {
      assert.equal(id, delivery.id);
      assert.equal(leaseToken, delivery.leaseToken);
      order.push("core:authorize");
      return structuredClone(delivery);
    },
    acknowledgeOutbox: (input) => {
      assert.equal(input.id, delivery.id);
      assert.equal(input.leaseToken, delivery.leaseToken);
      order.push(`core:ack:${input.delivered}`);
      return structuredClone(delivery);
    },
  };
}

function inboundEvent(provider: ImProvider, eventId: string): ImInboundEventInput {
  return {
    eventId,
    provider,
    connectionId: `${provider}-connection`,
    bindingGeneration: `${provider}-generation`,
    externalChatId: provider === "wechat" ? "wechat-owner" : "feishu-owner-chat",
    externalUserId: provider === "wechat" ? "wechat-owner" : "feishu-owner",
    chatType: "direct",
    text: "owner direct message",
    receivedAt: "2026-08-19T02:00:00.000Z",
  };
}

function leasedOutbox(provider: ImProvider, id: string): ImOutboxItem {
  const now = "2026-08-19T02:00:01.000Z";
  return {
    id,
    provider,
    connectionId: `${provider}-connection`,
    bindingGeneration: `${provider}-generation`,
    externalChatId: provider === "wechat" ? "wechat-owner" : "feishu-owner-chat",
    inboundEventId: `${provider}-event`,
    text: "reply",
    attachments: [],
    status: "pending",
    attempts: 1,
    availableAt: now,
    leaseToken: `lease-${id}`,
    leaseExpiresAt: "2026-08-19T02:01:01.000Z",
    createdAt: now,
    updatedAt: now,
  };
}
