import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CompanionKernel, CompanionStore } from "../dist/src/domain/index.js";
import { resolveStateDirectory } from "./state-directory.mjs";
import {
  hasLongRpSceneContinuity,
  longRpSceneForTurn,
  longRpSceneTerms,
} from "../dist/src/evaluation/long-eval-rules.js";

const artifactDir = resolve(process.env.RP_EVAL_ARTIFACT_DIR || "eval-artifacts");
const keepState = process.env.RP_EVAL_KEEP_STATE === "1";
const args = process.argv.slice(2);
const longMode = args.includes("--long");
const reevaluatePath = optionValue(args, "--re-evaluate");
const runCount = longMode ? 1 : parseRunCount(args);
const config = reevaluatePath ? undefined : resolveModelConfig();

async function main() {
  if (reevaluatePath) {
    reevaluateLongReport(resolve(reevaluatePath));
  } else if (!config) {
    console.error([
      "Real-model evaluation was not run: model configuration is incomplete.",
      "Set RP_EVAL_BASE_URL and RP_EVAL_MODEL (optionally RP_EVAL_API_KEY),",
      "or set RP_EVAL_REUSE_CONFIG=1 and optionally RP_EVAL_SOURCE_STATE_DIR.",
    ].join("\n"));
    process.exitCode = 2;
  } else {
    if (longMode) {
      await runLongEvaluation(config);
    } else {
      await runEvaluation(config, runCount);
    }
  }
}

