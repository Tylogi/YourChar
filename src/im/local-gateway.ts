import type { ImGateway } from "./gateway.js";
import { join } from "node:path";
import { ImGatewayError } from "./gateway.js";
import { LocalFeishuConnector, type PersistedFeishuCredential } from "./local-feishu.js";
import { LocalWechatConnector, type PersistedWechatCredential } from "./local-wechat.js";
import { LocalImCredentialStore } from "./local-store.js";
import { LocalImSpool } from "./local-spool.js";
import { LocalImMediaStore } from "./media-store.js";
import type {
  FeishuDomain,
  ImGatewayBindingSession,
  ImGatewayCapability,
  ImInboundEventInput,
  ImInboundReceipt,
  ImOutboxItem,
  ImProvider,
} from "./types.js";

export type LocalImCore = {
  isWechatTypingEnabled(): boolean;
  receiveInboundEvent(event: ImInboundEventInput): Promise<ImInboundReceipt>;
  claimPendingOutbox(input: {
    provider?: ImProvider;
    connectionId?: string;
    limit?: number;
  }): ImOutboxItem[];
  acknowledgeOutbox(input: {
    id: string;
    leaseToken: string;
    delivered: boolean;
    error?: string;
    retryAt?: string;
  }): ImOutboxItem;
  authorizeOutbox(id: string, leaseToken: string): ImOutboxItem;
};

type ConnectorHealth = {
  state: ImGatewayCapability["state"];
  detail?: string;
};

const workerIntervalMs = 750;
const missingAssistantProfileError = "Create the assistant profile first";
const permanentInboundErrors = new Set([
  "IM_BINDING_GENERATION_STALE",
  "IM_CHARACTER_ROUTE_REQUIRED",
  "IM_EVENT_CONFLICT",
  "IM_EVENT_PREVIOUSLY_FAILED",
  "IM_GROUP_CHAT_BLOCKED",
  "IM_SENDER_NOT_OWNER",
  "IM_MEDIA_INVALID",
  "IM_MEDIA_TOO_LARGE",
  "IM_MEDIA_NOT_FOUND",
  "IM_MEDIA_CHANGED",
  "WORKSPACE_PATH_INVALID",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_TYPE_INVALID",
]);

/**
 * Bundled single-process Channel Runtime. It implements the same boundary as
 * an external Gateway, while a durable spool keeps platform callbacks short
 * and preserves events across Core/model failures and process restarts.
 */
export class LocalImGateway implements ImGateway {
  readonly configured = true;
  readonly supportsAttachments = true;
  readonly detail = "内置 Channel Runtime（飞书 + 微信）";
  readonly feishu: LocalFeishuConnector;
  readonly wechat: LocalWechatConnector;

  private readonly credentials: LocalImCredentialStore;
  private readonly spool: LocalImSpool;
  private readonly media: LocalImMediaStore;
  private readonly sessionProviders = new Map<string, ImProvider>();
  private readonly blockedProviders = new Set<ImProvider>();
  private readonly inboundEnabledProviders = new Set<ImProvider>();
  private readonly inFlightIngress = new Map<ImProvider, Set<Promise<unknown>>>();
  private readonly inFlightDeliveries = new Map<ImProvider, Set<Promise<unknown>>>();
  private readonly health = new Map<ImProvider, ConnectorHealth>([
    ["feishu", { state: "starting", detail: "飞书连接器正在启动" }],
    ["wechat", { state: "starting", detail: "微信连接器正在启动" }],
  ]);
  private core?: LocalImCore;
  private workerTimer?: NodeJS.Timeout;
  private workerRunning = false;
  private workerPending = false;
  private workerTask?: Promise<void>;
  private restoreTask?: Promise<void>;
  private disposed = false;

  constructor(stateDirectory: string, normalWorkspaceDirectory = join(stateDirectory, "workspace")) {
    this.credentials = new LocalImCredentialStore(stateDirectory);
    this.spool = new LocalImSpool(stateDirectory);
    // IM is intentionally a normal-space transport. Never pass a character's
    // secret Workspace root here.
    this.media = new LocalImMediaStore(normalWorkspaceDirectory);
    this.feishu = new LocalFeishuConnector({
      loadCredential: () => this.credentials.get<PersistedFeishuCredential>("feishu"),
      saveCredential: (credential) => this.credentials.set("feishu", credential),
      clearCredential: () => this.credentials.clear("feishu"),
      shouldAcceptInbound: () => this.inboundEnabledProviders.has("feishu"),
      onInbound: (event) => this.enqueueInbound(event),
      saveInboundAttachment: (input) => this.media.saveInboundAttachment(input),
      loadOutboundAttachment: (attachment) => this.media.loadOutboundAttachment(attachment),
    });
    this.wechat = new LocalWechatConnector({
      loadCredential: () => this.credentials.get<PersistedWechatCredential>("wechat"),
      saveCredential: (credential) => this.credentials.set("wechat", credential),
      clearCredential: () => this.credentials.clear("wechat"),
      shouldAcceptInbound: () => this.inboundEnabledProviders.has("wechat"),
      onInbound: (event) => this.enqueueInbound(event),
      saveInboundAttachment: (input) => this.media.saveInboundAttachment(input),
      loadOutboundAttachment: (attachment) => this.media.loadOutboundAttachment(attachment),
    });
  }

