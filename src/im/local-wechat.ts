/*
 * Weixin iLink protocol implementation derived from Tencent/openclaw-weixin
 * commit cef0bfc390393f716903e16d50408118047f87e0 (release 2.4.6),
 * Copyright (C) 2026 Tencent, licensed under the MIT License.
 *
 * This connector implements the protocol directly and does not depend on an
 * OpenClaw host. Keep the attribution above when redistributing this file.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as qrcode from "qrcode";
import { WorkspaceFileError } from "../workspace/file-service.js";
import { LocalImMediaError } from "./media-store.js";
import type {
  ImAttachment,
  ImGatewayBindingSession,
  ImInboundAttachmentInput,
  ImInboundEventInput,
  ImOutboxPartCallbacks,
  ImOutboxItem,
  ImOutboundAttachmentContent,
} from "./types.js";

export type PersistedWechatCredential = {
  connectionId: string;
  accountId: string;
  ownerId: string;
  token: string;
  baseUrl: string;
  connectedAt: string;
  displayName?: string;
  syncBuf?: string;
  contextTokens?: Record<string, string>;
};

export type LocalWechatConnectorCallbacks = {
  loadCredential: () =>
    | PersistedWechatCredential
    | undefined
    | Promise<PersistedWechatCredential | undefined>;
  saveCredential: (credential: PersistedWechatCredential) => void | Promise<void>;
  clearCredential: () => void | Promise<void>;
  shouldAcceptInbound?: () => boolean;
  onInbound: (event: ImInboundEventInput) => void | Promise<void>;
  saveInboundAttachment?: (
    input: ImInboundAttachmentInput,
  ) => ImAttachment | Promise<ImAttachment>;
  loadOutboundAttachment?: (
    attachment: ImAttachment,
  ) => ImOutboundAttachmentContent | Promise<ImOutboundAttachmentContent>;
  /** Intended for deterministic protocol tests; production uses global fetch. */
  fetch?: typeof globalThis.fetch;
};

type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

type BindingOperation = {
  controller: AbortController;
  requestController?: AbortController;
  qrcode: string;
  pollBaseUrl: string;
  pendingVerificationCode?: string;
  session: ImGatewayBindingSession;
  task?: Promise<void>;
};

type TypingActivity = {
  key: string;
  externalChatId: string;
  credential: PersistedWechatCredential;
  contextToken?: string;
  controller: AbortController;
  references: number;
  startAttempted: boolean;
  activated: boolean;
  ticket?: string;
  task: Promise<void>;
  stopTask?: Promise<void>;
};

type TypingTicketCacheEntry = {
  ticket: string;
  expiresAt: number;
};

export type LocalWechatTypingHandle = {
  stop(): Promise<void>;
};

type WeixinMessage = {
  seq?: unknown;
  message_id?: unknown;
  from_user_id?: unknown;
  client_id?: unknown;
  create_time_ms?: unknown;
  message_type?: unknown;
  item_list?: unknown;
  context_token?: unknown;
};

type WeixinCdnMedia = {
  encryptQueryParam?: string;
  aesKey?: string;
  fullUrl?: string;
};

type WeixinInboundMedia = {
  kind: "image" | "file";
  itemIndex: number;
  media: WeixinCdnMedia;
  imageAesKeyHex?: string;
  name?: string;
  contentType?: string;
  declaredSize?: number;
  fingerprint: Record<string, unknown>;
};

type PreparedWechatAttachment = {
  attachment: ImAttachment;
  content: ImOutboundAttachmentContent;
  index: number;
  partId: string;
};

