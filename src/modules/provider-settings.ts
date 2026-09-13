import type { Clock } from "../app/clock.js";
import type { AppDatabase } from "../storage/database.js";
import type {
  AgentModuleSettingField,
  AgentModuleSettingsPatch,
  AgentModuleSettingsSchema,
  AgentModuleSettingsSnapshot,
  AgentModuleSettingValue,
} from "./types.js";

const settingKeyPattern = /^[a-z][A-Za-z0-9_-]{0,63}$/u;
const maximumFields = 32;
const maximumOptions = 64;
const maximumTextLength = 8_192;
const maximumSchemaCharacters = 64_000;
const maximumValuesCharacters = 64_000;
const emptySettings = Object.freeze({}) as Readonly<Record<string, AgentModuleSettingValue>>;

type SettingsRow = {
  revision: number;
  values_json: string;
  updated_at: string;
};

export class AgentModuleSettingsValidationError extends Error {
  readonly code = "AGENT_MODULE_SETTINGS_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AgentModuleSettingsValidationError";
  }
}

export class AgentModuleSettingsConflictError extends Error {
  readonly code = "AGENT_MODULE_SETTINGS_CONFLICT";

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(
      `Agent module settings revision conflict: expected ${expectedRevision}, current ${actualRevision}`,
    );
    this.name = "AgentModuleSettingsConflictError";
  }
}

export class AgentModuleSettingsSchemaConflictError extends Error {
  readonly code = "AGENT_MODULE_SETTINGS_SCHEMA_CONFLICT";

  constructor(
    readonly expectedSchemaVersion: number,
    readonly actualSchemaVersion: number,
  ) {
    super(
      `Agent module settings schema conflict: expected ${expectedSchemaVersion}, current ${actualSchemaVersion}`,
    );
    this.name = "AgentModuleSettingsSchemaConflictError";
  }
}

export class AgentModuleSettingsUnavailableError extends Error {
  readonly code = "AGENT_MODULE_SETTINGS_UNAVAILABLE";

  constructor(moduleId: string) {
    super(`Agent module does not declare provider settings: ${moduleId}`);
    this.name = "AgentModuleSettingsUnavailableError";
  }
}

/**
 * Validate and detach the declarative subset that may cross the HTTP/UI
 * boundary. No callbacks, markup, arbitrary JSON Schema keywords, or custom
 * browser code survive normalization.
 */
export function normalizeAgentModuleSettingsSchema(
  input: AgentModuleSettingsSchema,
  moduleId: string,
): AgentModuleSettingsSchema {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidSchema(moduleId, "must be an object");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version > 1_000_000) {
    throw invalidSchema(moduleId, "version must be a positive safe integer");
  }
  if (!Array.isArray(input.fields) || input.fields.length < 1) {
    throw invalidSchema(moduleId, "must contain at least one field");
  }
  if (input.fields.length > maximumFields) {
    throw invalidSchema(moduleId, `exceeds ${maximumFields} fields`);
  }
  const keys = new Set<string>();
  const fields = Object.freeze(input.fields.map((field) => {
    const normalized = normalizeField(field, moduleId);
    if (keys.has(normalized.key)) {
      throw invalidSchema(moduleId, `contains duplicate field ${normalized.key}`);
    }
    keys.add(normalized.key);
    return normalized;
  }));
  const ui = input.ui === undefined ? undefined : normalizeUi(input.ui, moduleId);
  const schema = Object.freeze({
    version: input.version,
    fields,
    ...(ui ? { ui } : {}),
  });
  if ([...JSON.stringify(schema)].length > maximumSchemaCharacters) {
    throw invalidSchema(moduleId, `exceeds ${maximumSchemaCharacters} characters`);
  }
  return schema;
}

export class AgentModuleSettingsRepository {
  constructor(
    private readonly database: AppDatabase,
    private readonly clock: Clock,
  ) {}

  snapshot(moduleId: string, schema: AgentModuleSettingsSchema): AgentModuleSettingsSnapshot {
    const row = this.read(moduleId);
    return settingsSnapshot(moduleId, schema, this.explicitValues(row, schema), row);
  }

  resolvedValues(
    moduleId: string,
    schema: AgentModuleSettingsSchema,
  ): Readonly<Record<string, AgentModuleSettingValue>> {
    const explicit = this.explicitValues(this.read(moduleId), schema);
    const resolved: Record<string, AgentModuleSettingValue> = {};
    for (const field of schema.fields) {
      const value = Object.hasOwn(explicit, field.key)
        ? explicit[field.key]
        : field.defaultValue;
      if (value !== undefined) resolved[field.key] = value;
    }
    return Object.freeze(resolved);
  }

