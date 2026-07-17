import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { AppDatabase } from "../storage/database.js";
import { MemoryVaultError } from "./errors.js";

type LeaseRow = {
  owner_id: string | null;
  fence_token: number;
  expires_at: string | null;
  process_identity: string | null;
};

const LEASE_MS = 20_000;
const HEARTBEAT_MS = 5_000;

export class MemoryVaultWriterLock {
  readonly ownerId = randomUUID();
  readonly fenceToken: number;
  readonly mode: "writer" | "memory";
  private released = false;
  private readonly heartbeat?: NodeJS.Timeout;
  private readonly processIdentity = currentProcessIdentity();

  constructor(private readonly database: AppDatabase, stateDir?: string) {
    if (!stateDir) {
      this.mode = "memory";
      this.fenceToken = 0;
      return;
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.mode = "writer";
    this.fenceToken = this.acquire();
    this.heartbeat = setInterval(() => {
      try {
        this.renew();
      } catch {
        this.released = true;
        if (this.heartbeat) clearInterval(this.heartbeat);
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  assertOwner(): void {
    if (this.mode === "memory") return;
    if (this.released) throw staleWriter();
    const row = this.row();
    if (
      row.owner_id !== this.ownerId || row.fence_token !== this.fenceToken ||
      row.process_identity !== this.processIdentity || !row.expires_at || row.expires_at <= nowIso()
    ) throw staleWriter();
  }

  renew(): void {
    if (this.mode === "memory" || this.released) return;
    const result = this.database.connection.prepare(`
      UPDATE memory_vault_writer_lease
      SET expires_at = ?, heartbeat_at = ?
      WHERE singleton = 1 AND owner_id = ? AND fence_token = ? AND process_identity = ?
        AND expires_at > ?
    `).run(expiryIso(), nowIso(), this.ownerId, this.fenceToken, this.processIdentity, nowIso());
    if (Number(result.changes) !== 1) throw staleWriter();
  }

  renewAndAssert(): void {
    if (this.mode === "memory") return;
    this.renew();
    this.assertOwner();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.mode === "memory") return;
    this.database.connection.prepare(`
      UPDATE memory_vault_writer_lease
      SET owner_id = NULL, expires_at = NULL, process_identity = NULL, heartbeat_at = ?
      WHERE singleton = 1 AND owner_id = ? AND fence_token = ?
    `).run(nowIso(), this.ownerId, this.fenceToken);
  }

  health(): { mode: "writer" | "readonly" | "memory"; fenceToken: number; leaseExpiresAt: string | null } {
    if (this.mode === "memory") return { mode: "memory", fenceToken: 0, leaseExpiresAt: null };
    const row = this.row();
    return {
      mode: row.owner_id === this.ownerId && row.fence_token === this.fenceToken ? "writer" : "readonly",
      fenceToken: this.fenceToken,
      leaseExpiresAt: row.owner_id === this.ownerId ? row.expires_at : null,
    };
  }

  private acquire(): number {
    return this.database.transaction(() => {
      const row = this.row();
      const active = Boolean(row.owner_id && row.expires_at && row.expires_at > nowIso());
      if (active) {
        throw new MemoryVaultError(
          "Memory Vault writer lease is held by another process",
          "MEMORY_VAULT_WRITER_BUSY",
        );
      }
      const fenceToken = Number(row.fence_token) + 1;
      this.database.connection.prepare(`
        UPDATE memory_vault_writer_lease
        SET owner_id = ?, fence_token = ?, expires_at = ?, process_identity = ?, heartbeat_at = ?
        WHERE singleton = 1
      `).run(this.ownerId, fenceToken, expiryIso(), this.processIdentity, nowIso());
      return fenceToken;
    });
  }

  private row(): LeaseRow {
    return this.database.connection.prepare(`
      SELECT owner_id, fence_token, expires_at, process_identity
      FROM memory_vault_writer_lease WHERE singleton = 1
    `).get() as LeaseRow;
  }
}

function currentProcessIdentity(): string {
  try {
    const source = readFileSync(`/proc/${process.pid}/stat`, "utf8").trim();
    const afterName = source.slice(source.lastIndexOf(")") + 1).trim().split(/\s+/);
    return `${process.pid}:${afterName[19] ?? "unknown"}`;
  } catch {
    return `${process.pid}:${process.hrtime.bigint().toString()}`;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiryIso(): string {
  return new Date(Date.now() + LEASE_MS).toISOString();
}

function staleWriter(): MemoryVaultError {
  return new MemoryVaultError("Memory Vault writer fencing token is stale", "MEMORY_VAULT_STALE_WRITER");
}
