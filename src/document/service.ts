import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createMemoryDirectory } from "../execution/memory-directory.js";
import { offlineWorkerAvailable, spawnOfflineWorker } from "../execution/offline-worker.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type {
  DocumentConversion,
  DocumentReadInput,
  DocumentReadResult,
} from "./types.js";

const defaultTimeoutMs = 90_000;
const maximumConversionOutputBytes = 18 * 1024 * 1024;
const maximumConversionErrorBytes = 32 * 1024;
const maximumCacheBytes = 32 * 1024 * 1024;
const maximumConvertedMarkdownBytes = 8 * 1024 * 1024;
const defaultLineLimit = 300;
const maximumLineLimit = 1_000;
const maximumChunkCharacters = 64 * 1024;
const maximumNormalizedLineCharacters = 8 * 1024;
const maximumConcurrentConversions = 2;

const supportedExtensions = new Set([
  ".csv",
  ".docx",
  ".pdf",
  ".pptx",
  ".xls",
  ".xlsx",
]);

type DocumentConversionResponse = {
  version: 1;
  engine: "anydoc";
  title?: string | null;
  markdown: string;
};

export type DocumentRunner = (
  input: { absolutePath: string; extension: string; bytes: Buffer },
  signal?: AbortSignal,
) => Promise<DocumentConversionResponse>;

export type DocumentConversionServiceOptions = {
  runner?: DocumentRunner;
  timeoutMs?: number;
};

export type DocumentWorkspaceContext = {
  workspaceFiles: WorkspaceFileService;
  cacheNamespace: string;
};

export class DocumentConversionService {
  private readonly runner: DocumentRunner;
  private readonly customRunner: boolean;
  private readonly cache = new Map<string, DocumentConversion>();
  private cachedBytes = 0;
  private activeConversions = 0;

  constructor(options: DocumentConversionServiceOptions = {}) {
    this.customRunner = options.runner !== undefined;
    this.runner = options.runner ?? ((input, signal) => convertInSandbox(
      input,
      options.timeoutMs ?? defaultTimeoutMs,
      signal,
    ));
  }

  isAvailable(): boolean {
    if (this.customRunner) return true;
    try {
      return offlineWorkerAvailable() &&
        existsSync(fileURLToPath(import.meta.resolve("@firecrawl/anydoc")));
    } catch {
      return false;
    }
  }

  async read(
    input: DocumentReadInput,
    workspace: DocumentWorkspaceContext,
    signal?: AbortSignal,
  ): Promise<DocumentReadResult> {
    const source = workspace.workspaceFiles.asset(input.path, "attachment");
    const extension = extname(source.entry.name).toLowerCase();
    const sourceBytes = readRegularSource(source.absolutePath, workspace.workspaceFiles.maximumUploadBytes);
    assertSupportedSource(extension, sourceBytes, workspace.workspaceFiles.maximumUploadBytes);
    const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
    const cacheKey = createHash("sha256").update(JSON.stringify({
      version: 1,
      cacheNamespace: workspace.cacheNamespace,
      extension,
      sourceSha256,
    })).digest("hex");
    let conversion = this.cache.get(cacheKey);
    if (conversion) {
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, conversion);
      conversion = { ...conversion, cached: true };
    } else {
      if (this.activeConversions >= maximumConcurrentConversions) {
        throw new DocumentConversionError(
          "DOCUMENT_CONVERSION_BUSY",
          `at most ${maximumConcurrentConversions} documents can be converted concurrently`,
        );
      }
      this.activeConversions += 1;
      let response: DocumentConversionResponse;
      try {
        response = await this.runner({
          absolutePath: source.absolutePath,
          extension,
          bytes: sourceBytes,
        }, signal);
      } finally {
        this.activeConversions -= 1;
      }
      assertConversionResponse(response);
      const markdown = normalizeMarkdown(response.markdown);
      if (!markdown.trim()) {
        throw new DocumentConversionError(
          "DOCUMENT_OCR_REQUIRED",
          extension === ".pdf"
            ? "AnyDoc found no readable text in this PDF; it may be scanned and require OCR"
            : "The document contains no readable text",
        );
      }
      conversion = {
        engine: "anydoc",
        ...(response.title
          ? { title: response.title.trim().replace(/\s+/gu, " ").slice(0, 500) }
          : {}),
        markdown,
        sourceSha256,
        cached: false,
      };
      this.remember(cacheKey, conversion);
    }

    return documentChunk(source.entry.path, conversion, input.offset, input.limit);
  }

  clearCache(): void {
    this.cache.clear();
    this.cachedBytes = 0;
  }

  private remember(key: string, conversion: DocumentConversion): void {
    const bytes = Buffer.byteLength(conversion.markdown, "utf8");
    if (bytes > maximumCacheBytes) return;
    while (this.cachedBytes + bytes > maximumCacheBytes && this.cache.size) {
      const oldest = this.cache.entries().next().value as [string, DocumentConversion] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cachedBytes -= Buffer.byteLength(oldest[1].markdown, "utf8");
    }
    this.cache.set(key, conversion);
    this.cachedBytes += bytes;
  }
}