  patch(
    moduleId: string,
    schema: AgentModuleSettingsSchema,
    patch: AgentModuleSettingsPatch,
  ): AgentModuleSettingsSnapshot {
    validatePatchShell(patch);
    if (patch.expectedSchemaVersion !== schema.version) {
      throw new AgentModuleSettingsSchemaConflictError(
        patch.expectedSchemaVersion,
        schema.version,
      );
    }
    this.database.transaction(() => {
      const row = this.read(moduleId);
      const actualRevision = row ? Number(row.revision) : 0;
      if (patch.expectedRevision !== actualRevision) {
        throw new AgentModuleSettingsConflictError(patch.expectedRevision, actualRevision);
      }
      const fields = new Map(schema.fields.map((field) => [field.key, field]));
      const valuesInput = patch.values ?? {};
      if (!valuesInput || typeof valuesInput !== "object" || Array.isArray(valuesInput)) {
        throw new AgentModuleSettingsValidationError("settings values must be an object");
      }
      const clear = patch.clear === undefined ? [] : [...patch.clear];
      if (clear.length > maximumFields || new Set(clear).size !== clear.length) {
        throw new AgentModuleSettingsValidationError(
          `settings clear must contain at most ${maximumFields} unique keys`,
        );
      }
      const next = { ...this.explicitValues(row, schema) };
      for (const key of clear) {
        if (typeof key !== "string" || !fields.has(key)) {
          throw new AgentModuleSettingsValidationError(`unknown settings field: ${String(key)}`);
        }
        if (Object.hasOwn(valuesInput, key)) {
          throw new AgentModuleSettingsValidationError(
            `settings field ${key} cannot be changed and cleared together`,
          );
        }
        delete next[key];
      }
      const valueKeys = Object.keys(valuesInput);
      if (valueKeys.length > maximumFields) {
        throw new AgentModuleSettingsValidationError(
          `settings values exceed ${maximumFields} fields`,
        );
      }
      for (const key of valueKeys) {
        const field = fields.get(key);
        if (!field) {
          throw new AgentModuleSettingsValidationError(`unknown settings field: ${key}`);
        }
        next[key] = validateSettingValue(field, valuesInput[key]);
      }
      const valuesJson = orderedValuesJson(schema, next);
      if ([...valuesJson].length > maximumValuesCharacters) {
        throw new AgentModuleSettingsValidationError(
          `settings values exceed ${maximumValuesCharacters} characters`,
        );
      }
      if (row && valuesJson === orderedValuesJson(schema, this.explicitValues(row, schema))) {
        return;
      }
      if (!row && valuesJson === "{}") return;
      const revision = actualRevision + 1;
      const updatedAt = this.clock.now().toISOString();
      this.database.connection.prepare(`
        INSERT INTO agent_module_provider_settings(module_id, revision, values_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(module_id) DO UPDATE SET
          revision = excluded.revision,
          values_json = excluded.values_json,
          updated_at = excluded.updated_at
      `).run(moduleId, revision, valuesJson, updatedAt);
    });
    return this.snapshot(moduleId, schema);
  }

  private explicitValues(
    row: SettingsRow | undefined,
    schema: AgentModuleSettingsSchema,
  ): Readonly<Record<string, AgentModuleSettingValue>> {
    if (!row) return emptySettings;
    if (row.values_json.length > maximumValuesCharacters * 2) return emptySettings;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.values_json);
    } catch {
      return emptySettings;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptySettings;
    const raw = parsed as Record<string, unknown>;
    const output: Record<string, AgentModuleSettingValue> = {};
    for (const field of schema.fields) {
      if (!Object.hasOwn(raw, field.key)) continue;
      try {
        output[field.key] = validateSettingValue(field, raw[field.key]);
      } catch {
        // Persisted data is never trusted merely because an older schema wrote
        // it. Invalid or incompatible values fail closed and remain invisible.
      }
    }
    if ([...orderedValuesJson(schema, output)].length > maximumValuesCharacters) {
      return emptySettings;
    }
    return Object.freeze(output);
  }

  private read(moduleId: string): SettingsRow | undefined {
    return this.database.connection.prepare(`
      SELECT revision, values_json, updated_at
      FROM agent_module_provider_settings
      WHERE module_id = ?
    `).get(moduleId) as SettingsRow | undefined;
  }
}

