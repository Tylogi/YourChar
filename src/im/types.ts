export const imProviders = ["feishu", "wechat"] as const;

export type ImProvider = typeof imProviders[number];
export type FeishuDomain = "feishu" | "lark";

export type ImBindingStatus =
  | "waiting_scan"
  | "scanned"
  | "connected"
  | "expired"
  | "cancelled"
  | "failed";

export type ImConnection = {
  provider: ImProvider;
  gatewayConnectionId: string;
  bindingGeneration: string;
  accountId: string;
  ownerId: string;
  displayName?: string;
  domain?: FeishuDomain;
  connectedAt: string;
  updatedAt: string;
  lastSeenAt?: string;
};

export type ImBindingSession = {
  id: string;
  provider: ImProvider;
  status: ImBindingStatus;
  domain?: FeishuDomain;
  qrCodeUrl?: string;
  expiresAt?: string;
  message?: string;
  verificationRequired?: boolean;
  createdAt: string;
  updatedAt: string;
  connection?: ImConnection;
};

export type ImGatewayConnection = {
  id: string;
  accountId: string;
  ownerId: string;
  displayName?: string;
  domain?: FeishuDomain;
  connectedAt?: string;
  lastSeenAt?: string;
};

export type ImGatewayBindingSession = {
  id: string;
  provider: ImProvider;
  status: ImBindingStatus;
  domain?: FeishuDomain;
  qrCodeUrl?: string;
  expiresAt?: string;
  message?: string;
  verificationRequired?: boolean;
  createdAt?: string;
  updatedAt?: string;
  connection?: ImGatewayConnection;
};

export type ImChannelAvailability =
  | "available"
  | "gateway_required"
  | "connector_unavailable"
  | "unsupported";

export type ImConnectorKind =
  | "feishu_personal_agent"
  | "wechat_tencent_ilink"
  | "external";

export type ImGatewayCapability = {
  provider: ImProvider;
  connectorKind: ImConnectorKind;
  state: "ready" | "starting" | "unhealthy" | "unsupported";
  detail?: string;
  domains?: FeishuDomain[];
};

/**
 * A provider is deliberately routed to exactly one roleplay character. IM is a
 * normal-space transport: secret conversations are never a valid destination.
 */
export type ImCharacterRoute = {
  provider: ImProvider;
  characterId: string;
  createdAt: string;
  updatedAt: string;
};

export type ImChannelSummary = {
  provider: ImProvider;
  characterId?: string;
  label: string;
  description: string;
  status: "unbound" | "binding" | "connected" | "error";
  availability: ImChannelAvailability;
  connector?: Omit<ImGatewayCapability, "provider">;
  connection?: Omit<
    ImConnection,
    "accountId" | "ownerId" | "gatewayConnectionId" | "bindingGeneration"
  >;
};

export type ImChannelState = {
  gateway: {
    configured: boolean;
    detail?: string;
  };
  channels: ImChannelSummary[];
};

export type ImRuntimeSettings = {
  wechatTypingEnabled: boolean;
  wechatRemindersEnabled: boolean;
  feishuRemindersEnabled: boolean;
  updatedAt: string;
};

export type ImRuntimeSettingsPatch = Partial<Omit<ImRuntimeSettings, "updatedAt">>;

export type ImRuntimeSettingsResponse = ImRuntimeSettings & {
  supported: boolean;
  appliesTo: "new_wechat_messages";
};

export type ImAttachmentKind = "image" | "file";

/**
 * A platform attachment that has already been copied into the trusted
 * Workspace boundary. Platform URLs, download tokens, and encryption keys
 * must never be persisted here.
 */
export type ImAttachment = {
  kind: ImAttachmentKind;
  path: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
};

export type ImOutboundMessage = {
  text: string;
  attachments: ImAttachment[];
};

export type ImOutboxPartCallbacks = {
  hasDelivered(partId: string): boolean;
  recordDelivered(partId: string, platformMessageId: string): void;
};

export type ImInboundAttachmentInput = {
  provider: ImProvider;
  eventId: string;
  kind: ImAttachmentKind;
  name?: string;
  contentType?: string;
  declaredSize?: number;
  bytes: Buffer;
};

export type ImOutboundAttachmentContent = {
  bytes: Buffer;
  name: string;
  contentType: string;
};

export type ImInboundEventInput = {
  eventId: string;
  provider: ImProvider;
  connectionId: string;
  bindingGeneration?: string;
  externalChatId: string;
  externalUserId: string;
  chatType: "direct" | "group";
  text: string;
  attachments?: ImAttachment[];
  receivedAt?: string;
  timezone?: string;
};

export type ImInboundEventStatus = "processing" | "completed" | "failed";

export type ImInboundEvent = Omit<ImInboundEventInput, "text" | "timezone" | "attachments"> & {
  /** Character route captured atomically when this platform event was claimed. */
  characterId: string;
  payloadDigest: string;
  status: ImInboundEventStatus;
  attempts: number;
  replyText?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ImOutboxItemStatus = "pending" | "delivered" | "failed" | "abandoned";

export type ImInboundTarget = {
  provider: ImProvider;
  characterId: string;
  conversationSpace: "normal";
  connectionId: string;
  bindingGeneration: string;
  accountId: string;
  ownerId: string;
  externalChatId: string;
};

export type ImOutboxItem = {
  id: string;
  provider: ImProvider;
  connectionId: string;
  bindingGeneration: string;
  externalChatId: string;
  inboundEventId?: string;
  notificationOutboxId?: string;
  text: string;
  attachments: ImAttachment[];
  status: ImOutboxItemStatus;
  attempts: number;
  availableAt: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
};

export type ImInboundReceipt = {
  duplicate: boolean;
  eventId: string;
  status: "completed";
  delivery: ImOutboxItem;
};

export function isImProvider(value: unknown): value is ImProvider {
  return typeof value === "string" && (imProviders as readonly string[]).includes(value);
}

export function isFeishuDomain(value: unknown): value is FeishuDomain {
  return value === "feishu" || value === "lark";
}
