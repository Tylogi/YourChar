import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const maximumRequestBytes = 1024 * 1024;
const maximumCachedResponseBytes = 2 * 1024 * 1024;
const maximumCacheBytes = 16 * 1024 * 1024;
const maximumEntries = 512;
const entryLifetimeMs = 10 * 60 * 1_000;

const preparedJsonBodies = new WeakMap<IncomingMessage, unknown>();
const responseTransactions = new WeakMap<ServerResponse, ResponseTransaction>();

export type HeadlessIdempotencyErrorCode =
  | "HEADLESS_IDEMPOTENCY_KEY_INVALID"
  | "HEADLESS_IDEMPOTENCY_CONFLICT"
  | "HEADLESS_IDEMPOTENCY_UNSUPPORTED"
  | "HEADLESS_IDEMPOTENCY_BODY_TOO_LARGE";

export class HeadlessIdempotencyError extends Error {
  constructor(
    readonly code: HeadlessIdempotencyErrorCode,
    readonly status: 400 | 409 | 413 | 422,
    message: string,
  ) {
    super(message);
    this.name = "HeadlessIdempotencyError";
  }
}

type PendingEntry = {
  state: "pending";
  fingerprint: string;
  createdAt: number;
  completion: Promise<void>;
  resolve: () => void;
};

type CompletedEntry = {
  state: "completed";
  fingerprint: string;
  createdAt: number;
  statusCode: number;
  body: string;
  contentType?: string;
  bytes: number;
};

type Entry = PendingEntry | CompletedEntry;

type ResponseTransaction = {
  registry: HeadlessIdempotencyRegistry;
  key: string;
  entry: PendingEntry;
};

/**
 * Bounded, process-lifetime replay protection for authenticated JSON
 * mutations. Durable domain resources retain their own restart semantics; this
 * cache protects ordinary client retries while the serving process is alive.
 */
export class HeadlessIdempotencyRegistry {
  private readonly entries = new Map<string, Entry>();
  private cachedBytes = 0;

  async prepare(input: {
    request: IncomingMessage;
    response: ServerResponse;
    method: string;
    resource: string;
  }): Promise<boolean> {
    const key = idempotencyKey(input.request);
    if (key === undefined) return false;
    if (!isMutationMethod(input.method)) {
      throw new HeadlessIdempotencyError(
        "HEADLESS_IDEMPOTENCY_UNSUPPORTED",
        422,
        "Idempotency-Key is supported only for JSON mutations",
      );
    }
    if (input.resource.endsWith("/messages/stream")) {
      throw new HeadlessIdempotencyError(
        "HEADLESS_IDEMPOTENCY_UNSUPPORTED",
        422,
        "streaming turns cannot use the HTTP replay cache",
      );
    }
    if (!isJsonContentType(singleHeader(input.request, "content-type"))) {
      throw new HeadlessIdempotencyError(
        "HEADLESS_IDEMPOTENCY_UNSUPPORTED",
        422,
        "Idempotency-Key requires an application/json request",
      );
    }

    const bytes = await readBoundedBody(input.request);
    const json = parseJson(bytes);
    preparedJsonBodies.set(input.request, json);
    const fingerprint = createHash("sha256")
      .update(input.method)
      .update("\0")
      .update(input.resource)
      .update("\0")
      .update(bytes)
      .digest("hex");

    for (;;) {
      this.pruneExpired();
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          throw new HeadlessIdempotencyError(
            "HEADLESS_IDEMPOTENCY_CONFLICT",
            409,
            "the Idempotency-Key was already used for a different request",
          );
        }
        if (existing.state === "completed") {
          this.touch(key, existing);
          replay(input.response, existing);
          return true;
        }
        await existing.completion;
        continue;
      }

