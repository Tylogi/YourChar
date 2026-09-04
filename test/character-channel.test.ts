import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CharacterCollaborationReporterInput } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/index.js";
import type {
  CharacterChannelEpisode,
  CharacterInteractionActorInput,
} from "../src/world/index.js";

test("character channels persist exchanges, unread state, relationships, and scoped memories", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-character-channel-"));
  const actorInputs: CharacterInteractionActorInput[] = [];
  const actor = async (input: CharacterInteractionActorInput) => {
    actorInputs.push(input);
    return `${input.peerName}，我收到了。`;
  };
  const first = createTestRuntime({
    stateDir,
    seed: "character-channel-persist",
    characterInteractionActor: actor,
    characterInteractionSceneComposer: async () => ({
      narrativeText: "雨声落在工作室窗沿。发起角色放下手中的记录，向目标角色问起整理进度；目标角色抬起头，认真给出了回应。",
      eventSummary: "发起角色询问实验记录的整理进度，目标角色确认已经收到。",
      sourcePerspectiveSummary: "我向目标角色确认了实验记录的进度，觉得她的回应很认真。",
      targetPerspectiveSummary: "发起角色来问实验记录，我及时回应，也记住了他在意整理进度。",
    }),
  });
  let channelId = "";
  try {
    const setup = setupSharedWorld(first);
    const result = await first.kernel.sendCharacterChannelMessage({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      message: "真由理，实验记录整理得怎么样了？",
      idempotencyKey: "direct-message-once",
      source: "manual",
    });
    channelId = result.channel.id;
    assert.equal(result.episode.status, "completed");
    assert.equal(result.responseText, "发起角色，我收到了。");
    assert.equal(result.messages.length, 2);
    assert.deepEqual(result.messages.map((message) => message.senderCharacterId), [
      setup.source.id,
      setup.target.id,
    ]);
    assert.equal(result.scene?.narrativeText.startsWith("雨声落在工作室窗沿"), true);
    assert.equal(result.scene?.eventSummary, "发起角色询问实验记录的整理进度，目标角色确认已经收到。");
    assert.equal(result.reflections.length, 2);
    assert.notEqual(result.reflections[0].summary, result.reflections[1].summary);
    assert.equal(actorInputs.length, 1);
    assert.equal(actorInputs[0].actorCharacterId, setup.target.id);
    assert.equal(actorInputs[0].peerCharacterId, setup.source.id);

    const summary = first.kernel.listCharacterChannels({ worldId: setup.world.id })[0];
    assert.equal(summary.id, channelId);
    assert.equal(summary.unreadCount, 1);
    assert.equal(summary.preview, result.scene?.narrativeText);
    assert.deepEqual(summary.characterNames, ["发起角色", "目标角色"]);
    assert.equal(first.kernel.markCharacterChannelRead(channelId).unreadCount, 0);

    const sourceRelationship = first.kernel.worldConversationService.repository.getCharacterRelationship(
      setup.world.id,
      setup.source.id,
      setup.target.id,
    );
    assert.equal(sourceRelationship?.affinity, 51);
    assert.equal(sourceRelationship?.trust, 41);
    assert.equal(sourceRelationship?.intimacy, 16);
    assert.equal(first.kernel.worldConversationService.repository.listObservations(
      setup.source.id,
      setup.world.id,
      10,
    ).length, 1);
    const targetMemory = first.kernel.searchRpMemories({
      characterId: setup.target.id,
      type: "relationship_event",
      confirmedOnly: true,
    }).find((memory) => memory.key === `character-channel:${result.episode.id}`);
    const sourceMemory = first.kernel.searchRpMemories({
      characterId: setup.source.id,
      type: "relationship_event",
      confirmedOnly: true,
    }).find((memory) => memory.key === `character-channel:${result.episode.id}`);
    assert.match(sourceMemory?.content ?? "", /觉得她的回应很认真/u);
    assert.doesNotMatch(sourceMemory?.content ?? "", /及时回应/u);
    assert.match(targetMemory?.content ?? "", /及时回应/u);
    assert.doesNotMatch(targetMemory?.content ?? "", /觉得她的回应很认真/u);
  } finally {
    first.dispose();
  }

  const second = createTestRuntime({
    stateDir,
    seed: "character-channel-restart",
    characterInteractionActor: actor,
  });
  try {
    const snapshot = second.kernel.getCharacterChannel(channelId);
    assert.equal(snapshot.messages.length, 2);
    assert.equal(snapshot.scenes.length, 1);
    assert.equal(snapshot.reflections.length, 2);
    assert.match(snapshot.scenes[0].narrativeText, /雨声落在工作室窗沿/u);
    assert.equal(snapshot.episodes[0].status, "completed");
    assert.equal(snapshot.channel.unreadCount, 0);
  } finally {
    second.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("model-facing character tools separate conversation from delegated work", async () => {
  const runtime = createTestRuntime({
    seed: "character-tool-intent-contract",
    characterInteractionActor: async () => "这条 actor 回复不应被调用。",
  });
  try {
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "我明白你的意思。",
    }]);
    await runtime.kernel.sendMessage("character-tool-intent-contract", {
      mode: "sms",
      characterId: setup.source.id,
      text: "先正常聊一句。",
    });

    const tools = runtime.model.requests[0].providerPayload.tools as Array<{
      name?: string;
      description?: string;
      parameters?: {
        properties?: Record<string, { description?: string }>;
        required?: string[];
      };
    }>;
    const sendMessage = tools.find((tool) => tool.name === "send_character_message");
    const requestHelp = tools.find((tool) => tool.name === "request_character_help");
    assert.ok(sendMessage, "send_character_message must be exposed to a same-world SMS character");
    assert.ok(requestHelp, "request_character_help must be exposed to a same-world SMS character");

    const sendDescription = (sendMessage.description ?? "").toLowerCase();
    assert.match(
      sendDescription,
      /\bordinary\b/u,
      "send_character_message must identify ordinary messaging as its positive use case",
    );
    assert.match(
      sendDescription,
      /\brelays?\b/u,
      "send_character_message must identify relaying a message as its positive use case",
    );
    assert.match(
      sendDescription,
      /\bsocial conversation\b/u,
      "send_character_message must identify social conversation as its positive use case",
    );
    assert.match(
      sendDescription,
      /\bdo not use\b/u,
      "send_character_message must redirect result-bearing delegated work to request_character_help",
    );
    assert.match(sendDescription, /\b(?:collaboration|delegation)\b/u);
    assert.match(sendDescription, /\b(?:work result|answer\/result|deliverable)\b/u);
    assert.match(sendDescription, /\brequest_character_help\b/u);

    const helpDescription = (requestHelp.description ?? "").toLowerCase();
    assert.match(helpDescription, /\bqueue\b/u);
    assert.match(helpDescription, /\bdelegate\b/u);
    assert.match(helpDescription, /\bbounded task\b/u);
    assert.match(
      helpDescription,
      /\bdurable acceptance\b/u,
      "request_character_help must return durable acceptance instead of blocking on the target actor",
    );
    assert.match(helpDescription, /\bbackground\b/u);
    assert.match(helpDescription, /\bdeliver\b.*\blater\b/u);
    assert.match(helpDescription, /\bdo not wait\b/u);
    assert.match(helpDescription, /\b(?:result|deliverable)\b/u);
    assert.match(helpDescription, /\btask intent\b/u);
    assert.match(
      helpDescription,
      /\btakes precedence\b/u,
      "request_character_help must make task intent override conversational surface wording",
    );
    for (const surfaceWord of ["ask", "message", "chat", "check"]) {
      assert.match(
        helpDescription,
        new RegExp(`\\b${surfaceWord}\\b`, "u"),
        `request_character_help must cover the misleading surface verb ${surfaceWord}`,
      );
    }

    assert.deepEqual(
      Object.keys(sendMessage.parameters?.properties ?? {}).sort(),
      ["message", "targetCharacterId"],
    );
    assert.deepEqual(
      [...(sendMessage.parameters?.required ?? [])].sort(),
      ["message", "targetCharacterId"],
    );
    assert.equal(
      Object.hasOwn(sendMessage.parameters?.properties ?? {}, "task"),
      false,
      "send_character_message must not expose a delegated task argument",
    );
    const sendInputDescription =
      sendMessage.parameters?.properties?.message?.description ?? "";
    assert.match(sendInputDescription, /\b(?:social|coordination)\b/i);
    assert.match(sendInputDescription, /\b(?:delegated task|work product)\b/i);
    assert.match(sendInputDescription, /\brequest_character_help\b/i);
    assert.deepEqual(
      Object.keys(requestHelp.parameters?.properties ?? {}).sort(),
      ["context", "message", "requiredSkillIds", "targetCharacterId", "task"],
    );
    assert.deepEqual(requestHelp.parameters?.required, ["task"]);
    assert.match(
      requestHelp.parameters?.properties?.task?.description ?? "",
      /\bdelegated task\b.*\bclear expected (?:answer|result|deliverable)\b/i,
    );
  } finally {
    runtime.dispose();
  }
});

