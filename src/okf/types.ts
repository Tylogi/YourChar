import type { MemoryType, RpMemory } from "../rp/types.js";

export const OKF_VERSION = "0.1" as const;
export const MAX_OKF_ARCHIVE_BYTES = 5 * 1024 * 1024;
export const MAX_OKF_EXTRACTED_BYTES = 10 * 1024 * 1024;
export const MAX_OKF_ENTRY_BYTES = 512 * 1024;
export const MAX_OKF_FILES = 500;
export const MAX_OKF_MEMORY_CHARACTERS = 2_000;

export type OkfImportRealm = "auto" | "reality" | "roleplay";

export type OkfImportTarget = {
  realm: OkfImportRealm;
  characterId?: string;
};

export type OkfIssue = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
};

export type OkfImportDocument = {
  path: string;
  type: string;
  title: string;
  description?: string;
  timestamp?: string;
  tags: string[];
  excerpt: string;
  status: "ready" | "unsupported" | "reserved" | "invalid";
  reason?: string;
  mappedRealm?: "reality" | "roleplay";
  mappedType?: MemoryType;
  mappedCharacterId?: string;
};

export type OkfImportPreview = {
  okfVersion: typeof OKF_VERSION;
  archiveHash: string;
  conforms: boolean;
  fileCount: number;
  conceptCount: number;
  readyCount: number;
  unsupportedCount: number;
  issues: OkfIssue[];
  documents: OkfImportDocument[];
};

export type OkfStageResult = {
  preview: OkfImportPreview;
  staged: RpMemory[];
};

export type OkfExportOptions = {
  includeProfile?: boolean;
  includeSouls?: boolean;
  includeScenes?: boolean;
};

export type OkfExportResult = {
  bytes: Uint8Array;
  filename: string;
  conceptCount: number;
};
