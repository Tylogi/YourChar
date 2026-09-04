import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { MAX_WORKSPACE_UPLOAD_BYTES } from "../workspace/file-service.js";

export const MAX_TASK_BENCH_UPLOAD_BYTES = MAX_WORKSPACE_UPLOAD_BYTES;
export const MAX_TASK_BENCH_UPLOAD_TOTAL_BYTES = 80 * 1024 * 1024;
export const TASK_BENCH_UPLOAD_TTL_MS = 60 * 60_000;

export type TaskBenchUpload = {
  id: string;
  name: string;
  size: number;
  contentType?: string;
  createdAt: string;
  expiresAt: string;
};

export type TaskBenchUploadFixture = TaskBenchUpload & {
  bytes: Buffer;
};

type StoredUpload = TaskBenchUploadFixture & {
  expiresAtMs: number;
};

export class TaskBenchUploadError extends Error {
  constructor(
    readonly code:
      | "TASK_BENCH_UPLOAD_INVALID"
      | "TASK_BENCH_UPLOAD_NOT_FOUND"
      | "TASK_BENCH_UPLOAD_LIMIT",
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "TaskBenchUploadError";
  }
}

export class TaskBenchUploadRegistry {
  private readonly uploads = new Map<string, StoredUpload>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.cleanupTimer = setInterval(() => this.purgeExpired(), 5 * 60_000);
    this.cleanupTimer.unref?.();
  }

  add(input: { name: string; contentType?: string; bytes: Buffer }): TaskBenchUpload {
    this.assertActive();
    this.purgeExpired();
    const name = safeUploadName(input.name);
    if (input.bytes.byteLength > MAX_TASK_BENCH_UPLOAD_BYTES) {
      throw new TaskBenchUploadError(
        "TASK_BENCH_UPLOAD_LIMIT",
        `单个测试材料不能超过 ${MAX_TASK_BENCH_UPLOAD_BYTES / 1024 / 1024} MiB`,
        413,
      );
    }
    const total = [...this.uploads.values()].reduce((sum, upload) => sum + upload.size, 0);
    if (total + input.bytes.byteLength > MAX_TASK_BENCH_UPLOAD_TOTAL_BYTES) {
      throw new TaskBenchUploadError(
        "TASK_BENCH_UPLOAD_LIMIT",
        `临时测试材料合计不能超过 ${MAX_TASK_BENCH_UPLOAD_TOTAL_BYTES / 1024 / 1024} MiB`,
        413,
      );
    }
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + TASK_BENCH_UPLOAD_TTL_MS;
    const id = `task-upload-${randomUUID()}`;
    const contentType = safeContentType(input.contentType);
    const upload: StoredUpload = {
      id,
      name,
      size: input.bytes.byteLength,
      ...(contentType ? { contentType } : {}),
      bytes: Buffer.from(input.bytes),
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    };
    this.uploads.set(id, upload);
    return publicUpload(upload);
  }

  snapshot(ids: string[]): TaskBenchUploadFixture[] {
    this.assertActive();
    this.purgeExpired();
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length) {
      throw new TaskBenchUploadError(
        "TASK_BENCH_UPLOAD_INVALID",
        "临时测试材料 ID 不能重复",
        400,
      );
    }
    return uniqueIds.map((id) => {
      const upload = this.uploads.get(id);
      if (!upload) {
        throw new TaskBenchUploadError(
          "TASK_BENCH_UPLOAD_NOT_FOUND",
          "临时测试材料不存在或已过期，请重新上传",
          404,
        );
      }
      return { ...publicUpload(upload), bytes: Buffer.from(upload.bytes) };
    });
  }

  remove(id: string): boolean {
    this.assertActive();
    this.purgeExpired();
    return this.uploads.delete(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    this.uploads.clear();
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [id, upload] of this.uploads) {
      if (upload.expiresAtMs <= now) this.uploads.delete(id);
    }
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new TaskBenchUploadError(
        "TASK_BENCH_UPLOAD_INVALID",
        "临时测试材料服务已关闭",
        503,
      );
    }
  }
}

function publicUpload(upload: StoredUpload): TaskBenchUpload {
  return {
    id: upload.id,
    name: upload.name,
    size: upload.size,
    ...(upload.contentType ? { contentType: upload.contentType } : {}),
    createdAt: upload.createdAt,
    expiresAt: upload.expiresAt,
  };
}

function safeUploadName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || name.length > 255 || basename(name) !== name || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new TaskBenchUploadError(
      "TASK_BENCH_UPLOAD_INVALID",
      "测试材料文件名无效",
      400,
    );
  }
  return name;
}

function safeContentType(value?: string): string | undefined {
  const contentType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || contentType.length > 160 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(contentType)) {
    return undefined;
  }
  return contentType;
}
