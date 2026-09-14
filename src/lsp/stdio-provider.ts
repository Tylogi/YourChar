import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, posix } from "node:path";
import { bubblewrapPath } from "../pi/sandboxed-shell-tool.js";
import {
  LspError,
  type LspDocumentSnapshot,
  type LspProvider,
  type LspProviderDefinition,
  type LspProviderLocation,
  type LspProviderQuery,
  type LspProviderResult,
  type LspProviderScope,
  type LspRange,
} from "./types.js";

const defaultRequestTimeoutMs = 10_000;
const defaultMaximumMessageBytes = 4 * 1024 * 1024;
const maximumStderrBytes = 8 * 1024;
const maximumInitializationCharacters = 64_000;
const maximumWireLocations = 1_001;
const maximumHoverParts = 256;
const maximumHoverDepth = 8;
const bindTargetPattern = /^\/opt\/lsp\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type StdioLspReadOnlyBind = Readonly<{
  /** Deployment-reviewed host file or directory. */
  source: string;
  /** One direct child below /opt/lsp inside the sandbox. */
  target: string;
}>;

export type StdioLspProviderOptions = Readonly<{
  id: string;
  extensions: readonly string[];
  /** Absolute executable path as seen inside the sandbox. */
  command: string;
  /** Arguments use sandbox paths, never host Workspace paths. */
  args?: readonly string[];
  /** Explicit reviewed runtime/server mounts; no host directory is inherited. */
  readOnlyBinds?: readonly StdioLspReadOnlyBind[];
  languageIds?: Readonly<Record<string, string>>;
  initializationOptions?: unknown;
  requestTimeoutMs?: number;
  maximumMessageBytes?: number;
}>;

type NormalizedStdioOptions = Readonly<{
  id: string;
  extensions: readonly string[];
  command: string;
  args: readonly string[];
  readOnlyBinds: readonly StdioLspReadOnlyBind[];
  languageIds: Readonly<Record<string, string>>;
  initializationOptions?: unknown;
  requestTimeoutMs: number;
  maximumMessageBytes: number;
}>;

type JsonRpcId = number | string;
type JsonRpcMessage = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};

type DocumentState = {
  digest: string;
  version: number;
};

/** Build a provider whose process is created lazily inside each mounted scope. */
export function createStdioLspProviderDefinition(
  input: StdioLspProviderOptions,
): LspProviderDefinition {
  const options = normalizeOptions(input);
  return Object.freeze({
    id: options.id,
    extensions: options.extensions,
    mount(scope) {
      return new StdioLspProvider(scope, options);
    },
  });
}

/**
 * Small LSP 3.x JSON-RPC client. It exposes only the four read-only operations
 * in LspProviderQuery and never gives the server network or host filesystem
 * access beyond explicitly reviewed read-only binds and the owning Workspace.
 */
class StdioLspProvider implements LspProvider {
  readonly id: string;
  readonly extensions: readonly string[];
  private readonly scope: LspProviderScope;
  private readonly options: NormalizedStdioOptions;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly documents = new Map<string, DocumentState>();
  private child?: ChildProcessWithoutNullStreams;
  private processClosed?: Promise<void>;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private stdout = Buffer.alloc(0);
  private stderrBytes = 0;
  private requestSequence = 0;
  private initialized = false;
  private disposed = false;
  private failed = false;

  constructor(scope: LspProviderScope, options: NormalizedStdioOptions) {
    this.scope = scope;
    this.options = options;
    this.id = options.id;
    this.extensions = options.extensions;
  }