export class DocumentConversionError extends Error {
  constructor(
    readonly code:
      | "DOCUMENT_FORMAT_UNSUPPORTED"
      | "DOCUMENT_FILE_TOO_LARGE"
      | "DOCUMENT_SIGNATURE_INVALID"
      | "DOCUMENT_RUNTIME_UNAVAILABLE"
      | "DOCUMENT_CONVERSION_FAILED"
      | "DOCUMENT_CONVERSION_TIMEOUT"
      | "DOCUMENT_CONVERSION_ABORTED"
      | "DOCUMENT_CONVERSION_BUSY"
      | "DOCUMENT_OUTPUT_INVALID"
      | "DOCUMENT_OCR_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "DocumentConversionError";
  }
}

function assertSupportedSource(extension: string, bytes: Buffer, maximumInputBytes: number): void {
  if (!supportedExtensions.has(extension)) {
    throw new DocumentConversionError(
      "DOCUMENT_FORMAT_UNSUPPORTED",
      `read_document does not support ${extension || "files without an extension"}`,
    );
  }
  if (bytes.length < 1 || bytes.length > maximumInputBytes) {
    throw new DocumentConversionError(
      "DOCUMENT_FILE_TOO_LARGE",
      `documents must be between 1 byte and ${maximumInputBytes / 1024 / 1024} MiB`,
    );
  }
  const signature = bytes.subarray(0, 8);
  if (extension === ".pdf" && signature.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new DocumentConversionError("DOCUMENT_SIGNATURE_INVALID", "the PDF signature is invalid");
  }
  if ([".docx", ".pptx", ".xlsx"].includes(extension) && !isZipSignature(signature)) {
    throw new DocumentConversionError("DOCUMENT_SIGNATURE_INVALID", "the Office document signature is invalid");
  }
  if (extension === ".xls" && !signature.equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw new DocumentConversionError("DOCUMENT_SIGNATURE_INVALID", "the legacy Excel signature is invalid");
  }
}

function isZipSignature(signature: Buffer): boolean {
  if (signature.length < 4 || signature[0] !== 0x50 || signature[1] !== 0x4b) return false;
  return (signature[2] === 0x03 && signature[3] === 0x04) ||
    (signature[2] === 0x05 && signature[3] === 0x06) ||
    (signature[2] === 0x07 && signature[3] === 0x08);
}

function normalizeMarkdown(markdown: string): string {
  return markdown
    .replaceAll("\u0000", "")
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .flatMap((line) => line.length > maximumNormalizedLineCharacters
      ? Array.from(
          { length: Math.ceil(line.length / maximumNormalizedLineCharacters) },
          (_, index) => line.slice(
            index * maximumNormalizedLineCharacters,
            (index + 1) * maximumNormalizedLineCharacters,
          ),
        )
      : [line])
    .join("\n")
    .trimEnd();
}

function documentChunk(
  path: string,
  conversion: DocumentConversion,
  requestedOffset?: number,
  requestedLimit?: number,
): DocumentReadResult {
  const lines = conversion.markdown.split("\n");
  const offset = integerInRange(requestedOffset ?? 1, 1, Math.max(1, lines.length), "offset");
  const limit = integerInRange(requestedLimit ?? defaultLineLimit, 1, maximumLineLimit, "limit");
  const selected: string[] = [];
  let characters = 0;
  for (const line of lines.slice(offset - 1, offset - 1 + limit)) {
    const numbered = `${offset + selected.length}: ${line}`;
    if (selected.length && characters + numbered.length + 1 > maximumChunkCharacters) break;
    selected.push(numbered);
    characters += numbered.length + 1;
  }
  const nextOffset = offset - 1 + selected.length < lines.length
    ? offset + selected.length
    : undefined;
  return {
    path,
    engine: conversion.engine,
    ...(conversion.title ? { title: conversion.title } : {}),
    sourceSha256: conversion.sourceSha256,
    offset,
    lines: selected.length,
    totalLines: lines.length,
    ...(nextOffset ? { nextOffset } : {}),
    cached: conversion.cached,
    markdown: selected.join("\n"),
  };
}

function integerInRange(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DocumentConversionError(
      "DOCUMENT_OUTPUT_INVALID",
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function assertConversionResponse(value: DocumentConversionResponse): void {
  if (
    !value || typeof value !== "object" || value.version !== 1 ||
    value.engine !== "anydoc" || typeof value.markdown !== "string" ||
    (value.title !== undefined && value.title !== null && typeof value.title !== "string")
  ) {
    throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "Document conversion returned an invalid response");
  }
  if (Buffer.byteLength(value.markdown, "utf8") > maximumConvertedMarkdownBytes) {
    throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "converted Markdown exceeds the 8 MiB limit");
  }
}

