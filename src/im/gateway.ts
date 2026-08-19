import type {
  FeishuDomain,
  ImGatewayBindingSession,
  ImGatewayCapability,
  ImProvider,
} from "./types.js";
import { isFeishuDomain, isImProvider } from "./types.js";

export interface ImGateway {
  readonly configured: boolean;
  readonly detail?: string;
  readonly supportsAttachments?: boolean;

  /** Synchronous ingress gate used when a provider has no selected character route. */
  setInboundEnabled?(provider: ImProvider, enabled: boolean): void;

  getCapabilities?(): readonly ImGatewayCapability[];

  startBinding(provider: ImProvider, options?: { domain?: FeishuDomain }): Promise<ImGatewayBindingSession>;
  getBindingSession(id: string): Promise<ImGatewayBindingSession>;
  cancelBindingSession(id: string): Promise<ImGatewayBindingSession>;
  submitBindingVerification?(id: string, code: string): Promise<ImGatewayBindingSession>;
  disconnect(provider: ImProvider, connectionId: string): Promise<void>;
}

export class UnavailableImGateway implements ImGateway {
  readonly configured = false;
  readonly supportsAttachments = false;

  constructor(
    readonly detail = "未配置 YOURCHAR_IM_GATEWAY_URL",
  ) {}

  async startBinding(): Promise<never> {
    throw new ImGatewayError("IM_GATEWAY_UNAVAILABLE", this.detail);
  }

  async getBindingSession(): Promise<never> {
    throw new ImGatewayError("IM_GATEWAY_UNAVAILABLE", this.detail);
  }

  async cancelBindingSession(): Promise<never> {
    throw new ImGatewayError("IM_GATEWAY_UNAVAILABLE", this.detail);
  }

  async disconnect(): Promise<never> {
    throw new ImGatewayError("IM_GATEWAY_UNAVAILABLE", this.detail);
  }
}