  async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspProviderResult> {
    if (this.disposed) throw new LspError("LSP_DISPOSED", `LSP provider ${this.id} is disposed`);
    if (!this.extensions.includes(request.document.extension)) {
      throw new LspError(
        "LSP_UNSUPPORTED_OPERATION",
        `LSP provider ${this.id} does not own ${request.document.extension}`,
      );
    }
    await waitFor(this.start(), signal);
    await this.syncDocument(request.document, signal);
    const textDocument = { uri: request.document.uri };
    const position = request.position;
    let raw: unknown;
    switch (request.operation) {
      case "goToDefinition":
        raw = await this.sendRequest("textDocument/definition", { textDocument, position }, signal);
        return locationsResult(raw);
      case "findReferences":
        raw = await this.sendRequest("textDocument/references", {
          textDocument,
          position,
          context: { includeDeclaration: true },
        }, signal);
        return locationsResult(raw);
      case "goToImplementation":
        raw = await this.sendRequest("textDocument/implementation", { textDocument, position }, signal);
        return locationsResult(raw);
      case "hover":
        raw = await this.sendRequest("textDocument/hover", { textDocument, position }, signal);
        return hoverResult(raw);
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.disposed = true;
    this.closePromise = this.closeProcess();
    return this.closePromise;
  }

  private async start(): Promise<void> {
    if (this.initialized) return;
    if (this.failed) throw new LspError("LSP_PROVIDER_FAILED", `LSP provider ${this.id} is unavailable`);
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } catch (error) {
      this.failed = true;
      this.terminate();
      if (error instanceof LspError) throw error;
      throw new LspError("LSP_PROVIDER_FAILED", `LSP provider ${this.id} failed to start`, error);
    }
  }

