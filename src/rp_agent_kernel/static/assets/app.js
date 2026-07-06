const STORAGE_KEY = "rp-agent-kernel-ui";
const RUN_ARTIFACTS_KEY = "rp-agent-kernel-run-artifacts";
const MAX_SESSIONS = 24;
const MAX_RUN_ARTIFACTS = 120;

const state = {
  mode: "sms",
  lastTraceId: "",
  lastFailedText: "",
  sending: false,
  inspectorOpen: true,
  activePanel: "schedulePanel",
  sessions: [],
  characters: [],
  focusModelLogId: "",
  copyResetTimer: 0,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const nodes = {
  workspace: $(".workspace"),
  statusText: $("#statusText"),
  sessionId: $("#sessionId"),
  sessionList: $("#sessionList"),
  newSessionBtn: $("#newSessionBtn"),
  newSmsSessionBtn: $("#newSmsSessionBtn"),
  newRpSessionBtn: $("#newRpSessionBtn"),
  copySessionBtn: $("#copySessionBtn"),
  syncServerSessionsBtn: $("#syncServerSessionsBtn"),
  cloneSessionBtn: $("#cloneSessionBtn"),
  clearSessionBtn: $("#clearSessionBtn"),
  exportSessionEvalBtn: $("#exportSessionEvalBtn"),
  sessionSearch: $("#sessionSearch"),
  sessionModeFilter: $("#sessionModeFilter"),
  timezone: $("#timezone"),
  fixedNow: $("#fixedNow"),
  characterId: $("#characterId"),
  characterSelect: $("#characterSelect"),
  chatTitle: $("#chatTitle"),
  chatSubtitle: $("#chatSubtitle"),
  chatContext: $("#chatContext"),
  composerMode: $("#composerMode"),
  messageList: $("#messageList"),
  messageForm: $("#messageForm"),
  messageText: $("#messageText"),
  sendButton: $("#sendButton"),
  retryBtn: $("#retryBtn"),
  refreshAllBtn: $("#refreshAllBtn"),
  loadHistoryBtn: $("#loadHistoryBtn"),
  toggleInspectorBtn: $("#toggleInspectorBtn"),
  lastMetrics: $("#lastMetrics"),
  calendarList: $("#calendarList"),
  reminderList: $("#reminderList"),
  featureList: $("#featureList"),
  modelConfigForm: $("#modelConfigForm"),
  modelEnabled: $("#modelEnabled"),
  modelBaseUrl: $("#modelBaseUrl"),
  modelApiKey: $("#modelApiKey"),
  modelName: $("#modelName"),
  modelSelect: $("#modelSelect"),
  modelTemperature: $("#modelTemperature"),
  modelMaxTokens: $("#modelMaxTokens"),
  modelContextWindow: $("#modelContextWindow"),
  modelHeaders: $("#modelHeaders"),
  modelConfigStatus: $("#modelConfigStatus"),
  loadModelsBtn: $("#loadModelsBtn"),
  modelLogList: $("#modelLogList"),
  characterForm: $("#characterForm"),
  characterFormId: $("#characterFormId"),
  characterName: $("#characterName"),
  characterTags: $("#characterTags"),
  characterPersona: $("#characterPersona"),
  characterScenario: $("#characterScenario"),
  characterCardFile: $("#characterCardFile"),
  characterImportStatus: $("#characterImportStatus"),
  characterList: $("#characterList"),
  evalJson: $("#evalJson"),
  evalResult: $("#evalResult"),
  traceId: $("#traceId"),
  traceOutput: $("#traceOutput"),
  eventForm: $("#eventForm"),
  eventTitle: $("#eventTitle"),
  eventStart: $("#eventStart"),
  reminderForm: $("#reminderForm"),
  reminderTitle: $("#reminderTitle"),
  reminderAt: $("#reminderAt"),
};

function init() {
  loadPreferences();
  setDefaultEval();
  syncControls();
  bindEvents();
  renderEmptyChat();
  refreshAll();
  loadHistory();
}

function loadPreferences() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.mode = saved.mode || state.mode;
    state.inspectorOpen = saved.inspectorOpen ?? state.inspectorOpen;
    state.activePanel = saved.activePanel || state.activePanel;
    state.sessions = normalizeSessions(saved.sessions);
    nodes.sessionId.value = saved.sessionId || state.sessions[0]?.id || "demo";
    nodes.characterId.value = saved.characterId || "";
    nodes.timezone.value = saved.timezone || "Asia/Shanghai";
    nodes.fixedNow.value = saved.fixedNow || "2026-07-02T12:00";
    nodes.messageText.value = saved.draft || "";
    nodes.sessionSearch.value = saved.sessionSearch || "";
    nodes.sessionModeFilter.value = saved.sessionModeFilter || "all";
    touchSession({ persist: false });
  } catch {
    nodes.fixedNow.value = "2026-07-02T12:00";
    state.sessions = normalizeSessions([]);
    touchSession({ persist: false });
  }
}

function savePreferences() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      mode: state.mode,
      sessionId: currentSessionId(),
      sessions: state.sessions,
      characterId: nodes.characterId.value,
      timezone: nodes.timezone.value || "Asia/Shanghai",
      fixedNow: nodes.fixedNow.value,
      draft: nodes.messageText.value,
      sessionSearch: nodes.sessionSearch.value,
      sessionModeFilter: nodes.sessionModeFilter.value,
      inspectorOpen: state.inspectorOpen,
      activePanel: state.activePanel,
    }),
  );
}

function setDefaultEval() {
  nodes.evalJson.value = JSON.stringify(
    {
      cases: [
        {
          id: "sms-reminder",
          sessionId: "eval-ui",
          request: {
            mode: "sms",
            text: "三小时后提醒我喝水",
            now: "2026-07-02T12:00:00+08:00",
          },
          assertions: {
            actionType: "create_reminder",
            replyContains: "已设置提醒",
            maxLatencyMs: 1000,
          },
        },
      ],
    },
    null,
    2,
  );
}

function syncControls() {
  setMode(state.mode, false);
  setInspectorOpen(state.inspectorOpen, false);
  switchPanel(state.activePanel, false);
  renderSessionList();
}

function currentSessionId() {
  const value = nodes.sessionId.value.trim();
  return value || "demo";
}

function normalizeSessions(items) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      mode: item.mode === "rp" ? "rp" : "sms",
      characterId: String(item.characterId || ""),
      updatedAt: item.updatedAt || new Date().toISOString(),
      messageCount: Number(item.messageCount || 0),
      lastPreview: String(item.lastPreview || ""),
      source: item.source || "local",
    });
  }
  return result.slice(0, MAX_SESSIONS);
}

function touchSession(options = {}) {
  const { persist = true } = options;
  const id = currentSessionId();
  const now = new Date().toISOString();
  const existing = state.sessions.find((session) => session.id === id);
  const next = {
    id,
    mode: state.mode,
    characterId: nodes.characterId.value.trim(),
    updatedAt: now,
    messageCount: existing?.messageCount || 0,
    lastPreview: existing?.lastPreview || "",
    source: existing?.source || "local",
  };
  state.sessions = [
    next,
    ...state.sessions.filter((session) => session.id !== id),
  ].slice(0, MAX_SESSIONS);
  if (existing?.updatedAt && options.keepUpdatedAt) {
    state.sessions[0].updatedAt = existing.updatedAt;
  }
  renderSessionList();
  renderChatContext();
  if (persist) savePreferences();
}

function createNewSession(modeOverride = state.mode) {
  const nextMode = modeOverride === "rp" ? "rp" : "sms";
  setMode(nextMode, false);
  const id = makeSessionId(nextMode);
  nodes.sessionId.value = id;
  if (nextMode === "sms") {
    nodes.characterId.value = "";
  }
  state.lastTraceId = "";
  state.lastFailedText = "";
  nodes.messageText.value = "";
  nodes.lastMetrics.innerHTML = "";
  renderEmptyChat();
  touchSession();
  loadHistory();
  nodes.messageText.focus();
}

function makeSessionId(mode) {
  const stamp = new Date()
    .toISOString()
    .replace(/\D/g, "")
    .slice(0, 17);
  return `${mode === "rp" ? "rp" : "sms"}-${stamp}`;
}

function switchSession(id) {
  const session = state.sessions.find((item) => item.id === id);
  nodes.sessionId.value = id;
  if (session?.mode) {
    setMode(session.mode, false);
  }
  nodes.characterId.value = session?.characterId || "";
  state.lastTraceId = "";
  state.lastFailedText = "";
  nodes.lastMetrics.innerHTML = "";
  touchSession({ keepUpdatedAt: true });
  loadHistory();
}

function forgetSession(id) {
  state.sessions = state.sessions.filter((session) => session.id !== id);
  if (currentSessionId() === id) {
    const next = state.sessions[0]?.id || "demo";
    nodes.sessionId.value = next;
    state.lastTraceId = "";
    nodes.lastMetrics.innerHTML = "";
    renderEmptyChat();
    if (!state.sessions.length) {
      touchSession({ persist: false });
    }
    loadHistory();
  }
  renderSessionList();
  savePreferences();
}

