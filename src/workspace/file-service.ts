import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_WORKSPACE_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_DIRECTORY_ENTRIES = 1_000;

export type WorkspaceEntryKind = "directory" | "file" | "other";
export type WorkspacePreviewKind = "text" | "html" | "image" | "pdf" | "unsupported";

export type WorkspaceFileEntry = {
  name: string;
  path: string;
  kind: WorkspaceEntryKind;
  size: number;
  updatedAt: string;
  contentType?: string;
  previewKind?: WorkspacePreviewKind;
};

export type WorkspaceFilePreview = {
  entry: WorkspaceFileEntry;
  kind: WorkspacePreviewKind;
  content?: string;
  truncated?: boolean;
};

export type WorkspaceFileAsset = {
  absolutePath: string;
  entry: WorkspaceFileEntry;
  inline: boolean;
};

export type WorkspaceVisionImage = {
  path: string;
  name: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  bytes: Buffer;
};

export class WorkspaceFileError extends Error {
  constructor(
    readonly code:
      | "WORKSPACE_PATH_INVALID"
      | "WORKSPACE_NOT_FOUND"
      | "WORKSPACE_TYPE_INVALID"
      | "WORKSPACE_FILE_TOO_LARGE"
      | "WORKSPACE_CONFLICT"
      | "WORKSPACE_PREVIEW_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceFileError";
  }
}

export class WorkspaceFileService {
  readonly rootDir: string;

  constructor(workspaceDir: string) {
    this.rootDir = resolve(workspaceDir);
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    chmodSync(this.rootDir, 0o700);
  }