      const entry = pendingEntry(fingerprint);
      this.entries.set(key, entry);
      responseTransactions.set(input.response, { registry: this, key, entry });
      const release = () => this.releasePending(key, entry);
      input.response.once("close", release);
      input.response.once("finish", () => {
        if (input.response.statusCode === 204) {
          this.complete(key, entry, input.response.statusCode, "", undefined);
        } else {
          release();
        }
      });
      return false;
    }
  }

  recordJsonResponse(
    key: string,
    entry: PendingEntry,
    statusCode: number,
    body: string,
  ): void {
    this.complete(key, entry, statusCode, body, "application/json; charset=utf-8");
  }

  private complete(
    key: string,
    pending: PendingEntry,
    statusCode: number,
    body: string,
    contentType: string | undefined,
  ): void {
    if (this.entries.get(key) !== pending) return;
    const bytes = Buffer.byteLength(body);
    if (bytes > maximumCachedResponseBytes) {
      this.entries.delete(key);
      pending.resolve();
      return;
    }
    const completed: CompletedEntry = {
      state: "completed",
      fingerprint: pending.fingerprint,
      createdAt: Date.now(),
      statusCode,
      body,
      ...(contentType ? { contentType } : {}),
      bytes,
    };
    this.entries.set(key, completed);
    this.cachedBytes += bytes;
    pending.resolve();
    this.enforceBounds();
  }

  private releasePending(key: string, pending: PendingEntry): void {
    if (this.entries.get(key) !== pending) return;
    this.entries.delete(key);
    pending.resolve();
  }

  private pruneExpired(): void {
    const oldest = Date.now() - entryLifetimeMs;
    for (const [key, entry] of this.entries) {
      if (entry.state === "pending" || entry.createdAt >= oldest) continue;
      this.entries.delete(key);
      this.cachedBytes -= entry.bytes;
    }
  }

  private enforceBounds(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= maximumEntries && this.cachedBytes <= maximumCacheBytes) break;
      if (entry.state === "pending") continue;
      this.entries.delete(key);
      this.cachedBytes -= entry.bytes;
    }
  }

  private touch(key: string, entry: CompletedEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}

export function consumePreparedHeadlessJsonBody(
  request: IncomingMessage,
): { prepared: boolean; body?: unknown } {
  if (!preparedJsonBodies.has(request)) return { prepared: false };
  const body = preparedJsonBodies.get(request);
  preparedJsonBodies.delete(request);
  return { prepared: true, body };
}

export function recordHeadlessIdempotentJsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  const transaction = responseTransactions.get(response);
  if (!transaction) return;
  responseTransactions.delete(response);
  transaction.registry.recordJsonResponse(
    transaction.key,
    transaction.entry,
    statusCode,
    body,
  );
}

function pendingEntry(fingerprint: string): PendingEntry {
  let resolve = () => {};
  const completion = new Promise<void>((done) => {
    resolve = done;
  });
  return { state: "pending", fingerprint, createdAt: Date.now(), completion, resolve };
}

function replay(response: ServerResponse, entry: CompletedEntry): void {
  response.setHeader("idempotency-replayed", "true");
  const headers: Record<string, string> = { "cache-control": "no-store" };
  if (entry.contentType) headers["content-type"] = entry.contentType;
  response.writeHead(entry.statusCode, headers);
  response.end(entry.body);
}

async function readBoundedBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = Number(singleHeader(request, "content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumRequestBytes) {
    throw bodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumRequestBytes) throw bodyTooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(bytes: Buffer): unknown {
  const text = bytes.toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

function idempotencyKey(request: IncomingMessage): string | undefined {
  const values = request.headersDistinct["idempotency-key"];
  if (!values) return undefined;
  if (values.length !== 1) return invalidKey();
  const key = values[0];
  if (
    key !== key.trim() || key.length < 8 || key.length > 200 ||
    !/^[A-Za-z0-9._~:/+-]+$/u.test(key)
  ) return invalidKey();
  return key;
}

function invalidKey(): never {
  throw new HeadlessIdempotencyError(
    "HEADLESS_IDEMPOTENCY_KEY_INVALID",
    400,
    "Idempotency-Key must be one unambiguous 8-200 character token",
  );
}

function bodyTooLarge(): HeadlessIdempotencyError {
  return new HeadlessIdempotencyError(
    "HEADLESS_IDEMPOTENCY_BODY_TOO_LARGE",
    413,
    "idempotent JSON request body exceeds 1 MiB",
  );
}

function isMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const segments = value.split(";").map((entry) => entry.trim().toLowerCase());
  if (segments[0] !== "application/json") return false;
  if (segments.length === 1) return true;
  return segments.length === 2 && /^charset=(?:utf-8|"utf-8")$/u.test(segments[1]);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values = request.headersDistinct[name];
  return values?.length === 1 ? values[0].trim() : undefined;
}
