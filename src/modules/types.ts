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
  /** The module owns a declarative provider-settings namespace. */
  hasSettings?: boolean;
  /** The generic module-detail renderer may expose the declared settings form. */
  settingsUi?: boolean;
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

export type AgentModuleSettingValue = string | number | boolean;

type AgentModuleSettingFieldBase = Readonly<{
  key: string;
  label: string;
  description?: string;
  required?: boolean;
}>;

export type AgentModuleTextSettingField = AgentModuleSettingFieldBase & Readonly<{
  kind: "text" | "secret";
  defaultValue?: string;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
}>;

export type AgentModuleNumberSettingField = AgentModuleSettingFieldBase & Readonly<{
  kind: "integer" | "number";
  defaultValue?: number;
  minimum?: number;
  maximum?: number;
  step?: number;
}>;

export type AgentModuleBooleanSettingField = AgentModuleSettingFieldBase & Readonly<{
  kind: "boolean";
  defaultValue: boolean;
}>;

export type AgentModuleSelectSettingField = AgentModuleSettingFieldBase & Readonly<{
  kind: "select";
  defaultValue?: string;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

export type AgentModuleSettingField =
  | AgentModuleTextSettingField
  | AgentModuleNumberSettingField
  | AgentModuleBooleanSettingField
  | AgentModuleSelectSettingField;

export type AgentModuleSettingsUi = Readonly<{
  /** P1c deliberately supports one host-rendered, sandbox-free UI slot. */
  slot: "module_detail";
  title?: string;
  description?: string;
  submitLabel?: string;
}>;

export type AgentModuleSettingsSchema = Readonly<{
  /** Package-owned schema revision; stored values are revalidated on every read. */
  version: number;
  fields: readonly AgentModuleSettingField[];
  /** Omit this to keep settings API/runtime-only with no generated browser form. */
  ui?: AgentModuleSettingsUi;
}>;

export type AgentModuleSettingsSnapshot = Readonly<{
  moduleId: string;
  schema: AgentModuleSettingsSchema;
  revision: number;
  updatedAt?: string;
  complete: boolean;
  /** Secret fields are always absent from this browser-safe value map. */
  values: Readonly<Record<string, AgentModuleSettingValue>>;
  secrets: Readonly<Record<string, Readonly<{ configured: boolean; masked: string }>>>;
}>;

export type AgentModuleSettingsPatch = Readonly<{
  expectedSchemaVersion: number;
  expectedRevision: number;
  values?: Readonly<Record<string, unknown>>;
  clear?: readonly string[];
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
  /** Declarative values scoped to this module and supplied only to its mount. */
  settings?: AgentModuleSettingsSchema;
}>;
