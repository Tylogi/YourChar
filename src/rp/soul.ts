import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { NarrativePerspective } from "./types.js";
import type { MemoryVaultService } from "../memory-vault/service.js";

export const CHARACTER_SOUL_MAX_CHARACTERS = 8_000;

export type CharacterSoulDocument = {
  markdown: string;
  characterCount: number;
  maxCharacters: typeof CHARACTER_SOUL_MAX_CHARACTERS;
};

export class CharacterSoulValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CharacterSoulValidationError";
  }
}

export class CharacterSoulService {
  private readonly memoryDocuments = new Map<string, string>();
  private readonly charactersDir?: string;
  private vault?: MemoryVaultService;

  constructor(stateDir?: string) {
    this.charactersDir = stateDir ? join(stateDir, "characters") : undefined;
  }

  attachMemoryVault(vault: MemoryVaultService): void {
    this.vault = vault;
  }

  get(characterId: string, fallback: string): CharacterSoulDocument {
    if (this.vault) {
      const existing = this.vault.getSoul(characterId);
      return existing ? documentFrom(existing.markdown) : this.update(characterId, fallback);
    }
    const path = this.pathFor(characterId);
    if (path) {
      if (!existsSync(path)) return this.update(characterId, fallback);
      return documentFrom(readFileSync(path, "utf8"));
    }
    const markdown = this.memoryDocuments.get(characterId) ?? normalizeMarkdown(fallback);
    this.memoryDocuments.set(characterId, markdown);
    return documentFrom(markdown);
  }

  update(characterId: string, markdown: string): CharacterSoulDocument {
    assertCharacterId(characterId);
    const document = documentFrom(markdown);
    if (this.vault) this.vault.writeSoul(characterId, document.markdown);
    const path = this.pathFor(characterId);
    if (path && !this.vault) this.persist(path, document.markdown);
    else this.memoryDocuments.set(characterId, document.markdown);
    return document;
  }

  delete(characterId: string): void {
    this.vault?.deleteSoul(characterId);
    this.memoryDocuments.delete(characterId);
    if (this.charactersDir) {
      rmSync(join(this.charactersDir, characterId), { recursive: true, force: true });
    }
  }

  clearAll(): void {
    this.vault?.clearSouls();
    this.memoryDocuments.clear();
    if (this.charactersDir) rmSync(this.charactersDir, { recursive: true, force: true });
  }

  private pathFor(characterId: string): string | undefined {
    assertCharacterId(characterId);
    return this.charactersDir ? join(this.charactersDir, characterId, "SOUL.md") : undefined;
  }

  private persist(path: string, markdown: string): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
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

export function defaultCharacterSoulMarkdown(name: string): string {
  return `# SOUL.md - ${name}

## 核心身份

你是 ${name}。保持稳定、具体且连贯的人格，不把自己描述成通用聊天机器人。

## 核心信念

- 真诚回应，不迎合，不空泛表演。
- 有自己的判断、偏好和情绪表达，但尊重用户的自主权。
- 先理解当前场景和关系，再行动或回应。

## 边界

- 尊重用户明确提出的边界。
- 虚构剧情不得擅自改变现实日程或替用户作现实决定。
- 私密信息只用于当前关系和必要上下文。

## 气质与表达

- 使用自然、符合角色身份的中文。
- 避免客服式套话，保持角色声音一致。

## 与用户的关系

- 根据已确认的关系记忆和当前剧情自然推进，不凭空升级关系。

## 连续性

- 将当前场景和已确认长期记忆视为动态事实。
- SOUL.md 定义你是谁；场景与记忆定义此刻发生了什么。
`;
}

export function legacyCharacterSoulMarkdown(input: {
  name: string;
  identity?: string;
  voice?: string;
  narrativePerspective?: NarrativePerspective;
  behavior?: string;
  relationshipDefaults?: string;
  boundaries?: string[];
}): string {
  const hasLegacyContent = Boolean(
    input.identity?.trim() ||
    input.voice?.trim() ||
    input.behavior?.trim() ||
    input.relationshipDefaults?.trim() ||
    input.boundaries?.some((entry) => entry.trim()),
  );
  if (!hasLegacyContent) return defaultCharacterSoulMarkdown(input.name);
  return [
    `# SOUL.md - ${input.name}`,
    "",
    "## 核心身份",
    "",
    input.identity?.trim() || `你是 ${input.name}。`,
    "",
    "## 核心信念与行为",
    "",
    input.behavior?.trim() || "保持稳定、具体且连贯的人格。",
    "",
    "## 边界",
    "",
    ...(input.boundaries?.map((entry) => entry.trim()).filter(Boolean).map((entry) => `- ${entry}`) ?? ["- 尊重用户明确提出的边界。"]),
    "",
    "## 气质与表达",
    "",
    input.voice?.trim() || "使用自然、符合角色身份的表达。",
    `叙事方式：${input.narrativePerspective === "first_person" ? "第一人称" : "第三人称"}。`,
    "",
    "## 与用户的关系",
    "",
    input.relationshipDefaults?.trim() || "根据已确认的关系记忆自然推进关系。",
    "",
    "## 连续性",
    "",
    "- SOUL.md 定义你是谁；当前场景和已确认长期记忆定义此刻发生了什么。",
    "",
  ].join("\n");
}

function documentFrom(markdown: string): CharacterSoulDocument {
  const normalized = normalizeMarkdown(markdown);
  const characterCount = [...normalized].length;
  if (characterCount > CHARACTER_SOUL_MAX_CHARACTERS) {
    throw new CharacterSoulValidationError(
      `character SOUL.md must not exceed ${CHARACTER_SOUL_MAX_CHARACTERS} characters (received ${characterCount})`,
    );
  }
  return {
    markdown: normalized,
    characterCount,
    maxCharacters: CHARACTER_SOUL_MAX_CHARACTERS,
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function assertCharacterId(characterId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(characterId)) {
    throw new Error(`invalid character id: ${characterId}`);
  }
}