test("World MCP queues collaboration immediately and the source character reports the result later", async () => {
  const actorInputs: CharacterInteractionActorInput[] = [];
  const actorStarted = createDeferred<void>();
  const actorResult = createDeferred<string>();
  const reporterInputs: CharacterCollaborationReporterInput[] = [];
  let actorReleased = false;
  const runtime = createTestRuntime({
    seed: "character-collaboration-mcp",
    characterInteractionActor: async (input) => {
      actorInputs.push(input);
      actorStarted.resolve();
      return actorResult.promise;
    },
    characterCollaborationReporter: async (input) => {
      reporterInputs.push(input);
      return "真由理核对完了：先按时间排序，再检查缺失项。";
    },
  });
  try {
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "request_character_help",
        arguments: {
          targetCharacterId: setup.target.id,
          task: "给出整理实验记录的检查步骤",
          context: "只处理共享的实验记录。",
        },
      },
      {
        kind: "assistant_text",
        text: "我已经请真由理帮忙核对了，她完成后我再来告诉你。",
      },
    ]);
    const response = await withTimeout(
      runtime.kernel.sendMessage("source-collaboration-session", {
        mode: "sms",
        characterId: setup.source.id,
        text: "你问问真由理该怎么整理实验记录。",
      }),
      1_000,
    );
    assert.equal(response.status, "completed");
    assert.match(response.reply, /已经请真由理/);
    assert.equal(actorReleased, false, "the source turn must not wait for the target actor");
    await withTimeout(actorStarted.promise, 1_000);
    assert.equal(actorInputs.length, 1);
    assert.equal(actorInputs[0].purpose, "collaboration_result");
    assert.equal(actorInputs[0].actorCharacterId, setup.target.id);
    assert.match(actorInputs[0].objective ?? "", /整理实验记录/);
    assert.equal(runtime.model.requests[0].toolNames.includes("send_character_message"), true);
    assert.equal(runtime.model.requests[0].toolNames.includes("request_character_help"), true);
    assert.match(JSON.stringify(runtime.model.requests[1].messages), /后台处理/);
    assert.doesNotMatch(JSON.stringify(runtime.model.requests[1].messages), /先按时间排序/);

    const channel = runtime.kernel.listCharacterChannels({ worldId: setup.world.id })[0];
    const inFlight = runtime.kernel.getCharacterChannel(channel.id);
    assert.equal(inFlight.episodes[0].kind, "collaboration");
    assert.equal(["queued", "running"].includes(inFlight.episodes[0].status), true);
    assert.deepEqual(inFlight.messages.map((message) => message.kind), ["task"]);
    assert.equal(response.actions.some((action) => action.actionType === "request_character_help"), true);

    actorReleased = true;
    actorResult.resolve("我核对过思路了：先按时间排序，再检查缺失项。");
    await runtime.kernel.characterInteractionCoordinator.drain();

    const snapshot = runtime.kernel.getCharacterChannel(channel.id);
    assert.equal(snapshot.episodes[0].status, "completed");
    assert.equal(snapshot.episodes[0].reportStatus, "delivered");
    assert.equal(snapshot.episodes[0].reportAttempts, 1);
    assert.equal(snapshot.episodes[0].resultText, "我核对过思路了：先按时间排序，再检查缺失项。");
    assert.deepEqual(snapshot.messages.map((message) => message.kind), ["task", "result"]);
    assertCollaborationMetrics(snapshot.episodes[0], {
      targetModelCalls: 0,
      reportModelCalls: 0,
    });
    assert.equal(reporterInputs.length, 1);
    assert.equal(reporterInputs[0].status, "completed");
    assert.equal(reporterInputs[0].resultText, "我核对过思路了：先按时间排序，再检查缺失项。");
    assert.equal(reporterInputs[0].sourceCharacterId, setup.source.id);
    assert.equal(reporterInputs[0].targetCharacterId, setup.target.id);
    assert.match(reporterInputs[0].objective, /整理实验记录/);
    const reporterProgress = reporterInputs[0] as CharacterCollaborationReporterInput & {
      requestedAt: string;
      settledAt?: string;
      conversationProgress: {
        userMessagesAfterRequest: number;
        hasAdvanced: boolean;
        latestUserText?: string;
        elapsedMs: number;
      };
    };
    assert.ok(reporterProgress.requestedAt);
    assert.ok(reporterProgress.settledAt);
    assert.equal(reporterProgress.conversationProgress.userMessagesAfterRequest, 0);
    assert.equal(reporterProgress.conversationProgress.hasAdvanced, false);
    assert.match(reporterProgress.conversationProgress.latestUserText ?? "", /整理实验记录/);
    assert.equal(reporterProgress.conversationProgress.elapsedMs >= 0, true);
    assert.equal(runtime.model.requests.length, 2);
    const projected = runtime.kernel.listSessionCharacterCollaborations(
      "source-collaboration-session",
    ).find((entry) => entry.episodeId === snapshot.episodes[0].id);
    assert.equal(projected?.status, "completed");
    assert.equal(projected?.reportStatus, "delivered");
    assert.ok(projected?.reportedAt);

    const session = await runtime.kernel.getSession("source-collaboration-session");
    assert.deepEqual(visibleAssistantTexts(session.messages), [
      "我已经请真由理帮忙核对了，她完成后我再来告诉你。",
      "真由理核对完了：先按时间排序，再检查缺失项。",
    ]);
    const markers = collaborationReportMarkers(session.messages);
    assert.equal(markers.length, 1);
    assert.equal(markers[0].display, false);
    assert.match(JSON.stringify(markers[0]), new RegExp(snapshot.episodes[0].id));

    const metricsBeforeSecondDrain = collaborationMetricSnapshot(snapshot.episodes[0]);
    await runtime.kernel.characterInteractionCoordinator.drain();
    const afterSecondDrain = await runtime.kernel.getSession("source-collaboration-session");
    assert.equal(collaborationReportMarkers(afterSecondDrain.messages).length, 1);
    assert.equal(visibleAssistantTexts(afterSecondDrain.messages).length, 2);
    assert.deepEqual(
      collaborationMetricSnapshot(
        runtime.kernel.characterChannels.repository.getEpisode(snapshot.episodes[0].id)!,
      ),
      metricsBeforeSecondDrain,
      "draining an already settled collaboration must not increment phase metrics",
    );
  } finally {
    actorResult.resolve("清理未完成的 actor");
    runtime.dispose();
  }
});