const connectorVersion = "2.4.6";
const encodedClientVersion = String((2 << 16) | (4 << 8) | 6);
const fixedApiBaseUrl = "https://ilinkai.weixin.qq.com";
const fixedCdnBaseUrl = "https://novac2c.cdn.weixin.qq.com/c2c";
const qrCodeEndpoint = `${fixedApiBaseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
const bindingTtlMs = 5 * 60_000;
const regularRequestTimeoutMs = 15_000;
const stopRequestTimeoutMs = 10_000;
const qrStatusRequestTimeoutMs = 35_000;
const defaultUpdatesRequestTimeoutMs = 40_000;
const typingRequestTimeoutMs = 10_000;
const typingCancelTimeoutMs = 2_000;
const typingKeepaliveIntervalMs = 5_000;
const typingTicketCacheTtlMs = 24 * 60 * 60_000;
const maximumTypingResponseBytes = 131_072;
const wechatParagraphFormattingMinimumCharacters = 240;
const wechatParagraphTargetCharacters = 180;
const wechatMaximumParagraphs = 4;
const wechatParagraphShortTailCharacters = 60;
const maximumResponseBytes = 2_000_000;
const maximumInboundAttachmentBytes = 20 * 1024 * 1024;
const maximumInboundCiphertextBytes = maximumInboundAttachmentBytes + 16;
const maximumAttachmentsPerMessage = 8;
const maximumAttachmentsTotalBytes = 40 * 1024 * 1024;
const maximumCdnErrorResponseBytes = 65_536;
const maximumMediaParameterCharacters = 65_536;
const maximumMediaUrlCharacters = 8_192;
const cdnUploadAttempts = 3;
const maximumRedirects = 3;
const maximumContextTokens = 1_024;

const terminalBindingStatuses = new Set<ImGatewayBindingSession["status"]>([
  "connected",
  "expired",
  "cancelled",
  "failed",
]);

export class LocalWechatConnector {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly sessions = new Map<string, BindingOperation>();
  private readonly inFlightSends = new Set<Promise<void>>();
  private readonly pendingContextTokens = new Map<string, string>();
  private readonly typingActivities = new Map<string, TypingActivity>();
  private readonly typingTickets = new Map<string, TypingTicketCacheEntry>();
  private activeBinding?: BindingOperation;
  private credential?: PersistedWechatCredential;
  private connectionController?: AbortController;
  private receiveTask?: Promise<void>;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private disconnecting = false;
  private disposed = false;

  constructor(private readonly callbacks: LocalWechatConnectorCallbacks) {
    if (
      typeof callbacks?.loadCredential !== "function" ||
      typeof callbacks.saveCredential !== "function" ||
      typeof callbacks.clearCredential !== "function" ||
      typeof callbacks.onInbound !== "function"
    ) {
      throw new LocalWechatConnectorError(
        "WECHAT_CONNECTOR_CONFIG_INVALID",
        "微信连接器回调配置不完整",
      );
    }
    this.fetcher = callbacks.fetch ?? globalThis.fetch;
  }

  async restore(): Promise<void> {
    await this.withLifecycleLock(async () => {
      this.assertNotDisposed();
      if (this.credential) return;
      const stored = await this.loadCredential();
      if (!stored) return;
      const credential = normalizeCredential(stored);
      this.credential = credential;
      this.startReceiveLoop(credential);
    });
  }

  async startBinding(): Promise<ImGatewayBindingSession> {
    return this.withLifecycleLock(async () => {
      this.assertNotDisposed();
      if (this.disconnecting) {
        throw new LocalWechatConnectorError("WECHAT_DISCONNECTING", "微信连接正在断开");
      }
      if (this.credential) {
        return recoveredBindingSession(this.credential);
      }
      const stored = await this.loadCredential();
      if (stored) {
        throw new LocalWechatConnectorError(
          "WECHAT_CREDENTIAL_RESTORE_REQUIRED",
          "存在已保存的微信连接，请先恢复或断开",
        );
      }
      if (this.activeBinding && !terminalBindingStatuses.has(this.activeBinding.session.status)) {
        throw new LocalWechatConnectorError("WECHAT_BINDING_IN_PROGRESS", "微信绑定正在进行中");
      }

      const response = await this.requestJson(qrCodeEndpoint, {
        method: "POST",
        headers: postHeaders(),
        body: JSON.stringify({ local_token_list: [] }),
      }, regularRequestTimeoutMs, maximumResponseBytes);
      const source = responseRecord(response, "二维码响应");
      const qrcodeTicket = requiredBoundedString(source.qrcode, "qrcode", 8_192);
      const imageContent = requiredBoundedString(
        source.qrcode_img_content,
        "qrcode_img_content",
        8_192,
      );
      let qrCodeUrl: string;
      try {
        qrCodeUrl = await qrcode.toDataURL(imageContent, {
          type: "image/png",
          errorCorrectionLevel: "M",
          margin: 2,
          width: 320,
        });
      } catch {
        throw new LocalWechatConnectorError(
          "WECHAT_QR_RENDER_FAILED",
          "无法生成微信登录二维码",
        );
      }

      const now = new Date();
      const operation: BindingOperation = {
        controller: new AbortController(),
        qrcode: qrcodeTicket,
        pollBaseUrl: fixedApiBaseUrl,
        session: {
          id: `wechat-binding-${randomUUID()}`,
          provider: "wechat",
          status: "waiting_scan",
          qrCodeUrl,
          expiresAt: new Date(now.getTime() + bindingTtlMs).toISOString(),
          message: "请使用手机微信扫描二维码",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      };
      this.sessions.set(operation.session.id, operation);
      this.activeBinding = operation;
      operation.task = this.pollBinding(operation);
      void operation.task.catch(() => undefined);
      return cloneSession(operation.session);
    });
  }

  async getBindingSession(id: string): Promise<ImGatewayBindingSession> {
    return this.withLifecycleLock(async () => {
      const operation = this.requireSession(id);
      if (
        !terminalBindingStatuses.has(operation.session.status) &&
        operation.session.expiresAt &&
        Date.parse(operation.session.expiresAt) <= Date.now()
      ) {
        operation.controller.abort();
        this.finishBinding(operation, "expired", "二维码已过期，请重新绑定");
      }
      return cloneSession(operation.session);
    });
  }

  async cancelBindingSession(id: string): Promise<ImGatewayBindingSession> {
    return this.withLifecycleLock(async () => {
      const operation = this.requireSession(id);
      if (!terminalBindingStatuses.has(operation.session.status)) {
        operation.controller.abort();
        this.finishBinding(operation, "cancelled", "绑定已取消");
      }
      return cloneSession(operation.session);
    });
  }

  async submitVerificationCode(id: string, code: string): Promise<ImGatewayBindingSession> {
    return this.withLifecycleLock(async () => {
      this.assertNotDisposed();
      const operation = this.requireSession(id);
      if (terminalBindingStatuses.has(operation.session.status)) {
        throw new LocalWechatConnectorError(
          "WECHAT_BINDING_NOT_ACTIVE",
          "微信绑定会话已经结束",
        );
      }
      if (!operation.session.verificationRequired) {
        throw new LocalWechatConnectorError(
          "WECHAT_VERIFICATION_NOT_REQUIRED",
          "当前绑定会话不需要配对码",
        );
      }
      const normalizedCode = typeof code === "string" ? code.trim() : "";
      if (!/^\d{1,32}$/u.test(normalizedCode)) {
        throw new LocalWechatConnectorError(
          "WECHAT_VERIFICATION_CODE_INVALID",
          "微信配对码必须是数字",
        );
      }
      operation.pendingVerificationCode = normalizedCode;
      operation.session = {
        ...operation.session,
        status: "scanned",
        verificationRequired: false,
        message: "正在校验微信配对码",
        updatedAt: new Date().toISOString(),
      };
      // Wake a currently-held long poll so the code is submitted immediately.
      operation.requestController?.abort();
      return cloneSession(operation.session);
    });
  }

  async disconnect(connectionId?: string): Promise<void> {
    await this.withLifecycleLock(async () => {
      if (this.disconnecting) return;
      this.disconnecting = true;
      try {
        const operation = this.activeBinding;
        if (operation && !terminalBindingStatuses.has(operation.session.status)) {
          operation.controller.abort();
          this.finishBinding(operation, "cancelled", "绑定已取消");
        }

        const stored = this.credential ?? await this.loadCredential();
        const credential = stored ? normalizeCredential(stored) : undefined;
        if (connectionId && credential && credential.connectionId !== normalizedId(connectionId)) {
          throw new LocalWechatConnectorError(
            "WECHAT_CONNECTION_MISMATCH",
            "微信连接 ID 与当前凭据不匹配",
          );
        }

        const receiveTask = this.receiveTask;
        this.connectionController?.abort();
        await Promise.allSettled([
          ...this.inFlightSends,
          ...(receiveTask ? [receiveTask] : []),
        ]);
        await this.stopAllTyping();

        if (credential) {
          try {
            const response = await this.requestJson(
              apiUrl(credential.baseUrl, "ilink/bot/msg/notifystop"),
              {
                method: "POST",
                headers: postHeaders(credential.token),
                body: JSON.stringify({ base_info: baseInfo() }),
              },
              stopRequestTimeoutMs,
              maximumResponseBytes,
            );
            assertSuccessfulProtocolResponse(response, "停止通知");
          } catch {
            this.connectionController = undefined;
            this.receiveTask = undefined;
            this.credential = credential;
            throw new LocalWechatConnectorError(
              "WECHAT_NOTIFY_STOP_FAILED",
              "微信远端停止通知未送达，已保留本地凭据以便重试",
            );
          }
        }

        this.connectionController = undefined;
        this.receiveTask = undefined;
        this.pendingContextTokens.clear();
        this.credential = undefined;
        await this.clearCredential();
      } finally {
        this.disconnecting = false;
      }
    });
  }

  async send(item: ImOutboxItem, parts?: ImOutboxPartCallbacks): Promise<void> {
    this.assertNotDisposed();
    if (this.disconnecting) {
      throw new LocalWechatConnectorError("WECHAT_DISCONNECTING", "微信连接正在断开");
    }
    if (item.provider !== "wechat") {
      throw new LocalWechatConnectorError(
        "WECHAT_OUTBOX_PROVIDER_INVALID",
        "微信连接器只能发送微信 outbox 消息",
      );
    }
    const credential = this.credential;
    const controller = this.connectionController;
    if (!credential || !controller || controller.signal.aborted) {
      throw new LocalWechatConnectorError("WECHAT_NOT_CONNECTED", "微信尚未连接");
    }
    if (item.connectionId !== credential.connectionId) {
      throw new LocalWechatConnectorError(
        "WECHAT_CONNECTION_MISMATCH",
        "消息不属于当前微信连接",
      );
    }
    const externalChatId = requiredBoundedString(item.externalChatId, "externalChatId", 256);
    const rawText = optionalBoundedString(item.text, "text", 100_000, false) ?? "";
    const text = rawText ? formatWechatOutboundText(rawText) : "";
    const rawAttachments = Array.isArray(item.attachments) ? item.attachments : [];
    const attachments = rawAttachments.slice(0, maximumAttachmentsPerMessage);
    if (!text && attachments.length === 0) {
      throw new LocalWechatConnectorError(
        "WECHAT_OUTBOX_EMPTY",
        "微信消息没有可发送的文字或附件",
      );
    }
    if (rawAttachments.length > maximumAttachmentsPerMessage) {
      throw new LocalWechatConnectorError(
        "WECHAT_ATTACHMENTS_TOO_MANY",
        `微信单条消息最多发送 ${maximumAttachmentsPerMessage} 个附件`,
      );
    }
    const declaredTotalBytes = attachments.reduce((total, attachment) => {
      if (!Number.isFinite(attachment.size) || attachment.size < 0) {
        throw new LocalWechatConnectorError(
          "WECHAT_ATTACHMENT_INVALID",
          "微信附件大小无效",
        );
      }
      if (attachment.size > maximumInboundAttachmentBytes) {
        throw new LocalWechatConnectorError(
          "WECHAT_ATTACHMENT_TOO_LARGE",
          "微信单个附件不能超过 20 MiB",
        );
      }
      return total + attachment.size;
    }, 0);
    if (declaredTotalBytes > maximumAttachmentsTotalBytes) {
      throw new LocalWechatConnectorError(
        "WECHAT_ATTACHMENTS_TOO_LARGE",
        "微信单条消息的附件总大小不能超过 40 MiB",
      );
    }
    const contextToken = this.pendingContextTokens.get(
      contextTokenKey(credential.connectionId, externalChatId),
    ) ?? (credential.contextTokens &&
        Object.hasOwn(credential.contextTokens, externalChatId)
      ? credential.contextTokens[externalChatId]
      : undefined);
    if (!contextToken) {
      throw new LocalWechatConnectorError(
        "WECHAT_CONTEXT_TOKEN_MISSING",
        "缺少该微信会话的上下文令牌，无法安全回复",
      );
    }

    const operation = this.sendOutboxParts({
      credential,
      signal: controller.signal,
      to: externalChatId,
      text,
      attachments,
      contextToken,
      outboxId: item.id,
      parts,
    });
    this.inFlightSends.add(operation);
    try {
      await operation;
    } finally {
      this.inFlightSends.delete(operation);
    }
  }

  /**
   * Starts Weixin's native typing indicator without delaying the model turn.
   * The returned handle is idempotent and must be stopped in a finally block.
   * Typing is best-effort: protocol failures never fail the actual reply path.
   */
  beginTyping(externalChatId: string): LocalWechatTypingHandle {
    this.assertNotDisposed();
    const chatId = normalizedId(externalChatId);
    const credential = this.credential;
    const connectionController = this.connectionController;
    if (
      this.disconnecting || !credential || !connectionController ||
      connectionController.signal.aborted || chatId !== credential.ownerId
    ) {
      return stoppedTypingHandle();
    }

    const key = contextTokenKey(credential.connectionId, chatId);
    const existing = this.typingActivities.get(key);
    if (existing?.stopTask) {
      let stopped = false;
      const next = existing.stopTask.then(() => {
        if (stopped || this.disposed || this.disconnecting) return undefined;
        return this.beginTyping(chatId);
      });
      return {
        stop: async () => {
          if (stopped) return;
          stopped = true;
          const handle = await next;
          await handle?.stop();
        },
      };
    }
    if (existing) {
      existing.references += 1;
      return this.typingHandle(existing);
    }

    const contextToken = this.pendingContextTokens.get(key) ??
      credential.contextTokens?.[chatId];
    const activity: TypingActivity = {
      key,
      externalChatId: chatId,
      credential: cloneCredential(credential),
      ...(contextToken ? { contextToken } : {}),
      controller: new AbortController(),
      references: 1,
      startAttempted: false,
      activated: false,
      task: Promise.resolve(),
    };
    this.typingActivities.set(key, activity);
    activity.task = this.runTypingActivity(activity).catch(() => undefined);
    return this.typingHandle(activity);
  }

  async dispose(): Promise<void> {
    await this.withLifecycleLock(async () => {
      if (this.disposed) return;
      this.disposed = true;
      const operation = this.activeBinding;
      if (operation && !terminalBindingStatuses.has(operation.session.status)) {
        operation.controller.abort();
        this.finishBinding(operation, "cancelled", "连接器已停止");
      }
      const receiveTask = this.receiveTask;
      this.connectionController?.abort();
      await Promise.allSettled([
        ...this.inFlightSends,
        ...(receiveTask ? [receiveTask] : []),
      ]);
      await this.stopAllTyping();
      const credential = this.credential;
      if (credential) {
        await this.requestJson(
          apiUrl(credential.baseUrl, "ilink/bot/msg/notifystop"),
          {
            method: "POST",
            headers: postHeaders(credential.token),
            body: JSON.stringify({ base_info: baseInfo() }),
          },
          stopRequestTimeoutMs,
          maximumResponseBytes,
        ).catch(() => undefined);
      }
      this.connectionController = undefined;
      this.receiveTask = undefined;
      this.pendingContextTokens.clear();
      this.typingTickets.clear();
      this.credential = undefined;
    });
  }

  private typingHandle(activity: TypingActivity): LocalWechatTypingHandle {
    let stopped = false;
    return {
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await this.releaseTyping(activity);
      },
    };
  }

  private async releaseTyping(activity: TypingActivity, force = false): Promise<void> {
    if (activity.stopTask) {
      await activity.stopTask;
      return;
    }
    if (force) activity.references = 0;
    else activity.references = Math.max(0, activity.references - 1);
    if (activity.references > 0) return;

    activity.stopTask = (async () => {
      activity.controller.abort();
      await activity.task.catch(() => undefined);
      if ((activity.activated || activity.startAttempted) && activity.ticket) {
        await this.sendTypingStatus(activity, 2).catch(() => undefined);
      }
      if (this.typingActivities.get(activity.key) === activity) {
        this.typingActivities.delete(activity.key);
      }
    })();
    await activity.stopTask;
  }

  private async stopAllTyping(): Promise<void> {
    const activities = [...this.typingActivities.values()];
    await Promise.allSettled(activities.map((activity) => this.releaseTyping(activity, true)));
    this.typingTickets.clear();
  }

  private async runTypingActivity(activity: TypingActivity): Promise<void> {
    try {
      activity.ticket = await this.getTypingTicket(activity);
    } catch {
      return;
    }
    while (!activity.controller.signal.aborted) {
      try {
        // Once this request is dispatched, an abort cannot tell us whether the
        // server applied status=1 before the response was interrupted. Keep the
        // ticket so releaseTyping can send a best-effort status=2 in that case.
        activity.startAttempted = true;
        await this.sendTypingStatus(activity, 1, activity.controller.signal);
        activity.activated = true;
      } catch (error) {
        this.typingTickets.delete(activity.key);
        const interruptedByStop = activity.controller.signal.aborted &&
          error instanceof LocalWechatConnectorError &&
          error.code === "WECHAT_REQUEST_ABORTED";
        if (!activity.activated && !interruptedByStop) {
          activity.startAttempted = false;
          activity.ticket = undefined;
        }
        return;
      }
      try {
        await abortableDelay(typingKeepaliveIntervalMs, activity.controller.signal);
      } catch {
        return;
      }
    }
  }

  private async getTypingTicket(activity: TypingActivity): Promise<string> {
    const cached = this.typingTickets.get(activity.key);
    if (cached && cached.expiresAt > Date.now()) return cached.ticket;
    this.typingTickets.delete(activity.key);
    const response = await this.requestJson(
      apiUrl(activity.credential.baseUrl, "ilink/bot/getconfig"),
      {
        method: "POST",
        headers: postHeaders(activity.credential.token),
        body: JSON.stringify({
          ilink_user_id: activity.externalChatId,
          ...(activity.contextToken ? { context_token: activity.contextToken } : {}),
          base_info: baseInfo(),
        }),
      },
      typingRequestTimeoutMs,
      maximumTypingResponseBytes,
      activity.controller.signal,
    );
    const source = responseRecord(response, "输入状态配置响应");
    assertSuccessfulProtocolResponse(source, "读取输入状态配置");
    if (source.ret !== 0) {
      throw new LocalWechatConnectorError(
        "WECHAT_PROTOCOL_ERROR",
        "读取输入状态配置未成功",
      );
    }
    const ticket = requiredBoundedString(source.typing_ticket, "typing_ticket", 65_536);
    this.typingTickets.set(activity.key, {
      ticket,
      expiresAt: Date.now() + typingTicketCacheTtlMs,
    });
    return ticket;
  }

  private async sendTypingStatus(
    activity: TypingActivity,
    status: 1 | 2,
    signal?: AbortSignal,
  ): Promise<void> {
    const ticket = activity.ticket;
    if (!ticket) return;
    const response = await this.requestJson(
      apiUrl(activity.credential.baseUrl, "ilink/bot/sendtyping"),
      {
        method: "POST",
        headers: postHeaders(activity.credential.token),
        body: JSON.stringify({
          ilink_user_id: activity.externalChatId,
          typing_ticket: ticket,
          status,
          base_info: baseInfo(),
        }),
      },
      status === 2 ? typingCancelTimeoutMs : typingRequestTimeoutMs,
      maximumTypingResponseBytes,
      signal,
    );
    assertSuccessfulProtocolResponse(response, status === 1 ? "发送输入状态" : "取消输入状态");
  }

  private async pollBinding(operation: BindingOperation): Promise<void> {
    let failures = 0;
    while (!operation.controller.signal.aborted && this.isBindingCurrent(operation)) {
      if (operation.session.expiresAt && Date.parse(operation.session.expiresAt) <= Date.now()) {
        await this.withLifecycleLock(async () => {
          if (!this.isBindingCurrent(operation)) return;
          operation.controller.abort();
          this.finishBinding(operation, "expired", "二维码已过期，请重新绑定");
        });
        return;
      }

      const requestController = new AbortController();
      operation.requestController = requestController;
      try {
        const verifyCode = operation.pendingVerificationCode;
        const url = new URL("ilink/bot/get_qrcode_status", ensureTrailingSlash(operation.pollBaseUrl));
        url.searchParams.set("qrcode", operation.qrcode);
        if (verifyCode) url.searchParams.set("verify_code", verifyCode);
        const response = await this.requestJson(
          url.toString(),
          { method: "GET", headers: commonHeaders() },
          qrStatusRequestTimeoutMs,
          maximumResponseBytes,
          combineSignals(operation.controller.signal, requestController.signal),
        );
        failures = 0;
        const source = responseRecord(response, "二维码状态响应");
        const status = qrStatus(source.status);
        const done = await this.applyQrStatus(operation, status, source);
        if (done) return;
      } catch (error) {
        if (operation.controller.signal.aborted || !this.isBindingCurrent(operation)) return;
        if (requestController.signal.aborted) continue;
        failures += 1;
        operation.session = {
          ...operation.session,
          message: "微信登录状态查询暂时失败，正在重试",
          updatedAt: new Date().toISOString(),
        };
        await abortableDelay(backoffDelay(failures), operation.controller.signal);
      } finally {
        if (operation.requestController === requestController) {
          operation.requestController = undefined;
        }
      }
      await abortableDelay(250, operation.controller.signal).catch(() => undefined);
    }
  }

  private async applyQrStatus(
    operation: BindingOperation,
    status: QrStatus,
    response: Record<string, unknown>,
  ): Promise<boolean> {
    if (!this.isBindingCurrent(operation)) return true;
    const now = new Date().toISOString();
    switch (status) {
      case "wait":
        operation.session = {
          ...operation.session,
          status: operation.session.status === "scanned" ? "scanned" : "waiting_scan",
          verificationRequired: false,
          message: operation.session.status === "scanned"
            ? "已扫码，正在等待手机微信确认"
            : "请使用手机微信扫描二维码",
          updatedAt: now,
        };
        return false;
      case "scaned":
        operation.pendingVerificationCode = undefined;
        operation.session = {
          ...operation.session,
          status: "scanned",
          verificationRequired: false,
          message: "二维码已扫描，请在手机微信中确认",
          updatedAt: now,
        };
        return false;
      case "need_verifycode":
        operation.pendingVerificationCode = undefined;
        operation.session = {
          ...operation.session,
          status: "scanned",
          verificationRequired: true,
          message: "请输入手机微信显示的配对码",
          updatedAt: now,
        };
        return false;
      case "verify_code_blocked":
        await this.withLifecycleLock(async () => {
          if (!this.isBindingCurrent(operation)) return;
          operation.controller.abort();
          operation.pendingVerificationCode = undefined;
          this.finishBinding(operation, "failed", "配对码错误次数过多，请稍后重新绑定");
        });
        return true;
      case "binded_redirect":
        await this.withLifecycleLock(async () => {
          if (!this.isBindingCurrent(operation)) return;
          operation.controller.abort();
          this.finishBinding(
            operation,
            "failed",
            "该微信机器人已在其他客户端绑定，请先解除旧绑定后重试",
          );
        });
        return true;
      case "expired":
        await this.withLifecycleLock(async () => {
          if (!this.isBindingCurrent(operation)) return;
          operation.controller.abort();
          this.finishBinding(operation, "expired", "二维码已过期，请重新绑定");
        });
        return true;
      case "scaned_but_redirect": {
        try {
          const redirectHost = requiredBoundedString(response.redirect_host, "redirect_host", 1_024);
          operation.pollBaseUrl = normalizeRedirectHost(redirectHost);
        } catch {
          await this.withLifecycleLock(async () => {
            if (!this.isBindingCurrent(operation)) return;
            operation.controller.abort();
            this.finishBinding(operation, "failed", "微信服务返回了不受信任的连接地址");
          });
          return true;
        }
        operation.session = {
          ...operation.session,
          status: "scanned",
          verificationRequired: false,
          message: "二维码已扫描，正在连接微信服务",
          updatedAt: now,
        };
        return false;
      }
      case "confirmed": {
        let credential: PersistedWechatCredential;
        try {
          const token = requiredBoundedString(response.bot_token, "bot_token", 65_536);
          const accountId = requiredBoundedString(response.ilink_bot_id, "ilink_bot_id", 256);
          const ownerId = requiredBoundedString(response.ilink_user_id, "ilink_user_id", 256);
          const responseBaseUrl = optionalBoundedString(response.baseurl, "baseurl", 2_048);
          const baseUrl = normalizeApiBaseUrl(responseBaseUrl ?? operation.pollBaseUrl);
          credential = {
            connectionId: `wechat-connection-${randomUUID()}`,
            accountId,
            ownerId,
            token,
            baseUrl,
            connectedAt: now,
            displayName: "微信",
            contextTokens: {},
          };
        } catch {
          await this.withLifecycleLock(async () => {
            if (!this.isBindingCurrent(operation)) return;
            operation.controller.abort();
            this.finishBinding(operation, "failed", "微信确认响应缺少完整的登录凭据");
          });
          return true;
        }
        await this.withLifecycleLock(async () => {
          if (!this.isBindingCurrent(operation)) return;
          try {
            await this.saveCredential(credential);
          } catch {
            await this.clearCredential().catch(() => undefined);
            operation.controller.abort();
            this.finishBinding(operation, "failed", "保存微信连接凭据失败");
            return;
          }
          if (!this.isBindingCurrent(operation)) {
            await this.clearCredential().catch(() => undefined);
            return;
          }
          this.credential = cloneCredential(credential);
          this.finishBinding(operation, "connected", "微信已连接", {
            connection: {
              id: credential.connectionId,
              accountId: credential.accountId,
              ownerId: credential.ownerId,
              displayName: credential.displayName,
              connectedAt: credential.connectedAt,
            },
          });
          this.startReceiveLoop(credential);
        });
        return true;
      }
    }
  }

  private startReceiveLoop(credential: PersistedWechatCredential): void {
    this.connectionController?.abort();
    const controller = new AbortController();
    this.connectionController = controller;
    const task = this.pollUpdates(credential.connectionId, controller.signal);
    this.receiveTask = task;
    void task.finally(() => {
      if (this.receiveTask === task) this.receiveTask = undefined;
    }).catch(() => undefined);
  }

  private async pollUpdates(connectionId: string, signal: AbortSignal): Promise<void> {
    let failures = 0;
    let timeoutMs = defaultUpdatesRequestTimeoutMs;
    while (!signal.aborted && !this.disposed) {
      const credential = this.credential;
      if (!credential || credential.connectionId !== connectionId) return;
      const cursor = credential.syncBuf ?? "";
      const transientTokens: Array<[key: string, token: string]> = [];
      try {
        const response = await this.requestJson(
          apiUrl(credential.baseUrl, "ilink/bot/getupdates"),
          {
            method: "POST",
            headers: postHeaders(credential.token),
            body: JSON.stringify({
              get_updates_buf: cursor,
              base_info: baseInfo(),
            }),
          },
          timeoutMs,
          maximumResponseBytes,
          signal,
        );
        const source = responseRecord(response, "消息同步响应");
        assertSuccessfulProtocolResponse(source, "消息同步");
        const messages = source.msgs === undefined
          ? []
          : arrayValue(source.msgs, "msgs", 1_000);
        const nextCursor = optionalBoundedString(
          source.get_updates_buf ?? source.sync_buf,
          "get_updates_buf",
          maximumResponseBytes,
          false,
        ) ?? cursor;
        const nextContextTokens = cloneContextTokens(credential.contextTokens);

        messageLoop: for (const value of messages) {
          const message = responseRecord(value, "message") as WeixinMessage;
          if (message.message_type !== 1) continue;
          const fromUserId = requiredBoundedString(message.from_user_id, "from_user_id", 256);
          // Defense in depth before context-token capture, media download, or
          // Workspace persistence. Core repeats this owner check, but the
          // connector must not materialize a non-owner payload first.
          if (fromUserId !== credential.ownerId) continue;
          if (!this.shouldAcceptInbound()) continue;
          const contextToken = optionalBoundedString(
            message.context_token,
            "context_token",
            65_536,
          );
          const text = textFromMessage(message) ?? "";
          const parsedMedia = mediaFromMessage(message);
          const eventId = stableEventId(
            credential.accountId,
            message,
            text,
            parsedMedia.media.map((entry) => entry.fingerprint),
          );
          const attachments: ImAttachment[] = [];
          const attachmentWarnings = [...parsedMedia.warnings];
          let totalBytes = 0;
          for (const media of parsedMedia.media) {
            if (!this.shouldAcceptInbound()) continue messageLoop;
            if (!this.callbacks.saveInboundAttachment) {
              attachmentWarnings.push(media.kind === "image" ? "图片附件能力未配置" : "文件附件能力未配置");
              continue;
            }
            let bytes: Buffer;
            try {
              bytes = await this.downloadInboundMedia(media, signal);
            } catch (error) {
              if (
                error instanceof LocalWechatConnectorError &&
                (error.code === "WECHAT_REQUEST_ABORTED" ||
                  error.code === "WECHAT_REQUEST_TIMEOUT" ||
                  error.code === "WECHAT_REQUEST_FAILED" ||
                  error.code === "WECHAT_UPSTREAM_ERROR" &&
                    (error.upstreamStatus === 408 || error.upstreamStatus === 429 ||
                      (error.upstreamStatus !== undefined && error.upstreamStatus >= 500)))
              ) {
                throw error;
              }
              attachmentWarnings.push(media.kind === "image" ? "图片接收失败" : "文件接收失败");
              continue;
            }
            if (!this.shouldAcceptInbound()) continue messageLoop;
            totalBytes += bytes.byteLength;
            if (totalBytes > maximumAttachmentsTotalBytes) {
              attachmentWarnings.push("附件总大小超过 40 MiB");
              break;
            }
            let attachment: ImAttachment;
            try {
              attachment = await this.callbacks.saveInboundAttachment({
                provider: "wechat",
                eventId,
                kind: media.kind,
                ...(media.name ? { name: media.name } : {}),
                ...(media.contentType ? { contentType: media.contentType } : {}),
                ...(media.declaredSize !== undefined ? { declaredSize: media.declaredSize } : {}),
                bytes,
              });
            } catch (error) {
              const warning = deterministicInboundPersistenceWarning(error, media.kind);
              if (!warning) {
                // Transient filesystem/I/O failures deliberately escape this
                // poll iteration so the unchanged cursor retries the event.
                throw error;
              }
              attachmentWarnings.push(warning);
              continue;
            }
            attachments.push(attachment);
          }
          const inboundText = composeWechatInboundText(text, attachments, attachmentWarnings);
          if (!inboundText && attachments.length === 0) continue;
          if (!this.shouldAcceptInbound()) continue;
          if (contextToken) {
            setBoundedContextToken(nextContextTokens, fromUserId, contextToken);
            const key = contextTokenKey(connectionId, fromUserId);
            this.pendingContextTokens.set(key, contextToken);
            transientTokens.push([key, contextToken]);
          }
          await this.callbacks.onInbound({
            eventId,
            provider: "wechat",
            connectionId: credential.connectionId,
            externalChatId: fromUserId,
            externalUserId: fromUserId,
            chatType: "direct",
            text: inboundText,
            ...(attachments.length ? { attachments } : {}),
            ...receivedAt(message.create_time_ms),
          });
        }

        if (signal.aborted || this.credential?.connectionId !== connectionId) return;
        const updated: PersistedWechatCredential = {
          ...credential,
          ...(nextCursor ? { syncBuf: nextCursor } : {}),
          contextTokens: nextContextTokens,
        };
        // The cursor is advanced only after every callback in the batch succeeds.
        // If this save fails, both memory and the next request keep the old cursor.
        await this.saveCredential(updated);
        if (signal.aborted || this.credential?.connectionId !== connectionId) return;
        this.credential = updated;
        failures = 0;
        timeoutMs = updatesTimeout(source.longpolling_timeout_ms);
      } catch {
        if (signal.aborted || this.disposed) return;
        failures += 1;
        await abortableDelay(backoffDelay(failures), signal);
      } finally {
        for (const [key, token] of transientTokens) {
          if (this.pendingContextTokens.get(key) === token) {
            this.pendingContextTokens.delete(key);
          }
        }
      }
    }
  }

  private async sendOutboxParts(input: {
    credential: PersistedWechatCredential;
    signal: AbortSignal;
    to: string;
    text: string;
    attachments: ImAttachment[];
    contextToken: string;
    outboxId: string;
    parts?: ImOutboxPartCallbacks;
  }): Promise<void> {
    const prepared = await this.prepareOutboundAttachments(input.attachments, input.parts);
    if (input.text && !input.parts?.hasDelivered("text")) {
      const clientId = await this.sendMessageItem({
        credential: input.credential,
        signal: input.signal,
        to: input.to,
        messageItem: { type: 1, text_item: { text: input.text } },
        contextToken: input.contextToken,
        outboxId: input.outboxId,
        partId: "text",
      });
      input.parts?.recordDelivered("text", clientId);
    }

    for (const entry of prepared) {
      if (input.parts?.hasDelivered(entry.partId)) continue;
      const uploaded = await this.uploadOutboundAttachment({
        credential: input.credential,
        signal: input.signal,
        to: input.to,
        outboxId: input.outboxId,
        partId: entry.partId,
        attachment: entry.attachment,
        content: entry.content,
      });
      const messageItem = entry.attachment.kind === "image"
        ? {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: uploaded.downloadParameter,
                aes_key: Buffer.from(uploaded.aesKey.toString("hex"), "utf8").toString("base64"),
                encrypt_type: 1,
              },
              mid_size: uploaded.ciphertextBytes,
            },
          }
        : {
            type: 4,
            file_item: {
              media: {
                encrypt_query_param: uploaded.downloadParameter,
                aes_key: Buffer.from(uploaded.aesKey.toString("hex"), "utf8").toString("base64"),
                encrypt_type: 1,
              },
              file_name: wireFileName(entry.content.name || entry.attachment.name),
              len: String(entry.content.bytes.byteLength),
            },
          };
      const clientId = await this.sendMessageItem({
        credential: input.credential,
        signal: input.signal,
        to: input.to,
        messageItem,
        contextToken: input.contextToken,
        outboxId: input.outboxId,
        partId: entry.partId,
      });
      input.parts?.recordDelivered(entry.partId, clientId);
    }
  }

  private async prepareOutboundAttachments(
    attachments: ImAttachment[],
    parts?: ImOutboxPartCallbacks,
  ): Promise<PreparedWechatAttachment[]> {
    const pending = attachments.flatMap((attachment, index) => {
      const partId = `attachment:${index}`;
      return parts?.hasDelivered(partId) ? [] : [{ attachment, index, partId }];
    });
    if (pending.length === 0) return [];
    const load = this.callbacks.loadOutboundAttachment;
    if (!load) {
      throw new LocalWechatConnectorError(
        "WECHAT_ATTACHMENT_STORE_UNAVAILABLE",
        "微信附件读取能力未配置",
      );
    }
    const prepared: PreparedWechatAttachment[] = [];
    let totalBytes = 0;
    for (const entry of pending) {
      const content = await load(entry.attachment);
      if (!content || !Buffer.isBuffer(content.bytes)) {
        throw new LocalWechatConnectorError(
          "WECHAT_ATTACHMENT_INVALID",
          "Workspace 返回了无效的微信附件",
        );
      }
      if (content.bytes.byteLength > maximumInboundAttachmentBytes) {
        throw new LocalWechatConnectorError(
          "WECHAT_ATTACHMENT_TOO_LARGE",
          "微信单个附件不能超过 20 MiB",
        );
      }
      totalBytes += content.bytes.byteLength;
      if (totalBytes > maximumAttachmentsTotalBytes) {
        throw new LocalWechatConnectorError(
          "WECHAT_ATTACHMENTS_TOO_LARGE",
          "微信单条消息的附件总大小不能超过 40 MiB",
        );
      }
      prepared.push({ ...entry, content });
    }
    return prepared;
  }

  private async uploadOutboundAttachment(input: {
    credential: PersistedWechatCredential;
    signal: AbortSignal;
    to: string;
    outboxId: string;
    partId: string;
    attachment: ImAttachment;
    content: ImOutboundAttachmentContent;
  }): Promise<{
    aesKey: Buffer;
    ciphertextBytes: number;
    downloadParameter: string;
  }> {
    const fileKey = stableMediaSecret(input.credential.token, input.outboxId, input.partId, "filekey")
      .subarray(0, 16)
      .toString("hex");
    const aesKey = stableMediaSecret(input.credential.token, input.outboxId, input.partId, "aeskey")
      .subarray(0, 16);
    const rawBytes = input.content.bytes;
    const ciphertext = encryptWechatMedia(rawBytes, aesKey);
    const response = await this.requestJson(
      apiUrl(input.credential.baseUrl, "ilink/bot/getuploadurl"),
      {
        method: "POST",
        headers: postHeaders(input.credential.token),
        body: JSON.stringify({
          filekey: fileKey,
          media_type: input.attachment.kind === "image" ? 1 : 3,
          to_user_id: input.to,
          rawsize: rawBytes.byteLength,
          rawfilemd5: createHash("md5").update(rawBytes).digest("hex"),
          filesize: ciphertext.byteLength,
          no_need_thumb: true,
          aeskey: aesKey.toString("hex"),
          base_info: baseInfo(),
        }),
      },
      regularRequestTimeoutMs,
      maximumResponseBytes,
      input.signal,
    );
    const source = responseRecord(response, "附件上传地址响应");
    assertSuccessfulProtocolResponse(source, "获取附件上传地址");
    const uploadFullUrl = optionalBoundedString(
      source.upload_full_url,
      "upload_full_url",
      maximumMediaUrlCharacters,
    );
    const uploadParameter = optionalBoundedString(
      source.upload_param,
      "upload_param",
      maximumMediaParameterCharacters,
      false,
    );
    if (!uploadFullUrl && !uploadParameter) {
      throw new LocalWechatConnectorError(
        "WECHAT_UPLOAD_URL_MISSING",
        "微信没有返回附件上传地址",
      );
    }
    const uploadUrl = uploadFullUrl
      ? validatedWechatUrl(uploadFullUrl).toString()
      : `${fixedCdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParameter ?? "")}&filekey=${encodeURIComponent(fileKey)}`;
    const downloadParameter = await this.uploadCdnBytes(
      uploadUrl,
      ciphertext,
      input.signal,
    );
    return { aesKey, ciphertextBytes: ciphertext.byteLength, downloadParameter };
  }

  private async downloadInboundMedia(
    input: WeixinInboundMedia,
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (
      input.declaredSize !== undefined &&
      input.declaredSize > (input.kind === "image"
        ? maximumInboundCiphertextBytes
        : maximumInboundAttachmentBytes)
    ) {
      throw new LocalWechatConnectorError(
        "WECHAT_ATTACHMENT_TOO_LARGE",
        "微信附件超过 20 MiB",
      );
    }
    const url = input.media.fullUrl
      ? validatedWechatUrl(input.media.fullUrl).toString()
      : input.media.encryptQueryParam
        ? `${fixedCdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(input.media.encryptQueryParam)}`
        : undefined;
    if (!url) {
      throw new LocalWechatConnectorError(
        "WECHAT_MEDIA_REFERENCE_MISSING",
        "微信附件缺少下载引用",
      );
    }
    const encrypted = await this.requestCdnBytes(
      url,
      maximumInboundCiphertextBytes,
      signal,
    );
    const key = input.imageAesKeyHex
      ? Buffer.from(input.imageAesKeyHex, "hex")
      : input.media.aesKey
        ? parseWechatAesKey(input.media.aesKey)
        : undefined;
    if (!key && input.kind === "file") {
      throw new LocalWechatConnectorError(
        "WECHAT_MEDIA_KEY_MISSING",
        "微信文件缺少解密密钥",
      );
    }
    let plaintext: Buffer;
    try {
      plaintext = key ? decryptWechatMedia(encrypted, key) : encrypted;
    } catch {
      throw new LocalWechatConnectorError(
        "WECHAT_MEDIA_DECRYPT_FAILED",
        "微信附件解密失败",
      );
    }
    if (plaintext.byteLength > maximumInboundAttachmentBytes) {
      throw new LocalWechatConnectorError(
        "WECHAT_ATTACHMENT_TOO_LARGE",
        "微信附件超过 20 MiB",
      );
    }
    return plaintext;
  }

  private async sendMessageItem(input: {
    credential: PersistedWechatCredential;
    signal: AbortSignal;
    to: string;
    messageItem: Record<string, unknown>;
    contextToken: string;
    outboxId: string;
    partId: string;
  }): Promise<string> {
    const clientId = clientIdForOutbox(input.outboxId, input.partId);
    const response = await this.requestJson(
      apiUrl(input.credential.baseUrl, "ilink/bot/sendmessage"),
      {
        method: "POST",
        headers: postHeaders(input.credential.token),
        body: JSON.stringify({
          msg: {
            from_user_id: "",
            to_user_id: input.to,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            item_list: [input.messageItem],
            context_token: input.contextToken,
          },
          base_info: baseInfo(),
        }),
      },
      regularRequestTimeoutMs,
      maximumResponseBytes,
      input.signal,
    );
    assertSuccessfulProtocolResponse(response, "发送消息");
    return clientId;
  }

  private async requestCdnBytes(
    url: string,
    maximumBytes: number,
    externalSignal: AbortSignal,
  ): Promise<Buffer> {
    let currentUrl = validatedWechatUrl(url);
    for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const onExternalAbort = () => controller.abort();
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, regularRequestTimeoutMs);
      try {
        const response = await this.fetcher(currentUrl, {
          method: "GET",
          signal: controller.signal,
          redirect: "manual",
        });
        if (isRedirectStatus(response.status)) {
          if (redirectCount >= maximumRedirects) {
            await response.body?.cancel().catch(() => undefined);
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_LIMIT",
              "微信附件重定向次数过多",
            );
          }
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) {
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_INVALID",
              "微信附件返回了无效重定向",
            );
          }
          currentUrl = validatedWechatUrl(new URL(location, currentUrl).toString());
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new LocalWechatConnectorError(
            "WECHAT_UPSTREAM_ERROR",
            `微信附件服务返回 HTTP ${response.status}`,
            response.status,
          );
        }
        return await readBoundedResponseBuffer(response, maximumBytes);
      } catch (error) {
        if (error instanceof LocalWechatConnectorError) throw error;
        if (externalSignal.aborted) {
          throw new LocalWechatConnectorError("WECHAT_REQUEST_ABORTED", "微信附件请求已取消");
        }
        if (timedOut) {
          throw new LocalWechatConnectorError("WECHAT_REQUEST_TIMEOUT", "微信附件请求超时");
        }
        throw new LocalWechatConnectorError("WECHAT_REQUEST_FAILED", "无法连接微信附件服务");
      } finally {
        clearTimeout(timer);
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
    throw new LocalWechatConnectorError("WECHAT_REDIRECT_LIMIT", "微信附件重定向次数过多");
  }

  private async uploadCdnBytes(
    url: string,
    ciphertext: Buffer,
    externalSignal: AbortSignal,
  ): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= cdnUploadAttempts; attempt += 1) {
      try {
        const response = await this.requestCdnUpload(url, ciphertext, externalSignal);
        const parameter = response.headers.get("x-encrypted-param");
        await response.body?.cancel().catch(() => undefined);
        if (!parameter || parameter.length > maximumMediaParameterCharacters) {
          throw new LocalWechatConnectorError(
            "WECHAT_UPLOAD_RESPONSE_INVALID",
            "微信附件上传响应缺少下载参数",
          );
        }
        return parameter;
      } catch (error) {
        lastError = error;
        if (
          externalSignal.aborted ||
          error instanceof LocalWechatConnectorError &&
            error.upstreamStatus !== undefined &&
            error.upstreamStatus >= 400 &&
            error.upstreamStatus < 500
        ) {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LocalWechatConnectorError("WECHAT_UPLOAD_FAILED", "微信附件上传失败");
  }

  private async requestCdnUpload(
    url: string,
    ciphertext: Buffer,
    externalSignal: AbortSignal,
  ): Promise<Response> {
    let currentUrl = validatedWechatUrl(url);
    for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const onExternalAbort = () => controller.abort();
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, regularRequestTimeoutMs);
      try {
        const response = await this.fetcher(currentUrl, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
          signal: controller.signal,
          redirect: "manual",
        });
        if (isRedirectStatus(response.status)) {
          if (redirectCount >= maximumRedirects || (response.status !== 307 && response.status !== 308)) {
            await response.body?.cancel().catch(() => undefined);
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_INVALID",
              "微信附件上传返回了不安全的重定向",
            );
          }
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) {
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_INVALID",
              "微信附件上传返回了无效重定向",
            );
          }
          currentUrl = validatedWechatUrl(new URL(location, currentUrl).toString());
          continue;
        }
        if (response.status !== 200) {
          await readBoundedResponseBuffer(response, maximumCdnErrorResponseBytes).catch(() => undefined);
          throw new LocalWechatConnectorError(
            "WECHAT_UPSTREAM_ERROR",
            `微信附件上传服务返回 HTTP ${response.status}`,
            response.status,
          );
        }
        return response;
      } catch (error) {
        if (error instanceof LocalWechatConnectorError) throw error;
        if (externalSignal.aborted) {
          throw new LocalWechatConnectorError("WECHAT_REQUEST_ABORTED", "微信附件上传已取消");
        }
        if (timedOut) {
          throw new LocalWechatConnectorError("WECHAT_REQUEST_TIMEOUT", "微信附件上传超时");
        }
        throw new LocalWechatConnectorError("WECHAT_REQUEST_FAILED", "无法连接微信附件上传服务");
      } finally {
        clearTimeout(timer);
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
    throw new LocalWechatConnectorError("WECHAT_REDIRECT_LIMIT", "微信附件上传重定向次数过多");
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    maximumBytes: number,
    externalSignal?: AbortSignal,
  ): Promise<unknown> {
    let currentUrl = validatedWechatUrl(url);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    let headers = new Headers(init.headers);

    for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
      const controller = new AbortController();
      let timedOut = false;
      const onExternalAbort = () => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      try {
        const response = await this.fetcher(currentUrl, {
          method,
          headers,
          body,
          signal: controller.signal,
          redirect: "manual",
        });

        if (isRedirectStatus(response.status)) {
          if (redirectCount >= maximumRedirects) {
            await response.body?.cancel().catch(() => undefined);
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_LIMIT",
              "微信服务重定向次数过多",
            );
          }
          const location = response.headers.get("location");
          await response.body?.cancel().catch(() => undefined);
          if (!location) {
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_INVALID",
              "微信服务返回了无效重定向",
            );
          }
          let redirected: URL;
          try {
            redirected = new URL(location, currentUrl);
          } catch {
            throw new LocalWechatConnectorError(
              "WECHAT_REDIRECT_INVALID",
              "微信服务返回了无效重定向",
            );
          }
          const nextUrl = validatedWechatUrl(redirected.toString());
          if (nextUrl.origin !== currentUrl.origin) {
            headers = new Headers(headers);
            headers.delete("authorization");
            headers.delete("authorizationtype");
            headers.delete("x-wechat-uin");
          }
          currentUrl = nextUrl;
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && method === "POST")
          ) {
            method = "GET";
            body = undefined;
            headers = new Headers(headers);
            headers.delete("content-type");
            headers.delete("content-length");
          }
          continue;
        }

        // Keep the timeout signal alive while consuming a streamed body too;
        // receiving headers alone must not allow an unbounded slow response.
        const raw = await readBoundedResponseText(response, maximumBytes);
        if (!response.ok) {
          throw new LocalWechatConnectorError(
            "WECHAT_UPSTREAM_ERROR",
            `微信服务返回 HTTP ${response.status}`,
            response.status,
          );
        }
        if (!raw) {
          throw new LocalWechatConnectorError(
            "WECHAT_RESPONSE_INVALID",
            "微信服务返回了空响应",
          );
        }
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          throw new LocalWechatConnectorError(
            "WECHAT_RESPONSE_INVALID",
            "微信服务返回了无效响应",
          );
        }
      } catch (error) {
        if (error instanceof LocalWechatConnectorError) throw error;
        if (externalSignal?.aborted) {
          throw new LocalWechatConnectorError("WECHAT_REQUEST_ABORTED", "微信请求已取消");
        }
        if (timedOut) {
          throw new LocalWechatConnectorError("WECHAT_REQUEST_TIMEOUT", "微信服务请求超时");
        }
        throw new LocalWechatConnectorError("WECHAT_REQUEST_FAILED", "无法连接微信服务");
      } finally {
        clearTimeout(timer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
      }
    }
    throw new LocalWechatConnectorError("WECHAT_REDIRECT_LIMIT", "微信服务重定向次数过多");
  }

  private finishBinding(
    operation: BindingOperation,
    status: Extract<ImGatewayBindingSession["status"], "connected" | "expired" | "cancelled" | "failed">,
    message: string,
    extra: Pick<ImGatewayBindingSession, "connection"> = {},
  ): void {
    if (terminalBindingStatuses.has(operation.session.status)) return;
    const { qrCodeUrl: _qrCodeUrl, verificationRequired: _verificationRequired, ...session } = operation.session;
    operation.qrcode = "";
    operation.pendingVerificationCode = undefined;
    operation.session = {
      ...session,
      status,
      message,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    if (this.activeBinding === operation) this.activeBinding = undefined;
  }

  private isBindingCurrent(operation: BindingOperation): boolean {
    return !this.disposed && this.activeBinding === operation &&
      !terminalBindingStatuses.has(operation.session.status) &&
      !operation.controller.signal.aborted;
  }

  private requireSession(id: string): BindingOperation {
    const operation = this.sessions.get(normalizedId(id));
    if (!operation) {
      throw new LocalWechatConnectorError(
        "WECHAT_BINDING_NOT_FOUND",
        "Wechat binding session was not found",
      );
    }
    return operation;
  }

  private async loadCredential(): Promise<PersistedWechatCredential | undefined> {
    try {
      const value = await this.callbacks.loadCredential();
      return value ? cloneCredential(value) : undefined;
    } catch {
      throw new LocalWechatConnectorError(
        "WECHAT_CREDENTIAL_LOAD_FAILED",
        "读取微信连接凭据失败",
      );
    }
  }

  private async saveCredential(credential: PersistedWechatCredential): Promise<void> {
    try {
      await this.callbacks.saveCredential(cloneCredential(credential));
    } catch {
      throw new LocalWechatConnectorError(
        "WECHAT_CREDENTIAL_SAVE_FAILED",
        "保存微信连接凭据失败",
      );
    }
  }

  private async clearCredential(): Promise<void> {
    try {
      await this.callbacks.clearCredential();
    } catch {
      throw new LocalWechatConnectorError(
        "WECHAT_CREDENTIAL_CLEAR_FAILED",
        "清除微信连接凭据失败",
      );
    }
  }

  private withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.catch(() => undefined).then(operation);
    this.lifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private shouldAcceptInbound(): boolean {
    try {
      return this.callbacks.shouldAcceptInbound?.() ?? true;
    } catch {
      return false;
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new LocalWechatConnectorError("WECHAT_CONNECTOR_DISPOSED", "微信连接器已经停止");
    }
  }
}

export class LocalWechatConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "LocalWechatConnectorError";
  }
}

function recoveredBindingSession(credential: PersistedWechatCredential): ImGatewayBindingSession {
  const now = new Date().toISOString();
  return {
    id: `wechat-binding-recovered-${randomUUID()}`,
    provider: "wechat",
    status: "connected",
    message: "已恢复本机保存的微信连接",
    createdAt: now,
    updatedAt: now,
    connection: {
      id: credential.connectionId,
      accountId: credential.accountId,
      ownerId: credential.ownerId,
      connectedAt: credential.connectedAt,
      ...(credential.displayName ? { displayName: credential.displayName } : {}),
    },
  };
}

function baseInfo(): { channel_version: string; bot_agent: string } {
  return {
    channel_version: connectorVersion,
    bot_agent: "YourChar/0.1.0",
  };
}

function commonHeaders(): Record<string, string> {
  return {
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": encodedClientVersion,
  };
}

function postHeaders(token?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...commonHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function randomWechatUin(): string {
  const value = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(value), "utf8").toString("base64");
}

function clientIdForOutbox(outboxId: string, partId = "text"): string {
  const normalized = requiredBoundedString(outboxId, "outbox id", 256);
  const normalizedPartId = requiredBoundedString(partId, "outbox part id", 256);
  const digest = createHash("sha256").update(normalized);
  // Keep the historical text-only client id stable across this upgrade so an
  // already-dispatched legacy outbox row cannot be duplicated after restart.
  if (normalizedPartId !== "text") digest.update("\u0000").update(normalizedPartId);
  return `yourchar-${digest.digest("hex")}`;
}

function stableMediaSecret(
  token: string,
  outboxId: string,
  partId: string,
  purpose: string,
): Buffer {
  return createHmac("sha256", token)
    .update(requiredBoundedString(outboxId, "outbox id", 256))
    .update("\u0000")
    .update(requiredBoundedString(partId, "outbox part id", 256))
    .update("\u0000")
    .update(purpose)
    .digest();
}

function contextTokenKey(connectionId: string, externalChatId: string): string {
  return `${connectionId}\u0000${externalChatId}`;
}

function stoppedTypingHandle(): LocalWechatTypingHandle {
  return { stop: async () => undefined };
}

/**
 * Makes a long, unstructured Chinese reply easier to scan in one WeChat
 * bubble. This is deliberately a whitespace-only transport rendering: the
 * durable outbox and Web transcript retain the model's original text, and the
 * connector still performs exactly one sendmessage request.
 *
 * Existing layout and Markdown-like structures are left byte-for-byte intact.
 * That fail-closed rule avoids corrupting code, tables, links, and lists.
 */
function formatWechatOutboundText(text: string): string {
  if (
    text !== text.trim() ||
    unicodeCharacterCount(text) < wechatParagraphFormattingMinimumCharacters ||
    /[\r\n`|*_~<>\[\]]/u.test(text) ||
    /(?:https?:\/\/|mailto:|\bwww\.)/iu.test(text) ||
    /!?\[[^\]\n]+\]\([^\n)]*\)/u.test(text) ||
    /^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/u.test(text)
  ) {
    return text;
  }

  const sentences = text.match(
    /[^。！？；]+[。！？；]+(?:[”’"'）》】〕』」]*)|[^。！？；]+$/gu,
  ) ?? [];
  if (sentences.length < 2 || sentences.join("") !== text) return text;

  const sentenceCharacters = sentences.map(unicodeCharacterCount);
  const totalCharacters = sentenceCharacters.reduce((total, count) => total + count, 0);
  const desiredParagraphs = Math.min(
    wechatMaximumParagraphs,
    sentences.length,
    Math.ceil(totalCharacters / wechatParagraphTargetCharacters),
  );
  if (desiredParagraphs < 2) return text;

  const paragraphs: string[] = [];
  let sentenceIndex = 0;
  let remainingCharacters = totalCharacters;
  for (let paragraphIndex = 0; paragraphIndex < desiredParagraphs; paragraphIndex += 1) {
    const remainingParagraphs = desiredParagraphs - paragraphIndex;
    if (remainingParagraphs === 1) {
      paragraphs.push(sentences.slice(sentenceIndex).join(""));
      break;
    }
    const targetCharacters = remainingCharacters / remainingParagraphs;
    const lastAvailableIndex = sentences.length - (remainingParagraphs - 1);
    let endIndex = sentenceIndex;
    let paragraphCharacters = 0;
    while (endIndex < lastAvailableIndex) {
      const nextCharacters = sentenceCharacters[endIndex] ?? 0;
      if (
        endIndex > sentenceIndex &&
        Math.abs(paragraphCharacters - targetCharacters) <=
          Math.abs(paragraphCharacters + nextCharacters - targetCharacters)
      ) {
        break;
      }
      paragraphCharacters += nextCharacters;
      endIndex += 1;
    }
    paragraphs.push(sentences.slice(sentenceIndex, endIndex).join(""));
    sentenceIndex = endIndex;
    remainingCharacters -= paragraphCharacters;
  }
  if (
    paragraphs.length > 1 &&
    unicodeCharacterCount(paragraphs[paragraphs.length - 1] ?? "") <
      wechatParagraphShortTailCharacters
  ) {
    const tail = paragraphs.pop() ?? "";
    paragraphs[paragraphs.length - 1] = `${paragraphs[paragraphs.length - 1] ?? ""}${tail}`;
  }
  const formatted = paragraphs.length > 1 ? paragraphs.join("\n\n") : text;
  return formatted.length <= 100_000 ? formatted : text;
}

function unicodeCharacterCount(value: string): number {
  return Array.from(value).length;
}

function stableEventId(
  accountId: string,
  message: WeixinMessage,
  text: string,
  media: readonly Record<string, unknown>[] = [],
): string {
  const digest = createHash("sha256").update(JSON.stringify({
    accountId,
    messageId: scalarId(message.message_id),
    sequence: scalarId(message.seq),
    clientId: scalarId(message.client_id),
    fromUserId: optionalBoundedString(message.from_user_id, "from_user_id", 256),
    createdAt: finiteNumber(message.create_time_ms),
    text,
    media,
  })).digest("hex");
  return `wechat-${digest}`;
}

function textFromMessage(message: WeixinMessage): string | undefined {
  if (!Array.isArray(message.item_list)) return undefined;
  for (const value of message.item_list) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    if (item.type !== 1 || !item.text_item || typeof item.text_item !== "object" || Array.isArray(item.text_item)) {
      continue;
    }
    const text = optionalBoundedString(
      (item.text_item as Record<string, unknown>).text,
      "text",
      100_000,
      false,
    );
    if (text?.trim()) return text.trim();
  }
  return undefined;
}

