import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { durableAtomicWrite } from "../memory-vault/durability.js";

const MAX_AVATAR_BYTES = 512 * 1024;
const CONTENT_TYPES = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

type AvatarExtension = keyof typeof CONTENT_TYPES;
type AvatarOwner = { type: "user" } | { type: "character"; id: string };

export type AvatarAsset = {
  bytes: Buffer;
  contentType: string;
  updatedAt: string;
};

export class AvatarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AvatarValidationError";
  }
}

export class AvatarService {
  private readonly directory?: string;
  private readonly memory = new Map<string, { bytes: Buffer; extension: AvatarExtension; updatedAt: string }>();

  constructor(stateDir?: string) {
    this.directory = stateDir ? join(stateDir, "avatars") : undefined;
  }

  getUser(): AvatarAsset | undefined {
    return this.get({ type: "user" });
  }

  getCharacter(id: string): AvatarAsset | undefined {
    return this.get({ type: "character", id: safeCharacterId(id) });
  }

  putUser(dataUrl: string): AvatarAsset {
    return this.put({ type: "user" }, dataUrl);
  }

  putCharacter(id: string, dataUrl: string): AvatarAsset {
    return this.put({ type: "character", id: safeCharacterId(id) }, dataUrl);
  }

  deleteUser(): boolean {
    return this.delete({ type: "user" });
  }

  deleteCharacter(id: string): boolean {
    return this.delete({ type: "character", id: safeCharacterId(id) });
  }

  clear(): void {
    this.memory.clear();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }

  private get(owner: AvatarOwner): AvatarAsset | undefined {
    const key = ownerKey(owner);
    if (!this.directory) {
      const stored = this.memory.get(key);
      return stored ? {
        bytes: Buffer.from(stored.bytes),
        contentType: CONTENT_TYPES[stored.extension],
        updatedAt: stored.updatedAt,
      } : undefined;
    }
    const path = this.findPath(owner);
    if (!path) return undefined;
    const extension = path.slice(path.lastIndexOf(".") + 1) as AvatarExtension;
    return {
      bytes: readFileSync(path),
      contentType: CONTENT_TYPES[extension],
      updatedAt: statSync(path).mtime.toISOString(),
    };
  }

  private put(owner: AvatarOwner, dataUrl: string): AvatarAsset {
    const decoded = decodeAvatar(dataUrl);
    const updatedAt = new Date().toISOString();
    const key = ownerKey(owner);
    if (!this.directory) {
      this.memory.set(key, { ...decoded, bytes: Buffer.from(decoded.bytes), updatedAt });
      return { bytes: Buffer.from(decoded.bytes), contentType: CONTENT_TYPES[decoded.extension], updatedAt };
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, `${key}.${decoded.extension}`);
    durableAtomicWrite(path, decoded.bytes, { mode: 0o600, failpointPrefix: "avatar_file" });
    this.removeFiles(owner, `${key}.${decoded.extension}`);
    return {
      bytes: Buffer.from(decoded.bytes),
      contentType: CONTENT_TYPES[decoded.extension],
      updatedAt: statSync(path).mtime.toISOString(),
    };
  }

  private delete(owner: AvatarOwner): boolean {
    if (!this.directory) return this.memory.delete(ownerKey(owner));
    return this.removeFiles(owner) > 0;
  }

  private findPath(owner: AvatarOwner): string | undefined {
    if (!this.directory || !existsSync(this.directory)) return undefined;
    const key = ownerKey(owner);
    for (const extension of Object.keys(CONTENT_TYPES) as AvatarExtension[]) {
      const path = join(this.directory, `${key}.${extension}`);
      if (existsSync(path)) return path;
    }
    return undefined;
  }

  private removeFiles(owner: AvatarOwner, keepName?: string): number {
    if (!this.directory || !existsSync(this.directory)) return 0;
    const key = ownerKey(owner);
    let removed = 0;
    for (const name of readdirSync(this.directory)) {
      if (name === keepName) continue;
      if (!name.startsWith(`${key}.`)) continue;
      const extension = name.slice(name.lastIndexOf(".") + 1);
      if (!(extension in CONTENT_TYPES)) continue;
      rmSync(join(this.directory, name), { force: true });
      removed += 1;
    }
    return removed;
  }
}

function decodeAvatar(dataUrl: string): { bytes: Buffer; extension: AvatarExtension } {
  if (typeof dataUrl !== "string") throw new AvatarValidationError("avatar dataUrl must be a string");
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new AvatarValidationError("avatar must be a base64 JPEG, PNG, or WebP image");
  const bytes = Buffer.from(match[2], "base64");
  if (!bytes.length) throw new AvatarValidationError("avatar image is empty");
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new AvatarValidationError(`avatar image must not exceed ${MAX_AVATAR_BYTES / 1024} KiB`);
  }
  const extension = match[1] === "image/jpeg" ? "jpg" : match[1].slice("image/".length) as AvatarExtension;
  if (!hasExpectedSignature(bytes, extension)) {
    throw new AvatarValidationError("avatar content does not match its declared image type");
  }
  return { bytes, extension };
}

function hasExpectedSignature(bytes: Buffer, extension: AvatarExtension): boolean {
  if (extension === "jpg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === "png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

function ownerKey(owner: AvatarOwner): string {
  return owner.type === "user" ? "user" : `character-${owner.id}`;
}

function safeCharacterId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AvatarValidationError("invalid character id");
  return id;
}
