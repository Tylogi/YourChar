import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, resolve, sep } from "node:path";
import { CompanionKernel, CompanionStore } from "../dist/src/domain/index.js";
import { runTaskBench } from "../dist/src/evaluation/task-bench.js";
import {
  bundledTypeScriptLspRuntimeProfileId,
  createBundledTypeScriptLspRuntimeConfiguration,
  lspNavigationModuleId,
} from "../dist/src/lsp/index.js";
import { resolveStateDirectory } from "./state-directory.mjs";

const args = process.argv.slice(2);
const repetitions = integerOption(args, "--runs", 3, 1, 5);
const timeoutSeconds = integerOption(args, "--timeout", 600, 10, 7_200);
const artifactDir = resolve(process.env.RP_EVAL_ARTIFACT_DIR || "eval-artifacts");
const fixtureRoot = resolve("eval-fixtures/lsp-navigation");
const modelConfig = resolveModelConfig();

const benchmarkTasks = Object.freeze([
  Object.freeze({
    id: "aliased-definition",
    task: `分析 fixtures/repository 中的 TypeScript 小型仓库。从 src/app/bootstrap.ts 的 DefaultAccessPolicy 实例化位置出发，确认该别名最终对应的类声明及授权成功时的 code 字面量。可以使用当前提供的只读代码工具。不要修改文件。只返回 JSON，不要 Markdown：{"definitionFile":"...","className":"...","grantedCode":"..."}`,
    assertions: {
      requiredPhrases: ["strict-policy.ts", "StrictAccessPolicy", "STRICT_GRANTED"],
      forbiddenPhrases: [],
      requiredFiles: [],
      responseMustBeJson: true,
    },
  }),
  Object.freeze({
    id: "semantic-references",
    task: `分析 fixtures/repository 中的 TypeScript 小型仓库。查找 src/audit/token.ts 所声明 makeAuditToken 符号的语义引用，忽略其他目录中仅同名但不同符号的声明和调用。可以使用当前提供的只读代码工具。不要修改文件。只返回 JSON，不要解释或列出被排除项：{"declaration":"...","referenceFiles":["..."]}，referenceFiles 去重并排序。`,
    assertions: {
      requiredPhrases: [
        "fixtures/repository/src/audit/token.ts",
        "fixtures/repository/src/audit/record.ts",
        "fixtures/repository/src/audit/replay.ts",
      ],
      forbiddenPhrases: ["fixtures/repository/src/decoys/token.ts", "NOT_A_REAL_AUDIT_REFERENCE"],
      requiredFiles: [],
      responseMustBeJson: true,
    },
  }),
  Object.freeze({
    id: "interface-implementations",
    task: `分析 fixtures/repository 中的 TypeScript 小型仓库。从 src/delivery/port.ts 的 DeliveryPort.deliver 出发，找出真正实现该接口方法的类、文件以及每个实现返回的字面量；不要把只有同名方法但未实现该接口的类算进去。可以使用当前提供的只读代码工具。不要修改文件。只返回 JSON，不要解释或列出被排除项：{"implementations":[{"file":"...","className":"...","result":"..."}]}，按 file 排序。`,
    assertions: {
      requiredPhrases: [
        "http-port.ts",
        "HttpDeliveryPort",
        "HTTP_ACCEPTED",
        "queue-port.ts",
        "QueueDeliveryPort",
        "QUEUE_ENQUEUED",
      ],
      forbiddenPhrases: ["shadow-port.ts", "ShadowDeliveryPort", "SHADOW_ONLY"],
      requiredFiles: [],
      responseMustBeJson: true,
    },
  }),
]);

await main();

