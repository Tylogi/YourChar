import { createHash } from "node:crypto";
import type { Clock } from "../app/clock.js";
import type { IdGenerator } from "../app/id-generator.js";
import type { ImGateway } from "./gateway.js";
import { ImGatewayError } from "./gateway.js";
import {
  ImRepository,
  ImRepositoryBindingStaleError,
  ImRepositoryCharacterNotFoundError,
  ImRepositoryConflictError,
} from "./repository.js";
import type {
  FeishuDomain,
  ImAttachment,
  ImBindingSession,
  ImCharacterRoute,
  ImChannelState,
  ImGatewayBindingSession,
  ImInboundEventInput,
  ImInboundReceipt,
  ImInboundTarget,
  ImOutboxItem,
  ImOutboundMessage,
  ImProvider,
  ImRuntimeSettingsPatch,
  ImRuntimeSettingsResponse,
} from "./types.js";
import { isFeishuDomain, isImProvider } from "./types.js";

const activeBindingStatuses = new Set<ImBindingSession["status"]>(["waiting_scan", "scanned"]);
const missingAssistantProfileError = "Create the assistant profile first";
const missingCharacterRouteError = "Choose a character for this IM channel first";

export class ImIntegrationService {
  private readonly qrCodeCache = new Map<string, string>();
  private readonly providerOperations = new Map<ImProvider, Promise<void>>();
  private readonly inFlightIngress = new Set<Promise<unknown>>();
  private ingressPaused = false;

  get isBusy(): boolean { return this.inFlightIngress.size > 0 || this.providerOperations.size > 0; }

  constructor(
    readonly repository: ImRepository,
    readonly gateway: ImGateway,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
  ) {
    this.repository.recoverInterruptedInboundEvents(this.clock.now().toISOString());
    for (const provider of ["feishu", "wechat"] as const) {
      this.gateway.setInboundEnabled?.(
        provider,
        Boolean(this.repository.getCharacterRoute(provider)),
      );
    }
  }

  getRuntimeSettings(): ImRuntimeSettingsResponse {
    return {
      ...this.repository.getRuntimeSettings(),
      supported: this.gateway.getCapabilities?.().some((capability) =>
        capability.provider === "wechat" && capability.connectorKind === "wechat_tencent_ilink"
      ) ?? false,
      appliesTo: "new_wechat_messages",
    };
  }

  patchRuntimeSettings(patch: ImRuntimeSettingsPatch): ImRuntimeSettingsResponse {
    if (
      patch.wechatTypingEnabled !== undefined &&
      typeof patch.wechatTypingEnabled !== "boolean"
    ) {
      throw new ImIntegrationError(
        "IM_REQUEST_INVALID",
        "wechatTypingEnabled must be a boolean",
        400,
      );
    }
    if (patch.wechatTypingEnabled !== undefined) {
      this.repository.patchRuntimeSettings(
        patch.wechatTypingEnabled,
        this.clock.now().toISOString(),
      );
    }
    return this.getRuntimeSettings();
  }

  isWechatTypingEnabled(): boolean {
    return this.repository.getRuntimeSettings().wechatTypingEnabled;
  }

  getCharacterRoute(provider: ImProvider): ImCharacterRoute | undefined {
    if (!isImProvider(provider)) {
      throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", 400);
    }
    return this.repository.getCharacterRoute(provider);
  }

  setCharacterRoute(provider: ImProvider, characterId: string): ImCharacterRoute {
    if (!isImProvider(provider)) {
      throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", 400);
    }
    const normalizedCharacterId = boundedValue(characterId, "characterId", 256);
    try {
      const route = this.repository.setCharacterRoute(
        provider,
        normalizedCharacterId,
        this.clock.now().toISOString(),
      );
      this.gateway.setInboundEnabled?.(provider, true);
      return route;
    } catch (error) {
      if (error instanceof ImRepositoryCharacterNotFoundError) {
        throw new ImIntegrationError("IM_CHARACTER_NOT_FOUND", "角色不存在", 404);
      }
      throw error;
    }
  }

  clearCharacterRoute(provider: ImProvider): { cleared: boolean } {
    if (!isImProvider(provider)) {
      throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", 400);
    }
    this.gateway.setInboundEnabled?.(provider, false);
    return { cleared: Boolean(this.repository.clearCharacterRoute(provider)) };
  }

