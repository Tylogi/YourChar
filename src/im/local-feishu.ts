import { createHash, randomBytes } from "node:crypto";
import {
  Domain,
  createLarkChannel,
  defaultHttpInstance,
  registerApp,
  type LarkChannel,
  type NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import * as qrcode from "qrcode";
import type {
  FeishuDomain,
  ImAttachment,
  ImGatewayBindingSession,
  ImInboundAttachmentInput,
  ImInboundEventInput,
  ImOutboxPartCallbacks,
  ImOutboundAttachmentContent,
  ImOutboxItem,
} from "./types.js";

export type PersistedFeishuCredential = {
  connectionId: string;
  appId: string;
  appSecret: string;
  ownerId: string;
  domain: FeishuDomain;
  connectedAt: string;
  displayName?: string;
  mediaScopesVersion?: 1;
};

export type LocalFeishuConnectorCallbacks = {
  loadCredential: () => PersistedFeishuCredential | undefined | Promise<PersistedFeishuCredential | undefined>;
  saveCredential: (credential: PersistedFeishuCredential) => void | Promise<void>;
  clearCredential: () => void | Promise<void>;
  shouldAcceptInbound?: () => boolean;
  saveInboundAttachment: (input: ImInboundAttachmentInput) => ImAttachment | Promise<ImAttachment>;
  loadOutboundAttachment: (
    attachment: ImAttachment,
  ) => ImOutboundAttachmentContent | Promise<ImOutboundAttachmentContent>;
  onInbound: (event: ImInboundEventInput) => void | Promise<void>;
};

type ChannelHandle = {
  channel: LarkChannel;
  credential: PersistedFeishuCredential;
  unsubscribe: () => void;
};

type BindingOperation = {
  controller: AbortController;
  ready: Promise<ImGatewayBindingSession>;
  resolveReady: (session: ImGatewayBindingSession) => void;
  readyResolved: boolean;
  session: ImGatewayBindingSession;
  task?: Promise<void>;
  provisionalHandle?: ChannelHandle;
  credentialMayHaveBeenSaved: boolean;
};

const terminalBindingStatuses = new Set<ImGatewayBindingSession["status"]>([
  "connected",
  "expired",
  "cancelled",
  "failed",
]);

const feishuAccountsDomain = "accounts.feishu.cn";
const larkAccountsDomain = "accounts.larksuite.com";
const noGroupChatSentinel = "__yourchar_direct_messages_only__";
const channelHandshakeTimeoutMs = 15_000;
const feishuRequestTimeoutMs = 15_000;
const mediaScopesVersion = 1;
const maxAttachmentCount = 8;
const maxAttachmentBytes = 20 * 1024 * 1024;
const maxMessageAttachmentBytes = 40 * 1024 * 1024;
const maxInlineImageBytes = 10 * 1024 * 1024;

// registerApp uses the SDK's shared Axios instance and does not expose a
// per-call client. Bound it so QR generation and restore cannot hang forever.
if (!defaultHttpInstance.defaults.timeout || defaultHttpInstance.defaults.timeout > feishuRequestTimeoutMs) {
  defaultHttpInstance.defaults.timeout = feishuRequestTimeoutMs;
}

export class LocalFeishuConnector {
  private readonly sessions = new Map<string, BindingOperation>();
  private readonly inFlightSends = new Set<Promise<void>>();
  private activeBinding?: BindingOperation;
  private activeChannel?: ChannelHandle;
  private credential?: PersistedFeishuCredential;
  private startingBinding = false;
  private acceptingMessages = false;
  private disposed = false;

  constructor(private readonly callbacks: LocalFeishuConnectorCallbacks) {}

  async restore(): Promise<void> {
    this.assertNotDisposed();
    if (this.activeChannel) return;
    if (this.activeBinding && !terminalBindingStatuses.has(this.activeBinding.session.status)) {
      throw new Error("A Feishu binding is already in progress");
    }

    const stored = await this.callbacks.loadCredential();
    if (!stored) return;
    const credential = normalizeCredential(stored);
    const handle = this.createChannelHandle(credential);
    try {
      await handle.channel.connect();
      if (this.disposed) {
        await closeChannel(handle);
        return;
      }
      this.credential = credential;
      this.activeChannel = handle;
      this.acceptingMessages = true;
    } catch {
      await closeChannel(handle).catch(() => undefined);
      throw new Error("无法恢复飞书长连接");
    }
  }

  async startBinding(domain: FeishuDomain): Promise<ImGatewayBindingSession> {
    this.assertNotDisposed();
    assertFeishuDomain(domain);
    if (this.startingBinding) throw new Error("A Feishu binding is already starting");
    if (this.activeBinding && !terminalBindingStatuses.has(this.activeBinding.session.status)) {
      throw new Error("A Feishu binding is already in progress");
    }
    if (this.activeChannel && this.credential) {
      return recoveredBindingSession(this.credential);
    }
    if (this.activeChannel || this.credential) {
      throw new Error("Feishu connector state is inconsistent");
    }

    this.startingBinding = true;
    try {
      const stored = await this.callbacks.loadCredential();
      if (stored) {
        throw new Error("A persisted Feishu credential already exists; restore or disconnect it first");
      }

      const createdAt = new Date().toISOString();
      let resolveReady!: (session: ImGatewayBindingSession) => void;
      const ready = new Promise<ImGatewayBindingSession>((resolve) => {
        resolveReady = resolve;
      });
      const operation: BindingOperation = {
        controller: new AbortController(),
        ready,
        resolveReady,
        readyResolved: false,
        credentialMayHaveBeenSaved: false,
        session: {
          id: randomOpaqueId("feishu-binding"),
          provider: "feishu",
          status: "waiting_scan",
          domain,
          createdAt,
          updatedAt: createdAt,
          message: "正在生成飞书应用授权二维码",
        },
      };
      this.sessions.set(operation.session.id, operation);
      this.activeBinding = operation;
      operation.task = this.runRegistration(operation, domain);
      void operation.task.catch(() => undefined);
      return await operation.ready;
    } finally {
      this.startingBinding = false;
    }
  }

  async getBindingSession(id: string): Promise<ImGatewayBindingSession> {
    const operation = this.requireSession(id);
    if (
      operation.session.status === "waiting_scan" && operation.session.expiresAt &&
      Date.parse(operation.session.expiresAt) <= Date.now()
    ) {
      this.finishBinding(operation, "expired", "二维码已过期，请重新绑定");
      operation.controller.abort();
    }
    return cloneSession(operation.session);
  }

  async cancelBindingSession(id: string): Promise<ImGatewayBindingSession> {
    const operation = this.requireSession(id);
    if (!terminalBindingStatuses.has(operation.session.status)) {
      this.finishBinding(operation, "cancelled", "绑定已取消");
      operation.controller.abort();
      if (operation.task) await operation.task;
    }
    return cloneSession(operation.session);
  }

  async disconnect(connectionId: string): Promise<void> {
    this.assertNotDisposed();
    const normalizedConnectionId = requiredString(connectionId, "connectionId");
    const activeBinding = this.activeBinding;
    if (activeBinding && !terminalBindingStatuses.has(activeBinding.session.status)) {
      this.finishBinding(activeBinding, "cancelled", "绑定已取消");
      activeBinding.controller.abort();
      if (activeBinding.task) await activeBinding.task;
    }

    const persisted = this.credential ?? await this.callbacks.loadCredential();
    if (persisted && normalizeCredential(persisted).connectionId !== normalizedConnectionId) {
      throw new Error("Feishu connection id does not match the active credential");
    }
    if (this.activeChannel && this.activeChannel.credential.connectionId !== normalizedConnectionId) {
      throw new Error("Feishu connection id does not match the active channel");
    }

    this.acceptingMessages = false;
    await Promise.allSettled([...this.inFlightSends]);
    if (this.activeChannel) {
      await closeChannel(this.activeChannel);
      this.activeChannel = undefined;
    }
    await this.callbacks.clearCredential();
    this.credential = undefined;
  }

  async send(item: ImOutboxItem, parts?: ImOutboxPartCallbacks): Promise<void> {
    this.assertNotDisposed();
    if (item.provider !== "feishu") throw new Error("LocalFeishuConnector can only send Feishu outbox items");
    const handle = this.activeChannel;
    const credential = this.credential;
    if (!this.acceptingMessages || !handle || !credential) {
      throw new Error("Feishu channel is not connected");
    }
    if (item.connectionId !== credential.connectionId) {
      throw new Error("Feishu outbox item belongs to a different connection");
    }

    const operation = this.sendParts(handle, item, parts);
    this.inFlightSends.add(operation);
    try {
      await operation;
    } finally {
      this.inFlightSends.delete(operation);
    }
  }

  private async sendParts(
    handle: ChannelHandle,
    item: ImOutboxItem,
    parts?: ImOutboxPartCallbacks,
  ): Promise<void> {
    const attachments = item.attachments ?? [];
    assertAttachmentEnvelope(attachments);
    if (attachments.length > 0 && handle.credential.mediaScopesVersion !== mediaScopesVersion) {
      if (item.text && !parts?.hasDelivered("text")) {
        const messageId = await createFeishuMessage(handle, item, "text", "text", { text: item.text });
        parts?.recordDelivered("text", messageId);
      }
      const noticePartId = "system:media-reauthorization";
      if (!parts?.hasDelivered(noticePartId)) {
        const messageId = await createFeishuMessage(handle, item, noticePartId, "text", {
          text: "【系统提示】当前飞书绑定缺少媒体权限，附件未发送。请在 WebUI 中解绑飞书后重新扫码授权。",
        });
        parts?.recordDelivered(noticePartId, messageId);
      }
      return;
    }

    if (item.text && !parts?.hasDelivered("text")) {
      const messageId = await createFeishuMessage(handle, item, "text", "text", { text: item.text });
      parts?.recordDelivered("text", messageId);
    }

    for (const [index, attachment] of attachments.entries()) {
      const partId = `attachment:${index}:${attachment.sha256}`;
      if (parts?.hasDelivered(partId)) continue;
      const loaded = await this.callbacks.loadOutboundAttachment(attachment);
      assertLoadedAttachment(attachment, loaded);
      // Feishu's image upload endpoint has a lower 10 MiB limit than the
      // generic file endpoint. Preserve delivery by downgrading only oversized
      // images to a downloadable file with the original safe filename.
      if (attachment.kind === "image" && loaded.bytes.byteLength <= maxInlineImageBytes) {
        const imageKey = await uploadFeishuImage(handle, loaded.bytes);
        const messageId = await createFeishuMessage(handle, item, partId, "image", { image_key: imageKey });
        parts?.recordDelivered(partId, messageId);
      } else {
        const fileKey = await uploadFeishuFile(handle, loaded.bytes, loaded.name);
        const messageId = await createFeishuMessage(handle, item, partId, "file", { file_key: fileKey });
        parts?.recordDelivered(partId, messageId);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.acceptingMessages = false;
    const activeBinding = this.activeBinding;
    if (activeBinding && !terminalBindingStatuses.has(activeBinding.session.status)) {
      this.finishBinding(activeBinding, "cancelled", "连接器已停止");
      activeBinding.controller.abort();
    }
    if (activeBinding?.task) await Promise.allSettled([activeBinding.task]);
    await Promise.allSettled([...this.inFlightSends]);
    if (this.activeChannel) {
      const handle = this.activeChannel;
      this.activeChannel = undefined;
      await closeChannel(handle);
    }
    this.credential = undefined;
  }

  private async runRegistration(operation: BindingOperation, domain: FeishuDomain): Promise<void> {
    try {
      const result = await registerApp({
        domain: domain === "lark" ? larkAccountsDomain : feishuAccountsDomain,
        larkDomain: larkAccountsDomain,
        signal: operation.controller.signal,
        createOnly: true,
        appPreset: { name: "Personal Agent" },
        addons: {
          preset: false,
          scopes: {
            tenant: [
              "im:message:send_as_bot",
              "im:message:readonly",
              "im:resource",
            ],
          },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
        onQRCodeReady: (info) => {
          void this.publishQrCode(operation, info.url, info.expireIn);
        },
      });

      if (!this.isBindingCurrent(operation)) return;
      const ownerId = optionalString(result.user_info?.open_id);
      if (!ownerId) {
        throw new PublicFeishuConnectorError("飞书授权结果缺少已验证的用户 open_id");
      }
      if (result.user_info?.tenant_brand !== domain) {
        throw new PublicFeishuConnectorError(
          domain === "lark" ? "扫码账号不是 Lark 租户，请选择正确的服务区域" : "扫码账号不是飞书租户，请选择正确的服务区域",
        );
      }
      const appId = requiredString(result.client_id, "registered app id");
      const appSecret = requiredString(result.client_secret, "registered app secret");
      const credential: PersistedFeishuCredential = {
        connectionId: randomOpaqueId("feishu-connection"),
        appId,
        appSecret,
        ownerId,
        domain,
        connectedAt: new Date().toISOString(),
        mediaScopesVersion,
      };
      const handle = this.createChannelHandle(credential);
      operation.provisionalHandle = handle;
      await handle.channel.connect();
      handle.credential = { ...credential, connectedAt: new Date().toISOString() };

      if (!this.isBindingCurrent(operation)) {
        await closeChannel(handle).catch(() => undefined);
        operation.provisionalHandle = undefined;
        return;
      }
      // Treat the callback as possibly non-atomic: if it writes and then throws,
      // the catch path must still attempt to remove the partial credential.
      operation.credentialMayHaveBeenSaved = true;
      await this.callbacks.saveCredential(cloneCredential(handle.credential));
      if (!this.isBindingCurrent(operation)) {
        await Promise.resolve(this.callbacks.clearCredential()).catch(() => undefined);
        await closeChannel(handle).catch(() => undefined);
        operation.provisionalHandle = undefined;
        return;
      }

      this.credential = handle.credential;
      this.activeChannel = handle;
      this.acceptingMessages = true;
      operation.provisionalHandle = undefined;
      this.finishBinding(operation, "connected", "飞书应用已连接", {
        connection: {
          id: handle.credential.connectionId,
          accountId: handle.credential.appId,
          ownerId: handle.credential.ownerId,
          domain: handle.credential.domain,
          connectedAt: handle.credential.connectedAt,
          ...(handle.credential.displayName ? { displayName: handle.credential.displayName } : {}),
        },
      });
    } catch (error) {
      if (operation.provisionalHandle) {
        await closeChannel(operation.provisionalHandle).catch(() => undefined);
        operation.provisionalHandle = undefined;
      }
      if (operation.credentialMayHaveBeenSaved) {
        await Promise.resolve(this.callbacks.clearCredential()).catch(() => undefined);
      }
      if (!terminalBindingStatuses.has(operation.session.status)) {
        const outcome = registrationFailure(error, operation.controller.signal.aborted);
        this.finishBinding(operation, outcome.status, outcome.message);
      }
    } finally {
      // Keep all credential-bearing SDK results in this stack frame only. Sessions
      // and thrown public errors never include appSecret.
      if (!operation.readyResolved && terminalBindingStatuses.has(operation.session.status)) {
        this.resolveBindingReady(operation);
      }
      if (this.activeBinding === operation && terminalBindingStatuses.has(operation.session.status)) {
        this.activeBinding = undefined;
      }
    }
  }

  private async publishQrCode(operation: BindingOperation, url: string, expireIn: number): Promise<void> {
    if (!this.isBindingCurrent(operation)) return;
    try {
      const qrCodeUrl = await qrcode.toDataURL(url, {
        type: "image/png",
        errorCorrectionLevel: "M",
        margin: 2,
        width: 320,
      });
      if (!this.isBindingCurrent(operation)) return;
      const boundedExpirySeconds = Number.isFinite(expireIn)
        ? Math.max(1, Math.min(3_600, Math.floor(expireIn)))
        : 600;
      const now = new Date();
      operation.session = {
        ...operation.session,
        status: "waiting_scan",
        qrCodeUrl,
        expiresAt: new Date(now.getTime() + boundedExpirySeconds * 1_000).toISOString(),
        message: domainLabel(operation.session.domain) + "：请扫码创建并授权 Personal Agent",
        updatedAt: now.toISOString(),
      };
      this.resolveBindingReady(operation);
    } catch {
      if (!this.isBindingCurrent(operation)) return;
      this.finishBinding(operation, "failed", "无法生成飞书授权二维码");
      operation.controller.abort();
    }
  }

  private createChannelHandle(credential: PersistedFeishuCredential): ChannelHandle {
    const channel = createLarkChannel({
      appId: credential.appId,
      appSecret: credential.appSecret,
      transport: "websocket",
      domain: credential.domain === "lark" ? Domain.Lark : Domain.Feishu,
      source: "yourchar",
      handshakeTimeoutMs: channelHandshakeTimeoutMs,
      policy: {
        dmMode: "allowlist",
        dmAllowlist: [credential.ownerId],
        groupAllowlist: [noGroupChatSentinel],
        requireMention: true,
        respondToMentionAll: false,
      },
      safety: { chatQueue: { enabled: true } },
    });
    const handle: ChannelHandle = {
      channel,
      credential,
      unsubscribe: () => undefined,
    };
    handle.unsubscribe = channel.on("message", async (message) => {
      await this.forwardInbound(handle, message);
    });
    return handle;
  }

  private async forwardInbound(handle: ChannelHandle, message: NormalizedMessage): Promise<void> {
    if (
      this.disposed || !this.acceptingMessages || this.activeChannel !== handle ||
      this.credential?.connectionId !== handle.credential.connectionId
    ) return;
    if (message.chatType !== "p2p") return;
    if (!message.senderId || message.senderId !== handle.credential.ownerId) return;
    if (!this.shouldAcceptInbound()) return;

    const resources = message.resources.filter((resource) => resource.type === "image" || resource.type === "file");
    if (resources.length === 0 && (message.rawContentType !== "text" || !message.content)) return;

    let attachments: ImAttachment[] = [];
    if (resources.length > 0) {
      if (handle.credential.mediaScopesVersion !== mediaScopesVersion) {
        await this.sendSystemNotice(
          handle,
          message.chatId,
          "当前飞书绑定是在媒体功能启用前创建的，暂时无法读取图片或文件。请在 WebUI 中解绑飞书后重新扫码授权。",
        );
        return;
      }
      if (resources.length > maxAttachmentCount) {
        await this.sendSystemNotice(
          handle,
          message.chatId,
          `一条消息最多支持 ${maxAttachmentCount} 个图片或文件，请分开发送。`,
        );
        return;
      }
      try {
        attachments = await this.downloadInboundAttachments(handle, message, resources);
      } catch (error) {
        if (!this.shouldAcceptInbound()) return;
        await this.sendSystemNotice(handle, message.chatId, inboundMediaFailureMessage(error));
        return;
      }
    }

    if (!this.shouldAcceptInbound()) return;
    const receivedAt = isoFromEpochMilliseconds(message.createTime);
    await this.callbacks.onInbound({
      eventId: message.messageId,
      provider: "feishu",
      connectionId: handle.credential.connectionId,
      externalChatId: message.chatId,
      externalUserId: message.senderId,
      chatType: "direct",
      text: inboundText(message),
      attachments,
      ...(receivedAt ? { receivedAt } : {}),
    });
  }

  private async downloadInboundAttachments(
    handle: ChannelHandle,
    message: NormalizedMessage,
    resources: NormalizedMessage["resources"],
  ): Promise<ImAttachment[]> {
    const attachments: ImAttachment[] = [];
    let totalBytes = 0;
    for (const [index, resource] of resources.entries()) {
      if (!this.shouldAcceptInbound()) return attachments;
      const resourceType = resource.type === "image" ? "image" : "file";
      const response = await handle.channel.rawClient.im.v1.messageResource.get({
        path: { message_id: message.messageId, file_key: resource.fileKey },
        params: { type: resourceType },
      });
      const declaredSize = numericHeader(response.headers, "content-length");
      if (declaredSize !== undefined && declaredSize > maxAttachmentBytes) {
        response.getReadableStream().destroy();
        throw new FeishuMediaLimitError("single");
      }
      if (declaredSize !== undefined && totalBytes + declaredSize > maxMessageAttachmentBytes) {
        response.getReadableStream().destroy();
        throw new FeishuMediaLimitError("total");
      }
      const bytes = await readBoundedStream(
        response.getReadableStream(),
        Math.min(maxAttachmentBytes, maxMessageAttachmentBytes - totalBytes),
      );
      if (!this.shouldAcceptInbound()) return attachments;
      totalBytes += bytes.byteLength;
      const contentType = stringHeader(response.headers, "content-type");
      const attachment = await this.callbacks.saveInboundAttachment({
        provider: "feishu",
        eventId: message.messageId,
        kind: resourceType,
        name: resource.fileName ?? defaultInboundFileName(resourceType, contentType, index),
        ...(contentType ? { contentType } : {}),
        ...(declaredSize !== undefined ? { declaredSize } : {}),
        bytes,
      });
      attachments.push(attachment);
    }
    return attachments;
  }

  private shouldAcceptInbound(): boolean {
    try {
      return this.callbacks.shouldAcceptInbound?.() ?? true;
    } catch {
      return false;
    }
  }

  private async sendSystemNotice(handle: ChannelHandle, chatId: string, message: string): Promise<void> {
    await handle.channel.send(chatId, { text: `【系统提示】${message}` });
  }

  private finishBinding(
    operation: BindingOperation,
    status: Extract<ImGatewayBindingSession["status"], "connected" | "expired" | "cancelled" | "failed">,
    message: string,
    extra: Pick<ImGatewayBindingSession, "connection"> = {},
  ): void {
    if (terminalBindingStatuses.has(operation.session.status)) return;
    const { qrCodeUrl: _qrCodeUrl, verificationRequired: _verificationRequired, ...session } = operation.session;
    operation.session = {
      ...session,
      status,
      message,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    if (this.activeBinding === operation) this.activeBinding = undefined;
    this.resolveBindingReady(operation);
  }

  private resolveBindingReady(operation: BindingOperation): void {
    if (operation.readyResolved) return;
    operation.readyResolved = true;
    operation.resolveReady(cloneSession(operation.session));
  }

  private isBindingCurrent(operation: BindingOperation): boolean {
    return !this.disposed && this.activeBinding === operation &&
      !terminalBindingStatuses.has(operation.session.status);
  }

  private requireSession(id: string): BindingOperation {
    const normalizedId = requiredString(id, "binding session id");
    const operation = this.sessions.get(normalizedId);
    if (!operation) throw new Error("Feishu binding session was not found");
    return operation;
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error("LocalFeishuConnector has been disposed");
  }
}

class PublicFeishuConnectorError extends Error {
  constructor(readonly publicMessage: string) {
    super(publicMessage);
    this.name = "PublicFeishuConnectorError";
  }
}

function registrationFailure(
  error: unknown,
  aborted: boolean,
): { status: "expired" | "cancelled" | "failed"; message: string } {
  const code = errorCode(error);
  if (code === "expired_token") return { status: "expired", message: "二维码已过期，请重新绑定" };
  if (code === "access_denied") return { status: "failed", message: "你已拒绝飞书应用授权" };
  if (code === "abort" || aborted) return { status: "cancelled", message: "绑定已取消" };
  if (error instanceof PublicFeishuConnectorError) return { status: "failed", message: error.publicMessage };
  return { status: "failed", message: "飞书应用注册或长连接建立失败" };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function closeChannel(handle: ChannelHandle): Promise<void> {
  try {
    // disconnect() is a no-op after a failed initial handshake, even though
    // rawWsClient may already be auto-reconnecting.
    try {
      handle.channel.rawWsClient?.close({});
    } catch {
      // Best effort; the regular connected path is closed below.
    }
    await handle.channel.disconnect();
  } finally {
    handle.unsubscribe();
  }
}

function recoveredBindingSession(credential: PersistedFeishuCredential): ImGatewayBindingSession {
  const now = new Date().toISOString();
  return {
    id: randomOpaqueId("feishu-binding-recovered"),
    provider: "feishu",
    status: "connected",
    domain: credential.domain,
    message: "已恢复本机保存的飞书连接",
    createdAt: now,
    updatedAt: now,
    connection: {
      id: credential.connectionId,
      accountId: credential.appId,
      ownerId: credential.ownerId,
      domain: credential.domain,
      connectedAt: credential.connectedAt,
      ...(credential.displayName ? { displayName: credential.displayName } : {}),
    },
  };
}

function normalizeCredential(input: PersistedFeishuCredential): PersistedFeishuCredential {
  const domain = input?.domain;
  assertFeishuDomain(domain);
  const connectedAt = requiredString(input.connectedAt, "connectedAt");
  if (!Number.isFinite(Date.parse(connectedAt))) throw new Error("Stored Feishu credential has an invalid connectedAt");
  const displayName = optionalString(input.displayName);
  const normalizedMediaScopesVersion = input.mediaScopesVersion === mediaScopesVersion
    ? mediaScopesVersion
    : undefined;
  return {
    connectionId: requiredString(input.connectionId, "connectionId"),
    appId: requiredString(input.appId, "appId"),
    appSecret: requiredString(input.appSecret, "appSecret"),
    ownerId: requiredString(input.ownerId, "ownerId"),
    domain,
    connectedAt: new Date(connectedAt).toISOString(),
    ...(displayName ? { displayName } : {}),
    ...(normalizedMediaScopesVersion ? { mediaScopesVersion: normalizedMediaScopesVersion } : {}),
  };
}

function cloneCredential(input: PersistedFeishuCredential): PersistedFeishuCredential {
  return { ...input };
}

function cloneSession(input: ImGatewayBindingSession): ImGatewayBindingSession {
  return {
    ...input,
    ...(input.connection ? { connection: { ...input.connection } } : {}),
  };
}

function assertFeishuDomain(value: unknown): asserts value is FeishuDomain {
  if (value !== "feishu" && value !== "lark") throw new Error("Feishu domain must be feishu or lark");
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function randomOpaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(24).toString("base64url")}`;
}

function domainLabel(domain?: FeishuDomain): string {
  return domain === "lark" ? "Lark" : "飞书";
}

function isoFromEpochMilliseconds(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : undefined;
}

async function uploadFeishuImage(handle: ChannelHandle, bytes: Buffer): Promise<string> {
  const response = await handle.channel.rawClient.im.v1.image.create({
    data: { image_type: "message", image: bytes },
  });
  const imageKey = responseField(response, "image_key");
  if (!imageKey) throw new Error("Feishu image upload response is missing image_key");
  return imageKey;
}

async function uploadFeishuFile(handle: ChannelHandle, bytes: Buffer, fileName: string): Promise<string> {
  const response = await handle.channel.rawClient.im.v1.file.create({
    data: { file_type: "stream", file_name: fileName, file: bytes },
  });
  const fileKey = responseField(response, "file_key");
  if (!fileKey) throw new Error("Feishu file upload response is missing file_key");
  return fileKey;
}

async function createFeishuMessage(
  handle: ChannelHandle,
  item: ImOutboxItem,
  partId: string,
  messageType: "text" | "image" | "file",
  content: Record<string, string>,
): Promise<string> {
  const response = await handle.channel.rawClient.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: item.externalChatId,
      msg_type: messageType,
      content: JSON.stringify(content),
      uuid: feishuMessageUuid(item.id, partId),
    },
  });
  const messageId = responseField(response, "message_id");
  if (!messageId) throw new Error("Feishu message create response is missing message_id");
  return messageId;
}

/**
 * Feishu's create-message UUID is the platform-side idempotency key. Derive a
 * fixed-size RFC 9562 UUIDv8 from the durable outbox and delivery-part IDs so
 * retries survive a lost response without exposing either internal value.
 */
function feishuMessageUuid(outboxId: string, partId: string): string {
  const bytes = Buffer.from(createHash("sha256")
    .update("yourchar/feishu/message/v1\0", "utf8")
    .update(outboxId, "utf8")
    .update("\0", "utf8")
    .update(partId, "utf8")
    .digest()
    .subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function responseField(response: unknown, field: string): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const direct = (response as Record<string, unknown>)[field];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nested = (response as Record<string, unknown>).data;
  if (!nested || typeof nested !== "object") return undefined;
  const value = (nested as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

class FeishuMediaLimitError extends Error {
  constructor(readonly limit: "single" | "total") {
    super(limit === "single" ? "Feishu attachment exceeds the size limit" : "Feishu attachments exceed the total limit");
    this.name = "FeishuMediaLimitError";
  }
}

function inboundMediaFailureMessage(error: unknown): string {
  if (error instanceof FeishuMediaLimitError) {
    return error.limit === "single"
      ? "单个图片或文件不能超过 20 MiB，请压缩或拆分后重试。"
      : "一条消息中的图片和文件合计不能超过 40 MiB，请分开发送。";
  }
  return "暂时无法读取你发送的飞书图片或文件，请稍后重试；若刚升级媒体功能，请解绑飞书后重新扫码授权。";
}

function inboundText(message: NormalizedMessage): string {
  if (message.rawContentType === "image" || message.rawContentType === "file") return "";
  let text = message.content;
  for (const resource of message.resources) {
    text = text.replaceAll(resource.fileKey, "");
  }
  return text
    .replace(/!\[image\]\(\s*\)/g, "")
    .replace(/<(?:file|image)\b[^>]*\/?\s*>/gi, "")
    .trim();
}

async function readBoundedStream(
  stream: NodeJS.ReadableStream & AsyncIterable<unknown> & { destroy(error?: Error): void },
  maximumBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : typeof chunk === "string"
          ? Buffer.from(chunk)
          : Buffer.from(chunk as Uint8Array);
      totalBytes += bytes.byteLength;
      if (totalBytes > maximumBytes) throw new FeishuMediaLimitError(maximumBytes < maxAttachmentBytes ? "total" : "single");
      chunks.push(bytes);
    }
  } catch (error) {
    stream.destroy(error instanceof Error ? error : undefined);
    throw error;
  }
  return Buffer.concat(chunks, totalBytes);
}

function stringHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  const raw = typeof getter === "function"
    ? getter.call(headers, name)
    : (headers as Record<string, unknown>)[name] ??
      (headers as Record<string, unknown>)[name.toLowerCase()] ??
      (headers as Record<string, unknown>)[name.toUpperCase()];
  if (typeof raw !== "string") return undefined;
  const normalized = raw.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && normalized.length <= 255 ? normalized : undefined;
}

function numericHeader(headers: unknown, name: string): number | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  const raw = typeof getter === "function"
    ? getter.call(headers, name)
    : (headers as Record<string, unknown>)[name] ??
      (headers as Record<string, unknown>)[name.toLowerCase()] ??
      (headers as Record<string, unknown>)[name.toUpperCase()];
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function defaultInboundFileName(kind: ImAttachment["kind"], contentType: string | undefined, index: number): string {
  const suffix = index + 1;
  if (kind === "file") return `feishu-file-${suffix}`;
  const extension = contentType === "image/jpeg"
    ? "jpg"
    : contentType === "image/gif"
      ? "gif"
      : contentType === "image/webp"
        ? "webp"
        : contentType === "image/bmp"
          ? "bmp"
          : contentType === "image/tiff"
            ? "tiff"
            : contentType === "image/x-icon" || contentType === "image/vnd.microsoft.icon"
              ? "ico"
              : "png";
  return `feishu-image-${suffix}.${extension}`;
}

function assertAttachmentEnvelope(attachments: readonly ImAttachment[]): void {
  if (attachments.length > maxAttachmentCount) {
    throw new Error(`Feishu messages support at most ${maxAttachmentCount} attachments`);
  }
  let totalBytes = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > maxAttachmentBytes) {
      throw new Error("Feishu attachment size is invalid or exceeds 20 MiB");
    }
    totalBytes += attachment.size;
    if (totalBytes > maxMessageAttachmentBytes) {
      throw new Error("Feishu attachments exceed the 40 MiB message limit");
    }
  }
}

function assertLoadedAttachment(
  attachment: ImAttachment,
  loaded: { bytes: Buffer; name: string; contentType: string },
): void {
  if (!Buffer.isBuffer(loaded.bytes)) throw new Error("Feishu outbound attachment loader returned invalid bytes");
  if (loaded.bytes.byteLength !== attachment.size) {
    throw new Error("Feishu outbound attachment changed after it was queued");
  }
  if (createHash("sha256").update(loaded.bytes).digest("hex") !== attachment.sha256) {
    throw new Error("Feishu outbound attachment digest no longer matches the queued file");
  }
  if (!optionalString(loaded.name)) throw new Error("Feishu outbound attachment name is missing");
  if (!optionalString(loaded.contentType)) throw new Error("Feishu outbound attachment content type is missing");
}