  getCapabilities(): readonly ImGatewayCapability[] {
    return [
      {
        provider: "feishu",
        connectorKind: "feishu_personal_agent",
        domains: ["feishu", "lark"],
        ...(this.health.get("feishu") ?? { state: "unhealthy", detail: "飞书连接器状态未知" }),
      },
      {
        provider: "wechat",
        connectorKind: "wechat_tencent_ilink",
        ...(this.health.get("wechat") ?? { state: "unhealthy", detail: "微信连接器状态未知" }),
      },
    ];
  }

  setInboundEnabled(provider: ImProvider, enabled: boolean): void {
    if (enabled) {
      this.inboundEnabledProviders.add(provider);
      return;
    }
    this.inboundEnabledProviders.delete(provider);
    this.spool.clearInboundProvider(provider);
  }

  async attachCore(core: LocalImCore): Promise<void> {
    if (this.disposed) throw new Error("Local IM gateway has been disposed");
    if (this.core) {
      if (this.core !== core) throw new Error("Local IM gateway is already attached");
      return;
    }
    this.core = core;
    this.spool.reviveDeadByError(missingAssistantProfileError);
    this.workerTimer = setInterval(() => this.wakeWorker(), workerIntervalMs);
    this.workerTimer.unref();
    this.restoreTask = this.restoreConnectors();
    void this.restoreTask.catch(() => undefined);
  }

  private async restoreConnectors(): Promise<void> {
    const restored = await Promise.allSettled([
      this.restoreConnector("feishu", () => this.feishu.restore()),
      this.restoreConnector("wechat", () => this.wechat.restore()),
    ]);
    for (const [index, result] of restored.entries()) {
      if (result.status === "rejected") {
        const provider: ImProvider = index === 0 ? "feishu" : "wechat";
        this.health.set(provider, {
          state: "unhealthy",
          detail: `${provider === "feishu" ? "飞书" : "微信"}已保存凭据，但连接恢复失败`,
        });
      }
    }
    this.wakeWorker();
  }

  async startBinding(
    provider: ImProvider,
    options: { domain?: FeishuDomain } = {},
  ): Promise<ImGatewayBindingSession> {
    this.assertActive();
    try {
      this.blockedProviders.delete(provider);
      const session = provider === "feishu"
        ? await this.feishu.startBinding(options.domain ?? "feishu")
        : await this.wechat.startBinding();
      this.sessionProviders.set(session.id, provider);
      this.health.set(provider, { state: "ready" });
      return session;
    } catch (error) {
      throw localGatewayError(provider, "无法启动扫码绑定", error);
    }
  }

  async getBindingSession(id: string): Promise<ImGatewayBindingSession> {
    this.assertActive();
    const provider = this.providerForSession(id);
    try {
      return provider === "feishu"
        ? await this.feishu.getBindingSession(id)
        : await this.wechat.getBindingSession(id);
    } catch (error) {
      if (isMissingSessionError(error)) {
        return staleSession(id, provider, "expired", "Channel Runtime 已重启，请刷新二维码");
      }
      throw localGatewayError(provider, "无法读取扫码状态", error);
    }
  }

  async cancelBindingSession(id: string): Promise<ImGatewayBindingSession> {
    this.assertActive();
    const provider = this.providerForSession(id);
    try {
      return provider === "feishu"
        ? await this.feishu.cancelBindingSession(id)
        : await this.wechat.cancelBindingSession(id);
    } catch (error) {
      if (isMissingSessionError(error)) {
        return staleSession(id, provider, "cancelled", "绑定会话已取消");
      }
      throw localGatewayError(provider, "无法取消扫码绑定", error);
    }
  }

