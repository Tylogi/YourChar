import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type {
  DocumentConversion,
  DocumentReadInput,
  DocumentReadResult,
} from "./types.js";

const bubblewrapPath = "/usr/bin/bwrap";
const defaultTimeoutMs = 90_000;
const maximumInputBytes = 20 * 1024 * 1024;
const maximumWorkerOutputBytes = 18 * 1024 * 1024;
const maximumWorkerErrorBytes = 32 * 1024;
const maximumCacheBytes = 32 * 1024 * 1024;
const maximumConvertedMarkdownBytes = 8 * 1024 * 1024;
const defaultLineLimit = 300;
const maximumLineLimit = 1_000;
const maximumChunkCharacters = 64 * 1024;
const maximumNormalizedLineCharacters = 8 * 1024;
const maximumConcurrentConversions = 2;
const tmpfsMagic = 0x01021994;

const supportedExtensions = new Set([
  ".csv",
  ".docx",
  ".htm",
  ".html",
  ".json",
  ".md",
  ".pdf",
  ".pptx",
  ".txt",
  ".xlsx",
  ".xml",
  ".yaml",
  ".yml",
]);

type OfficeParserWorkerResponse = {
  version: 1;
  engine: "officeparser";
  title?: string | null;
  markdown: string;
};

export type OfficeParserRunner = (
  input: { absolutePath: string; extension: string; bytes: Buffer },
  signal?: AbortSignal,
) => Promise<OfficeParserWorkerResponse>;

export type DocumentConversionServiceOptions = {
  runner?: OfficeParserRunner;
  timeoutMs?: number;
};

export type DocumentWorkspaceContext = {
  workspaceFiles: WorkspaceFileService;
  cacheNamespace: string;
};

export class DocumentConversionService {
  private readonly workerPath = fileURLToPath(new URL("./officeparser.js", import.meta.url));
  private readonly nodeModulesDir = join(process.cwd(), "node_modules");
  private readonly runner: OfficeParserRunner;
  private readonly customRunner: boolean;
  private readonly cache = new Map<string, DocumentConversion>();
  private cachedBytes = 0;
  private activeConversions = 0;

  constructor(options: DocumentConversionServiceOptions = {}) {
    this.customRunner = options.runner !== undefined;
    this.runner = options.runner ?? ((input, signal) => runOfficeParserWorker(
      this.workerPath,
      this.nodeModulesDir,
      input,
      options.timeoutMs ?? defaultTimeoutMs,
      signal,
    ));
  }

  isAvailable(): boolean {
    if (this.customRunner) return true;
    return existsSync(bubblewrapPath) &&
      existsSync(this.workerPath) &&
      existsSync(join(this.nodeModulesDir, "officeparser", "package.json"));
  }