async function main() {
  if (!modelConfig) {
    console.error([
      "LSP A/B evaluation was not run: model configuration is incomplete.",
      "Set RP_EVAL_BASE_URL and RP_EVAL_MODEL (optionally RP_EVAL_API_KEY),",
      "or set RP_EVAL_REUSE_CONFIG=1 and optionally RP_EVAL_SOURCE_STATE_DIR.",
    ].join("\n"));
    process.exitCode = 2;
    return;
  }

  const sourceStateDir = mkdtempSync(join(tmpdir(), "yourchar-lsp-ab-source-"));
  const runtimeConfiguration = createBundledTypeScriptLspRuntimeConfiguration();
  let kernel;
  try {
    kernel = new CompanionKernel({
      stateDir: sourceStateDir,
      workspaceDir: join(sourceStateDir, "workspace"),
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      reminderMessageComposer: false,
      skillInstaller: false,
      imGateway: false,
      characterSkillReflector: false,
      agentCapabilityPackages: runtimeConfiguration.packages,
      agentRuntimeProfiles: runtimeConfiguration.profiles,
      activeAgentRuntimeProfileId: bundledTypeScriptLspRuntimeProfileId,
    });
    kernel.patchAgentPermissions({
      workspaceAccess: "read_only",
      shellEnabled: true,
      networkEnabled: false,
    });
    const target = kernel.createModelApiProfile({
      name: "P3d LSP A/B target",
      enabled: true,
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model,
      ...(modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : {}),
      ...(modelConfig.temperature === undefined ? {} : { temperature: modelConfig.temperature }),
      ...(modelConfig.maxTokens === undefined ? {} : { maxTokens: modelConfig.maxTokens }),
      ...(modelConfig.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: modelConfig.contextWindowTokens }),
      ...(modelConfig.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: modelConfig.reasoningEffort }),
      ...(modelConfig.thinkingTokenBudgetField === undefined
        ? {}
        : { thinkingTokenBudgetField: modelConfig.thinkingTokenBudgetField }),
      ...(modelConfig.thinkingBudgetTokens === undefined
        ? {}
        : { thinkingBudgetTokens: modelConfig.thinkingBudgetTokens }),
    });
    kernel.setAgentModuleEnabled(lspNavigationModuleId, false);
    console.log("model preflight (1 run)");
    const preflight = await runTaskBench(kernel, {
      name: "P3d model preflight",
      targetMode: "model",
      modelProfileId: target.id,
      task: "健康检查：只回复 P3D_PREFLIGHT_OK，不调用工具。",
      repetitions: 1,
      timeoutSeconds: Math.min(timeoutSeconds, 120),
      assertions: { requiredPhrases: ["P3D_PREFLIGHT_OK"] },
    });
    if (preflight.report.summary.completedRuns !== 1 || preflight.report.summary.passedRuns !== 1) {
      const failure = buildPreflightFailure(preflight.report);
      const paths = writeArtifacts("lsp-navigation-ab-preflight-failed", failure, renderPreflightFailureMarkdown(failure));
      console.error("Model preflight failed; paired A/B tasks were not run.");
      console.error(`JSON: ${paths.jsonPath}`);
      console.error(`Summary: ${paths.markdownPath}`);
      process.exitCode = 2;
      return;
    }
    const fixtures = installSourceFixtures(kernel);
    const reports = [];
    for (let taskIndex = 0; taskIndex < benchmarkTasks.length; taskIndex += 1) {
      const task = benchmarkTasks[taskIndex];
      // Alternate order to reduce systematic warm-provider or time-of-run bias.
      const variants = taskIndex % 2 === 0 ? ["baseline", "lsp"] : ["lsp", "baseline"];
      for (const variant of variants) {
        const enabled = variant === "lsp";
        kernel.setAgentModuleEnabled(lspNavigationModuleId, enabled);
        console.log(`${task.id}: ${variant} (${repetitions} run${repetitions === 1 ? "" : "s"})`);
        const result = await runTaskBench(kernel, {
          name: `P3d ${task.id} · ${variant}`,
          targetMode: "model",
          modelProfileId: target.id,
          task: task.task,
          repetitions,
          timeoutSeconds,
          workspacePaths: fixtures.paths,
          assertions: task.assertions,
        });
        reports.push({ taskId: task.id, variant, report: result.report });
      }
    }

    const report = buildComparisonReport(reports, fixtures.digest, preflight.report);
    const paths = writeArtifacts("lsp-navigation-ab", report, renderComparisonMarkdown(report));
    console.log(`Baseline pass rate: ${percent(report.baseline.passRate)}`);
    console.log(`LSP pass rate: ${percent(report.lsp.passRate)}`);
    console.log(`LSP used in ${report.lsp.runsUsingLsp}/${report.lsp.runs} runs.`);
    console.log(`JSON: ${paths.jsonPath}`);
    console.log(`Summary: ${paths.markdownPath}`);
    if (!report.integrity.passed) process.exitCode = 1;
  } finally {
    kernel?.dispose();
    rmSync(sourceStateDir, { recursive: true, force: true });
  }
}

