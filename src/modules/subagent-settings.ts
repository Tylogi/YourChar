import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";

export type SubagentSettingsValues = {
  maxConcurrentTasks: number;
  maxWorkModelCalls: number;
  maxOutputTokens: number;
  maxResultCharacters: number;
  timeoutSeconds: number;
};

export type SubagentSettings = SubagentSettingsValues & {
  revision: number;
  updatedAt: string;
};

export type SubagentSettingsPatch = Partial<SubagentSettingsValues>;

export type SubagentSettingsSnapshot = Readonly<SubagentSettingsValues>;

export const defaultSubagentSettings: Readonly<SubagentSettingsValues> = Object.freeze({
  maxConcurrentTasks: 4,
  maxWorkModelCalls: 32,
  maxOutputTokens: 16_384,
  maxResultCharacters: 64_000,
  timeoutSeconds: 1_800,
});

export const maximumSubagentSettings: Readonly<SubagentSettingsValues> = Object.freeze({
  maxConcurrentTasks: 8,
  maxWorkModelCalls: 64,
  maxOutputTokens: 65_536,
  maxResultCharacters: 200_000,
  timeoutSeconds: 3_600,
});

export const minimumSubagentSettings: Readonly<SubagentSettingsValues> = Object.freeze({
  maxConcurrentTasks: 1,
  maxWorkModelCalls: 1,
  maxOutputTokens: 512,
  maxResultCharacters: 1_000,
  timeoutSeconds: 60,
});

const settingKeys = [
  "maxConcurrentTasks",
  "maxWorkModelCalls",
  "maxOutputTokens",
  "maxResultCharacters",
  "timeoutSeconds",
] as const satisfies readonly (keyof SubagentSettingsValues)[];
const settingKeySet = new Set<string>(settingKeys);

export class SubagentSettingsValidationError extends Error {
  readonly code = "SUBAGENT_SETTINGS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SubagentSettingsValidationError";
  }
}

export class SubagentSettingsConflictError extends Error {
  readonly code = "SUBAGENT_SETTINGS_CONFLICT";
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(expectedRevision: number, actualRevision: number) {
    super(
      `Subagent settings revision conflict: expected ${expectedRevision}, current ${actualRevision}`,
    );
    this.name = "SubagentSettingsConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class SubagentSettingsService {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
  ) {}

  get(): SubagentSettings {
    const row = this.database.connection.prepare(`
      SELECT
        max_concurrent_tasks,
        max_work_model_calls,
        max_output_tokens,
        max_result_characters,
        timeout_seconds,
        revision,
        updated_at
      FROM subagent_runtime_settings
      WHERE singleton = 1
    `).get() as SubagentSettingsRow | undefined;
    if (!row) throw new Error("Subagent runtime settings are missing");
    return mapSubagentSettings(row);
  }

  patch(patch: SubagentSettingsPatch, expectedRevision: number): SubagentSettings {
    assertExpectedRevision(expectedRevision);
    const validated = validateSubagentSettingsPatch(patch);
    return this.database.transaction(() => {
      const current = this.get();
      if (current.revision !== expectedRevision) {
        throw new SubagentSettingsConflictError(expectedRevision, current.revision);
      }
      if (!Object.keys(validated).length) return current;
      const next = { ...current, ...validated };
      const updatedAt = this.clock.now().toISOString();
      const result = this.database.connection.prepare(`
        UPDATE subagent_runtime_settings
        SET
          max_concurrent_tasks = ?,
          max_work_model_calls = ?,
          max_output_tokens = ?,
          max_result_characters = ?,
          timeout_seconds = ?,
          revision = revision + 1,
          updated_at = ?
        WHERE singleton = 1 AND revision = ?
      `).run(
        next.maxConcurrentTasks,
        next.maxWorkModelCalls,
        next.maxOutputTokens,
        next.maxResultCharacters,
        next.timeoutSeconds,
        updatedAt,
        expectedRevision,
      );
      if (Number(result.changes) !== 1) {
        const actual = this.get().revision;
        throw new SubagentSettingsConflictError(expectedRevision, actual);
      }
      return this.get();
    });
  }

  snapshot(): SubagentSettingsSnapshot {
    return freezeSubagentSettingsSnapshot(this.get());
  }
}

export function freezeSubagentSettingsSnapshot(
  settings: SubagentSettingsValues,
): SubagentSettingsSnapshot {
  const snapshot: SubagentSettingsValues = {
    maxConcurrentTasks: settings.maxConcurrentTasks,
    maxWorkModelCalls: settings.maxWorkModelCalls,
    maxOutputTokens: settings.maxOutputTokens,
    maxResultCharacters: settings.maxResultCharacters,
    timeoutSeconds: settings.timeoutSeconds,
  };
  assertCompleteSubagentSettings(snapshot);
  return Object.freeze(snapshot);
}

function validateSubagentSettingsPatch(
  patch: SubagentSettingsPatch,
): SubagentSettingsPatch {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SubagentSettingsValidationError("Subagent settings patch must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!settingKeySet.has(key)) {
      throw new SubagentSettingsValidationError(`Unknown Subagent setting: ${key}`);
    }
  }
  const validated: SubagentSettingsPatch = {};
  for (const key of settingKeys) {
    const value = patch[key];
    if (value === undefined) continue;
    if (
      !Number.isSafeInteger(value) ||
      value < minimumSubagentSettings[key] ||
      value > maximumSubagentSettings[key]
    ) {
      throw new SubagentSettingsValidationError(
        `${key} must be an integer between ${minimumSubagentSettings[key]} and ${maximumSubagentSettings[key]}`,
      );
    }
    validated[key] = value;
  }
  return validated;
}

function assertCompleteSubagentSettings(settings: SubagentSettingsValues): void {
  validateSubagentSettingsPatch(settings);
  for (const key of settingKeys) {
    if (settings[key] === undefined) {
      throw new SubagentSettingsValidationError(`Missing Subagent setting: ${key}`);
    }
  }
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SubagentSettingsValidationError("expectedRevision must be a non-negative integer");
  }
}

type SubagentSettingsRow = {
  max_concurrent_tasks: number;
  max_work_model_calls: number;
  max_output_tokens: number;
  max_result_characters: number;
  timeout_seconds: number;
  revision: number;
  updated_at: string;
};

function mapSubagentSettings(row: SubagentSettingsRow): SubagentSettings {
  return {
    maxConcurrentTasks: Number(row.max_concurrent_tasks),
    maxWorkModelCalls: Number(row.max_work_model_calls),
    maxOutputTokens: Number(row.max_output_tokens),
    maxResultCharacters: Number(row.max_result_characters),
    timeoutSeconds: Number(row.timeout_seconds),
    revision: Number(row.revision),
    updatedAt: String(row.updated_at),
  };
}
