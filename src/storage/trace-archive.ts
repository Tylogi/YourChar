import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Clock } from "../app/clock.js";
import type {
  ModelContextTrace,
  TraceArchiveConfig,
  TraceArchiveStatus,
} from "../domain/types.js";

type StoredTraceArchiveConfig = {
  version: 1;
  enabled: boolean;
  updatedAt?: string;
};

export class TraceArchive {
  private readonly configPath?: string;
  private readonly archiveDir?: string;
  private config: StoredTraceArchiveConfig;
  private lastError?: string;

  constructor(stateDir: string | undefined, private readonly clock: Clock) {
    this.configPath = stateDir ? join(resolve(stateDir), "trace-archive.json") : undefined;
    this.archiveDir = stateDir ? join(resolve(stateDir), "trace-archive") : undefined;
    this.config = this.loadConfig();
  }

  getConfig(): TraceArchiveConfig {
    return {
      enabled: this.config.enabled,
      available: Boolean(this.configPath && this.archiveDir),
      updatedAt: this.config.updatedAt,
    };
  }

  patchConfig(patch: { enabled?: boolean }): TraceArchiveStatus {
    if (patch.enabled !== undefined) {
      if (patch.enabled && (!this.configPath || !this.archiveDir)) {
        throw new Error("trace archive requires a persistent state directory");
      }
      this.config.enabled = Boolean(patch.enabled);
      this.config.updatedAt = this.clock.now().toISOString();
      this.lastError = undefined;
      this.persistConfig();
    }
    return this.status();
  }

  append(trace: ModelContextTrace): void {
    if (!this.config.enabled || !this.archiveDir) return;
    try {
      mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
      chmodSync(this.archiveDir, 0o700);
      const target = join(this.archiveDir, archiveFileName(trace.createdAt));
      appendFileSync(target, `${JSON.stringify({
        schemaVersion: 1,
        kind: "model_context_trace",
        trace,
      })}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(target, 0o600);
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  status(): TraceArchiveStatus {
    let files = 0;
    let totalBytes = 0;
    if (this.archiveDir && existsSync(this.archiveDir)) {
      try {
        for (const entry of readdirSync(this.archiveDir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^model-traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) continue;
          files += 1;
          totalBytes += statSync(join(this.archiveDir, entry.name)).size;
        }
      } catch (error) {
        this.lastError ??= error instanceof Error ? error.message : String(error);
      }
    }
    const currentFile = this.archiveDir
      ? join(this.archiveDir, archiveFileName(this.clock.now().toISOString()))
      : undefined;
    return {
      ...this.getConfig(),
      format: "jsonl",
      directory: this.archiveDir,
      currentFile,
      files,
      totalBytes,
      lastError: this.lastError,
    };
  }

  clearData(): void {
    if (this.archiveDir) rmSync(this.archiveDir, { recursive: true, force: true });
    this.lastError = undefined;
  }

  private loadConfig(): StoredTraceArchiveConfig {
    if (!this.configPath || !existsSync(this.configPath)) return { version: 1, enabled: false };
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, "utf8")) as Record<string, unknown>;
      return {
        version: 1,
        enabled: parsed.enabled === true,
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
      };
    } catch {
      return { version: 1, enabled: false };
    }
  }

  private persistConfig(): void {
    if (!this.configPath) return;
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.configPath);
    chmodSync(this.configPath, 0o600);
  }
}

function archiveFileName(createdAt: string): string {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(createdAt)?.[0] ?? new Date().toISOString().slice(0, 10);
  return `model-traces-${date}.jsonl`;
}