function installSourceFixtures(kernel) {
  const files = listFixtureFiles(fixtureRoot);
  if (!files.length || files.length > 20) {
    throw new Error("LSP benchmark fixture must contain between 1 and 20 files");
  }
  const digest = createHash("sha256");
  const paths = [];
  for (const relativePath of files) {
    const bytes = readFileSync(join(fixtureRoot, relativePath));
    digest.update(relativePath).update("\0").update(bytes).update("\0");
    const destination = posix.join("repository", relativePath);
    const entry = kernel.uploadWorkspaceFile({
      directory: posix.dirname(destination),
      name: posix.basename(destination),
      bytes,
    });
    if (entry.path !== destination) {
      throw new Error(`LSP benchmark fixture collision at ${destination}`);
    }
    paths.push(entry.path);
  }
  return { paths, digest: digest.digest("hex") };
}

function listFixtureFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`LSP benchmark fixture cannot contain links or special files: ${path}`);
    }
  }
  return output.sort();
}

function buildComparisonReport(entries, fixtureDigest, preflight) {
  const baselineReports = entries.filter((entry) => entry.variant === "baseline").map((entry) => entry.report);
  const lspReports = entries.filter((entry) => entry.variant === "lsp").map((entry) => entry.report);
  const baseline = aggregateReports(baselineReports);
  const lsp = aggregateReports(lspReports);
  const expectedRuns = benchmarkTasks.length * repetitions;
  const integrityChecks = {
    pairedTasks: baselineReports.length === benchmarkTasks.length && lspReports.length === benchmarkTasks.length,
    expectedRuns: baseline.runs === expectedRuns && lsp.runs === expectedRuns,
    completedRuns:
      baseline.completedRuns === expectedRuns &&
      lsp.completedRuns === expectedRuns,
    sameModel: entries.every((entry) => entry.report.target.model === modelConfig.model),
    baselineDisabled: baselineReports.every((report) =>
      !report.capabilities.enabledModules.includes(lspNavigationModuleId)
    ),
    variantEnabled: lspReports.every((report) =>
      report.capabilities.enabledModules.includes(lspNavigationModuleId)
    ),
    baselineDidNotUseLsp: baseline.lspActions === 0,
    sameFixtures: entries.every((entry) =>
      createHash("sha256")
        .update(JSON.stringify(entry.report.fixtures.map((fixture) => ({
          sourcePath: fixture.sourcePath,
          workspacePath: fixture.workspacePath,
          size: fixture.size,
        }))))
        .digest("hex") === fixtureReportDigest(entries[0].report)
    ),
  };
  return {
    version: 1,
    kind: "lsp-navigation-ab",
    ranAt: new Date().toISOString(),
    configuration: {
      source: modelConfig.source,
      model: modelConfig.model,
      apiKeySet: Boolean(modelConfig.apiKey),
      repetitionsPerTask: repetitions,
      timeoutSeconds,
      taskIds: benchmarkTasks.map((task) => task.id),
      fixtureDigest,
      workspaceAccess: "read_only",
      shellEnabled: true,
      networkEnabled: false,
      order: "alternating",
    },
    integrity: {
      passed: Object.values(integrityChecks).every(Boolean),
      checks: integrityChecks,
    },
    baseline,
    lsp,
    delta: {
      passRatePoints: round((lsp.passRate - baseline.passRate) * 100),
      averageDurationMs: lsp.averageDurationMs - baseline.averageDurationMs,
      inputTokens: nullableDifference(lsp.inputTokens, baseline.inputTokens),
      outputTokens: nullableDifference(lsp.outputTokens, baseline.outputTokens),
      modelRequests: lsp.modelRequests - baseline.modelRequests,
    },
    decision: {
      lspEvidence: lsp.runsUsingLsp > 0 ? "observed" : "not_used_by_model",
      codeMode: "deferred",
      rationale: "This benchmark measures bounded LSP navigation only. A broader Code Mode needs its own paired candidate and must not be inferred from tool availability.",
    },
    preflight,
    reports: entries,
  };
}