function mediaFromMessage(message: WeixinMessage): {
  media: WeixinInboundMedia[];
  warnings: string[];
} {
  if (!Array.isArray(message.item_list)) return { media: [], warnings: [] };
  const direct: Array<{ value: Record<string, unknown>; itemIndex: number }> = [];
  const referenced: Array<{ value: Record<string, unknown>; itemIndex: number }> = [];
  const warnings: string[] = [];
  for (const [itemIndex, value] of message.item_list.entries()) {
    if (!isRecord(value)) continue;
    if (value.type === 2 || value.type === 4) direct.push({ value, itemIndex });
    else if (value.type === 3) warnings.push("语音暂不支持读取");
    else if (value.type === 5) warnings.push("视频暂不支持读取");
    if (value.type !== 1 || !isRecord(value.ref_msg) || !isRecord(value.ref_msg.message_item)) {
      continue;
    }
    const referencedItem = value.ref_msg.message_item;
    if (referencedItem.type === 2 || referencedItem.type === 4) {
      referenced.push({ value: referencedItem, itemIndex: itemIndex + 10_000 });
    }
  }
  const selected = direct.length > 0 ? direct : referenced;
  const media: WeixinInboundMedia[] = [];
  for (const candidate of selected) {
    if (media.length >= maximumAttachmentsPerMessage) {
      warnings.push(`附件超过 ${maximumAttachmentsPerMessage} 个，超出部分未读取`);
      break;
    }
    const parsed = parseWechatMediaItem(candidate.value, candidate.itemIndex);
    if (parsed) media.push(parsed);
    else warnings.push(candidate.value.type === 2 ? "图片缺少有效下载信息" : "文件缺少有效下载信息");
  }
  return { media, warnings: [...new Set(warnings)] };
}

