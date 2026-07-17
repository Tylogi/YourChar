export type AgentModuleType = "mcp" | "skill";

export type WorkspaceAccess = "off" | "read_only" | "read_write";

export type AgentPermissions = {
  workspaceAccess: WorkspaceAccess;
  shellEnabled: boolean;
  networkEnabled: boolean;
  userProfileWriteEnabled: boolean;
  characterSoulWriteEnabled: boolean;
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
  defaultEnabled: boolean;
  estimatedTokens: number;
  fullContentEstimatedTokens?: number;
};

export type AgentModuleDetail = {
  module: AgentModule;
  format: "markdown";
  content: string;
};