function buildPreflightFailure(preflight) {
  return {
    version: 1,
    kind: "lsp-navigation-ab-preflight-failed",
    ranAt: new Date().toISOString(),
    configuration: {
      source: modelConfig.source,
      model: modelConfig.model,
      apiKeySet: Boolean(modelConfig.apiKey),
      requestedRepetitionsPerTask: repetitions,
      timeoutSeconds,
    },
    integrity: {
      passed: false,
      checks: { modelPreflight: false },
    },
    preflight,
  };
}

function aggregateReports(reports) {
  const runs = reports.flatMap((report) => report.runs);
  const durations = runs.map((run) => run.durationMs);
  const inputTokens = knownTokenSum(runs.map((run) => run.usage.inputTokens));
  const outputTokens = knownTokenSum(runs.map((run) => run.usage.outputTokens));
  const lspActions = runs.flatMap((run) => run.actions)
    .filter((action) => action.actionType === "lsp_navigation");
  return {
    tasks: reports.length,
    runs: runs.length,
    completedRuns: runs.filter((run) => run.status === "completed").length,
    passedRuns: runs.filter((run) => run.passed).length,
    passRate: ratio(runs.filter((run) => run.passed).length, runs.length),
    averageDurationMs: Math.round(average(durations)),
    modelRequests: runs.reduce((total, run) => total + run.modelRequests, 0),
    inputTokens,
    outputTokens,
    lspActions: lspActions.length,
    completedLspActions: lspActions.filter((action) => action.status === "completed").length,
    runsUsingLsp: runs.filter((run) =>
      run.actions.some((action) => action.actionType === "lsp_navigation")
    ).length,
  };
}

function fixtureReportDigest(report) {
  return createHash("sha256")
    .update(JSON.stringify(report.fixtures.map((fixture) => ({
      sourcePath: fixture.sourcePath,
      workspacePath: fixture.workspacePath,
      size: fixture.size,
    }))))
    .digest("hex");
}

function renderComparisonMarkdown(report) {
  const token = (value) => value === null ? "未报告" : String(value);
  return [
    "# P3d TypeScript LSP 同模型 A/B",
    "",
    `- 时间：${report.ranAt}`,
    `- 模型：${report.configuration.model}`,
    `- 每任务重复：${report.configuration.repetitionsPerTask}`,
    `- Fixture SHA-256：${report.configuration.fixtureDigest}`,
    `- 公平性检查：${report.integrity.passed ? "PASS" : "FAIL"}`,
    "",
    "| 指标 | Baseline | LSP | 差值（LSP - Baseline） |",
    "|---|---:|---:|---:|",
    `| 通过率 | ${percent(report.baseline.passRate)} | ${percent(report.lsp.passRate)} | ${signed(report.delta.passRatePoints)} pp |`,
    `| 平均耗时 | ${report.baseline.averageDurationMs} ms | ${report.lsp.averageDurationMs} ms | ${signed(report.delta.averageDurationMs)} ms |`,
    `| 输入 Token | ${token(report.baseline.inputTokens)} | ${token(report.lsp.inputTokens)} | ${token(report.delta.inputTokens)} |`,
    `| 输出 Token | ${token(report.baseline.outputTokens)} | ${token(report.lsp.outputTokens)} | ${token(report.delta.outputTokens)} |`,
    `| 模型请求 | ${report.baseline.modelRequests} | ${report.lsp.modelRequests} | ${signed(report.delta.modelRequests)} |`,
    `| 使用 LSP 的运行 | 0/${report.baseline.runs} | ${report.lsp.runsUsingLsp}/${report.lsp.runs} | -- |`,
    `| LSP 动作 | 0 | ${report.lsp.completedLspActions}/${report.lsp.lspActions} 完成 | -- |`,
    "",
    "## 判定边界",
    "",
    `- LSP 使用证据：${report.decision.lspEvidence}`,
    "- 完整 Code Mode：继续延期；本报告只比较轻量 LSP，不能由工具是否出现推导 Code Mode 收益。",
    "",
    "完整逐轮结果与候选回复保存在同名 JSON 文件中。",
    "",
  ].join("\n");
}