  listChannels(): ImChannelState {
    const capabilities = this.gateway.getCapabilities?.() ?? [];
    return {
      gateway: {
        configured: this.gateway.configured,
        ...(this.gateway.detail ? { detail: this.gateway.detail } : {}),
      },
      channels: (["feishu", "wechat"] as const).map((provider) => {
        const capability = capabilities.find((entry) => entry.provider === provider);
        const connection = this.repository.getConnection(provider);
        const characterRoute = this.repository.getCharacterRoute(provider);
        const latest = this.repository.latestBindingSession(provider);
        const status = connection
          ? "connected"
          : latest && activeBindingStatuses.has(latest.status)
            ? "binding"
            : latest?.status === "failed" ? "error" : "unbound";
        const availability = !this.gateway.configured
          ? "gateway_required" as const
          : capability?.state === "unsupported"
            ? "unsupported" as const
            : capability && capability.state !== "ready"
              ? "connector_unavailable" as const
              : "available" as const;
        return {
          provider,
          ...(characterRoute ? { characterId: characterRoute.characterId } : {}),
          label: provider === "feishu" ? "飞书 / Lark" : "微信",
          description: provider === "feishu"
            ? "扫码创建 Personal Agent 应用，通过官方长连接把本人单聊的文字、图片和文件接入所选角色。"
            : "通过腾讯微信连接器扫码授权，把本人 AI 助手单聊中的文字、图片和文件接入所选角色。",
          status,
          availability,
          ...(capability
            ? {
                connector: {
                  connectorKind: capability.connectorKind,
                  state: capability.state,
                  ...(capability.detail ? { detail: capability.detail } : {}),
                  ...(capability.domains ? { domains: capability.domains } : {}),
                },
              }
            : {}),
          ...(connection
            ? {
                connection: {
                  provider: connection.provider,
                  ...(connection.displayName ? { displayName: connection.displayName } : {}),
                  ...(connection.domain ? { domain: connection.domain } : {}),
                  connectedAt: connection.connectedAt,
                  updatedAt: connection.updatedAt,
                  ...(connection.lastSeenAt ? { lastSeenAt: connection.lastSeenAt } : {}),
                },
              }
            : {}),
        };
      }),
    };
  }

  async startBinding(
    provider: ImProvider,
    options: { domain?: FeishuDomain } = {},
  ): Promise<ImBindingSession> {
    return this.withProviderOperation(provider, () => this.startBindingLocked(provider, options));
  }

  private async startBindingLocked(
    provider: ImProvider,
    options: { domain?: FeishuDomain },
  ): Promise<ImBindingSession> {
    if (this.ingressPaused) {
      throw new ImIntegrationError("IM_MAINTENANCE_IN_PROGRESS", "IM 接入正在暂停维护", 503);
    }
    if (!isImProvider(provider)) throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", 404);
    if (!this.repository.getCharacterRoute(provider)) {
      throw new ImIntegrationError(
        "IM_CHARACTER_ROUTE_REQUIRED",
        missingCharacterRouteError,
        409,
      );
    }
    if (!this.gateway.configured) {
      throw new ImIntegrationError(
        "IM_GATEWAY_UNAVAILABLE",
        this.gateway.detail ?? "IM gateway 尚未配置",
        503,
      );
    }
    const capability = this.gateway.getCapabilities?.().find((entry) => entry.provider === provider);
    if (capability && capability.state !== "ready") {
      throw new ImIntegrationError(
        "IM_CONNECTOR_UNAVAILABLE",
        capability.detail ?? "该 IM 连接器当前不可用",
        503,
      );
    }
    if (this.repository.getConnection(provider)) {
      throw new ImIntegrationError("IM_ALREADY_BOUND", "该平台已经绑定，请先解绑", 409);
    }
    if (provider === "feishu" && options.domain !== undefined && !isFeishuDomain(options.domain)) {
      throw new ImIntegrationError("IM_DOMAIN_INVALID", "domain must be feishu or lark", 400);
    }
    if (provider !== "feishu" && options.domain !== undefined) {
      throw new ImIntegrationError("IM_DOMAIN_INVALID", "domain is only valid for Feishu/Lark", 400);
    }
    const latest = this.repository.latestBindingSession(provider);
    if (latest && activeBindingStatuses.has(latest.status)) {
      try {
        const remote = await this.gateway.cancelBindingSession(latest.id);
        if (remote.id !== latest.id || remote.provider !== provider) {
          throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的绑定会话", 502);
        }
        const cancelled = this.applyGatewaySession(remote, provider, latest.domain);
        if (cancelled.status === "connected") return cancelled;
        if (activeBindingStatuses.has(cancelled.status)) {
          throw new ImIntegrationError("IM_GATEWAY_CANCEL_INCOMPLETE", "gateway 未确认旧绑定会话已取消", 502);
        }
      } catch (error) {
        throw asIntegrationError(error);
      }
    }
    try {
      const effectiveDomain = provider === "feishu" ? options.domain ?? "feishu" : undefined;
      const session = await this.gateway.startBinding(provider, {
        ...(effectiveDomain ? { domain: effectiveDomain } : {}),
      });
      try {
        return this.applyGatewaySession(session, provider, effectiveDomain, false);
      } catch (error) {
        if (session.provider === provider && session.id.trim()) {
          await this.gateway.cancelBindingSession(session.id).catch(() => undefined);
        }
        throw error;
      }
    } catch (error) {
      throw asIntegrationError(error);
    }
  }