  list(inputPath = "."): { path: string; parent?: string; entries: WorkspaceFileEntry[] } {
    const directory = this.existingPath(inputPath);
    if (!lstatSync(directory).isDirectory()) {
      throw new WorkspaceFileError("WORKSPACE_TYPE_INVALID", "workspace list path must be a directory");
    }
    const currentPath = this.relativePath(directory);
    const entries = readdirSync(directory, { withFileTypes: true })
      .slice(0, MAX_DIRECTORY_ENTRIES)
      .map((entry) => this.entryFor(resolve(directory, entry.name), entry.name))
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : right.kind === "directory" ? 1 : 0;
        return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
      });
    return {
      path: currentPath,
      ...(currentPath === "." ? {} : { parent: parentPath(currentPath) }),
      entries,
    };
  }

  upload(input: { directory?: string; name: string; bytes: Buffer }): WorkspaceFileEntry {
    if (input.bytes.byteLength > MAX_WORKSPACE_UPLOAD_BYTES) {
      throw new WorkspaceFileError(
        "WORKSPACE_FILE_TOO_LARGE",
        `workspace uploads must not exceed ${MAX_WORKSPACE_UPLOAD_BYTES / 1024 / 1024} MiB`,
      );
    }
    const name = safeFileName(input.name);
    const directory = this.ensureDirectory(input.directory ?? "uploads");
    const destination = this.uniqueDestination(directory, name);
    writeFileSync(destination, input.bytes, { flag: "wx", mode: 0o600 });
    return this.entryFor(destination);
  }

  preview(inputPath: string): WorkspaceFilePreview {
    const path = this.regularFile(inputPath);
    const entry = this.entryFor(path);
    const kind = entry.previewKind ?? "unsupported";
    if (kind !== "text" && kind !== "html") return { entry, kind };
    if (kind === "html" && entry.size > MAX_TEXT_PREVIEW_BYTES) {
      return { entry, kind, truncated: true };
    }
    const length = Math.min(entry.size, MAX_TEXT_PREVIEW_BYTES + 1);
    const bytes = Buffer.alloc(length);
    const descriptor = openSync(path, "r");
    let bytesRead = 0;
    try {
      bytesRead = readSync(descriptor, bytes, 0, length, 0);
    } finally {
      closeSync(descriptor);
    }
    const content = bytes.subarray(0, Math.min(bytesRead, MAX_TEXT_PREVIEW_BYTES));
    if (content.includes(0)) return { entry, kind: "unsupported" };
    return {
      entry,
      kind,
      content: content.toString("utf8"),
      truncated: entry.size > MAX_TEXT_PREVIEW_BYTES,
    };
  }

  asset(inputPath: string, disposition: "inline" | "attachment"): WorkspaceFileAsset {
    const path = this.regularFile(inputPath);
    const entry = this.entryFor(path);
    const inline = disposition === "inline" &&
      (entry.previewKind === "image" || entry.previewKind === "pdf");
    if (disposition === "inline" && !inline) {
      throw new WorkspaceFileError("WORKSPACE_PREVIEW_UNSUPPORTED", "this file type does not support inline preview");
    }
    return { absolutePath: path, entry, inline };
  }

  visionImage(inputPath: string): WorkspaceVisionImage {
    const path = this.regularFile(inputPath);
    const workspacePath = this.relativePath(path);
    if (!workspacePath.startsWith("uploads/")) {
      throw new WorkspaceFileError(
        "WORKSPACE_PATH_INVALID",
        "vision can only read images stored under workspace/uploads",
      );
    }
    const stats = statSync(path);
    if (stats.size > MAX_WORKSPACE_UPLOAD_BYTES) {
      throw new WorkspaceFileError(
        "WORKSPACE_FILE_TOO_LARGE",
        `vision images must not exceed ${MAX_WORKSPACE_UPLOAD_BYTES / 1024 / 1024} MiB`,
      );
    }
    const bytes = readFileSync(path);
    const mimeType = rasterMimeType(bytes);
    if (!mimeType) {
      throw new WorkspaceFileError(
        "WORKSPACE_PREVIEW_UNSUPPORTED",
        "vision supports PNG, JPEG, GIF, and WebP images with valid file signatures",
      );
    }
    return { path: workspacePath, name: basename(path), mimeType, bytes };
  }

  move(fromPath: string, toPath: string): WorkspaceFileEntry {
    const source = this.existingPath(fromPath, false, true);
    const sourceRelative = this.relativePath(source);
    if (sourceRelative === ".") {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "the workspace root cannot be moved");
    }
    let destination = this.lexicalPath(toPath);
    if (existsSync(destination)) {
      const existing = this.existingPath(toPath);
      if (!lstatSync(existing).isDirectory()) {
        throw new WorkspaceFileError("WORKSPACE_CONFLICT", "the workspace destination already exists");
      }
      destination = resolve(existing, basename(source));
    }
    const destinationParent = this.existingPath(this.relativePath(dirname(destination)));
    if (!lstatSync(destinationParent).isDirectory()) {
      throw new WorkspaceFileError("WORKSPACE_TYPE_INVALID", "the workspace destination parent must be a directory");
    }
    if (existsSync(destination)) {
      throw new WorkspaceFileError("WORKSPACE_CONFLICT", "the workspace destination already exists");
    }
    const sourceStats = lstatSync(source);
    if (sourceStats.isDirectory() && isWithin(source, destination)) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "a directory cannot be moved inside itself");
    }
    renameSync(source, destination);
    return this.entryFor(destination);
  }

  delete(inputPath: string): { path: string; kind: WorkspaceEntryKind } {
    const path = this.existingPath(inputPath, false, true);
    const relativePath = this.relativePath(path);
    if (relativePath === ".") {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "the workspace root cannot be deleted");
    }
    const stats = lstatSync(path);
    const kind = entryKind(stats);
    rmSync(path, { recursive: stats.isDirectory(), force: false });
    return { path: relativePath, kind };
  }

  private ensureDirectory(inputPath: string): string {
    const path = this.lexicalPath(inputPath);
    const root = realpathSync(this.rootDir);
    let ancestor = path;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    if (!isWithin(root, realpathSync(ancestor))) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "workspace path escapes the dedicated workspace");
    }
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const resolved = realpathSync(path);
    if (!isWithin(root, resolved) || !lstatSync(resolved).isDirectory()) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "workspace path escapes the dedicated workspace");
    }
    return resolved;
  }

  private regularFile(inputPath: string): string {
    const path = this.existingPath(inputPath);
    if (!lstatSync(path).isFile()) {
      throw new WorkspaceFileError("WORKSPACE_TYPE_INVALID", "workspace path must be a regular file");
    }
    return path;
  }

  private existingPath(inputPath: string, allowRoot = true, allowSymlink = false): string {
    const requested = this.lexicalPath(inputPath);
    if (!existsSync(requested)) {
      throw new WorkspaceFileError("WORKSPACE_NOT_FOUND", `workspace path does not exist: ${inputPath}`);
    }
    const stats = lstatSync(requested);
    if (stats.isSymbolicLink()) {
      if (allowSymlink) return requested;
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "symbolic links are not available through workspace files");
    }
    const root = realpathSync(this.rootDir);
    const path = realpathSync(requested);
    if (!isWithin(root, path)) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "workspace path escapes the dedicated workspace");
    }
    if (!allowRoot && path === root) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "the workspace root is not a valid target");
    }
    return path;
  }

  private lexicalPath(inputPath: string): string {
    if (typeof inputPath !== "string" || !inputPath.trim()) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "workspace path is required");
    }
    if (inputPath.includes("\0") || inputPath.includes("\\") || isAbsolute(inputPath)) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "workspace paths must be relative");
    }
    const path = resolve(this.rootDir, inputPath);
    if (!isWithin(this.rootDir, path)) {
      throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "workspace path escapes the dedicated workspace");
    }
    return path;
  }

  private relativePath(path: string): string {
    return relative(realpathSync(this.rootDir), path).split(sep).join("/") || ".";
  }

  private entryFor(path: string, name = basename(path)): WorkspaceFileEntry {
    const stats = lstatSync(path);
    const kind = entryKind(stats);
    const contentType = kind === "file" ? contentTypeFor(name) : undefined;
    return {
      name,
      path: this.relativePath(path),
      kind,
      size: kind === "file" ? stats.size : 0,
      updatedAt: stats.mtime.toISOString(),
      ...(contentType ? { contentType, previewKind: previewKindFor(name, contentType, path) } : {}),
    };
  }

  private uniqueDestination(directory: string, name: string): string {
    const extension = extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let index = 1; index <= 10_000; index += 1) {
      const candidateName = index === 1 ? name : `${stem}-${index}${extension}`;
      const candidate = resolve(directory, candidateName);
      if (!existsSync(candidate)) return candidate;
    }
    throw new WorkspaceFileError("WORKSPACE_CONFLICT", "could not allocate a unique workspace filename");
  }
}