function renderPreflightFailureMarkdown(report) {
  const run = report.preflight.runs[0];
  return [
    "# P3d TypeScript LSP A/B · 模型预检失败",
    "",
    `- 时间：${report.ranAt}`,
    `- 模型：${report.configuration.model}`,
    `- 状态：${run?.status ?? "unknown"}`,
    "- A/B 任务：未运行，不能形成 Baseline 或 LSP 效果结论。",
    "",
    run?.error || run?.reply || "模型未返回可用结果。",
    "",
  ].join("\n");
}

function writeArtifacts(prefix, report, markdown) {
  mkdirSync(artifactDir, { recursive: true });
  const stamp = report.ranAt.replace(/[:.]/gu, "-");
  const jsonPath = join(artifactDir, `${prefix}-${stamp}.json`);
  const markdownPath = join(artifactDir, `${prefix}-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(markdownPath, markdown, { mode: 0o600 });
  return { jsonPath, markdownPath };
}

function resolveModelConfig() {
  const baseUrl = process.env.RP_EVAL_BASE_URL?.trim();
  const model = process.env.RP_EVAL_MODEL?.trim();
  if (baseUrl && model) {
    return {
      source: "environment",
      baseUrl,
      model,
      apiKey: process.env.RP_EVAL_API_KEY?.trim() || undefined,
      temperature: optionalNumber(process.env.RP_EVAL_TEMPERATURE),
      maxTokens: optionalInteger(process.env.RP_EVAL_MAX_TOKENS),
    };
  }
  if (process.env.RP_EVAL_REUSE_CONFIG !== "1") return undefined;
  const explicitStateDir = process.env.RP_EVAL_SOURCE_STATE_DIR?.trim();
  const stateDir = explicitStateDir ? resolve(explicitStateDir) : resolveStateDirectory();
  const store = new CompanionStore({ stateDir });
  const profileId = process.env.RP_EVAL_PROFILE_ID?.trim();
  const stored = profileId
    ? store.getRawModelApiProfile(profileId)
    : store.getRawModelApiConfig();
  if (!stored?.enabled || !stored.baseUrl || !stored.model) return undefined;
  return {
    source: profileId ? "stored-profile" : "stored-config",
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey,
    temperature: optionalNumber(process.env.RP_EVAL_TEMPERATURE) ?? stored.temperature,
    maxTokens: optionalInteger(process.env.RP_EVAL_MAX_TOKENS) ?? stored.maxTokens,
    contextWindowTokens: stored.contextWindowTokens,
    reasoningEffort: stored.reasoningEffort,
    thinkingTokenBudgetField: stored.thinkingTokenBudgetField,
    thinkingBudgetTokens: stored.thinkingBudgetTokens,
  };
}

function integerOption(arguments_, name, fallback, minimum, maximum) {
  const inline = arguments_.find((argument) => argument.startsWith(`${name}=`));
  const index = arguments_.indexOf(name);
  const value = inline?.slice(name.length + 1) || (index >= 0 ? arguments_[index + 1] : undefined);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionalNumber(value) {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalInteger(value) {
  const parsed = optionalNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function knownTokenSum(values) {
  const known = values.filter((value) => typeof value === "number");
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
}

function nullableDifference(left, right) {
  return left === null || right === null ? null : left - right;
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function ratio(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function percent(value) {
  return `${round(value * 100).toFixed(1)}%`;
}

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
}
