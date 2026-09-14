import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  LspError,
  lspOperations,
  type LspLocation,
  type LspOperation,
  type LspPosition,
  type LspProvider,
  type LspProviderDefinition,
  type LspProviderLocation,
  type LspProviderResult,
  type LspQueryRequest,
  type LspQueryResult,
  type LspRange,
} from "./types.js";

const providerIdPattern = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const extensionPattern = /^\.[a-z0-9][a-z0-9+_-]{0,31}$/u;
const virtualWorkspacePath = "/workspace";
const virtualWorkspaceUri = "file:///workspace" as const;
const maximumLspInteger = 2_147_483_647;

export const lspLimits = Object.freeze({
  providers: 16,
  extensionsPerProvider: 32,
  pathCharacters: 500,
  documentBytes: 2 * 1024 * 1024,
  locations: 100,
  hoverCharacters: 16_000,
  queryTimeoutMs: 15_000,
});

export type WorkspaceLspServiceOptions = Readonly<{
  queryTimeoutMs?: number;
  maximumLocations?: number;
  maximumHoverCharacters?: number;
}>;

type NormalizedOptions = Readonly<{
  queryTimeoutMs: number;
  maximumLocations: number;
  maximumHoverCharacters: number;
}>;

/**
 * Owner-scoped semantic navigation service. Paths are resolved and read by the
 * host before a provider receives a bounded snapshot; provider URIs are then
 * constrained back to the same virtual Workspace root.
 */
export class WorkspaceLspService {
  private readonly workspaceDir: string;
  private readonly options: NormalizedOptions;
  private readonly providers = new Map<string, LspProvider>();
  private readonly providerByExtension = new Map<string, LspProvider>();
  private readonly activeQueries = new Set<AbortController>();
  private disposed = false;

  constructor(workspaceDir: string, options: WorkspaceLspServiceOptions = {}) {
    const resolved = resolve(workspaceDir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP Workspace must be an existing directory");
    }
    this.workspaceDir = realpathSync(resolved);
    this.options = normalizeOptions(options);
  }

  static async mount(
    workspaceDir: string,
    definitions: readonly LspProviderDefinition[],
    options: WorkspaceLspServiceOptions = {},
  ): Promise<WorkspaceLspService> {
    if (!Array.isArray(definitions) || definitions.length > lspLimits.providers) {
      throw new LspError(
        "LSP_INVALID_PROVIDER",
        `LSP provider definitions must contain at most ${lspLimits.providers} entries`,
      );
    }
    const normalized = definitions.map(normalizeDefinition);
    validateDefinitionConflicts(normalized);
    const service = new WorkspaceLspService(workspaceDir, options);
    try {
      for (const definition of normalized) {
        const provider = await definition.mount(Object.freeze({
          workspaceDir: service.workspaceDir,
          workspaceUri: virtualWorkspaceUri,
          readOnly: true,
        }));
        try {
          service.registerProvider(provider, definition);
        } catch (error) {
          await Promise.resolve(provider?.close?.()).catch(() => undefined);
          throw error;
        }
      }
      return service;
    } catch (error) {
      await service.dispose().catch(() => undefined);
      throw error;
    }
  }

  listProviders(): readonly Readonly<{ id: string; extensions: readonly string[] }>[] {
    return Object.freeze([...this.providers.values()].map((provider) => Object.freeze({
      id: provider.id,
      extensions: Object.freeze([...provider.extensions]),
    })));
  }

