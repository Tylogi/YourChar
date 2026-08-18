import { createHash } from "node:crypto";
import { basename } from "node:path";
import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { parseDocument, stringify } from "yaml";
import type { VaultDocument } from "../memory-vault/types.js";
import {
  isRealityMemoryType,
  isRoleplayMemoryType,
  type MemoryType,
  type RpMemory,
} from "../rp/types.js";
import {
  MAX_OKF_ARCHIVE_BYTES,
  MAX_OKF_ENTRY_BYTES,
  MAX_OKF_EXTRACTED_BYTES,
  MAX_OKF_FILES,
  MAX_OKF_MEMORY_CHARACTERS,
  OKF_VERSION,
  type OkfExportOptions,
  type OkfExportResult,
  type OkfImportDocument,
  type OkfImportPreview,
  type OkfImportTarget,
  type OkfIssue,
  type OkfStageResult,
} from "./types.js";

type CharacterLabel = { id: string; name: string };
type ParsedConcept = {
  path: string;
  type: string;
  title: string;
  description?: string;
  timestamp?: string;
  tags: string[];
  body: string;
  rpAgent?: Record<string, unknown>;
};

type ParsedBundle = {
  preview: OkfImportPreview;
  ready: Array<ParsedConcept & {
    mappedRealm: "reality" | "roleplay";
    mappedType: MemoryType;
    mappedCharacterId?: string;
  }>;
};

type StageCandidate = {
  realm: "reality" | "roleplay";
  type: MemoryType;
  content: string;
  characterId?: string;
  sourceSessionId: string;
  sourceMessageId: string;
  tags: string[];
  idempotencyKey: string;
  salience: number;
  confidence: number;
};

export class OkfBundleError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "OkfBundleError";
  }
}

export class OkfService {
  exportBundle(input: {
    documents: VaultDocument[];
    characters: CharacterLabel[];
    exportedAt: Date;
    options?: OkfExportOptions;
  }): OkfExportResult {
    const options = input.options ?? {};
    const characterNames = new Map(input.characters.map((character) => [character.id, character.name]));
    const documents = input.documents.filter((document) => {
      if (document.metadata.kind === "memory") {
        return document.metadata.realm !== "legacy" &&
          document.metadata.validity === "active" && document.metadata.confirmed === true;
      }
      if (document.metadata.kind === "user_profile") return Boolean(options.includeProfile);
      if (document.metadata.kind === "character_soul") return Boolean(options.includeSouls);
      if (document.metadata.kind === "scene") return Boolean(options.includeScenes);
      return false;
    });
    const files: Zippable = {};
    const indexItems: Array<{ path: string; title: string; description: string; realm: string }> = [];
    for (const document of documents) {
      const concept = exportConcept(document, characterNames);
      files[document.relativePath] = strToU8(concept.source);
      indexItems.push({
        path: document.relativePath,
        title: concept.title,
        description: concept.description,
        realm: document.metadata.realm,
      });
    }
    files["index.md"] = strToU8(renderIndex(indexItems));
    const bytes = zipSync(files, { level: 6, mtime: input.exportedAt });
    return {
      bytes,
      filename: `yourchar-memory-okf-${compactTimestamp(input.exportedAt)}.zip`,
      conceptCount: documents.length,
    };
  }

  previewImport(bytes: Uint8Array, target: OkfImportTarget, characterIds: Set<string>): OkfImportPreview {
    return this.parseBundle(bytes, target, characterIds).preview;
  }

  stageImport(input: {
    bytes: Uint8Array;
    target: OkfImportTarget;
    characterIds: Set<string>;
    propose: (candidate: StageCandidate) => RpMemory;
  }): OkfStageResult {
    const parsed = this.parseBundle(input.bytes, input.target, input.characterIds);
    if (!parsed.preview.conforms) {
      throw new OkfBundleError("OKF bundle has conformance errors; preview and fix it before staging", "OKF_NOT_CONFORMANT");
    }
    if (!parsed.ready.length) {
      throw new OkfBundleError("OKF bundle contains no concepts that map to YourChar memory types", "OKF_NO_IMPORTABLE_CONCEPTS");
    }
    const staged = parsed.ready.map((concept) => {
      const conceptHash = sha256(`${parsed.preview.archiveHash}\0${concept.path}\0${concept.mappedRealm}\0${concept.mappedCharacterId ?? ""}`);
      return input.propose({
        realm: concept.mappedRealm,
        type: concept.mappedType,
        content: concept.body.trim(),
        ...(concept.mappedCharacterId ? { characterId: concept.mappedCharacterId } : {}),
        sourceSessionId: "okf_import",
        sourceMessageId: `okf_${conceptHash.slice(0, 32)}`,
        tags: [...new Set(["okf", ...concept.tags])].slice(0, 24),
        idempotencyKey: `okf:${conceptHash}`,
        salience: 0.5,
        confidence: 0.6,
      });
    });
    return { preview: parsed.preview, staged };
  }

