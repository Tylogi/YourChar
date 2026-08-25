export type MineruParseMethod = "auto" | "ocr" | "txt";

export type MineruApiConfig = {
  baseUrl: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
  backend: string;
  parseMethod: MineruParseMethod;
  language: string;
  formulaEnabled: boolean;
  tableEnabled: boolean;
  timeoutSeconds: number;
  updatedAt?: string;
};

export type MineruApiConfigPatch = {
  baseUrl?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  backend?: string;
  parseMethod?: MineruParseMethod;
  language?: string;
  formulaEnabled?: boolean;
  tableEnabled?: boolean;
  timeoutSeconds?: number;
};

export type MineruParseInput = {
  path: string;
  offset?: number;
  limit?: number;
};

export type MineruParseResult = {
  markdown: string;
  offset: number;
  limit: number;
  totalLines: number;
  nextOffset?: number;
  sourceSha256: string;
  sourceBytes: number;
  imageCount: number;
  imageBytes: number;
  backend: string;
  engineVersion?: string;
  cached: boolean;
  savedPath: string;
  expiresAt: string;
};

export type MineruWorkspaceContext = {
  workspaceFiles: import("../workspace/file-service.js").WorkspaceFileService;
  cacheNamespace: string;
};