test("default collaboration reports reconnect an older request only after the conversation advances", async (t) => {
  await t.test("new topic", async () => {
    const captured = await captureDefaultCollaborationReport({
      seed: "collaboration-report-new-topic",
      sessionId: "collaboration-report-new-topic",
      initialUserText: "帮我请目标角色核对一下实验清单。",
      initialAssistantText: "好，我去请她核对。",
      task: "核对实验清单是否缺少安全检查项",
      resultText: "实验清单缺少最后一项断电确认。",
      laterUserText: "对了，晚饭我们吃寿司怎么样？",
      laterAssistantText: "可以，我正好也想吃寿司。",
      reportText: "对了，刚才那件事有结果了：清单还缺最后一项断电确认。",
    });

    assert.match(captured.providerBody, /帮我请目标角色核对一下实验清单/);
    assert.match(captured.providerBody, /核对实验清单是否缺少安全检查项/);
    assert.match(captured.providerBody, /晚饭我们吃寿司怎么样/);
    assert.match(captured.providerBody, /hasAdvanced[^A-Za-z0-9]{1,20}true/);
    assert.match(captured.providerBody, /userMessagesAfterRequest[^A-Za-z0-9]{1,20}1/);
    assert.match(
      captured.providerBody,
      /(?:naturally|自然).{0,120}(?:reconnect|重接|return)|(?:reconnect|重接).{0,120}(?:earlier|previous|原委托)/i,
    );
    assert.equal(captured.visibleAssistantTexts.at(-1),
      "对了，刚才那件事有结果了：清单还缺最后一项断电确认。");
    assertCollaborationMetrics(captured.episode, {
      targetModelCalls: 0,
      reportModelCalls: 1,
    });
  });

  await t.test("no newer topic", async () => {
    const captured = await captureDefaultCollaborationReport({
      seed: "collaboration-report-current-topic",
      sessionId: "collaboration-report-current-topic",
      initialUserText: "帮我请目标角色核对一下旅行清单。",
      initialAssistantText: "好，我现在去问她。",
      task: "核对旅行清单是否遗漏证件",
      resultText: "旅行清单完整，证件都列上了。",
      reportText: "目标角色核对好了，旅行清单里的证件都齐全。",
    });

    assert.match(captured.providerBody, /帮我请目标角色核对一下旅行清单/);
    assert.match(captured.providerBody, /核对旅行清单是否遗漏证件/);
    assert.match(captured.providerBody, /hasAdvanced[^A-Za-z0-9]{1,20}false/);
    assert.match(captured.providerBody, /userMessagesAfterRequest[^A-Za-z0-9]{1,20}0/);
    assert.match(
      captured.providerBody,
      /(?:do not|不得|不要).{0,160}(?:mechanical|机械|delayed|迟到|transition|转场)/i,
    );
    assert.doesNotMatch(captured.visibleAssistantTexts.at(-1) ?? "", /刚才那件事|说回|回到之前|迟点来报/);
    assert.equal(captured.visibleAssistantTexts.at(-1),
      "目标角色核对好了，旅行清单里的证件都齐全。");
    assertCollaborationMetrics(captured.episode, {
      targetModelCalls: 0,
      reportModelCalls: 1,
    });
  });
});

test("background collaboration reports declined and failed outcomes without fabricating a target result", async (t) => {
  const scenarios = [
    {
      name: "declined",
      expectedStatus: "declined" as const,
      reason: "今天状态不好，暂时接不了。",
      reportText: "她今天状态不好，所以这次没有接下任务。",
    },
    {
      name: "failed",
      expectedStatus: "failed" as const,
      reason: "目标角色模型暂时不可用",
      reportText: "刚才的协作没有完成，目标角色模型暂时不可用。",
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const reporterInputs: CharacterCollaborationReporterInput[] = [];
      const runtime = createTestRuntime({
        seed: `character-collaboration-${scenario.name}`,
        characterInteractionActor: async () => {
          if (scenario.expectedStatus === "failed") throw new Error(scenario.reason);
          return `[DECLINE]: ${scenario.reason}`;
        },
        characterCollaborationReporter: async (input) => {
          reporterInputs.push(input);
          return scenario.reportText;
        },
      });
      try {
        const setup = setupSharedWorld(runtime);
        const sessionId = `source-collaboration-${scenario.name}`;
        runtime.model.enqueue([{
          kind: "assistant_text",
          text: "我在，怎么了？",
        }]);
        await runtime.kernel.sendMessage(sessionId, {
          mode: "sms",
          characterId: setup.source.id,
          text: "先确认一下这条会话。",
        });

        const queued = await runtime.kernel.characterInteractionCoordinator.queueCharacterHelp({
          sourceCharacterId: setup.source.id,
          targetCharacterId: setup.target.id,
          task: `验证协作${scenario.name}终态`,
          parentSessionId: sessionId,
          idempotencyKey: `terminal-collaboration-${scenario.name}`,
        });
        assert.equal(["queued", "running"].includes(queued.episode.status), true);
        await runtime.kernel.characterInteractionCoordinator.drain();

        const snapshot = runtime.kernel.getCharacterChannel(queued.channel.id);
        const episode = snapshot.episodes.find((entry) => entry.id === queued.episode.id);
        assert.ok(episode);
        assert.equal(episode.status, scenario.expectedStatus);
        assert.equal(episode.reportStatus, "delivered");
        assert.equal(episode.reportAttempts, 1);
        if (scenario.expectedStatus === "declined") {
          assert.equal(episode.resultText, scenario.reason);
        } else {
          assert.equal(episode.failureReason, scenario.reason);
        }
        assertCollaborationMetrics(episode, {
          targetModelCalls: 0,
          reportModelCalls: 0,
        });
        assert.equal(
          snapshot.messages.some((message) =>
            message.episodeId === episode.id && message.kind === "result"
          ),
          false,
          "a declined or failed task must not gain a fabricated target result message",
        );
        assert.equal(reporterInputs.length, 1);
        assert.equal(reporterInputs[0].status, scenario.expectedStatus);
        assert.equal(reporterInputs[0].sourceCharacterId, setup.source.id);
        assert.equal(reporterInputs[0].targetCharacterId, setup.target.id);
        if (scenario.expectedStatus === "declined") {
          assert.equal(reporterInputs[0].resultText, scenario.reason);
        } else {
          assert.equal(reporterInputs[0].failureReason, scenario.reason);
        }

        const session = await runtime.kernel.getSession(sessionId);
        assert.equal(visibleAssistantTexts(session.messages).at(-1), scenario.reportText);
        const markers = collaborationReportMarkers(session.messages);
        assert.equal(markers.length, 1);
        assert.equal(markers[0].display, false);
        assert.match(JSON.stringify(markers[0]), new RegExp(episode.id));

        const metricsBeforeSecondDrain = collaborationMetricSnapshot(episode);
        await runtime.kernel.characterInteractionCoordinator.drain();
        const afterSecondDrain = await runtime.kernel.getSession(sessionId);
        assert.equal(collaborationReportMarkers(afterSecondDrain.messages).length, 1);
        assert.equal(visibleAssistantTexts(afterSecondDrain.messages).length, 2);
        assert.deepEqual(
          collaborationMetricSnapshot(
            runtime.kernel.characterChannels.repository.getEpisode(episode.id)!,
          ),
          metricsBeforeSecondDrain,
        );
      } finally {
        runtime.dispose();
      }
    });
  }
});

