import assert from "node:assert/strict";
import test from "node:test";
import { AppDatabase } from "../src/storage/database.js";
import { createHttpServer } from "../src/http/router.js";
import { TestRuntime } from "../src/testing/runtime.js";
import type {
  FeishuDomain,
  ImGateway,
  ImGatewayBindingSession,
  ImGatewayCapability,
  ImProvider,
} from "../src/im/index.js";

class FakeImGateway implements ImGateway {
  readonly configured = true;
  readonly detail = "fake IM gateway";
  readonly supportsAttachments = true;
  readonly sessions = new Map<string, ImGatewayBindingSession>();
  readonly disconnected: Array<{ provider: ImProvider; connectionId: string }> = [];
  private sequence = 0;

  getCapabilities(): readonly ImGatewayCapability[] {
    return [
      {
        provider: "feishu",
        connectorKind: "feishu_personal_agent",
        state: "ready",
        domains: ["feishu", "lark"],
      },
      {
        provider: "wechat",
        connectorKind: "wechat_tencent_ilink",
        state: "ready",
      },
    ];
  }

  async startBinding(
    provider: ImProvider,
    options: { domain?: FeishuDomain } = {},
  ): Promise<ImGatewayBindingSession> {
    this.sequence += 1;
    const session: ImGatewayBindingSession = {
      id: `binding-${this.sequence}`,
      provider,
      status: "waiting_scan",
      ...(options.domain ? { domain: options.domain } : {}),
      qrCodeUrl: "data:image/png;base64,iVBORw0KGgo=",
      createdAt: "2026-08-19T01:00:00.000Z",
      updatedAt: "2026-08-19T01:00:00.000Z",
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async getBindingSession(id: string): Promise<ImGatewayBindingSession> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`unknown fake binding session: ${id}`);
    return session;
  }

  async cancelBindingSession(id: string): Promise<ImGatewayBindingSession> {
    const session = await this.getBindingSession(id);
    const cancelled = { ...session, status: "cancelled" as const };
    this.sessions.set(id, cancelled);
    return cancelled;
  }

  async disconnect(provider: ImProvider, connectionId: string): Promise<void> {
    this.disconnected.push({ provider, connectionId });
  }

  connect(
    id: string,
    input: {
      connectionId: string;
      accountId: string;
      ownerId: string;
      displayName: string;
    },
  ): void {
    const session = this.sessions.get(id);
    assert.ok(session);
    this.sessions.set(id, {
      ...session,
      status: "connected",
      connection: {
        id: input.connectionId,
        accountId: input.accountId,
        ownerId: input.ownerId,
        displayName: input.displayName,
        ...(session.domain ? { domain: session.domain } : {}),
        connectedAt: "2026-08-19T01:01:00.000Z",
      },
    });
  }
}

