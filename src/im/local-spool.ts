import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { durableAtomicWrite } from "../memory-vault/durability.js";
import type { ImInboundEventInput, ImProvider } from "./types.js";

type InboundSpoolEntry = {
  key: string;
  digest: string;
  event: ImInboundEventInput;
  status: "pending" | "dead";
  attempts: number;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

type DeliveryReceipt = {
  outboxId: string;
  partId: string;
  provider: ImProvider;
  platformMessageId: string;
  deliveredAt: string;
};

type LocalImSpoolDocument = {
  version: 2;
  inbound: InboundSpoolEntry[];
  deliveries: DeliveryReceipt[];
};

const EMPTY_SPOOL: LocalImSpoolDocument = { version: 2, inbound: [], deliveries: [] };
const MAX_INBOUND_ENTRIES = 1_000;
const MAX_DELIVERY_RECEIPTS = 2_000;

/** Durable hand-off between platform transports and the Core model pipeline. */
export class LocalImSpool {
  readonly path: string;
  private document: LocalImSpoolDocument;

  constructor(stateDirectory: string) {
    const directory = resolve(stateDirectory, "im-runtime");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.path = join(directory, "spool.json");
    this.document = this.load();
    if (existsSync(this.path)) chmodSync(this.path, 0o600);
  }

  enqueue(event: ImInboundEventInput): void {
    const key = `${event.provider}:${event.eventId}`;
    const digest = createHash("sha256").update(JSON.stringify(event)).digest("hex");
    const existing = this.document.inbound.find((entry) => entry.key === key);
    if (existing) {
      if (existing.digest !== digest) throw new Error("platform event id was reused with different content");
      return;
    }
    if (this.document.inbound.length >= MAX_INBOUND_ENTRIES) {
      throw new Error("local IM inbound spool is full");
    }
    const now = new Date().toISOString();
    this.document.inbound.push({
      key,
      digest,
      event: structuredClone(event),
      status: "pending",
      attempts: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
    });
    this.persist();
  }

  due(limit = 10, now = new Date()): InboundSpoolEntry[] {
    return this.document.inbound
      .filter((entry) => entry.status === "pending" && Date.parse(entry.availableAt) <= now.getTime())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map((entry) => structuredClone(entry));
  }

  retry(key: string, error: string, delayMs: number): void {
    const entry = this.document.inbound.find((candidate) => candidate.key === key);
    if (!entry || entry.status !== "pending") return;
    const now = new Date();
    entry.attempts += 1;
    entry.availableAt = new Date(now.getTime() + Math.max(1_000, delayMs)).toISOString();
    entry.updatedAt = now.toISOString();
    entry.lastError = safeError(error);
    this.persist();
  }

  complete(key: string): void {
    const next = this.document.inbound.filter((entry) => entry.key !== key);
    if (next.length === this.document.inbound.length) return;
    this.document.inbound = next;
    this.persist();
  }

  deadLetter(key: string, error: string): void {
    const entry = this.document.inbound.find((candidate) => candidate.key === key);
    if (!entry) return;
    entry.status = "dead";
    entry.attempts += 1;
    entry.updatedAt = new Date().toISOString();
    entry.lastError = safeError(error);
    const dead = this.document.inbound.filter((candidate) => candidate.status === "dead");
    if (dead.length > 100) {
      const remove = new Set(dead.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, dead.length - 100).map((candidate) => candidate.key));
      this.document.inbound = this.document.inbound.filter((candidate) => !remove.has(candidate.key));
    }
    this.persist();
  }

  reviveDeadByError(error: string): number {
    const now = new Date().toISOString();
    let revived = 0;
    for (const entry of this.document.inbound) {
      if (entry.status !== "dead" || entry.lastError !== error) continue;
      entry.status = "pending";
      entry.availableAt = now;
      entry.updatedAt = now;
      entry.lastError = undefined;
      revived += 1;
    }
    if (revived) this.persist();
    return revived;
  }

  delivery(outboxId: string, partId = "complete"): DeliveryReceipt | undefined {
    const value = this.document.deliveries.find((entry) =>
      entry.outboxId === outboxId && entry.partId === partId
    );
    return value ? structuredClone(value) : undefined;
  }

  recordDelivery(receipt: DeliveryReceipt): void {
    const existing = this.document.deliveries.find((entry) =>
      entry.outboxId === receipt.outboxId && entry.partId === receipt.partId
    );
    if (existing) return;
    this.document.deliveries.push(structuredClone(receipt));
    if (this.document.deliveries.length > MAX_DELIVERY_RECEIPTS) {
      this.document.deliveries = this.document.deliveries
        .sort((left, right) => left.deliveredAt.localeCompare(right.deliveredAt))
        .slice(-MAX_DELIVERY_RECEIPTS);
    }
    this.persist();
  }

  clearProvider(provider: ImProvider): void {
    const inbound = this.document.inbound.filter((entry) => entry.event.provider !== provider);
    const deliveries = this.document.deliveries.filter((entry) => entry.provider !== provider);
    if (inbound.length === this.document.inbound.length && deliveries.length === this.document.deliveries.length) return;
    this.document = { version: 2, inbound, deliveries };
    this.persist();
  }

  /** Drop unclaimed ingress while retaining send receipts used for outbox idempotency. */
  clearInboundProvider(provider: ImProvider): void {
    const inbound = this.document.inbound.filter((entry) => entry.event.provider !== provider);
    if (inbound.length === this.document.inbound.length) return;
    this.document = { ...this.document, inbound };
    this.persist();
  }

  clearAll(): void {
    this.document = structuredClone(EMPTY_SPOOL);
    this.persist();
  }

  private load(): LocalImSpoolDocument {
    if (!existsSync(this.path)) return structuredClone(EMPTY_SPOOL);
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as {
        version?: unknown;
        inbound?: unknown;
        deliveries?: unknown;
      };
      if ((value.version !== 1 && value.version !== 2) || !Array.isArray(value.inbound) || !Array.isArray(value.deliveries)) {
        return structuredClone(EMPTY_SPOOL);
      }
      return {
        version: 2,
        inbound: value.inbound.slice(0, MAX_INBOUND_ENTRIES) as InboundSpoolEntry[],
        deliveries: value.deliveries.slice(-MAX_DELIVERY_RECEIPTS).flatMap((entry) => {
          if (!entry || typeof entry !== "object") return [];
          const receipt = entry as Partial<DeliveryReceipt>;
          if (
            typeof receipt.outboxId !== "string" ||
            typeof receipt.provider !== "string" ||
            typeof receipt.platformMessageId !== "string" ||
            typeof receipt.deliveredAt !== "string"
          ) return [];
          return [{
            outboxId: receipt.outboxId,
            partId: typeof receipt.partId === "string" && receipt.partId ? receipt.partId : "complete",
            provider: receipt.provider as ImProvider,
            platformMessageId: receipt.platformMessageId,
            deliveredAt: receipt.deliveredAt,
          }];
        }),
      };
    } catch {
      return structuredClone(EMPTY_SPOOL);
    }
  }

  private persist(): void {
    durableAtomicWrite(this.path, `${JSON.stringify(this.document, null, 2)}\n`, {
      mode: 0o600,
      failpointPrefix: "im_spool",
    });
  }
}

function safeError(value: string): string {
  return value.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1_000);
}
