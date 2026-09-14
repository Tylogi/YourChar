import type { AgentMcpModuleContribution } from "../modules/types.js";
import type {
  SessionCapability,
  SessionCapabilityDescriptor,
} from "../pi/session-capability.js";
import type { AgentCapabilityPackage } from "../pi/runtime-configuration.js";
import { WorkspaceLspService, type WorkspaceLspServiceOptions } from "./service.js";
import { createLspNavigationTool } from "./tools.js";
import type { LspProviderDefinition } from "./types.js";

export const lspNavigationModuleId = "mcp:lsp-navigation";
export const lspNavigationCapabilityId = "code:lsp-navigation";

export const lspNavigationCapabilityDescriptor: SessionCapabilityDescriptor = Object.freeze({
  id: lspNavigationCapabilityId,
  order: 825,
  moduleId: lspNavigationModuleId,
});

export const lspNavigationModuleContribution: AgentMcpModuleContribution = Object.freeze({
  id: lspNavigationModuleId,
  name: "LSP Code Navigation",
  description: "Bounded read-only semantic navigation for files in the current Workspace.",
  source: "deployment-trusted capability package",
  defaultEnabled: false,
  estimatedTokens: 300,
  detail: `# LSP Code Navigation

## Tool

- \`lsp\`: query a definition, references, implementation, or hover information at one source position.

## Boundaries

- This module is disabled by default and appears only when a deployment-trusted runtime package is active.
- It requires Workspace read permission. Incognito children never receive it.
- Every Agent handle owns fresh provider instances. Disabling the module, changing profiles, deleting the conversation, or shutting down the runtime closes their language-server processes.
- The generic stdio provider runs without network access in an OS sandbox. It sees the owning Workspace read-only plus only deployment-reviewed runtime paths.
- Paths, documents, messages, locations, hover text, query duration, and result counts are bounded. Provider locations outside the owning Workspace fail closed.
- The capability is read-only. Keep \`bash\` and ordinary Workspace search as the compatibility path and compare task outcomes before treating LSP as required.
`,
  context: {
    order: 8_250,
    enabled: "Capability status: bounded read-only LSP navigation is enabled for the current Workspace.",
    disabled: "Capability status: LSP navigation is disabled or unavailable; use ordinary Workspace search and bash.",
  },
});

export type LspNavigationCapabilityOptions = WorkspaceLspServiceOptions & Readonly<{
  providers: readonly LspProviderDefinition[];
}>;

/**
 * An optional code-intelligence capability. Provider definitions are trusted
 * deployment code; the model can select only an operation, file, and position.
 */
export function createLspNavigationCapability(
  options: LspNavigationCapabilityOptions,
): SessionCapability {
  const providers = Object.freeze([...(options.providers ?? [])]);
  return Object.freeze({
    ...lspNavigationCapabilityDescriptor,
    moduleContribution: lspNavigationModuleContribution,
    allowInIsolatedTaskBench: true,
    async mount(context) {
      if (context.incognitoChild || context.permissions.workspaceAccess === "off") {
        return undefined;
      }
      const service = await WorkspaceLspService.mount(
        context.workspace.dir,
        providers,
        {
          queryTimeoutMs: options.queryTimeoutMs,
          maximumLocations: options.maximumLocations,
          maximumHoverCharacters: options.maximumHoverCharacters,
        },
      );
      return {
        tools: [createLspNavigationTool(service, context.recordAction)],
        close: () => service.dispose(),
      };
    },
  });
}

export type LspNavigationCapabilityPackageOptions = LspNavigationCapabilityOptions & Readonly<{
  version: string;
  contentDigest: string;
  source: string;
  /** Explicit deployment trust; false keeps the package inventoried but inactive. */
  trusted: boolean;
  packageId?: string;
  packageName?: string;
}>;

/** Convenience wrapper for the P1 trusted-package/profile activation seam. */
export function createLspNavigationCapabilityPackage(
  options: LspNavigationCapabilityPackageOptions,
): AgentCapabilityPackage {
  return Object.freeze({
    id: options.packageId ?? "lsp-navigation",
    name: options.packageName ?? "LSP Code Navigation",
    version: options.version,
    contentDigest: options.contentDigest,
    source: options.source,
    trusted: options.trusted,
    capabilities: Object.freeze([createLspNavigationCapability(options)]),
  });
}
