import type { AppDatabase } from "../storage/database.js";

export const DEFAULT_UPLOAD_LIMIT_MIB = 100;
export const MAXIMUM_UPLOAD_LIMIT_MIB = 1024;

export class UploadSettingsValidationError extends Error {
  readonly code = "UPLOAD_SETTINGS_INVALID";
}

export class UploadSettingsService {
  constructor(private readonly database: AppDatabase) {}

  get() {
    const row = this.database.connection.prepare(
      "SELECT max_file_mib FROM file_upload_settings WHERE singleton = 1",
    ).get() as { max_file_mib: number } | undefined;
    const maxFileMiB = row?.max_file_mib ?? DEFAULT_UPLOAD_LIMIT_MIB;
    return { maxFileMiB, maxFileBytes: maxFileMiB * 1024 * 1024, maximumMiB: MAXIMUM_UPLOAD_LIMIT_MIB };
  }

  set(maxFileMiB: unknown) {
    if (typeof maxFileMiB !== "number" || !Number.isSafeInteger(maxFileMiB) ||
        maxFileMiB < 1 || maxFileMiB > MAXIMUM_UPLOAD_LIMIT_MIB) {
      throw new UploadSettingsValidationError(`上传上限必须是 1–${MAXIMUM_UPLOAD_LIMIT_MIB} MiB 的整数`);
    }
    this.database.connection.prepare(`
      INSERT INTO file_upload_settings(singleton, max_file_mib) VALUES (1, ?)
      ON CONFLICT(singleton) DO UPDATE SET max_file_mib = excluded.max_file_mib
    `).run(maxFileMiB);
    return this.get();
  }
}
