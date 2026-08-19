import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { MessageAttachment } from "../domain/types.js";
import {
  MAX_WORKSPACE_UPLOAD_BYTES,
  WorkspaceFileError,
  WorkspaceFileService,
} from "../workspace/file-service.js";
import type {
  ImAttachment,
  ImAttachmentKind,
  ImInboundAttachmentInput,
  ImOutboundAttachmentContent,
} from "./types.js";

export const MAX_IM_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_IM_ATTACHMENT_BYTES = MAX_WORKSPACE_UPLOAD_BYTES;
export const MAX_IM_ATTACHMENTS_TOTAL_BYTES = 40 * 1024 * 1024;

export class LocalImMediaError extends Error {
  constructor(
    readonly code:
      | "IM_MEDIA_INVALID"
      | "IM_MEDIA_TOO_LARGE"
      | "IM_MEDIA_NOT_FOUND"
      | "IM_MEDIA_CHANGED",
    message: string,
  ) {
    super(message);
    this.name = "LocalImMediaError";
  }
}

/** Normal-Workspace-only media boundary shared by the bundled platform connectors. */
export class LocalImMediaStore {
  private readonly workspaceFiles: WorkspaceFileService;

  constructor(normalWorkspaceDirectory: string) {
    this.workspaceFiles = new WorkspaceFileService(normalWorkspaceDirectory);
  }

  async saveInboundAttachment(input: ImInboundAttachmentInput): Promise<ImAttachment> {
    if (
      (input.provider !== "feishu" && input.provider !== "wechat") ||
      typeof input.eventId !== "string" || !input.eventId || input.eventId.length > 1_024
    ) {
      throw new LocalImMediaError("IM_MEDIA_INVALID", "平台附件事件标识无效");
    }
    if (!Buffer.isBuffer(input.bytes) || input.bytes.length < 1) {
      throw new LocalImMediaError("IM_MEDIA_INVALID", "平台附件内容为空");
    }
    if (input.bytes.length > MAX_IM_ATTACHMENT_BYTES) {
      throw new LocalImMediaError("IM_MEDIA_TOO_LARGE", "平台附件超过 20 MiB 上限");
    }
    if (
      input.declaredSize !== undefined &&
      (!Number.isSafeInteger(input.declaredSize) || input.declaredSize < 0)
    ) {
      throw new LocalImMediaError("IM_MEDIA_INVALID", "平台附件大小无效");
    }
    const detectedImage = rasterMimeType(input.bytes);
    if (input.kind === "image" && !detectedImage) {
      throw new LocalImMediaError("IM_MEDIA_INVALID", "图片附件的文件签名无效");
    }
    const contentType = detectedImage ?? normalizedContentType(input.contentType, input.name);
    const kind: ImAttachmentKind = detectedImage ? "image" : "file";
    const name = safeInboundName(
      input.name,
      `${input.provider}-${shortStableId(input.eventId)}${extensionFor(contentType, kind)}`,
      detectedImage,
    );
    const contentSha256 = sha256(input.bytes);
    const directory = [
      "uploads/im",
      input.provider,
      sha256(Buffer.from(input.eventId, "utf8")),
      `${contentSha256}-${sha256(Buffer.from(name, "utf8"))}`,
    ].join("/");
    const expectedPath = `${directory}/${name}`;
    const existing = this.existingInboundAttachment({
      expectedPath,
      name,
      kind,
      contentType,
      size: input.bytes.length,
      sha256: contentSha256,
    });
    if (existing) return existing;

    const entry = this.workspaceFiles.upload({
      directory,
      name,
      bytes: input.bytes,
    });
    // upload() normally returns expectedPath because this method is synchronous
    // between the existence check and the exclusive write. If another process
    // won that race, discard our unique-name copy and reuse only an identical
    // fixed target. A conflicting target is never overwritten.
    if (entry.path !== expectedPath) {
      this.workspaceFiles.delete(entry.path);
      const raced = this.existingInboundAttachment({
        expectedPath,
        name,
        kind,
        contentType,
        size: input.bytes.length,
        sha256: contentSha256,
      });
      if (raced) return raced;
      throw new LocalImMediaError(
        "IM_MEDIA_CHANGED",
        "同一平台事件的附件存储目标发生冲突",
      );
    }
    return {
      kind,
      path: entry.path,
      name: entry.name,
      contentType,
      size: input.bytes.length,
      sha256: contentSha256,
    };
  }

  /** Remove only connector-managed inbound media; a missing directory is already clear. */
  clearInboundAttachments(): void {
    try {
      this.workspaceFiles.delete("uploads/im");
    } catch (error) {
      if (error instanceof WorkspaceFileError && error.code === "WORKSPACE_NOT_FOUND") return;
      throw error;
    }
  }