  private async startProcess(): Promise<void> {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bubblewrapPath, sandboxArguments(this.scope, this.options), {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {},
      });
    } catch (error) {
      throw new LspError("LSP_PROVIDER_FAILED", `LSP provider ${this.id} could not spawn`, error);
    }
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes = Math.min(maximumStderrBytes, this.stderrBytes + chunk.length);
    });
    child.once("error", (error) => this.failProcess(error));
    this.processClosed = new Promise((resolve) => {
      child.once("close", () => {
        this.failProcess(new Error("language server exited"));
        resolve();
      });
    });

    const result = await this.sendRequest("initialize", {
      processId: null,
      clientInfo: { name: "YourChar", version: "0.1" },
      rootPath: null,
      rootUri: this.scope.workspaceUri,
      workspaceFolders: [{ uri: this.scope.workspaceUri, name: "workspace" }],
      capabilities: {
        workspace: { configuration: false, workspaceFolders: true },
        textDocument: {
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          references: {},
          synchronization: { didSave: false, dynamicRegistration: false },
        },
      },
      ...(this.options.initializationOptions === undefined
        ? {}
        : { initializationOptions: this.options.initializationOptions }),
    });
    if (!result || typeof result !== "object") {
      throw new LspError("LSP_MALFORMED_RESPONSE", `LSP provider ${this.id} returned invalid initialize data`);
    }
    await this.sendNotification("initialized", {});
    this.initialized = true;
  }

  private async syncDocument(document: LspDocumentSnapshot, signal?: AbortSignal): Promise<void> {
    const digest = createHash("sha256").update(document.text).digest("hex");
    const existing = this.documents.get(document.uri);
    if (existing?.digest === digest) return;
    const languageId = this.options.languageIds[document.extension] ?? document.extension.slice(1);
    if (!existing) {
      this.documents.set(document.uri, { digest, version: 1 });
      await this.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: document.uri,
          languageId,
          version: 1,
          text: document.text,
        },
      }, signal);
      return;
    }
    const version = existing.version + 1;
    this.documents.set(document.uri, { digest, version });
    await this.sendNotification("textDocument/didChange", {
      textDocument: { uri: document.uri, version },
      contentChanges: [{ text: document.text }],
    }, signal);
  }

  private async sendRequest(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child || this.failed) {
      throw new LspError("LSP_PROVIDER_FAILED", `LSP provider ${this.id} process is unavailable`);
    }
    if (signal?.aborted) throw new LspError("LSP_CANCELLED", "LSP request was cancelled");
    this.requestSequence += 1;
    const id = this.requestSequence;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const expired = this.takePending(id);
        if (!expired) return;
        const error = new LspError(
          "LSP_TIMEOUT",
          `LSP provider request exceeded ${this.options.requestTimeoutMs} ms`,
        );
        expired.reject(error);
        // A language server that cannot answer within its hard deadline must
        // not keep consuming resources after the owning query has returned.
        this.failProcess(error);
      }, this.options.requestTimeoutMs);
      const pending: PendingRequest = { resolve, reject, timeout, ...(signal ? { signal } : {}) };
      if (signal) {
        pending.abort = () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timeout);
          void this.sendNotification("$/cancelRequest", { id }).catch(() => undefined);
          reject(new LspError("LSP_CANCELLED", "LSP provider request was cancelled"));
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }
      this.pending.set(id, pending);
    });
    try {
      await this.writeMessage({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      this.rejectPending(id, error);
    }
    return response;
  }

  private async sendNotification(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) throw new LspError("LSP_CANCELLED", "LSP notification was cancelled");
    await this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || child.stdin.destroyed || this.failed) {
      throw new LspError("LSP_PROVIDER_FAILED", `LSP provider ${this.id} input is unavailable`);
    }
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length > this.options.maximumMessageBytes) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP JSON-RPC request exceeds the message bound");
    }
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
      body,
    ]);
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.failed) return;
    this.stdout = Buffer.concat([this.stdout, chunk]);
    if (this.stdout.length > this.options.maximumMessageBytes * 2) {
      this.failProcess(new Error("language server output exceeded framing bound"));
      return;
    }
    while (this.stdout.length) {
      const headerEnd = this.stdout.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.stdout.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/iu.exec(header);
      if (!match) {
        this.failProcess(new Error("language server response omitted Content-Length"));
        return;
      }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.options.maximumMessageBytes) {
        this.failProcess(new Error("language server response length is invalid"));
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.stdout.length < bodyStart + length) return;
      const body = this.stdout.subarray(bodyStart, bodyStart + length);
      this.stdout = this.stdout.subarray(bodyStart + length);
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch (error) {
        this.failProcess(error);
        return;
      }
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        this.failProcess(new Error("language server response is not an object"));
        return;
      }
      this.routeMessage(message as JsonRpcMessage);
    }
  }

  private routeMessage(message: JsonRpcMessage): void {
    if (typeof message.method === "string") {
      if (message.id !== undefined && (typeof message.id === "number" || typeof message.id === "string")) {
        void this.answerServerRequest(message.id, message.method, message.params);
      }
      return;
    }
    const id = message.id;
    if (typeof id !== "number" && typeof id !== "string") return;
    const pending = this.takePending(id);
    if (!pending) return;
    if (message.error !== undefined) {
      pending.reject(new LspError("LSP_PROVIDER_FAILED", `LSP provider ${this.id} rejected a request`));
      return;
    }
    pending.resolve(message.result);
  }

  private async answerServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items = params && typeof params === "object" && Array.isArray((params as { items?: unknown }).items)
        ? (params as { items: unknown[] }).items
        : [];
      result = items.map(() => null);
    }
    try {
      await this.writeMessage({ jsonrpc: "2.0", id, result });
    } catch {
      // Process failure rejects the owning client request through failProcess.
    }
  }

  private takePending(id: JsonRpcId): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abort) {
      pending.signal.removeEventListener("abort", pending.abort);
    }
    return pending;
  }

  private rejectPending(id: JsonRpcId, error: unknown): void {
    this.takePending(id)?.reject(error);
  }

  private failProcess(cause: unknown): void {
    if (this.failed) return;
    this.failed = true;
    const error = new LspError(
      "LSP_PROVIDER_FAILED",
      `LSP provider ${this.id} process failed`,
      cause,
    );
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
    this.terminate();
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.initialized && !this.failed) {
      try {
        await Promise.race([
          this.sendRequest("shutdown", null),
          new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown timeout")), 500)),
        ]);
        await this.sendNotification("exit", {});
      } catch {
        // Forced process-group termination below is the lifecycle backstop.
      }
    }
    this.terminate();
    if (this.processClosed) await waitAtMost(this.processClosed, 1_000);
    for (const id of [...this.pending.keys()]) {
      this.rejectPending(id, new LspError("LSP_DISPOSED", `LSP provider ${this.id} closed`));
    }
  }

  private terminate(): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // An already-exited process needs no further cleanup.
      }
    }
  }
}

