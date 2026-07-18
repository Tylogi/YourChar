import assert from "node:assert/strict";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("server serves chat UI and debug model traces", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    clock: new VirtualClock("2026-07-09T12:00:00.000Z"),
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
    assert.match(html, /RP Agent/);
    assert.match(html, /上下文调试/);
    assert.match(html, /Provider Trace/);
    assert.match(html, /Context Economics/);
    assert.match(html, /model-traces\?limit=10/);
    assert.match(html, /语义上下文/);
    assert.match(html, /原始 JSON/);
    assert.match(html, /复制 Payload/);
    assert.match(html, /模型 API/);
    assert.match(html, /id="apiModel"/);
    assert.match(html, /id="systemPromptCustom"/);
    assert.match(html, /id="workspaceFilesPanel"/);
    assert.match(html, /id="chatAttachmentInput"/);
    assert.match(html, /addEventListener\("paste", pasteChatAttachments\)/);
    assert.match(html, /function clipboardFileExtension/);
    assert.match(html, /id="okfImportInput"/);
    assert.match(html, /id="stageOkfImportBtn"/);
    assert.match(html, /function renderOkfImportPreview/);
    assert.match(html, /id="chatImageDialog"/);
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
    assert.match(html, /id="sidebarArchivedSessionsBtn"/);
    assert.match(html, /id="sidebarBatchManageBtn"/);
    assert.match(html, /id="conversationBatchBar"/);
    assert.match(html, /data-conversation-group-toggle/);
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
    assert.match(html, /SOUL\.md/);
    assert.match(html, /loadCharacters/);
    assert.match(html, /id="managementPage"/);
    assert.match(html, /能力模块/);
    assert.match(html, /用户画像/);
    assert.match(html, /progress-tool-result/);
    assert.match(html, /查看结果/);
    assert.doesNotMatch(html, /<span>执行过程<\/span>/);
    assert.match(html, /module-token/);
    assert.match(html, /模型推理/);
    assert.match(html, /\/assets\/marked\.umd\.js/);
    assert.match(html, /\/assets\/purify\.min\.js/);
    assert.match(html, /renderMarkdown/);
    assert.match(html, /markdown-body/);
    assert.match(html, /<option value="sms">角色私聊<\/option>/);
    assert.match(html, /<option value="rp">剧情演绎<\/option>/);
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
