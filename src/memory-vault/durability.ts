import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

export type MemoryVaultFailpoint = (name: string, metadata: Record<string, unknown>) => void;

export class MemoryVaultSimulatedCrashError extends Error {
  readonly simulatedCrash = true;

  constructor(readonly failpoint: string) {
    super(`simulated Memory Vault crash at ${failpoint}`);
    this.name = "MemoryVaultSimulatedCrashError";
  }
}

export function runFailpoint(
  failpoint: MemoryVaultFailpoint | undefined,
  name: string,
  metadata: Record<string, unknown> = {},
): void {
  failpoint?.(name, metadata);
}

export function durableAtomicWrite(
  target: string,
  source: string | Uint8Array,
  options: {
    mode?: number;
    failpoint?: MemoryVaultFailpoint;
    failpointPrefix?: string;
    metadata?: Record<string, unknown>;
    writeChunk?: (descriptor: number, bytes: Uint8Array, offset: number, length: number) => number;
    beforeCommit?: () => void;
  } = {},
): void {
  const mode = options.mode ?? 0o600;
  const temporary = resolve(dirname(target), `.${randomUUID()}.tmp`);
  const metadata = { target, ...options.metadata };
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", mode);
    const bytes = typeof source === "string" ? Buffer.from(source) : source;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = (options.writeChunk ?? writeSync)(descriptor, bytes, offset, bytes.byteLength - offset);
      if (written <= 0) throw new Error(`short write while persisting ${target}`);
      offset += written;
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, mode);
    runFailpoint(options.failpoint, `${options.failpointPrefix ?? "file"}.before_fence`, metadata);
    options.beforeCommit?.();
    runFailpoint(options.failpoint, `${options.failpointPrefix ?? "file"}.before_rename`, metadata);
    renameSync(temporary, target);
    chmodSync(target, mode);
    fsyncDirectory(dirname(target));
    runFailpoint(options.failpoint, `${options.failpointPrefix ?? "file"}.after_rename`, metadata);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

export function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function isSimulatedCrash(error: unknown): error is MemoryVaultSimulatedCrashError {
  return error instanceof MemoryVaultSimulatedCrashError;
}