test("current schema contains character-routed IM tables and scoped interaction state", () => {
  const database = new AppDatabase(":memory:");
  try {
    const version = database.connection.prepare(
      "SELECT MAX(version) AS version FROM schema_migrations",
    ).get() as { version: number };
    assert.equal(Number(version.version), 58);
    const tables = database.connection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'im_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((row) => row.name), [
      "im_binding_sessions",
      "im_bindings",
      "im_character_routes",
      "im_inbound_events",
      "im_outbox",
      "im_runtime_settings",
    ]);
    assert.equal(Boolean(database.connection.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'schedule_delivery_targets'
    `).get()), false);
    const inboundColumns = database.connection.prepare(
      "PRAGMA table_info(im_inbound_events)",
    ).all() as Array<{ name: string; notnull: number }>;
    for (const name of ["binding_generation", "character_id", "attachments_json"]) {
      assert.equal(inboundColumns.find((column) => column.name === name)?.notnull, 1, name);
    }
    const inboundForeignKeys = database.connection.prepare(
      "PRAGMA foreign_key_list(im_inbound_events)",
    ).all() as Array<{ table: string }>;
    assert.equal(inboundForeignKeys.some((entry) => entry.table === "characters"), false);
  } finally {
    database.close();
  }
});

test("Feishu and WeChat route owner DMs to their selected character's normal SMS thread", async () => {
  const gateway = new FakeImGateway();
  const runtime = new TestRuntime("im-character-routing", {
    now: "2026-08-19T01:00:00.000Z",
    imGateway: gateway,
  });
  const server = createHttpServer({
    kernel: runtime.kernel,
    imGatewaySecret: "0123456789abcdef-gateway",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${baseUrl}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const controlHeaders = {
      "content-type": "application/json",
      cookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    };
    const feishuCharacter = runtime.kernel.createCharacter({ name: "飞书角色" });
    const wechatCharacter = runtime.kernel.createCharacter({ name: "微信角色" });

    const unguarded = await fetch(`${baseUrl}/api/v1/im/channels/feishu`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: feishuCharacter.id }),
    });
    assert.equal(unguarded.status, 403);

    for (const [provider, characterId] of [
      ["feishu", feishuCharacter.id],
      ["wechat", wechatCharacter.id],
    ] as const) {
      const routed = await fetch(`${baseUrl}/api/v1/im/channels/${provider}`, {
        method: "PATCH",
        headers: controlHeaders,
        body: JSON.stringify({ characterId }),
      });
      assert.equal(routed.status, 200);
      assert.equal(((await routed.json()) as { route: { characterId: string } }).route.characterId, characterId);
    }

    const privateCanary = "PRIVATE_IM_ISOLATION_CANARY_9f21";
    const secretConversation = await runtime.kernel.openCanonicalPrivateConversation(
      feishuCharacter.id,
      "secret",
    );
    runtime.model.enqueue([{ kind: "assistant_text", text: "私密会话回复" }]);
    await runtime.kernel.sendMessage(secretConversation.id, {
      mode: "sms",
      conversationSpace: "secret",
      characterId: feishuCharacter.id,
      text: privateCanary,
    });

    const channels = await (await fetch(`${baseUrl}/api/v1/im/channels`)).json() as {
      channels: Array<{ provider: ImProvider; characterId?: string }>;
    };
    assert.deepEqual(
      Object.fromEntries(channels.channels.map((channel) => [channel.provider, channel.characterId])),
      { feishu: feishuCharacter.id, wechat: wechatCharacter.id },
    );

    const bindings = new Map<ImProvider, { sessionId: string; connectionId: string; ownerId: string }>();
    for (const provider of ["feishu", "wechat"] as const) {
      const started = await fetch(`${baseUrl}/api/v1/im/bindings/${provider}/qr`, {
        method: "POST",
        headers: controlHeaders,
        body: JSON.stringify(provider === "feishu" ? { domain: "feishu" } : {}),
      });
      assert.equal(started.status, 201);
      const sessionId = ((await started.json()) as { session: { id: string } }).session.id;
      const connectionId = `${provider}-connection`;
      const ownerId = `${provider}-owner`;
      gateway.connect(sessionId, {
        connectionId,
        accountId: `${provider}-account-secret`,
        ownerId,
        displayName: `${provider} owner`,
      });
      const polled = await fetch(
        `${baseUrl}/api/v1/im/binding-sessions/${encodeURIComponent(sessionId)}`,
      );
      const publicConnection = ((await polled.json()) as {
        session: { connection: Record<string, unknown> };
      }).session.connection;
      assert.deepEqual(
        Object.keys(publicConnection).sort(),
        provider === "feishu"
          ? ["connectedAt", "displayName", "domain", "provider", "updatedAt"]
          : ["connectedAt", "displayName", "provider", "updatedAt"],
      );
      bindings.set(provider, { sessionId, connectionId, ownerId });
    }

    const blockedSpace = await postGatewayEvent(baseUrl, {
      ...gatewayEvent("feishu", bindings.get("feishu")!, "blocked-space", "不能进入私密模式"),
      conversationSpace: "secret",
    });
    assert.equal(blockedSpace.status, 400);
    assert.equal(((await blockedSpace.json()) as { code: string }).code, "IM_REQUEST_INVALID");
    const blockedMedia = await postGatewayEvent(baseUrl, {
      ...gatewayEvent("feishu", bindings.get("feishu")!, "blocked-media", "伪造附件"),
      attachments: [{ path: "uploads/im/forged" }],
    });
    assert.equal(blockedMedia.status, 501);
    assert.equal(((await blockedMedia.json()) as { code: string }).code, "IM_MEDIA_GATEWAY_UNSUPPORTED");

    const unauthorizedEvent = gatewayEvent(
      "feishu",
      bindings.get("feishu")!,
      "unauthorized-event",
      "未授权消息",
    );
    const unauthorized = await fetch(`${baseUrl}/api/v1/im/gateway/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unauthorizedEvent),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(runtime.model.requests.length, 1);

    runtime.model.enqueue([
      { kind: "assistant_text", text: "飞书角色回复" },
      { kind: "assistant_text", text: "微信角色回复" },
    ]);
    let feishuDeliveryText = "";
    for (const [provider, expectedReply] of [
      ["feishu", "飞书角色回复"],
      ["wechat", "微信角色回复"],
    ] as const) {
      const response = await postGatewayEvent(
        baseUrl,
        gatewayEvent(provider, bindings.get(provider)!, `${provider}-event`, `${provider}消息`),
      );
      assert.equal(response.status, 200);
      const receipt = await response.json() as {
        duplicate: boolean;
        delivery: { text: string; status: string };
      };
      assert.equal(receipt.duplicate, false);
      assert.equal(receipt.delivery.text, expectedReply);
      assert.equal(receipt.delivery.status, "pending");
      if (provider === "feishu") feishuDeliveryText = receipt.delivery.text;
    }

    const feishuImRequest = runtime.model.requests[1];
    assert.ok(feishuImRequest);
    assert.doesNotMatch(JSON.stringify({
      systemPrompt: feishuImRequest.systemPrompt,
      messages: feishuImRequest.messages,
      providerPayload: feishuImRequest.providerPayload,
      deliveryText: feishuDeliveryText,
    }), new RegExp(privateCanary));

    const canonical = runtime.kernel.listConversationMetadata()
      .filter((entry) => entry.canonicalDirect && entry.conversationSpace === "normal");
    assert.deepEqual(
      canonical.map((entry) => ({
        characterId: entry.characterId,
        mode: entry.mode,
        conversationSpace: entry.conversationSpace,
      })).sort((left, right) => String(left.characterId).localeCompare(String(right.characterId))),
      [feishuCharacter.id, wechatCharacter.id].sort().map((characterId) => ({
        characterId,
        mode: "sms",
        conversationSpace: "normal",
      })),
    );
    const persistedSecret = runtime.kernel.listConversationMetadata()
      .find((entry) => entry.id === secretConversation.id);
    assert.equal(persistedSecret?.conversationSpace, "secret");
    const feishuNormal = canonical.find((entry) => entry.characterId === feishuCharacter.id);
    assert.ok(feishuNormal);
    assert.doesNotMatch(
      JSON.stringify(await runtime.kernel.getConversationTranscript(feishuNormal.id)),
      new RegExp(privateCanary),
    );

    const clearedRoute = await fetch(`${baseUrl}/api/v1/im/channels/feishu`, {
      method: "PATCH",
      headers: controlHeaders,
      body: JSON.stringify({ characterId: null }),
    });
    assert.equal(clearedRoute.status, 200);
    const afterClear = await postGatewayEvent(
      baseUrl,
      gatewayEvent(
        "feishu",
        bindings.get("feishu")!,
        "event-after-route-clear",
        "清除路由后不能进入任何角色",
      ),
    );
    assert.equal(afterClear.status, 409);
    assert.equal(
      ((await afterClear.json()) as { code: string }).code,
      "IM_CHARACTER_ROUTE_REQUIRED",
    );
    assert.equal(
      runtime.kernel.imIntegrations.repository.getInboundEvent(
        "feishu",
        "event-after-route-clear",
      ),
      undefined,
    );
    assert.equal(
      runtime.kernel.imIntegrations.repository.getOutboxByInboundEvent(
        "feishu",
        "event-after-route-clear",
      ),
      undefined,
    );

    await runtime.kernel.deleteAllUserData();
    assert.deepEqual(gateway.disconnected.map((entry) => entry.provider).sort(), ["feishu", "wechat"]);
    for (const table of [
      "im_character_routes",
      "im_bindings",
      "im_binding_sessions",
      "im_inbound_events",
      "im_outbox",
    ]) {
      const row = runtime.kernel.database.connection.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).get() as { count: number };
      assert.equal(Number(row.count), 0, table);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    runtime.dispose();
  }
});