  describeOutboundAttachments(
    attachments: readonly MessageAttachment[] | undefined,
  ): ImAttachment[] {
    if (!attachments?.length) return [];
    const result: ImAttachment[] = [];
    let totalBytes = 0;
    for (const attachment of attachments.slice(0, MAX_IM_ATTACHMENTS_PER_MESSAGE)) {
      const asset = this.workspaceFiles.asset(attachment.path, "attachment");
      if (asset.entry.size > MAX_IM_ATTACHMENT_BYTES) {
        throw new LocalImMediaError("IM_MEDIA_TOO_LARGE", "待发送附件超过 20 MiB 上限");
      }
      totalBytes += asset.entry.size;
      if (totalBytes > MAX_IM_ATTACHMENTS_TOTAL_BYTES) {
        throw new LocalImMediaError("IM_MEDIA_TOO_LARGE", "单条消息附件总量超过 40 MiB 上限");
      }
      const bytes = readFileSync(asset.absolutePath);
      const imageContentType = rasterMimeType(bytes);
      result.push({
        kind: imageContentType ? "image" : "file",
        path: asset.entry.path,
        name: asset.entry.name,
        contentType: imageContentType ?? asset.entry.contentType ?? "application/octet-stream",
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }
    return result;
  }

  async loadOutboundAttachment(attachment: ImAttachment): Promise<ImOutboundAttachmentContent> {
    const asset = this.workspaceFiles.asset(attachment.path, "attachment");
    if (asset.entry.size > MAX_IM_ATTACHMENT_BYTES) {
      throw new LocalImMediaError("IM_MEDIA_TOO_LARGE", "待发送附件超过 20 MiB 上限");
    }
    const bytes = readFileSync(asset.absolutePath);
    if (bytes.length !== attachment.size || sha256(bytes) !== attachment.sha256) {
      throw new LocalImMediaError("IM_MEDIA_CHANGED", "待发送附件在排队后发生变化");
    }
    const imageContentType = rasterMimeType(bytes);
    if (
      (attachment.kind === "image" && imageContentType !== attachment.contentType) ||
      (attachment.kind === "file" && imageContentType !== undefined)
    ) {
      throw new LocalImMediaError("IM_MEDIA_CHANGED", "待发送附件的文件签名或媒体类型已失效");
    }
    return {
      bytes,
      name: attachment.name,
      contentType: attachment.contentType,
    };
  }

  private existingInboundAttachment(input: Omit<ImAttachment, "path"> & { expectedPath: string }):
    ImAttachment | undefined {
    let asset;
    try {
      asset = this.workspaceFiles.asset(input.expectedPath, "attachment");
    } catch (error) {
      if (error instanceof WorkspaceFileError && error.code === "WORKSPACE_NOT_FOUND") {
        return undefined;
      }
      throw error;
    }
    const bytes = readFileSync(asset.absolutePath);
    if (bytes.length !== input.size || sha256(bytes) !== input.sha256) {
      throw new LocalImMediaError(
        "IM_MEDIA_CHANGED",
        "同一平台事件的附件存储内容不一致",
      );
    }
    return {
      kind: input.kind,
      path: asset.entry.path,
      name: input.name,
      contentType: input.contentType,
      size: input.size,
      sha256: input.sha256,
    };
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function shortStableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeInboundName(
  input: string | undefined,
  fallback: string,
  detectedImageType?: string,
): string {
  let name = String(input ?? "").normalize("NFKC").trim();
  name = name.replace(/[\u0000-\u001f\u007f/\\]+/gu, "-").replace(/^\.+/u, "");
  if (!name || name === "." || name === "..") name = fallback;
  const characters = [...name];
  if (characters.length > 140) {
    const extension = extname(name).slice(0, 16);
    name = `${characters.slice(0, Math.max(1, 140 - [...extension].length)).join("")}${extension}`;
  }
  if (detectedImageType) {
    const expected = extensionFor(detectedImageType, "image");
    if (!imageExtensionMatches(extname(name).toLowerCase(), detectedImageType)) {
      name = `${name.replace(/\.[^.]+$/u, "") || "image"}${expected}`;
    }
  }
  return name;
}

function normalizedContentType(value: string | undefined, name: string | undefined): string {
  const candidate = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(candidate)) return candidate;
  return contentTypeFromExtension(extname(String(name ?? "")).toLowerCase());
}

function contentTypeFromExtension(extension: string): string {
  return ({
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".eml": "message/rfc822",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".html": "text/html",
    ".htm": "text/html",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}

function extensionFor(contentType: string, kind: ImAttachmentKind): string {
  if (kind === "image") {
    if (contentType === "image/jpeg") return ".jpg";
    if (contentType === "image/gif") return ".gif";
    if (contentType === "image/webp") return ".webp";
    return ".png";
  }
  return ".bin";
}

function imageExtensionMatches(extension: string, contentType: string): boolean {
  if (contentType === "image/jpeg") return extension === ".jpg" || extension === ".jpeg";
  if (contentType === "image/png") return extension === ".png";
  if (contentType === "image/gif") return extension === ".gif";
  if (contentType === "image/webp") return extension === ".webp";
  return false;
}

function rasterMimeType(bytes: Buffer): "image/png" | "image/jpeg" | "image/gif" | "image/webp" | undefined {
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