function sandboxArguments(
  scope: LspProviderScope,
  options: NormalizedStdioOptions,
): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
    "--dir", "/opt",
    "--dir", "/opt/lsp",
  ];
  for (const bind of options.readOnlyBinds) {
    args.push("--ro-bind", bind.source, bind.target);
  }
  args.push(
    "--ro-bind", realpathSync(scope.workspaceDir), "/workspace",
    "--chdir", "/workspace",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin:/opt/lsp",
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "LANG", "C.UTF-8",
    "--",
    options.command,
    ...options.args,
  );
  return args;
}

function locationsResult(input: unknown): LspProviderResult {
  if (input === null || input === undefined) return Object.freeze({ kind: "empty" });
  const entries = Array.isArray(input) ? input : [input];
  const locations = entries.slice(0, maximumWireLocations).map(normalizeWireLocation);
  return Object.freeze({
    kind: "locations",
    locations: Object.freeze(locations),
    ...(entries.length > locations.length ? { truncated: true } : {}),
  });
}

function normalizeWireLocation(input: unknown): LspProviderLocation {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw malformed("LSP location response is malformed");
  }
  const value = input as Record<string, unknown>;
  const uri = typeof value.uri === "string"
    ? value.uri
    : typeof value.targetUri === "string"
      ? value.targetUri
      : undefined;
  const range = value.range ?? value.targetSelectionRange ?? value.targetRange;
  if (!uri) throw malformed("LSP location response omitted its URI");
  return Object.freeze({ uri, range: normalizeWireRange(range) });
}

function hoverResult(input: unknown): LspProviderResult {
  if (input === null || input === undefined) return Object.freeze({ kind: "empty" });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw malformed("LSP hover response is malformed");
  }
  const value = input as Record<string, unknown>;
  const contents = normalizeHoverContents(value.contents, 0);
  const range = value.range === undefined ? undefined : normalizeWireRange(value.range);
  return Object.freeze({
    kind: "hover",
    contents,
    ...(range ? { range } : {}),
  });
}

function normalizeHoverContents(input: unknown, depth: number): string {
  if (depth > maximumHoverDepth) throw malformed("LSP hover contents are nested too deeply");
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    if (input.length > maximumHoverParts) throw malformed("LSP hover contents contain too many parts");
    return input.map((entry) => normalizeHoverContents(entry, depth + 1)).join("\n\n");
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const value = input as Record<string, unknown>;
    if (typeof value.value === "string") {
      return typeof value.language === "string"
        ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
        : value.value;
    }
  }
  throw malformed("LSP hover contents are malformed");
}

function normalizeWireRange(input: unknown): LspRange {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw malformed("LSP range response is malformed");
  }
  const value = input as Record<string, unknown>;
  return Object.freeze({
    start: normalizeWirePosition(value.start),
    end: normalizeWirePosition(value.end),
  });
}

function normalizeWirePosition(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw malformed("LSP position response is malformed");
  }
  const value = input as Record<string, unknown>;
  if (
    !Number.isSafeInteger(value.line) ||
    !Number.isSafeInteger(value.character) ||
    Number(value.line) < 0 ||
    Number(value.character) < 0
  ) {
    throw malformed("LSP position response must contain non-negative safe integers");
  }
  return Object.freeze({ line: Number(value.line), character: Number(value.character) });
}