async function copyCurrentSessionId() {
  const id = currentSessionId();
  try {
    await copyText(id);
    nodes.copySessionBtn.textContent = "已复制";
    window.clearTimeout(state.copyResetTimer);
    state.copyResetTimer = window.setTimeout(() => {
      nodes.copySessionBtn.textContent = "复制 ID";
    }, 1200);
    addMessage("system", `已复制 Session ID：${id}`);
  } catch (error) {
    addMessage("system", `复制失败：${error.message}`);
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function syncServerSessions() {
  try {
    const params = new URLSearchParams();
    params.set("limit", "100");
    const query = nodes.sessionSearch.value.trim();
    const mode = nodes.sessionModeFilter.value;
    if (query) params.set("search", query);
    if (mode && mode !== "all") params.set("mode", mode);
    const sessions = await api(`/api/sessions?${params.toString()}`);
    const merged = [
      ...sessions.map((item) => ({
        id: item.sessionId || item.id,
        mode: item.mode === "rp" ? "rp" : "sms",
        characterId: item.characterId || "",
        updatedAt: item.updatedAt || new Date().toISOString(),
        messageCount: item.messageCount || 0,
        lastPreview: item.lastPreview || "",
        source: "server",
      })),
      ...state.sessions,
    ];
    state.sessions = normalizeSessions(merged);
    touchSession({ keepUpdatedAt: true });
    addMessage("system", `已同步 ${sessions.length} 个服务端会话。`);
  } catch (error) {
    addMessage("system", `同步服务端会话失败：${error.message}`);
  }
}

async function cloneCurrentSession() {
  const sourceId = currentSessionId();
  const targetId = `${sourceId}-copy-${new Date().toISOString().replace(/\D/g, "").slice(8, 14)}`;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(sourceId)}/clone`, {
      method: "POST",
      body: { targetSessionId: targetId },
    });
    nodes.sessionId.value = result.targetSessionId;
    state.lastTraceId = "";
    state.lastFailedText = "";
    nodes.lastMetrics.innerHTML = "";
    touchSession();
    state.sessions = state.sessions.map((session) =>
      session.id === result.targetSessionId
        ? { ...session, messageCount: result.cloned, source: "server" }
        : session,
    );
    renderSessionList();
    savePreferences();
    await loadHistory();
    addMessage("system", `已克隆 ${result.cloned} 条消息到 ${result.targetSessionId}。`);
  } catch (error) {
    addMessage("system", `克隆会话失败：${error.message}`);
  }
}

async function clearCurrentSessionHistory() {
  const id = currentSessionId();
  if (!window.confirm(`清空会话 ${id} 的聊天历史？此操作不会删除日程、提醒或记忆。`)) {
    return;
  }
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(id)}/messages`, {
      method: "DELETE",
    });
    state.sessions = state.sessions.map((session) =>
      session.id === id ? { ...session, messageCount: 0, lastPreview: "" } : session,
    );
    renderSessionList();
    renderEmptyChat();
    savePreferences();
    addMessage("system", `已清空 ${result.deleted} 条历史消息。`);
  } catch (error) {
    addMessage("system", `清空历史失败：${error.message}`);
  }
}

async function exportCurrentSessionEvalCase() {
  try {
    const id = currentSessionId();
    const messages = await api(`/api/sessions/${encodeURIComponent(id)}/messages?limit=20`);
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    if (!lastUser) {
      addMessage("system", "当前会话没有可导出的用户消息。");
      return;
    }
    const evalPayload = {
      cases: [
        {
          id: `${id}-latest`,
          sessionId: `${id}-eval`,
          request: {
            mode: lastUser.mode || state.mode,
            text: lastUser.content,
            timezone: nodes.timezone.value || "Asia/Shanghai",
            ...(nodes.fixedNow.value ? { now: toIso(nodes.fixedNow.value) } : {}),
            ...(lastUser.character_id ? { characterId: lastUser.character_id } : {}),
          },
          assertions: {
            contextTracePresent: true,
            maxLatencyMs: 60000,
          },
        },
      ],
    };
    nodes.evalJson.value = JSON.stringify(evalPayload, null, 2);
    setInspectorOpen(true);
    switchPanel("evalPanel");
    addMessage("system", `已把 ${id} 最近一条用户消息导出为 eval case。`);
  } catch (error) {
    addMessage("system", `导出 eval 失败：${error.message}`);
  }
}

function renderSessionList() {
  if (!nodes.sessionList) return;
  nodes.sessionList.innerHTML = "";
  if (!state.sessions.length) {
    nodes.sessionList.append(emptyItem("暂无最近会话"));
    return;
  }
  const activeId = currentSessionId();
  const query = nodes.sessionSearch.value.trim().toLowerCase();
  const modeFilter = nodes.sessionModeFilter.value || "all";
  const visibleSessions = state.sessions
    .filter((session) => modeFilter === "all" || session.mode === modeFilter)
    .filter((session) => {
      if (!query) return true;
      return `${session.id} ${session.mode} ${session.characterId}`.toLowerCase().includes(query);
    });
  if (!visibleSessions.length) {
    nodes.sessionList.append(emptyItem("没有匹配的会话"));
    return;
  }
  for (const session of visibleSessions.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = `session-card${session.id === activeId ? " active" : ""}`;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "session-open";
    open.addEventListener("click", () => switchSession(session.id));

    const title = document.createElement("span");
    title.className = "session-title";
    title.textContent = session.id;
    const meta = document.createElement("span");
    meta.className = "session-meta";
    const character = session.characterId ? ` · ${shortId(session.characterId)}` : "";
    const count = session.messageCount ? ` · ${session.messageCount} msg` : "";
    meta.textContent = `${session.mode.toUpperCase()}${character}${count} · ${formatSessionTime(session.updatedAt)}`;
    if (session.lastPreview) {
      open.title = session.lastPreview;
    }
    open.append(title, meta);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "session-remove";
    remove.title = "从最近会话移除";
    remove.textContent = "×";
    remove.addEventListener("click", () => forgetSession(session.id));

    row.append(open, remove);
    nodes.sessionList.append(row);
  }
}

function bindEvents() {
  $$("#modeSms, #modeRp").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });

  $$(".preset").forEach((button) => {
    button.addEventListener("click", () => {
      setMode(button.dataset.mode || state.mode);
      nodes.messageText.value = button.dataset.text;
      savePreferences();
      nodes.messageText.focus();
    });
  });

  $$(".command").forEach((button) => {
    button.addEventListener("click", () => runCommand(button.dataset.command));
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchPanel(tab.dataset.panel));
  });

  nodes.messageForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });
  nodes.messageText.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  nodes.messageText.addEventListener("input", savePreferences);
  nodes.sessionId.addEventListener("change", () => {
    touchSession();
    savePreferences();
    loadHistory();
    renderChatContext();
  });
  nodes.sessionId.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      nodes.sessionId.blur();
    }
  });
  nodes.newSessionBtn.addEventListener("click", () => createNewSession(state.mode));
  nodes.newSmsSessionBtn.addEventListener("click", () => createNewSession("sms"));
  nodes.newRpSessionBtn.addEventListener("click", () => createNewSession("rp"));
  nodes.copySessionBtn.addEventListener("click", copyCurrentSessionId);
  nodes.syncServerSessionsBtn.addEventListener("click", syncServerSessions);
  nodes.cloneSessionBtn.addEventListener("click", cloneCurrentSession);
  nodes.clearSessionBtn.addEventListener("click", clearCurrentSessionHistory);
  nodes.exportSessionEvalBtn.addEventListener("click", exportCurrentSessionEvalCase);
  nodes.sessionSearch.addEventListener("input", () => {
    renderSessionList();
    savePreferences();
  });
  nodes.sessionModeFilter.addEventListener("change", () => {
    renderSessionList();
    savePreferences();
  });
  [nodes.timezone, nodes.fixedNow].forEach((node) => {
    node.addEventListener("change", () => {
      savePreferences();
      renderChatContext();
    });
  });
  nodes.characterId.addEventListener("change", () => {
    touchSession();
    savePreferences();
    renderChatContext();
  });
  nodes.characterSelect.addEventListener("change", () => {
    if (nodes.characterSelect.value) {
      nodes.characterId.value = nodes.characterSelect.value;
      setMode("rp");
      touchSession();
      savePreferences();
      renderChatContext();
    }
  });

  nodes.eventForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createEvent();
  });
  nodes.reminderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createReminder();
  });
  nodes.modelConfigForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveModelConfig();
  });
  nodes.loadModelsBtn.addEventListener("click", () => loadModelList({ saveCurrent: true }));
  nodes.modelSelect.addEventListener("change", () => {
    if (nodes.modelSelect.value) {
      selectModel(nodes.modelSelect.value);
    }
  });
  $("#clearApiKeyBtn").addEventListener("click", clearModelApiKey);
  nodes.characterForm.addEventListener("submit", (event) => {
    event.preventDefault();
    saveCharacter();
  });
  $("#useCharacterBtn").addEventListener("click", useCharacterFormId);
  $("#importCharacterBtn").addEventListener("click", importCharacterCard);
  nodes.refreshAllBtn.addEventListener("click", refreshAll);
  nodes.loadHistoryBtn.addEventListener("click", loadHistory);
  nodes.toggleInspectorBtn.addEventListener("click", () => setInspectorOpen(!state.inspectorOpen));
  nodes.retryBtn.addEventListener("click", retryLastMessage);
  $("#refreshScheduleBtn").addEventListener("click", refreshSchedule);
  $("#refreshReminderBtn").addEventListener("click", refreshReminders);
  $("#refreshFeaturesBtn").addEventListener("click", refreshFeatures);
  $("#loadModelConfigBtn").addEventListener("click", loadModelConfig);
  $("#refreshModelLogsBtn").addEventListener("click", loadModelLogs);
  $("#clearModelLogsBtn").addEventListener("click", clearModelLogs);
  $("#refreshCharactersBtn").addEventListener("click", refreshCharacters);
  $("#runEvalBtn").addEventListener("click", runEval);
  $("#loadTraceBtn").addEventListener("click", loadTrace);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== "string") {
    body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, { ...options, headers, body });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.detail || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

