import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TaskBenchReportRepository,
} from "../src/evaluation/task-bench-reports.js";
import type { TaskBenchReport } from "../src/evaluation/task-bench.js";
import { DataManagementRepository } from "../src/storage/data-management.js";
import { AppDatabase } from "../src/storage/database.js";

test("task-bench reports persist across restart and import prior Workspace exports once", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-task-bench-reports-"));
  const databasePath = join(stateDir, "rp-agent.sqlite");
  const exportDirectory = join(stateDir, "workspace", "task-bench-results");
  mkdirSync(exportDirectory, { recursive: true });
  const legacy = sampleReport(
    "task-bench-legacy",
    "2026-09-03T18:40:22.136Z",
    "旧版导出评测",
    93,
  );
  writeFileSync(join(exportDirectory, "legacy.json"), JSON.stringify(legacy), "utf8");

  let database: AppDatabase | undefined;
  try {
    database = new AppDatabase(databasePath);
    let reports = new TaskBenchReportRepository(database, { stateDir });
    assert.deepEqual(reports.list().map((entry) => entry.id), [legacy.id]);

    const current = sampleReport(
      "task-bench-current",
      "2026-09-04T08:00:00.000Z",
      "API 评测",
      88,
    );
    reports.save({ report: current, markdown: "ignored; regenerated when read" });
    assert.deepEqual(reports.list().map((entry) => entry.id), [current.id, legacy.id]);
    assert.equal(reports.get(current.id)?.report.summary.overallScoreMean, 88);
    assert.match(reports.get(current.id)?.markdown ?? "", /API 评测/u);

    database.close();
    database = new AppDatabase(databasePath);
    reports = new TaskBenchReportRepository(database, { stateDir });
    assert.deepEqual(reports.list().map((entry) => entry.id), [current.id, legacy.id]);

    new DataManagementRepository(database).deleteAllUserData();
    database.close();
    database = new AppDatabase(databasePath);
    reports = new TaskBenchReportRepository(database, { stateDir });
    assert.deepEqual(reports.list(), [], "the one-time import must not resurrect deleted reports");
  } finally {
    database?.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function sampleReport(
  id: string,
  ranAt: string,
  name: string,
  overallScoreMean: number,
): TaskBenchReport {
  return {
    version: 1,
    id,
    ranAt,
    name,
    targetMode: "model",
    target: {
      profileId: "target-profile",
      profileName: "测试模型",
      model: "test-model",
    },
    judge: null,
    task: "完成测试任务",
    rubric: "",
    referenceAnswer: "",
    timeouts: { taskSeconds: 1800, judgeSeconds: 600 },
    scoring: {
      passThreshold: 70,
      hardWeight: 1,
      judgeWeight: 0,
      hardFailureIsGate: true,
    },
    isolation: {
      state: "new_disposable_runtime_per_repetition",
      memory: "empty_and_disabled",
      userProfile: "not_injected",
      relationships: "not_injected",
      world: "not_injected",
      conversationHistory: "not_injected",
      sandboxDestroyed: true,
    },
    capabilities: {
      workspaceAccess: "off",
      shellEnabled: false,
      networkEnabled: false,
      enabledModules: [],
      characterSkillsIncluded: false,
      meetingPresetIncluded: false,
    },
    fixtures: [],
    assertions: {
      requiredPhrases: [],
      forbiddenPhrases: [],
      requiredFiles: [],
      responseMustBeJson: false,
    },
    summary: {
      repetitions: 1,
      completedRuns: 1,
      timedOutRuns: 0,
      passedRuns: 1,
      passRate: 1,
      hardPassRate: 1,
      judgeCoverage: 0,
      hardScoreMean: 100,
      judgeScoreMean: null,
      overallScoreMean,
      overallScoreStdDev: null,
      averageDurationMs: 100,
      totalModelRequests: 1,
      totalJudgeRequests: 0,
      targetInputTokens: 10,
      targetOutputTokens: 20,
      judgeInputTokens: 0,
      judgeOutputTokens: 0,
    },
    runs: [],
  };
}