test("archiving a parent conversation while its report is being composed skips late delivery", async () => {
  const reporterStarted = createDeferred<void>();
  const reporterResult = createDeferred<string>();
  const runtime = createTestRuntime({
    seed: "character-collaboration-archive-race",
    characterInteractionActor: async () => "已经核对完成：没有遗漏。",
    characterCollaborationReporter: async () => {
      reporterStarted.resolve();
      return reporterResult.promise;
    },
  });
  const sessionId = "collaboration-archive-race-parent";
  try {
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "我先保留这条会话。",
    }]);
    await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: "先建立会话。",
    });
    const queued = await runtime.kernel.characterInteractionCoordinator.queueCharacterHelp({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "核对归档竞态",
      parentSessionId: sessionId,
      idempotencyKey: "character-collaboration-archive-race",
    });
    const draining = runtime.kernel.characterInteractionCoordinator.drain();
    await withTimeout(reporterStarted.promise, 1_000);
    runtime.kernel.archiveConversation(sessionId);
    reporterResult.resolve("这条结果不应写进已经归档的会话。");
    await withTimeout(draining, 1_000);

    const episode = runtime.kernel.characterChannels.repository.getEpisode(queued.episode.id);
    assert.equal(episode?.status, "completed");
    assert.equal(episode?.reportStatus, "skipped");
    assert.equal(episode?.reportAttempts, 1);
    const session = await runtime.kernel.getSession(sessionId);
    assert.deepEqual(visibleAssistantTexts(session.messages), ["我先保留这条会话。"]);
    assert.equal(collaborationReportMarkers(session.messages).length, 0);
    assert.ok(runtime.kernel.listConversationMetadata().find((entry) =>
      entry.id === sessionId && entry.archivedAt
    ));
  } finally {
    reporterResult.resolve("清理未完成的 reporter");
    runtime.dispose();
  }
});

test("collaboration delivery failures retain report phase metrics without leaking diagnostics", async () => {
  const reporterStarted = createDeferred<void>();
  const reporterResult = createDeferred<string>();
  const deliveryError = "delivery-metrics-secret-stack-token";
  const runtime = createTestRuntime({
    seed: "character-collaboration-delivery-metrics",
    characterInteractionActor: async () => "已经核对完成：内容没有遗漏。",
    characterCollaborationReporter: async () => {
      reporterStarted.resolve();
      return reporterResult.promise;
    },
  });
  const sessionId = "collaboration-delivery-metrics-parent";
  const originalGetOrCreate = runtime.kernel.sessionRuntime.getOrCreate.bind(
    runtime.kernel.sessionRuntime,
  );
  let deliveryFailureInstalled = false;
  try {
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "我先记住这件事。",
    }]);
    await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: "先建立会话。",
    });
    const queued = await runtime.kernel.characterInteractionCoordinator.queueCharacterHelp({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "验证回报投递失败仍保留阶段指标",
      parentSessionId: sessionId,
      idempotencyKey: "character-collaboration-delivery-metrics",
    });
    const draining = runtime.kernel.characterInteractionCoordinator.drain();
    await withTimeout(reporterStarted.promise, 1_000);
    runtime.kernel.sessionRuntime.getOrCreate = async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      throw new Error(deliveryError);
    };
    deliveryFailureInstalled = true;
    await new Promise((resolve) => setTimeout(resolve, 15));
    reporterResult.resolve("核对结果是：内容没有遗漏。");
    await withTimeout(draining, 1_000);
    runtime.kernel.sessionRuntime.getOrCreate = originalGetOrCreate;
    deliveryFailureInstalled = false;

    const episode = runtime.kernel.characterChannels.repository.getEpisode(queued.episode.id);
    assert.ok(episode);
    assert.equal(episode.status, "completed");
    assert.equal(episode.reportStatus, "failed");
    assert.match(episode.reportError ?? "", new RegExp(deliveryError));
    assertCollaborationMetrics(episode, {
      targetModelCalls: 0,
      reportModelCalls: 0,
    });
    assert.equal((episode.reportGenerationMs ?? 0) > 0, true);
    assert.equal((episode.reportDeliveryMs ?? 0) > 0, true);

    const projection = runtime.kernel.listSessionCharacterCollaborations(sessionId)
      .find((entry) => entry.episodeId === episode.id);
    assert.ok(projection);
    assert.equal(projection.reportStatus, "failed");
    assert.equal(projection.stage, "settled");
    const projectedRecord = projection as unknown as Record<string, unknown>;
    for (const privateField of [
      "reportError",
      "reportWaitMs",
      "reportGenerationMs",
      "reportDeliveryMs",
      "reportModelCalls",
    ]) {
      assert.equal(privateField in projectedRecord, false);
    }
    const session = await runtime.kernel.getSession(sessionId);
    assert.deepEqual(visibleAssistantTexts(session.messages), ["我先记住这件事。"]);
    assert.equal(collaborationReportMarkers(session.messages).length, 0);
  } finally {
    reporterResult.resolve("清理未完成的 reporter");
    if (deliveryFailureInstalled) {
      runtime.kernel.sessionRuntime.getOrCreate = originalGetOrCreate;
    }
    runtime.dispose();
  }
});