async function streamApi(path, options = {}, onEvent) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && typeof body !== "string") {
    body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, { ...options, headers, body });
  if (!response.ok) {
    const text = await response.text();
    let detail = text;
    try {
      detail = JSON.parse(text).detail || text;
    } catch {
      detail = text || `${response.status} ${response.statusText}`;
    }
    throw new Error(detail);
  }
  if (!response.body) {
    throw new Error("当前浏览器不支持流式响应。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = consumeSseBuffer(buffer, onEvent);
  }
  buffer += decoder.decode();
  consumeSseBuffer(buffer, onEvent, true);
}

function consumeSseBuffer(buffer, onEvent, flush = false) {
  buffer = buffer.replace(/\r\n/g, "\n");
  let boundary = buffer.indexOf("\n\n");
  while (boundary !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 2);
    handleSseFrame(frame, onEvent);
    boundary = buffer.indexOf("\n\n");
  }
  if (flush && buffer.trim()) {
    handleSseFrame(buffer, onEvent);
    return "";
  }
  return buffer;
}

function handleSseFrame(frame, onEvent) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return;
  const event = JSON.parse(data);
  onEvent(event);
}

function setMode(mode, persist = true) {
  state.mode = mode === "rp" ? "rp" : "sms";
  $$("#modeSms, #modeRp").forEach((item) => {
    item.classList.toggle("active", item.dataset.mode === state.mode);
  });
  nodes.composerMode.textContent = state.mode === "rp" ? "沉浸" : "日常";
  nodes.chatTitle.textContent = state.mode === "rp" ? "沉浸姿态" : "日常姿态";
  nodes.chatSubtitle.textContent =
    state.mode === "rp"
      ? "同一个 companion 的场景、角色和共同时间线"
      : "同一个 companion 的清醒、简短、实践侧";
  nodes.messageText.placeholder =
    state.mode === "rp"
      ? "输入台词、动作或场景推进；选择角色后更容易延续共同经历。"
      : "输入日常请求，例如安排日程、设置提醒或确认动作。";
  renderChatContext();
  if (persist) {
    touchSession();
    savePreferences();
  }
}

function renderChatContext() {
  if (!nodes.chatContext) return;
  nodes.chatContext.innerHTML = "";
  if (state.mode === "rp") {
    const character = currentCharacter();
    const characterId = nodes.characterId.value.trim();
    if (character) {
      nodes.chatContext.append(
        contextPill("Role", character.name || shortId(character.id)),
        contextPill("Persona", compactStatus(character.persona), character.persona ? "ok" : "warn"),
        contextPill("Scene", compactStatus(character.scenario), character.scenario ? "ok" : "warn"),
      );
      return;
    }
    if (characterId) {
      nodes.chatContext.append(
        contextPill("Role", `${shortId(characterId)}（未加载详情）`, "warn"),
        contextPill("Persona", "未知", "warn"),
        contextPill("Scene", "未知", "warn"),
      );
      return;
    }
    nodes.chatContext.append(
      contextPill("Role", "未选择", "warn"),
      contextPill("Persona", "未设置", "warn"),
      contextPill("Scene", "未设置", "warn"),
    );
    return;
  }

  nodes.chatContext.append(
    contextPill("Session", currentSessionId()),
    contextPill("TZ", nodes.timezone.value || "Asia/Shanghai"),
    contextPill("Now", fixedNowLabel(nodes.fixedNow.value)),
  );
}

function currentCharacter() {
  const id = nodes.characterId.value.trim();
  if (!id) return null;
  return state.characters.find((character) => character.id === id) || null;
}