function normalizeField(
  input: AgentModuleSettingField,
  moduleId: string,
): AgentModuleSettingField {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidSchema(moduleId, "field must be an object");
  }
  const key = boundedString(input.key, `${moduleId} settings field key`, 64);
  if (
    !settingKeyPattern.test(key) ||
    key === "prototype" ||
    Object.hasOwn(Object.prototype, key)
  ) {
    throw invalidSchema(moduleId, `contains invalid field key ${key}`);
  }
  if (input.required !== undefined && typeof input.required !== "boolean") {
    throw invalidSchema(moduleId, `field ${key} required must be boolean`);
  }
  const base = {
    key,
    label: boundedString(input.label, `${moduleId} settings field ${key} label`, 120),
    ...(input.description === undefined
      ? {}
      : { description: boundedString(input.description, `${moduleId} settings field ${key} description`, 1_000) }),
    ...(input.required === undefined ? {} : { required: input.required }),
  };
  if (input.kind === "text" || input.kind === "secret") {
    const minLength = boundedOptionalInteger(input.minLength, 1, maximumTextLength,
      `${moduleId} settings field ${key} minLength`);
    const maxLength = boundedOptionalInteger(input.maxLength, 1, maximumTextLength,
      `${moduleId} settings field ${key} maxLength`);
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      throw invalidSchema(moduleId, `field ${key} minLength exceeds maxLength`);
    }
    if (input.kind === "secret" && input.defaultValue !== undefined) {
      throw invalidSchema(moduleId, `secret field ${key} cannot declare a default value`);
    }
    const field = Object.freeze({
      ...base,
      kind: input.kind,
      ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
      ...(input.placeholder === undefined
        ? {}
        : { placeholder: boundedString(input.placeholder, `${moduleId} settings field ${key} placeholder`, 300) }),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
    }) as AgentModuleSettingField;
    if (input.defaultValue !== undefined) validateSettingValue(field, input.defaultValue);
    return field;
  }
  if (input.kind === "integer" || input.kind === "number") {
    const minimum = boundedOptionalNumber(input.minimum, `${moduleId} settings field ${key} minimum`);
    const maximum = boundedOptionalNumber(input.maximum, `${moduleId} settings field ${key} maximum`);
    const step = boundedOptionalNumber(input.step, `${moduleId} settings field ${key} step`);
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw invalidSchema(moduleId, `field ${key} minimum exceeds maximum`);
    }
    if (step !== undefined && step <= 0) {
      throw invalidSchema(moduleId, `field ${key} step must be positive`);
    }
    const field = Object.freeze({
      ...base,
      kind: input.kind,
      ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(step === undefined ? {} : { step }),
    }) as AgentModuleSettingField;
    if (input.defaultValue !== undefined) validateSettingValue(field, input.defaultValue);
    return field;
  }
  if (input.kind === "boolean") {
    if (typeof input.defaultValue !== "boolean") {
      throw invalidSchema(moduleId, `field ${key} must declare a boolean default value`);
    }
    return Object.freeze({
      ...base,
      kind: "boolean" as const,
      defaultValue: input.defaultValue,
    });
  }
  if (input.kind === "select") {
    if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > maximumOptions) {
      throw invalidSchema(moduleId, `field ${key} must contain 1-${maximumOptions} options`);
    }
    const optionValues = new Set<string>();
    const options = Object.freeze(input.options.map((option) => {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        throw invalidSchema(moduleId, `field ${key} option must be an object`);
      }
      const value = boundedString(option.value, `${moduleId} settings field ${key} option value`, 200);
      if (optionValues.has(value)) {
        throw invalidSchema(moduleId, `field ${key} contains duplicate option ${value}`);
      }
      optionValues.add(value);
      return Object.freeze({
        value,
        label: boundedString(option.label, `${moduleId} settings field ${key} option label`, 200),
      });
    }));
    const field = Object.freeze({
      ...base,
      kind: "select" as const,
      options,
      ...(input.defaultValue === undefined ? {} : { defaultValue: input.defaultValue }),
    });
    if (input.defaultValue !== undefined) validateSettingValue(field, input.defaultValue);
    return field;
  }
  throw invalidSchema(moduleId, `field ${key} has an unsupported kind`);
}

function normalizeUi(
  input: NonNullable<AgentModuleSettingsSchema["ui"]>,
  moduleId: string,
) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidSchema(moduleId, "UI declaration must be an object");
  }
  if (input.slot !== "module_detail") {
    throw invalidSchema(moduleId, "UI slot must be module_detail");
  }
  return Object.freeze({
    slot: "module_detail" as const,
    ...(input.title === undefined
      ? {}
      : { title: boundedString(input.title, `${moduleId} settings UI title`, 200) }),
    ...(input.description === undefined
      ? {}
      : { description: boundedString(input.description, `${moduleId} settings UI description`, 2_000) }),
    ...(input.submitLabel === undefined
      ? {}
      : { submitLabel: boundedString(input.submitLabel, `${moduleId} settings UI submit label`, 80) }),
  });
}