export class HttpImGateway implements ImGateway {
  readonly configured = true;
  readonly supportsAttachments = false;
  readonly detail: string;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 15_000,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (token.trim().length < 16) {
      throw new ImGatewayError(
        "IM_GATEWAY_CONFIG_INVALID",
        "YOURCHAR_IM_GATEWAY_TOKEN must contain at least 16 characters",
      );
    }
    this.detail = gatewayDisplayUrl(this.baseUrl);
  }

  async startBinding(
    provider: ImProvider,
    options: { domain?: FeishuDomain } = {},
  ): Promise<ImGatewayBindingSession> {
    return this.request(`/v1/im/bindings/${encodeURIComponent(provider)}/qr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    });
  }

  async getBindingSession(id: string): Promise<ImGatewayBindingSession> {
    return this.request(`/v1/im/binding-sessions/${encodeURIComponent(id)}`);
  }

  async cancelBindingSession(id: string): Promise<ImGatewayBindingSession> {
    return this.request(`/v1/im/binding-sessions/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  }

  async submitBindingVerification(id: string, code: string): Promise<ImGatewayBindingSession> {
    return this.request(`/v1/im/binding-sessions/${encodeURIComponent(id)}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
  }

  async disconnect(provider: ImProvider, connectionId: string): Promise<void> {
    await this.request(`/v1/im/bindings/${encodeURIComponent(provider)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<ImGatewayBindingSession> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch (error) {
      throw new ImGatewayError(
        "IM_GATEWAY_UNREACHABLE",
        `无法连接 IM gateway：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 2_000_000) {
      throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "IM gateway response is too large");
    }
    const responseText = await readBoundedResponseText(response, 2_000_000);
    const body = responseText ? parseGatewayJson(responseText) : undefined;
    if (!response.ok) {
      throw new ImGatewayError(
        "IM_GATEWAY_RESPONSE_ERROR",
        `IM gateway 返回 ${response.status}`,
        response.status,
      );
    }
    if (init.method === "DELETE") {
      return {
        id: "disconnected",
        provider: providerFromPath(path),
        status: "cancelled",
      };
    }
    return parseGatewayBindingSession(body);
  }
}

export class ImGatewayError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus?: number,
  ) {
    super(message);
    this.name = "ImGatewayError";
  }
}

export function createImGatewayFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ImGateway {
  const baseUrl = environment.YOURCHAR_IM_GATEWAY_URL?.trim();
  if (!baseUrl) return new UnavailableImGateway();
  const token = environment.YOURCHAR_IM_GATEWAY_TOKEN?.trim();
  if (!token || token.length < 16) {
    return new UnavailableImGateway(
      "已配置 gateway URL，但 YOURCHAR_IM_GATEWAY_TOKEN 缺失或少于 16 个字符",
    );
  }
  return new HttpImGateway(baseUrl, token);
}

function parseGatewayBindingSession(value: unknown): ImGatewayBindingSession {
  const outer = record(value, "gateway response");
  const source = outer.session && typeof outer.session === "object" && !Array.isArray(outer.session)
    ? outer.session as Record<string, unknown>
    : outer;
  const id = boundedString(source.id, "session.id", 256);
  if (!isImProvider(source.provider)) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway response has an invalid provider");
  }
  const statuses = ["waiting_scan", "scanned", "connected", "expired", "cancelled", "failed"] as const;
  if (!statuses.includes(source.status as typeof statuses[number])) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway response has an invalid status");
  }
  const connectionRecord = source.connection === undefined
    ? undefined
    : record(source.connection, "session.connection");
  const domain = optionalFeishuDomain(source.domain, "session.domain");
  const connectionDomain = connectionRecord
    ? optionalFeishuDomain(connectionRecord.domain, "session.connection.domain")
    : undefined;
  const expiresAt = optionalTimestamp(source.expiresAt, "session.expiresAt");
  const createdAt = optionalTimestamp(source.createdAt, "session.createdAt");
  const updatedAt = optionalTimestamp(source.updatedAt, "session.updatedAt");
  const connectedAt = connectionRecord
    ? optionalTimestamp(connectionRecord.connectedAt, "session.connection.connectedAt")
    : undefined;
  const lastSeenAt = connectionRecord
    ? optionalTimestamp(connectionRecord.lastSeenAt, "session.connection.lastSeenAt")
    : undefined;
  const qrCodeUrl = optionalBoundedString(source.qrCodeUrl, "session.qrCodeUrl", 1_500_000);
  const message = optionalBoundedString(source.message, "session.message", 1_000);
  const displayName = connectionRecord
    ? optionalBoundedString(connectionRecord.displayName, "session.connection.displayName", 200)
    : undefined;
  const verificationRequired = source.verificationRequired === undefined
    ? undefined
    : source.verificationRequired === true;
  if (source.verificationRequired !== undefined && typeof source.verificationRequired !== "boolean") {
    throw new ImGatewayError(
      "IM_GATEWAY_INVALID_RESPONSE",
      "gateway response has an invalid verificationRequired flag",
    );
  }
  return {
    id,
    provider: source.provider,
    status: source.status as ImGatewayBindingSession["status"],
    ...(domain ? { domain } : {}),
    ...(qrCodeUrl ? { qrCodeUrl: validateQrCodeUrl(qrCodeUrl) } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(message ? { message } : {}),
    ...(verificationRequired !== undefined ? { verificationRequired } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(connectionRecord
      ? {
          connection: {
            id: boundedString(connectionRecord.id, "session.connection.id", 256),
            accountId: boundedString(connectionRecord.accountId, "session.connection.accountId", 256),
            ownerId: boundedString(connectionRecord.ownerId, "session.connection.ownerId", 256),
            ...(displayName ? { displayName } : {}),
            ...(connectionDomain ? { domain: connectionDomain } : {}),
            ...(connectedAt ? { connectedAt } : {}),
            ...(lastSeenAt ? { lastSeenAt } : {}),
          },
        }
      : {}),
  };
}

function validateQrCodeUrl(value: string): string {
  const dataUrl = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/u);
  if (dataUrl) {
    const payload = dataUrl[2];
    if (payload.length % 4 !== 0) {
      throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway QR image has invalid base64 padding");
    }
    const bytes = Buffer.from(payload, "base64");
    if (!bytes.length || bytes.toString("base64") !== payload || !matchesRasterSignature(dataUrl[1], bytes)) {
      throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway QR image data is invalid");
    }
    return value;
  }
  if (/^data:image\//u.test(value)) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway QR image has invalid base64 data");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway QR code URL is invalid");
  }
  if (parsed.protocol !== "https:") {
    throw new ImGatewayError(
      "IM_GATEWAY_INVALID_RESPONSE",
      "gateway QR code URL must use HTTPS or a raster image data URL",
    );
  }
  if (parsed.username || parsed.password) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "gateway QR code URL must not contain credentials");
  }
  return parsed.toString();
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ImGatewayError("IM_GATEWAY_CONFIG_INVALID", "YOURCHAR_IM_GATEWAY_URL must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ImGatewayError("IM_GATEWAY_CONFIG_INVALID", "IM gateway URL must use HTTP(S)");
  }
  if (parsed.username || parsed.password) {
    throw new ImGatewayError("IM_GATEWAY_CONFIG_INVALID", "IM gateway URL must not contain credentials");
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    throw new ImGatewayError(
      "IM_GATEWAY_CONFIG_INVALID",
      "plain HTTP is only allowed for a loopback IM gateway; remote gateways must use HTTPS",
    );
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/u, "");
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/gu, "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}

function gatewayDisplayUrl(value: string): string {
  const parsed = new URL(value);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString().replace(/\/$/u, "");
}

function providerFromPath(path: string): ImProvider {
  return path.includes("/wechat") ? "wechat" : "feishu";
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, field: string, maximum: number): string {
  const result = optionalBoundedString(value, field, maximum);
  if (!result) throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", `${field} is required`);
  return result;
}

function optionalBoundedString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", `${field} must be at most ${maximum} characters`);
  }
  const result = value.trim();
  if (!result) return undefined;
  if (result.length > maximum) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", `${field} must be at most ${maximum} characters`);
  }
  return result;
}

function matchesRasterSignature(kind: string, value: Buffer): boolean {
  if (kind === "png") {
    return value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (kind === "jpeg") {
    return value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  }
  return value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" &&
    value.subarray(8, 12).toString("ascii") === "WEBP";
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  const source = optionalBoundedString(value, field, 100);
  if (!source) return undefined;
  if (!Number.isFinite(Date.parse(source))) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", `${field} must be an ISO timestamp`);
  }
  return new Date(source).toISOString();
}

function optionalFeishuDomain(value: unknown, field: string): FeishuDomain | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isFeishuDomain(value)) {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", `${field} must be feishu or lark`);
  }
  return value;
}

function parseGatewayJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "IM gateway response must be valid JSON");
  }
}

async function readBoundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let result = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ImGatewayError("IM_GATEWAY_INVALID_RESPONSE", "IM gateway response is too large");
    }
    result += decoder.decode(chunk.value, { stream: true });
  }
  return result + decoder.decode();
}
