import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("server serves chat UI and debug model traces", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-09T12:00:00.000Z"),
    characterFunctionInferer: false,
    characterSkillReflector: false,
  });
  const character = kernel.createCharacter({ name: "UI 测试角色" });
  const server = createHttpServer({
    kernel,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].at(-1)?.[1] ?? "";
    assert.ok(inlineScript.length > 1_000);
    assert.doesNotThrow(() => new Script(inlineScript, { filename: "rendered-rp-agent-ui.js" }));
    assert.match(html, /RP Agent/);
    assert.match(html, /上下文调试/);
    assert.match(html, /Provider Trace/);
    assert.match(html, /Context Economics/);
    assert.match(html, /model-traces\?scope=conversation&limit=10/);
    assert.match(html, /model-traces\?scope=background&limit=10/);
    assert.match(html, /id="conversationTraceScopeBtn"/);
    assert.match(html, /id="backgroundTraceScopeBtn"/);
    assert.match(html, /角色职能推断/);
    assert.match(html, /角色 Skill 反思/);
    assert.match(html, /语义上下文/);
    assert.match(html, /原始 JSON/);
    assert.match(html, /复制 Payload/);
    assert.match(html, /上下文数量汇总/);
    assert.match(html, /function traceContextQuantity/);
    assert.match(html, /模型 API/);
    assert.match(html, /id="apiModel"/);
    assert.match(html, /id="apiContextWindowTokens"/);
    assert.match(html, /id="systemPromptCustom"/);
    assert.match(html, /id="systemPromptSettingsViewBtn"/);
    assert.match(html, /id="meetingPresetSettingsViewBtn"/);
    assert.match(html, /远程私聊与约见等待继续使用 SMS 默认编排/);
    assert.match(html, /退出见面后立即恢复 SMS 默认的系统提示词、用户画像和上下文编排/);
    assert.match(html, /id="meetingPresetImportInput"[^>]+accept="\.json,application\/json"/);
    assert.match(html, /id="meetingPresetImportOrder"/);
    assert.match(html, /id="meetingPresetParametersEnabled"/);
    assert.match(html, /id="meetingPresetCompatibility"/);
    assert.match(html, /id="meetingPresetPromptList"/);
    assert.match(html, /function loadMeetingPresetCatalog/);
    assert.match(html, /function selectMeetingPresetImport/);
    assert.match(html, /function saveMeetingPreset/);
    assert.match(html, /api\/v1\/meeting-presets/);
    assert.match(html, /JSON 文件超过 900 KB/);
    assert.match(html, /id="workspaceFilesPanel"/);
    assert.match(html, /id="chatAttachmentInput"/);
    assert.match(html, /id="emojiPickerBtn"/);
    assert.match(html, /id="emojiPicker"/);
    assert.match(html, /function insertSelectedEmoji/);
    assert.match(html, /addEventListener\("paste", pasteChatAttachments\)/);
    assert.match(html, /function clipboardFileExtension/);
    assert.match(html, /id="okfImportInput"/);
    assert.match(html, /id="stageOkfImportBtn"/);
    assert.match(html, /id="traceArchiveEnabled"/);
    assert.match(html, /api\/settings\/trace-archive/);
    assert.match(html, /function renderOkfImportPreview/);
    assert.match(html, /id="chatImageDialog"/);
    assert.match(html, /id="characterProfileDialog"/);
    assert.match(html, /id="characterChannelDialog"/);
    assert.match(html, /data-character-channel-id/);
    assert.match(html, /data-character-channel-episode-id/);
    assert.match(html, /function openCharacterChannel/);
    assert.match(html, /activeCharacterChannelEpisodeId/);
    assert.match(html, /api\/v1\/character-channels/);
    assert.match(html, /api\/v1\/sessions\/.*\/character-collaborations/);
    assert.match(html, /function mergeCharacterCollaborations/);
    assert.match(html, /function renderCollaborationEvent/);
    assert.match(html, /character-collaboration-card/);
    assert.match(html, /rejectedWithoutEpisode/);
    assert.match(html, /outcome\.status === "blocked"/);
    assert.match(html, /查看他们的往来/);
    assert.match(html, /data-character-profile-id/);
    assert.match(html, /function openCharacterProfile/);
    const characterProfileDialog = html.match(/<dialog id="characterProfileDialog"[\s\S]*?<\/dialog>/)?.[0] ?? "";
    assert.doesNotMatch(characterProfileDialog, /<(?:input|textarea|select|form)\b/);
    assert.doesNotMatch(characterProfileDialog, /保存|编辑/);
    assert.match(html, /data-message-image/);
    assert.match(html, /workspaceImagePath/);
    assert.match(html, /compositionEndedAt/);
    assert.match(html, /normalBtn/);
    assert.match(html, /settingsBtn/);
    assert.match(html, /debugBtn/);
    assert.match(html, /height: 100vh/);
    assert.match(html, /overflow: hidden/);
    assert.match(html, /id="mainPane"/);
    assert.match(html, /nodes\.chatPane\.hidden = mode !== "normal"/);
    assert.match(html, /id="sessionSelect"/);
    assert.match(html, /id="newSessionBtn"/);
    assert.match(html, /id="newConversationDialog"/);
    assert.match(html, /id="sceneInfoDialog"/);
    assert.match(html, /id="contextBudgetBtn"/);
    assert.match(html, /id="contextBudgetDialog"/);
    assert.match(html, /Provider 实测（含缓存）/);
    assert.match(html, /\["本地估算", formatTokenCount\(budget\.estimatedInputTokens\)\]/);
    assert.match(html, /api\/v1\/sessions\/.*\/context-budget/);
    assert.match(html, /function compactCurrentContext/);
    assert.match(html, /id="sidebarArchivedSessionsBtn"/);
    assert.match(html, /id="sidebarBatchManageBtn"/);
    assert.match(html, /id="conversationBatchBar"/);
    assert.match(html, /data-conversation-group-toggle/);
    assert.match(html, /function conversationUnreadBadge/);
    assert.match(html, /function conversationUnreadCount/);
    assert.match(html, /api\/v1\/conversation-unread/);
    assert.match(html, /function isConversationVisible/);
    assert.match(html, /document\.hasFocus\(\)/);
    assert.match(html, /conversation-group-title/);
    assert.match(html, /character_declined: "角色未发送"/);
    assert.match(html, /__worlds__/);
    assert.match(html, /__roles__/);
    assert.match(html, /data-world-id/);
    assert.match(html, /api\/v1\/world-conversations/);
    assert.match(html, /function sendWorldChatMessage/);
    assert.match(html, /id="resetWorldConversationBtn"/);
    assert.match(html, /function resetCurrentWorldConversation/);
    assert.match(html, /method: "DELETE"/);
    assert.match(html, /function worldAvatarCluster/);
    assert.match(html, /data-conversation-session-select/);
    assert.match(html, /data-session-draft/);
    assert.doesNotMatch(html, /id="sessionInput"/);
    assert.match(html, /rp-agent\/system_event/);
    assert.match(html, /message\.display === false/);
    assert.match(html, /class="message-row system"/);
    assert.match(html, /id="renameSessionBtn"/);
    assert.match(html, /id="archiveSessionBtn"/);
    assert.match(html, /id="deleteSessionBtn"/);
    assert.match(html, /id="archivedSessionsDialog"/);
    assert.match(html, /data-system-action/);
    assert.match(html, /lastTurnCanRetry/);
    assert.match(html, /sleepState/);
    assert.match(html, /休息中/);
    assert.doesNotMatch(html, /lastTurnFailed|turnFailed|retryFailed/);
    assert.match(html, /id="schedulePage"/);
    assert.match(html, /id="userScheduleTabBtn"/);
    assert.match(html, /id="characterScheduleTabBtn"/);
    assert.match(html, /id="scheduleCharacterSelect"/);
    assert.match(html, /id="scheduleAgendaViewBtn"/);
    assert.match(html, /id="scheduleAllDay"/);
    assert.match(html, /loadScheduleItems/);
    assert.match(html, /id="charactersPage"/);
    assert.match(html, /角色设定/);
    assert.match(html, /id="characterDetail" class="character-detail" hidden/);
    assert.match(html, /id="characterMemoryPanel"/);
    assert.match(html, /id="characterFunctionTabBtn"/);
    assert.match(html, /id="characterFunctionPanel"/);
    assert.match(html, /id="characterCapabilityList"/);
    assert.match(html, /id="characterFunctionAutomatic"/);
    assert.match(html, /id="refreshCharacterFunctionBtn"/);
    assert.match(html, /id="characterSkillVersionSelect"/);
    assert.match(html, /id="characterSkillMarkdown"/);
    assert.match(html, /id="characterFunctionAdvanced"/);
    assert.match(html, /function loadCharacterFunction/);
    assert.match(html, /function saveCharacterFunction/);
    assert.match(html, /function renderCharacterSkillDocument/);
    assert.match(html, /api\/v1\/characters\/.*\/function-profile/);
    assert.match(html, /skill-versions/);
    assert.match(html, /id="characterLifePanel"/);
    assert.match(html, /id="lifeProactiveCooldown"/);
    assert.match(html, /id="lifeSocialEnabled"/);
    assert.match(html, /id="lifeSocialDailyLimit"/);
    assert.match(html, /id="lifeSocialCooldown"/);
    assert.match(html, /id="lifeProactiveList"/);
    assert.match(html, /id="lifeTopicPolicyList"/);
    assert.match(html, /id="resumeProactiveBtn"/);
    assert.match(html, /id="memoryEditorDialog"/);
    assert.match(html, /尚未建立浪漫关系/);
    assert.match(html, /relationship_confirmed: "确认交往"/);
    const characterPage = html.match(/<section id="charactersPage"[\s\S]*?<section id="managementPage"/)?.[0] ?? "";
    assert.doesNotMatch(characterPage, /id="sceneForm"/);
    const characterMemoryForm = html.match(/<form id="memoryForm"[\s\S]*?<\/form>/)?.[0] ?? "";
    assert.doesNotMatch(characterMemoryForm, /<option value="user_fact">/);
    assert.doesNotMatch(characterMemoryForm, /<option value="preference">/);
    assert.match(characterMemoryForm, /<option value="relationship_event">/);
    assert.match(html, /characterSoulMarkdown/);
    assert.match(html, /id="characterMeetingPreset"/);
    assert.match(html, /meetingPresetId: nodes\.characterMeetingPreset\.value \|\| null/);
    assert.match(html, /SOUL\.md/);
    assert.match(html, /loadCharacters/);
    assert.match(html, /id="managementPage"/);
    assert.match(html, /能力模块/);
    assert.match(html, /用户画像/);
    assert.match(html, /id="userInsightList"/);
    assert.match(html, /画像形成记录/);
    assert.match(html, /api\/v1\/user-insights/);
    assert.match(html, /data-user-insight-action/);
    assert.match(html, /conversation_statement/);
    assert.match(html, /progress-tool-result/);
    assert.match(html, /查看结果/);
    assert.doesNotMatch(html, /<span>执行过程<\/span>/);
    assert.match(html, /module-token/);
    assert.match(html, /模型推理/);
    assert.match(html, /\/assets\/marked\.umd\.js/);
    assert.match(html, /\/assets\/purify\.min\.js/);
    assert.match(html, /\/assets\/noto-emoji\/400\.css/);
    assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
    assert.match(html, /rel="apple-touch-icon" sizes="180x180"/);
    assert.match(html, /name="theme-color" content="#07c160"/);
    assert.match(html, /renderMarkdown/);
    assert.match(html, /markdown-body/);
    assert.match(html, /function assistantBubbleSegments/);
    assert.match(html, /function annotateProactiveMessages/);
    assert.match(html, /data-proactive-feedback/);
    assert.match(html, /function schedulePrivateTypingHeartbeat/);
    assert.match(html, /\/inbox\/typing/);
    assert.match(html, /id="debugInitiativeBtn"/);
    assert.match(html, /id="initiativeDebugPanel"/);
    const modeControl = html.match(/<label id="modeControl">[\s\S]*?<\/label>/)?.[0] ?? "";
    assert.match(modeControl, /<option value="sms">角色私聊<\/option>/);
    assert.doesNotMatch(modeControl, /value="rp"/);
    const newConversationDialog = html.match(/<dialog id="newConversationDialog"[\s\S]*?<\/dialog>/)?.[0] ?? "";
    assert.match(newConversationDialog, />角色<\/button>/);
    assert.match(newConversationDialog, />世界<\/button>/);
    assert.match(newConversationDialog, /id="newConversationWorld"/);
    assert.doesNotMatch(newConversationDialog, /群聊|剧情演绎/);
    assert.match(html, /id="worldDirectorModelProfile"/);
    assert.match(html, /id="worldAnalystModelProfile"/);
    assert.match(html, /id="conversationCharacter"/);
    assert.match(html, /id="visionSettingsTabBtn"/);
    assert.match(html, /id="visionSettingsPanel"/);
    assert.match(html, /id="apiVisionInputEnabled"/);
    assert.match(html, /请先选择角色；如果还没有角色/);
    assert.doesNotMatch(html, /thinking_delta/);

    for (const asset of ["marked.umd.js", "purify.min.js", "lucide.min.js"]) {
      const response = await fetch(`${baseUrl}/assets/${asset}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/javascript/);
      assert.ok((await response.arrayBuffer()).byteLength > 10_000);
    }
    const emojiCss = await fetch(`${baseUrl}/assets/noto-emoji/400.css`);
    assert.equal(emojiCss.status, 200);
    assert.match(emojiCss.headers.get("content-type") ?? "", /text\/css/);
    assert.match(await emojiCss.text(), /font-family: 'Noto Emoji'/);
    const emojiFont = await fetch(`${baseUrl}/assets/noto-emoji/files/noto-emoji-9-400-normal.woff2`);
    assert.equal(emojiFont.status, 200);
    assert.equal(emojiFont.headers.get("content-type"), "font/woff2");
    assert.ok((await emojiFont.arrayBuffer()).byteLength > 50_000);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type") ?? "", /application\/manifest\+json/);
    const manifest = await manifestResponse.json() as {
      name: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string }>;
    };
    assert.equal(manifest.name, "RP Agent");
    assert.equal(manifest.theme_color, "#07c160");
    assert.equal(manifest.icons.some((icon) => icon.sizes === "192x192"), true);
    assert.equal(manifest.icons.some((icon) => icon.sizes === "512x512"), true);

    const appIcon = await fetch(`${baseUrl}/assets/icons/app-icon-192.png`);
    assert.equal(appIcon.status, 200);
    assert.equal(appIcon.headers.get("content-type"), "image/png");
    const appIconBuffer = Buffer.from(await appIcon.arrayBuffer());
    assert.equal(appIconBuffer.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(appIconBuffer.readUInt32BE(16), 192);
    assert.equal(appIconBuffer.readUInt32BE(20), 192);

    const iosAppIcon = await fetch(`${baseUrl}/assets/icons/app-icon-1024.png`);
    assert.equal(iosAppIcon.status, 200);
    const iosAppIconBuffer = Buffer.from(await iosAppIcon.arrayBuffer());
    assert.equal(iosAppIconBuffer.readUInt32BE(16), 1024);
    assert.equal(iosAppIconBuffer.readUInt32BE(20), 1024);
    assert.equal(iosAppIconBuffer[25], 2, "iOS master icon must be opaque RGB without an alpha channel");

    const pageWithSlash = await fetch(`${baseUrl}/ui/`);
    assert.equal(pageWithSlash.status, 200);

    const relationshipResponse = await fetch(`${baseUrl}/api/v1/characters/${encodeURIComponent(character.id)}/relationship`);
    assert.equal(relationshipResponse.status, 200);
    const relationshipBody = await relationshipResponse.json() as {
      relationship: { state: { bondFacets: string[]; romanceStatus: string }; qualitative: string };
    };
    assert.deepEqual(relationshipBody.relationship.state.bondFacets, []);
    assert.equal(relationshipBody.relationship.state.romanceStatus, "none");
    assert.match(relationshipBody.relationship.qualitative, /Explicit romantic status/);

    const insightResponse = await fetch(`${baseUrl}/api/v1/user-insights?limit=10`);
    assert.equal(insightResponse.status, 200);
    const insightBody = await insightResponse.json() as {
      insights: { observationCount: number; recentObservations: unknown[] };
    };
    assert.equal(insightBody.insights.observationCount, 0);
    assert.deepEqual(insightBody.insights.recentObservations, []);
    assert.match(await pageWithSlash.text(), /RP Agent/);

    const apiHealth = await fetch(`${baseUrl}/api/health`);
    assert.equal(apiHealth.status, 200);
    assert.deepEqual(await apiHealth.json(), { status: "ok" });

    const uiApiRoot = await fetch(`${baseUrl}/ui/api`);
    assert.equal(uiApiRoot.status, 200);
    assert.equal(((await uiApiRoot.json()) as { status: string }).status, "ok");

    const savedSettings = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        baseUrl: "http://127.0.0.1:8317/v1",
        model: "local-model",
        visionInputEnabled: true,
        apiKey: "client-secret",
        temperature: 0.7,
        maxTokens: 2048,
      }),
    });
    assert.equal(savedSettings.status, 200);
    const savedBody = await savedSettings.json();
    assert.equal(savedBody.apiKeySet, true);
    assert.equal(savedBody.visionInputEnabled, true);
    assert.equal(savedBody.apiKeyMasked, "clie...cret");
    assert.equal(JSON.stringify(savedBody).includes("client-secret"), false);

    const fetchedSettings = await fetch(`${baseUrl}/api/model-config/openai-compatible`);
    assert.equal(fetchedSettings.status, 200);
    const fetchedBody = await fetchedSettings.json();
    assert.equal(fetchedBody.model, "local-model");
    assert.equal(JSON.stringify(fetchedBody).includes("client-secret"), false);

    const savedVisionSettings = await fetch(`${baseUrl}/api/settings/vision`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "direct", detail: "high", maxImages: 2 }),
    });
    assert.equal(savedVisionSettings.status, 200);
    const visionBody = await savedVisionSettings.json();
    assert.equal(visionBody.mode, "direct");
    assert.equal(visionBody.detail, "high");
    assert.equal(visionBody.maxImages, 2);

    await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const message = await fetch(`${baseUrl}/api/sessions/ui-test/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "sms",
        text: "5分钟后提醒我喝水",
        characterId: character.id,
      }),
    });
    assert.equal(message.status, 200);

    const handle = await kernel.sessionRuntime.getOrCreate("ui-test", "sms", character.id);
    await handle.session.sendCustomMessage({
      customType: "rp-agent/turn_context",
      content: "hidden runtime context",
      display: false,
    }, { triggerTurn: false });
    const rawSession = await kernel.getSession("ui-test");
    assert.equal(rawSession.messages.some((entry) =>
      entry.role === "custom" && entry.customType === "rp-agent/turn_context"
    ), true);

    const visibleHistory = await fetch(`${baseUrl}/api/v1/sessions/ui-test/messages`);
    const visibleMessages = await visibleHistory.json() as Array<{ customType?: string }>;
    assert.equal(visibleMessages.some((entry) => entry.customType === "rp-agent/turn_context"), false);
    const sessionsResponse = await fetch(`${baseUrl}/api/v1/sessions`);
    const sessionsBody = await sessionsResponse.json() as {
      sessions: Array<{ id: string; messageCount: number }>;
    };
    assert.equal(sessionsBody.sessions.find((entry) => entry.id === "ui-test")?.messageCount, 2);

    const logs = await fetch(`${baseUrl}/api/debug/context-logs`);
    assert.equal(logs.status, 200);
    const body = (await logs.json()) as { logs: Array<{ requestText: string; toolNames: string[] }> };
    assert.equal(body.logs[0].requestText, "5分钟后提醒我喝水");
    assert.deepEqual(body.logs[0].toolNames, [
      "create_schedule_item",
      "list_schedule_items",
      "update_schedule_item",
      "complete_schedule_item",
      "cancel_schedule_item",
      "snooze_reminder",
      "get_user_profile",
      "update_user_profile",
      "propose_meeting",
      "begin_meeting",
      "end_meeting",
      "search_memory",
    ]);

    const traces = await fetch(`${baseUrl}/api/debug/model-traces`);
    assert.equal(traces.status, 200);
    assert.deepEqual(await traces.json(), { traces: [] });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    kernel.dispose();
  }
});