function compactStatus(value) {
  const text = String(value || "").trim();
  if (!text) return "未设置";
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

function contextPill(label, value, tone = "ok") {
  const pill = document.createElement("span");
  pill.className = `context-pill ${tone}`;
  pill.title = `${label}: ${value}`;
  pill.textContent = `${label}: ${value}`;
  return pill;
}

function fixedNowLabel(value) {
  if (!value) return "实时";
  return value.replace("T", " ");
}

function setInspectorOpen(open, persist = true) {
  state.inspectorOpen = open;
  nodes.workspace.classList.toggle("inspector-collapsed", !open);
  nodes.toggleInspectorBtn.textContent = open ? "Hide Inspector" : "Show Inspector";
  if (persist) savePreferences();
}

function switchPanel(panelId, persist = true) {
  state.activePanel = panelId || "schedulePanel";
  $$(".tab").forEach((item) => {
    item.classList.toggle("active", item.dataset.panel === state.activePanel);
  });
  $$(".panel-view").forEach((panel) => {
    panel.classList.toggle("active", panel.id === state.activePanel);
  });
  if (state.activePanel === "modelLogsPanel") {
    loadModelLogs();
  }
  if (persist) savePreferences();
}

function runCommand(command) {
  const text = command.trim();
  if (text === "/sms") {
    setMode("sms");
    addMessage("system", "已切换到日常姿态。");
  } else if (text === "/rp") {
    setMode("rp");
    addMessage("system", "已切换到沉浸姿态。");
  } else if (text === "/calendar") {
    setInspectorOpen(true);
    switchPanel("schedulePanel");
    refreshSchedule();
  } else if (text === "/features") {
    setInspectorOpen(true);
    switchPanel("featuresPanel");
    refreshFeatures();
  } else if (text === "/model") {
    setInspectorOpen(true);
    switchPanel("modelPanel");
    loadModelConfig();
  } else if (text === "/logs") {
    setInspectorOpen(true);
    switchPanel("modelLogsPanel");
    loadModelLogs();
  } else if (text === "/characters") {
    setInspectorOpen(true);
    switchPanel("charactersPanel");
    refreshCharacters();
  } else if (text === "/trace") {
    setInspectorOpen(true);
    switchPanel("tracePanel");
    loadTrace();
  } else if (text === "/eval") {
    setInspectorOpen(true);
    switchPanel("evalPanel");
  } else if (text === "/clear") {
    renderEmptyChat();
  } else {
    addMessage("system", `未知命令：${text}`);
  }
}

async function refreshAll() {
  await Promise.allSettled([
    checkHealth(),
    refreshSchedule(),
    refreshReminders(),
    refreshFeatures(),
    loadModelConfig(),
    loadModelLogs(),
    refreshCharacters(),
  ]);
}

async function checkHealth() {
  try {
    await api("/health");
    nodes.statusText.textContent = "在线";
    nodes.statusText.style.color = "var(--ok)";
  } catch (error) {
    nodes.statusText.textContent = `离线：${error.message}`;
    nodes.statusText.style.color = "var(--danger)";
  }
}

async function loadHistory() {
  try {
    const sessionId = encodeURIComponent(currentSessionId());
    const messages = await api(`/api/sessions/${sessionId}/messages?limit=50`);
    nodes.messageList.innerHTML = "";
    if (!messages.length) {
      renderEmptyChat();
      return;
    }
    for (const message of messages) {
      const protectedContent =
        message.role === "assistant" ? sanitizeAssistantHistoryText(message.content) : null;
      const article = addMessage(message.role, protectedContent?.text ?? message.content, null, {
        fromHistory: true,
        mode: message.mode,
        createdAt: message.created_at,
        protectedHistory: protectedContent?.protected ?? false,
      });
      if (message.role === "assistant") {
        const artifact = getRunArtifact(message.id);
        if (artifact) {
          attachRunSummary(article, artifact, { persisted: true });
        }
      }
    }
  } catch (error) {
    renderEmptyChat();
    addMessage("system", `加载历史失败：${error.message}`);
  }
}

async function sendMessage() {
  if (state.sending) return;
  const text = nodes.messageText.value.trim();
  if (!text) return;
  if (text.startsWith("/")) {
    nodes.messageText.value = "";
    savePreferences();
    runCommand(text);
    return;
  }

  state.sending = true;
  state.lastFailedText = text;
  touchSession();
  nodes.sendButton.disabled = true;
  nodes.retryBtn.classList.add("hidden");
  addMessage("user", text, null, { mode: state.mode });
  const assistantMessage = addMessage("assistant", "正在生成…", null, {
    mode: state.mode,
    streaming: true,
  });
  const assistantBody = assistantMessage.querySelector(".message-text");
  nodes.messageText.value = "";
  savePreferences();

  try {
    const beforeSnapshot = await captureRunSnapshot();
    const payload = {
      mode: state.mode,
      text,
      timezone: nodes.timezone.value || "Asia/Shanghai",
      characterId: nodes.characterId.value.trim() || null,
    };
    const fixedNow = toIso(nodes.fixedNow.value);
    if (fixedNow) payload.now = fixedNow;

    let gotDelta = false;
    let finalResponse = null;
    await streamApi(
      `/api/sessions/${encodeURIComponent(currentSessionId())}/messages/stream`,
      {
        method: "POST",
        body: payload,
      },
      (event) => {
        if (event.type === "start") {
          updateTraceId(event.contextTraceId);
          renderMetrics(event.metrics);
          return;
        }
        if (event.type === "delta") {
          if (!gotDelta) {
            assistantBody.textContent = "";
            gotDelta = true;
          }
          assistantBody.textContent += event.text || "";
          renderMetrics(event.metrics);
          nodes.messageList.scrollTop = nodes.messageList.scrollHeight;
          return;
        }
        if (event.type === "status" && event.status !== "fallback") {
          addMessage("system", event.detail || event.status);
          return;
        }
        if (event.type === "error") {
          throw new Error(event.detail || "流式响应失败");
        }
        if (event.type === "done") {
          finalResponse = event.response;
        }
      },
    );
    if (!finalResponse) {
      throw new Error("流式响应缺少完成事件。");
    }
    assistantBody.textContent = finalResponse.reply;
    assistantMessage.classList.remove("streaming");
    attachPayloadMeta(assistantMessage, finalResponse);
    const afterSnapshot = await captureRunSnapshot();
    const run = {
      inputText: text,
      request: payload,
      response: finalResponse,
      beforeSnapshot,
      afterSnapshot,
    };
    attachRunSummary(assistantMessage, run);
    persistLatestRunArtifact(run);
    updateFromResponse(finalResponse);
    state.lastFailedText = "";
    refreshSchedule();
    refreshReminders();
    if (state.activePanel === "modelLogsPanel") {
      loadModelLogs();
    }
  } catch (error) {
    assistantMessage.remove();
    addMessage("system", error.message);
    nodes.retryBtn.classList.remove("hidden");
  } finally {
    state.sending = false;
    nodes.sendButton.disabled = false;
  }
}

function retryLastMessage() {
  if (!state.lastFailedText) return;
  nodes.messageText.value = state.lastFailedText;
  nodes.retryBtn.classList.add("hidden");
  sendMessage();
}

function updateFromResponse(data) {
  updateTraceId(data.contextTraceId);
  renderMetrics(data.metrics);
  if (state.lastTraceId && state.activePanel === "tracePanel") {
    loadTrace();
  }
}

function updateTraceId(traceId) {
  state.lastTraceId = traceId || state.lastTraceId;
  if (state.lastTraceId) {
    nodes.traceId.value = state.lastTraceId;
  }
}

function addMessage(role, text, payload = null, options = {}) {
  const empty = nodes.messageList.querySelector(".empty-state");
  if (empty) empty.remove();

  const article = document.createElement("article");
  article.className = `message ${role}`;
  if (role === "assistant" && (options.mode || state.mode) === "rp") {
    article.classList.add("rp");
  }
  if (options.streaming) {
    article.classList.add("streaming");
  }
  if (options.protectedHistory) {
    article.classList.add("history-protected");
  }

  const header = document.createElement("div");
  header.className = "message-header";
  const label = document.createElement("span");
  label.textContent = options.protectedHistory ? `${role} · visible-only` : role;
  const time = document.createElement("span");
  time.textContent = options.createdAt ? formatDate(options.createdAt) : "";
  header.append(label, time);

  const body = document.createElement("div");
  body.className = "message-text";
  body.textContent = text;
  article.append(header, body);

  if (payload) {
    attachPayloadMeta(article, payload);
  }

  nodes.messageList.append(article);
  nodes.messageList.scrollTop = nodes.messageList.scrollHeight;
  return article;
}

function sanitizeAssistantHistoryText(value) {
  const original = String(value || "");
  const text = original.trim();
  if (!text) return { text: "（历史助手消息为空）", protected: true };

  const parsed = parseJsonLike(text);
  if (parsed.ok) {
    const visible = extractVisibleHistoryText(parsed.value);
    if (visible && !looksLikeDebugDump(visible)) {
      return { text: visible, protected: true };
    }
    return {
      text: "（历史助手消息包含旧版推理、工具或 JSON 载荷，已在聊天区隐藏。）",
      protected: true,
    };
  }

  if (looksLikeDebugDump(text)) {
    return {
      text: "（历史助手消息包含旧版推理、工具或 JSON 载荷，已在聊天区隐藏。）",
      protected: true,
    };
  }
  return { text: original, protected: false };
}

function parseJsonLike(text) {
  const stripped = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  if (!/^[{[]/.test(stripped)) return { ok: false, value: null };
  try {
    return { ok: true, value: JSON.parse(stripped) };
  } catch {
    return { ok: false, value: null };
  }
}

function extractVisibleHistoryText(value) {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) {
    return "";
  }
  const directKeys = ["reply", "visible", "displayText", "assistantText"];
  for (const key of directKeys) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return value[key].trim();
    }
  }
  if (typeof value.response?.reply === "string") {
    return value.response.reply.trim();
  }
  if (typeof value.message?.content === "string") {
    return value.message.content.trim();
  }
  if (typeof value.choices?.[0]?.message?.content === "string") {
    return value.choices[0].message.content.trim();
  }
  return "";
}

function looksLikeDebugDump(text) {
  const source = String(text || "");
  const head = source.slice(0, 3200);
  const lower = head.toLowerCase();
  if (/<\/?think\b/.test(lower)) return true;
  if (hasDebugOpening(head)) return true;
  if (debugHeadingCount(source) >= 2) return true;
  if (/^\s*(reasoning|chain[_ -]?of[_ -]?thought|cot|tool[_ -]?calls?|actions?)\s*[:=]/i.test(head)) {
    return true;
  }
  if (/\b(analy[sz]e the request|determine character response|drafting the prose|final review|output generation)\b/i.test(head)) {
    return true;
  }
  const debugMarkerCount = [
    "user input",
    "current character",
    "scenario",
    "memory context",
    "determine",
    "formulate",
    "drafting",
    "refining",
    "final output",
  ].filter((marker) => lower.includes(marker)).length;
  if (debugMarkerCount >= 3) return true;
  return [
    '"reasoning"',
    '"reasoningcontent"',
    '"tool_calls"',
    '"toolcalls"',
    '"function_call"',
    '"actiontype"',
    '"actions"',
    '"tool"',
  ].some((marker) => lower.includes(marker));
}

