import type { ConversationSpace } from "../domain/types.js";

export type AgentModuleType = "mcp" | "skill";

export type WorkspaceAccess = "off" | "read_only" | "read_write";

export type AgentPermissions = {
  workspaceAccess: WorkspaceAccess;
  shellEnabled: boolean;
  networkEnabled: boolean;
  userProfileWriteEnabled: boolean;
  characterSoulWriteEnabled: boolean;
  characterSkillManageEnabled: boolean;
  realityMemoryWriteEnabled: boolean;
  characterMemoryWriteEnabled: boolean;
  workspaceDir: string;
  shellAvailable: boolean;
};

export type AgentPermissionsPatch = Partial<
  Pick<
    AgentPermissions,
    | "workspaceAccess"
    | "shellEnabled"
    | "networkEnabled"
    | "userProfileWriteEnabled"
    | "characterSoulWriteEnabled"
    | "characterSkillManageEnabled"
    | "realityMemoryWriteEnabled"
    | "characterMemoryWriteEnabled"
  >
>;

export type AgentModule = {
  id: string;
  type: AgentModuleType;
  name: string;
  description: string;
  source: string;
  enabled: boolean;
  enabledSpaces?: ConversationSpace[];
  defaultEnabled: boolean;
  estimatedTokens: number;
  fullContentEstimatedTokens?: number;
};

export type AgentModuleDetail = {
  module: AgentModule;
  format: "markdown";
  content: string;
};

export type AgentMcpContextContribution = Readonly<{
  order: number;
  enabled: string;
  disabled: string;
  availableSpaces?: readonly ConversationSpace[];
}>;

/**
 * Trusted, declarative product surface for one MCP-backed Agent module. The
 * generic boolean setting is owned by AgentModuleCatalog; runtime admission and
 * permission checks remain the capability's responsibility.
 */
export type AgentMcpModuleContribution = Readonly<{
  id: string;
  name: string;
  description: string;
  source: string;
  defaultEnabled: boolean;
  estimatedTokens: number;
  detail: string;
  context?: AgentMcpContextContribution;
}>;