function parseWechatMediaItem(
  item: Record<string, unknown>,
  itemIndex: number,
): WeixinInboundMedia | undefined {
  const kind = item.type === 2 ? "image" : item.type === 4 ? "file" : undefined;
  const itemBody = kind === "image" ? item.image_item : kind === "file" ? item.file_item : undefined;
  if (!kind || !isRecord(itemBody) || !isRecord(itemBody.media)) return undefined;
  const mediaBody = itemBody.media;
  const encryptQueryParam = looseBoundedString(
    mediaBody.encrypt_query_param,
    maximumMediaParameterCharacters,
    false,
  );
  const fullUrl = looseBoundedString(mediaBody.full_url, maximumMediaUrlCharacters);
  if (!encryptQueryParam && !fullUrl) return undefined;
  const aesKey = looseBoundedString(mediaBody.aes_key, 1_024, false);
  const imageAesKeyCandidate = kind === "image"
    ? looseBoundedString(itemBody.aeskey, 128)
    : undefined;
  const imageAesKeyHex = imageAesKeyCandidate && /^[0-9a-f]{32}$/iu.test(imageAesKeyCandidate)
    ? imageAesKeyCandidate.toLowerCase()
    : undefined;
  const name = kind === "file"
    ? looseBoundedString(itemBody.file_name, 500)
    : undefined;
  const declaredSize = kind === "image"
    ? nonNegativeInteger(itemBody.mid_size ?? itemBody.hd_size)
    : decimalByteLength(itemBody.len);
  const media: WeixinCdnMedia = {
    ...(encryptQueryParam ? { encryptQueryParam } : {}),
    ...(aesKey ? { aesKey } : {}),
    ...(fullUrl ? { fullUrl } : {}),
  };
  return {
    kind,
    itemIndex,
    media,
    ...(imageAesKeyHex ? { imageAesKeyHex } : {}),
    ...(name ? { name } : {}),
    ...(name ? { contentType: contentTypeForFilename(name) } : {}),
    ...(declaredSize !== undefined ? { declaredSize } : {}),
    fingerprint: {
      kind,
      itemIndex,
      encryptQueryParam,
      fullUrl,
      name,
      declaredSize,
    },
  };
}