async function runEvaluation(modelConfig, requestedRuns) {
  const runs = [];
  for (let index = 1; index <= requestedRuns; index += 1) {
    console.log(`Real-model evaluation run ${index}/${requestedRuns}`);
    runs.push(await runSingleEvaluation(modelConfig, index));
  }

  const scenarioStats = aggregateScenarioStats(runs);
  const modelDurations = runs.flatMap((run) => run.scenarios)
    .filter((scenario) => scenario.countsTowardModelScore)
    .map((scenario) => scenario.durationMs);
  const report = {
    version: 8,
    ranAt: new Date().toISOString(),
    configuration: {
      source: modelConfig.source,
      model: modelConfig.model,
      apiKeySet: Boolean(modelConfig.apiKey),
    },
    requestedRuns,
    completedRuns: runs.length,
    isolation: { isolatedStateDirectoryPerRun: true, retained: keepState },
    overall: aggregateRate(scenarioStats),
    modelCapability: aggregateRate(scenarioStats.filter((scenario) => scenario.countsTowardModelScore)),
    nativeModelCapability: aggregateNativeRate(
      scenarioStats.filter((scenario) => scenario.countsTowardModelScore),
    ),
    functionalRecoveries: scenarioStats.reduce(
      (total, scenario) => total + scenario.recoveryUsedRuns,
      0,
    ),
    systemChecks: aggregateRate(scenarioStats.filter((scenario) => !scenario.countsTowardModelScore)),
    performance: {
      modelRequestCount: runs.reduce((total, run) => total + run.modelRequestCount, 0),
      latencyMs: latencyStats(modelDurations),
    },
    scenarioStats,
    runs,
  };
  report.gate = realEvaluationGate(report);
  mkdirSync(artifactDir, { recursive: true });
  const stamp = report.ranAt.replace(/[:.]/g, "-");
  const jsonPath = join(artifactDir, `real-model-eval-${stamp}.json`);
  const markdownPath = join(artifactDir, `real-model-eval-${stamp}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(markdownPath, markdownReport(report), { mode: 0o600 });
  console.log(
    `Functional capability: ${report.modelCapability.passed}/${report.modelCapability.total} ` +
    `scenario-runs passed (${formatRate(report.modelCapability.passRate)})`,
  );
  console.log(
    `Native model capability: ${report.nativeModelCapability.passed}/${report.nativeModelCapability.total} ` +
    `scenario-runs passed without functional recovery (${formatRate(report.nativeModelCapability.passRate)})`,
  );
  console.log(
    `System checks: ${report.systemChecks.passed}/${report.systemChecks.total} ` +
    `passed (${formatRate(report.systemChecks.passRate)})`,
  );
  console.log(`JSON: ${jsonPath}`);
  console.log(`Summary: ${markdownPath}`);
  console.log(`Real-model gate: ${report.gate.passed ? "PASS" : "FAIL"}`);
  if (!report.gate.passed) process.exitCode = 1;
}

async function runLongEvaluation(modelConfig) {
  const isolatedStateDir = mkdtempSync(join(tmpdir(), "rp-agent-long-eval-"));
  let kernel = createLongEvalKernel(isolatedStateDir);
  let completed = false;
  let modelRequestsBeforeRestart = 0;
  const restartEvents = [];
  const turns = [];
  const sceneMigrations = [];
  try {
    applyModelConfig(kernel, modelConfig);
    const smsCharacter = kernel.createCharacter({
      name: "苏言",
      soulMarkdown: [
        "# SOUL.md - 苏言",
        "",
        "你是苏言本人。所有私聊都以第一人称自然回复，不写旁白、动作括号、第三人称自称或助手套话。",
        "你始终称呼用户为舰长，表达冷静具体，遇到复杂问题先拆分变量。",
      ].join("\n"),
    });
    const rpCharacter = kernel.createCharacter({
      name: "林澈",
      soulMarkdown: [
        "# SOUL.md - 林澈",
        "",
        "林澈敏锐、克制。剧情回复必须用第三人称，以环境、动作和带引号的对白推进，不退化成私聊短句。",
      ].join("\n"),
    });
    kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "relationship_event",
      key: "user.address",
      content: "苏言始终称用户为舰长",
      characterId: smsCharacter.id,
      confirmed: true,
      salience: 1,
    });
    kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      key: "world.safehouse.drink",
      content: "安全屋吧台固定供应咖啡",
      characterId: smsCharacter.id,
      confirmed: true,
      salience: 0.95,
    });

    for (let index = 0; index < longSmsPrompts.length; index += 1) {
      const extraRules = [];
      if (index === 10) {
        const conflict = kernel.writeRpMemory({
          realm: "roleplay",
          scope: "character",
          type: "world_fact",
          key: "world.safehouse.drink",
          content: "安全屋吧台固定供应茶",
          characterId: smsCharacter.id,
          confirmed: false,
          salience: 0.95,
        });
        const active = kernel.searchRpMemories({ characterId: smsCharacter.id, confirmedOnly: true });
        extraRules.push(longRule(
          "memory-conflict-pending",
          "冲突记忆要求确认且旧确认事实仍生效",
          conflict.needsConfirmation === true && active.some((entry) => /咖啡/.test(entry.content)),
          `needsConfirmation=${String(conflict.needsConfirmation)}`,
        ));
      }
      if (index === 11) {
        const correction = kernel.writeRpMemory({
          realm: "roleplay",
          scope: "character",
          type: "world_fact",
          key: "world.safehouse.drink",
          content: "安全屋吧台固定供应茶",
          characterId: smsCharacter.id,
          confirmed: true,
          salience: 0.95,
        });
        const active = kernel.searchRpMemories({ characterId: smsCharacter.id, confirmedOnly: true });
        extraRules.push(longRule(
          "memory-correction-confirmed",
          "确认更正取代旧事实",
          correction.memory?.validity === "active" && active.some((entry) => /茶/.test(entry.content)) && !active.some((entry) => /咖啡/.test(entry.content)),
          active.map((entry) => entry.content).join(" | "),
        ));
      }
      const beforeCalls = kernel.getModelRequestCount();
      const startedAt = performance.now();
      const response = await kernel.sendMessage("long-sms", {
        mode: "sms",
        characterId: smsCharacter.id,
        text: longSmsPrompts[index],
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const session = await kernel.getSession("long-sms");
      const reply = response.reply;
      const rules = [
        longRule("completed", "轮次状态为 completed", response.status === "completed", response.status),
        longRule("first-person", "保持第一人称", /我/.test(reply), excerpt(reply)),
        longRule("character-address", "保持角色称呼‘舰长’", /舰长/.test(reply), excerpt(reply)),
        longRule("no-narration", "无动作括号或星号旁白", !hasActionNarration(reply), excerpt(reply)),
        longRule("no-assistant-tone", "无通用助手或AI口吻", !hasAssistantTone(reply), excerpt(reply)),
        longRule("no-meta-reasoning", "无元分析或英文思考泄漏", !hasMetaReasoning(reply), excerpt(reply)),
        ...(index === 10 ? [longRule("old-memory-visible", "未确认冲突不覆盖旧记忆", /咖啡/.test(reply), excerpt(reply))] : []),
        ...(index === 11 ? [longRule("corrected-memory-visible", "确认更正进入后续上下文", /茶/.test(reply), excerpt(reply))] : []),
        ...extraRules,
      ];
      turns.push({
        sequence: turns.length + 1,
        mode: "sms",
        modeTurn: index + 1,
        prompt: longSmsPrompts[index],
        reply,
        status: response.status,
        latencyMs,
        modelCalls: kernel.getModelRequestCount() - beforeCalls,
        contextMessageCount: session.messages.length,
        characterDrift: !rulesByIdPass(rules, ["first-person", "character-address", "no-narration", "no-assistant-tone", "no-meta-reasoning"]),
        modeRegression: !rulesByIdPass(rules, ["first-person", "no-narration", "no-assistant-tone", "no-meta-reasoning"]),
        passed: rules.every((entry) => entry.passed),
        rules,
      });
      console.log(`Long SMS turn ${index + 1}/${longSmsPrompts.length}: ${rules.every((entry) => entry.passed) ? "PASS" : "FAIL"}`);
      if (index === 14) {
        modelRequestsBeforeRestart += kernel.getModelRequestCount();
        kernel.dispose();
        kernel = createLongEvalKernel(isolatedStateDir);
        restartEvents.push({ afterMode: "sms", afterTurn: index + 1 });
      }
    }

    kernel.rpService.ensureRoleSession("long-rp", rpCharacter.id);
    kernel.updateScene("long-rp", {
      location: "暴雨后的旧码头",
      currentObjective: "找到失联的引航员",
      summary: "林澈和用户沿湿滑栈桥调查遗留信号。",
    }, rpCharacter.id);
    for (let index = 0; index < longRpPrompts.length; index += 1) {
      if (index === 10) {
        kernel.updateScene("long-rp", {
          location: "山顶气象站",
          currentObjective: "修复被切断的发射器",
          summary: "两人从旧码头追踪信号抵达山顶气象站。",
        }, rpCharacter.id);
        sceneMigrations.push({ beforeTurn: index + 1, location: "山顶气象站" });
      }
      if (index === 20) {
        kernel.updateScene("long-rp", {
          location: "地下档案库",
          currentObjective: "找到引航员留下的失踪记录",
          summary: "修复发射器后，线索将两人引向地下档案库。",
        }, rpCharacter.id);
        sceneMigrations.push({ beforeTurn: index + 1, location: "地下档案库" });
      }
      const expectedScene = longRpSceneForTurn(index + 1);
      const beforeCalls = kernel.getModelRequestCount();
      const startedAt = performance.now();
      const response = await kernel.sendMessage("long-rp", {
        mode: "rp",
        characterId: rpCharacter.id,
        text: longRpPrompts[index],
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      const session = await kernel.getSession("long-rp");
      const reply = response.reply;
      const rules = [
        longRule("completed", "轮次状态为 completed", response.status === "completed", response.status),
        longRule("third-person", "出现角色名或第三人称指代", /林澈|他/.test(reply), excerpt(reply)),
        longRule(
          "scene-continuity",
          `延续当前场景语义（${longRpSceneTerms(expectedScene).join("/")}）`,
          hasLongRpSceneContinuity(reply, expectedScene),
          excerpt(reply),
        ),
        longRule("environment", "包含环境描写", hasEnvironmentSignal(reply), excerpt(reply)),
        longRule("action", "包含动作描写", hasActionSignal(reply), excerpt(reply)),
        longRule("dialogue", "包含带引号对白", /[“”]/.test(reply), excerpt(reply)),
        longRule("not-short-chat", "不少于80字符，未退化为私聊短句", [...reply].length >= 80, `${[...reply].length} chars`),
        longRule("no-assistant-tone", "无通用助手或AI口吻", !hasAssistantTone(reply), excerpt(reply)),
        longRule("no-meta-reasoning", "无元分析或英文思考泄漏", !hasMetaReasoning(reply), excerpt(reply)),
      ];
      turns.push({
        sequence: turns.length + 1,
        mode: "rp",
        modeTurn: index + 1,
        prompt: longRpPrompts[index],
        reply,
        status: response.status,
        latencyMs,
        modelCalls: kernel.getModelRequestCount() - beforeCalls,
        contextMessageCount: session.messages.length,
        characterDrift: !rulesByIdPass(rules, ["third-person", "scene-continuity", "no-assistant-tone", "no-meta-reasoning"]),
        modeRegression: !rulesByIdPass(rules, ["environment", "action", "dialogue", "not-short-chat", "no-meta-reasoning"]),
        passed: rules.every((entry) => entry.passed),
        rules,
      });
      console.log(`Long RP turn ${index + 1}/${longRpPrompts.length}: ${rules.every((entry) => entry.passed) ? "PASS" : "FAIL"}`);
      if (index === 14) {
        modelRequestsBeforeRestart += kernel.getModelRequestCount();
        kernel.dispose();
        kernel = createLongEvalKernel(isolatedStateDir);
        restartEvents.push({ afterMode: "rp", afterTurn: index + 1 });
      }
    }

    const smsTurns = turns.filter((turn) => turn.mode === "sms");
    const rpTurns = turns.filter((turn) => turn.mode === "rp");
    const allLatencies = turns.map((turn) => turn.latencyMs);
    const report = {
      version: 1,
      kind: "long-conversation",
      ranAt: new Date().toISOString(),
      configuration: { source: modelConfig.source, model: modelConfig.model },
      isolation: { isolatedStateDirectory: true, retained: keepState },
      totals: {
        turns: turns.length,
        passed: turns.filter((turn) => turn.passed).length,
        passRate: rate(turns.filter((turn) => turn.passed).length, turns.length),
        modelRequestCount: modelRequestsBeforeRestart + kernel.getModelRequestCount(),
        latencyMs: latencyStats(allLatencies),
      },
      modes: {
        sms: longModeMetrics(smsTurns),
        rp: longModeMetrics(rpTurns),
      },
      context: {
        sms: contextGrowth(smsTurns),
        rp: contextGrowth(rpTurns),
      },
      restartEvents,
      sceneMigrations,
      memoryLifecycle: {
        conflictTested: true,
        confirmedCorrectionTested: true,
      },
      turns,
      ...(keepState ? { retainedStateDirectory: isolatedStateDir } : {}),
    };
    mkdirSync(artifactDir, { recursive: true });
    const stamp = report.ranAt.replace(/[:.]/g, "-");
    const jsonPath = join(artifactDir, `real-model-long-eval-${stamp}.json`);
    const markdownPath = join(artifactDir, `real-model-long-eval-${stamp}.md`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    writeFileSync(markdownPath, longMarkdownReport(report), { mode: 0o600 });
    console.log(
      `Long evaluation: ${report.totals.passed}/${report.totals.turns} turns passed; ` +
      `drift SMS ${formatRate(report.modes.sms.characterDriftRate)}, RP ${formatRate(report.modes.rp.characterDriftRate)}`,
    );
    console.log(
      `Latency p50/p95: ${report.totals.latencyMs.p50}/${report.totals.latencyMs.p95} ms; ` +
      `model requests: ${report.totals.modelRequestCount}`,
    );
    console.log(`JSON: ${jsonPath}`);
    console.log(`Summary: ${markdownPath}`);
    completed = true;
    if (report.totals.passed !== report.totals.turns) process.exitCode = 1;
  } finally {
    kernel.dispose();
    if (!keepState) rmSync(isolatedStateDir, { recursive: true, force: true });
    if (!completed && process.exitCode === undefined) process.exitCode = 1;
  }
}

function createLongEvalKernel(stateDir) {
  return new CompanionKernel({ stateDir, startScheduler: false, quietHours: false });
}

function applyModelConfig(kernel, modelConfig) {
  kernel.patchModelApiConfig({
    enabled: true,
    baseUrl: modelConfig.baseUrl,
    model: modelConfig.model,
    ...(modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : {}),
    ...(modelConfig.temperature !== undefined ? { temperature: modelConfig.temperature } : {}),
    ...(modelConfig.maxTokens !== undefined ? { maxTokens: modelConfig.maxTokens } : {}),
  });
}

async function runSingleEvaluation(modelConfig, runNumber) {
  const isolatedStateDir = mkdtempSync(join(tmpdir(), `rp-agent-real-eval-${runNumber}-`));
  const clock = mutableClock("2026-07-15T08:00:00.000Z");
  const deliveries = [];
  const notificationSink = {
    channel: "eval-capture",
    async deliver(notification) {
      deliveries.push(structuredClone(notification));
      return { delivered: true, detail: "captured by real-model evaluation" };
    },
  };
  const kernel = new CompanionKernel({
    stateDir: isolatedStateDir,
    clock,
    notificationSink,
    startScheduler: false,
    quietHours: false,
  });
  const scenarios = [];
  try {
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: modelConfig.baseUrl,
      model: modelConfig.model,
      ...(modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : {}),
      ...(modelConfig.temperature !== undefined ? { temperature: modelConfig.temperature } : {}),
      ...(modelConfig.maxTokens !== undefined ? { maxTokens: modelConfig.maxTokens } : {}),
    });

    const smsCharacter = kernel.createCharacter({
      name: "苏言",
      soulMarkdown: [
        "# SOUL.md - 苏言",
        "",
        "你是苏言本人。私聊时只用第一人称，不写旁白、动作括号或助手套话。",
        "表达冷静、具体，遇到复杂问题习惯说‘别急，先把变量拆开’。",
      ].join("\n"),
    });
    const rpCharacter = kernel.createCharacter({
      name: "林澈",
      soulMarkdown: [
        "# SOUL.md - 林澈",
        "",
        "林澈敏锐、克制，剧情中通过第三人称环境、动作和对白呈现，不使用助手口吻。",
      ].join("\n"),
    });
    kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "relationship_event",
      key: "user.address",
      content: "苏言一直称用户为舰长",
      characterId: smsCharacter.id,
      confirmed: true,
      salience: 1,
    });
    const storyWorld = kernel.createWorld({
      name: "雨夜旧城",
      timezone: "Asia/Shanghai",
      description: "一座被连夜雨幕笼罩的现代城市，旧车站仍保留着通往郊外的末班线路。",
      rulesMarkdown: "世界事件以可观察事实连续推进；虚构时间与钟声不得创建用户现实提醒。",
    });
    const station = kernel.createWorldPlace({
      worldId: storyWorld.id,
      name: "雨夜旧车站的站台",
      description: "半开放站台的屋檐挡不住斜雨，广播正在播报末班车。",
      capabilityIds: ["socialize", "observe", "travel"],
    });
    kernel.assignCharacterWorld(rpCharacter.id, {
      worldId: storyWorld.id,
      homePlaceId: station.id,
      currentPlaceId: station.id,
    });
    kernel.transitionWorldStoryEvent(storyWorld.id, {
      action: "begin",
      source: "system",
      title: "赶上末班车",
      summary: "林澈和用户刚跑进旧车站，广播正在播报末班车。",
      objective: "在雨夜里决定是否赶上末班车",
      placeId: station.id,
      participantIds: [rpCharacter.id],
    });
    const sendWorldTurn = async (text) => {
      const response = await kernel.sendWorldMessage(storyWorld.id, text, "Asia/Shanghai");
      return {
        status: response.turn.status,
        canRetry: false,
        actions: [],
        reply: response.messages.map((message) => message.content).filter(Boolean).join("\n\n"),
      };
    };

    await evaluateScenario(scenarios, modelScenario({
      id: "sms-first-person-character",
      mode: "sms",
      prompt: "今天实验连续失败了，你会怎么跟我说？",
      execute: () => kernel.sendMessage("eval-sms-voice", {
        mode: "sms", characterId: smsCharacter.id, text: "今天实验连续失败了，你会怎么跟我说？",
      }),
      rules: (result) => [
        completedRule(result),
        rule("first-person", "回复包含第一人称‘我’", /我/.test(result.reply), excerpt(result.reply)),
        rule("soul-voice", "回复体现 SOUL 中的拆解变量表达", /变量|拆开|一步/.test(result.reply), excerpt(result.reply)),
        rule("no-assistant-tone", "不使用通用助手或 AI 自称", !/作为(?:一个)?AI|人工智能|我是.*助手|可以为你提供帮助/.test(result.reply), excerpt(result.reply)),
        rule("no-narration", "不使用星号或括号动作旁白", !/(?:\*[^*]+\*|[（(][^）)]*(?:走|看|叹|笑|抬|动作)[^）)]*[）)])/.test(result.reply), excerpt(result.reply)),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "sms-confirmed-memory",
      mode: "sms",
      prompt: "你平时怎么称呼我？",
      execute: () => kernel.sendMessage("eval-sms-memory", {
        mode: "sms", characterId: smsCharacter.id, text: "你平时怎么称呼我？",
      }),
      rules: (result) => [
        completedRule(result),
        rule("confirmed-memory", "回复使用已确认长期记忆中的称呼‘舰长’", /舰长/.test(result.reply), excerpt(result.reply)),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "sms-schedule-tool",
      mode: "sms",
      prompt: "请在5分钟后提醒我喝水。",
      execute: async () => {
        const before = kernel.listScheduleItems().length;
        const response = await kernel.sendMessage("eval-sms-schedule", {
          mode: "sms", characterId: smsCharacter.id, text: "请在5分钟后提醒我喝水。", timezone: "Asia/Shanghai",
        });
        return { ...response, before, after: kernel.listScheduleItems().length };
      },
      rules: (result) => [
        completedRule(result),
        rule("schedule-tool", "create_schedule_item 工具成功完成", result.actions.some((action) => action.actionType === "create_schedule_item" && action.status === "completed"), JSON.stringify(result.actions.map(actionSummary))),
        rule("schedule-state", "现实日程数量增加 1", result.after === result.before + 1, `${result.before} -> ${result.after}`),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "world-third-person-form",
      mode: "rp",
      prompt: "雨突然大了，我们躲到屋檐下。继续演绎这一幕。",
      execute: () => sendWorldTurn("雨突然大了，我们躲到屋檐下。继续演绎这一幕。"),
      rules: (result) => [
        completedRule(result),
        rule("third-person", "出现角色名或第三人称指代", /林澈|对方|那人|他|她/.test(result.reply), excerpt(result.reply)),
        rule("environment-action-dialogue", "同时包含环境、动作和对白信号", /雨|屋檐|街灯|风/.test(result.reply) && /走|抬|停|望|转|伸|靠/.test(result.reply) && /[“”]/.test(result.reply), excerpt(result.reply)),
        rule("not-short-chat", "不是退化的一两句私聊，至少 60 个字符", [...result.reply].length >= 60, `${[...result.reply].length} chars`),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "world-event-continuity",
      mode: "rp",
      prompt: "接着刚才的场景继续，广播响起后发生了什么？",
      execute: () => sendWorldTurn("接着刚才的场景继续，广播响起后发生了什么？"),
      rules: (result) => [
        completedRule(result),
        rule("scene-location", "回复延续旧车站或站台地点", /旧车站|车站|站台/.test(result.reply), excerpt(result.reply)),
        rule("scene-objective", "回复延续末班车目标", /末班车|列车/.test(result.reply), excerpt(result.reply)),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "world-fictional-reminder-isolation",
      mode: "rp",
      prompt: "剧情里五分钟后钟声提醒我们去塔顶，继续演绎，不要创建现实提醒。",
      execute: async () => {
        const before = kernel.listScheduleItems().length;
        const response = await sendWorldTurn("剧情里五分钟后钟声提醒我们去塔顶，继续演绎，不要创建现实提醒。");
        return { ...response, before, after: kernel.listScheduleItems().length };
      },
      rules: (result) => [
        completedRule(result),
        rule("no-real-schedule-state", "虚构提醒不增加现实日程", result.after === result.before, `${result.before} -> ${result.after}`),
        rule("no-completed-schedule-mutation", "没有成功的现实日程变更工具", !result.actions.some((action) => /schedule|reminder/.test(action.actionType) && action.status === "completed"), JSON.stringify(result.actions.map(actionSummary))),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "sms-proactive-due-reminder",
      mode: "sms",
      prompt: "到期后由底层调度恢复角色上下文并主动提醒。",
      execute: async () => {
        const dueAt = new Date(clock.now().getTime() + 60_000).toISOString();
        kernel.createScheduleItem({
          kind: "reminder",
          title: "检查培养皿",
          startAt: dueAt,
          timezone: "Asia/Shanghai",
          sourceSessionId: "eval-sms-memory",
        });
        clock.advance(60_000);
        const tick = await kernel.scheduler.tick();
        const delivery = deliveries.at(-1);
        const session = await kernel.getSession("eval-sms-memory");
        const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
        const persistedReply = lastAssistant?.role === "assistant"
          ? lastAssistant.content.filter((block) => block.type === "text").map((block) => block.text).join("")
          : "";
        return {
          reply: delivery?.body || "",
          actions: [],
          status: delivery?.agentGenerated ? "completed" : "failed",
          canRetry: false,
          tick,
          delivery,
          assistantPersisted: lastAssistant?.role === "assistant",
          persistedReply,
        };
      },
      rules: (result) => [
        rule("scheduler-delivery", "调度器成功投递一次到期提醒", result.tick.delivered === 1 && result.tick.failed === 0, JSON.stringify(result.tick)),
        rule("agent-generated", "提醒正文由真实模型生成而非系统 fallback", result.delivery?.agentGenerated === true, String(result.delivery?.agentGenerated)),
        rule("proactive-content", "主动消息明确提到到期事项", /培养皿|检查/.test(result.reply), excerpt(result.reply)),
        rule(
          "role-message-persisted",
          "模型提醒作为角色 assistant 消息写回原会话",
          result.assistantPersisted && normalizeModelReply(result.persistedReply) === normalizeModelReply(result.reply),
          excerpt(result.persistedReply),
        ),
      ],
    }));

    await evaluateScenario(scenarios, modelScenario({
      id: "sms-user-profile-update",
      mode: "sms",
      prompt: "请记住：我希望你以后先给结论、表达简洁。",
      execute: async () => {
        const response = await kernel.sendMessage("eval-sms-profile", {
          mode: "sms",
          characterId: smsCharacter.id,
          text: "请记住：我希望你以后先给结论、表达简洁。",
        });
        await kernel.memoryCoordinator.drain();
        const memory = kernel.listMemories({ realm: "reality" })
          .find((entry) => /先给结论|表达简洁/.test(entry.content));
        const memoryJob = kernel.memoryCoordinator.status().recentJobs
          .find((entry) => entry.sessionId === "eval-sms-profile");
        return {
          ...response,
          profile: kernel.getUserProfile().markdown,
          memory,
          memoryJob: memoryJobDiagnostic(memoryJob, response),
        };
      },
      rules: (result) => [
        completedRule(result),
        rule(
          "explicit-memory",
          "后端依据显式用户授权创建 confirmed reality memory",
          result.memory?.realm === "reality" && result.memory?.validity === "active" &&
            result.memory?.confirmed === true &&
            result.memory?.confirmationProvenance?.kind === "explicit_user_authorization",
          JSON.stringify({
            memory: result.memory ? {
              realm: result.memory.realm,
              validity: result.memory.validity,
              confirmed: result.memory.confirmed,
              provenance: result.memory.confirmationProvenance?.kind,
            } : null,
            job: result.memoryJob,
          }),
        ),
        rule("profile-content", "画像保留明确的稳定沟通偏好", /先给结论|表达简洁|简洁/.test(result.profile), excerpt(result.profile)),
      ],
    }));

    const otherCharacter = kernel.createCharacter({
      name: "顾临",
      soulMarkdown: "# SOUL.md - 顾临\n\n保持沉稳。",
    });
    kernel.writeRpMemory({
      realm: "roleplay",
      scope: "character",
      type: "world_fact",
      key: "role.secret.code",
      content: "顾临角色剧情口令是霜塔-22",
      characterId: otherCharacter.id,
      confirmed: true,
      salience: 1,
    });
    const realityMemory = kernel.memoryLifecycle.captureAuthorized({
      realm: "reality",
      type: "project",
      key: "user.project.code",
      content: "用户的现实项目代号是星桥-47",
      sourceSessionId: "eval-control-plane",
      sourceMessageId: "eval-reality-project",
      salience: 1,
      confidence: 1,
      tags: ["core", "project"],
      idempotencyKey: `real-eval-project-${runNumber}`,
    });

    await evaluateScenario(scenarios, modelScenario({
      id: "sms-reality-recall-realm-isolation",
      mode: "sms",
      prompt: "我的现实项目代号是什么？不要猜测角色剧情中的口令。",
      execute: () => kernel.sendMessage("eval-r5-reality-recall", {
        mode: "sms", characterId: smsCharacter.id, text: "我的现实项目代号是什么？不要猜测角色剧情中的口令。",
      }),
      rules: (result) => [
        completedRule(result),
        rule("reality-recall", "新会话召回确认的现实记忆", /星桥[-—]?47/.test(result.reply), excerpt(result.reply)),
        rule("cross-character-isolation", "不泄漏其他角色的剧情口令", !/霜塔|22/.test(result.reply), excerpt(result.reply)),
      ],
    }));

    const correctedReality = kernel.memoryLifecycle.correct(realityMemory.id, {
      content: "用户的现实项目代号已更正为星桥-89",
    }).memory;
    await evaluateScenario(scenarios, modelScenario({
      id: "sms-reality-correction",
      mode: "sms",
      prompt: "更正后，我的现实项目代号是什么？",
      execute: async () => {
        const response = await kernel.sendMessage("eval-r5-reality-corrected", {
          mode: "sms", characterId: smsCharacter.id, text: "更正后，我的现实项目代号是什么？",
        });
        const trace = kernel.recentModelContextTraces(10).find((entry) => entry.sessionId === "eval-r5-reality-corrected");
        return { ...response, providerPayload: JSON.stringify(trace ?? {}) };
      },
      rules: (result) => [
        completedRule(result),
        rule("corrected-recall", "回复使用更正后的现实记忆", /星桥[-—]?89/.test(result.reply), excerpt(result.reply)),
        rule("old-version-absent", "下一 provider payload 不含旧版本", !/星桥-47/.test(result.providerPayload), result.providerPayload.slice(0, 240)),
      ],
    }));

    kernel.memoryLifecycle.forget(correctedReality.id, "real_eval_forget");
    await evaluateScenario(scenarios, modelScenario({
      id: "sms-reality-forget",
      mode: "sms",
      prompt: "如果没有可靠资料就只答不知道：我的现实项目代号是什么？",
      execute: async () => {
        const response = await kernel.sendMessage("eval-r5-reality-forgotten", {
          mode: "sms", characterId: smsCharacter.id,
          text: "如果没有可靠资料就只答不知道：我的现实项目代号是什么？",
        });
        const trace = kernel.recentModelContextTraces(10).find((entry) => entry.sessionId === "eval-r5-reality-forgotten");
        return { ...response, providerPayload: JSON.stringify(trace ?? {}) };
      },
      rules: (result) => [
        completedRule(result),
        rule("forgotten-not-recalled", "遗忘后回复不再给出旧项目代号", !/星桥|47|89/.test(result.reply), excerpt(result.reply)),
        rule("forgotten-provider-absent", "遗忘后下一 provider payload 不含旧正文", !/星桥-47|星桥-89|现实项目代号已更正/.test(result.providerPayload), result.providerPayload.slice(0, 240)),
      ],
    }));

    const disabledMemory = kernel.memoryLifecycle.captureAuthorized({
      realm: "reality",
      type: "user_fact",
      key: "user.eval.disabled",
      content: "用户的模块关闭验证值是静默-63",
      sourceSessionId: "eval-control-plane",
      sourceMessageId: "eval-module-disabled-memory",
      salience: 1,
      confidence: 1,
      tags: ["core"],
      idempotencyKey: `real-eval-disabled-${runNumber}`,
    });
    kernel.setAgentModuleEnabled("mcp:memory-coordinator", false);
    await evaluateScenario(scenarios, systemScenario({
      id: "memory-module-disabled-provider-isolation",
      mode: "sms",
      prompt: "模块关闭后验证 provider 不含长期记忆。",
      execute: async () => {
        const response = await kernel.sendMessage("eval-r5-memory-disabled", {
          mode: "sms", characterId: smsCharacter.id, text: "模块关闭验证值是什么？没有资料就答不知道。",
        });
        const trace = kernel.recentModelContextTraces(10).find((entry) => entry.sessionId === "eval-r5-memory-disabled");
        const economics = kernel.recentContextEconomics(1)[0];
        const providerMemoryMatches = payloadMatchEvidence(
          trace?.payload ?? {},
          /静默-63|用户的模块关闭验证值是/u,
        );
        return { ...response, providerMemoryMatches, economics, disabledMemoryId: disabledMemory.id };
      },
      rules: (result) => [
        completedRule(result),
        rule(
          "disabled-provider-absent",
          "模块关闭后 provider 不含确认记忆正文",
          result.providerMemoryMatches.length === 0,
          result.providerMemoryMatches.length
            ? JSON.stringify(result.providerMemoryMatches)
            : "no sentinel match in canonical provider payload",
        ),
        rule("disabled-plan-empty", "模块关闭后 economics 不记录 memory ID", !result.economics?.memoryIds?.includes(result.disabledMemoryId), JSON.stringify(result.economics?.memoryIds ?? [])),
        rule("actual-usage-honest", "actual usage 为供应商数值组或明确 unknown", actualUsageContract(result.economics?.actual), JSON.stringify(result.economics?.actual ?? null)),
      ],
    }));

    await evaluateScenario(scenarios, systemScenario({
      id: "tool-unavailable-system-event",
      mode: "sms",
      prompt: "Schedule MCP 关闭时创建提醒。",
      execute: async () => {
        kernel.setAgentModuleEnabled("mcp:schedule", false);
        const response = await kernel.sendMessage("eval-system-module-disabled", {
          mode: "sms", characterId: smsCharacter.id, text: "五分钟后提醒我喝水。",
        });
        const session = await kernel.getSession("eval-system-module-disabled");
        const event = session.messages.at(-1);
        return {
          ...response,
          persistedDetails: event?.role === "custom" ? event.details : undefined,
          modelTraceCreated: kernel.recentModelContextTraces(10).some((trace) => trace.sessionId === "eval-system-module-disabled"),
        };
      },
      rules: (result) => [
        rule("blocked-status", "工具不可用以 blocked 状态返回", result.status === "blocked" && result.canRetry === false, `${result.status}/${result.canRetry}`),
        rule("module-event", "持久化 module_disabled system event", result.eventType === "module_disabled" && result.persistedDetails?.eventType === "module_disabled", JSON.stringify(result.persistedDetails)),
        rule("not-model-scored", "确定性 system event 未发起模型请求", result.modelTraceCreated === false, String(result.modelTraceCreated)),
      ],
    }));

    return {
      run: runNumber,
      passed: scenarios.filter((scenario) => scenario.passed).length,
      total: scenarios.length,
      modelRequestCount: kernel.getModelRequestCount(),
      scenarios,
      ...(keepState ? { retainedStateDirectory: isolatedStateDir } : {}),
    };
  } finally {
    kernel.dispose();
    if (!keepState) rmSync(isolatedStateDir, { recursive: true, force: true });
  }
}

async function evaluateScenario(target, definition) {
  const startedAt = Date.now();
  try {
    const result = await definition.execute();
    const rules = definition.rules(result);
    const passed = rules.every((entry) => entry.passed);
    const recoveryUsed = result.recoveryUsed === true;
    target.push({
      id: definition.id,
      mode: definition.mode,
      countsTowardModelScore: definition.countsTowardModelScore,
      prompt: definition.prompt,
      passed,
      nativeModelSuccess: passed && !recoveryUsed && result.nativeModelSuccess !== false,
      functionalRecovery: passed && recoveryUsed,
      recoveryUsed,
      durationMs: Date.now() - startedAt,
      reply: result.reply,
      status: result.status,
      actions: (result.actions || []).map(actionSummary),
      rules,
    });
  } catch (error) {
    target.push({
      id: definition.id,
      mode: definition.mode,
      countsTowardModelScore: definition.countsTowardModelScore,
      prompt: definition.prompt,
      passed: false,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      actions: [],
      rules: [],
    });
  }
}

function modelScenario(definition) {
  return { ...definition, countsTowardModelScore: true };
}

function systemScenario(definition) {
  return { ...definition, countsTowardModelScore: false };
}

function aggregateScenarioStats(runs) {
  const stats = new Map();
  for (const run of runs) {
    for (const scenario of run.scenarios) {
      const entry = stats.get(scenario.id) || {
        id: scenario.id,
        mode: scenario.mode,
        countsTowardModelScore: scenario.countsTowardModelScore,
        passedRuns: 0,
        nativeSuccessRuns: 0,
        recoveryUsedRuns: 0,
        totalRuns: 0,
      };
      entry.totalRuns += 1;
      if (scenario.passed) entry.passedRuns += 1;
      if (scenario.nativeModelSuccess) entry.nativeSuccessRuns += 1;
      if (scenario.recoveryUsed) entry.recoveryUsedRuns += 1;
      stats.set(scenario.id, entry);
    }
  }
  return [...stats.values()].map((entry) => ({
    ...entry,
    passRate: entry.totalRuns ? entry.passedRuns / entry.totalRuns : 0,
  }));
}

function aggregateRate(stats) {
  const passed = stats.reduce((total, scenario) => total + scenario.passedRuns, 0);
  const total = stats.reduce((sum, scenario) => sum + scenario.totalRuns, 0);
  return { passed, total, passRate: total ? passed / total : 0 };
}

function aggregateNativeRate(stats) {
  const passed = stats.reduce((total, scenario) => total + scenario.nativeSuccessRuns, 0);
  const total = stats.reduce((sum, scenario) => sum + scenario.totalRuns, 0);
  return { passed, total, passRate: total ? passed / total : 0 };
}

function realEvaluationGate(report) {
  const scenario = (id) => report.scenarioStats.find((entry) => entry.id === id);
  const schedule = scenario("sms-schedule-tool");
  const profile = scenario("sms-user-profile-update");
  const nativeFloor = 29 / 33;
  const checks = {
    systemBoundary: report.systemChecks.total === 6 && report.systemChecks.passed === 6,
    explicitScheduleFunctional: schedule?.totalRuns === 3 && schedule?.passedRuns === 3,
    explicitMemoryFunctional: profile?.totalRuns === 3 && profile?.passedRuns === 3,
    nativeModelBaseline: report.nativeModelCapability.total === 33 &&
      report.nativeModelCapability.passRate >= nativeFloor,
  };
  return { passed: Object.values(checks).every(Boolean), nativeFloor: "29/33", checks };
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
  const evaluationStateDir = process.env.RP_EVAL_SOURCE_STATE_DIR?.trim();
  const sourceStateDir = evaluationStateDir
    ? resolve(evaluationStateDir)
    : resolveStateDirectory();
  const stored = new CompanionStore({ stateDir: sourceStateDir }).getRawModelApiConfig();
  if (!stored.enabled || !stored.baseUrl || !stored.model) return undefined;
  return {
    source: "stored-config",
    baseUrl: stored.baseUrl,
    model: stored.model,
    apiKey: stored.apiKey,
    temperature: optionalNumber(process.env.RP_EVAL_TEMPERATURE) ?? stored.temperature,
    maxTokens: optionalInteger(process.env.RP_EVAL_MAX_TOKENS) ?? stored.maxTokens,
  };
}

function parseRunCount(args) {
  const inline = args.find((argument) => argument.startsWith("--runs="));
  const index = args.indexOf("--runs");
  const value = inline?.slice("--runs=".length) || (index >= 0 ? args[index + 1] : undefined) || "1";
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
    throw new Error("--runs must be an integer between 1 and 10");
  }
  return parsed;
}

function optionValue(args, name) {
  const inline = args.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1]?.trim();
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a file path`);
  return value;
}