test("running collaboration resumes after restart and neither execution nor reporting is duplicated", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-character-collaboration-restart-"));
  const actorStarted = createDeferred<void>();
  let releaseFirstActor: ((value: string) => void) | undefined;
  let firstActorAborted = false;
  let firstActorCalls = 0;
  let recoveredActorCalls = 0;
  let duplicateActorCalls = 0;
  let recoveredReporterCalls = 0;
  let duplicateReporterCalls = 0;
  let first: TestRuntime | undefined;
  let second: TestRuntime | undefined;
  let third: TestRuntime | undefined;
  try {
    first = createTestRuntime({
      stateDir,
      seed: "character-collaboration-restart-first",
      characterInteractionActor: async (input) => {
        firstActorCalls += 1;
        actorStarted.resolve();
        return new Promise<string>((resolve, reject) => {
          releaseFirstActor = resolve;
          const abort = () => {
            firstActorAborted = true;
            reject(new Error("first collaboration worker aborted"));
          };
          if (input.signal?.aborted) abort();
          else input.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const setup = setupSharedWorld(first);
    const sessionId = "collaboration-restart-parent";
    first.model.enqueue([{
      kind: "assistant_text",
      text: "这条会话会保留下来。",
    }]);
    await first.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: "建立可恢复的会话。",
    });
    const queued = await first.kernel.characterInteractionCoordinator.queueCharacterHelp({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "重启后继续核对共享实验记录",
      parentSessionId: sessionId,
      idempotencyKey: "restartable-character-collaboration",
    });
    const firstDrain = first.kernel.characterInteractionCoordinator.drain();
    await withTimeout(actorStarted.promise, 1_000);
    assert.equal(firstActorCalls, 1);
    const firstRunningEpisode = first.kernel.characterChannels.repository.getEpisode(
      queued.episode.id,
    );
    assert.equal(firstRunningEpisode?.status, "running");
    assert.equal(firstRunningEpisode?.modelCalls, 0);
    assert.ok(firstRunningEpisode?.queuedAt);
    assert.ok(firstRunningEpisode?.startedAt);
    assert.equal(firstRunningEpisode?.settledAt, undefined);
    const executingProjection = first.kernel.listSessionCharacterCollaborations(sessionId)
      .find((entry) => entry.episodeId === queued.episode.id);
    assert.equal(executingProjection?.stage, "executing");
    assert.equal((executingProjection?.elapsedMs ?? -1) >= 0, true);
    assert.equal(
      first.kernel.characterChannels.repository.getCollaborationJob(queued.episode.id)?.attempts,
      1,
    );

    first.dispose();
    first = undefined;
    await withTimeout(firstDrain, 1_000);
    assert.equal(firstActorAborted, true);

    second = createTestRuntime({
      stateDir,
      seed: "character-collaboration-restart-second",
      characterInteractionActor: async () => {
        recoveredActorCalls += 1;
        return "重启后实际完成：记录顺序正确，没有缺项。";
      },
      characterCollaborationReporter: async (input) => {
        recoveredReporterCalls += 1;
        assert.equal(input.episodeId, queued.episode.id);
        assert.equal(input.status, "completed");
        assert.equal(input.resultText, "重启后实际完成：记录顺序正确，没有缺项。");
        return "我回来汇报：记录顺序正确，也没有缺项。";
      },
    });
    await second.kernel.characterInteractionCoordinator.drain();

    const recoveredEpisode = second.kernel.characterChannels.repository.getEpisode(
      queued.episode.id,
    );
    const recoveredJob = second.kernel.characterChannels.repository.getCollaborationJob(
      queued.episode.id,
    );
    assert.equal(recoveredActorCalls, 1);
    assert.equal(recoveredReporterCalls, 1);
    assert.equal(recoveredEpisode?.status, "completed");
    assert.equal(recoveredEpisode?.reportStatus, "delivered");
    assert.equal(recoveredEpisode?.reportAttempts, 1);
    assert.equal(recoveredJob?.status, "completed");
    assert.equal(recoveredJob?.attempts, 2);
    assert.equal(recoveredEpisode?.resultText, "重启后实际完成：记录顺序正确，没有缺项。");
    assert.ok(recoveredEpisode);
    assertCollaborationMetrics(recoveredEpisode, {
      targetModelCalls: 0,
      reportModelCalls: 0,
    });
    assert.equal(recoveredEpisode.queuedAt, firstRunningEpisode?.queuedAt);
    assert.equal(recoveredEpisode.startedAt, firstRunningEpisode?.startedAt);
    assert.equal(
      (recoveredEpisode.targetExecutionMs ?? 0) >= (firstRunningEpisode?.targetExecutionMs ?? 0),
      true,
    );
    const recoveredMetrics = collaborationMetricSnapshot(recoveredEpisode);
    const settledProjection = second.kernel.listSessionCharacterCollaborations(sessionId)
      .find((entry) => entry.episodeId === queued.episode.id);
    assert.equal(settledProjection?.stage, "settled");
    assert.equal(
      (settledProjection?.elapsedMs ?? -1) >= (executingProjection?.elapsedMs ?? 0),
      true,
    );

    const afterRecovery = await second.kernel.getSession(sessionId);
    assert.deepEqual(visibleAssistantTexts(afterRecovery.messages), [
      "这条会话会保留下来。",
      "我回来汇报：记录顺序正确，也没有缺项。",
    ]);
    assert.equal(collaborationReportMarkers(afterRecovery.messages).length, 1);
    second.dispose();
    second = undefined;

    third = createTestRuntime({
      stateDir,
      seed: "character-collaboration-restart-third",
      characterInteractionActor: async () => {
        duplicateActorCalls += 1;
        return "不应该再次执行";
      },
      characterCollaborationReporter: async () => {
        duplicateReporterCalls += 1;
        return "不应该再次汇报";
      },
    });
    await third.kernel.characterInteractionCoordinator.drain();
    const afterSecondRestart = await third.kernel.getSession(sessionId);
    assert.equal(duplicateActorCalls, 0);
    assert.equal(duplicateReporterCalls, 0);
    assert.deepEqual(
      visibleAssistantTexts(afterSecondRestart.messages),
      visibleAssistantTexts(afterRecovery.messages),
    );
    assert.equal(collaborationReportMarkers(afterSecondRestart.messages).length, 1);
    const persistedReport = afterSecondRestart.messages.find((message) =>
      isRecord(message) &&
      message.role === "assistant" &&
      message.collaborationEpisodeId === queued.episode.id
    );
    assert.ok(
      persistedReport,
      "the visible report keeps a durable episode stamp for crash-window deduplication",
    );
    assert.equal(
      third.kernel.characterChannels.repository.getCollaborationJob(queued.episode.id)?.attempts,
      2,
    );
    assert.deepEqual(
      collaborationMetricSnapshot(
        third.kernel.characterChannels.repository.getEpisode(queued.episode.id)!,
      ),
      recoveredMetrics,
      "a later restart must not replay or increment already settled collaboration phases",
    );
  } finally {
    releaseFirstActor?.("清理旧 worker");
    first?.dispose();
    second?.dispose();
    third?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("autonomous social exchanges honor policy, cooldown, and daily limits", async () => {
  const actorInputs: CharacterInteractionActorInput[] = [];
  const runtime = createTestRuntime({
    now: "2026-07-24T02:00:00.000Z",
    seed: "character-social-policy",
    worldPlanner: async () => ({ activities: [] }),
    characterInteractionActor: async (input) => {
      actorInputs.push(input);
      return input.purpose === "social_opening"
        ? "今天实验室挺安静的，你那边怎么样？"
        : "我也刚忙完，正准备泡杯茶。";
    },
  });
  try {
    const setup = setupSharedWorld(runtime);
    for (const character of [setup.source, setup.target]) {
      runtime.kernel.updateCharacterAutonomyPolicy(character.id, {
        enabled: true,
        socialEnabled: true,
        socialDailyLimit: 1,
        socialCooldownMinutes: 240,
        quietStart: "23:00",
        quietEnd: "08:00",
      });
    }

    const first = await runtime.worldTick(setup.source.id);
    assert.equal(first.socialEpisodes, 1);
    assert.equal(actorInputs.length, 2);
    assert.deepEqual(actorInputs.map((input) => [input.purpose, input.actorCharacterId]), [
      ["social_opening", setup.source.id],
      ["social_reply", setup.target.id],
    ]);
    const channel = runtime.kernel.listCharacterChannels({ worldId: setup.world.id })[0];
    assert.equal(runtime.kernel.getCharacterChannel(channel.id).episodes[0].source, "autonomy");
    assert.ok(runtime.kernel.getCharacterLife(setup.source.id).policy.lastSocialAt);
    assert.ok(runtime.kernel.getCharacterLife(setup.target.id).policy.lastSocialAt);

    const second = await runtime.worldTick(setup.source.id);
    assert.equal(second.socialEpisodes, 0);
    assert.equal(actorInputs.length, 2);
  } finally {
    runtime.dispose();
  }
});

test("each character-channel actor uses its own model without receiving private user-thread text", async () => {
  const requests: Array<{ model: string; body: string }> = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const model = (JSON.parse(body) as { model?: string }).model ?? "unknown";
    requests.push({ model, body });
    const composesScene = body.includes("neutral literary narrator");
    writeChatCompletionStream(
      response,
      model,
      composesScene
        ? JSON.stringify({
            narrativeText: "工作室的灯光下，两人把话说完，各自留下了不同的印象。",
            eventSummary: "两名角色完成了一次私下互动。",
            sourcePerspectiveSummary: "我主动开了口，并留意了对方的反应。",
            targetPerspectiveSummary: "对方来找我，我按自己的想法作出了回应。",
          })
        : model === "source-model"
          ? "我先问问她今天过得怎么样。"
          : "我挺好的，你呢？",
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const runtime = createTestRuntime({
    seed: "character-channel-model-binding",
    characterInteractionSceneComposer: false,
    characterCollaborationReporter: async () => "目标角色已经给出协作结果。",
  });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    runtime.kernel.patchModelApiConfig({ enabled: true, baseUrl, model: "source-model" });
    const targetProfile = runtime.kernel.createModelApiProfile({
      name: "目标模型",
      enabled: true,
      baseUrl,
      model: "target-model",
    });
    const setup = setupSharedWorld(runtime, targetProfile.id);

    runtime.model.enqueue([{ kind: "assistant_text", text: "这件事我只在这里说。" }]);
    await runtime.kernel.sendMessage("source-private-secret", {
      mode: "sms",
      characterId: setup.source.id,
      text: "私人暗号是只属于用户会话的内容。",
    });
    await runtime.kernel.sendCharacterChannelMessage({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      message: "今天过得怎么样？",
      idempotencyKey: "model-binding-direct",
      source: "manual",
    });
    await runtime.kernel.startCharacterSocialExchange({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      idempotencyKey: "model-binding-social",
    });
    const collaboration = await runtime.kernel.characterInteractionCoordinator.queueCharacterHelp({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "核对公开实验清单",
      parentSessionId: "source-private-secret",
      idempotencyKey: "model-binding-collaboration",
    });
    await runtime.kernel.characterInteractionCoordinator.drain();

    const actorRequests = requests.filter((entry) => !entry.body.includes("neutral literary narrator"));
    const sceneRequests = requests.filter((entry) => entry.body.includes("neutral literary narrator"));
    assert.deepEqual(actorRequests.map((entry) => entry.model), [
      "target-model",
      "source-model",
      "target-model",
      "target-model",
    ]);
    assert.equal(sceneRequests.length, 3);
    assert.deepEqual(sceneRequests.map((entry) => entry.model), [
      "source-model",
      "source-model",
      "source-model",
    ]);
    const collaborationEpisode = runtime.kernel.characterChannels.repository.getEpisode(
      collaboration.episode.id,
    );
    assert.equal(collaborationEpisode?.status, "completed");
    assert.equal(collaborationEpisode?.modelCalls, 1);
    assert.equal(collaborationEpisode?.reportModelCalls, 0);
    assert.match(actorRequests[0].body, /待人温和/);
    assert.match(actorRequests[1].body, /做事严谨/);
    assert.match(actorRequests[2].body, /actor_private_reflections/u);
    assert.match(actorRequests[3].body, /核对公开实验清单/);
    assert.equal(
      runtime.kernel.characterChannels.repository.getInteractionScene(collaboration.episode.id)
        ?.narrativeText,
      "工作室的灯光下，两人把话说完，各自留下了不同的印象。",
    );
    for (const request of requests) {
      assert.doesNotMatch(request.body, /私人暗号/);
      assert.doesNotMatch(request.body, /这件事我只在这里说/);
    }
  } finally {
    runtime.dispose();
    await new Promise<void>((resolve, reject) => modelServer.close((error) => error ? reject(error) : resolve()));
  }
});

test("character-channel HTTP APIs expose exchanges, snapshots, read state, and social policy", async () => {
  const runtime = createTestRuntime({
    seed: "character-channel-http",
    characterInteractionActor: async () => "我收到啦。",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const setup = setupSharedWorld(runtime);
    const exchangeResponse = await fetch(`${baseUrl}/api/v1/character-channels/exchanges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "message",
        sourceCharacterId: setup.source.id,
        targetCharacterId: setup.target.id,
        message: "有空聊聊吗？",
        clientRequestId: "http-message-once",
      }),
    });
    assert.equal(exchangeResponse.status, 200);
    const exchange = await exchangeResponse.json() as {
      channel: { id: string };
      episode: { id: string; status: string };
    };
    assert.equal(exchange.episode.status, "completed");

    const listResponse = await fetch(
      `${baseUrl}/api/v1/character-channels?worldId=${encodeURIComponent(setup.world.id)}`,
    );
    assert.equal(listResponse.status, 200);
    const listed = await listResponse.json() as { channels: Array<{ id: string; unreadCount: number }> };
    assert.equal(listed.channels[0].id, exchange.channel.id);
    assert.equal(listed.channels[0].unreadCount, 1);

    const snapshotResponse = await fetch(
      `${baseUrl}/api/v1/character-channels/${encodeURIComponent(exchange.channel.id)}`,
    );
    assert.equal(snapshotResponse.status, 200);
    const snapshot = await snapshotResponse.json() as {
      snapshot: { messages: unknown[]; scenes: unknown[]; reflections: unknown[] };
    };
    assert.equal(snapshot.snapshot.messages.length, 2);
    assert.equal(snapshot.snapshot.scenes.length, 1);
    assert.equal(snapshot.snapshot.reflections.length, 2);
    const readResponse = await fetch(
      `${baseUrl}/api/v1/character-channels/${encodeURIComponent(exchange.channel.id)}/read`,
      { method: "POST" },
    );
    assert.equal(readResponse.status, 200);
    assert.equal((await readResponse.json() as { channel: { unreadCount: number } }).channel.unreadCount, 0);

    runtime.clock.advance(1_000);
    const laterExchange = await runtime.kernel.sendCharacterChannelMessage({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      message: "这是一段更晚的往来。",
      idempotencyKey: "http-message-later",
      source: "manual",
    });
    const focusedSnapshotResponse = await fetch(
      `${baseUrl}/api/v1/character-channels/${encodeURIComponent(exchange.channel.id)}` +
        `?messageLimit=1&episodeLimit=1&focusEpisodeId=${encodeURIComponent(exchange.episode.id)}`,
    );
    assert.equal(focusedSnapshotResponse.status, 200);
    const focusedSnapshot = (await focusedSnapshotResponse.json() as {
      snapshot: {
        episodes: Array<{ id: string }>;
        messages: Array<{ episodeId: string; content: string }>;
      };
    }).snapshot;
    assert.deepEqual(
      new Set(focusedSnapshot.episodes.map((episode) => episode.id)),
      new Set([exchange.episode.id, laterExchange.episode.id]),
    );
    assert.equal(
      focusedSnapshot.messages.filter((message) => message.episodeId === exchange.episode.id).length,
      2,
    );
    assert.equal(
      focusedSnapshot.messages.some((message) => message.content === "这是一段更晚的往来。"),
      false,
    );
    assert.equal(
      focusedSnapshot.messages.some((message) => message.content === "我收到啦。"),
      true,
    );

    const policyResponse = await fetch(
      `${baseUrl}/api/v1/characters/${encodeURIComponent(setup.source.id)}/life`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          policy: {
            socialEnabled: false,
            socialDailyLimit: 3,
            socialCooldownMinutes: 360,
          },
        }),
      },
    );
    assert.equal(policyResponse.status, 200);
    const policy = (await policyResponse.json() as {
      life: { policy: { socialEnabled: boolean; socialDailyLimit: number; socialCooldownMinutes: number } };
    }).life.policy;
    assert.equal(policy.socialEnabled, false);
    assert.equal(policy.socialDailyLimit, 3);
    assert.equal(policy.socialCooldownMinutes, 360);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

test("session collaboration HTTP projection is scoped to the bound character and omits execution details", async () => {
  const runtime = createTestRuntime({
    seed: "session-character-collaboration-http",
    characterInteractionActor: async () => "内部协作结果：先核对时间，再检查遗漏。",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sessionId = "character-collaboration-projection";
    const setup = setupSharedWorld(runtime);

    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "我会请同伴一起核对。",
    }]);
    const boundSession = await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: "请找同伴核对共享记录。",
    });
    assert.equal(boundSession.status, "completed");

    const expected = await runtime.kernel.requestCharacterCollaboration({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "核对共享记录的时间顺序",
      context: "只核对共同工作室里的共享内容。",
      idempotencyKey: "session-collaboration-visible",
      parentSessionId: sessionId,
    });
    assert.equal(expected.episode.status, "completed");
    assert.match(expected.episode.resultText ?? "", /内部协作结果/);

    await runtime.kernel.requestCharacterCollaboration({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "属于另一个用户会话的协作",
      idempotencyKey: "session-collaboration-other-session",
      parentSessionId: "another-session",
    });
    await runtime.kernel.sendCharacterChannelMessage({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      message: "这只是角色间联系，不是协作投影。",
      idempotencyKey: "session-collaboration-contact",
      parentSessionId: sessionId,
    });

    const forgedInitiator = runtime.kernel.createCharacter({
      name: "伪造发起角色",
      soulMarkdown: "# SOUL.md\n\n不属于当前绑定会话的发起角色。",
    });
    runtime.kernel.assignCharacterWorld(forgedInitiator.id, {
      worldId: setup.world.id,
      homePlaceId: setup.place.id,
      currentPlaceId: setup.place.id,
    });
    await runtime.kernel.requestCharacterCollaboration({
      sourceCharacterId: forgedInitiator.id,
      targetCharacterId: setup.target.id,
      task: "伪造相同 parentSessionId 的协作",
      idempotencyKey: "session-collaboration-forged-initiator",
      parentSessionId: sessionId,
    });

    const response = await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/character-collaborations`,
    );
    assert.equal(response.status, 200);
    const body = await response.json() as {
      collaborations: Array<Record<string, unknown>>;
    };
    assert.equal(body.collaborations.length, 1);
    const projection = body.collaborations[0];
    assert.deepEqual({
      episodeId: projection.episodeId,
      channelId: projection.channelId,
      worldId: projection.worldId,
      initiatorCharacterId: projection.initiatorCharacterId,
      initiatorCharacterName: projection.initiatorCharacterName,
      targetCharacterId: projection.targetCharacterId,
      targetCharacterName: projection.targetCharacterName,
      title: projection.title,
      objective: projection.objective,
      status: projection.status,
    }, {
      episodeId: expected.episode.id,
      channelId: expected.channel.id,
      worldId: setup.world.id,
      initiatorCharacterId: setup.source.id,
      initiatorCharacterName: setup.source.name,
      targetCharacterId: setup.target.id,
      targetCharacterName: setup.target.name,
      title: `${setup.source.name}委托${setup.target.name}`,
      objective: "核对共享记录的时间顺序\n补充背景：只核对共同工作室里的共享内容。",
      status: "completed",
    });
    assert.equal(projection.stage, "settled");
    assert.equal(typeof projection.elapsedMs, "number");
    assert.equal(Number(projection.elapsedMs) >= 0, true);
    assert.ok(projection.queuedAt);
    assert.ok(projection.startedAt);
    assert.ok(projection.settledAt);
    for (const privateField of [
      "resultText",
      "failureReason",
      "idempotencyKey",
      "parentSessionId",
      "modelCalls",
      "reportAttempts",
      "reportError",
      "targetExecutionMs",
      "reportQueuedAt",
      "reportStartedAt",
      "reportWaitMs",
      "reportGenerationMs",
      "reportDeliveryMs",
      "reportModelCalls",
      "responseText",
      "messages",
    ]) {
      assert.equal(
        Object.hasOwn(projection, privateField),
        false,
        `collaboration projection must omit ${privateField}`,
      );
    }
    const serialized = JSON.stringify(projection);
    assert.doesNotMatch(serialized, /内部协作结果/);
    assert.doesNotMatch(serialized, /session-collaboration-visible/);
    assert.doesNotMatch(serialized, /属于另一个用户会话/);
    assert.doesNotMatch(serialized, /这只是角色间联系/);
    assert.doesNotMatch(serialized, /伪造相同 parentSessionId/);

    const sharedLongPrefix = `long-session-${"x".repeat(260)}`;
    const longSessionA = `${sharedLongPrefix}-a`;
    const longSessionB = `${sharedLongPrefix}-b`;
    for (const longSessionId of [longSessionA, longSessionB]) {
      runtime.model.enqueue([{
        kind: "assistant_text",
        text: "长会话 ID 已绑定。",
      }]);
      await runtime.kernel.sendMessage(longSessionId, {
        mode: "sms",
        characterId: setup.source.id,
        text: `绑定 ${longSessionId.endsWith("-a") ? "A" : "B"} 会话。`,
      });
    }
    const longSessionCollaboration = await runtime.kernel.requestCharacterCollaboration({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "只属于长 ID 会话 A 的协作",
      idempotencyKey: "session-collaboration-long-id",
      parentSessionId: longSessionA,
    });
    const longSessionAResponse = await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(longSessionA)}/character-collaborations`,
    );
    const longSessionBResponse = await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(longSessionB)}/character-collaborations`,
    );
    assert.equal(longSessionAResponse.status, 200);
    assert.equal(longSessionBResponse.status, 200);
    assert.deepEqual(
      (await longSessionAResponse.json() as {
        collaborations: Array<{ episodeId: string }>;
      }).collaborations.map((entry) => entry.episodeId),
      [longSessionCollaboration.episode.id],
    );
    assert.deepEqual(
      (await longSessionBResponse.json() as { collaborations: unknown[] }).collaborations,
      [],
    );

    const sessionTitle = runtime.kernel.listConversationMetadata()
      .find((entry) => entry.id === sessionId)?.title;
    assert.ok(sessionTitle);
    const deleted = await runtime.kernel.deleteConversation(sessionId, sessionTitle);
    assert.ok(deleted.cleanup.characterCollaborationLinks >= 1);
    assert.equal(
      runtime.kernel.getCharacterChannel(expected.channel.id).episodes
        .find((episode) => episode.id === expected.episode.id)?.parentSessionId,
      undefined,
    );
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "这是复用 ID 后的新会话。",
    }]);
    await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: "重新创建同名会话。",
    });
    const reusedSession = await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/character-collaborations`,
    );
    assert.equal(reusedSession.status, 200);
    assert.deepEqual(
      (await reusedSession.json() as { collaborations: unknown[] }).collaborations,
      [],
    );

    const missing = await fetch(
      `${baseUrl}/api/v1/sessions/unknown-character-collaboration/character-collaborations`,
    );
    assert.equal(missing.status, 404);
    assert.equal(
      (await missing.json() as { code?: string }).code,
      "SESSION_NOT_FOUND",
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

test("failed collaboration session projection exposes only coarse progress and hides diagnostics", async () => {
  const internalFailure = "projection-secret-stack-token: upstream model socket 10.0.0.8 failed";
  const runtime = createTestRuntime({
    seed: "failed-character-collaboration-projection",
    characterInteractionActor: async () => {
      throw new Error(internalFailure);
    },
    characterCollaborationReporter: async () => "这次没能顺利拿到结果，我没有可转达的答案。",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sessionId = "failed-character-collaboration-projection";
    const setup = setupSharedWorld(runtime);
    runtime.model.enqueue([{ kind: "assistant_text", text: "我在这里。" }]);
    await runtime.kernel.sendMessage(sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: "先建立这条私聊。",
    });
    const queued = await runtime.kernel.characterInteractionCoordinator.queueCharacterHelp({
      sourceCharacterId: setup.source.id,
      targetCharacterId: setup.target.id,
      task: "验证失败协作的普通会话投影",
      parentSessionId: sessionId,
      idempotencyKey: "failed-collaboration-projection",
    });
    await runtime.kernel.characterInteractionCoordinator.drain();
    assert.match(
      runtime.kernel.characterChannels.repository.getEpisode(queued.episode.id)?.failureReason ?? "",
      /projection-secret-stack-token/,
      "the management snapshot must actually contain a diagnostic for this privacy assertion",
    );

    const response = await fetch(
      `${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/character-collaborations`,
    );
    assert.equal(response.status, 200);
    const collaborations = (await response.json() as {
      collaborations: Array<Record<string, unknown>>;
    }).collaborations;
    assert.equal(collaborations.length, 1);
    const projection = collaborations[0];
    assert.equal(projection.status, "failed");
    assert.equal(projection.stage, "settled");
    assert.equal(projection.reportStatus, "delivered");
    assert.equal(Number(projection.elapsedMs) >= 0, true);
    assert.ok(projection.queuedAt);
    assert.ok(projection.startedAt);
    assert.ok(projection.settledAt);
    for (const privateField of [
      "failureReason",
      "resultText",
      "idempotencyKey",
      "parentSessionId",
      "modelCalls",
      "reportAttempts",
      "reportError",
      "targetExecutionMs",
      "reportQueuedAt",
      "reportStartedAt",
      "reportWaitMs",
      "reportGenerationMs",
      "reportDeliveryMs",
      "reportModelCalls",
    ]) {
      assert.equal(
        Object.hasOwn(projection, privateField),
        false,
        `ordinary session projection must omit ${privateField}`,
      );
    }
    assert.doesNotMatch(JSON.stringify(projection), /projection-secret-stack-token|10\.0\.0\.8|socket/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
    runtime.dispose();
  }
});

async function captureDefaultCollaborationReport(input: {
  seed: string;
  sessionId: string;
  initialUserText: string;
  initialAssistantText: string;
  task: string;
  resultText: string;
  reportText: string;
  laterUserText?: string;
  laterAssistantText?: string;
}): Promise<{
  providerBody: string;
  visibleAssistantTexts: string[];
  episode: CharacterChannelEpisode;
}> {
  const providerBodies: string[] = [];
  const modelServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    providerBodies.push(Buffer.concat(chunks).toString("utf8"));
    writeChatCompletionStream(response, "collaboration-reporter-model", input.reportText);
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const actorStarted = createDeferred<void>();
  const actorResult = createDeferred<string>();
  const runtime = createTestRuntime({
    seed: input.seed,
    characterInteractionActor: async () => {
      actorStarted.resolve();
      return actorResult.promise;
    },
  });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const setup = setupSharedWorld(runtime);
    runtime.kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "collaboration-reporter-model",
    });
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "request_character_help",
        arguments: {
          targetCharacterId: setup.target.id,
          task: input.task,
        },
      },
      { kind: "assistant_text", text: input.initialAssistantText },
    ]);
    await runtime.kernel.sendMessage(input.sessionId, {
      mode: "sms",
      characterId: setup.source.id,
      text: input.initialUserText,
    });
    await withTimeout(actorStarted.promise, 1_000);

    if (input.laterUserText) {
      runtime.clock.advance(60_000);
      runtime.model.enqueue([{
        kind: "assistant_text",
        text: input.laterAssistantText ?? "好。",
      }]);
      await runtime.kernel.sendMessage(input.sessionId, {
        mode: "sms",
        characterId: setup.source.id,
        text: input.laterUserText,
      });
    }
    actorResult.resolve(input.resultText);
    await runtime.kernel.characterInteractionCoordinator.drain();
    assert.equal(providerBodies.length, 1);
    const session = await runtime.kernel.getSession(input.sessionId);
    const episode = runtime.kernel.listCharacterChannels({ worldId: setup.world.id })
      .flatMap((channel) => runtime.kernel.getCharacterChannel(channel.id).episodes)
      .find((entry) => entry.kind === "collaboration");
    assert.ok(episode);
    return {
      providerBody: providerBodies[0],
      visibleAssistantTexts: visibleAssistantTexts(session.messages),
      episode,
    };
  } finally {
    actorResult.resolve(input.resultText);
    runtime.dispose();
    await new Promise<void>((resolve, reject) =>
      modelServer.close((error) => error ? reject(error) : resolve()));
  }
}

function setupSharedWorld(runtime: TestRuntime, targetModelProfileId?: string) {
  const source = runtime.kernel.createCharacter({
    name: "发起角色",
    soulMarkdown: "# SOUL.md\n\n做事严谨，会主动向同伴求助。",
  });
  const target = runtime.kernel.createCharacter({
    name: "目标角色",
    soulMarkdown: "# SOUL.md\n\n待人温和，有自己的判断。",
    ...(targetModelProfileId ? { modelProfileId: targetModelProfileId } : {}),
  });
  const world = runtime.kernel.createWorld({
    name: "共同生活世界",
    timezone: "Asia/Shanghai",
    description: "两位角色生活在同一个城市。",
  });
  const place = runtime.kernel.createWorldPlace({
    worldId: world.id,
    name: "共同工作室",
    capabilityIds: ["work", "socialize", "communicate", "rest"],
  });
  for (const character of [source, target]) {
    runtime.kernel.assignCharacterWorld(character.id, {
      worldId: world.id,
      homePlaceId: place.id,
      currentPlaceId: place.id,
    });
  }
  return { source, target, world, place };
}

function writeChatCompletionStream(response: ServerResponse, model: string, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-character-channel",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-character-channel",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function assertCollaborationMetrics(
  episode: CharacterChannelEpisode,
  expected: { targetModelCalls: number; reportModelCalls: number },
): void {
  assert.ok(episode.queuedAt);
  assert.ok(episode.startedAt);
  assert.ok(episode.settledAt);
  assert.ok(episode.reportQueuedAt);
  assert.ok(episode.reportStartedAt);
  assert.ok(episode.reportedAt);
  const timeline = [
    episode.queuedAt,
    episode.startedAt,
    episode.settledAt,
    episode.reportQueuedAt,
    episode.reportStartedAt,
    episode.reportedAt,
  ].map((value) => Date.parse(value!));
  assert.equal(timeline.every(Number.isFinite), true);
  for (let index = 1; index < timeline.length; index += 1) {
    assert.equal(
      timeline[index] >= timeline[index - 1],
      true,
      `collaboration timestamp ${index} must not precede phase ${index - 1}`,
    );
  }
  assert.equal(episode.modelCalls, expected.targetModelCalls);
  assert.equal(episode.reportModelCalls, expected.reportModelCalls);
  assert.equal(episode.reportAttempts, 1);
  for (const value of [
    episode.targetExecutionMs,
    episode.reportWaitMs,
    episode.reportGenerationMs,
    episode.reportDeliveryMs,
  ]) {
    assert.equal(Number.isInteger(value) && Number(value) >= 0, true);
  }
}

function collaborationMetricSnapshot(episode: CharacterChannelEpisode) {
  return {
    modelCalls: episode.modelCalls,
    reportAttempts: episode.reportAttempts,
    queuedAt: episode.queuedAt,
    startedAt: episode.startedAt,
    settledAt: episode.settledAt,
    targetExecutionMs: episode.targetExecutionMs,
    reportQueuedAt: episode.reportQueuedAt,
    reportStartedAt: episode.reportStartedAt,
    reportWaitMs: episode.reportWaitMs,
    reportGenerationMs: episode.reportGenerationMs,
    reportDeliveryMs: episode.reportDeliveryMs,
    reportModelCalls: episode.reportModelCalls,
    reportedAt: episode.reportedAt,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function visibleAssistantTexts(messages: unknown[]): string[] {
  return messages.flatMap((message) => {
    if (!isRecord(message) || message.role !== "assistant") return [];
    const text = messageText(message).trim();
    return text ? [text] : [];
  });
}

function collaborationReportMarkers(messages: unknown[]): Array<Record<string, unknown>> {
  return messages.flatMap((message) =>
    isRecord(message) &&
      message.role === "custom" &&
      message.customType === "rp-agent/character_collaboration_report"
      ? [message]
      : []);
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