function composeWechatInboundText(
  text: string,
  attachments: readonly ImAttachment[],
  warnings: readonly string[],
): string {
  const pieces: string[] = [];
  const trimmed = text.trim();
  if (trimmed) pieces.push(trimmed);
  if (!trimmed && attachments.length > 0) {
    const kinds = new Set(attachments.map((attachment) => attachment.kind));
    pieces.push(
      kinds.size === 1 && kinds.has("image")
        ? "请查看我通过微信发送的图片。"
        : kinds.size === 1 && kinds.has("file")
          ? "请查看我通过微信发送的文件。"
          : "请查看我通过微信发送的附件。",
    );
  }
  const uniqueWarnings = [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
  if (uniqueWarnings.length > 0) {
    pieces.push(`[微信系统提示：${uniqueWarnings.join("；")}。]`);
  }
  return pieces.join("\n\n");
}

function deterministicInboundPersistenceWarning(
  error: unknown,
  kind: "image" | "file",
): string | undefined {
  const label = kind === "image" ? "图片" : "文件";
  if (error instanceof LocalImMediaError) {
    if (error.code === "IM_MEDIA_TOO_LARGE") return `${label}超过大小限制，未接收`;
    if (error.code === "IM_MEDIA_INVALID") return `${label}格式无效，未接收`;
    return `${label}无法安全保存，未接收`;
  }
  if (error instanceof WorkspaceFileError) {
    return `${label}无法安全保存，未接收`;
  }
  return undefined;
}

function receivedAt(value: unknown): Pick<ImInboundEventInput, "receivedAt"> {
  const milliseconds = finiteNumber(value);
  if (milliseconds === undefined || milliseconds <= 0) return {};
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? { receivedAt: date.toISOString() } : {};
}

function normalizeCredential(input: PersistedWechatCredential): PersistedWechatCredential {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalWechatConnectorError(
      "WECHAT_CREDENTIAL_INVALID",
      "保存的微信连接凭据无效",
    );
  }
  const source = input as unknown as Record<string, unknown>;
  const connectedAt = requiredBoundedString(source.connectedAt, "connectedAt", 100);
  if (!Number.isFinite(Date.parse(connectedAt))) {
    throw new LocalWechatConnectorError(
      "WECHAT_CREDENTIAL_INVALID",
      "保存的微信连接凭据无效",
    );
  }
  const displayName = optionalBoundedString(source.displayName, "displayName", 200);
  const syncBuf = optionalBoundedString(source.syncBuf, "syncBuf", maximumResponseBytes, false);
  return {
    connectionId: requiredBoundedString(source.connectionId, "connectionId", 256),
    accountId: requiredBoundedString(source.accountId, "accountId", 256),
    ownerId: requiredBoundedString(source.ownerId, "ownerId", 256),
    token: requiredBoundedString(source.token, "token", 65_536),
    baseUrl: normalizeApiBaseUrl(source.baseUrl),
    connectedAt: new Date(connectedAt).toISOString(),
    ...(displayName ? { displayName } : {}),
    ...(syncBuf ? { syncBuf } : {}),
    contextTokens: cloneContextTokens(source.contextTokens as Record<string, string> | undefined),
  };
}

