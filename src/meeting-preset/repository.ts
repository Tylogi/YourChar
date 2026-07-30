import type { AppDatabase } from "../storage/database.js";
import type { MeetingPreset } from "./types.js";

type Row = Record<string, unknown>;

export class MeetingPresetRepository {
  constructor(readonly database: AppDatabase) {}

  create(preset: MeetingPreset): MeetingPreset {
    this.database.connection.prepare(`
      INSERT INTO meeting_presets(
        id, name, format, data_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      preset.id,
      preset.name,
      preset.format,
      JSON.stringify(storedData(preset)),
      preset.createdAt,
      preset.updatedAt,
    );
    return preset;
  }

  get(id: string): MeetingPreset | undefined {
    const row = this.database.connection.prepare(
      "SELECT * FROM meeting_presets WHERE id = ?",
    ).get(id) as Row | undefined;
    return row ? mapPreset(row) : undefined;
  }

  list(): MeetingPreset[] {
    return (this.database.connection.prepare(
      "SELECT * FROM meeting_presets ORDER BY updated_at DESC, name, id",
    ).all() as Row[]).map(mapPreset);
  }

  update(preset: MeetingPreset): MeetingPreset {
    this.database.connection.prepare(`
      UPDATE meeting_presets
      SET name = ?, data_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      preset.name,
      JSON.stringify(storedData(preset)),
      preset.updatedAt,
      preset.id,
    );
    return preset;
  }

  delete(id: string): boolean {
    return Number(this.database.connection.prepare(
      "DELETE FROM meeting_presets WHERE id = ?",
    ).run(id).changes) > 0;
  }
}

function storedData(preset: MeetingPreset): Omit<
  MeetingPreset,
  "id" | "name" | "format" | "createdAt" | "updatedAt"
> {
  return {
    parametersEnabled: preset.parametersEnabled,
    parameters: preset.parameters,
    prompts: preset.prompts,
    importInfo: preset.importInfo,
  };
}

function mapPreset(row: Row): MeetingPreset {
  const data = parseStoredData(row.data_json);
  return {
    id: String(row.id),
    name: String(row.name),
    format: "sillytavern_openai",
    parametersEnabled: data.parametersEnabled,
    parameters: data.parameters,
    prompts: data.prompts,
    importInfo: data.importInfo,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function parseStoredData(value: unknown): ReturnType<typeof storedData> {
  if (typeof value !== "string") throw new Error("meeting preset data is corrupt");
  const parsed = JSON.parse(value) as ReturnType<typeof storedData>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.prompts) ||
    !parsed.importInfo ||
    typeof parsed.importInfo !== "object"
  ) {
    throw new Error("meeting preset data is corrupt");
  }
  return parsed;
}