  async getBindingSession(id: string): Promise<ImBindingSession> {
    const normalizedId = boundedValue(id, "binding session id", 256);
    const local = this.repository.getBindingSession(normalizedId);
    if (!local) throw new ImIntegrationError("IM_BINDING_SESSION_NOT_FOUND", "绑定会话不存在", 404);
    return this.withProviderOperation(local.provider, () => this.getBindingSessionLocked(normalizedId));
  }

  private async getBindingSessionLocked(normalizedId: string): Promise<ImBindingSession> {
    this.assertControlAvailable();
    const local = this.repository.getBindingSession(normalizedId);
    if (!local) throw new ImIntegrationError("IM_BINDING_SESSION_NOT_FOUND", "绑定会话不存在", 404);
    if (!activeBindingStatuses.has(local.status)) return this.withCachedQr(local);
    try {
      const remote = await this.gateway.getBindingSession(normalizedId);
      if (remote.id !== normalizedId) {
        throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的绑定会话", 502);
      }
      return this.applyGatewaySession(remote, local.provider, local.domain);
    } catch (error) {
      if (!this.gateway.configured) return this.withCachedQr(local);
      throw asIntegrationError(error);
    }
  }

  async cancelBindingSession(id: string): Promise<ImBindingSession> {
    const normalizedId = boundedValue(id, "binding session id", 256);
    const local = this.repository.getBindingSession(normalizedId);
    if (!local) throw new ImIntegrationError("IM_BINDING_SESSION_NOT_FOUND", "绑定会话不存在", 404);
    return this.withProviderOperation(local.provider, () => this.cancelBindingSessionLocked(normalizedId));
  }

  async submitBindingVerification(id: string, code: string): Promise<ImBindingSession> {
    const normalizedId = boundedValue(id, "binding session id", 256);
    const normalizedCode = boundedValue(code, "verification code", 32);
    const local = this.repository.getBindingSession(normalizedId);
    if (!local) throw new ImIntegrationError("IM_BINDING_SESSION_NOT_FOUND", "绑定会话不存在", 404);
    return this.withProviderOperation(local.provider, async () => {
      this.assertControlAvailable();
      const submit = this.gateway.submitBindingVerification;
      if (!submit) {
        throw new ImIntegrationError("IM_VERIFICATION_UNSUPPORTED", "当前连接器不支持提交配对码", 501);
      }
      try {
        const remote = await submit.call(this.gateway, normalizedId, normalizedCode);
        if (remote.id !== normalizedId) {
          throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的绑定会话", 502);
        }
        return this.applyGatewaySession(remote, local.provider, local.domain);
      } catch (error) {
        throw asIntegrationError(error);
      }
    });
  }

  private async cancelBindingSessionLocked(normalizedId: string): Promise<ImBindingSession> {
    this.assertControlAvailable();
    const local = this.repository.getBindingSession(normalizedId);
    if (!local) throw new ImIntegrationError("IM_BINDING_SESSION_NOT_FOUND", "绑定会话不存在", 404);
    if (!activeBindingStatuses.has(local.status)) return this.withCachedQr(local);
    try {
      const remote = await this.gateway.cancelBindingSession(normalizedId);
      if (remote.id !== normalizedId) {
        throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的绑定会话", 502);
      }
      const session = this.applyGatewaySession(remote, local.provider, local.domain);
      if (activeBindingStatuses.has(session.status)) {
        throw new ImIntegrationError("IM_GATEWAY_CANCEL_INCOMPLETE", "gateway 未确认绑定会话已取消", 502);
      }
      this.qrCodeCache.delete(normalizedId);
      return session;
    } catch (error) {
      throw asIntegrationError(error);
    }
  }