function cloneCredential(input: PersistedWechatCredential): PersistedWechatCredential {
  return {
    ...input,
    ...(input.contextTokens ? { contextTokens: { ...input.contextTokens } } : {}),
  };
}

function cloneContextTokens(input?: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  if (input === undefined) return result;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LocalWechatConnectorError(
      "WECHAT_CREDENTIAL_INVALID",
      "保存的微信连接凭据无效",
    );
  }
  const entries = Object.entries(input);
  if (entries.length > maximumContextTokens) {
    throw new LocalWechatConnectorError(
      "WECHAT_CREDENTIAL_INVALID",
      "保存的微信连接凭据无效",
    );
  }
  for (const [chatId, token] of entries) {
    const normalizedChatId = requiredBoundedString(chatId, "context chat id", 256);
    result[normalizedChatId] = requiredBoundedString(token, "context token", 65_536);
  }
  return result;
}

function setBoundedContextToken(
  contextTokens: Record<string, string>,
  chatId: string,
  token: string,
): void {
  if (!Object.hasOwn(contextTokens, chatId) && Object.keys(contextTokens).length >= maximumContextTokens) {
    const oldest = Object.keys(contextTokens)[0];
    if (oldest) delete contextTokens[oldest];
  }
  contextTokens[chatId] = token;
}

