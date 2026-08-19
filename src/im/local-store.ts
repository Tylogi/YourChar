import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { durableAtomicWrite } from "../memory-vault/durability.js";
import type { ImProvider } from "./types.js";

type LocalImCredentialDocument = {
  version: 1;
  providers: Partial<Record<ImProvider, unknown>>;
};

const EMPTY_DOCUMENT: LocalImCredentialDocument = {
  version: 1,
  providers: {},
};

/**
 * Private, crash-safe storage for platform credentials owned by the bundled
 * Channel Runtime. Values are deliberately opaque here: each connector owns
 * validation and migration of its credential shape.
 */
export class LocalImCredentialStore {
  readonly directory: string;
  readonly path: string;
  private document: LocalImCredentialDocument;

  constructor(stateDirectory: string) {
    this.directory = resolve(stateDirectory, "im-runtime");
    this.path = join(this.directory, "credentials.json");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    this.document = this.load();
    if (existsSync(this.path)) chmodSync(this.path, 0o600);
  }

  get<T>(provider: ImProvider): T | undefined {
    const value = this.document.providers[provider];
    return value === undefined ? undefined : structuredClone(value) as T;
  }

  set(provider: ImProvider, value: unknown): void {
    this.document = {
      version: 1,
      providers: {
        ...this.document.providers,
        [provider]: structuredClone(value),
      },
    };
    this.persist();
  }

  clear(provider: ImProvider): void {
    if (this.document.providers[provider] === undefined) return;
    const providers = { ...this.document.providers };
    delete providers[provider];
    this.document = { version: 1, providers };
    this.persist();
  }

  clearAll(): void {
    this.document = structuredClone(EMPTY_DOCUMENT);
    this.persist();
  }

  private load(): LocalImCredentialDocument {
    if (!existsSync(this.path)) return structuredClone(EMPTY_DOCUMENT);
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return structuredClone(EMPTY_DOCUMENT);
      }
      const record = value as Record<string, unknown>;
      const providers = record.providers;
      if (record.version !== 1 || !providers || typeof providers !== "object" || Array.isArray(providers)) {
        return structuredClone(EMPTY_DOCUMENT);
      }
      const source = providers as Record<string, unknown>;
      return {
        version: 1,
        providers: {
          ...(source.feishu !== undefined ? { feishu: source.feishu } : {}),
          ...(source.wechat !== undefined ? { wechat: source.wechat } : {}),
        },
      };
    } catch {
      return structuredClone(EMPTY_DOCUMENT);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    durableAtomicWrite(this.path, `${JSON.stringify(this.document, null, 2)}\n`, {
      mode: 0o600,
      failpointPrefix: "im_credentials",
    });
  }
}