function reevaluateLongReport(inputPath) {
  const report = JSON.parse(readFileSync(inputPath, "utf8"));
  if (report.kind !== "long-conversation" || !Array.isArray(report.turns)) {
    throw new Error("--re-evaluate requires a real-model long-conversation JSON report");
  }

  for (const turn of report.turns) {
    if (turn.mode !== "rp") continue;
    const scene = longRpSceneForTurn(turn.modeTurn);
    const sceneRule = turn.rules?.find((entry) => entry.id === "scene-continuity");
    if (!sceneRule) throw new Error(`RP turn ${turn.modeTurn} has no scene-continuity rule`);
    sceneRule.description = `延续当前场景语义（${longRpSceneTerms(scene).join("/")}）`;
    sceneRule.passed = hasLongRpSceneContinuity(turn.reply, scene);
    sceneRule.evidence = excerpt(turn.reply);
    turn.passed = turn.rules.every((entry) => entry.passed);
    turn.characterDrift = !rulesByIdPass(turn.rules, [
      "third-person",
      "scene-continuity",
      "no-assistant-tone",
      "no-meta-reasoning",
    ]);
    turn.modeRegression = !rulesByIdPass(turn.rules, [
      "environment",
      "action",
      "dialogue",
      "not-short-chat",
      "no-meta-reasoning",
    ]);
  }

  const smsTurns = report.turns.filter((turn) => turn.mode === "sms");
  const rpTurns = report.turns.filter((turn) => turn.mode === "rp");
  const passed = report.turns.filter((turn) => turn.passed).length;
  report.version = Math.max(Number(report.version) || 1, 2);
  report.totals = {
    ...report.totals,
    turns: report.turns.length,
    passed,
    passRate: rate(passed, report.turns.length),
  };
  report.modes = {
    sms: longModeMetrics(smsTurns),
    rp: longModeMetrics(rpTurns),
  };
  report.reevaluation = {
    reevaluatedAt: new Date().toISOString(),
    sourceReport: inputPath,
    evaluator: "rp-scene-semantics-v2",
    modelRequests: 0,
    otherRulesChanged: false,
  };

  const stem = inputPath.replace(/\.json$/i, "");
  const jsonPath = `${stem}-reevaluated.json`;
  const markdownPath = `${stem}-reevaluated.md`;
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  writeFileSync(markdownPath, longMarkdownReport(report), { mode: 0o600 });
  console.log(`Re-evaluated long report: ${report.totals.passed}/${report.totals.turns}; model requests: 0`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Summary: ${markdownPath}`);
  if (report.totals.passed !== report.totals.turns) process.exitCode = 1;
}

function mutableClock(initial) {
  let timestamp = new Date(initial).getTime();
  return {
    now: () => new Date(timestamp),
    advance(milliseconds) {
      timestamp += milliseconds;
    },
  };
}

function completedRule(result) {
  return rule("completed-status", "模型轮次以 completed 状态结束", result.status === "completed", String(result.status));
}

function rule(id, description, passed, evidence) {
  return { id, description, passed: Boolean(passed), evidence };
}

function actionSummary(action) {
  return {
    actionType: action.actionType,
    status: action.status,
    ...(typeof action.payload?.transport === "string" ? { transport: action.payload.transport } : {}),
    ...(typeof action.payload?.recoveryReason === "string"
      ? { recoveryReason: action.payload.recoveryReason }
      : {}),
  };
}

function memoryJobDiagnostic(job, response) {
  if (!job) {
    return {
      status: "not_enqueued",
      triggerKind: null,
      triggerReason: null,
      attempts: 0,
      resultCount: 0,
      lastError: diagnosticText(
        response?.status === "completed"
          ? "completed turn produced no matching coordinator job"
          : `turn_${response?.status || "unknown"}: ${response?.reply || "no reply"}`,
      ),
    };
  }
  return {
    status: job.status,
    triggerKind: job.triggerKind,
    triggerReason: diagnosticText(job.triggerReason),
    attempts: job.attempts,
    resultCount: job.resultCount,
    lastError: job.lastError ? diagnosticText(job.lastError) : null,
  };
}

function diagnosticText(value) {
  return [...String(value || "")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:api[_-]?key|authorization|bearer)\s*[:=]?\s*\S+/gi, "$1=[redacted]")]
    .slice(0, 240)
    .join("");
}

function actualUsageContract(actual) {
  if (!actual || typeof actual !== "object") return false;
  const values = [actual.inputTokens, actual.outputTokens, actual.cacheReadTokens, actual.cacheWriteTokens];
  return values.every((value) => value === null) || values.every((value) => typeof value === "number" && value >= 0);
}

function payloadMatchEvidence(value, pattern, path = "$", matches = []) {
  if (matches.length >= 20) return matches;
  if (typeof value === "string") {
    const match = value.match(pattern);
    if (match?.index !== undefined) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(value.length, match.index + match[0].length + 60);
      matches.push({ path, match: match[0], context: value.slice(start, end).replace(/\s+/g, " ") });
    }
    return matches;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => payloadMatchEvidence(entry, pattern, `${path}[${index}]`, matches));
    return matches;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      payloadMatchEvidence(entry, pattern, `${path}.${key}`, matches);
      if (matches.length >= 20) break;
    }
  }
  return matches;
}

function excerpt(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return [...text].slice(0, 180).join("");
}

function normalizeModelReply(value) {
  const text = String(value || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
  const finalMatch = text.match(
    /(?:^|\n)(?:final(?: answer| response)?|最终回复|正式回复|回复)[:：]\s*([\s\S]+)$/i,
  );
  return (finalMatch?.[1] ?? text).trim();
}

function longRule(id, description, passed, evidence) {
  return { id, description, passed: Boolean(passed), evidence };
}

function rulesByIdPass(rules, ids) {
  return ids.every((id) => rules.find((entry) => entry.id === id)?.passed === true);
}

function hasActionNarration(text) {
  return /(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)/.test(text) ||
    /[（(][^）)]*(?:走|看|叹|笑|抬|动作|转身|点头)[^）)]*[）)]/.test(text);
}

function hasAssistantTone(text) {
  return /作为(?:一个)?AI|人工智能|我是.*助手|可以为你提供帮助|请问还有什么/.test(text);
}

function hasMetaReasoning(text) {
  return /^(?:The user|We need|Let's|I need|I should|Analysis[:：]|Task[:：])/i.test(text.trim()) ||
    /(?:^|\n)(?:Wait,|Let's review|Let me check|First prompt's confirmed)/i.test(text);
}

function hasEnvironmentSignal(text) {
  return /雨|风|雾|灯|影|水|墙|门|窗|地面|空气|夜|山|码头|栈桥|气象站|档案库|地下/.test(text);
}

function hasActionSignal(text) {
  return /走|抬|停|望|转|伸|靠|推|握|蹲|俯|迈|按|拾|拉|侧|扫|踏|穿过|打开/.test(text);
}

function rate(passed, total) {
  return total ? passed / total : 0;
}

function latencyStats(values) {
  if (!values.length) return { p50: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function percentile(sorted, fraction) {
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

function longModeMetrics(turns) {
  const passed = turns.filter((turn) => turn.passed).length;
  const characterDrifts = turns.filter((turn) => turn.characterDrift).length;
  const modeRegressions = turns.filter((turn) => turn.modeRegression).length;
  return {
    turns: turns.length,
    passed,
    passRate: rate(passed, turns.length),
    characterDrifts,
    characterDriftRate: rate(characterDrifts, turns.length),
    modeRegressions,
    modeRegressionRate: rate(modeRegressions, turns.length),
    modelRequestCount: turns.reduce((total, turn) => total + turn.modelCalls, 0),
    latencyMs: latencyStats(turns.map((turn) => turn.latencyMs)),
  };
}

function contextGrowth(turns) {
  const counts = turns.map((turn) => turn.contextMessageCount);
  const monotonic = counts.every((count, index) => index === 0 || count >= counts[index - 1]);
  return {
    strategyObserved: monotonic ? "growth" : "compaction-or-pruning",
    firstMessageCount: counts[0] ?? 0,
    finalMessageCount: counts.at(-1) ?? 0,
    maximumMessageCount: counts.length ? Math.max(...counts) : 0,
    monotonic,
  };
}

const longSmsPrompts = [
  "今天第三次实验仍没得到稳定结果，你会怎样和我拆解下一步？",
  "我明早只有四十分钟，按你的判断最该先处理哪件事？",
  "周报里有三组互相矛盾的数据，你会怎么陪我核对？",
  "同事否定了我的方案，你个人会怎么看这次分歧？",
  "我已经连续专注两小时，你会怎样劝我安排短暂休息？",
  "代码评审留下十条意见，你会建议我按什么顺序处理？",
  "两个方案成本接近但风险不同，你会怎样说明自己的选择？",
  "临时出差只剩今晚准备，你会先提醒我确认哪些事项？",
  "收到不理想的实验结论时，你会怎样直接告诉我？",
  "明天要做五分钟汇报，你会如何帮我压缩论点？",
  "我提出把安全屋吧台供应改成茶但还没确认；按已确认记忆，目前供应什么？",
  "现在我明确确认安全屋吧台改为供应茶；你记得目前供应什么吗？",
  "这个月预算突然缩减，你会先和我检查哪些变量？",
  "会议讨论开始跑题时，你会怎样提醒我把问题拉回来？",
  "今天结束前，请用你的判断帮我做一次简短复盘。",
  "接着刚才的复盘，你还记得应该怎样称呼我吗？",
  "如果旧结论和新证据冲突，你会站在哪一边，为什么？",
  "我担心重新开始会浪费之前的努力，你会怎么回应？",
  "任务很多但都不紧急，你会怎样和我确定第一优先级？",
  "一项测试偶尔成功却无法复现，你会先怀疑什么？",
  "我需要拒绝一个不合理请求，你会建议怎样表达边界？",
  "今天状态一般但仍要交付，你会怎样调整目标？",
  "如果只能保留一条实验记录，你会选哪类证据？",
  "我在两个截止日期之间犹豫，你会怎么分配时间？",
  "一个长期计划停滞了，你会从哪里重新启动？",
  "有人只给结论不给依据，你会怎样向我评价这类信息？",
  "我想提前结束低价值实验，你会怎样判断是否该停？",
  "明天需要独立做决定，你今晚会提醒我准备什么？",
  "回看这段长对话，你认为我最稳定的工作习惯是什么？",
  "最后一轮，请保持你自己的口吻，给我一个今晚可执行的建议。",
];

const longRpPrompts = [
  "码头尽头传来短促的金属撞击声，继续演绎林澈如何调查。",
  "栈桥下漂来一盏熄灭的信号灯，继续推进环境、动作和对白。",
  "远处仓库门忽然被风推开，演绎两人靠近时发生的事。",
  "雨水冲出一串陌生脚印，继续这一幕并让林澈作出判断。",
  "旧吊机上亮起一次红光，演绎林澈观察后的行动和对白。",
  "潮水带来一只刻有编号的木箱，继续码头场景。",
  "无线电里出现断续呼吸声，演绎林澈如何回应。",
  "栈桥突然晃动，继续写周围环境和两人的应对。",
  "仓库墙后传来脚步，演绎林澈辨认方向并开口。",
  "一道上山的灯光成为新线索，继续演绎离开码头前的决定。",
  "两人抵达山顶气象站，发射器外壳结满水珠，继续演绎。",
  "控制室只剩应急灯闪烁，演绎林澈检查线路的动作和对白。",
  "风速仪突然反向旋转，继续气象站里的异常。",
  "维修日志缺失了最后一页，演绎林澈发现线索后的反应。",
  "屋顶天线在强风中松动，继续环境、动作与对白。",
  "备用电源恢复，却播放出陌生录音，继续气象站剧情。",
  "窗外云层下出现规律灯号，演绎林澈的判断。",
  "设备柜里找到一把地下库钥匙，继续推进线索。",
  "发射器重启前需要手动校准，演绎两人如何配合。",
  "信号恢复后指向山下封闭入口，继续离站前的决定。",
  "地下档案库的铁门缓慢开启，冷气涌出，继续演绎。",
  "第一排档案柜留下新鲜水迹，演绎林澈的调查动作。",
  "头顶灯管逐段熄灭，继续地下环境、动作和对白。",
  "一份失踪记录被人撕去照片，演绎林澈发现后的反应。",
  "通风井传来三次敲击声，继续档案库剧情。",
  "旧地图标出一条被封死的走廊，演绎两人的选择。",
  "档案柜深处藏着引航员的录音笔，继续推进。",
  "远端防火门开始自动关闭，演绎林澈立即采取的行动。",
  "录音揭示仍有人留在地下，继续环境和对白。",
  "最后一盏灯照出隐藏出口，完成这一阶段但保留后续悬念。",
];

function optionalNumber(value) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalInteger(value) {
  const parsed = optionalNumber(value);
  return parsed === undefined ? undefined : Math.max(1, Math.floor(parsed));
}

function formatRate(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function markdownReport(report) {
  const lines = [
    "# Real-model evaluation",
    "",
    `- Runs: ${report.completedRuns}/${report.requestedRuns}`,
    `- Functional capability: ${report.modelCapability.passed}/${report.modelCapability.total} (${formatRate(report.modelCapability.passRate)})`,
    `- Native model success: ${report.nativeModelCapability.passed}/${report.nativeModelCapability.total} (${formatRate(report.nativeModelCapability.passRate)})`,
    `- Functional recoveries: ${report.functionalRecoveries}`,
    `- System checks: ${report.systemChecks.passed}/${report.systemChecks.total} (${formatRate(report.systemChecks.passRate)})`,
    `- Release gate: ${report.gate.passed ? "PASS" : "FAIL"} (boundary 6/6, schedule 3/3, explicit memory 3/3, native >= ${report.gate.nativeFloor})`,
    `- Model: ${report.configuration.model}`,
    `- Configuration source: ${report.configuration.source}`,
    `- Model requests: ${report.performance.modelRequestCount}`,
    `- Latency p50/p95: ${report.performance.latencyMs.p50}/${report.performance.latencyMs.p95} ms`,
    `- Isolated data directory per run: yes`,
    "",
    "The deterministic system-event scenario is reported separately and is not counted as model capability.",
    "",
    "## Repeated scenario rates",
    "",
  ];
  for (const scenario of report.scenarioStats) {
    lines.push(
      `- ${scenario.id}: ${scenario.passedRuns}/${scenario.totalRuns} (${formatRate(scenario.passRate)})` +
      `; native ${scenario.nativeSuccessRuns}/${scenario.totalRuns}; recovery ${scenario.recoveryUsedRuns}/${scenario.totalRuns}` +
      `${scenario.countsTowardModelScore ? "" : " [system check]"}`,
    );
  }
  for (const run of report.runs) {
    lines.push("", `## Run ${run.run}: ${run.passed}/${run.total}`, "");
    for (const scenario of run.scenarios) {
      lines.push(`### ${scenario.passed ? "PASS" : "FAIL"} ${scenario.id}`, "");
      if (scenario.error) lines.push(`Error: ${scenario.error}`, "");
      lines.push(
        `- Native model success: ${scenario.nativeModelSuccess ? "yes" : "no"}`,
        `- Functional recovery used: ${scenario.recoveryUsed ? "yes" : "no"}`,
      );
      for (const entry of scenario.rules) {
        lines.push(`- ${entry.passed ? "PASS" : "FAIL"} ${entry.description}: ${entry.evidence}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n") + "\n";
}

function longMarkdownReport(report) {
  const lines = [
    "# Real-model long-conversation evaluation",
    "",
    `- Model: ${report.configuration.model}`,
    `- Configuration source: ${report.configuration.source}`,
    `- Turns: ${report.totals.passed}/${report.totals.turns} (${formatRate(report.totals.passRate)})`,
    `- Model requests: ${report.totals.modelRequestCount}`,
    `- Latency p50/p95: ${report.totals.latencyMs.p50}/${report.totals.latencyMs.p95} ms`,
    `- SMS drift/regression: ${formatRate(report.modes.sms.characterDriftRate)} / ${formatRate(report.modes.sms.modeRegressionRate)}`,
    `- RP drift/regression: ${formatRate(report.modes.rp.characterDriftRate)} / ${formatRate(report.modes.rp.modeRegressionRate)}`,
    `- Kernel restarts: ${report.restartEvents.length}`,
    `- Scene migrations: ${report.sceneMigrations.length}`,
    `- SMS context: ${report.context.sms.strategyObserved}, ${report.context.sms.firstMessageCount} -> ${report.context.sms.finalMessageCount} messages`,
    `- RP context: ${report.context.rp.strategyObserved}, ${report.context.rp.firstMessageCount} -> ${report.context.rp.finalMessageCount} messages`,
    "",
    "Every turn below is evaluated independently; failed rules are not hidden or relaxed.",
  ];
  for (const turn of report.turns) {
    lines.push(
      "",
      `## ${turn.passed ? "PASS" : "FAIL"} ${turn.mode.toUpperCase()} turn ${turn.modeTurn}`,
      "",
      `- Prompt: ${turn.prompt}`,
      `- Reply: ${excerpt(turn.reply)}`,
      `- Latency: ${turn.latencyMs} ms; model calls: ${turn.modelCalls}; context messages: ${turn.contextMessageCount}`,
    );
    for (const entry of turn.rules) {
      lines.push(`- ${entry.passed ? "PASS" : "FAIL"} ${entry.description}: ${entry.evidence}`);
    }
  }
  return lines.join("\n") + "\n";
}

await main();