function normalizeOptions(input: StdioLspProviderOptions): NormalizedStdioOptions {
  if (!input || typeof input !== "object") {
    throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP options must be an object");
  }
  if (!Array.isArray(input.extensions)) {
    throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP extensions must be an array");
  }
  const extensions = [...input.extensions];
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (
    command !== input.command ||
    !posix.isAbsolute(command) ||
    !["/usr/", "/bin/", "/opt/lsp/"].some((root) => command.startsWith(root)) ||
    [...command].length > 500 ||
    command.includes("\0")
  ) {
    throw new LspError(
      "LSP_INVALID_PROVIDER",
      "stdio LSP command must be a bounded absolute sandbox path below /usr, /bin, or /opt/lsp",
    );
  }
  if (!Array.isArray(input.args ?? [])) {
    throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP arguments must be an array");
  }
  const args = input.args === undefined ? [] : [...input.args];
  if (
    args.length > 64 ||
    args.some((value) => typeof value !== "string" || [...value].length > 4_096 || value.includes("\0"))
  ) {
    throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP arguments exceed their bounds");
  }
  const binds = normalizeBinds(input.readOnlyBinds ?? []);
  const languageIds: Record<string, string> = {};
  if (
    input.languageIds !== undefined &&
    (!input.languageIds || typeof input.languageIds !== "object" || Array.isArray(input.languageIds))
  ) {
    throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP languageIds must be an object");
  }
  for (const [extension, languageId] of Object.entries(input.languageIds ?? {})) {
    if (
      extension !== extension.toLowerCase() ||
      !extensions.includes(extension) ||
      typeof languageId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(languageId)
    ) {
      throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP languageIds are invalid");
    }
    languageIds[extension] = languageId;
  }
  const initializationOptions = cloneInitializationOptions(input.initializationOptions);
  return Object.freeze({
    id: input.id,
    extensions: Object.freeze(extensions),
    command,
    args: Object.freeze(args),
    readOnlyBinds: binds,
    languageIds: Object.freeze(languageIds),
    ...(initializationOptions === undefined ? {} : { initializationOptions }),
    requestTimeoutMs: boundedInteger(
      input.requestTimeoutMs ?? defaultRequestTimeoutMs,
      "requestTimeoutMs",
      100,
      120_000,
    ),
    maximumMessageBytes: boundedInteger(
      input.maximumMessageBytes ?? defaultMaximumMessageBytes,
      "maximumMessageBytes",
      64 * 1024,
      16 * 1024 * 1024,
    ),
  });
}

function normalizeBinds(input: readonly StdioLspReadOnlyBind[]): readonly StdioLspReadOnlyBind[] {
  if (!Array.isArray(input) || input.length > 16) {
    throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP read-only binds exceed 16 entries");
  }
  const targets = new Set<string>();
  return Object.freeze(input.map((bind) => {
    if (!bind || typeof bind !== "object" || !bindTargetPattern.test(bind.target)) {
      throw new LspError(
        "LSP_INVALID_PROVIDER",
        "stdio LSP bind targets must be direct children below /opt/lsp",
      );
    }
    if (targets.has(bind.target)) {
      throw new LspError("LSP_INVALID_PROVIDER", `duplicate stdio LSP bind target: ${bind.target}`);
    }
    targets.add(bind.target);
    if (typeof bind.source !== "string" || !isAbsolute(bind.source) || !existsSync(bind.source)) {
      throw new LspError("LSP_INVALID_PROVIDER", "stdio LSP bind source must be an existing absolute path");
    }
    return Object.freeze({ source: realpathSync(bind.source), target: bind.target });
  }));
}

function cloneInitializationOptions(input: unknown): unknown {
  if (input === undefined) return undefined;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch (error) {
    throw new LspError("LSP_INVALID_PROVIDER", "LSP initializationOptions must be JSON-safe", error);
  }
  if (serialized === undefined || [...serialized].length > maximumInitializationCharacters) {
    throw new LspError("LSP_INVALID_PROVIDER", "LSP initializationOptions exceed their bound");
  }
  return JSON.parse(serialized) as unknown;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LspError(
      "LSP_INVALID_PROVIDER",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new LspError("LSP_CANCELLED", "LSP query was cancelled"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new LspError("LSP_CANCELLED", "LSP query was cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

async function waitAtMost(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function malformed(message: string): LspError {
  return new LspError("LSP_MALFORMED_RESPONSE", message);
}
