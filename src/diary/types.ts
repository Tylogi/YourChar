import type { MeetingPreset } from "../meeting-preset/types.js";

export type DiarySource = {
  kind: "activity" | "interaction" | "world_event";
  id: string;
  characterId: string;
  characterName: string;
  worldId: string;
  worldName: string;
  timezone: string;
  title: string;
  occurredAt: string;
  soul: string;
  // Only this character's knowledge; never the world's omniscient transcript.
  observations: string[];
  statements: Array<{ characterId: string; name: string; text: string }>;
};

export type DiaryMemoryPoint = {
  kind: "fact" | "interpretation" | "open_thread";
  text: string;
  evidence: string;
};

export type RomanceDecision = {
  subjectCharacterId: string;
  objectCharacterId: string;
  event: "interest" | "confirm" | "decline" | "commit" | "breakup" | "reconcile";
  subjectEvidence: string;
  objectEvidence?: string;
  confidence: number;
};

export type DiaryMemory = { points: DiaryMemoryPoint[]; relationships: RomanceDecision[] };
export type DiaryJobKind = "memory" | "narrative";
export type DiaryJobStatus = "pending" | "running" | "ready" | "failed" | "paused";
export type DiarySettings = {
  narrativeEnabled: boolean;
  /** Optional, diary-only writing instructions; retained for existing users. */
  preset: string;
  presetMode: "inherit" | "custom" | "none";
  presetId: string | null;
};
export type DiarySettingsPatch = Pick<DiarySettings, "narrativeEnabled" | "preset"> & Partial<Pick<DiarySettings, "presetMode" | "presetId">>;
export type DiaryEntry = {
  id: string;
  characterId: string;
  worldId: string;
  title: string;
  occurredAt: string;
  source: DiarySource;
  invalidated: boolean;
  memory?: DiaryMemory;
  narrative?: string;
  jobs: Array<{ kind: DiaryJobKind; status: DiaryJobStatus; error?: string }>;
};
export type DiaryGenerator = (input: {
  kind: DiaryJobKind;
  source: DiarySource;
  preset: string;
  narrativePreset?: MeetingPreset;
  signal: AbortSignal;
}) => Promise<unknown>;