function validateSettingValue(
  field: AgentModuleSettingField,
  value: unknown,
): AgentModuleSettingValue {
  if (field.kind === "text" || field.kind === "secret") {
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} must be non-empty text`);
    }
    if (field.kind === "text" && value !== value.trim()) {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} must be trimmed`);
    }
    const length = [...value].length;
    const minimum = field.minLength ?? 0;
    const maximum = field.maxLength ?? maximumTextLength;
    if (length < minimum || length > maximum) {
      throw new AgentModuleSettingsValidationError(
        `settings field ${field.key} must contain ${minimum}-${maximum} characters`,
      );
    }
    return value;
  }
  if (field.kind === "integer" || field.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} must be a finite number`);
    }
    if (field.kind === "integer" && !Number.isSafeInteger(value)) {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} must be a safe integer`);
    }
    if (field.minimum !== undefined && value < field.minimum) {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} is below its minimum`);
    }
    if (field.maximum !== undefined && value > field.maximum) {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} exceeds its maximum`);
    }
    if (field.step !== undefined) {
      const origin = field.minimum ?? 0;
      const steps = (value - origin) / field.step;
      if (Math.abs(steps - Math.round(steps)) > 1e-9) {
        throw new AgentModuleSettingsValidationError(`settings field ${field.key} does not match its step`);
      }
    }
    return value;
  }
  if (field.kind === "boolean") {
    if (typeof value !== "boolean") {
      throw new AgentModuleSettingsValidationError(`settings field ${field.key} must be boolean`);
    }
    return value;
  }
  if (field.kind !== "select") {
    throw new AgentModuleSettingsValidationError(`settings field ${field.key} has an unsupported kind`);
  }
  if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
    throw new AgentModuleSettingsValidationError(`settings field ${field.key} is not an allowed option`);
  }
  return value;
}

function settingsSnapshot(
  moduleId: string,
  schema: AgentModuleSettingsSchema,
  explicit: Readonly<Record<string, AgentModuleSettingValue>>,
  row?: SettingsRow,
): AgentModuleSettingsSnapshot {
  const values: Record<string, AgentModuleSettingValue> = {};
  const secrets: Record<string, Readonly<{ configured: boolean; masked: string }>> = {};
  let complete = true;
  for (const field of schema.fields) {
    const value = Object.hasOwn(explicit, field.key)
      ? explicit[field.key]
      : field.defaultValue;
    if (field.kind === "secret") {
      const configured = typeof value === "string" && value.length > 0;
      secrets[field.key] = Object.freeze({
        configured,
        masked: configured ? "••••••••" : "",
      });
      if (field.required && !configured) complete = false;
    } else {
      if (value !== undefined) values[field.key] = value;
      if (field.required && value === undefined) complete = false;
    }
  }
  return Object.freeze({
    moduleId,
    schema,
    revision: row ? Number(row.revision) : 0,
    ...(row ? { updatedAt: row.updated_at } : {}),
    complete,
    values: Object.freeze(values),
    secrets: Object.freeze(secrets),
  });
}

function validatePatchShell(patch: AgentModuleSettingsPatch): void {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new AgentModuleSettingsValidationError("settings patch must be an object");
  }
  if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0) {
    throw new AgentModuleSettingsValidationError(
      "settings expectedRevision must be a non-negative safe integer",
    );
  }
  if (!Number.isSafeInteger(patch.expectedSchemaVersion) || patch.expectedSchemaVersion < 1) {
    throw new AgentModuleSettingsValidationError(
      "settings expectedSchemaVersion must be a positive safe integer",
    );
  }
  if (patch.clear !== undefined && !Array.isArray(patch.clear)) {
    throw new AgentModuleSettingsValidationError("settings clear must be an array");
  }
}

function orderedValuesJson(
  schema: AgentModuleSettingsSchema,
  values: Readonly<Record<string, AgentModuleSettingValue>>,
): string {
  const ordered: Record<string, AgentModuleSettingValue> = {};
  for (const field of schema.fields) {
    if (Object.hasOwn(values, field.key)) ordered[field.key] = values[field.key]!;
  }
  return JSON.stringify(ordered);
}

function boundedString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new AgentModuleSettingsValidationError(`${field} must be non-empty trimmed text`);
  }
  if ([...value].length > maximum) {
    throw new AgentModuleSettingsValidationError(`${field} exceeds ${maximum} characters`);
  }
  return value;
}

function boundedOptionalInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new AgentModuleSettingsValidationError(
      `${field} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

function boundedOptionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AgentModuleSettingsValidationError(`${field} must be a finite number`);
  }
  return value;
}

function invalidSchema(moduleId: string, detail: string): AgentModuleSettingsValidationError {
  return new AgentModuleSettingsValidationError(
    `Agent module ${moduleId} settings schema ${detail}`,
  );
}