  async disconnect(provider: ImProvider): Promise<{ disconnected: boolean }> {
    return this.withProviderOperation(provider, () => this.disconnectLocked(provider));
  }

  private async disconnectLocked(provider: ImProvider): Promise<{ disconnected: boolean }> {
    this.assertControlAvailable();
    const connection = this.repository.getConnection(provider);
    if (!connection) return { disconnected: false };
    try {
      await this.gateway.disconnect(provider, connection.gatewayConnectionId);
    } catch (error) {
      throw asIntegrationError(error);
    }
    this.repository.deleteConnection(provider, this.clock.now().toISOString());
    return { disconnected: true };
  }

  async revokeAll(): Promise<{ attempted: number; failures: string[] }> {
    const results = await Promise.all(
      (["feishu", "wechat"] as const).map((provider) =>
        this.withProviderOperation(provider, () => this.revokeProviderLocked(provider))
      ),
    );
    return {
      attempted: results.reduce((total, result) => total + result.attempted, 0),
      failures: results.flatMap((result) => result.failures),
    };
  }

  private async revokeProviderLocked(provider: ImProvider): Promise<{ attempted: number; failures: string[] }> {
    let attempted = 0;
    const failures: string[] = [];
    const activeSession = this.repository.latestBindingSession(provider);
    if (activeSession && activeBindingStatuses.has(activeSession.status)) {
      attempted += 1;
      try {
        const remote = await this.gateway.cancelBindingSession(activeSession.id);
        if (remote.id !== activeSession.id || remote.provider !== provider) {
          throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的绑定会话", 502);
        }
        const applied = this.applyGatewaySession(remote, provider, activeSession.domain);
        if (activeBindingStatuses.has(applied.status)) {
          throw new ImIntegrationError("IM_GATEWAY_CANCEL_INCOMPLETE", "gateway 未确认绑定会话已取消", 502);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    const connection = this.repository.getConnection(provider);
    if (connection) {
      attempted += 1;
      try {
        await this.gateway.disconnect(provider, connection.gatewayConnectionId);
        const now = this.clock.now().toISOString();
        this.repository.deleteConnection(provider, now);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    return { attempted, failures };
  }

  receiveInboundEvent(
    rawEvent: ImInboundEventInput,
    handler: (
      event: ImInboundEventInput,
      target: ImInboundTarget,
    ) => Promise<string | ImOutboundMessage>,
  ): Promise<ImInboundReceipt> {
    if (this.ingressPaused) {
      return Promise.reject(new ImIntegrationError("IM_INGRESS_PAUSED", "IM ingress 正在暂停维护", 503));
    }
    const operation = this.processInboundEvent(rawEvent, handler);
    this.inFlightIngress.add(operation);
    void operation.finally(() => this.inFlightIngress.delete(operation)).catch(() => undefined);
    return operation;
  }

  private async processInboundEvent(
    rawEvent: ImInboundEventInput,
    handler: (
      event: ImInboundEventInput,
      target: ImInboundTarget,
    ) => Promise<string | ImOutboundMessage>,
  ): Promise<ImInboundReceipt> {
    const event = normalizeInboundEvent(rawEvent);
    const connection = this.repository.getConnectionByGatewayId(event.provider, event.connectionId);
    if (!connection) {
      throw new ImIntegrationError("IM_BINDING_NOT_FOUND", "消息来自未知或已解绑的连接", 404);
    }
    if (event.chatType !== "direct") {
      throw new ImIntegrationError("IM_GROUP_CHAT_BLOCKED", "首版仅允许绑定用户本人的一对一消息", 403);
    }
    if (event.externalUserId !== connection.ownerId) {
      throw new ImIntegrationError("IM_SENDER_NOT_OWNER", "消息发送者不是当前绑定用户", 403);
    }
    if (event.bindingGeneration !== undefined) {
      if (event.bindingGeneration !== connection.bindingGeneration) {
        throw new ImIntegrationError(
          "IM_BINDING_GENERATION_STALE",
          "消息来自过期的绑定授权",
          409,
        );
      }
    } else if (this.repository.hasConnectionGenerationConflict(
      event.provider,
      event.connectionId,
      connection.bindingGeneration,
    )) {
      throw new ImIntegrationError(
        "IM_BINDING_GENERATION_REQUIRED",
        "该连接标识曾被重新绑定，gateway 必须携带当前绑定代次",
        409,
      );
    }
    const acceptedEvent: ImInboundEventInput = {
      ...event,
      bindingGeneration: connection.bindingGeneration,
    };
    // A previously claimed event stays pinned to its original character even
    // if the provider route changes. A brand-new event must observe a current
    // route before any model work is claimed, so setting the route later can
    // safely retry the same durable platform event.
    const priorEvent = this.repository.getInboundEvent(event.provider, event.eventId);
    const characterId = priorEvent?.characterId ??
      this.repository.getCharacterRoute(event.provider)?.characterId;
    if (!characterId) {
      throw new ImIntegrationError(
        "IM_CHARACTER_ROUTE_REQUIRED",
        missingCharacterRouteError,
        409,
      );
    }
    const now = this.clock.now().toISOString();
    const payloadDigest = inboundDigest(acceptedEvent);
    let claim;
    try {
      claim = this.repository.claimInboundEvent({
        event: acceptedEvent,
        bindingGeneration: connection.bindingGeneration,
        characterId,
        payloadDigest,
        now,
      });
    } catch (error) {
      if (error instanceof ImRepositoryConflictError) {
        throw new ImIntegrationError("IM_EVENT_CONFLICT", error.message, 409);
      }
      throw error;
    }
    if (claim.kind === "completed") {
      return {
        duplicate: true,
        eventId: event.eventId,
        status: "completed",
        delivery: claim.delivery,
      };
    }
    if (claim.kind === "processing") {
      throw new ImIntegrationError("IM_EVENT_IN_PROGRESS", "该消息正在处理中，请稍后重试", 409);
    }
    if (claim.kind === "failed") {
      const retryingProfileBootstrap = claim.event.lastError === missingAssistantProfileError &&
        this.repository.retryFailedInboundEvent(
          event.provider,
          event.eventId,
          missingAssistantProfileError,
          this.clock.now().toISOString(),
        );
      if (!retryingProfileBootstrap) {
        throw new ImIntegrationError(
          "IM_EVENT_PREVIOUSLY_FAILED",
          claim.event.lastError ?? "该消息此前处理失败，需要人工确认后重放",
          409,
        );
      }
    }
    this.repository.touchConnection(acceptedEvent.provider, acceptedEvent.connectionId, now);
    try {
      const rawReply = await handler(acceptedEvent, {
        provider: acceptedEvent.provider,
        characterId,
        conversationSpace: "normal",
        connectionId: acceptedEvent.connectionId,
        bindingGeneration: connection.bindingGeneration,
        accountId: connection.accountId,
        ownerId: connection.ownerId,
        externalChatId: acceptedEvent.externalChatId,
      });
      const reply = normalizeOutboundMessage(rawReply);
      if (reply.attachments.length && this.gateway.supportsAttachments !== true) {
        throw new ImIntegrationError(
          "IM_MEDIA_GATEWAY_UNSUPPORTED",
          "当前外部 IM Gateway 尚不支持 Workspace 附件投递",
          501,
        );
      }
      let delivery: ImOutboxItem;
      try {
        delivery = this.repository.completeInboundEvent({
          provider: event.provider,
          eventId: event.eventId,
          outboxId: this.idGenerator.next("im-outbox"),
          replyText: reply.text,
          attachments: reply.attachments,
          now: this.clock.now().toISOString(),
        });
      } catch (error) {
        if (error instanceof ImRepositoryBindingStaleError) {
          throw new ImIntegrationError(
            "IM_BINDING_GENERATION_STALE",
            "绑定已在回复生成期间变更，旧回复已丢弃",
            409,
          );
        }
        throw error;
      }
      return { duplicate: false, eventId: event.eventId, status: "completed", delivery };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.failInboundEvent(event.provider, event.eventId, message.slice(0, 2_000), this.clock.now().toISOString());
      throw error;
    }
  }

  getOutbox(id: string): ImOutboxItem | undefined {
    return this.repository.getOutbox(boundedValue(id, "outbox id", 256));
  }

  claimPendingOutbox(input: {
    provider?: ImProvider;
    connectionId?: string;
    limit?: number;
  }): ImOutboxItem[] {
    this.assertControlAvailable();
    if (input.provider !== undefined && !isImProvider(input.provider)) {
      throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", 400);
    }
    const now = this.clock.now();
    return this.repository.claimPendingOutbox({
      ...input,
      ...(input.connectionId ? { connectionId: boundedValue(input.connectionId, "connectionId", 256) } : {}),
      now: now.toISOString(),
      leaseToken: this.idGenerator.next("im-lease"),
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
      allowAttachments: this.gateway.supportsAttachments === true,
    });
  }

  acknowledgeOutbox(input: {
    id: string;
    leaseToken: string;
    delivered: boolean;
    error?: string;
    retryAt?: string;
  }): ImOutboxItem {
    this.assertControlAvailable();
    const id = boundedValue(input.id, "outbox id", 256);
    if (input.retryAt && !Number.isFinite(Date.parse(input.retryAt))) {
      throw new ImIntegrationError("IM_RETRY_AT_INVALID", "retryAt must be an ISO timestamp", 400);
    }
    const retryAt = input.retryAt ? new Date(input.retryAt).toISOString() : undefined;
    const item = this.repository.acknowledgeOutbox({
      id,
      leaseToken: boundedValue(input.leaseToken, "leaseToken", 256),
      delivered: input.delivered,
      ...(input.error ? { error: boundedValue(input.error, "error", 2_000) } : {}),
      ...(retryAt ? { retryAt } : {}),
      now: this.clock.now().toISOString(),
    });
    if (!item) throw new ImIntegrationError("IM_OUTBOX_LEASE_INVALID", "外发消息不存在或 lease 已失效", 409);
    return item;
  }

  authorizeOutbox(id: string, leaseToken: string): ImOutboxItem {
    this.assertControlAvailable();
    const item = this.repository.authorizeOutbox(
      boundedValue(id, "outbox id", 256),
      boundedValue(leaseToken, "leaseToken", 256),
    );
    if (!item) {
      throw new ImIntegrationError(
        "IM_OUTBOX_LEASE_INVALID",
        "外发消息不存在、已取消或 lease 已失效",
        409,
      );
    }
    return item;
  }

  pauseIngress(): void {
    this.ingressPaused = true;
  }

  resumeIngress(): void {
    this.ingressPaused = false;
  }

  async drainIngress(): Promise<void> {
    await Promise.allSettled([...this.inFlightIngress]);
  }

  clearEphemeralState(): void {
    this.qrCodeCache.clear();
  }

  private applyGatewaySession(
    remote: ImGatewayBindingSession,
    expectedProvider: ImProvider,
    requestedDomain?: FeishuDomain,
    allowExisting = true,
  ): ImBindingSession {
    if (remote.provider !== expectedProvider) {
      throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的平台绑定会话", 502);
    }
    const existingSession = this.repository.getBindingSession(remote.id);
    if (existingSession && !allowExisting) {
      throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 重用了历史绑定会话 ID", 502);
    }
    if (existingSession && existingSession.provider !== expectedProvider) {
      throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 重用了其他平台的绑定会话 ID", 502);
    }
    const now = this.clock.now().toISOString();
    const domain = remote.domain ?? requestedDomain;
    if (expectedProvider === "feishu" && remote.domain && requestedDomain && remote.domain !== requestedDomain) {
      throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway 返回了错误的飞书服务区域", 502);
    }
    if (expectedProvider === "wechat" && (remote.domain || remote.connection?.domain)) {
      throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "微信绑定会话不能包含飞书服务区域", 502);
    }
    if (remote.status === "connected" && !remote.connection) {
      throw new ImIntegrationError("IM_GATEWAY_INVALID_RESPONSE", "gateway connected 状态缺少 connection", 502);
    }
    if (remote.status === "connected" && !remote.connection?.ownerId?.trim()) {
      throw new ImIntegrationError("IM_GATEWAY_INVALID_RESPONSE", "gateway connected 状态缺少已验证的 ownerId", 502);
    }
    if (
      remote.status === "connected" && remote.connection?.domain && domain &&
      remote.connection.domain !== domain
    ) {
      throw new ImIntegrationError("IM_GATEWAY_SESSION_MISMATCH", "gateway connection 与绑定会话区域不一致", 502);
    }
    const active = activeBindingStatuses.has(remote.status);
    if (active && remote.qrCodeUrl) this.qrCodeCache.set(remote.id, remote.qrCodeUrl);
    if (!active) this.qrCodeCache.delete(remote.id);
    let connection: ReturnType<ImRepository["upsertConnection"]> | undefined;
    const session = this.repository.database.transaction(() => {
      if (remote.status === "connected" && remote.connection) {
        const connectionDomain = remote.connection.domain ?? domain;
        connection = this.repository.upsertConnection({
          provider: remote.provider,
          gatewayConnectionId: remote.connection.id,
          bindingGeneration: remote.id,
          accountId: remote.connection.accountId,
          ownerId: remote.connection.ownerId,
          ...(remote.connection.displayName ? { displayName: remote.connection.displayName } : {}),
          ...(connectionDomain ? { domain: connectionDomain } : {}),
          connectedAt: remote.connection.connectedAt ?? now,
          ...(remote.connection.lastSeenAt ? { lastSeenAt: remote.connection.lastSeenAt } : {}),
          now,
        });
      }
      return this.repository.upsertBindingSession({
        id: remote.id,
        provider: remote.provider,
        status: remote.status,
        ...(domain ? { domain } : {}),
        ...(connection ? { gatewayConnectionId: connection.gatewayConnectionId } : {}),
        ...(remote.expiresAt ? { expiresAt: remote.expiresAt } : {}),
        ...(remote.message ? { message: remote.message } : {}),
        createdAt: remote.createdAt ?? now,
        updatedAt: now,
      });
    });
    const result = {
      ...session,
      ...(remote.verificationRequired !== undefined
        ? { verificationRequired: remote.verificationRequired }
        : {}),
      ...(connection ? { connection } : {}),
    };
    return active ? this.withCachedQr(result) : result;
  }

  private withCachedQr(session: ImBindingSession): ImBindingSession {
    const qrCodeUrl = this.qrCodeCache.get(session.id);
    return qrCodeUrl ? { ...session, qrCodeUrl } : session;
  }

  private withProviderOperation<T>(provider: ImProvider, operation: () => Promise<T>): Promise<T> {
    const previous = this.providerOperations.get(provider) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.providerOperations.set(provider, tail);
    void tail.finally(() => {
      if (this.providerOperations.get(provider) === tail) this.providerOperations.delete(provider);
    });
    return result;
  }

  private assertControlAvailable(): void {
    if (this.ingressPaused) {
      throw new ImIntegrationError("IM_MAINTENANCE_IN_PROGRESS", "IM 接入正在暂停维护", 503);
    }
  }
}

export class ImIntegrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "ImIntegrationError";
  }
}

function asIntegrationError(error: unknown): ImIntegrationError {
  if (error instanceof ImIntegrationError) return error;
  if (error instanceof ImGatewayError) {
    const status = error.code === "IM_GATEWAY_UNAVAILABLE" || error.code === "IM_GATEWAY_UNREACHABLE"
      ? 503
      : 502;
    return new ImIntegrationError(error.code, error.message, status);
  }
  return new ImIntegrationError(
    "IM_GATEWAY_ERROR",
    error instanceof Error ? error.message : String(error),
    502,
  );
}

function normalizeInboundEvent(input: ImInboundEventInput): ImInboundEventInput {
  if (!isImProvider(input.provider)) {
    throw new ImIntegrationError("IM_PROVIDER_INVALID", "不支持的 IM 平台", 400);
  }
  const chatType = input.chatType;
  if (chatType !== "direct" && chatType !== "group") {
    throw new ImIntegrationError("IM_CHAT_TYPE_INVALID", "chatType must be direct or group", 400);
  }
  if (input.receivedAt && !Number.isFinite(Date.parse(input.receivedAt))) {
    throw new ImIntegrationError("IM_RECEIVED_AT_INVALID", "receivedAt must be an ISO timestamp", 400);
  }
  const attachments = normalizeImAttachments(input.attachments, input.provider, true);
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text && !attachments.length) {
    throw new ImIntegrationError("IM_INPUT_INVALID", "text or attachments are required", 400);
  }
  if ([...text].length > 100_000) {
    throw new ImIntegrationError("IM_INPUT_INVALID", "text is too long", 400);
  }
  return {
    eventId: boundedValue(input.eventId, "eventId", 256),
    provider: input.provider,
    connectionId: boundedValue(input.connectionId, "connectionId", 256),
    ...(input.bindingGeneration !== undefined
      ? { bindingGeneration: boundedValue(input.bindingGeneration, "bindingGeneration", 256) }
      : {}),
    externalChatId: boundedValue(input.externalChatId, "externalChatId", 256),
    externalUserId: boundedValue(input.externalUserId, "externalUserId", 256),
    chatType,
    text: text || attachmentOnlyText(attachments),
    ...(attachments.length ? { attachments } : {}),
    ...(input.receivedAt ? { receivedAt: new Date(input.receivedAt).toISOString() } : {}),
    ...(input.timezone ? { timezone: boundedValue(input.timezone, "timezone", 100) } : {}),
  };
}

function inboundDigest(event: ImInboundEventInput): string {
  return createHash("sha256").update(JSON.stringify({
    eventId: event.eventId,
    provider: event.provider,
    connectionId: event.connectionId,
    bindingGeneration: event.bindingGeneration ?? null,
    externalChatId: event.externalChatId,
    externalUserId: event.externalUserId,
    chatType: event.chatType,
    text: event.text,
    attachments: event.attachments ?? [],
    receivedAt: event.receivedAt ?? null,
    timezone: event.timezone ?? null,
  })).digest("hex");
}

function normalizeOutboundMessage(value: string | ImOutboundMessage): ImOutboundMessage {
  if (typeof value === "string") {
    return { text: boundedValue(value, "assistant reply", 200_000), attachments: [] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImIntegrationError("IM_OUTPUT_INVALID", "assistant reply is invalid", 500);
  }
  return {
    text: boundedValue(value.text, "assistant reply", 200_000),
    attachments: normalizeImAttachments(value.attachments, undefined, false),
  };
}

function normalizeImAttachments(
  value: unknown,
  provider: ImProvider | undefined,
  inbound: boolean,
): ImAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", "attachments must contain at most 8 items", 400);
  }
  let totalSize = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} is invalid`, 400);
    }
    const item = entry as Record<string, unknown>;
    if (item.kind !== "image" && item.kind !== "file") {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} kind is invalid`, 400);
    }
    const path = boundedValue(item.path, `attachment ${index + 1} path`, 500);
    if (
      path.startsWith("/") || path.includes("\\") || path.includes("\0") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      (inbound && provider && !path.startsWith(`uploads/im/${provider}/`))
    ) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} path is invalid`, 400);
    }
    const name = boundedValue(item.name, `attachment ${index + 1} name`, 200);
    if (name.includes("/") || name.includes("\\") || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} name is invalid`, 400);
    }
    const contentType = boundedValue(item.contentType, `attachment ${index + 1} contentType`, 200)
      .toLowerCase();
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:;\s*charset=[a-z0-9._-]+)?$/u.test(contentType)) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} contentType is invalid`, 400);
    }
    if (!Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > 20 * 1024 * 1024) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} size is invalid`, 400);
    }
    totalSize += Number(item.size);
    if (totalSize > 40 * 1024 * 1024) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", "attachment total exceeds 40 MiB", 400);
    }
    const sha256 = boundedValue(item.sha256, `attachment ${index + 1} sha256`, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new ImIntegrationError("IM_ATTACHMENTS_INVALID", `attachment ${index + 1} sha256 is invalid`, 400);
    }
    return { kind: item.kind, path, name, contentType, size: Number(item.size), sha256 };
  });
}

function attachmentOnlyText(attachments: readonly ImAttachment[]): string {
  const images = attachments.filter((attachment) => attachment.kind === "image").length;
  const files = attachments.length - images;
  if (images && files) return `用户发送了 ${images} 张图片和 ${files} 个文件。`;
  if (images) return `用户发送了 ${images} 张图片。`;
  return `用户发送了 ${files} 个文件。`;
}

function boundedValue(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ImIntegrationError("IM_INPUT_INVALID", `${field} is required`, 400);
  }
  const normalized = value.trim();
  if ([...normalized].length > maximum) {
    throw new ImIntegrationError("IM_INPUT_INVALID", `${field} is too long`, 400);
  }
  return normalized;
}
