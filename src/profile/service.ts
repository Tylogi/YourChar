import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../app/clock.js";
import type { MemoryVaultService } from "../memory-vault/service.js";
import {
  USER_PROFILE_REALM,
  USER_PROFILE_MAX_CHARACTERS,
  USER_PROFILE_SCOPE,
  type UserProfileDocument,
} from "./types.js";

const defaultMarkdown = `# 用户画像

## 基本信息

## 偏好与沟通

## 当前目标

## 边界与注意事项
`;

export type UserProfileServiceOptions = {
  clock: Clock;
  stateDir?: string;
};

export class UserProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserProfileValidationError";
  }
}

export class UserProfileService {
  private readonly profilePath?: string;
  private markdown = defaultMarkdown;
  private updatedAt: string;
  private vault?: MemoryVaultService;

  constructor(private readonly options: UserProfileServiceOptions) {
    this.profilePath = options.stateDir ? join(options.stateDir, "user-profile.md") : undefined;
    this.updatedAt = options.clock.now().toISOString();
  }

  attachMemoryVault(vault: MemoryVaultService): void {
    this.vault = vault;
  }

  get(): UserProfileDocument {
    if (this.vault) {
      this.vault.syncIfChanged();
      const profile = this.vault.getProfile() ?? this.vault.writeProfile(defaultMarkdown);
      assertWithinLimit(profile.markdown);
      this.markdown = profile.markdown;
      this.updatedAt = profile.updatedAt;
      return this.document();
    }
    if (this.profilePath) {
      if (!existsSync(this.profilePath)) {
        return this.update(defaultMarkdown);
      }
      this.markdown = normalizeMarkdown(readFileSync(this.profilePath, "utf8"));
      assertWithinLimit(this.markdown);
      this.updatedAt = statSync(this.profilePath).mtime.toISOString();
    }
    return this.document();
  }

  update(markdown: string): UserProfileDocument {
    const normalized = normalizeMarkdown(markdown);
    assertWithinLimit(normalized);
    if (this.vault) {
      const profile = this.vault.writeProfile(normalized);
      this.markdown = profile.markdown;
      this.updatedAt = profile.updatedAt;
    } else {
      this.markdown = normalized;
      this.updatedAt = this.options.clock.now().toISOString();
    }
    // Keep the R1 path as a migration mirror; runtime reads never use it once Vault is attached.
    if (this.profilePath && !this.vault) this.persist(this.markdown);
    return this.document();
  }

  clear(): void {
    this.vault?.deleteProfile();
    if (this.profilePath) rmSync(this.profilePath, { force: true });
    this.markdown = defaultMarkdown;
    this.updatedAt = this.options.clock.now().toISOString();
  }

  private document(): UserProfileDocument {
    return {
      realm: USER_PROFILE_REALM,
      scope: USER_PROFILE_SCOPE,
      markdown: this.markdown,
      characterCount: countCharacters(this.markdown),
      maxCharacters: USER_PROFILE_MAX_CHARACTERS,
      updatedAt: this.updatedAt,
    };
  }

  private persist(markdown: string): void {
    const path = this.profilePath!;
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, path);
      chmodSync(path, 0o600);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}

export function countUserProfileCharacters(markdown: string): number {
  return countCharacters(normalizeMarkdown(markdown));
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function countCharacters(value: string): number {
  return [...value].length;
}

function assertWithinLimit(markdown: string): void {
  const count = countCharacters(markdown);
  if (count > USER_PROFILE_MAX_CHARACTERS) {
    throw new UserProfileValidationError(
      `user profile must not exceed ${USER_PROFILE_MAX_CHARACTERS} characters (received ${count})`,
    );
  }
}