  private parseBundle(bytes: Uint8Array, target: OkfImportTarget, characterIds: Set<string>): ParsedBundle {
    validateTarget(target, characterIds);
    if (bytes.byteLength > MAX_OKF_ARCHIVE_BYTES) {
      throw new OkfBundleError("OKF ZIP exceeds 5 MiB", "OKF_ARCHIVE_TOO_LARGE");
    }
    const archiveHash = sha256(bytes);
    const issues: OkfIssue[] = [];
    const entries = stripBundleRoot(readZip(bytes));
    const markdownEntries = entries.filter((entry) => entry.path.toLowerCase().endsWith(".md"));
    if (!markdownEntries.length) {
      issues.push({ severity: "error", code: "OKF_NO_MARKDOWN", message: "bundle contains no Markdown files" });
    }
    const documents: OkfImportDocument[] = [];
    const ready: ParsedBundle["ready"] = [];
    let conceptCount = 0;
    for (const entry of markdownEntries) {
      const reservedName = basename(entry.path).toLowerCase();
      if (reservedName === "index.md" || reservedName === "log.md") {
        let reservedIssues: OkfIssue[];
        try {
          reservedIssues = validateReservedDocument(entry.path, entry.source, reservedName);
        } catch (error) {
          reservedIssues = [{
            severity: "error",
            code: "OKF_RESERVED_INVALID",
            path: entry.path,
            message: error instanceof Error ? error.message : String(error),
          }];
        }
        issues.push(...reservedIssues);
        documents.push({
          path: entry.path,
          type: reservedName === "index.md" ? "OKF Index" : "OKF Log",
          title: basename(entry.path),
          tags: [],
          excerpt: excerpt(entry.source),
          status: reservedIssues.some((issue) => issue.severity === "error") ? "invalid" : "reserved",
          ...(reservedIssues.length ? { reason: reservedIssues[0].message } : {}),
        });
        continue;
      }
      conceptCount += 1;
      let concept: ParsedConcept;
      try {
        concept = parseConcept(entry.path, entry.source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        issues.push({ severity: "error", code: "OKF_CONCEPT_INVALID", path: entry.path, message });
        documents.push({
          path: entry.path,
          type: "Invalid",
          title: basename(entry.path, ".md"),
          tags: [],
          excerpt: excerpt(entry.source),
          status: "invalid",
          reason: message,
        });
        continue;
      }
      const mapping = mapConcept(concept, target, characterIds);
      const presentation: OkfImportDocument = {
        path: concept.path,
        type: concept.type,
        title: concept.title,
        ...(concept.description ? { description: concept.description } : {}),
        ...(concept.timestamp ? { timestamp: concept.timestamp } : {}),
        tags: concept.tags,
        excerpt: excerpt(concept.body),
        status: mapping.ready ? "ready" : "unsupported",
        ...(!mapping.ready ? { reason: mapping.reason } : {
          mappedRealm: mapping.realm,
          mappedType: mapping.type,
          ...(mapping.characterId ? { mappedCharacterId: mapping.characterId } : {}),
        }),
      };
      documents.push(presentation);
      if (mapping.ready) {
        ready.push({
          ...concept,
          mappedRealm: mapping.realm,
          mappedType: mapping.type,
          ...(mapping.characterId ? { mappedCharacterId: mapping.characterId } : {}),
        });
      }
    }
    const conforms = !issues.some((issue) => issue.severity === "error");
    const sortedDocuments = documents.sort((left, right) => left.path.localeCompare(right.path));
    return {
      preview: {
        okfVersion: OKF_VERSION,
        archiveHash,
        conforms,
        fileCount: entries.length,
        conceptCount,
        readyCount: ready.length,
        unsupportedCount: sortedDocuments.filter((document) => document.status === "unsupported").length,
        issues,
        documents: sortedDocuments,
      },
      ready: ready.sort((left, right) => left.path.localeCompare(right.path)),
    };
  }
}

function readZip(bytes: Uint8Array): Array<{ path: string; source: string }> {
  if (!bytes.byteLength) throw new OkfBundleError("OKF ZIP is empty", "OKF_ARCHIVE_INVALID");
  const seen = new Set<string>();
  let extractedBytes = 0;
  let fileCount = 0;
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes, {
      filter: (file) => {
        const path = safeArchivePath(file.name);
        if (seen.has(path)) throw new OkfBundleError(`duplicate ZIP entry: ${path}`, "OKF_ARCHIVE_DUPLICATE_PATH");
        seen.add(path);
        if (path.endsWith("/")) return false;
        fileCount += 1;
        if (fileCount > MAX_OKF_FILES) {
          throw new OkfBundleError(`OKF ZIP exceeds ${MAX_OKF_FILES} files`, "OKF_ARCHIVE_TOO_MANY_FILES");
        }
        if (file.originalSize > MAX_OKF_ENTRY_BYTES) {
          throw new OkfBundleError(`${path} exceeds ${MAX_OKF_ENTRY_BYTES / 1024} KiB`, "OKF_ENTRY_TOO_LARGE");
        }
        extractedBytes += file.originalSize;
        if (extractedBytes > MAX_OKF_EXTRACTED_BYTES) {
          throw new OkfBundleError("OKF ZIP exceeds the extracted size limit", "OKF_ARCHIVE_EXPANDED_TOO_LARGE");
        }
        return path.toLowerCase().endsWith(".md");
      },
    });
  } catch (error) {
    if (error instanceof OkfBundleError) throw error;
    throw new OkfBundleError(`invalid OKF ZIP: ${error instanceof Error ? error.message : String(error)}`, "OKF_ARCHIVE_INVALID");
  }
  return Object.entries(unzipped)
    .filter(([path]) => !path.endsWith("/"))
    .map(([path, data]) => {
      const safePath = safeArchivePath(path);
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new OkfBundleError(`${safePath} is not valid UTF-8`, "OKF_ENTRY_UTF8_INVALID");
      }
      return { path: safePath, source: source.replace(/\r\n?/g, "\n") };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function safeArchivePath(input: string): string {
  const path = String(input ?? "");
  const comparable = path.endsWith("/") ? path.slice(0, -1) : path;
  if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path) || path.length > 500 ||
      !comparable || comparable.split("/").some((part) => part === "." || part === ".." || !part)) {
    throw new OkfBundleError(`unsafe ZIP path: ${path || "<empty>"}`, "OKF_ARCHIVE_PATH_INVALID");
  }
  return path;
}

