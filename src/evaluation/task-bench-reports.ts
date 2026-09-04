import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  type Dirent,
} from "node:fs";
import { join, resolve } from "node:path";
import type { AppDatabase } from "../storage/database.js";
import {
  renderTaskBenchMarkdown,
  type TaskBenchReport,
  type TaskBenchSummary,
} from "./task-bench.js";

const maximumListedReports = 100;
const maximumLegacyReportBytes = 8 * 1024 * 1024;
const legacyWorkspaceImportName = "workspace-exports-v1";

export type TaskBenchReportSummary = {
  version: 1;
  id: string;
  ranAt: string;
  name: string;
  targetMode: TaskBenchReport["targetMode"];
  target: TaskBenchReport["target"];
  character?: TaskBenchReport["character"];
  judge: TaskBenchReport["judge"];
  summary: TaskBenchSummary;
};

export type StoredTaskBenchResult = {
  report: TaskBenchReport;
  markdown: string;
};

/**
 * Durable task-bench report storage. Full reports live in the application
 * database so browser refreshes and API-initiated runs share one history.
 */
export class TaskBenchReportRepository {
  constructor(
    private readonly database: AppDatabase,
    options: { stateDir?: string } = {},
  ) {
    this.importLegacyWorkspaceExports(options.stateDir);
  }

  save(result: StoredTaskBenchResult): void {
    const report = requireTaskBenchReport(result.report);
    const now = new Date().toISOString();
    this.database.connection.prepare(`
      INSERT INTO task_bench_reports(
        id, ran_at, name, report_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ran_at = excluded.ran_at,
        name = excluded.name,
        report_json = excluded.report_json,
        updated_at = excluded.updated_at
    `).run(
      report.id,
      report.ranAt,
      report.name,
      JSON.stringify(report),
      now,
      now,
    );
  }

  list(limit = 20): TaskBenchReportSummary[] {
    const bounded = Math.min(Math.max(Math.floor(limit), 1), maximumListedReports);
    const rows = this.database.connection.prepare(`
      SELECT report_json
      FROM task_bench_reports
      ORDER BY ran_at DESC, id DESC
      LIMIT ?
    `).all(bounded) as Array<{ report_json?: unknown }>;
    return rows.flatMap((row) => {
      const report = parseStoredReport(row.report_json);
      return report ? [summarizeReport(report)] : [];
    });
  }

  get(id: string): StoredTaskBenchResult | undefined {
    const row = this.database.connection.prepare(`
      SELECT report_json
      FROM task_bench_reports
      WHERE id = ?
    `).get(id) as { report_json?: unknown } | undefined;
    const report = parseStoredReport(row?.report_json);
    return report ? { report, markdown: renderTaskBenchMarkdown(report) } : undefined;
  }

  private importLegacyWorkspaceExports(stateDir: string | undefined): void {
    if (!stateDir) return;
    const imported = this.database.connection.prepare(`
      SELECT 1 AS present
      FROM task_bench_report_migrations
      WHERE name = ?
    `).get(legacyWorkspaceImportName);
    if (imported) return;
    const directory = join(resolve(stateDir), "workspace", "task-bench-results");
    const reports: TaskBenchReport[] = [];
    if (existsSync(directory)) {
      let entries: Array<Dirent<string>>;
      try {
        entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const path = join(directory, entry.name);
          const stats = lstatSync(path);
          if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maximumLegacyReportBytes) continue;
          const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
          const candidate = isRecord(parsed) && "report" in parsed ? parsed.report : parsed;
          const report = parseTaskBenchReport(candidate);
          if (report) reports.push(report);
        } catch {
          // A malformed manual export must not prevent the local service starting.
        }
      }
    }
    this.database.transaction(() => {
      const alreadyImported = this.database.connection.prepare(`
        SELECT 1 AS present
        FROM task_bench_report_migrations
        WHERE name = ?
      `).get(legacyWorkspaceImportName);
      if (alreadyImported) return;
      const insert = this.database.connection.prepare(`
        INSERT OR IGNORE INTO task_bench_reports(
          id, ran_at, name, report_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      for (const report of reports) {
        insert.run(
          report.id,
          report.ranAt,
          report.name,
          JSON.stringify(report),
          now,
          now,
        );
      }
      this.database.connection.prepare(`
        INSERT INTO task_bench_report_migrations(name, completed_at)
        VALUES (?, ?)
      `).run(legacyWorkspaceImportName, now);
    });
  }
}

function summarizeReport(report: TaskBenchReport): TaskBenchReportSummary {
  return {
    version: 1,
    id: report.id,
    ranAt: report.ranAt,
    name: report.name,
    targetMode: report.targetMode,
    target: report.target,
    ...(report.character ? { character: report.character } : {}),
    judge: report.judge,
    summary: report.summary,
  };
}

function parseStoredReport(value: unknown): TaskBenchReport | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return parseTaskBenchReport(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function requireTaskBenchReport(value: unknown): TaskBenchReport {
  const report = parseTaskBenchReport(value);
  if (!report) throw new Error("invalid task-bench report");
  return report;
}

function parseTaskBenchReport(value: unknown): TaskBenchReport | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    value.id.length < 1 ||
    value.id.length > 300 ||
    typeof value.ranAt !== "string" ||
    !Number.isFinite(Date.parse(value.ranAt)) ||
    typeof value.name !== "string" ||
    (value.targetMode !== "model" && value.targetMode !== "character") ||
    !isRecord(value.target) ||
    !isRecord(value.summary) ||
    !Array.isArray(value.runs) ||
    !Array.isArray(value.fixtures)
  ) return undefined;
  return value as TaskBenchReport;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
