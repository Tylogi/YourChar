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
    assert.match(html, /id="gitSettingsTabBtn"/u);
    assert.match(html, /id="gitSettingsPanel"/u);
    assert.match(html, /id="gitCredentialMode"/u);
    assert.match(html, /id="gitPrivateKeyPath"/u);
    assert.match(html, /id="gitProxyMode"/u);
    assert.match(html, /id="gitProxyPort"/u);
    assert.match(html, /id="gitAccessPublicKey"/u);
    assert.match(html, /\/api\/settings\/git-access/u);
    assert.match(html, /\/api\/settings\/git-access\/generate-key/u);
    assert.match(html, /\/api\/settings\/git-access\/public-key/u);
    assert.doesNotMatch(html, /id="gitRemoteUrl"/u);
    assert.doesNotMatch(html, /id="gitProjectSelect"/u);
    assert.doesNotMatch(html, /id="gitRepositorySelect"/u);
    assert.doesNotMatch(html, /id="gitIdentitySelect"/u);
    assert.doesNotMatch(html, /id="gitSessionProjectSelect"/u);
    assert.doesNotMatch(html, /\/api\/settings\/git-(?:registry|identities|projects|repositories|project-repositories)/u);
    assert.doesNotMatch(html, /\/api\/v1\/diagnostics\/git-repositor/u);
    assert.doesNotMatch(html, /\/api\/settings\/sessions\/[\s\S]{0,160}?\/git-project/u);
    assert.ok(html.includes("把 <code>ssh://</code> 仓库 URL 直接发给普通模式角色"));
    assert.match(html, /Workspace\/repos\//u);
    assert.match(html, /无需预先登记项目、仓库或白名单/u);
    assert.match(html, /托管 Key 会随完整状态备份/u);
    const inlineScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)].at(-1)?.[1] ?? "";
    assert.ok(inlineScript.length > 1_000);
    assert.doesNotThrow(() => new Script(inlineScript, { filename: "rendered-rp-agent-ui.js" }));
    const gitAccessSaveScript = inlineScript.match(
      /async function saveGitAccess[\s\S]*?(?=\n    async function generateGitAccessKey)/,
    )?.[0] ?? "";
    assert.match(gitAccessSaveScript, /expectedRevision: access\.revision/u);
    assert.match(gitAccessSaveScript, /controlPlaneFetch\("\/api\/settings\/git-access"/u);
    assert.match(gitAccessSaveScript, /gitAccessScopeMatches\(scope\)/u);
    assert.match(gitAccessSaveScript, /kind: "external-file"/u);
    assert.match(gitAccessSaveScript, /kind: "unconfigured"/u);
    assert.doesNotMatch(gitAccessSaveScript, /\{\s*kind: "managed-ed25519"/u);
    assert.match(gitAccessSaveScript, /title: "更换 SSH 凭据"/u);
    assert.doesNotMatch(gitAccessSaveScript, /fingerprint\s*:/u);
    assert.doesNotMatch(gitAccessSaveScript, /keyRef\s*:/u);
    assert.doesNotMatch(gitAccessSaveScript, /remoteUrl\s*:/u);
    const gitGenerateScript = inlineScript.match(
      /async function generateGitAccessKey[\s\S]*?(?=\n    async function loadGitAccessPublicKey)/,
    )?.[0] ?? "";
    assert.match(gitGenerateScript, /controlPlaneFetch\("\/api\/settings\/git-access\/generate-key"/u);
    assert.match(gitGenerateScript, /expectedRevision: access\.revision/u);
    const gitPublicKeyScript = inlineScript.match(
      /async function loadGitAccessPublicKey[\s\S]*?(?=\n    function showGitAccessPublicKey)/,
    )?.[0] ?? "";
    assert.match(gitPublicKeyScript, /fetch\("\/api\/settings\/git-access\/public-key"\)/u);
    assert.match(gitPublicKeyScript, /gitAccessScopeMatches\(scope\)/u);
    const gitAccessScopeScript = inlineScript.match(
      /function captureGitAccessScope[\s\S]*?(?=\n    async function loadGitSettings)/,
    )?.[0] ?? "";
    assert.match(gitAccessScopeScript, /scope\.requestId === state\.gitAccessRequestId/u);
    assert.match(gitAccessScopeScript, /spaceEpoch: state\.conversationSpaceEpoch/u);
    assert.match(gitAccessScopeScript, /viewEpoch: state\.conversationViewEpoch/u);
    assert.match(gitAccessScopeScript, /scope\.sessionId === state\.activeSessionId/u);
    const gitScopeState: Record<string, any> = {
      uiMode: "settings",
      settingsTab: "git",
      conversationSpace: "normal",
      conversationSpaceEpoch: 3,
      conversationViewEpoch: 8,
      activeConversationKind: "direct",
      activeSessionId: "session-git-a",
      selectedCharacterId: character.id,
      gitAccessRequestId: 5,
    };
    const gitScopeContext: Record<string, any> = { state: gitScopeState };
    new Script(
      gitAccessScopeScript +
      "\nthis.captureGitAccessScopeForTest = captureGitAccessScope;" +
      "\nthis.gitAccessScopeMatchesForTest = gitAccessScopeMatches;",
    ).runInNewContext(gitScopeContext);
    const currentGitScope = gitScopeContext.captureGitAccessScopeForTest(5);
    assert.equal(gitScopeContext.gitAccessScopeMatchesForTest(currentGitScope), true);
    gitScopeState.gitAccessRequestId += 1;
    assert.equal(gitScopeContext.gitAccessScopeMatchesForTest(currentGitScope), false, "superseded Git response is stale");
    gitScopeState.gitAccessRequestId = 5;
    gitScopeState.conversationViewEpoch += 1;
    assert.equal(gitScopeContext.gitAccessScopeMatchesForTest(currentGitScope), false, "late Git GET cannot cross views");
    gitScopeState.conversationViewEpoch = 8;
    gitScopeState.conversationSpace = "secret";
    assert.equal(gitScopeContext.gitAccessScopeMatchesForTest(currentGitScope), false, "Git settings response cannot cross spaces");
    gitScopeState.conversationSpace = "normal";
    gitScopeState.activeSessionId = "session-git-b";
    assert.equal(gitScopeContext.gitAccessScopeMatchesForTest(currentGitScope), false, "late Git response cannot cross sessions");
    const conversationNavigationScript = inlineScript.match(
      /function conversationViewIsCurrent[\s\S]*?(?=\n    async function applySession)/,
    )?.[0] ?? "";
    assert.match(conversationNavigationScript, /state\.messages = \[\]/);
    assert.match(conversationNavigationScript, /\+\+state\.conversationViewEpoch/);
    const navigationState = {
      activeConversationKind: "direct",
      activeSessionId: "session-b",
      activeWorldId: "",
      activeGroupId: "",
      conversationViewEpoch: 4,
      conversationViewLoading: false,
      messages: [{ text: "B sentinel" }],
      privateTypingHeartbeatTimer: null,
      privateInboxMessages: [{ id: "old-inbox" }],
      privateInboxRunning: true,
      activeProactiveMessages: [{ id: "old-proactive" }],
      contextBudget: { remainingTokens: 1 },
      characterLiveState: { presence: "old" },
      lastTurnStatus: "completed",
      lastTurnCanRetry: true,
      pendingAttachments: [{ path: "old.txt" }],
      attachmentUploadQueue: [{ file: "old.txt", viewEpoch: 4 }],
    };
    let clearedConversationScenes = 0;
    const navigationContext: Record<string, any> = {
      state: navigationState,
      window: { clearTimeout() {} },
      closePrivateInboxEvents() {},
      clearInteractionState() {},
      clearConversationScene() { clearedConversationScenes += 1; },
      closeMessageEditDialog() {},
      renderAttachmentQueue() {},
      updateContextBudgetChrome() {},
      updateRetryState() {},
    };
    new Script(
      conversationNavigationScript +
      "\nthis.beginConversationViewForTest = beginConversationView;" +
      "\nthis.conversationViewIsCurrentForTest = conversationViewIsCurrent;",
    ).runInNewContext(navigationContext);
    const firstAView = navigationContext.beginConversationViewForTest("direct", "session-a");
    assert.equal(navigationState.messages.length, 0, "switching to A synchronously removes B's messages");
    assert.equal(navigationState.pendingAttachments.length, 0, "view-scoped attachments do not cross sessions");
    assert.equal(clearedConversationScenes, 1, "switching conversations synchronously clears the old scene");
    assert.equal(navigationState.activeSessionId, "session-a");
    navigationContext.beginConversationViewForTest("direct", "session-b");
    const latestAView = navigationContext.beginConversationViewForTest("direct", "session-a");
    assert.equal(
      navigationContext.conversationViewIsCurrentForTest("direct", "session-a", firstAView.epoch),
      false,
      "an A response from before an A-B-A navigation is stale",
    );
    assert.equal(
      navigationContext.conversationViewIsCurrentForTest("direct", "session-a", latestAView.epoch),
      true,
    );
    const directRefreshScript = inlineScript.match(
      /async function refreshSessionMessages[\s\S]*?(?=\n    async function uploadChatAttachments)/,
    )?.[0] ?? "";
    assert.match(directRefreshScript, /expectedViewEpoch = state\.conversationViewEpoch/);
    assert.match(directRefreshScript, /directConversationScopeMatches\(scope\)/);
    assert.match(directRefreshScript, /scope\.characterId[\s\S]*?\/interaction/);
    assert.doesNotMatch(
      directRefreshScript,
      /sharedStateEnabled\s*\?[\s\S]{0,240}?\/interaction/,
      "secret conversations fetch their isolated interaction state",
    );
    assert.match(
      directRefreshScript,
      /sharedStateEnabled\s*\?[\s\S]*?\/proactive-messages[\s\S]*?sharedStateEnabled\s*\?[\s\S]*?\/character-collaborations/,
      "proactive messages and collaboration remain normal-space only",
    );
    const directScopeScript = inlineScript.match(
      /function captureDirectConversationScope[\s\S]*?(?=\n    async function applySession)/,
    )?.[0] ?? "";
    assert.match(directScopeScript, /spaceEpoch: state\.conversationSpaceEpoch/);
    assert.match(directScopeScript, /viewEpoch: state\.conversationViewEpoch/);
    assert.match(directScopeScript, /scope\.characterId !== state\.selectedCharacterId/);
    assert.match(directScopeScript, /conversationViewIsCurrent\("direct", scope\.sessionId, scope\.viewEpoch\)/);
    const interactionActionScript = inlineScript.match(
      /async function runInteractionAction[\s\S]*?(?=\n    function updateScheduleHeaderContext)/,
    )?.[0] ?? "";
    assert.match(interactionActionScript, /captureDirectConversationScope\(\)/);
    assert.match(interactionActionScript, /scope\.conversationSpace,[\s\S]*?scope\.characterId/);
    assert.match(interactionActionScript, /directConversationScopeMatches\(scope\)/);
    assert.match(interactionActionScript, /refreshSessionMessages\(true, scope\.spaceEpoch, scope\.viewEpoch\)/);
    const conversationViewGuardScript = inlineScript.match(
      /function conversationViewIsCurrent[\s\S]*?(?=\n    function beginConversationView)/,
    )?.[0] ?? "";
    let resolveActionFetch: (value: unknown) => void = () => undefined;
    const actionFetch = new Promise((resolve) => { resolveActionFetch = resolve; });
    let requestedInteractionUrl = "";
    let actionChromeUpdates = 0;
    let actionRefreshes = 0;
    const actionState: Record<string, any> = {
      activeConversationKind: "direct",
      activeSessionId: "secret-session",
      activeWorldId: "",
      activeGroupId: "",
      selectedCharacterId: character.id,
      conversationSpace: "secret",
      conversationSpaceEpoch: 3,
      conversationViewEpoch: 8,
      sessionDraft: false,
      sessions: [{
        id: "secret-session",
        characterId: character.id,
        conversationSpace: "secret",
      }],
      busy: false,
      privateInboxRunning: false,
      interactionState: { presence: "remote" },
      interactionEvents: [],
      interactionCanUndo: false,
      interactionLocations: [],
      characterLiveState: null,
    };
    const staleActionContext: Record<string, any> = {
      state: actionState,
      fetch(path: string) {
        requestedInteractionUrl = path;
        return actionFetch;
      },
      withConversationSpace(path: string, conversationSpace: string, characterId: string) {
        return path + "?conversationSpace=" + conversationSpace + "&characterId=" + characterId;
      },
      updateInteractionChrome() { actionChromeUpdates += 1; },
      async refreshSessionMessages() { actionRefreshes += 1; },
      async refreshConversationMetadata() { actionRefreshes += 1; },
      setStatus() { throw new Error("stale interaction action must not update status"); },
    };
    new Script(
      conversationViewGuardScript + "\n" + directScopeScript + "\n" + interactionActionScript +
      "\nthis.runInteractionActionForTest = runInteractionAction;",
    ).runInNewContext(staleActionContext);
    const staleAction = staleActionContext.runInteractionActionForTest("begin", { userConfirmed: true });
    assert.equal(actionState.busy, true);
    assert.match(requestedInteractionUrl, /conversationSpace=secret&characterId=/);
    actionState.conversationViewEpoch += 1;
    resolveActionFetch({
      ok: true,
      async json() {
        return { state: { presence: "co_present", location: "不应写入当前视图" } };
      },
    });
    await staleAction;
    assert.equal(actionState.busy, false);
    assert.equal(actionState.interactionState.presence, "remote");
    assert.equal(actionRefreshes, 0);
    assert.equal(actionChromeUpdates, 1, "stale completion does not repaint the replacement view");

    const interactionChromeScript = inlineScript.match(
      /function updateInteractionChrome[\s\S]*?(?=\n    async function openInteractionControl)/,
    )?.[0] ?? "";
    const control = () => ({
      hidden: true,
      disabled: false,
      textContent: "",
      title: "",
      innerHTML: "",
      attributes: {} as Record<string, string>,
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
    });
    const interactionNodes = {
      interactionToggleBtn: control(),
      interactionUndoBtn: control(),
      textInput: { placeholder: "" },
      modeSelect: { value: "sms" },
      conversationMode: { textContent: "" },
      conversationScene: { textContent: "", title: "", hidden: true },
      sceneInfoBtn: { hidden: false },
    };
    const interactionState: Record<string, any> = {
      uiMode: "normal",
      activeConversationKind: "direct",
      activeSessionId: "secret-session",
      conversationSpace: "secret",
      incognitoConversation: null,
      sessionDraft: false,
      interactionState: { presence: "remote" },
      interactionCanUndo: false,
      characterLiveState: { place: "普通空间地点哨兵", activity: "普通空间活动哨兵" },
      busy: false,
      privateInboxRunning: false,
    };
    const interactionContext: Record<string, any> = {
      state: interactionState,
      nodes: interactionNodes,
      refreshIcons() {},
    };
    new Script(
      interactionChromeScript + "\nthis.updateInteractionChromeForTest = updateInteractionChrome;",
    ).runInNewContext(interactionContext);
    interactionContext.updateInteractionChromeForTest();
    assert.equal(interactionNodes.interactionToggleBtn.hidden, false);
    assert.equal(interactionNodes.interactionToggleBtn.title, "发起见面");
    assert.equal(interactionNodes.conversationMode.textContent, "私密对话");
    assert.equal(interactionNodes.conversationScene.hidden, true, "normal live state is hidden in secret mode");
    assert.equal(interactionNodes.sceneInfoBtn.hidden, true, "secret meeting does not expose scene controls");
    interactionState.interactionState = { presence: "meeting_pending", location: "私密地点" };
    interactionState.interactionCanUndo = true;
    interactionContext.updateInteractionChromeForTest();
    assert.equal(interactionNodes.conversationMode.textContent, "私密·约好见面");
    assert.equal(interactionNodes.conversationScene.textContent, "约好见面 · 私密地点");
    assert.equal(interactionNodes.interactionUndoBtn.hidden, false);
    interactionState.interactionState = { presence: "co_present", location: "私密地点" };
    interactionContext.updateInteractionChromeForTest();
    assert.equal(interactionNodes.conversationMode.textContent, "私密见面中");
    assert.equal(interactionNodes.interactionToggleBtn.title, "结束见面");
    interactionState.conversationSpace = "normal";
    interactionState.activeSessionId = "incognito-session";
    interactionState.incognitoConversation = { id: "incognito-session", incognito: true };
    interactionContext.updateInteractionChromeForTest();
    assert.equal(interactionNodes.conversationMode.textContent, "无痕见面中");
    const worldRefreshScript = inlineScript.match(
      /async function refreshWorldMessages[\s\S]*?(?=\n    function normalizeWorldMessage)/,
    )?.[0] ?? "";
    assert.match(worldRefreshScript, /conversationViewIsCurrent\("world", requestedWorldId, expectedViewEpoch\)/);
    const groupRefreshScript = inlineScript.match(
      /async function refreshGroupMessages[\s\S]*?(?=\n    function renderSessionOptions)/,
    )?.[0] ?? "";
    assert.match(groupRefreshScript, /const requestedGroupId = state\.activeGroupId/);
    assert.match(groupRefreshScript, /conversationViewIsCurrent\("group", requestedGroupId, expectedViewEpoch\)/);
    const retryScript = inlineScript.match(
      /async function retryMessage[\s\S]*?(?=\n    function pushMessage)/,
    )?.[0] ?? "";
    assert.match(retryScript, /retryLocalId/);
    assert.match(retryScript, /conversationViewIsCurrent\("direct", requestedSessionId, expectedViewEpoch\)/);
    const inboxEventScript = inlineScript.match(
      /function openPrivateInboxEvents[\s\S]*?(?=\n    function captureInsightReceiptBaseline)/,
    )?.[0] ?? "";
    assert.match(inboxEventScript, /expectedViewEpoch = state\.conversationViewEpoch/);
    assert.match(inboxEventScript, /handlePrivateInboxEvent\([\s\S]*?expectedViewEpoch/);
    assert.match(inboxEventScript, /refreshSessionMessages\(true, expectedEpoch, expectedViewEpoch\)/);
    const loadSessionsScript = inlineScript.match(
      /async function loadSessions\(\)[\s\S]*?(?=\n    function startNewSession)/,
    )?.[0] ?? "";
    assert.match(loadSessionsScript, /const expectedViewEpoch = state\.conversationViewEpoch/);
    assert.match(loadSessionsScript, /expectedViewEpoch !== state\.conversationViewEpoch/);
    const attachmentUploadScript = inlineScript.match(
      /async function queueChatAttachments[\s\S]*?(?=\n    function renderAttachmentQueue)/,
    )?.[0] ?? "";
    assert.match(attachmentUploadScript, /viewEpoch: enqueueViewEpoch/);
    assert.match(attachmentUploadScript, /queuedUpload\.viewEpoch !== state\.conversationViewEpoch/);
    const conversationHeaderBeforeMenu = html.match(
      /<div class="conversation-header-actions">[\s\S]*?(?=<div class="mobile-session-actions">)/,
    )?.[0] ?? "";
    const sessionActionsMenuMarkup = html.match(
      /<div id="sessionActionsMenu"[\s\S]*?id="mobileArchivedSessionsBtn"[\s\S]*?<\/div>/,
    )?.[0] ?? "";
    assert.doesNotMatch(conversationHeaderBeforeMenu, /id="(?:private|incognito)ModeToggle"/);
    assert.match(sessionActionsMenuMarkup, /id="privateModeToggle"[\s\S]*?role="menuitemcheckbox"/);
    assert.match(sessionActionsMenuMarkup, /id="incognitoModeToggle"[\s\S]*?role="menuitemcheckbox"/);
    assert.match(sessionActionsMenuMarkup, /id="privacyModeMenuSeparator"/);
    assert.match(inlineScript, /runSessionMenuAction\(togglePrivateMode\)/);
    assert.match(inlineScript, /runSessionMenuAction\(toggleIncognitoMode\)/);
    assert.match(inlineScript, /button:not\(\[hidden\]\):not\(:disabled\)/);
    assert.match(html, /id="incognitoModeToggle"/);
    assert.match(html, /id="incognitoNotice"/);
    assert.match(html, /无痕会话仅保存在 YourChar 内存盘/);
    const incognitoToggleScript = inlineScript.match(
      /async function toggleIncognitoMode[\s\S]*?(?=\n    async function togglePrivateMode)/,
    )?.[0] ?? "";
    assert.match(incognitoToggleScript, /controlPlaneFetch\("\/api\/v1\/incognito-conversations"/);
    assert.match(incognitoToggleScript, /method: "POST"/);
    assert.match(incognitoToggleScript, /普通对话的关系、记忆、角色设定、Skill、见面状态与对话快照/);
    assert.match(incognitoToggleScript, /模型提供商仍可能保留请求/);
    assert.match(incognitoToggleScript, /conversation\.incognito/);
    assert.match(incognitoToggleScript, /const requestId = \+\+state\.incognitoOpenRequestId/);
    assert.match(incognitoToggleScript, /incognitoOpeningScopeMatches\(openingScope\)/);
    assert.match(incognitoToggleScript, /discardReturnedIncognitoConversation\(conversation\)/);
    const privateToggleScript = inlineScript.match(
      /async function togglePrivateMode[\s\S]*?(?=\n\s*async function initializeChat)/,
    )?.[0] ?? "";
    assert.match(privateToggleScript, /state\.privateModeTransitioning = true/);
    assert.match(privateToggleScript, /closeSessionActionsMenu\(\)/);
    assert.match(privateToggleScript, /finally[\s\S]*?state\.privateModeTransitioning = false/);
    const sendMessageScript = inlineScript.match(
      /async function sendMessage\(\)[\s\S]*?(?=\n    async function sendIncognitoMessage)/,
    )?.[0] ?? "";
    assert.match(sendMessageScript, /state\.incognitoTransitioning \|\| state\.privateModeTransitioning/);
    const sessionActionStateScript = inlineScript.match(
      /function updateSessionActionState[\s\S]*?(?=\n    async function renameCurrentSession)/,
    )?.[0] ?? "";
    let activeIncognitoForMenu = true;
    const menuState: Record<string, any> = {
      activeConversationKind: "direct",
      sessionDraft: false,
      incognitoTransitioning: false,
      privateModeTransitioning: false,
      activeSessionId: "incognito-00000000-0000-4000-8000-000000000001",
      activeWorldId: "",
      uiMode: "normal",
      selectedCharacterId: character.id,
      privateInboxRunning: false,
      privateInboxMessages: [],
      busy: false,
    };
    const menuControl = () => ({
      hidden: false,
      disabled: false,
      querySelector() { return { textContent: "" }; },
    });
    const menuNodes: Record<string, any> = {
      renameSessionBtn: menuControl(),
      archiveSessionBtn: menuControl(),
      deleteSessionBtn: menuControl(),
      mobileRenameSessionBtn: menuControl(),
      mobileArchiveSessionBtn: menuControl(),
      mobileDeleteSessionBtn: menuControl(),
      resetWorldConversationBtn: menuControl(),
      privacyModeMenuSeparator: menuControl(),
      sessionActionsMenuBtn: menuControl(),
    };
    const menuContext: Record<string, any> = {
      state: menuState,
      nodes: menuNodes,
      incognitoConversationIsActive: () => activeIncognitoForMenu,
      closeSessionActionsMenu() {},
    };
    new Script(
      sessionActionStateScript + "\nthis.updateSessionActionStateForTest = updateSessionActionState;",
    ).runInNewContext(menuContext);
    menuContext.updateSessionActionStateForTest();
    assert.equal(menuNodes.sessionActionsMenuBtn.hidden, false, "incognito keeps the overflow exit available");
    assert.equal(menuNodes.mobileRenameSessionBtn.hidden, true, "persistent actions stay hidden in incognito");
    activeIncognitoForMenu = false;
    menuState.sessionDraft = true;
    menuState.activeSessionId = "local-draft";
    menuContext.updateSessionActionStateForTest();
    assert.equal(menuNodes.sessionActionsMenuBtn.hidden, false, "a character-bound draft keeps privacy actions available");
    const incognitoDestroyScript = inlineScript.match(
      /async function destroyIncognitoConversation[\s\S]*?(?=\n    function discardIncognitoConversationOnPageHide)/,
    )?.[0] ?? "";
    assert.match(incognitoDestroyScript, /controlPlaneFetch\(/);
    assert.match(incognitoDestroyScript, /method: "DELETE", body: "\{\}"/);
    assert.match(incognitoDestroyScript, /clearConversationSpaceTransientState\(\)/);
    const incognitoPageHideScript = inlineScript.match(
      /function discardIncognitoConversationOnPageHide[\s\S]*?(?=\n    async function restoreConversationAfterIncognito)/,
    )?.[0] ?? "";
    assert.match(incognitoPageHideScript, /controlPlaneFetch\(/);
    assert.match(incognitoPageHideScript, /method: "DELETE", body: "\{\}", keepalive: true/);
    const incognitoRestoreScript = inlineScript.match(
      /async function restoreConversationAfterIncognito[\s\S]*?(?=\n    async function toggleIncognitoMode)/,
    )?.[0] ?? "";
    assert.match(incognitoRestoreScript, /const targetSpace = returnView\.conversationSpace === "secret"/);
    assert.match(incognitoRestoreScript, /await refreshConversationMetadata\(epoch\)/);
    assert.match(incognitoRestoreScript, /sourceArchivedAt/);
    assert.doesNotMatch(incognitoRestoreScript, /openPersistentDirectConversation|direct-conversations|method:\s*"POST"/);
    const applySessionScript = inlineScript.match(
      /async function applySession[\s\S]*?(?=\n    async function applyWorldConversation)/,
    )?.[0] ?? "";
    assert.match(applySessionScript, /!scope\.incognito\) openPrivateInboxEvents/);
    assert.match(applySessionScript, /!scope\.incognito && isConversationVisible/);
    assert.match(retryScript, /incognitoConversationIsActive\(\)/);
    const messageActionChromeScript = inlineScript.match(
      /function renderMessageActions[\s\S]*?(?=\n    function proactiveFeedbackButton)/,
    )?.[0] ?? "";
    assert.match(messageActionChromeScript, /if \(incognitoConversationIsActive\(\)\) return ""/);
    const workspaceAvailabilityScript = inlineScript.match(
      /function updateWorkspaceManagerAvailability[\s\S]*?(?=\n\s*async function loadWorkspaceFiles)/,
    )?.[0] ?? "";
    assert.match(workspaceAvailabilityScript, /!incognitoConversationIsActive\(\)/);
    async function runIncognitoRestoreCase(input: {
      discarded: Record<string, any>;
      sessions: Array<Record<string, any>>;
    }) {
      const restoredSessionIds: string[] = [];
      const refreshedSpaces: string[] = [];
      let drafts = 0;
      const restoreState: Record<string, any> = {
        selectedCharacterId: character.id,
        conversationSpace: "normal",
        conversationSpaceEpoch: 3,
        conversationViewEpoch: 7,
        incognitoTransitioning: false,
        incognitoOpenRequestId: 0,
        sessions: [],
        activeConversationKind: "direct",
        activeSessionId: "",
      };
      const restoreContext: Record<string, any> = {
        state: restoreState,
        nodes: { chatCharacterSelect: { value: "" } },
        updatePrivateModeChrome() {},
        updateWorkspaceManagerAvailability() {},
        updateChatIdentity() {},
        setStatus() {},
        async refreshConversationMetadata() {
          refreshedSpaces.push(restoreState.conversationSpace);
          restoreState.sessions = input.sessions;
        },
        async applySession(session: Record<string, any>) {
          restoredSessionIds.push(session.id);
          restoreState.activeConversationKind = "direct";
          restoreState.activeSessionId = session.id;
        },
        startNewSession() {
          assert.equal(restoreState.incognitoTransitioning, false, "draft is prepared only after restore unlocks");
          drafts += 1;
          restoreState.activeConversationKind = "direct";
          restoreState.activeSessionId = "local-draft";
        },
      };
      new Script(
        incognitoRestoreScript + "\nthis.restoreConversationAfterIncognitoForTest = restoreConversationAfterIncognito;",
      ).runInNewContext(restoreContext);
      await restoreContext.restoreConversationAfterIncognitoForTest(input.discarded);
      return { restoreState, restoredSessionIds, refreshedSpaces, drafts };
    }
    const secretRestore = await runIncognitoRestoreCase({
      discarded: {
        conversation: { characterId: character.id, sourceSessionId: "normal-source" },
        returnView: { conversationSpace: "secret", sessionId: "secret-source" },
      },
      sessions: [{
        id: "secret-source",
        characterId: character.id,
        conversationSpace: "secret",
      }],
    });
    assert.deepEqual(secretRestore.refreshedSpaces, ["secret"]);
    assert.deepEqual(secretRestore.restoredSessionIds, ["secret-source"]);
    assert.equal(secretRestore.drafts, 0);
    const archivedRestore = await runIncognitoRestoreCase({
      discarded: {
        conversation: {
          characterId: character.id,
          sourceSessionId: "archived-normal-source",
          sourceArchived: true,
        },
        returnView: { conversationSpace: "normal", sessionId: "archived-normal-source" },
      },
      sessions: [{
        id: "archived-normal-source",
        characterId: character.id,
        conversationSpace: "normal",
      }],
    });
    assert.deepEqual(archivedRestore.restoredSessionIds, [], "an archived source is never reopened");
    assert.equal(archivedRestore.drafts, 1);
    const deletedRestore = await runIncognitoRestoreCase({
      discarded: {
        conversation: { characterId: character.id, sourceSessionId: "deleted-normal-source" },
        returnView: { conversationSpace: "normal", sessionId: "deleted-normal-source" },
      },
      sessions: [],
    });
    assert.deepEqual(deletedRestore.restoredSessionIds, []);
    assert.equal(deletedRestore.drafts, 1, "a source deleted in another tab returns to a local draft");
    let resolveIncognitoDelete: (value: unknown) => void = () => undefined;
    const incognitoDeleteResponse = new Promise((resolve) => { resolveIncognitoDelete = resolve; });
    const destroyState: Record<string, any> = {
      incognitoConversation: {
        id: "incognito-session",
        characterId: character.id,
        incognito: true,
      },
      incognitoReturnView: { sessionId: "normal-session" },
      incognitoTransitioning: false,
      incognitoAbortController: { abort() {} },
      conversationSpace: "normal",
      conversationSpaceEpoch: 2,
      conversationViewEpoch: 5,
      selectedCharacterId: character.id,
      messages: [{ text: "must disappear" }],
    };
    const incognitoDeleteRequests: Array<{ path: string; options: Record<string, unknown> }> = [];
    let incognitoClears = 0;
    const destroyContext: Record<string, any> = {
      state: destroyState,
      nodes: { chatCharacterSelect: { value: "" } },
      controlPlaneFetch(path: string, options: Record<string, unknown>) {
        incognitoDeleteRequests.push({ path, options });
        return incognitoDeleteResponse;
      },
      updatePrivateModeChrome() {},
      setStatus() {},
      clearConversationSpaceTransientState() {
        incognitoClears += 1;
        destroyState.messages = [];
        destroyState.conversationViewEpoch += 1;
      },
      updateWorkspaceManagerAvailability() {},
      updateChatIdentity() {},
    };
    new Script(
      incognitoDestroyScript + "\nthis.destroyIncognitoConversationForTest = destroyIncognitoConversation;",
    ).runInNewContext(destroyContext);
    const destroyingIncognito = destroyContext.destroyIncognitoConversationForTest();
    assert.equal(incognitoDeleteRequests[0]?.path, "/api/v1/incognito-conversations/incognito-session");
    assert.equal(incognitoDeleteRequests[0]?.options.method, "DELETE");
    assert.equal(destroyState.messages.length, 1, "the DELETE is initiated before replacing the view");
    resolveIncognitoDelete({ ok: true, status: 204 });
    const discardedIncognito = await destroyingIncognito;
    assert.equal(discardedIncognito.conversation.id, "incognito-session");
    assert.equal(destroyState.incognitoConversation, null);
    assert.equal(destroyState.messages.length, 0, "leaving synchronously clears the discarded transcript");
    assert.equal(incognitoClears, 1);

    let resolveIncognitoCreate: (value: Record<string, any>) => void = () => undefined;
    const incognitoCreateResponse = new Promise<Record<string, any>>((resolve) => {
      resolveIncognitoCreate = resolve;
    });
    const openingState: Record<string, any> = {
      activeConversationKind: "direct",
      activeSessionId: "normal-a",
      activeWorldId: "",
      activeGroupId: "",
      conversationSpace: "normal",
      conversationSpaceEpoch: 4,
      conversationViewEpoch: 8,
      selectedCharacterId: character.id,
      sessionDraft: false,
      sessions: [{ id: "normal-a", characterId: character.id }],
      incognitoConversation: null,
      incognitoReturnView: null,
      incognitoTransitioning: false,
      incognitoOpenRequestId: 0,
    };
    const openingRequests: Array<{ path: string; options: Record<string, any> }> = [];
    const openingStatuses: string[] = [];
    let openingClears = 0;
    let openingApplies = 0;
    const openingContext: Record<string, any> = {
      state: openingState,
      nodes: { chatCharacterSelect: { value: character.id } },
      conversationSpaceIdle() { return !openingState.incognitoTransitioning; },
      incognitoConversationIsActive() { return false; },
      async openActionDialog() { return true; },
      captureIncognitoOpeningScope(requestId: number, characterId: string) {
        return {
          requestId,
          spaceEpoch: openingState.conversationSpaceEpoch,
          viewEpoch: openingState.conversationViewEpoch,
          conversationSpace: openingState.conversationSpace,
          conversationKind: openingState.activeConversationKind,
          sessionId: openingState.activeSessionId,
          worldId: openingState.activeWorldId,
          groupId: openingState.activeGroupId,
          characterId,
        };
      },
      incognitoOpeningScopeMatches(scope: Record<string, any>) {
        return scope.requestId === openingState.incognitoOpenRequestId &&
          scope.spaceEpoch === openingState.conversationSpaceEpoch &&
          scope.viewEpoch === openingState.conversationViewEpoch &&
          scope.sessionId === openingState.activeSessionId &&
          scope.characterId === openingState.selectedCharacterId;
      },
      incognitoActivationMatches() { return false; },
      async controlPlaneFetch(path: string, options: Record<string, any>) {
        openingRequests.push({ path, options });
        if (options.method === "POST") return incognitoCreateResponse;
        return { ok: true, status: 204, async json() { return {}; } };
      },
      async discardReturnedIncognitoConversation(conversation: Record<string, any>) {
        await openingContext.controlPlaneFetch(
          "/api/v1/incognito-conversations/" + encodeURIComponent(conversation.id),
          { method: "DELETE", body: "{}" },
        );
      },
      updatePrivateModeChrome() {},
      updateWorkspaceManagerAvailability() {},
      clearConversationSpaceTransientState() { openingClears += 1; },
      async applySession() { openingApplies += 1; },
      setStatus(message: string) { openingStatuses.push(message); },
    };
    new Script(
      incognitoToggleScript + "\nthis.toggleIncognitoModeForTest = toggleIncognitoMode;",
    ).runInNewContext(openingContext);
    const lateOpening = openingContext.toggleIncognitoModeForTest();
    while (!openingRequests.some((request) => request.options.method === "POST")) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    openingState.conversationViewEpoch += 1;
    openingState.activeSessionId = "normal-b";
    openingState.selectedCharacterId = "character-b";
    resolveIncognitoCreate({
      ok: true,
      status: 201,
      async json() {
        return {
          conversation: {
            id: "late-incognito",
            characterId: character.id,
            conversationSpace: "normal",
            incognito: true,
          },
        };
      },
    });
    await lateOpening;
    assert.equal(openingClears, 0, "a late POST never replaces the newer conversation view");
    assert.equal(openingApplies, 0);
    assert.equal(openingState.activeSessionId, "normal-b");
    assert.equal(openingState.selectedCharacterId, "character-b");
    const lateDelete = openingRequests.find((request) => request.options.method === "DELETE");
    assert.equal(lateDelete?.path, "/api/v1/incognito-conversations/late-incognito");
    assert.equal(lateDelete?.options.body, "{}");
    assert.equal(openingStatuses.includes("无痕会话已开启；退出或重启后内容会丢弃"), false);

    const incognitoRecoveryScript = inlineScript.match(
      /async function recoverIncognitoConversation[\s\S]*?(?=\n    async function togglePrivateMode)/,
    )?.[0] ?? "";
    assert.match(incognitoRecoveryScript, /fetch\("\/api\/v1\/incognito-conversations", \{ credentials: "same-origin" \}\)/);
    assert.match(incognitoRecoveryScript, /incognitoOpeningScopeMatches\(openingScope\)/);
    const initializeChatScript = inlineScript.match(
      /async function initializeChat[\s\S]*?(?=\n    async function refreshConversationMetadata)/,
    )?.[0] ?? "";
    assert.match(
      initializeChatScript,
      /await loadCharacters\(\)[\s\S]*?await recoverIncognitoConversation\(\)[\s\S]*?if \(!recoveredIncognito\)[\s\S]*?await loadSessions\(\)/,
    );
    const initializationCalls: string[] = [];
    const initializeContext: Record<string, any> = {
      async loadModelProfiles() { initializationCalls.push("models"); },
      async loadMeetingPresetCatalog() { initializationCalls.push("presets"); },
      async loadUserAvatarState() { initializationCalls.push("avatar"); },
      async loadCharacters() { initializationCalls.push("characters"); },
      async recoverIncognitoConversation() {
        initializationCalls.push("recover");
        return true;
      },
      async loadSessions() { initializationCalls.push("sessions"); },
      async pollIncomingMessages() { initializationCalls.push("poll"); },
    };
    new Script(
      initializeChatScript + "\nthis.initializeChatForTest = initializeChat;",
    ).runInNewContext(initializeContext);
    await initializeContext.initializeChatForTest();
    assert.ok(initializationCalls.indexOf("characters") < initializationCalls.indexOf("recover"));
    assert.equal(initializationCalls.includes("sessions"), false, "active overlay skips persistent session loading");
    assert.equal(initializationCalls.includes("poll"), false, "active overlay skips persistent unread polling");
    const recoveryState: Record<string, any> = {
      incognitoConversation: null,
      incognitoReturnView: null,
      incognitoTransitioning: false,
      incognitoOpenRequestId: 0,
      activeConversationKind: "direct",
      activeSessionId: "normal-source",
      activeWorldId: "",
      activeGroupId: "",
      conversationSpace: "normal",
      conversationSpaceEpoch: 2,
      conversationViewEpoch: 3,
      selectedCharacterId: character.id,
      sessions: [],
    };
    const recoveredConversation: Record<string, any> = {
      id: "recovered-incognito",
      characterId: character.id,
      conversationSpace: "normal",
      incognito: true,
      sourceSessionId: "normal-source",
    };
    const recoveryFetches: Array<{ path: string; options: Record<string, any> }> = [];
    const recoveryApplies: string[] = [];
    const recoveryContext: Record<string, any> = {
      state: recoveryState,
      nodes: { chatCharacterSelect: { value: "" } },
      captureIncognitoOpeningScope(requestId: number) {
        return {
          requestId,
          spaceEpoch: recoveryState.conversationSpaceEpoch,
          viewEpoch: recoveryState.conversationViewEpoch,
          conversationSpace: recoveryState.conversationSpace,
          conversationKind: recoveryState.activeConversationKind,
          sessionId: recoveryState.activeSessionId,
          worldId: recoveryState.activeWorldId,
          groupId: recoveryState.activeGroupId,
          characterId: recoveryState.selectedCharacterId,
        };
      },
      incognitoOpeningScopeMatches(scope: Record<string, any>) {
        return scope.requestId === recoveryState.incognitoOpenRequestId &&
          scope.spaceEpoch === recoveryState.conversationSpaceEpoch &&
          scope.viewEpoch === recoveryState.conversationViewEpoch &&
          scope.sessionId === recoveryState.activeSessionId;
      },
      incognitoActivationMatches(requestId: number, conversationId: string, characterId: string) {
        return requestId === recoveryState.incognitoOpenRequestId &&
          recoveryState.incognitoConversation?.id === conversationId &&
          recoveryState.activeSessionId === conversationId &&
          recoveryState.selectedCharacterId === characterId;
      },
      async fetch(path: string, options: Record<string, any>) {
        recoveryFetches.push({ path, options });
        return {
          ok: true,
          async json() { return { conversations: [recoveredConversation] }; },
        };
      },
      clearConversationSpaceTransientState() {
        recoveryState.conversationViewEpoch += 1;
        recoveryState.activeSessionId = "";
        recoveryState.sessions = [];
      },
      updatePrivateModeChrome() {},
      updateWorkspaceManagerAvailability() {},
      async applySession(conversation: Record<string, any>) {
        recoveryApplies.push(conversation.id);
        recoveryState.activeConversationKind = "direct";
        recoveryState.activeSessionId = conversation.id;
      },
      async discardReturnedIncognitoConversation() {
        assert.fail("a current recovery must not discard the active overlay");
      },
      setStatus() {},
    };
    new Script(
      incognitoRecoveryScript + "\nthis.recoverIncognitoConversationForTest = recoverIncognitoConversation;",
    ).runInNewContext(recoveryContext);
    assert.equal(await recoveryContext.recoverIncognitoConversationForTest(), true);
    assert.equal(recoveryFetches.length, 1);
    assert.equal(recoveryFetches[0]?.path, "/api/v1/incognito-conversations");
    assert.equal(recoveryFetches[0]?.options.credentials, "same-origin");
    assert.deepEqual(recoveryApplies, ["recovered-incognito"]);
    assert.equal(recoveryState.incognitoConversation.id, "recovered-incognito");
    assert.equal(recoveryState.incognitoReturnView.conversationSpace, "normal");
    assert.equal(recoveryState.incognitoReturnView.sessionId, "normal-source");
    assert.equal(recoveryState.incognitoTransitioning, false);
    recoveredConversation.sourceArchived = true;
    recoveryState.incognitoConversation = null;
    recoveryState.incognitoReturnView = null;
    recoveryState.incognitoTransitioning = false;
    recoveryState.activeConversationKind = "direct";
    recoveryState.activeSessionId = "normal-source";
    recoveryState.conversationSpace = "normal";
    recoveryState.sessions = [];
    assert.equal(await recoveryContext.recoverIncognitoConversationForTest(), true);
    assert.equal(recoveryState.incognitoReturnView.sessionId, "");
    assert.equal(recoveryState.incognitoReturnView.sessionDraft, true);

    assert.match(directRefreshScript, /const sharedStateEnabled = requestedSpace === "normal" && !scope\.incognito/);
    assert.match(directRefreshScript, /scope\.incognito\s*\? Promise\.resolve\(null\)[\s\S]*?\/inbox/);
    assert.match(directRefreshScript, /if \(scope\.incognito\)[\s\S]*?message\.attachments = \[\]/);
    const incognitoSendScript = inlineScript.match(
      /async function sendIncognitoMessage[\s\S]*?(?=\n    async function sendWorldChatMessage)/,
    )?.[0] ?? "";
    assert.match(incognitoSendScript, /\/messages\/stream/);
    assert.doesNotMatch(incognitoSendScript, /\/inbox/);
    assert.match(incognitoSendScript, /directConversationScopeMatches\(scope\)/);
    let releaseIncognitoStream = () => undefined;
    let incognitoStreamReady = false;
    let streamedIncognitoUrl = "";
    const streamedIncognitoBodies: Array<Record<string, any>> = [];
    let appliedIncognitoEvents = 0;
    let refreshedIncognitoMessages = 0;
    const streamState: Record<string, any> = {
      activeConversationKind: "direct",
      activeSessionId: "incognito-session",
      conversationSpace: "normal",
      conversationSpaceEpoch: 4,
      conversationViewEpoch: 9,
      selectedCharacterId: character.id,
      busy: false,
      lastTurnStatus: null,
      lastTurnCanRetry: false,
      incognitoAbortController: null,
      messages: [],
    };
    const streamScope = {
      sessionId: "incognito-session",
      characterId: character.id,
      conversationSpace: "normal",
      incognito: true,
      spaceEpoch: 4,
      viewEpoch: 9,
    };
    const streamContext: Record<string, any> = {
      state: streamState,
      nodes: {
        textInput: { value: "", focus() {} },
        sendBtn: { disabled: false },
        cancelMessageBtn: { disabled: true },
      },
      AbortController: class {
        signal = {};
        abort() {}
      },
      captureDirectConversationScope() { return streamScope; },
      directConversationScopeMatches(scope: Record<string, any>) {
        return scope.viewEpoch === streamState.conversationViewEpoch &&
          scope.sessionId === streamState.activeSessionId;
      },
      generateClientMessageId() { return "client-id"; },
      closeEmojiPicker() {},
      pushMessage(role: string, text: string, extra: Record<string, any>) {
        streamState.messages.push({ role, text, ...extra });
      },
      ensurePrivateBurstMessage() { return 1; },
      renderMessages() {},
      updateInteractionChrome() {},
      updatePrivateModeChrome() {},
      setStatus() {},
      async fetch(path: string, options: Record<string, any>) {
        streamedIncognitoUrl = path;
        streamedIncognitoBodies.push(JSON.parse(options.body));
        return { ok: true, body: {} };
      },
      consumeEventStream(_body: unknown, onEvent: (event: Record<string, any>) => void) {
        return new Promise<void>((resolve) => {
          incognitoStreamReady = true;
          releaseIncognitoStream = () => {
            onEvent({ type: "delta", delta: "must not leak" });
            onEvent({ type: "done", response: { reply: "must not leak", status: "completed" } });
            resolve();
          };
        });
      },
      applyPrivateAgentEvent() { appliedIncognitoEvents += 1; },
      finishPrivateBurst() { appliedIncognitoEvents += 1; },
      applyTurnOutcome() { appliedIncognitoEvents += 1; },
      async refreshSessionMessages() { refreshedIncognitoMessages += 1; },
      privateBurstIndex() { return -1; },
      updateDirectGenerationControls() {},
    };
    new Script(
      incognitoSendScript + "\nthis.sendIncognitoMessageForTest = sendIncognitoMessage;",
    ).runInNewContext(streamContext);
    const staleIncognitoSend = streamContext.sendIncognitoMessageForTest("hello");
    while (!incognitoStreamReady) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(streamedIncognitoUrl, "/api/v1/sessions/incognito-session/messages/stream");
    assert.equal(streamedIncognitoBodies[0]?.conversationSpace, "normal");
    assert.deepEqual(streamedIncognitoBodies[0]?.attachments, []);
    streamState.conversationViewEpoch += 1;
    releaseIncognitoStream();
    await staleIncognitoSend;
    assert.equal(appliedIncognitoEvents, 0, "a late incognito stream cannot refill a replacement view");
    assert.equal(refreshedIncognitoMessages, 0);
    assert.match(html, /YourChar/);
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
    assert.match(html, /id="imSettingsTabBtn"/);
    assert.match(html, /id="imSettingsPanel"/);
    assert.match(html, /仅普通模式 · 单主人私聊/);
    assert.match(html, /微信与飞书/);
    assert.match(html, /data-im-character/);
    assert.match(html, /id="imQrDialog"/);
    assert.match(html, /id="imVerifyForm"/);
    assert.match(html, /处理时显示“正在输入”/);
    assert.match(html, /function loadImSettingsView/);
    assert.match(html, /function deactivateImSettingsView/);
    assert.match(html, /function imViewIsCurrent/);
    assert.match(html, /state\.imViewEpoch === epoch/);
    assert.match(html, /requestId !== state\.imRouteRequestIds\[provider\]/);
    assert.match(html, /sessionId !== state\.imBindingSession\?\.id/);
    assert.match(html, /PATCH[\s\S]*?characterId: characterId \|\| null/);
    assert.match(html, /\/api\/v1\/im\/channels\/" \+ provider/);
    assert.match(html, /\/api\/v1\/im\/bindings\/" \+ provider \+ "\/qr/);
    assert.match(html, /\/api\/v1\/im\/binding-sessions\/" \+ encodeURIComponent\(session\.id\) \+ "\/verify/);
    assert.match(html, /function safeImQrCodeUrl/);
    assert.match(html, /parsed\.protocol === "https:"/);
    const imUiScript = html.match(/function imViewIsCurrent\(epoch\)[\s\S]*?function controlPlaneFetch/)?.[0] ?? "";
    assert.match(imUiScript, /controlPlaneFetch\("\/api\/v1\/im\/settings"/);
    assert.match(imUiScript, /controlPlaneFetch\("\/api\/v1\/im\/channels\/" \+ provider/);
    assert.match(imUiScript, /controlPlaneFetch\("\/api\/v1\/im\/bindings\/" \+ provider \+ "\/qr"/);
    assert.match(imUiScript, /controlPlaneFetch\("\/api\/v1\/im\/binding-sessions\/" \+ encodeURIComponent\(session\.id\) \+ "\/verify"/);
    assert.match(imUiScript, /controlPlaneFetch\("\/api\/v1\/im\/binding-sessions\/" \+ encodeURIComponent\(session\.id\) \+ "\/cancel"/);
    assert.match(imUiScript, /controlPlaneFetch\("\/api\/v1\/im\/bindings\/" \+ provider, \{ method: "DELETE"/);
    assert.match(imUiScript, /cancelImBindingSessionBestEffort/);
    assert.match(html, /controlPlaneFetch\("\/api\/v1\/data", \{/);
    assert.match(html, /id="apiModel"/);
    assert.match(html, /id="apiContextWindowTokens"/);
    assert.match(html, /id="apiReasoningEffort"/);
    assert.match(html, /<option value="">自动（推荐）<\/option>/);
    assert.match(html, /<option value="none">关闭<\/option>/);
    assert.match(html, /<option value="minimal">最低<\/option>/);
    assert.match(html, /<option value="low">低<\/option>/);
    assert.match(html, /<option value="medium">中<\/option>/);
    assert.match(html, /<option value="high">高<\/option>/);
    assert.match(html, /<option value="xhigh">极高<\/option>/);
    assert.match(html, /<option value="max">最大（max）<\/option>/);
    assert.match(html, /<option value="ultra">超强（ultra）<\/option>/);
    assert.match(html, /仅支持 reasoning_effort 的兼容 API 生效；不支持时可能返回参数错误/);
    assert.match(html, /nodes\.apiReasoningEffort\.value = config\.reasoningEffort \|\| ""/);
    assert.match(html, /reasoningEffort: nodes\.apiReasoningEffort\.value \|\| null/);
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
    assert.match(html, /function collaborationElapsedLabel/);
    assert.match(html, /协作耗时/);
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
    assert.match(html, /计划整理阈值/);
    assert.match(html, /紧急保护阈值/);
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
    assert.match(html, /协作介绍/);
    assert.match(html, /特点标签/);
    assert.match(html, /协作与技能/);
    assert.match(html, /id="characterOwnedSkillList"/);
    assert.match(html, /id="newCharacterOwnedSkillBtn"/);
    assert.match(html, /id="characterOwnedSkillDialog"/);
    assert.match(html, /执行后生成改进提案/);
    assert.match(html, /id="characterOwnedSkillsTitle">专属工作法/);
    assert.match(html, /id="characterSkillPackagesTitle">扩展 Skill 包/);
    assert.match(html, /普通角色会话可自行下载、安装并启用扩展包，无需逐次确认/);
    assert.match(html, /私密空间只能查看和管理已安装包/);
    assert.match(html, /私密会话不能远程安装，可管理已有包与本地工作法/);
    assert.doesNotMatch(html, /id="characterSkillPackageStageList"/);
    assert.match(html, /id="inspectCharacterSkillPackageBtn"[^>]*>查看安装内容<\/button>/);
    assert.match(html, /id="removeCharacterSkillPackageBtn"[^>]*>移除<\/button>/);
    assert.match(html, /id="characterSkillPackageManifest"/);
    assert.match(html, /id="characterSkillPackageMarkdown"/);
    assert.match(html, /安装后的本机只读审计记录/);
    assert.match(html, /不会改变启用状态/);
    assert.match(html, /来源 URL 可能含敏感路径，请勿直接分享/);
    assert.match(html, /function renderCharacterOwnedSkills/);
    assert.match(html, /function reviewCharacterOwnedSkillProposal/);
    assert.match(html, /controlPlaneFetch\(withConversationSpace\(/);
    assert.match(html, /id="characterFunctionAdvanced"/);
    assert.match(html, /function loadCharacterFunction/);
    assert.match(html, /function saveCharacterFunction/);
    assert.match(html, /collaboration-profile/);
    const characterSkillPackageScript = inlineScript.match(
      /function clearCharacterSkillPackageState\(\)[\s\S]*?(?=\n    async function loadCharacterFunction)/,
    )?.[0] ?? "";
    assert.match(characterSkillPackageScript, /\/skill-packages/);
    assert.match(characterSkillPackageScript, /fetch\(characterSkillPackageUrl\(scope\)\)/);
    assert.match(characterSkillPackageScript, /controlPlaneFetch\(characterSkillPackageUrl/);
    assert.match(characterSkillPackageScript, /method: "PATCH"/);
    assert.match(characterSkillPackageScript, /enabled: !entry\.enabled/);
    assert.match(characterSkillPackageScript, /个已安装 · /);
    assert.doesNotMatch(characterSkillPackageScript, /\/skill-package-stages|data-stage-action/);
    const inspectCharacterSkillPackageScript = inlineScript.match(
      /async function inspectCharacterSkillPackage\(\)[\s\S]*?(?=\n    async function toggleCharacterSkillPackage)/,
    )?.[0] ?? "";
    assert.match(inspectCharacterSkillPackageScript, /encodeURIComponent\(packageName\) \+ "\/review"/);
    assert.match(inspectCharacterSkillPackageScript, /method: "POST"/);
    assert.match(inspectCharacterSkillPackageScript, /name: packageName/);
    assert.match(inspectCharacterSkillPackageScript, /characterId: scope\.characterId/);
    assert.match(inspectCharacterSkillPackageScript, /conversationSpace: scope\.conversationSpace/);
    assert.match(inspectCharacterSkillPackageScript, /characterSkillPackageScopeIsCurrent\(scope\)/);
    assert.match(inspectCharacterSkillPackageScript, /state\.selectedCharacterSkillPackageName !== packageName/);
    assert.match(characterSkillPackageScript, /characterSkillPackageMarkdown\.textContent/);
    assert.match(characterSkillPackageScript, /\["Manifest 摘要", detail\.digest/);
    assert.match(characterSkillPackageScript, /\["归档摘要", detail\.archiveSha256/);
    assert.match(characterSkillPackageScript, /\["安装时间", detail\.createdAt/);
    assert.match(characterSkillPackageScript, /\["解析归档", source\.resolvedArchiveUrl/);
    assert.match(characterSkillPackageScript, /\["最终归档", source\.finalArchiveUrl/);
    assert.match(characterSkillPackageScript, /escapeHtml\(entry\.path \|\| ""\)/);
    assert.match(characterSkillPackageScript, /escapeHtml\(entry\.sha256 \|\| ""\)/);
    assert.doesNotMatch(
      characterSkillPackageScript,
      /renderMarkdown\([^)]*skillMarkdown|characterSkillPackageMarkdown\.innerHTML/,
    );
    const removeCharacterSkillPackageScript = inlineScript.match(
      /async function removeCharacterSkillPackage\(\)[\s\S]*?(?=\n    async function loadCharacterFunction)/,
    )?.[0] ?? "";
    assert.match(removeCharacterSkillPackageScript, /if \(entry\.enabled\)/);
    assert.match(removeCharacterSkillPackageScript, /window\.confirm\(/);
    assert.match(removeCharacterSkillPackageScript, /method: "DELETE"/);
    assert.match(removeCharacterSkillPackageScript, /name: entry\.name/);
    assert.match(removeCharacterSkillPackageScript, /digest: entry\.digest/);
    assert.match(removeCharacterSkillPackageScript, /characterId: scope\.characterId/);
    assert.match(removeCharacterSkillPackageScript, /conversationSpace: scope\.conversationSpace/);
    assert.match(removeCharacterSkillPackageScript, /characterSkillPackageScopeIsCurrent\(scope\)/);
    assert.match(characterSkillPackageScript, /removeCharacterSkillPackageBtn\.disabled = Boolean\(detail\.enabled\)/);
    const hostileSkillMarkdown = "</pre><script>globalThis.__characterSkillXss = true</script>";
    const hostileManifestPath = "references/<img src=x onerror=manifest_xss>.md";
    const auditMarkdownNode = { textContent: "", innerHTML: "must-not-change" };
    const auditManifestNode = { innerHTML: "" };
    const auditContext: Record<string, any> = {
      state: {
        characterSkillPackages: [{
          name: "hostile-skill",
          description: "inspection fixture",
          enabled: true,
          integrity: "verified",
          conversationSpace: "normal",
          sourceHost: "skills.example.com",
          digest: "manifest-digest",
          fileCount: 1,
          createdAt: "2026-08-27T01:00:00.000Z",
          updatedAt: "2026-08-27T02:00:00.000Z",
        }],
        selectedCharacterSkillPackageName: "hostile-skill",
        characterSkillPackageDetailData: {
          name: "hostile-skill",
          description: "inspection fixture",
          enabled: true,
          integrity: "verified",
          conversationSpace: "normal",
          sourceHost: "skills.example.com",
          digest: "manifest-digest",
          archiveSha256: "archive-digest",
          createdAt: "2026-08-27T01:00:00.000Z",
          updatedAt: "2026-08-27T02:00:00.000Z",
          skillMarkdown: hostileSkillMarkdown,
          manifest: [{ path: hostileManifestPath, size: 12, sha256: "<digest>" }],
        },
      },
      nodes: {
        characterSkillPackageDetail: { hidden: true },
        characterSkillPackageInspection: { hidden: true },
        characterSkillPackageName: { textContent: "" },
        characterSkillPackageDescription: { textContent: "" },
        characterSkillPackageMeta: { textContent: "" },
        inspectCharacterSkillPackageBtn: { textContent: "" },
        toggleCharacterSkillPackageBtn: { textContent: "" },
        removeCharacterSkillPackageBtn: { disabled: false, title: "" },
        characterSkillPackageSummary: { innerHTML: "" },
        characterSkillPackageManifest: auditManifestNode,
        characterSkillPackageMarkdown: auditMarkdownNode,
      },
      escapeHtml(value: unknown) {
        const replacements: Record<string, string> = {
          "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
        };
        return String(value).replace(/[&<>"']/gu, (character) => replacements[character]);
      },
      formatFileSize() { return "12 B"; },
      formatTraceTime(value: string) { return value; },
    };
    new Script(
      characterSkillPackageScript +
      "\nthis.renderCharacterSkillPackageDetailForTest = renderCharacterSkillPackageDetail;",
    ).runInNewContext(auditContext);
    auditContext.renderCharacterSkillPackageDetailForTest();
    assert.equal(auditMarkdownNode.textContent, hostileSkillMarkdown);
    assert.equal(auditMarkdownNode.innerHTML, "must-not-change");
    assert.match(auditManifestNode.innerHTML, /&lt;img src=x onerror=manifest_xss&gt;/u);
    assert.doesNotMatch(auditManifestNode.innerHTML, /<img/u);
    const characterSkillScopeScript = inlineScript.match(
      /function captureCharacterSkillPackageScope[\s\S]*?(?=\n    function characterSkillPackageUrl)/,
    )?.[0] ?? "";
    assert.match(characterSkillScopeScript, /scope\.requestId === state\.characterSkillPackageRequestId/);
    assert.match(characterSkillScopeScript, /scope\.spaceEpoch === state\.conversationSpaceEpoch/);
    assert.match(characterSkillScopeScript, /scope\.viewEpoch === state\.conversationViewEpoch/);
    assert.match(characterSkillScopeScript, /scope\.sessionId === state\.activeSessionId/);
    assert.match(characterSkillScopeScript, /scope\.characterId === state\.workspaceCharacterId/);
    assert.match(characterSkillScopeScript, /scope\.conversationSpace === state\.conversationSpace/);
    const characterSkillScopeState: Record<string, any> = {
      workspaceCharacterId: character.id,
      selectedCharacterId: character.id,
      conversationSpace: "secret",
      conversationSpaceEpoch: 4,
      conversationViewEpoch: 9,
      activeSessionId: "character-skill-session-a",
      characterSkillPackageRequestId: 6,
      uiMode: "characters",
      characterTab: "capabilities",
    };
    const characterSkillScopeContext: Record<string, any> = {
      state: characterSkillScopeState,
      captureCharacterWorkspaceScope() {
        return {
          characterId: characterSkillScopeState.workspaceCharacterId,
          conversationSpace: characterSkillScopeState.conversationSpace,
        };
      },
    };
    new Script(
      characterSkillScopeScript +
      "\nthis.captureCharacterSkillPackageScopeForTest = captureCharacterSkillPackageScope;" +
      "\nthis.characterSkillPackageScopeIsCurrentForTest = characterSkillPackageScopeIsCurrent;",
    ).runInNewContext(characterSkillScopeContext);
    const currentCharacterSkillScope =
      characterSkillScopeContext.captureCharacterSkillPackageScopeForTest(6);
    assert.equal(
      characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope),
      true,
    );
    characterSkillScopeState.characterSkillPackageRequestId += 1;
    assert.equal(characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope), false);
    characterSkillScopeState.characterSkillPackageRequestId = 6;
    characterSkillScopeState.conversationSpace = "normal";
    assert.equal(
      characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope),
      false,
      "a private Skill audit response cannot cross into the normal space",
    );
    characterSkillScopeState.conversationSpace = "secret";
    characterSkillScopeState.conversationSpaceEpoch += 1;
    assert.equal(characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope), false);
    characterSkillScopeState.conversationSpaceEpoch = 4;
    characterSkillScopeState.conversationViewEpoch += 1;
    assert.equal(characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope), false);
    characterSkillScopeState.conversationViewEpoch = 9;
    characterSkillScopeState.activeSessionId = "character-skill-session-b";
    assert.equal(characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope), false);
    characterSkillScopeState.activeSessionId = "character-skill-session-a";
    characterSkillScopeState.workspaceCharacterId = "another-character";
    assert.equal(characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope), false);
    characterSkillScopeState.workspaceCharacterId = character.id;
    characterSkillScopeState.selectedCharacterId = "another-character";
    assert.equal(characterSkillScopeContext.characterSkillPackageScopeIsCurrentForTest(currentCharacterSkillScope), false);
    assert.doesNotMatch(html, /function-profile/);
    assert.doesNotMatch(html, /skill-versions/);
    assert.doesNotMatch(html, /自动更新档案/);
    assert.doesNotMatch(html, /id="characterCapabilityList"/);
    assert.match(html, /id="characterLifePanel"/);
    assert.match(html, /id="lifeProactiveCooldown"/);
    assert.match(html, /id="lifeSocialEnabled"/);
    assert.match(html, /id="lifeSocialDailyLimit"/);
    assert.match(html, /id="lifeSocialCooldown"/);
    assert.match(html, /id="lifeProactiveList"/);
    assert.match(html, /id="lifeTopicPolicyList"/);
    assert.match(html, /id="lifeWorldAttributeList"/);
    assert.match(html, /id="saveLifeWorldAttributesBtn"/);
    assert.match(html, /id="worldAttributesSection"/);
    assert.match(html, /id="worldAttributeForm"/);
    assert.match(html, /id="worldAttributeScope"/);
    assert.match(html, /id="saveWorldSharedAttributesBtn"/);
    assert.match(html, /id="worldAttributeAnalysisEnabled"/);
    assert.match(html, /id="worldAttributeIncreaseRule"/);
    assert.match(html, /id="worldAttributeIncreaseDelta"/);
    assert.match(html, /id="worldAttributeDecreaseRule"/);
    assert.match(html, /id="worldAttributeDecreaseDelta"/);
    assert.match(html, /function saveWorldAttribute/);
    assert.match(html, /function saveWorldSharedAttributes/);
    assert.match(html, /function saveLifeWorldAttributes/);
    assert.match(html, /每次固定增加/);
    assert.match(html, /每次固定减少/);
    assert.match(html, /controlPlaneFetch\(\s*"\/api\/v1\/characters\/" \+ encodeURIComponent\(state\.workspaceCharacterId\) \+ "\/life\/attributes"/);
    assert.match(html, /"\/api\/v1\/world-attributes\/" \+ encodeURIComponent\(editing\)/);
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
    assert.match(html, /角色 Skill 自主管理/);
    assert.match(html, /自行选择公开 HTTPS 来源并下载安装/);
    assert.match(html, /远端暴露目标主机和路径/);
    assert.match(html, /请勿在 URL 或普通空间内容中放入秘密/);
    assert.match(html, /私密会话不能远程安装，但仍可创建、修订本地工作法并管理已安装包/);
    assert.match(html, /无痕会话只使用只读冻结快照，不能进行任何 Skill 管理/);
    assert.match(html, /角色私有 Skill 或角色自建工作法/);
    assert.match(html, /停用相关项并进入下一安全回合/);
    assert.match(html, /id="characterSkillManagePermissionInput"[^>]+data-permission="characterSkillManageEnabled"/);
    assert.match(html, /id="characterSkillManagePermissionLabel">已关闭/);
    assert.match(html, /permissions\.characterSkillManageEnabled/);
    assert.match(html, /偏好已开启 · 当前隔离/);
    assert.match(html, /这是网络偏好/);
    assert.match(html, /实际网络仍会被拒绝/);
    const permissionPatchScript = inlineScript.match(
      /async function patchAgentPermissions\(patch\)[\s\S]*?(?=\n    function renderAgentModules)/,
    )?.[0] ?? "";
    assert.match(
      permissionPatchScript,
      /controlPlaneFetch\("\/api\/v1\/agent-permissions", \{[\s\S]*?method: "PATCH"/,
    );
    assert.doesNotMatch(permissionPatchScript, /fetch\("\/api\/v1\/agent-permissions"/);
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
    assert.match(html, /\/assets\/twemoji\.min\.js/);
    assert.match(html, /callback: \(icon\) => "\/assets\/twemoji\/svg\/" \+ icon \+ "\.svg"/);
    assert.match(html, /renderTwemoji\(template\.content\)/);
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
    assert.match(html, /id="privateModeToggle"/);
    assert.match(html, /conversationSpace: "normal"/);
    assert.match(html, /conversationSpaceEpoch: 0/);
    assert.match(html, /function togglePrivateMode/);
    assert.match(html, /function clearConversationSpaceTransientState/);
    const clearConversationSpaceScript = html.match(
      /function clearConversationSpaceTransientState\(\)[\s\S]*?async function togglePrivateMode/,
    )?.[0] ?? "";
    assert.match(clearConversationSpaceScript, /nodes\.moduleDetailDialog\.open/);
    assert.match(clearConversationSpaceScript, /nodes\.moduleDetailContent\.innerHTML = ""/);
    assert.match(html, /function captureMemoryConversationScope/);
    assert.match(html, /function captureCharacterMemoryScope/);
    assert.match(html, /function memoryConversationScopeMatches/);
    assert.match(html, /function characterMemoryScopeMatches/);
    assert.match(html, /function memoryMatchesConversationScope/);
    assert.match(html, /function clearMemoryConversationState/);
    const memoryScopeScript = html.match(
      /function captureMemoryConversationScope\(\)[\s\S]*?function captureCharacterMemoryScope/,
    )?.[0] ?? "";
    assert.match(memoryScopeScript, /state\.conversationSpaceEpoch/);
    assert.match(memoryScopeScript, /state\.activeSessionId/);
    assert.match(memoryScopeScript, /session\.conversationSpace !== "secret"/);
    assert.match(memoryScopeScript, /session\.characterId !== characterId/);
    const clearMemoryScript = html.match(
      /function clearMemoryConversationState\(\)[\s\S]*?function conversationSpaceIdle/,
    )?.[0] ?? "";
    assert.match(clearMemoryScript, /state\.memories = \[\]/);
    assert.match(clearMemoryScript, /state\.managedMemories = \[\]/);
    assert.match(clearMemoryScript, /state\.memoryJobs = \[\]/);
    assert.match(clearMemoryScript, /state\.retrievalPreview = null/);
    assert.match(clearMemoryScript, /nodes\.memoryList\.innerHTML = ""/);
    assert.match(clearMemoryScript, /nodes\.managedMemoryList\.innerHTML = ""/);
    assert.match(clearMemoryScript, /nodes\.memoryJobList\.innerHTML = ""/);
    assert.match(clearMemoryScript, /nodes\.retrievalPreviewResults\.innerHTML = ""/);
    assert.match(clearMemoryScript, /nodes\.memorySearch\.value = ""/);
    assert.match(clearMemoryScript, /nodes\.managedMemoryQuery\.value = ""/);
    assert.match(clearMemoryScript, /nodes\.managedMemoryCreateContent\.value = ""/);
    assert.match(clearMemoryScript, /nodes\.retrievalPreviewQuery\.value = ""/);
    assert.match(html, /workspaceCharacterId !== scope\.characterId/);
    const characterMemoryScript = html.match(
      /async function loadMemories\(\)[\s\S]*?function splitLines/,
    )?.[0] ?? "";
    assert.match(characterMemoryScript, /fetch\(withConversationSpace\(/);
    assert.match(characterMemoryScript, /scope\.conversationSpace,[\s\S]*?scope\.characterId/);
    assert.match(characterMemoryScript, /characterMemoryScopeMatches\(scope\)/);
    assert.match(characterMemoryScript, /memoryMatchesConversationScope\(memory, scope\)/);
    assert.doesNotMatch(characterMemoryScript, /fetch\("\/api\/v1\/memories/);
    const managedMemoryLoadScript = html.match(
      /async function loadManagedMemories\(\)[\s\S]*?function renderManagedMemories/,
    )?.[0] ?? "";
    assert.match(managedMemoryLoadScript, /memory-coordinator\/status/);
    assert.match(managedMemoryLoadScript, /memory-coordinator\/memories\?limit=100/);
    assert.match(managedMemoryLoadScript, /memoryConversationScopeMatches\(scope\)/);
    assert.match(managedMemoryLoadScript, /memoryMatchesConversationScope\(memory, scope\)/);
    assert.match(managedMemoryLoadScript, /scope\.conversationSpace === "secret"[\s\S]*?scope\.characterId/);
    const retrievalPreviewScript = html.match(
      /async function runRetrievalPreview\(event\)[\s\S]*?function renderRetrievalPreview/,
    )?.[0] ?? "";
    assert.match(retrievalPreviewScript, /\? scope\.sessionId/);
    assert.match(retrievalPreviewScript, /fetch\(withConversationSpace\(/);
    assert.match(retrievalPreviewScript, /memoryConversationScopeMatches\(scope\)/);
    const managedMemoryCreateScript = html.match(
      /async function createManagedMemory\(event\)[\s\S]*?async function handleManagedMemoryAction/,
    )?.[0] ?? "";
    assert.match(managedMemoryCreateScript, /scope\.conversationSpace === "secret"[\s\S]*?scope\.characterId/);
    assert.match(managedMemoryCreateScript, /fetch\(withConversationSpace\(/);
    assert.match(managedMemoryCreateScript, /memoryConversationScopeMatches\(scope\)/);
    const managedMemoryActionScript = html.match(
      /async function handleManagedMemoryAction\(event\)[\s\S]*?function renderMemoryJobs/,
    )?.[0] ?? "";
    assert.match(managedMemoryActionScript, /memoryMatchesConversationScope\(memory, scope\)/);
    assert.match(managedMemoryActionScript, /fetch\(withConversationSpace\(/);
    assert.match(managedMemoryActionScript, /memoryConversationScopeMatches\(scope\)/);
    const retryMemoryJobScript = html.match(
      /async function retryMemoryJob\(event\)[\s\S]*?async function loadAgentModules/,
    )?.[0] ?? "";
    assert.match(retryMemoryJobScript, /memoryMatchesConversationScope\(job, scope\)/);
    assert.match(retryMemoryJobScript, /fetch\(withConversationSpace\(/);
    assert.match(retryMemoryJobScript, /memoryConversationScopeMatches\(scope\)/);
    assert.match(html, /state\.debugTracesByScope = \{ conversation: \[\], background: \[\] \}/);
    assert.match(html, /nodes\.textInput\.value = ""/);
    assert.match(html, /expectedEpoch !== state\.conversationSpaceEpoch/);
    assert.match(html, /JSON\.stringify\(\{ characterId, conversationSpace: requestedSpace \}\)/);
    assert.match(html, /withConversationSpace\("\/api\/v1\/sessions"/);
    assert.match(html, /"&characterId=" \+ encodeURIComponent\(characterId\)/);
    assert.match(html, /state\.conversationSpace !== "normal"/);
    assert.match(html, /data-module-spaces/);
    assert.match(html, /enabledSpaces: enabledSpacesForSetting/);
    const moduleDetailScript = html.match(
      /async function openModuleDetailFromList\(event\)[\s\S]*?async function toggleAgentModule/,
    )?.[0] ?? "";
    assert.match(moduleDetailScript, /withConversationSpace\(/);
    assert.match(moduleDetailScript, /fetch\("\/api\/v1\/subagent-settings"\)/);
    assert.match(moduleDetailScript, /id="subagentSettingsForm"/);
    assert.match(moduleDetailScript, /subagentSettingsFieldHtml\("subagentMaxConcurrentTasks"/);
    assert.match(moduleDetailScript, /subagentSettingsFieldHtml\("subagentMaxWorkModelCalls"/);
    assert.match(moduleDetailScript, /subagentSettingsFieldHtml\("subagentMaxOutputTokens"/);
    assert.match(moduleDetailScript, /subagentSettingsFieldHtml\("subagentMaxResultCharacters"/);
    assert.match(moduleDetailScript, /subagentSettingsFieldHtml\("subagentTimeoutSeconds"/);
    assert.match(moduleDetailScript, /maxWorkModelCalls \+ 1/);
    assert.match(moduleDetailScript, /timeoutSeconds \+ 30/);
    assert.match(moduleDetailScript, /设置仅影响之后开始的委派任务/);
    assert.match(moduleDetailScript, /绝对上限：并发 8、工作模型 64 轮/);
    assert.match(moduleDetailScript, /受当前模型真实 context window 与模型服务支持限制/);
    assert.match(moduleDetailScript, /多路并发结果共享当前父回合的 Subagent 结果上下文预算/);
    assert.match(moduleDetailScript, /expectedRevision: record\.subagentSettings\.revision/);
    assert.match(moduleDetailScript, /controlPlaneFetch\("\/api\/v1\/subagent-settings", \{/);
    assert.match(moduleDetailScript, /method: "PATCH"/);
    assert.match(moduleDetailScript, /CONTROL_PLANE_BUSY/);
    assert.match(moduleDetailScript, /当前有角色回合正在运行，请等待结束后再保存/);
    assert.match(moduleDetailScript, /SUBAGENT_SETTINGS_CONFLICT/);
    assert.match(moduleDetailScript, /设置已被其他窗口更新，请重新打开模块详情/);
    assert.match(moduleDetailScript, /SUBAGENT_SETTINGS_INVALID/);
    assert.match(moduleDetailScript, /请输入 .* 之间的整数/);
    const moduleDetailScopeScript = inlineScript.match(
      /function captureModuleDetailScope[\s\S]*?(?=\n    function closeModuleDetail)/,
    )?.[0] ?? "";
    assert.match(moduleDetailScopeScript, /scope\.requestId === state\.moduleDetailRequestId/);
    assert.match(moduleDetailScopeScript, /scope\.epoch === state\.conversationSpaceEpoch/);
    assert.match(moduleDetailScopeScript, /scope\.characterId === state\.selectedCharacterId/);
    assert.match(moduleDetailScopeScript, /state\.uiMode === "management" && state\.managementTab === "modules"/);
    const moduleDetailScopeState = {
      moduleDetailRequestId: 7,
      conversationSpaceEpoch: 4,
      conversationSpace: "secret",
      selectedCharacterId: "character-a",
      uiMode: "management",
      managementTab: "modules",
    };
    const moduleDetailScopeContext: Record<string, any> = { state: moduleDetailScopeState };
    new Script(
      moduleDetailScopeScript +
      "\nthis.captureModuleDetailScopeForTest = captureModuleDetailScope;" +
      "\nthis.moduleDetailScopeIsCurrentForTest = moduleDetailScopeIsCurrent;",
    ).runInNewContext(moduleDetailScopeContext);
    const currentModuleDetailScope = moduleDetailScopeContext.captureModuleDetailScopeForTest(
      "mcp:subagent",
      7,
    );
    assert.equal(
      moduleDetailScopeContext.moduleDetailScopeIsCurrentForTest(currentModuleDetailScope),
      true,
    );
    moduleDetailScopeState.moduleDetailRequestId += 1;
    assert.equal(
      moduleDetailScopeContext.moduleDetailScopeIsCurrentForTest(currentModuleDetailScope),
      false,
      "an older module-detail response cannot replace a newer request",
    );
    moduleDetailScopeState.moduleDetailRequestId = 7;
    moduleDetailScopeState.selectedCharacterId = "character-b";
    assert.equal(
      moduleDetailScopeContext.moduleDetailScopeIsCurrentForTest(currentModuleDetailScope),
      false,
      "a Subagent settings response cannot cross into another character view",
    );
    moduleDetailScopeState.selectedCharacterId = "character-a";
    moduleDetailScopeState.conversationSpace = "normal";
    assert.equal(
      moduleDetailScopeContext.moduleDetailScopeIsCurrentForTest(currentModuleDetailScope),
      false,
      "a Subagent settings response cannot cross conversation spaces",
    );
    moduleDetailScopeState.conversationSpace = "secret";
    moduleDetailScopeState.managementTab = "profile";
    assert.equal(
      moduleDetailScopeContext.moduleDetailScopeIsCurrentForTest(currentModuleDetailScope),
      false,
      "a closed capability view ignores late settings responses",
    );
    assert.match(html, />仅普通<\/option>/);
    assert.match(html, />仅私密<\/option>/);
    assert.match(html, />普通 \+ 私密<\/option>/);
    assert.match(html, /id="agentSkillInstallForm"/);
    assert.match(html, /id="agentSkillSourceUrl" type="url"[^>]+placeholder="https:\/\/github\.com\/owner\/repo\/tree\/main\/path\/to\/skill"/);
    assert.match(html, /GitHub 目录或 ZIP/);
    assert.match(html, /id="agentSkillExpectedSha256"[^>]+maxlength="64"/);
    assert.match(html, /id="previewAgentSkillInstallBtn"[^>]*>下载并预检<\/button>/);
    assert.match(html, /预检不会安装或启用 Skill/);
    assert.match(html, /id="agentSkillInstallPreview"[^>]+hidden/);
    assert.match(html, /id="agentSkillInstallMarkdown"/);
    assert.match(html, /SKILL\.md 文本预览/);
    assert.match(html, /id="agentSkillInstallSpaces"/);
    assert.match(html, /id="cancelAgentSkillInstallBtn"[^>]*>取消并删除预检<\/button>/);
    assert.match(html, /id="confirmAgentSkillInstallBtn"[^>]*>确认安装并启用<\/button>/);
    assert.match(html, /function controlPlaneFetch/);
    const controlPlaneFetchScript = html.match(
      /function controlPlaneFetch\(path, options = \{\}\)[\s\S]*?function captureAgentSkillInstallScope/,
    )?.[0] ?? "";
    assert.match(controlPlaneFetchScript, /new Headers\(options\.headers \|\| \{\}\)/);
    assert.match(controlPlaneFetchScript, /headers\.set\("content-type", "application\/json"\)/);
    assert.match(controlPlaneFetchScript, /credentials: "same-origin"/);
    assert.doesNotMatch(controlPlaneFetchScript, /control-token|meta\[|querySelector/);
    const skillInstallScript = html.match(
      /function captureAgentSkillInstallScope[\s\S]*?async function loadAgentModules/,
    )?.[0] ?? "";
    assert.match(skillInstallScript, /expectedEpoch: state\.conversationSpaceEpoch/);
    assert.match(skillInstallScript, /scope\.expectedEpoch === state\.conversationSpaceEpoch/);
    assert.match(skillInstallScript, /state\.uiMode === "management" && state\.managementTab === "modules"/);
    assert.match(skillInstallScript, /agentSkillInstallSpaces\.value = state\.conversationSpace === "secret" \? "secret" : "normal"/);
    assert.match(skillInstallScript, /parsedSourceUrl = new URL\(sourceUrl\)/);
    assert.match(skillInstallScript, /parsedSourceUrl\.protocol !== "https:"/);
    assert.match(skillInstallScript, /\/api\/v1\/agent-skills\/install\/preview/);
    assert.match(skillInstallScript, /\/api\/v1\/agent-skills\/install\/confirm/);
    assert.match(skillInstallScript, /\/api\/v1\/agent-skills\/install\/stages\//);
    assert.match(skillInstallScript, /controlPlaneFetch\("\/api\/v1\/agent-skills\/install\/preview"/);
    assert.match(skillInstallScript, /controlPlaneFetch\("\/api\/v1\/agent-skills\/install\/confirm"/);
    assert.match(skillInstallScript, /JSON\.stringify\(\{ stageId: stage\.id, sha256: stage\.sha256, enabledSpaces \}\)/);
    assert.match(skillInstallScript, /window\.confirm\(/);
    assert.match(skillInstallScript, /预检完成。请核对来源、摘要和 SKILL\.md，再明确确认安装/);
    assert.match(skillInstallScript, /agentSkillInstallMarkdown\.textContent/);
    assert.doesNotMatch(skillInstallScript, /renderMarkdown\(stage\.skillMarkdown|innerHTML = stage\.skillMarkdown/);
    assert.match(skillInstallScript, /\["来源主机", stage\.sourceHost/);
    assert.match(skillInstallScript, /\["规范化来源", stage\.sourceUrl/);
    assert.match(skillInstallScript, /stage\.resolvedRef \? \[\["解析 Ref", stage\.resolvedRef\]\]/);
    assert.match(skillInstallScript, /stage\.resolvedCommit \? \[\["解析 Commit", stage\.resolvedCommit\]\]/);
    assert.match(skillInstallScript, /\["包目录", stage\.packageName/);
    assert.match(skillInstallScript, /\["Skill 名称", stage\.skillName/);
    assert.match(skillInstallScript, /\["SHA-256", stage\.sha256/);
    assert.match(skillInstallScript, /stage\.files\.length/);
    assert.doesNotMatch(skillInstallScript, /stage\.files\.(?:map|join)/);
    assert.match(skillInstallScript, /formatFileSize\(stage\.totalBytes/);
    assert.match(skillInstallScript, /formatTraceTime\(stage\.expiresAt\)/);
    assert.match(skillInstallScript, /"来源：" \+ \(stage\.sourceUrl \|\| "未知"\)/);
    assert.match(skillInstallScript, /stage\.resolvedCommit \? "解析 Commit：" \+ stage\.resolvedCommit/);
    assert.match(clearConversationSpaceScript, /clearAgentSkillInstallStage\(\{ deleteRemote: true \}\)/);
    const uiModeScript = html.match(/function setUiMode\(mode\)[\s\S]*?function setManagementTab/)?.[0] ?? "";
    assert.match(uiModeScript, /mode !== "management"[\s\S]*?clearAgentSkillInstallStage/);
    const managementTabScript = html.match(/function setManagementTab\(tab\)[\s\S]*?function loadManagement/)?.[0] ?? "";
    assert.match(managementTabScript, /tab !== "modules"[\s\S]*?clearAgentSkillInstallStage/);
    assert.match(html, /\/workspace\/files\/upload\?/);
    assert.match(html, /function activeSecretWorkspaceManagerScope\(\)/);
    assert.match(html, /session\.conversationSpace !== "secret" \|\| session\.characterId !== characterId/);
    assert.match(html, /function requireWorkspaceManagerScope\(\)/);
    assert.match(html, /请先打开当前角色的私密对话，再管理私密 Workspace/);
    assert.match(html, /function workspaceManagerScopeIsCurrent\(scope\)/);
    assert.match(html, /scope\.epoch !== state\.conversationSpaceEpoch/);
    assert.match(html, /active\.sessionId === scope\.sessionId/);
    assert.match(html, /active\.characterId === scope\.characterId/);
    assert.match(html, /function workspaceManagerUrl\(scope, suffix, query = ""\)/);
    assert.match(html, /scope\.conversationSpace,\s*scope\.characterId/);
    assert.match(html, /fetch\(workspaceManagerUrl\(scope, "", query\)\)/);
    assert.match(html, /workspaceManagerUrl\(requestScope, "\/upload", query\.toString\(\)\)/);
    assert.match(html, /workspaceManagerUrl\(scope, ""\), \{\s*method: "PATCH"/);
    assert.match(html, /workspaceManagerUrl\(scope, ""\), \{\s*method: "DELETE"/);
    assert.match(html, /previewWorkspaceFile\(path, scope\.sessionScoped, scope\)/);
    assert.match(html, /workspaceFileContentUrl\(path, "attachment", scope\.sessionScoped, scope\)/);
    assert.match(html, /workspaceFileContentUrl\(path, "inline", sessionScoped, requestScope\)/);
    assert.match(html, /state\.workspaceFileDirectory = "";\s*state\.workspaceFiles = \[\]/);
    assert.match(html, /nodes\.workspaceFileList\.innerHTML = ""/);
    assert.match(html, /nodes\.workspaceFileRefreshBtn\.disabled = true/);
    assert.match(html, /clearWorkspaceManagerState\(\);/);
    assert.match(html, /id="visionSettingsTabBtn"/);
    assert.match(html, /id="visionSettingsPanel"/);
    assert.match(html, /id="documentSettingsTabBtn"/);
    assert.match(html, /id="documentSettingsPanel"/);
    assert.match(html, /id="mineruBaseUrl"/);
    assert.match(html, /id="mineruTimeoutSeconds"[^>]*value="600"/);
    assert.match(html, /CPU 服务解析较长 PDF/);
    assert.match(html, /MinerU Document MCP/);
    assert.match(html, /controlPlaneFetch\("\/api\/settings\/mineru"/);
    assert.match(html, /controlPlaneFetch\("\/api\/v1\/diagnostics\/mineru\/test"/);
    assert.match(html, /parse_document_with_mineru: "MinerU 深度解析文档"/);
    assert.match(html, /id="apiVisionInputEnabled"/);
    assert.match(html, /请先选择角色；如果还没有角色/);
    assert.doesNotMatch(html, /thinking_delta/);

    for (const asset of ["marked.umd.js", "purify.min.js", "lucide.min.js", "twemoji.min.js"]) {
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
    const twemojiSvg = await fetch(`${baseUrl}/assets/twemoji/svg/1f60a.svg`);
    assert.equal(twemojiSvg.status, 200);
    assert.match(twemojiSvg.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await twemojiSvg.text(), /<svg/);
    const rejectedTwemojiPath = await fetch(`${baseUrl}/assets/twemoji/svg/..%2fpackage.json.svg`);
    assert.doesNotMatch(rejectedTwemojiPath.headers.get("content-type") ?? "", /image\/svg\+xml/);

    const manifestResponse = await fetch(`${baseUrl}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    assert.match(manifestResponse.headers.get("content-type") ?? "", /application\/manifest\+json/);
    const manifest = await manifestResponse.json() as {
      name: string;
      theme_color: string;
      icons: Array<{ src: string; sizes: string }>;
    };
    assert.equal(manifest.name, "YourChar");
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
    assert.match(await pageWithSlash.text(), /YourChar/);

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
        reasoningEffort: "high",
        maxTokens: 2048,
      }),
    });
    assert.equal(savedSettings.status, 200);
    const savedBody = await savedSettings.json();
    assert.equal(savedBody.apiKeySet, true);
    assert.equal(savedBody.visionInputEnabled, true);
    assert.equal(savedBody.reasoningEffort, "high");
    assert.equal(savedBody.apiKeyMasked, "clie...cret");
    assert.equal(JSON.stringify(savedBody).includes("client-secret"), false);

    const fetchedSettings = await fetch(`${baseUrl}/api/model-config/openai-compatible`);
    assert.equal(fetchedSettings.status, 200);
    const fetchedBody = await fetchedSettings.json();
    assert.equal(fetchedBody.model, "local-model");
    assert.equal(fetchedBody.reasoningEffort, "high");
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