function hasDebugOpening(text) {
  const compact = String(text || "")
    .trimStart()
    .replace(/^```(?:text|markdown|json)?/i, "")
    .trimStart();
  return /^(?:okay[,.]?\s*)?(?:the user\b|user asks?\b|i need to\b|i should\b|we need to\b|we should\b|let me\b|let's\b|need to\b|first[,\s]+i\b|action\s*:|payload\b(?:\s*:|\s+-|\s+is)?|observation\s*:|thought\s*:|analysis\s*:|reasoning\s*:|tool call\s*:|tool result\s*:|scratchpad\s*:)/i.test(
    compact,
  );
}

function debugHeadingCount(text) {
  const lines = String(text || "").split(/\r?\n/).slice(0, 80);
  return lines.filter((line) =>
    /^\s{0,3}(?:#{1,6}\s*)?(?:analysis|reasoning|thought|chain[-_ ]?of[-_ ]?thought|plan|action|payload|observation|tool call|tool result|scratchpad|decision|final review|output generation|step\s+\d+|phase\s+\d+)\s*[:：-]?\s*$/i.test(
      line,
    ),
  ).length;
}

function attachPayloadMeta(article, payload) {
  article.querySelectorAll(".meta-row, .confirmation-row").forEach((node) => node.remove());
  const meta = document.createElement("div");
  meta.className = "meta-row";
  for (const action of payload.actions || []) {
    const modelCallLogId = action.payload?.modelCallLogId;
    if (action.actionType === "external_model_render" && modelCallLogId) {
      meta.append(
        makePillButton(formatActionSummary(action), action.status, () =>
          focusModelLog(modelCallLogId),
        ),
      );
    } else {
      meta.append(makePill(formatActionSummary(action), action.status));
    }
  }
  if (payload.contextTraceId) {
    const traceButton = document.createElement("button");
    traceButton.type = "button";
    traceButton.className = "pill ok";
    traceButton.textContent = `trace ${payload.contextTraceId.slice(0, 8)}`;
    traceButton.addEventListener("click", () => {
      nodes.traceId.value = payload.contextTraceId;
      setInspectorOpen(true);
      switchPanel("tracePanel");
      loadTrace();
    });
    meta.append(traceButton);
  }
  appendMetricPills(meta, payload.metrics);
  if (meta.children.length) {
    article.append(meta);
  }

  if (payload.confirmations?.length) {
    const row = document.createElement("div");
    row.className = "confirmation-row";
    for (const confirmation of payload.confirmations) {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.textContent = "批准";
      approve.addEventListener("click", () => decideConfirmation(confirmation.id, "approved"));
      const reject = document.createElement("button");
      reject.type = "button";
      reject.textContent = "拒绝";
      reject.addEventListener("click", () => decideConfirmation(confirmation.id, "rejected"));
      row.append(approve, reject);
    }
    article.append(row);
  }
}

async function captureRunSnapshot() {
  const [calendar, reminders] = await Promise.allSettled([
    api("/api/calendar/events"),
    api("/api/reminders"),
  ]);
  const errors = [];
  if (calendar.status === "rejected") errors.push(`calendar: ${calendar.reason?.message || calendar.reason}`);
  if (reminders.status === "rejected") errors.push(`reminders: ${reminders.reason?.message || reminders.reason}`);
  return {
    calendarEvents: calendar.status === "fulfilled" ? calendar.value : [],
    reminders: reminders.status === "fulfilled" ? reminders.value : [],
    errors,
  };
}

function attachRunSummary(article, run, options = {}) {
  article.querySelectorAll(".run-summary").forEach((node) => node.remove());
  const diff = run.diff || diffRunSnapshots(run.beforeSnapshot, run.afterSnapshot);
  const response = run.response || {};
  const details = document.createElement("details");
  details.className = "run-summary";
  const summary = document.createElement("summary");
  summary.textContent = options.persisted ? "Run Summary · persisted" : "Run Summary";

  const body = document.createElement("div");
  body.className = "run-summary-body";
  body.append(
    runLine("输入", compactRunText(run.inputText)),
    runLine("回复", compactRunText(response.reply || "")),
    runLine("Actions", `${(response.actions || []).length} 个`),
    runLine("Trace", response.contextTraceId ? shortId(response.contextTraceId) : "无"),
    runLine("Latency", response.metrics ? formatMs(response.metrics.latencyMs) : "无"),
    runLine("Context", response.metrics ? formatContextMetric(response.metrics) : "无"),
    runLine("Generated", response.metrics?.generatedTokens ? `${response.metrics.generatedTokens} tok` : "无"),
  );
  const modelAction = (response.actions || []).find((action) => action.actionType === "external_model_render");
  if (modelAction) {
    const fallback = modelAction.payload?.fallback ? "fallback" : "model";
    body.append(runLine("Model", `${humanActionStatus(modelAction.status)} · ${fallback}`));
  }
  for (const action of response.actions || []) {
    body.append(runLine("Action", formatActionSummary(action)));
  }
  for (const event of diff.addedCalendarEvents) {
    body.append(runLine("新增日程", `${event.title} · ${formatDate(event.start)}`));
  }
  for (const event of diff.changedCalendarEvents) {
    body.append(runLine("变更日程", `${event.after.title} · ${formatDate(event.after.start)}`));
  }
  for (const event of diff.removedCalendarEvents) {
    body.append(runLine("删除日程", `${event.title} · ${formatDate(event.start)}`));
  }
  for (const reminder of diff.addedReminders) {
    body.append(runLine("新增提醒", `${reminder.title} · ${formatDate(reminder.remindAt)}`));
  }
  for (const reminder of diff.changedReminders) {
    body.append(runLine("变更提醒", `${reminder.after.title} · ${formatDate(reminder.after.remindAt)}`));
  }
  for (const reminder of diff.removedReminders) {
    body.append(runLine("删除提醒", `${reminder.title} · ${formatDate(reminder.remindAt)}`));
  }
  const snapshotErrors = [
    ...(run.beforeSnapshot?.errors || []).map((error) => `before ${error}`),
    ...(run.afterSnapshot?.errors || []).map((error) => `after ${error}`),
    ...(run.snapshotErrors || []),
  ];
  for (const error of snapshotErrors) {
    body.append(runLine("Snapshot", error));
  }
  if (!runHasDiff(diff)) {
    body.append(runLine("状态变更", "未检测到日程/提醒差异"));
  }

  const buttons = document.createElement("div");
  buttons.className = "button-row compact-buttons compact-row";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "复制 Run JSON";
  copy.addEventListener("click", () => copyRunSummary(run, diff));
  const exportEval = document.createElement("button");
  exportEval.type = "button";
  exportEval.textContent = "导出 Eval";
  exportEval.addEventListener("click", () => exportRunEvalCase(run));
  buttons.append(copy, exportEval);
  body.append(buttons);

  details.append(summary, body);
  article.append(details);
}

function diffRunSnapshots(before, after) {
  const beforeEvents = itemMap(before?.calendarEvents || []);
  const afterEvents = itemMap(after?.calendarEvents || []);
  const beforeReminders = itemMap(before?.reminders || []);
  const afterReminders = itemMap(after?.reminders || []);
  return {
    addedCalendarEvents: [...afterEvents.values()].filter((item) => !beforeEvents.has(item.id)),
    removedCalendarEvents: [...beforeEvents.values()].filter((item) => !afterEvents.has(item.id)),
    changedCalendarEvents: [...afterEvents.values()]
      .filter((item) => beforeEvents.has(item.id) && stableJson(beforeEvents.get(item.id)) !== stableJson(item))
      .map((item) => ({ before: beforeEvents.get(item.id), after: item })),
    addedReminders: [...afterReminders.values()].filter((item) => !beforeReminders.has(item.id)),
    removedReminders: [...beforeReminders.values()].filter((item) => !afterReminders.has(item.id)),
    changedReminders: [...afterReminders.values()]
      .filter((item) => beforeReminders.has(item.id) && stableJson(beforeReminders.get(item.id)) !== stableJson(item))
      .map((item) => ({ before: beforeReminders.get(item.id), after: item })),
  };
}

function itemMap(items) {
  return new Map(items.filter((item) => item?.id).map((item) => [item.id, item]));
}

function stableJson(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

function runHasDiff(diff) {
  return [
    "addedCalendarEvents",
    "removedCalendarEvents",
    "changedCalendarEvents",
    "addedReminders",
    "removedReminders",
    "changedReminders",
  ].some((key) => diff[key]?.length);
}

function runLine(label, value) {
  const row = document.createElement("div");
  row.className = "run-line";
  const key = document.createElement("span");
  key.textContent = label;
  const val = document.createElement("span");
  val.textContent = value;
  row.append(key, val);
  return row;
}

function compactRunText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > 96 ? `${value.slice(0, 96)}...` : value || "空";
}

async function copyRunSummary(run, diff) {
  const payload = {
    sessionId: currentSessionId(),
    mode: run.request?.mode,
    request: run.request,
    reply: run.response?.reply,
    actions: run.response?.actions || [],
    confirmations: run.response?.confirmations || [],
    contextTraceId: run.response?.contextTraceId,
    metrics: run.response?.metrics,
    diff,
    snapshotErrors: run.snapshotErrors || [],
  };
  try {
    await copyText(JSON.stringify(payload, null, 2));
    addMessage("system", "Run JSON 已复制。");
  } catch (error) {
    addMessage("system", `复制 Run JSON 失败：${error.message}`);
  }
}

function exportRunEvalCase(run) {
  const evalPayload = {
    cases: [
      {
        id: `${currentSessionId()}-${Date.now()}`,
        sessionId: `${currentSessionId()}-eval`,
        request: run.request,
        assertions: {
          contextTracePresent: true,
          maxLatencyMs: 60000,
          ...(run.response?.actions?.[0]?.actionType
            ? { actionType: run.response.actions[0].actionType }
            : {}),
        },
      },
    ],
  };
  nodes.evalJson.value = JSON.stringify(evalPayload, null, 2);
  setInspectorOpen(true);
  switchPanel("evalPanel");
}

async function persistLatestRunArtifact(run) {
  try {
    const messages = await api(`/api/sessions/${encodeURIComponent(currentSessionId())}/messages?limit=8`);
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    if (!latestAssistant?.id) return;
    const artifact = buildRunArtifact(run, latestAssistant.id);
    const artifacts = loadRunArtifacts();
    artifacts[latestAssistant.id] = artifact;
    saveRunArtifacts(artifacts);
  } catch {
    // Persistence is best-effort; the visible run summary has already rendered.
  }
}

function buildRunArtifact(run, messageId) {
  const diff = run.diff || diffRunSnapshots(run.beforeSnapshot, run.afterSnapshot);
  return {
    messageId,
    sessionId: currentSessionId(),
    createdAt: new Date().toISOString(),
    inputText: run.inputText,
    request: run.request,
    response: run.response,
    diff,
    snapshotErrors: [
      ...(run.beforeSnapshot?.errors || []).map((error) => `before ${error}`),
      ...(run.afterSnapshot?.errors || []).map((error) => `after ${error}`),
      ...(run.snapshotErrors || []),
    ],
  };
}

function getRunArtifact(messageId) {
  return loadRunArtifacts()[messageId] || null;
}

function loadRunArtifacts() {
  try {
    return JSON.parse(localStorage.getItem(RUN_ARTIFACTS_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveRunArtifacts(artifacts) {
  const entries = Object.entries(artifacts)
    .sort((a, b) => String(b[1].createdAt || "").localeCompare(String(a[1].createdAt || "")))
    .slice(0, MAX_RUN_ARTIFACTS);
  localStorage.setItem(RUN_ARTIFACTS_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function renderEmptyChat() {
  nodes.messageList.innerHTML = '<div class="empty-state">输入消息开始体验，或点左侧 Quick Tests。</div>';
}

function renderMetrics(metrics) {
  nodes.lastMetrics.innerHTML = "";
  if (!metrics) return;
  appendMetricPills(nodes.lastMetrics, metrics);
}

function appendMetricPills(target, metrics) {
  if (!metrics) return;
  if (metrics.latencyMs !== undefined) {
    target.append(makePill(`${formatMs(metrics.latencyMs)} total`, "ok"));
  }
  if (metrics.actionCount !== undefined) {
    target.append(makePill(`${metrics.actionCount} actions`, "ok"));
  }
  if (metrics.tokenEstimate !== undefined) {
    const contextWindow = metrics.contextWindowTokens || 128000;
    target.append(
      makePill(
        `ctx ${metrics.tokenEstimate}/${contextWindow} (${formatPercent(metrics.contextUsageRatio)})`,
        contextTone(metrics.contextUsageRatio),
      ),
    );
  }
  if (metrics.prefillTokensPerSecond) {
    target.append(makePill(`prefill ${formatSpeed(metrics.prefillTokensPerSecond)}`, "ok"));
  } else if (metrics.prefillMs) {
    target.append(makePill(`prefill ${formatMs(metrics.prefillMs)}`, "ok"));
  }
  if (metrics.generationTokensPerSecond) {
    target.append(makePill(`tg ${formatSpeed(metrics.generationTokensPerSecond)}`, "ok"));
  }
  if (metrics.generatedTokens) {
    target.append(makePill(`gen ${metrics.generatedTokens} tok`, "ok"));
  }
}

function formatContextMetric(metrics) {
  const contextWindow = metrics.contextWindowTokens || 128000;
  return `${metrics.tokenEstimate}/${contextWindow} (${formatPercent(metrics.contextUsageRatio)})`;
}

function makePill(text, status) {
  const pill = document.createElement("span");
  const tone = pillTone(status);
  pill.className = `pill ${tone}`;
  pill.textContent = text;
  return pill;
}

function makePillButton(text, status, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `pill ${pillTone(status)}`;
  button.textContent = text;
  button.title = "打开对应模型调用日志";
  button.addEventListener("click", onClick);
  return button;
}

function pillTone(status) {
  if (status === "completed" || status === "ok") return "ok";
  if (["failed", "error", "feature_disabled", "rejected"].includes(status)) return "danger";
  return "warn";
}

function formatActionSummary(action) {
  const type = humanActionType(action.actionType);
  const status = humanActionStatus(action.status);
  const details = actionPayloadSummary(action.payload || {});
  return details ? `${type} · ${status} · ${details}` : `${type} · ${status}`;
}

function humanActionType(type) {
  const labels = {
    create_calendar: "日程",
    list_calendar: "查日程",
    bulk_delete_calendar: "清空日程",
    reschedule_calendar: "改期",
    create_reminder: "提醒",
    create_task: "任务",
    list_tasks: "查任务",
    write_rp_memory: "场景记忆",
    write_secretary_memory: "日常记忆",
    record_shared_episode: "共同经历",
    external_model_render: "外部模型",
  };
  return labels[type] || String(type || "action").replace(/_/g, " ");
}

function humanActionStatus(status) {
  const labels = {
    completed: "完成",
    failed: "失败",
    feature_disabled: "开关关闭",
    confirmation_required: "待确认",
    rejected: "已拒绝",
    approved_no_target: "已批准",
  };
  return labels[status] || String(status || "状态未知").replace(/_/g, " ");
}

function actionPayloadSummary(payload) {
  const parts = [];
  if (payload.title) parts.push(compactStatus(payload.title));
  if (payload.start) parts.push(formatDate(payload.start));
  if (payload.remindAt) parts.push(formatDate(payload.remindAt));
  if (payload.count !== undefined) parts.push(`${payload.count} 条`);
  if (payload.deleted !== undefined) parts.push(`删除 ${payload.deleted} 条`);
  if (payload.model) parts.push(shortId(payload.model));
  if (payload.modelCallLogId) parts.push(`log ${shortId(payload.modelCallLogId)}`);
  if (payload.reason) parts.push(compactStatus(payload.reason));
  if (payload.fallback) parts.push("fallback");
  return parts.slice(0, 3).join(" · ");
}

function focusModelLog(logId) {
  state.focusModelLogId = String(logId || "");
  if (!state.focusModelLogId) return;
  setInspectorOpen(true);
  switchPanel("modelLogsPanel");
}

function contextTone(ratio) {
  if (ratio >= 0.85) return "danger";
  if (ratio >= 0.65) return "warn";
  return "ok";
}

function formatMs(value) {
  const number = Number(value || 0);
  if (number >= 1000) return `${(number / 1000).toFixed(2)}s`;
  return `${Math.round(number)}ms`;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function formatSpeed(value) {
  return `${Number(value || 0).toFixed(1)} tok/s`;
}

async function decideConfirmation(id, decision) {
  try {
    const data = await api(`/api/confirmations/${encodeURIComponent(id)}`, {
      method: "POST",
      body: { decision },
    });
    addMessage("assistant", data.reply, data, { mode: "sms" });
    updateFromResponse(data);
    refreshSchedule();
  } catch (error) {
    addMessage("system", error.message);
  }
}

async function refreshSchedule() {
  try {
    const items = await api("/api/calendar/events");
    nodes.calendarList.innerHTML = "";
    if (!items.length) {
      nodes.calendarList.append(emptyItem("没有日程"));
      return;
    }
    for (const item of items) {
      nodes.calendarList.append(
        listItem(item.title, `${formatDate(item.start)}${item.location ? ` · ${item.location}` : ""}`),
      );
    }
  } catch (error) {
    nodes.calendarList.innerHTML = "";
    nodes.calendarList.append(emptyItem(error.message));
  }
}

async function refreshReminders() {
  try {
    const items = await api("/api/reminders");
    nodes.reminderList.innerHTML = "";
    if (!items.length) {
      nodes.reminderList.append(emptyItem("没有提醒"));
      return;
    }
    for (const item of items) {
      nodes.reminderList.append(listItem(item.title, `${formatDate(item.remindAt)} · ${item.status}`));
    }
  } catch (error) {
    nodes.reminderList.innerHTML = "";
    nodes.reminderList.append(emptyItem(error.message));
  }
}

async function refreshFeatures() {
  try {
    const features = await api("/api/features");
    nodes.featureList.innerHTML = "";
    for (const feature of features) {
      const row = document.createElement("div");
      row.className = "feature-row";

      const copy = document.createElement("div");
      const title = document.createElement("div");
      title.className = "item-title";
      title.textContent = feature.name;
      const meta = document.createElement("div");
      meta.className = "item-meta";
      meta.textContent = feature.description;
      copy.append(title, meta);

      const label = document.createElement("label");
      label.className = "switch";
      label.title = feature.enabled ? "关闭" : "开启";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = feature.enabled;
      input.addEventListener("change", () => setFeature(feature.name, input.checked));
      const slider = document.createElement("span");
      slider.className = "slider";
      label.append(input, slider);
      row.append(copy, label);
      nodes.featureList.append(row);
    }
  } catch (error) {
    nodes.featureList.innerHTML = "";
    nodes.featureList.append(emptyItem(error.message));
  }
}

async function setFeature(name, enabled) {
  try {
    await api("/api/features", {
      method: "PATCH",
      body: { flags: { [name]: enabled } },
    });
    refreshFeatures();
  } catch (error) {
    addMessage("system", error.message);
    refreshFeatures();
  }
}

async function loadModelConfig() {
  try {
    const config = await api("/api/model-config/openai-compatible");
    nodes.modelEnabled.checked = config.enabled;
    nodes.modelBaseUrl.value = config.baseUrl || "";
    nodes.modelName.value = config.model || "";
    setModelOptions(config.model ? [config.model] : [], config.model || "");
    nodes.modelApiKey.value = "";
    nodes.modelApiKey.placeholder = config.apiKeySet
      ? `已保存 ${config.apiKeyMasked}，留空不修改`
      : "未设置，填写后保存到本地 SQLite";
    nodes.modelTemperature.value = config.temperature ?? "";
    nodes.modelMaxTokens.value = config.maxTokens ?? "";
    nodes.modelContextWindow.value = config.contextWindowTokens || 128000;
    nodes.modelHeaders.value = JSON.stringify(config.headers || {}, null, 2);
    renderModelConfigStatus(config);
  } catch (error) {
    setModelStatus(`加载模型配置失败：${error.message}`, "status-error");
  }
}

function readModelConfigPayload() {
  let headers = {};
  const rawHeaders = nodes.modelHeaders.value.trim();
  if (rawHeaders) {
    try {
      headers = JSON.parse(rawHeaders);
    } catch (error) {
      throw new Error(`Extra Headers JSON 格式不对：${error.message}`);
    }
  }
  const payload = {
    enabled: nodes.modelEnabled.checked,
    baseUrl: nodes.modelBaseUrl.value.trim(),
    model: nodes.modelName.value.trim(),
    headers,
  };
  if (nodes.modelApiKey.value.trim()) {
    payload.apiKey = nodes.modelApiKey.value.trim();
  }
  if (nodes.modelTemperature.value !== "") {
    payload.temperature = Number(nodes.modelTemperature.value);
  }
  if (nodes.modelMaxTokens.value !== "") {
    payload.maxTokens = Number(nodes.modelMaxTokens.value);
  }
  if (nodes.modelContextWindow.value !== "") {
    payload.contextWindowTokens = Number(nodes.modelContextWindow.value);
  }
  return payload;
}

async function saveModelConfig(options = {}) {
  const { silent = false, fetchModels = true } = options;
  try {
    if (!silent) {
      setModelLoading(true, "正在保存模型配置...");
    }
    const payload = readModelConfigPayload();
    await api("/api/model-config/openai-compatible", {
      method: "PATCH",
      body: payload,
    });
    await loadModelConfig();
    if (fetchModels) {
      await loadModelList({ silent: true, setBusy: false });
    }
    if (!silent) {
      addMessage("system", "模型配置已保存。");
    }
  } catch (error) {
    setModelStatus(`保存模型配置失败：${error.message}`, "status-error");
    if (silent) {
      throw error;
    }
  } finally {
    if (!silent) {
      setModelLoading(false);
    }
  }
}

async function loadModelList(options = {}) {
  const { silent = false, saveCurrent = false, setBusy = true } = options;
  try {
    if (setBusy) {
      setModelLoading(
        true,
        saveCurrent ? "正在保存当前配置并拉取模型..." : "正在拉取模型列表...",
      );
    }
    if (saveCurrent) {
      await saveModelConfig({ silent: true, fetchModels: false });
    }
    const data = await api("/api/model-config/openai-compatible/models");
    setModelOptions(data.models || [], nodes.modelName.value.trim());
    nodes.modelConfigStatus.append(listInline("可选模型", `${data.count || 0} 个`));
    if (!silent) {
      addMessage("system", `已拉取 ${data.count || 0} 个模型。`);
    }
  } catch (error) {
    setModelStatus(
      `${saveCurrent ? "保存或拉取模型失败" : "拉取模型失败"}：${error.message}`,
      "status-error",
    );
    if (!silent) {
      addMessage("system", error.message);
    }
  } finally {
    if (setBusy) {
      setModelLoading(false);
    }
  }
}

function setModelOptions(models, selected) {
  const unique = Array.from(new Set([selected, ...models].filter(Boolean))).sort();
  nodes.modelSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = unique.length ? "选择已有模型" : "先保存配置，再拉取模型列表";
  nodes.modelSelect.append(placeholder);
  for (const model of unique) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    option.selected = model === selected;
    nodes.modelSelect.append(option);
  }
}

async function selectModel(model) {
  nodes.modelName.value = model;
  setModelLoading(true, `正在保存模型：${model}`);
  try {
    await saveModelConfig({ silent: true, fetchModels: false });
    setModelStatus(`已选择并保存模型：${model}`, "status-ok");
  } catch (error) {
    setModelStatus(`保存模型选择失败：${error.message}`, "status-error");
  } finally {
    setModelLoading(false);
  }
}

function renderModelConfigStatus(config) {
  nodes.modelConfigStatus.innerHTML = "";
  nodes.modelConfigStatus.append(
    listInline("状态", config.enabled ? "启用" : "未启用"),
    listInline("Base URL", config.baseUrl || "未设置"),
    listInline("Model", config.model || "未选择"),
    listInline("Context Window", `${config.contextWindowTokens || 128000} tok`),
    listInline("API Key", config.apiKeySet ? config.apiKeyMasked : "未设置"),
    listInline("更新时间", config.updated_at ? formatDate(config.updated_at) : "尚未保存"),
  );
}

function setModelStatus(message, className = "") {
  nodes.modelConfigStatus.innerHTML = "";
  const line = document.createElement("div");
  line.className = className ? `item-meta ${className}` : "item-meta";
  line.textContent = message;
  nodes.modelConfigStatus.append(line);
}

function setModelLoading(loading, message = "") {
  const saveButton = nodes.modelConfigForm.querySelector("button[type='submit']");
  nodes.loadModelsBtn.disabled = loading;
  if (saveButton) {
    saveButton.disabled = loading;
  }
  if (message) {
    setModelStatus(message);
  }
}

async function clearModelApiKey() {
  try {
    await api("/api/model-config/openai-compatible", {
      method: "PATCH",
      body: { clearApiKey: true },
    });
    await loadModelConfig();
    addMessage("system", "模型 API Key 已清除。");
  } catch (error) {
    nodes.modelConfigStatus.textContent = error.message;
  }
}

async function loadModelLogs() {
  if (!nodes.modelLogList) return;
  try {
    const logs = await api("/api/model-call-logs?limit=30");
    nodes.modelLogList.innerHTML = "";
    if (!logs.length) {
      nodes.modelLogList.append(emptyItem("暂无模型调用日志。"));
      return;
    }
    for (const log of logs) {
      nodes.modelLogList.append(modelLogItem(log));
    }
    focusModelLogElement();
  } catch (error) {
    nodes.modelLogList.innerHTML = "";
    nodes.modelLogList.append(emptyItem(error.message));
  }
}

async function clearModelLogs() {
  if (!nodes.modelLogList) return;
  try {
    await api("/api/model-call-logs", { method: "DELETE" });
    await loadModelLogs();
    addMessage("system", "模型调用日志已清空。");
  } catch (error) {
    addMessage("system", error.message);
  }
}

function modelLogItem(log) {
  const item = document.createElement("article");
  item.className = `model-log ${log.status}`;
  item.dataset.logId = log.id;
  item.tabIndex = -1;
  if (state.focusModelLogId && String(log.id) === state.focusModelLogId) {
    item.classList.add("focused");
  }

  const header = document.createElement("div");
  header.className = "model-log-header";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = `${log.model || "unknown model"} · ${log.status}`;
  const time = document.createElement("div");
  time.className = "item-meta";
  time.textContent = formatDate(log.created_at);
  header.append(title, time);

  const meta = document.createElement("div");
  meta.className = "model-log-meta";
  meta.append(
    makePill(log.mode || "mode", "ok"),
    makePill(`session ${shortId(log.sessionId)}`, "ok"),
    makePill(`${log.promptTokenEstimate || 0} prompt tok`, "ok"),
  );
  if (log.response?.usage?.total_tokens) {
    meta.append(makePill(`${log.response.usage.total_tokens} total tok`, "ok"));
  }
  if (log.error) {
    meta.append(makePill("error", "danger"));
  }

  const endpoint = document.createElement("div");
  endpoint.className = "item-meta";
  endpoint.textContent = log.endpoint;

  const messages = document.createElement("div");
  messages.className = "model-log-messages";
  for (const message of log.request?.messages || []) {
    messages.append(modelRoleBlock(message.role || "unknown", displayText(message.content || "")));
  }

  const response = document.createElement("div");
  response.className = "model-log-response";
  if (log.response?.reasoningContent) {
    response.append(modelRoleBlock("reasoning", displayText(log.response.reasoningContent)));
  }
  if (log.completionText) {
    response.append(modelRoleBlock("assistant", displayText(log.completionText)));
  }
  if (log.error) {
    response.append(modelRoleBlock("error", displayText(log.error)));
  }

  const details = document.createElement("details");
  details.className = "model-log-raw";
  const summary = document.createElement("summary");
  summary.textContent = "Raw JSON";
  const raw = document.createElement("pre");
  raw.className = "json-output compact-json";
  raw.textContent = JSON.stringify(log, null, 2);
  details.append(summary, raw);

  item.append(header, meta, endpoint, messages, response, details);
  return item;
}

function focusModelLogElement() {
  if (!state.focusModelLogId || !nodes.modelLogList) return;
  const target = Array.from(nodes.modelLogList.querySelectorAll(".model-log")).find(
    (item) => item.dataset.logId === state.focusModelLogId,
  );
  if (!target) return;
  requestAnimationFrame(() => {
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  });
}

function modelRoleBlock(role, content) {
  const block = document.createElement("div");
  block.className = `model-role role-${roleClass(role)}`;
  const label = document.createElement("div");
  label.className = "model-role-label";
  label.textContent = role;
  const text = document.createElement("pre");
  text.className = "model-role-content";
  text.textContent = displayText(content);
  block.append(label, text);
  return block;
}

function roleClass(role) {
  const normalized = String(role || "unknown").toLowerCase();
  if (["system", "user", "assistant", "tool", "developer", "reasoning", "error"].includes(normalized)) {
    return normalized;
  }
  return "unknown";
}

function displayText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 10 ? text.slice(0, 10) : text;
}

async function refreshCharacters() {
  try {
    const characters = await api("/api/characters");
    state.characters = characters;
    nodes.characterList.innerHTML = "";
    nodes.characterSelect.innerHTML = '<option value="">选择已有角色</option>';
    if (!characters.length) {
      nodes.characterList.append(emptyItem("没有角色。可以手动创建或上传角色卡。"));
      renderChatContext();
      return;
    }
    for (const character of characters) {
      const option = document.createElement("option");
      option.value = character.id;
      option.textContent = `${character.name} (${character.id.slice(0, 8)})`;
      option.selected = character.id === nodes.characterId.value.trim();
      nodes.characterSelect.append(option);
      nodes.characterList.append(characterItem(character));
    }
    renderChatContext();
  } catch (error) {
    state.characters = [];
    nodes.characterList.innerHTML = "";
    nodes.characterList.append(emptyItem(error.message));
    renderChatContext();
  }
}

async function saveCharacter() {
  const id = nodes.characterFormId.value.trim();
  const name = nodes.characterName.value.trim();
  if (!name) {
    nodes.characterImportStatus.textContent = "角色名不能为空。";
    return;
  }
  const payload = {
    name,
    persona: nodes.characterPersona.value,
    scenario: nodes.characterScenario.value,
    tags: splitTags(nodes.characterTags.value),
    metadata: {},
  };
  try {
    const existing = await api("/api/characters");
    const found = id && existing.some((character) => character.id === id);
    const saved = found
      ? await api(`/api/characters/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: payload,
        })
      : await api("/api/characters", {
          method: "POST",
          body: { id: id || null, ...payload },
        });
    fillCharacterForm(saved);
    nodes.characterId.value = saved.id;
    nodes.characterImportStatus.textContent = `已保存角色：${saved.name}`;
    setMode("rp");
    savePreferences();
    refreshCharacters();
    renderChatContext();
  } catch (error) {
    nodes.characterImportStatus.textContent = error.message;
  }
}