function normalizeApiBaseUrl(value: unknown): string {
  const raw = requiredBoundedString(value, "baseUrl", 2_048);
  const parsed = validatedWechatUrl(raw);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function normalizeRedirectHost(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new LocalWechatConnectorError(
      "WECHAT_REDIRECT_INVALID",
      "微信服务返回了无效重定向",
    );
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new LocalWechatConnectorError(
      "WECHAT_REDIRECT_INVALID",
      "微信服务返回了无效重定向",
    );
  }
  return validatedWechatUrl(parsed.toString()).origin;
}

function validatedWechatUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LocalWechatConnectorError("WECHAT_URL_INVALID", "微信服务地址无效");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    (parsed.port && parsed.port !== "443") || !isTrustedWechatHostname(hostname)
  ) {
    throw new LocalWechatConnectorError(
      "WECHAT_URL_UNTRUSTED",
      "微信服务地址不是受信任的 HTTPS 地址",
    );
  }
  return parsed;
}

function isTrustedWechatHostname(hostname: string): boolean {
  return hostname === "weixin.qq.com" || hostname.endsWith(".weixin.qq.com") ||
    hostname === "weixin.com" || hostname.endsWith(".weixin.com");
}

function apiUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, ensureTrailingSlash(normalizeApiBaseUrl(baseUrl))).toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  return (await readBoundedResponseBuffer(response, maximumBytes)).toString("utf8");
}

