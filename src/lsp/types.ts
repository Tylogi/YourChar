export const lspOperations = Object.freeze([
  "goToDefinition",
  "findReferences",
  "goToImplementation",
  "hover",
] as const);

export type LspOperation = (typeof lspOperations)[number];

/** Zero-based UTF-16 coordinates, matching the Language Server Protocol. */
export type LspPosition = Readonly<{
  line: number;
  character: number;
}>;

export type LspRange = Readonly<{
  start: LspPosition;
  end: LspPosition;
}>;

export type LspDocumentSnapshot = Readonly<{
  /** Workspace-relative POSIX path. */
  path: string;
  /** Sandboxed file URI below file:///workspace/. */
  uri: string;
  extension: string;
  text: string;
}>;

export type LspProviderQuery = Readonly<{
  operation: LspOperation;
  document: LspDocumentSnapshot;
  position: LspPosition;
}>;

export type LspProviderLocation = Readonly<{
  uri: string;
  range: LspRange;
}>;

export type LspProviderResult =
  | Readonly<{ kind: "empty" }>
  | Readonly<{
      kind: "locations";
      locations: readonly LspProviderLocation[];
      truncated?: boolean;
    }>
  | Readonly<{
      kind: "hover";
      contents: string;
      range?: LspRange;
      truncated?: boolean;
    }>;

export type LspProvider = Readonly<{
  id: string;
  /** Lowercase file extensions including the leading dot. */
  extensions: readonly string[];
  query: (
    request: LspProviderQuery,
    signal?: AbortSignal,
  ) => Promise<LspProviderResult>;
  close?: () => void | Promise<void>;
}>;

export type LspProviderScope = Readonly<{
  /** Host path used only when constructing the provider sandbox. */
  workspaceDir: string;
  /** Providers see documents below this stable virtual root. */
  workspaceUri: "file:///workspace";
  readOnly: true;
}>;

/**
 * Deployment-trusted provider definition. A fresh provider is mounted for
 * every owning Agent handle; implementations must not reuse a process across
 * Workspace scopes.
 */
export type LspProviderDefinition = Readonly<{
  id: string;
  extensions: readonly string[];
  mount: (
    scope: LspProviderScope,
  ) => LspProvider | Promise<LspProvider>;
}>;

export type LspQueryRequest = Readonly<{
  operation: LspOperation;
  /** Workspace-relative path. */
  path: string;
  /** Zero-based UTF-16 coordinate. */
  position: LspPosition;
}>;

export type LspLocation = Readonly<{
  path: string;
  range: LspRange;
}>;

export type LspQueryResult =
  | Readonly<{
      kind: "locations";
      providerId: string;
      locations: readonly LspLocation[];
      truncated: boolean;
    }>
  | Readonly<{
      kind: "hover";
      providerId: string;
      path: string;
      contents: string;
      range?: LspRange;
      truncated: boolean;
    }>;

export type LspErrorCode =
  | "LSP_INVALID_PROVIDER"
  | "LSP_CONFLICT"
  | "LSP_UNAVAILABLE"
  | "LSP_DISPOSED"
  | "LSP_UNSUPPORTED_OPERATION"
  | "LSP_INVALID_REQUEST"
  | "LSP_MALFORMED_RESPONSE"
  | "LSP_PROVIDER_FAILED"
  | "LSP_TIMEOUT"
  | "LSP_CANCELLED";

export class LspError extends Error {
  constructor(
    readonly code: LspErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LspError";
  }
}