async function convertInSandbox(
  input: { absolutePath: string; extension: string; bytes: Buffer },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<DocumentConversionResponse> {
  if (signal?.aborted) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_ABORTED", "document conversion was cancelled");
  }
  let snapshot: ReturnType<typeof createMemoryDirectory>;
  let sandbox: ReturnType<typeof spawnOfflineWorker>;
  try {
    snapshot = createMemoryDirectory("yourchar-document-");
  } catch (error) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", String(error));
  }
  try {
    const sourcePath = join(snapshot.path, `document${input.extension}`);
    writeFileSync(sourcePath, input.bytes, { flag: "wx", mode: 0o600 });
    const nodeModules = dirname(dirname(dirname(fileURLToPath(import.meta.resolve("@firecrawl/anydoc")))));
    const limits = "set -e; ulimit -c 0; ulimit -t 90; ulimit -n 128; " +
      (process.platform === "linux" ? "ulimit -v 4194304; " : "");
    sandbox = spawnOfflineWorker({
      command: "/opt/document/sh",
      // JITless keeps V8's virtual reservations within the Linux address-space cap.
      args: ["-c", `${limits}exec "$@"`, "read_document", "/opt/document/node",
        "--jitless", "--max-old-space-size=256", "/opt/document/src/document/service.js", `/input/document${input.extension}`],
      binds: [
        { source: realpathSync("/bin/sh"), target: "/opt/document/sh" },
        { source: realpathSync(process.execPath), target: "/opt/document/node" },
        { source: dirname(dirname(fileURLToPath(import.meta.url))), target: "/opt/document/src" },
        { source: join(dirname(nodeModules), "package.json"), target: "/opt/document/package.json" },
        { source: nodeModules, target: "/opt/document/node_modules" },
        { source: sourcePath, target: `/input/document${input.extension}` },
      ],
    });
  } catch (error) {
    snapshot.dispose();
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", String(error));
  }
  const child = sandbox.child;
  child.stdin.end();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let timedOut = false;
  let aborted = false;
  const terminate = sandbox.terminate;
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes + chunk.length > maximumConversionOutputBytes) {
      overflow = true;
      terminate();
      return;
    }
    stdout.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = maximumConversionErrorBytes - stderrBytes;
    if (remaining <= 0) return;
    const selected = chunk.subarray(0, remaining);
    stderr.push(selected);
    stderrBytes += selected.length;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const abort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    if (timedOut) {
      throw new DocumentConversionError("DOCUMENT_CONVERSION_TIMEOUT", "Document conversion timed out");
    }
    if (aborted) {
      throw new DocumentConversionError("DOCUMENT_CONVERSION_ABORTED", "document conversion was cancelled");
    }
    if (overflow) {
      throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "Document conversion output exceeded the safe limit");
    }
    if (exitCode !== 0) {
      let detail = Buffer.concat(stderr).toString("utf8").trim();
      let code: DocumentConversionError["code"] = "DOCUMENT_CONVERSION_FAILED";
      try {
        const failure = JSON.parse(detail.split("\n").at(-1) ?? "");
        if (failure.code === "needsOcr") code = "DOCUMENT_OCR_REQUIRED";
        if (failure.code === "outputLimit") code = "DOCUMENT_OUTPUT_INVALID";
        if (typeof failure.message === "string") detail = failure.message;
      } catch { /* Startup failures may not have a structured conversion error. */ }
      throw new DocumentConversionError(
        code,
        `Could not convert ${basename(input.absolutePath)}${detail ? `: ${detail.slice(0, 1000)}` : ""}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch {
      throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "Document conversion returned malformed JSON");
    }
    assertConversionResponse(value as DocumentConversionResponse);
    return value as DocumentConversionResponse;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    snapshot.dispose();
  }
}

function readRegularSource(path: string, maximumInputBytes: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new DocumentConversionError("DOCUMENT_FORMAT_UNSUPPORTED", "document path must be a regular file");
    }
    if (stats.size < 1 || stats.size > maximumInputBytes) {
      throw new DocumentConversionError(
        "DOCUMENT_FILE_TOO_LARGE",
        `documents must be between 1 byte and ${maximumInputBytes / 1024 / 1024} MiB`,
      );
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function convertDocument(path: string): Promise<DocumentConversionResponse> {
  const extension = extname(path).toLowerCase();
  const bytes = readFileSync(path);
  const { formatFromExtension, toMarkdownBytes } = await import("@firecrawl/anydoc");
  const markdown = await toMarkdownBytes(bytes, formatFromExtension(extension), { ocr: "reject" });
  if (Buffer.byteLength(markdown, "utf8") > maximumConvertedMarkdownBytes) {
    throw Object.assign(new Error("converted Markdown exceeds the 8 MiB limit"), { code: "outputLimit" });
  }
  return { version: 1, engine: "anydoc", markdown };
}

// The same implementation runs inside the existing sandbox; no separate entry program.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("read_document requires a document path");
    process.stdout.write(JSON.stringify(await convertDocument(process.argv[2])));
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({ code, message: message.slice(0, 1000) }) + "\n");
    process.exitCode = 1;
  }
}