function stripBundleRoot(entries: Array<{ path: string; source: string }>): Array<{ path: string; source: string }> {
  if (!entries.length) return entries;
  const firstSegments = new Set(entries.map((entry) => entry.path.split("/")[0]));
  if (firstSegments.size !== 1) return entries;
  const root = [...firstSegments][0];
  const prefix = `${root}/`;
  if (!entries.some((entry) => entry.path === `${prefix}index.md`) ||
      entries.some((entry) => !entry.path.startsWith(prefix))) return entries;
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(prefix.length) }));
}

function parseConcept(path: string, source: string): ParsedConcept {
  const parsed = splitFrontmatter(path, source, true);
  const record = parseYamlMapping(path, parsed.yaml!);
  const type = stringField(record.type);
  if (!type) throw new OkfBundleError(`${path}: frontmatter type must be a non-empty string`, "OKF_TYPE_REQUIRED");
  const title = stringField(record.title) ?? basename(path, ".md");
  const description = stringField(record.description);
  const timestamp = stringField(record.timestamp);
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean)
    : [];
  const rpAgent = plainRecord(record.rp_agent);
  return {
    path,
    type,
    title,
    ...(description ? { description } : {}),
    ...(timestamp ? { timestamp } : {}),
    tags: [...new Set(tags)].slice(0, 50),
    body: parsed.body,
    ...(rpAgent ? { rpAgent } : {}),
  };
}