  async query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult> {
    if (this.disposed) throw new LspError("LSP_DISPOSED", "LSP service is disposed");
    const normalized = normalizeRequest(request);
    const document = this.readDocument(normalized.path);
    assertPosition(document.text, normalized.position);
    const provider = this.providerByExtension.get(document.extension);
    if (!provider) {
      throw new LspError(
        "LSP_UNAVAILABLE",
        `no LSP provider is registered for ${document.extension || "extensionless files"}`,
      );
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort("caller");
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort("caller");
    const timeout = setTimeout(() => controller.abort("timeout"), this.options.queryTimeoutMs);
    this.activeQueries.add(controller);
    try {
      const providerPromise = Promise.resolve(provider.query(Object.freeze({
        operation: normalized.operation,
        document,
        position: normalized.position,
      }), controller.signal));
      // Some third-party providers cannot cancel an underlying server request.
      // Race locally while still attaching a rejection handler to their work.
      const result = await Promise.race([
        providerPromise,
        aborted(controller.signal),
      ]);
      return this.normalizeResult(provider.id, { ...normalized, path: document.path }, result);
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason === "timeout") {
          throw new LspError(
            "LSP_TIMEOUT",
            `LSP query exceeded ${this.options.queryTimeoutMs} ms`,
          );
        }
        if (reason === "dispose") {
          throw new LspError("LSP_DISPOSED", "LSP service was disposed during the query");
        }
        throw new LspError("LSP_CANCELLED", "LSP query was cancelled");
      }
      if (error instanceof LspError) throw error;
      throw new LspError("LSP_PROVIDER_FAILED", "LSP provider query failed", error);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      this.activeQueries.delete(controller);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.activeQueries) controller.abort("dispose");
    const failures: unknown[] = [];
    for (const provider of [...this.providers.values()].reverse()) {
      try {
        await Promise.resolve(provider.close?.());
      } catch (error) {
        failures.push(error);
      }
    }
    this.providers.clear();
    this.providerByExtension.clear();
    if (failures.length) throw new AggregateError(failures, "one or more LSP providers failed to close");
  }

  private registerProvider(
    provider: LspProvider,
    definition: LspProviderDefinition,
  ): void {
    if (!provider || typeof provider !== "object") {
      throw new LspError("LSP_INVALID_PROVIDER", `LSP provider ${definition.id} did not mount`);
    }
    const normalized = normalizeProviderShell(provider);
    if (
      normalized.id !== definition.id ||
      normalized.extensions.length !== definition.extensions.length ||
      normalized.extensions.some((extension, index) => extension !== definition.extensions[index])
    ) {
      throw new LspError(
        "LSP_INVALID_PROVIDER",
        `mounted LSP provider ${definition.id} does not match its declared identity`,
      );
    }
    if (this.providers.has(normalized.id)) {
      throw new LspError("LSP_CONFLICT", `duplicate LSP provider id: ${normalized.id}`);
    }
    for (const extension of normalized.extensions) {
      const owner = this.providerByExtension.get(extension);
      if (owner) {
        throw new LspError(
          "LSP_CONFLICT",
          `LSP extension ${extension} is already owned by ${owner.id}`,
        );
      }
    }
    this.providers.set(normalized.id, normalized);
    for (const extension of normalized.extensions) {
      this.providerByExtension.set(extension, normalized);
    }
  }

  private readDocument(pathInput: string) {
    const requested = resolve(this.workspaceDir, pathInput);
    if (!isWithin(this.workspaceDir, requested) || !existsSync(requested)) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP path must name an existing Workspace file");
    }
    const actual = realpathSync(requested);
    if (!isWithin(this.workspaceDir, actual)) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP path escapes the owning Workspace");
    }
    const stats = statSync(actual);
    if (!stats.isFile()) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP path must name a regular file");
    }
    if (stats.size > lspLimits.documentBytes) {
      throw new LspError(
        "LSP_INVALID_REQUEST",
        `LSP documents must not exceed ${lspLimits.documentBytes} bytes`,
      );
    }
    const bytes = readFileSync(actual);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP documents must be valid UTF-8 text", error);
    }
    if (text.includes("\0")) {
      throw new LspError("LSP_INVALID_REQUEST", "LSP documents must not contain NUL bytes");
    }
    const canonicalPath = toPosix(relative(this.workspaceDir, actual));
    return Object.freeze({
      path: canonicalPath,
      uri: `${virtualWorkspaceUri}/${encodeWorkspacePath(canonicalPath)}`,
      extension: extname(canonicalPath).toLowerCase(),
      text,
    });
  }

  private normalizeResult(
    providerId: string,
    request: LspQueryRequest,
    result: LspProviderResult,
  ): LspQueryResult {
    if (!result || typeof result !== "object") {
      throw malformed("LSP provider returned a non-object result");
    }
    if (request.operation === "hover") {
      if (result.kind === "empty") {
        return Object.freeze({
          kind: "hover",
          providerId,
          path: request.path,
          contents: "",
          truncated: false,
        });
      }
      if (result.kind !== "hover" || typeof result.contents !== "string") {
        throw malformed("hover query returned an incompatible result");
      }
      const bounded = boundCharacters(result.contents, this.options.maximumHoverCharacters);
      const range = result.range === undefined ? undefined : normalizeRange(result.range);
      return Object.freeze({
        kind: "hover",
        providerId,
        path: request.path,
        contents: bounded.value,
        ...(range ? { range } : {}),
        truncated: result.truncated === true || bounded.truncated,
      });
    }
    if (result.kind === "empty") {
      return Object.freeze({
        kind: "locations",
        providerId,
        locations: Object.freeze([]),
        truncated: false,
      });
    }
    if (result.kind !== "locations" || !Array.isArray(result.locations)) {
      throw malformed("navigation query returned an incompatible result");
    }
    const selected = result.locations.slice(0, this.options.maximumLocations + 1);
    const normalized = selected.map((location) => this.normalizeLocation(location));
    const unique = new Map(normalized.map((location) => [
      `${location.path}:${location.range.start.line}:${location.range.start.character}:` +
        `${location.range.end.line}:${location.range.end.character}`,
      location,
    ]));
    const locations = [...unique.values()];
    return Object.freeze({
      kind: "locations",
      providerId,
      locations: Object.freeze(locations.slice(0, this.options.maximumLocations)),
      truncated:
        result.truncated === true ||
        result.locations.length > selected.length ||
        locations.length > this.options.maximumLocations,
    });
  }

  private normalizeLocation(input: LspProviderLocation): LspLocation {
    if (!input || typeof input !== "object" || typeof input.uri !== "string") {
      throw malformed("LSP location is malformed");
    }
    const path = workspacePathFromUri(input.uri, this.workspaceDir);
    return Object.freeze({ path, range: normalizeRange(input.range) });
  }
}