function useCharacterFormId() {
  const id = nodes.characterFormId.value.trim();
  if (!id) return;
  nodes.characterId.value = id;
  setMode("rp");
  savePreferences();
  renderChatContext();
  addMessage("system", `当前沉浸角色已设为 ${id}。`);
}

async function importCharacterCard() {
  const file = nodes.characterCardFile.files?.[0];
  if (!file) {
    nodes.characterImportStatus.textContent = "请选择角色卡文件。";
    return;
  }
  try {
    const payload = { fileName: file.name };
    if (file.type === "image/png" || file.name.toLowerCase().endsWith(".png")) {
      payload.contentBase64 = await readFileAsDataUrl(file);
    } else {
      payload.content = await readFileAsText(file);
    }
    const result = await api("/api/characters/import-card", {
      method: "POST",
      body: payload,
    });
    fillCharacterForm(result.character);
    nodes.characterId.value = result.character.id;
    nodes.characterImportStatus.textContent = `已导入 ${result.character.name}（${result.parsedFormat}）`;
    setMode("rp");
    savePreferences();
    refreshCharacters();
    renderChatContext();
  } catch (error) {
    nodes.characterImportStatus.textContent = error.message;
  }
}

async function createEvent() {
  const title = nodes.eventTitle.value.trim();
  const start = toIso(nodes.eventStart.value);
  if (!title || !start) return;
  try {
    await api("/api/calendar/events", {
      method: "POST",
      body: {
        title,
        start,
        timezone: nodes.timezone.value || "Asia/Shanghai",
      },
    });
    nodes.eventTitle.value = "";
    nodes.eventStart.value = "";
    refreshSchedule();
  } catch (error) {
    addMessage("system", error.message);
  }
}