function validateReservedDocument(path: string, source: string, name: string): OkfIssue[] {
  const issues: OkfIssue[] = [];
  const parsed = splitFrontmatter(path, source, false);
  if (parsed.yaml !== undefined) {
    const rootIndex = name === "index.md" && !path.includes("/");
    if (!rootIndex) {
      issues.push({ severity: "error", code: "OKF_RESERVED_FRONTMATTER", path, message: `${name} must not contain frontmatter` });
    } else {
      try {
        const record = parseYamlMapping(path, parsed.yaml);
        if (Object.keys(record).some((key) => key !== "okf_version") || record.okf_version !== OKF_VERSION) {
          issues.push({ severity: "error", code: "OKF_VERSION_INVALID", path, message: `root index.md may only declare okf_version: "${OKF_VERSION}"` });
        }
      } catch (error) {
        issues.push({ severity: "error", code: "OKF_RESERVED_FRONTMATTER", path, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  if (name === "index.md" && parsed.body.trim() && !/^#\s+\S+/mu.test(parsed.body)) {
    issues.push({ severity: "error", code: "OKF_INDEX_STRUCTURE_INVALID", path, message: "index.md must group entries under Markdown headings" });
  }
  if (name === "log.md") {
    for (const heading of parsed.body.matchAll(/^##\s+(.+)$/gmu)) {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(heading[1].trim())) {
        issues.push({ severity: "error", code: "OKF_LOG_DATE_INVALID", path, message: "log.md level-two headings must use YYYY-MM-DD" });
        break;
      }
    }
  }
  return issues;
}

function splitFrontmatter(path: string, source: string, required: boolean): { yaml?: string; body: string } {
  if (!source.startsWith("---\n")) {
    if (required) throw new OkfBundleError(`${path}: missing YAML frontmatter`, "OKF_FRONTMATTER_REQUIRED");
    return { body: source };
  }
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new OkfBundleError(`${path}: missing YAML frontmatter end`, "OKF_FRONTMATTER_INVALID");
  return { yaml: source.slice(4, end), body: source.slice(end + 5) };
}

function parseYamlMapping(path: string, yaml: string): Record<string, unknown> {
  const document = parseDocument(yaml, { schema: "core", strict: true, uniqueKeys: true, prettyErrors: true });
  if (document.errors.length) {
    throw new OkfBundleError(`${path}: ${document.errors.map((error) => error.message).join("; ")}`, "OKF_FRONTMATTER_INVALID");
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new OkfBundleError(`${path}: ${error instanceof Error ? error.message : String(error)}`, "OKF_FRONTMATTER_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OkfBundleError(`${path}: frontmatter must be a mapping`, "OKF_FRONTMATTER_INVALID");
  }
  return value as Record<string, unknown>;
}

function mapConcept(
  concept: ParsedConcept,
  target: OkfImportTarget,
  characterIds: Set<string>,
): { ready: true; realm: "reality" | "roleplay"; type: MemoryType; characterId?: string } |
   { ready: false; reason: string } {
  const normalizedType = normalizeType(concept.type);
  const extensionRealm = concept.rpAgent?.realm === "roleplay" || concept.rpAgent?.realm === "reality"
    ? concept.rpAgent.realm
    : undefined;
  const realm = target.realm === "auto" ? extensionRealm ?? "reality" : target.realm;
  const characterId = realm === "roleplay"
    ? target.characterId ?? stringField(concept.rpAgent?.characterId)
    : undefined;
  if (realm === "roleplay" && (!characterId || !characterIds.has(characterId))) {
    return { ready: false, reason: "roleplay concept requires an existing target character" };
  }
  let mappedType: MemoryType;
  if (realm === "reality") {
    if (!isRealityMemoryType(normalizedType)) {
      return { ready: false, reason: `type ${concept.type} is not a reality memory type` };
    }
    mappedType = normalizedType;
  } else {
    if (!isRoleplayMemoryType(normalizedType)) {
      return { ready: false, reason: `type ${concept.type} is not a roleplay memory type` };
    }
    mappedType = normalizedType;
  }
  const body = concept.body.trim();
  if (!body) return { ready: false, reason: "concept body is empty" };
  if ([...body].length > MAX_OKF_MEMORY_CHARACTERS) {
    return { ready: false, reason: `concept body exceeds ${MAX_OKF_MEMORY_CHARACTERS} characters` };
  }
  return {
    ready: true,
    realm,
    type: mappedType,
    ...(characterId ? { characterId } : {}),
  };
}

function exportConcept(document: VaultDocument, characterNames: Map<string, string>) {
  const metadata = document.metadata;
  const type = metadata.kind === "memory" ? metadata.type! : staticType(metadata.kind);
  const title = exportTitle(document, characterNames);
  const description = oneLine(document.body, 160) || title;
  const frontmatter = {
    type,
    title,
    description,
    tags: metadata.tags,
    timestamp: metadata.updatedAt,
    rp_agent: {
      schemaVersion: 1,
      vaultSchemaVersion: metadata.schemaVersion,
      id: metadata.id,
      kind: metadata.kind,
      realm: metadata.realm,
      scope: metadata.scope,
      characterId: metadata.characterId,
      sessionId: metadata.sessionId,
      validity: metadata.validity,
      confirmed: metadata.confirmed,
      revision: metadata.revision,
      memoryKey: metadata.memoryKey,
      salience: metadata.salience,
      confidence: metadata.confidence,
    },
  };
  const yaml = stringify(frontmatter, { schema: "core", lineWidth: 0, sortMapEntries: false }).trimEnd();
  return { title, description, source: `---\n${yaml}\n---\n${document.body}` };
}

function renderIndex(items: Array<{ path: string; title: string; description: string; realm: string }>): string {
  const sections = [
    ["Reality", items.filter((item) => item.realm === "reality")],
    ["Roleplay", items.filter((item) => item.realm === "roleplay")],
  ] as const;
  const body = sections
    .filter(([, entries]) => entries.length)
    .map(([heading, entries]) => `# ${heading}\n\n${entries
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => `* [${markdownLabel(entry.title)}](${entry.path}) - ${oneLine(entry.description, 160)}`)
      .join("\n")}`)
    .join("\n\n");
  return `---\nokf_version: "${OKF_VERSION}"\n---\n${body ? `${body}\n` : ""}`;
}

function exportTitle(document: VaultDocument, characterNames: Map<string, string>): string {
  const metadata = document.metadata;
  if (metadata.kind === "user_profile") return "User Profile";
  const character = metadata.characterId ? characterNames.get(metadata.characterId) : undefined;
  if (metadata.kind === "character_soul") return `${character ?? metadata.characterId ?? "Character"} SOUL`;
  if (metadata.kind === "scene") return `${character ?? "Roleplay"} Scene`;
  return oneLine(document.body, 80) || `${metadata.type} ${metadata.id}`;
}

function staticType(kind: VaultDocument["metadata"]["kind"]): string {
  if (kind === "user_profile") return "User Profile";
  if (kind === "character_soul") return "Character Soul";
  if (kind === "scene") return "Roleplay Scene";
  return "Memory";
}

function validateTarget(target: OkfImportTarget, characterIds: Set<string>): void {
  if (target.realm !== "auto" && target.realm !== "reality" && target.realm !== "roleplay") {
    throw new OkfBundleError("realm must be auto, reality, or roleplay", "OKF_TARGET_INVALID");
  }
  if (target.realm === "roleplay" && (!target.characterId || !characterIds.has(target.characterId))) {
    throw new OkfBundleError("roleplay import requires an existing characterId", "OKF_TARGET_INVALID");
  }
  if (target.characterId && !characterIds.has(target.characterId)) {
    throw new OkfBundleError("import characterId does not exist", "OKF_TARGET_INVALID");
  }
}

function normalizeType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function excerpt(value: string): string {
  return oneLine(value, 240);
}

function oneLine(value: string, limit: number): string {
  const normalized = value
    .replace(/^---[\s\S]*?---\s*/u, "")
    .replace(/^[#>*`\-\t ]+/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return [...normalized].slice(0, limit).join("");
}

function markdownLabel(value: string): string {
  return value.replace(/[\[\]]/gu, "");
}

function compactTimestamp(value: Date): string {
  return value.toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