  async submitBindingVerification(id: string, code: string): Promise<ImGatewayBindingSession> {
    this.assertActive();
    const provider = this.providerForSession(id);
    if (provider !== "wechat") {
      throw new ImGatewayError("IM_VERIFICATION_UNSUPPORTED", "飞书绑定不需要提交配对码");
    }
    try {
      return await this.wechat.submitVerificationCode(id, code);
    } catch (error) {
      throw localGatewayError(provider, "无法提交微信配对码", error);
    }
  }

  async disconnect(provider: ImProvider, connectionId: string): Promise<void> {
    this.assertActive();
    this.blockedProviders.add(provider);
    try {
      const connectorDisconnect = provider === "feishu"
        ? this.feishu.disconnect(connectionId)
        : this.wechat.disconnect(connectionId);
      const results = await Promise.allSettled([
        connectorDisconnect,
        ...(this.inFlightIngress.get(provider) ?? []),
        ...(this.inFlightDeliveries.get(provider) ?? []),
      ]);
      const connectorResult = results[0];
      if (connectorResult?.status === "rejected") throw connectorResult.reason;
      this.spool.clearProvider(provider);
      this.health.set(provider, { state: "ready" });
    } catch (error) {
      throw localGatewayError(provider, "无法撤销平台连接", error);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = undefined;
    await Promise.allSettled([this.feishu.dispose(), this.wechat.dispose()]);
    if (this.restoreTask) await this.restoreTask;
    if (this.workerTask) await this.workerTask;
    await Promise.allSettled([
      ...[...this.inFlightDeliveries.values()].flatMap((operations) => [...operations]),
    ]);
  }

  private async restoreConnector(provider: ImProvider, restore: () => Promise<void>): Promise<void> {
    await restore();
    this.health.set(provider, { state: "ready" });
  }

  private async enqueueInbound(event: ImInboundEventInput): Promise<void> {
    this.assertActive();
    if (!this.inboundEnabledProviders.has(event.provider)) return;
    this.spool.enqueue(event);
    this.wakeWorker();
  }

  private wakeWorker(): void {
    if (this.disposed || !this.core) return;
    if (this.workerRunning) {
      this.workerPending = true;
      return;
    }
    this.workerRunning = true;
    const task = this.runWorker().catch(() => undefined).finally(() => {
      this.workerRunning = false;
      if (this.workerTask === task) this.workerTask = undefined;
      if (this.workerPending) {
        this.workerPending = false;
        this.wakeWorker();
      }
    });
    this.workerTask = task;
    void task;
  }

  private async runWorker(): Promise<void> {
    const core = this.core;
    if (!core || this.disposed) return;
    for (const entry of this.spool.due(10)) {
      if (this.disposed) return;
      if (this.blockedProviders.has(entry.event.provider)) continue;
      if (!this.inboundEnabledProviders.has(entry.event.provider)) {
        this.spool.complete(entry.key);
        continue;
      }
      const typing = entry.event.provider === "wechat" && this.wechatTypingEnabled(core)
        ? this.bestEffortWechatTyping(entry.event.externalChatId)
        : undefined;
      try {
        await this.validateInboundAttachments(entry.event);
        const operation = core.receiveInboundEvent(entry.event);
        this.trackIngress(entry.event.provider, operation);
        const receipt = await operation;
        this.spool.complete(entry.key);
        await this.flushOutbox(
          entry.event.provider,
          entry.event.connectionId,
          receipt.delivery.id,
        );
      } catch (error) {
        const code = errorCode(error);
        const message = safeWorkerError(error);
        if (code && permanentInboundErrors.has(code)) this.spool.deadLetter(entry.key, message);
        else this.spool.retry(entry.key, message, retryDelay(entry.attempts));
      } finally {
        await typing?.stop().catch(() => undefined);
      }
    }
    await this.flushOutbox("feishu", this.credentials.get<PersistedFeishuCredential>("feishu")?.connectionId);
    await this.flushOutbox("wechat", this.credentials.get<PersistedWechatCredential>("wechat")?.connectionId);
  }

  private async validateInboundAttachments(event: ImInboundEventInput): Promise<void> {
    for (const attachment of event.attachments ?? []) {
      await this.media.loadOutboundAttachment(attachment);
    }
  }

  private async flushOutbox(
    provider: ImProvider,
    connectionId: string | undefined,
    awaitedOutboxId?: string,
  ): Promise<void> {
    const core = this.core;
    if (!core || !connectionId || this.disposed || this.blockedProviders.has(provider)) return;
    const maximumBatches = awaitedOutboxId ? 10 : 1;
    for (let batch = 0; batch < maximumBatches; batch += 1) {
      let items: ImOutboxItem[];
      try {
        items = core.claimPendingOutbox({ provider, connectionId, limit: 10 });
      } catch {
        return;
      }
      if (!items.length) return;
      let awaitedAttempted = false;
      for (const item of items) {
        if (this.disposed || this.blockedProviders.has(provider) || !item.leaseToken) return;
        if (item.id === awaitedOutboxId) awaitedAttempted = true;
        try {
          core.authorizeOutbox(item.id, item.leaseToken);
          if (this.disposed || this.blockedProviders.has(provider)) {
            throw new Error("binding disconnected before delivery authorization completed");
          }
          if (!this.spool.delivery(item.id, "complete")) {
            const parts = {
              hasDelivered: (partId: string) => Boolean(this.spool.delivery(item.id, partId)),
              recordDelivered: (partId: string, platformMessageId: string) => {
                this.spool.recordDelivery({
                  outboxId: item.id,
                  partId,
                  provider,
                  platformMessageId: platformMessageId.slice(0, 512),
                  deliveredAt: new Date().toISOString(),
                });
              },
            };
            const delivery = provider === "feishu"
              ? this.feishu.send(item, parts)
              : this.wechat.send(item, parts);
            this.trackDelivery(provider, delivery);
            await delivery;
            this.spool.recordDelivery({
              outboxId: item.id,
              partId: "complete",
              provider,
              platformMessageId: item.id,
              deliveredAt: new Date().toISOString(),
            });
          }
          core.acknowledgeOutbox({ id: item.id, leaseToken: item.leaseToken, delivered: true });
        } catch (error) {
          try {
            core.acknowledgeOutbox({
              id: item.id,
              leaseToken: item.leaseToken,
              delivered: false,
              error: safeWorkerError(error),
              retryAt: new Date(Date.now() + retryDelay(item.attempts)).toISOString(),
            });
          } catch {
            // A stale lease is expected after long platform calls; a future claim
            // will consult the durable delivery receipt before sending again.
          }
        }
      }
      if (!awaitedOutboxId || awaitedAttempted) return;
    }
  }

  private bestEffortWechatTyping(externalChatId: string) {
    try {
      return this.wechat.beginTyping(externalChatId);
    } catch {
      return undefined;
    }
  }

  private wechatTypingEnabled(core: LocalImCore): boolean {
    try {
      return core.isWechatTypingEnabled();
    } catch {
      return false;
    }
  }

  private providerForSession(id: string): ImProvider {
    const known = this.sessionProviders.get(id);
    if (known) return known;
    if (id.startsWith("feishu-binding-")) return "feishu";
    if (id.startsWith("wechat-binding-")) return "wechat";
    throw new ImGatewayError("IM_GATEWAY_SESSION_NOT_FOUND", "绑定会话不存在", 404);
  }

  private trackIngress(provider: ImProvider, operation: Promise<unknown>): void {
    const active = this.inFlightIngress.get(provider) ?? new Set<Promise<unknown>>();
    active.add(operation);
    this.inFlightIngress.set(provider, active);
    void operation.finally(() => {
      active.delete(operation);
      if (active.size === 0) this.inFlightIngress.delete(provider);
    }).catch(() => undefined);
  }

  private trackDelivery(provider: ImProvider, operation: Promise<unknown>): void {
    const active = this.inFlightDeliveries.get(provider) ?? new Set<Promise<unknown>>();
    active.add(operation);
    this.inFlightDeliveries.set(provider, active);
    void operation.finally(() => {
      active.delete(operation);
      if (active.size === 0) this.inFlightDeliveries.delete(provider);
    }).catch(() => undefined);
  }

  private assertActive(): void {
    if (this.disposed) throw new ImGatewayError("IM_GATEWAY_UNAVAILABLE", "内置 Channel Runtime 已停止");
  }
}

function staleSession(
  id: string,
  provider: ImProvider,
  status: "expired" | "cancelled",
  message: string,
): ImGatewayBindingSession {
  return { id, provider, status, message, updatedAt: new Date().toISOString() };
}

function isMissingSessionError(error: unknown): boolean {
  return error instanceof Error && /session.+not found|session was not found/i.test(error.message);
}

function localGatewayError(provider: ImProvider, action: string, error: unknown): ImGatewayError {
  const code = errorCode(error);
  if (code === "IM_GATEWAY_UNAVAILABLE") return error as ImGatewayError;
  return new ImGatewayError(
    "IM_CONNECTOR_ERROR",
    `${provider === "feishu" ? "飞书" : "微信"}${action}`,
  );
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function safeWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1_000);
}

function retryDelay(attempts: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.min(Math.max(attempts, 0), 6));
}