async function createReminder() {
  const title = nodes.reminderTitle.value.trim();
  const remindAt = toIso(nodes.reminderAt.value);
  if (!title || !remindAt) return;
  try {
    await api("/api/reminders", {
      method: "POST",
      body: {
        title,
        remindAt,
        timezone: nodes.timezone.value || "Asia/Shanghai",
      },
    });
    nodes.reminderTitle.value = "";
    nodes.reminderAt.value = "";
    refreshReminders();
  } catch (error) {
    addMessage("system", error.message);
  }
}

async function runEval() {
  try {
    const payload = JSON.parse(nodes.evalJson.value);
    const data = await api("/api/eval/run", {
      method: "POST",
      body: payload,
    });
    nodes.evalResult.textContent = formatEvalResult(data);
  } catch (error) {
    nodes.evalResult.textContent = error.message;
  }
}

function formatEvalResult(data) {
  const summary = data?.summary || {};
  const cost = summary.cost || {};
  const lines = [
    "Summary",
    `passed ${summary.passed ?? 0}/${summary.total ?? 0}`,
    `latency mean ${formatMs(summary.meanLatencyMs || 0)} · max ${formatMs(summary.maxLatencyMs || 0)}`,
    `context mean ${formatPercent(summary.meanContextUsageRatio || 0)} · max ${formatPercent(summary.maxContextUsageRatio || 0)}`,
    `tokens input ${summary.cost?.inputTokens ?? summary.maxTokenEstimate ?? 0} · output ${summary.totalGeneratedTokens ?? 0} · total ${cost.totalTokens ?? "unknown"}`,
    `cost ${formatEvalCost(cost)}`,
    "",
    JSON.stringify(data, null, 2),
  ];
  return lines.join("\n");
}