function normalizeDefinition(input: LspProviderDefinition): LspProviderDefinition {
  if (!input || typeof input !== "object" || typeof input.mount !== "function") {
    throw new LspError("LSP_INVALID_PROVIDER", "LSP provider definition is invalid");
  }
  const shell = normalizeProviderIdentity(input.id, input.extensions);
  return Object.freeze({ ...shell, mount: input.mount });
}

function validateDefinitionConflicts(definitions: readonly LspProviderDefinition[]): void {
  const ids = new Set<string>();
  const extensions = new Map<string, string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) {
      throw new LspError("LSP_CONFLICT", `duplicate LSP provider id: ${definition.id}`);
    }
    ids.add(definition.id);
    for (const extension of definition.extensions) {
      const owner = extensions.get(extension);
      if (owner) {
        throw new LspError(
          "LSP_CONFLICT",
          `LSP extension ${extension} is already owned by ${owner}`,
        );
      }
      extensions.set(extension, definition.id);
    }
  }
}

function normalizeProviderShell(input: LspProvider): LspProvider {
  if (typeof input.query !== "function" || (input.close !== undefined && typeof input.close !== "function")) {
    throw new LspError("LSP_INVALID_PROVIDER", "LSP provider must implement query and optional close");
  }
  const shell = normalizeProviderIdentity(input.id, input.extensions);
  return Object.freeze({
    ...shell,
    query: input.query.bind(input),
    ...(input.close ? { close: input.close.bind(input) } : {}),
  });
}

function normalizeProviderIdentity(idInput: string, extensionsInput: readonly string[]) {
  const id = typeof idInput === "string" ? idInput.trim() : "";
  if (!providerIdPattern.test(id) || id !== idInput) {
    throw new LspError("LSP_INVALID_PROVIDER", `invalid LSP provider id: ${String(idInput)}`);
  }
  if (
    !Array.isArray(extensionsInput) ||
    extensionsInput.length < 1 ||
    extensionsInput.length > lspLimits.extensionsPerProvider
  ) {
    throw new LspError(
      "LSP_INVALID_PROVIDER",
      `LSP provider ${id} must declare 1-${lspLimits.extensionsPerProvider} extensions`,
    );
  }
  const extensions = extensionsInput.map((extension) =>
    typeof extension === "string" ? extension.toLowerCase() : ""
  );
  if (
    new Set(extensions).size !== extensions.length ||
    extensions.some((extension, index) =>
      extension !== extensionsInput[index] || !extensionPattern.test(extension)
    )
  ) {
    throw new LspError(
      "LSP_INVALID_PROVIDER",
      `LSP provider ${id} extensions must be unique normalized lowercase values`,
    );
  }
  return Object.freeze({ id, extensions: Object.freeze(extensions) });
}