  async read(
    input: DocumentReadInput,
    workspace: DocumentWorkspaceContext,
    signal?: AbortSignal,
  ): Promise<DocumentReadResult> {
    const source = workspace.workspaceFiles.asset(input.path, "attachment");
    const extension = extname(source.entry.name).toLowerCase();
    const sourceBytes = readRegularSource(source.absolutePath);
    assertSupportedSource(extension, sourceBytes);
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
      let response: OfficeParserWorkerResponse;
      try {
        response = await this.runner({
          absolutePath: source.absolutePath,
          extension,
          bytes: sourceBytes,
        }, signal);
      } finally {
        this.activeConversions -= 1;
      }
      assertWorkerResponse(response);
      const markdown = normalizeMarkdown(response.markdown);
      if (!markdown.trim()) {
        throw new DocumentConversionError(
          "DOCUMENT_OCR_REQUIRED",
          extension === ".pdf"
            ? "officeparser found no readable text in this PDF; it may be scanned and require OCR"
            : "officeparser returned no readable document text",
        );
      }
      conversion = {
        engine: "officeparser",
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

function assertSupportedSource(extension: string, bytes: Buffer): void {
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

function assertWorkerResponse(value: OfficeParserWorkerResponse): void {
  if (
    !value || typeof value !== "object" || value.version !== 1 ||
    value.engine !== "officeparser" || typeof value.markdown !== "string" ||
    (value.title !== undefined && value.title !== null && typeof value.title !== "string")
  ) {
    throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "officeparser returned an invalid response");
  }
  if (Buffer.byteLength(value.markdown, "utf8") > maximumConvertedMarkdownBytes) {
    throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "converted Markdown exceeds the 8 MiB limit");
  }
}

async function runOfficeParserWorker(
  workerPath: string,
  nodeModulesDir: string,
  input: { absolutePath: string; extension: string; bytes: Buffer },
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OfficeParserWorkerResponse> {
  if (signal?.aborted) {
    throw new DocumentConversionError("DOCUMENT_CONVERSION_ABORTED", "document conversion was cancelled");
  }
  if (!existsSync(bubblewrapPath)) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", "Bubblewrap is required for officeparser");
  }
  const resolvedWorkerPath = safeRealFile(workerPath, "officeparser worker");
  const resolvedNodeModulesDir = safeRealDirectory(nodeModulesDir, "Node.js dependency directory");
  const resolvedPackagePath = safeRealFile(
    join(resolvedNodeModulesDir, "..", "package.json"),
    "package manifest",
  );
  const resolvedNodePath = safeRealFile(process.execPath, "Node.js executable");
  if (!existsSync(join(resolvedNodeModulesDir, "officeparser", "package.json"))) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", "officeparser is not installed; run npm ci");
  }
  const snapshot = createTmpfsSnapshot(input.extension, input.bytes);
  const sourcePath = snapshot.path;
  const sandboxSource = `/input/document${input.extension}`;
  const sandboxRoot = "/opt/yourchar-document";
  const sandboxNodePath = `${sandboxRoot}/node`;
  const sandboxWorkerPath = `${sandboxRoot}/officeparser.js`;
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
    "--dir", "/input",
    "--dir", "/opt",
    "--dir", sandboxRoot,
    "--ro-bind", resolvedNodePath, sandboxNodePath,
    "--ro-bind", resolvedWorkerPath, sandboxWorkerPath,
    "--ro-bind", resolvedPackagePath, `${sandboxRoot}/package.json`,
    "--ro-bind", resolvedNodeModulesDir, `${sandboxRoot}/node_modules`,
    "--ro-bind", sourcePath, sandboxSource,
    "--chdir", "/tmp",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "NODE_ENV", "production",
    "--",
    "/usr/bin/prlimit",
    "--as=2147483648",
    "--cpu=90",
    "--core=0",
    "--nofile=128",
    "--",
    sandboxNodePath,
    sandboxWorkerPath,
    sandboxSource,
  ];
  let child;
  try {
    child = spawn(bubblewrapPath, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
  } catch (error) {
    rmSync(snapshot.dir, { recursive: true, force: true });
    throw error;
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let overflow = false;
  let timedOut = false;
  let aborted = false;
  const terminate = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    if (stdoutBytes + chunk.length > maximumWorkerOutputBytes) {
      overflow = true;
      terminate();
      return;
    }
    stdout.push(chunk);
    stdoutBytes += chunk.length;
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const remaining = maximumWorkerErrorBytes - stderrBytes;
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
  try {
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", resolveExit);
    });
    if (timedOut) {
      throw new DocumentConversionError("DOCUMENT_CONVERSION_TIMEOUT", "officeparser conversion timed out");
    }
    if (aborted) {
      throw new DocumentConversionError("DOCUMENT_CONVERSION_ABORTED", "document conversion was cancelled");
    }
    if (overflow) {
      throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "officeparser output exceeded the safe limit");
    }
    if (exitCode !== 0) {
      const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1000);
      throw new DocumentConversionError(
        "DOCUMENT_CONVERSION_FAILED",
        `officeparser could not convert ${basename(input.absolutePath)}${detail ? `: ${detail}` : ""}`,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch {
      throw new DocumentConversionError("DOCUMENT_OUTPUT_INVALID", "officeparser returned malformed JSON");
    }
    assertWorkerResponse(value as OfficeParserWorkerResponse);
    return value as OfficeParserWorkerResponse;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    rmSync(snapshot.dir, { recursive: true, force: true });
  }
}

function readRegularSource(path: string): Buffer {
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

function createTmpfsSnapshot(extension: string, bytes: Buffer): { dir: string; path: string } {
  let fileSystemType: bigint;
  try {
    fileSystemType = statfsSync("/dev/shm", { bigint: true }).type;
  } catch {
    throw new DocumentConversionError(
      "DOCUMENT_RUNTIME_UNAVAILABLE",
      "a private /dev/shm tmpfs is required for document conversion",
    );
  }
  if (fileSystemType !== BigInt(tmpfsMagic)) {
    throw new DocumentConversionError(
      "DOCUMENT_RUNTIME_UNAVAILABLE",
      "document conversion refuses to stage input outside tmpfs",
    );
  }
  const dir = mkdtempSync("/dev/shm/yourchar-document-");
  chmodSync(dir, 0o700);
  const path = join(dir, `document${extension}`);
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    return { dir, path };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function safeRealDirectory(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", `${label} is missing`);
  }
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", `${label} is not a directory`);
  }
  return real;
}

function safeRealFile(path: string, label: string): string {
  if (!existsSync(path)) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", `${label} is missing`);
  }
  const real = realpathSync(path);
  if (!statSync(real).isFile()) {
    throw new DocumentConversionError("DOCUMENT_RUNTIME_UNAVAILABLE", `${label} is not a file`);
  }
  return real;
}