function formatEvalCost(cost) {
  if (!cost || !cost.status) return "unknown";
  if (cost.status === "unknown") {
    return `unknown · ${cost.totalTokens ?? 0} tok`;
  }
  if (typeof cost.estimatedCostUsd === "number") {
    return `$${cost.estimatedCostUsd.toFixed(6)}`;
  }
  return String(cost.status);
}

async function loadTrace() {
  const id = nodes.traceId.value.trim();
  if (!id) return;
  try {
    const data = await api(`/api/context-traces/${encodeURIComponent(id)}`);
    nodes.traceOutput.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    nodes.traceOutput.textContent = error.message;
  }
}

function characterItem(character) {
  const item = document.createElement("div");
  item.className = "item character-card";
  const title = document.createElement("div");
  title.className = "item-title";
  title.textContent = character.name;
  const meta = document.createElement("div");
  meta.className = "item-meta";
  meta.textContent = `${character.id}${character.tags?.length ? ` · ${character.tags.join(", ")}` : ""}`;
  const actions = document.createElement("div");
  actions.className = "button-row compact-row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.textContent = "编辑";
  edit.addEventListener("click", () => fillCharacterForm(character));
  const use = document.createElement("button");
  use.type = "button";
  use.textContent = "使用";
  use.addEventListener("click", () => {
    fillCharacterForm(character);
    nodes.characterId.value = character.id;
    setMode("rp");
    savePreferences();
    renderChatContext();
  });
  actions.append(edit, use);
  item.append(title, meta, actions);
  return item;
}

function fillCharacterForm(character) {
  nodes.characterFormId.value = character.id || "";
  nodes.characterName.value = character.name || "";
  nodes.characterTags.value = (character.tags || []).join(", ");
  nodes.characterPersona.value = character.persona || "";
  nodes.characterScenario.value = character.scenario || "";
}

function listItem(title, meta) {
  const item = document.createElement("div");
  item.className = "item";
  const titleNode = document.createElement("div");
  titleNode.className = "item-title";
  titleNode.textContent = title;
  const metaNode = document.createElement("div");
  metaNode.className = "item-meta";
  metaNode.textContent = meta;
  item.append(titleNode, metaNode);
  return item;
}

function listInline(label, value) {
  const wrapper = document.createElement("div");
  wrapper.className = "item-meta";
  wrapper.textContent = `${label}: ${value}`;
  return wrapper;
}

function emptyItem(text) {
  const item = document.createElement("div");
  item.className = "item";
  item.textContent = text;
  return item;
}

function splitTags(value) {
  return value
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function toIso(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatSessionTime(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

init();