function normalizeRequest(input: LspQueryRequest): LspQueryRequest {
  if (!input || typeof input !== "object") {
    throw new LspError("LSP_INVALID_REQUEST", "LSP query must be an object");
  }
  if (!lspOperations.includes(input.operation as LspOperation)) {
    throw new LspError(
      "LSP_UNSUPPORTED_OPERATION",
      `unsupported LSP operation: ${String(input.operation)}`,
    );
  }
  const path = typeof input.path === "string" ? input.path.trim() : "";
  if (
    !path ||
    path !== input.path ||
    [...path].length > lspLimits.pathCharacters ||
    path.includes("\0") ||
    isAbsolute(path)
  ) {
    throw new LspError("LSP_INVALID_REQUEST", "LSP path must be a bounded Workspace-relative path");
  }
  const position = normalizePosition(input.position);
  return Object.freeze({ operation: input.operation, path, position });
}

function normalizePosition(input: LspPosition): LspPosition {
  if (
    !input ||
    typeof input !== "object" ||
    !Number.isSafeInteger(input.line) ||
    !Number.isSafeInteger(input.character) ||
    input.line < 0 ||
    input.character < 0 ||
    input.line > maximumLspInteger ||
    input.character > maximumLspInteger
  ) {
    throw new LspError("LSP_INVALID_REQUEST", "LSP position must contain non-negative safe integers");
  }
  return Object.freeze({ line: input.line, character: input.character });
}

function normalizeRange(input: LspRange): LspRange {
  if (!input || typeof input !== "object") throw malformed("LSP range is malformed");
  const start = normalizeResponsePosition(input.start);
  const end = normalizeResponsePosition(input.end);
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    throw malformed("LSP range end precedes its start");
  }
  return Object.freeze({ start, end });
}

function normalizeResponsePosition(input: LspPosition): LspPosition {
  if (
    !input ||
    typeof input !== "object" ||
    !Number.isSafeInteger(input.line) ||
    !Number.isSafeInteger(input.character) ||
    input.line < 0 ||
    input.character < 0 ||
    input.line > maximumLspInteger ||
    input.character > maximumLspInteger
  ) {
    throw malformed("LSP response position is malformed");
  }
  return Object.freeze({ line: input.line, character: input.character });
}

function assertPosition(text: string, position: LspPosition): void {
  const lines = text.split("\n");
  if (position.line >= lines.length) {
    throw new LspError("LSP_INVALID_REQUEST", "LSP line is outside the selected document");
  }
  const line = lines[position.line]!.replace(/\r$/u, "");
  if (position.character > line.length) {
    throw new LspError("LSP_INVALID_REQUEST", "LSP character is outside the selected line");
  }
}

function workspacePathFromUri(uri: string, actualWorkspaceDir: string): string {
  let path: string;
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "file:" || (parsed.hostname && parsed.hostname !== "localhost")) {
      throw new Error("not a local file URI");
    }
    path = fileURLToPath(parsed);
  } catch (error) {
    throw malformed("LSP locations must use local file URIs", error);
  }
  const roots = [virtualWorkspacePath, actualWorkspaceDir];
  for (const root of roots) {
    const candidate = resolve(path);
    if (!isWithin(root, candidate)) continue;
    const output = toPosix(relative(root, candidate));
    if (!output || [...output].length > lspLimits.pathCharacters) {
      throw malformed("LSP location path is outside output bounds");
    }
    return output;
  }
  throw malformed("LSP location escapes the owning Workspace");
}

function encodeWorkspacePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function boundCharacters(value: string, maximum: number) {
  const characters = [...value];
  return characters.length <= maximum
    ? { value, truncated: false }
    : { value: characters.slice(0, maximum).join(""), truncated: true };
}

function normalizeOptions(input: WorkspaceLspServiceOptions): NormalizedOptions {
  return Object.freeze({
    queryTimeoutMs: boundedInteger(
      input.queryTimeoutMs ?? lspLimits.queryTimeoutMs,
      "queryTimeoutMs",
      100,
      120_000,
    ),
    maximumLocations: boundedInteger(
      input.maximumLocations ?? lspLimits.locations,
      "maximumLocations",
      1,
      1_000,
    ),
    maximumHoverCharacters: boundedInteger(
      input.maximumHoverCharacters ?? lspLimits.hoverCharacters,
      "maximumHoverCharacters",
      1,
      100_000,
    ),
  });
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new LspError(
      "LSP_INVALID_REQUEST",
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function malformed(message: string, cause?: unknown): LspError {
  return new LspError("LSP_MALFORMED_RESPONSE", message, cause);
}

function isWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}
