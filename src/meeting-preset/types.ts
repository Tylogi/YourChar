export type MeetingPresetRole = "system" | "user" | "assistant";

export type MeetingPresetPromptPosition = "relative" | "in_chat";

export type MeetingPresetPrompt = {
  id: string;
  identifier: string;
  name: string;
  role: MeetingPresetRole;
  content: string;
  enabled: boolean;
  marker: boolean;
  position: MeetingPresetPromptPosition;
  depth: number;
  order: number;
  triggers: string[];
  sourceIndex: number;
};

export type MeetingPresetParameters = {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  seed?: number;
};

export type MeetingPresetImportInfo = {
  promptOrderCharacterId?: string;
  availablePromptOrders: Array<{
    characterId: string;
    promptCount: number;
    enabledPromptCount: number;
  }>;
  sourcePromptCount: number;
  ignoredExtensionKeys: string[];
  unsupportedParameterKeys: string[];
  warnings: string[];
};

export type MeetingPreset = {
  id: string;
  name: string;
  format: "sillytavern_openai";
  parametersEnabled: boolean;
  parameters: MeetingPresetParameters;
  prompts: MeetingPresetPrompt[];
  importInfo: MeetingPresetImportInfo;
  createdAt: string;
  updatedAt: string;
};

export type MeetingPresetSummary = Omit<MeetingPreset, "prompts"> & {
  promptCount: number;
  enabledPromptCount: number;
};

export type ImportMeetingPresetInput = {
  name: string;
  source: unknown;
  promptOrderCharacterId?: string | number;
};

export type MeetingPresetPromptPatch = {
  id: string;
  name?: string;
  role?: MeetingPresetRole;
  content?: string;
  enabled?: boolean;
};

export type UpdateMeetingPresetInput = {
  name?: string;
  parametersEnabled?: boolean;
  parameters?: Partial<MeetingPresetParameters>;
  prompts?: MeetingPresetPromptPatch[];
};

export type MeetingPresetProviderOverrides = {
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  maxTokens?: number;
  seed?: number;
};