async function readBoundedResponseBuffer(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalWechatConnectorError(
      "WECHAT_RESPONSE_TOO_LARGE",
      "微信服务响应过大",
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LocalWechatConnectorError(
          "WECHAT_RESPONSE_TOO_LARGE",
          "微信服务响应过大",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), length);
}

function assertSuccessfulProtocolResponse(value: unknown, label: string): void {
  const source = responseRecord(value, `${label}响应`);
  const ret = source.ret;
  const errcode = source.errcode;
  if (
    (ret !== undefined && (typeof ret !== "number" || !Number.isFinite(ret) || ret !== 0)) ||
    (errcode !== undefined &&
      (typeof errcode !== "number" || !Number.isFinite(errcode) || errcode !== 0))
  ) {
    throw new LocalWechatConnectorError(
      "WECHAT_PROTOCOL_ERROR",
      `${label}未成功`,
    );
  }
}

function responseRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LocalWechatConnectorError(
      "WECHAT_RESPONSE_INVALID",
      `微信服务${field}无效`,
    );
  }
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, field: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new LocalWechatConnectorError(
      "WECHAT_RESPONSE_INVALID",
      `微信服务${field}无效`,
    );
  }
  return value;
}

function qrStatus(value: unknown): QrStatus {
  if (
    value === "wait" || value === "scaned" || value === "confirmed" || value === "expired" ||
    value === "scaned_but_redirect" || value === "need_verifycode" ||
    value === "verify_code_blocked" || value === "binded_redirect"
  ) {
    return value;
  }
  throw new LocalWechatConnectorError(
    "WECHAT_RESPONSE_INVALID",
    "微信服务返回了未知的二维码状态",
  );
}

function requiredBoundedString(
  value: unknown,
  field: string,
  maximum: number,
  trim = true,
): string {
  const result = optionalBoundedString(value, field, maximum, trim);
  if (!result) {
    throw new LocalWechatConnectorError(
      "WECHAT_RESPONSE_INVALID",
      `微信服务字段 ${field} 无效`,
    );
  }
  return result;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  maximum: number,
  trim = true,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maximum) {
    throw new LocalWechatConnectorError(
      "WECHAT_RESPONSE_INVALID",
      `微信服务字段 ${field} 无效`,
    );
  }
  const normalized = trim ? value.trim() : value;
  return normalized || undefined;
}

function looseBoundedString(
  value: unknown,
  maximum: number,
  trim = true,
): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return undefined;
  const normalized = trim ? value.trim() : value;
  return normalized || undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function decimalByteLength(value: unknown): number | undefined {
  if (typeof value === "number") return nonNegativeInteger(value);
  if (typeof value !== "string" || !/^\d{1,16}$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseWechatAesKey(value: string): Buffer {
  const normalized = value.trim();
  if (
    normalized.length > 1_024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(normalized) ||
    normalized.length % 4 !== 0
  ) {
    throw new LocalWechatConnectorError("WECHAT_MEDIA_KEY_INVALID", "微信附件解密密钥无效");
  }
  const decoded = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/u, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/u, "");
  if (canonicalInput !== canonicalDecoded) {
    throw new LocalWechatConnectorError("WECHAT_MEDIA_KEY_INVALID", "微信附件解密密钥无效");
  }
  if (decoded.byteLength === 16) return decoded;
  if (decoded.byteLength === 32 && /^[0-9a-f]{32}$/iu.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new LocalWechatConnectorError("WECHAT_MEDIA_KEY_INVALID", "微信附件解密密钥无效");
}

function encryptWechatMedia(plaintext: Buffer, key: Buffer): Buffer {
  if (key.byteLength !== 16) {
    throw new LocalWechatConnectorError("WECHAT_MEDIA_KEY_INVALID", "微信附件加密密钥无效");
  }
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptWechatMedia(ciphertext: Buffer, key: Buffer): Buffer {
  if (key.byteLength !== 16) {
    throw new LocalWechatConnectorError("WECHAT_MEDIA_KEY_INVALID", "微信附件解密密钥无效");
  }
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function wireFileName(value: string): string {
  const basename = value.split(/[\\/]/u).pop() ?? "";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, 200);
  return cleaned || "attachment.bin";
}

function contentTypeForFilename(filename: string): string {
  const extension = filename.toLowerCase().match(/\.[a-z0-9]{1,10}$/u)?.[0];
  return ({
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizedId(value: unknown): string {
  if (typeof value !== "string") {
    throw new LocalWechatConnectorError("WECHAT_INPUT_INVALID", "ID 无效");
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) {
    throw new LocalWechatConnectorError("WECHAT_INPUT_INVALID", "ID 无效");
  }
  return normalized;
}

function scalarId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length <= 512) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function updatesTimeout(value: unknown): number {
  const suggested = finiteNumber(value);
  if (suggested === undefined || suggested <= 0) return defaultUpdatesRequestTimeoutMs;
  return Math.max(10_000, Math.min(65_000, Math.floor(suggested) + 5_000));
}

function backoffDelay(failures: number): number {
  return Math.min(30_000, 1_000 * (2 ** Math.min(5, Math.max(0, failures - 1))));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  if (first.aborted || second.aborted) return AbortSignal.abort();
  return AbortSignal.any([first, second]);
}

function cloneSession(input: ImGatewayBindingSession): ImGatewayBindingSession {
  return {
    ...input,
    ...(input.connection ? { connection: { ...input.connection } } : {}),
  };
}