function safeFileName(input: string): string {
  const name = String(input ?? "").trim();
  if (
    !name || name === "." || name === ".." || name !== basename(name) ||
    /[\u0000-\u001f\u007f/\\]/u.test(name) || [...name].length > 160
  ) {
    throw new WorkspaceFileError("WORKSPACE_PATH_INVALID", "invalid workspace filename");
  }
  return name;
}

function entryKind(stats: Stats): WorkspaceEntryKind {
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function parentPath(path: string): string {
  const segments = path.split("/");
  segments.pop();
  return segments.join("/") || ".";
}

function isWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}

const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

const TEXT_EXTENSIONS = new Set([
  ".c", ".cc", ".conf", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".ini", ".java", ".js",
  ".jsx", ".log", ".mjs", ".py", ".rb", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".xml",
]);

function contentTypeFor(name: string): string {
  const extension = extname(name).toLowerCase();
  return MIME_TYPES[extension] ?? (TEXT_EXTENSIONS.has(extension) ? "text/plain; charset=utf-8" : "application/octet-stream");
}

function previewKindFor(name: string, contentType: string, path: string): WorkspacePreviewKind {
  const extension = extname(name).toLowerCase();
  if ((extension === ".html" || extension === ".htm") && contentType.startsWith("text/html")) {
    return "html";
  }
  if (contentType.startsWith("text/") || contentType.includes("json") || TEXT_EXTENSIONS.has(extension)) return "text";
  if (contentType === "application/pdf") {
    const signature = readSignature(path, 5);
    return signature.toString("ascii") === "%PDF-" ? "pdf" : "unsupported";
  }
  if (contentType.startsWith("image/") && contentType !== "image/svg+xml") return "image";
  if (contentType === "image/svg+xml") return "text";
  return "unsupported";
}

function readSignature(path: string, length: number): Buffer {
  const bytes = Buffer.alloc(length);
  const descriptor = openSync(path, "r");
  try {
    const read = readSync(descriptor, bytes, 0, length, 0);
    return bytes.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

function rasterMimeType(bytes: Buffer): WorkspaceVisionImage["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}
