import { randomUUID } from "node:crypto";

export interface IdGenerator {
  next(kind: string): string;
}

export class SystemIdGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export class SeededIdGenerator implements IdGenerator {
  private counter = 0;
  private readonly seed: string;

  constructor(seed: string) {
    this.seed = seed.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "test";
  }

  next(kind: string): string {
    this.counter += 1;
    const normalizedKind = kind.replace(/[^A-Za-z0-9_-]+/g, "-") || "id";
    return `${this.seed}_${normalizedKind}_${String(this.counter).padStart(4, "0")}`;
  }
}