test("rebind with a reused connection id cannot deliver an in-flight reply to the new owner", async () => {
  const gateway = new FakeImGateway();
  const runtime = new TestRuntime("im-rebind-fence", {
    now: "2026-08-19T02:00:00.000Z",
    imGateway: gateway,
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "重绑隔离角色" });
    runtime.kernel.setImCharacterRoute("feishu", character.id);
    const original = await runtime.kernel.startImBinding("feishu", { domain: "feishu" });
    gateway.connect(original.id, {
      connectionId: "reused-connection",
      accountId: "old-account",
      ownerId: "old-owner",
      displayName: "旧主人",
    });
    await runtime.kernel.getImBindingSession(original.id);

    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "绝不能发给新主人的旧回复",
      delayMs: 300,
    }]);
    const staleReply = runtime.kernel.receiveImInboundEvent({
      eventId: "old-generation-event",
      provider: "feishu",
      connectionId: "reused-connection",
      bindingGeneration: original.id,
      externalChatId: "old-owner-chat",
      externalUserId: "old-owner",
      chatType: "direct",
      text: "旧授权下的消息",
    });
    await waitFor(() => runtime.model.requests.length === 1);

    await runtime.kernel.disconnectImBinding("feishu");
    const rebound = await runtime.kernel.startImBinding("feishu", { domain: "feishu" });
    gateway.connect(rebound.id, {
      connectionId: "reused-connection",
      accountId: "new-account",
      ownerId: "new-owner",
      displayName: "新主人",
    });
    await runtime.kernel.getImBindingSession(rebound.id);

    await assert.rejects(staleReply);
    assert.equal(
      runtime.kernel.imIntegrations.repository.getOutboxByInboundEvent(
        "feishu",
        "old-generation-event",
      ),
      undefined,
    );

    runtime.model.enqueue([{ kind: "assistant_text", text: "新授权回复" }]);
    const current = await runtime.kernel.receiveImInboundEvent({
      eventId: "new-generation-event",
      provider: "feishu",
      connectionId: "reused-connection",
      bindingGeneration: rebound.id,
      externalChatId: "new-owner-chat",
      externalUserId: "new-owner",
      chatType: "direct",
      text: "新授权下的消息",
    });
    assert.equal(current.delivery.text, "新授权回复");
    const claimed = runtime.kernel.claimImPendingOutbox({ provider: "feishu" });
    assert.deepEqual(claimed.map((item) => item.inboundEventId), ["new-generation-event"]);
  } finally {
    runtime.dispose();
  }
});

function gatewayEvent(
  provider: ImProvider,
  binding: { sessionId: string; connectionId: string; ownerId: string },
  eventId: string,
  text: string,
) {
  return {
    eventId,
    provider,
    connectionId: binding.connectionId,
    bindingGeneration: binding.sessionId,
    externalChatId: `${provider}-direct-chat`,
    externalUserId: binding.ownerId,
    chatType: "direct",
    text,
    timezone: "Asia/Shanghai",
  };
}

function postGatewayEvent(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/im/gateway/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer 0123456789abcdef-gateway",
    },
    body: JSON.stringify(body),
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
