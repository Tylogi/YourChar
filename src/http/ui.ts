export function renderAppHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>RP Agent</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --line: #d9dee7;
      --text: #17202f;
      --muted: #637083;
      --primary: #2563eb;
      --primary-strong: #1749b5;
      --user: #e7f0ff;
      --assistant: #ffffff;
      --tool: #fff7df;
      --event: #eef8f1;
      --danger: #a53636;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr auto;
    }
    header {
      border-bottom: 1px solid var(--line);
      background: var(--panel);
      padding: 12px 18px;
      display: flex;
      gap: 14px;
      align-items: center;
      justify-content: space-between;
    }
    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 700;
    }
    .header-left,
    .header-right,
    .controls {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .segmented {
      display: inline-grid;
      grid-template-columns: 1fr 1fr 1fr;
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
      background: #eef1f6;
    }
    .segmented button {
      border: 0;
      background: transparent;
      padding: 8px 12px;
      min-width: 74px;
      cursor: pointer;
      font: inherit;
      color: var(--muted);
    }
    .segmented button.active {
      background: var(--primary);
      color: white;
    }
    select,
    input,
    textarea,
    button {
      font: inherit;
    }
    select,
    input,
    textarea {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
      color: var(--text);
    }
    select,
    input {
      height: 38px;
      padding: 0 10px;
    }
    main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      gap: 0;
      min-height: 0;
    }
    .chat {
      display: grid;
      grid-template-rows: 1fr auto;
      min-height: 0;
      border-right: 1px solid var(--line);
    }
    .settings-page {
      grid-column: 1 / -1;
      padding: 18px;
      overflow: auto;
      background: var(--bg);
    }
    .settings-shell {
      max-width: 860px;
      margin: 0 auto;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 18px;
    }
    .settings-shell h2 {
      margin: 0 0 14px;
      font-size: 18px;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .settings-field {
      display: grid;
      gap: 6px;
    }
    .settings-field.full {
      grid-column: 1 / -1;
    }
    .checkbox-row.full {
      grid-column: 1 / -1;
    }
    .settings-field label,
    .checkbox-row {
      color: var(--muted);
      font-size: 13px;
    }
    .checkbox-row {
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .checkbox-row input {
      width: 16px;
      height: 16px;
    }
    .settings-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      margin-top: 16px;
    }
    .secondary {
      height: 38px;
      padding: 0 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: white;
      color: var(--text);
      cursor: pointer;
    }
    .messages {
      overflow: auto;
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .bubble {
      max-width: min(760px, 92%);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: var(--assistant);
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .bubble.user {
      margin-left: auto;
      background: var(--user);
      border-color: #bfd3f8;
    }
    .bubble.assistant {
      margin-right: auto;
    }
    .bubble.tool {
      background: var(--tool);
      font-size: 13px;
      color: #6d540e;
    }
    .meta {
      display: block;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
    }
    .composer {
      border-top: 1px solid var(--line);
      padding: 12px;
      background: var(--panel);
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: end;
    }
    textarea {
      width: 100%;
      min-height: 48px;
      max-height: 160px;
      resize: vertical;
      padding: 10px 12px;
      line-height: 1.45;
    }
    .primary {
      height: 48px;
      padding: 0 18px;
      border: 0;
      border-radius: 8px;
      color: white;
      background: var(--primary);
      cursor: pointer;
    }
    .primary:disabled {
      opacity: 0.55;
      cursor: wait;
    }
    .primary:hover:not(:disabled) {
      background: var(--primary-strong);
    }
    aside {
      background: var(--panel);
      min-height: 0;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .side-head {
      padding: 14px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .side-head h2 {
      margin: 0;
      font-size: 15px;
    }
    .debug-list {
      min-height: 0;
      overflow: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .log {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #fbfcfe;
    }
    .log h3 {
      margin: 0 0 6px;
      font-size: 13px;
    }
    .log pre {
      margin: 8px 0 0;
      max-height: 220px;
      overflow: auto;
      background: #101827;
      color: #d7e0f5;
      border-radius: 6px;
      padding: 8px;
      font-size: 12px;
      line-height: 1.45;
    }
    .pills {
      display: flex;
      gap: 5px;
      flex-wrap: wrap;
      margin-top: 6px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      background: var(--event);
      color: #24613a;
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
    }
    .status {
      min-height: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    .error {
      color: var(--danger);
    }
    @media (max-width: 900px) {
      header { align-items: flex-start; }
      main { grid-template-columns: 1fr; }
      .chat { border-right: 0; }
      aside { border-top: 1px solid var(--line); min-height: 360px; }
      .composer { grid-template-columns: 1fr; }
      .primary { width: 100%; }
      .settings-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="header-left">
        <h1>RP Agent</h1>
        <div class="segmented" aria-label="UI mode">
          <button id="normalBtn" class="active" type="button">聊天</button>
          <button id="settingsBtn" type="button">设置</button>
          <button id="debugBtn" type="button">Debug</button>
        </div>
      </div>
      <div class="header-right">
        <label class="controls">
          <span class="muted">会话</span>
          <input id="sessionInput" value="default" autocomplete="off" />
        </label>
        <label class="controls">
          <span class="muted">视角</span>
          <select id="modeSelect">
            <option value="sms">消息</option>
            <option value="rp">叙事</option>
          </select>
        </label>
      </div>
    </header>
    <main>
      <section id="chatPane" class="chat">
        <div id="messages" class="messages" aria-live="polite"></div>
        <form id="composer" class="composer">
          <textarea id="textInput" placeholder="输入消息，例如：5分钟后提醒我喝水"></textarea>
          <button id="sendBtn" class="primary" type="submit">发送</button>
        </form>
      </section>
      <aside id="debugPane" hidden>
        <div class="side-head">
          <h2>最近上下文日志</h2>
          <button id="refreshLogsBtn" type="button">刷新</button>
        </div>
        <div id="debugList" class="debug-list"></div>
      </aside>
      <section id="settingsPage" class="settings-page" hidden>
        <div class="settings-shell">
          <h2>模型 API 设置</h2>
          <div class="settings-grid">
            <label class="checkbox-row full">
              <input id="apiEnabled" type="checkbox" />
              <span>启用 OpenAI-compatible API</span>
            </label>
            <div class="settings-field full">
              <label for="apiBaseUrl">Base URL</label>
              <input id="apiBaseUrl" placeholder="http://127.0.0.1:8317/v1" />
            </div>
            <div class="settings-field">
              <label for="apiModel">模型名</label>
              <input id="apiModel" placeholder="例如 qwen3、gpt-4.1、local-model" />
            </div>
            <div class="settings-field">
              <label for="apiKey">API Key</label>
              <input id="apiKey" type="password" placeholder="留空表示不修改" autocomplete="off" />
            </div>
            <div class="settings-field">
              <label for="apiTemperature">Temperature</label>
              <input id="apiTemperature" type="number" step="0.1" min="0" max="2" placeholder="可选" />
            </div>
            <div class="settings-field">
              <label for="apiMaxTokens">Max Tokens</label>
              <input id="apiMaxTokens" type="number" min="1" step="1" placeholder="可选" />
            </div>
          </div>
          <div class="settings-actions">
            <button id="saveApiSettingsBtn" class="primary" type="button">保存设置</button>
            <button id="clearApiKeyBtn" class="secondary" type="button">清除 Key</button>
            <span id="apiSettingsState" class="muted"></span>
          </div>
        </div>
      </section>
    </main>
    <footer style="padding: 8px 14px; background: var(--panel); border-top: 1px solid var(--line);">
      <div id="status" class="status">就绪</div>
    </footer>
  </div>
  <script>
    const state = {
      uiMode: "normal",
      messages: [],
      busy: false
    };
    const nodes = {
      normalBtn: document.getElementById("normalBtn"),
      settingsBtn: document.getElementById("settingsBtn"),
      debugBtn: document.getElementById("debugBtn"),
      chatPane: document.getElementById("chatPane"),
      settingsPage: document.getElementById("settingsPage"),
      debugPane: document.getElementById("debugPane"),
      debugList: document.getElementById("debugList"),
      refreshLogsBtn: document.getElementById("refreshLogsBtn"),
      messages: document.getElementById("messages"),
      composer: document.getElementById("composer"),
      textInput: document.getElementById("textInput"),
      sendBtn: document.getElementById("sendBtn"),
      status: document.getElementById("status"),
      sessionInput: document.getElementById("sessionInput"),
      modeSelect: document.getElementById("modeSelect"),
      apiEnabled: document.getElementById("apiEnabled"),
      apiBaseUrl: document.getElementById("apiBaseUrl"),
      apiModel: document.getElementById("apiModel"),
      apiKey: document.getElementById("apiKey"),
      apiTemperature: document.getElementById("apiTemperature"),
      apiMaxTokens: document.getElementById("apiMaxTokens"),
      saveApiSettingsBtn: document.getElementById("saveApiSettingsBtn"),
      clearApiKeyBtn: document.getElementById("clearApiKeyBtn"),
      apiSettingsState: document.getElementById("apiSettingsState")
    };

    nodes.normalBtn.addEventListener("click", () => setUiMode("normal"));
    nodes.settingsBtn.addEventListener("click", () => setUiMode("settings"));
    nodes.debugBtn.addEventListener("click", () => setUiMode("debug"));
    nodes.refreshLogsBtn.addEventListener("click", loadDebugLogs);
    nodes.saveApiSettingsBtn.addEventListener("click", saveApiSettings);
    nodes.clearApiKeyBtn.addEventListener("click", clearApiKey);
    nodes.composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      await sendMessage();
    });
    nodes.textInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        await sendMessage();
      }
    });

    renderMessages();

    function setUiMode(mode) {
      state.uiMode = mode;
      nodes.normalBtn.classList.toggle("active", mode === "normal");
      nodes.settingsBtn.classList.toggle("active", mode === "settings");
      nodes.debugBtn.classList.toggle("active", mode === "debug");
      nodes.chatPane.hidden = mode === "settings";
      nodes.settingsPage.hidden = mode !== "settings";
      nodes.debugPane.hidden = mode !== "debug";
      if (mode === "debug") {
        loadDebugLogs();
      }
      if (mode === "settings") {
        loadApiSettings();
      }
    }

    async function sendMessage() {
      const text = nodes.textInput.value.trim();
      if (!text || state.busy) return;
      state.busy = true;
      nodes.sendBtn.disabled = true;
      setStatus("发送中...");
      nodes.textInput.value = "";
      pushMessage("user", text);
      try {
        const sessionId = encodeURIComponent(nodes.sessionInput.value.trim() || "default");
        const response = await fetch("/api/sessions/" + sessionId + "/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: nodes.modeSelect.value,
            text,
            now: new Date().toISOString()
          })
        });
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error || "请求失败");
        }
        pushMessage("assistant", body.reply || "");
        if (Array.isArray(body.actions) && body.actions.length) {
          pushMessage("tool", formatActions(body.actions));
        }
        setStatus("完成");
        if (state.uiMode === "debug") {
          await loadDebugLogs();
        }
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        state.busy = false;
        nodes.sendBtn.disabled = false;
        nodes.textInput.focus();
      }
    }

    function pushMessage(role, text) {
      state.messages.push({ role, text, at: new Date().toLocaleTimeString() });
      renderMessages();
    }

    function renderMessages() {
      if (!state.messages.length) {
        nodes.messages.innerHTML = '<div class="muted">开始聊天。当前只保留基础聊天、提醒工具和 Debug 上下文日志。</div>';
        return;
      }
      nodes.messages.innerHTML = state.messages.map((message) => {
        return '<div class="bubble ' + escapeHtml(message.role) + '">' +
          '<span class="meta">' + roleLabel(message.role) + ' · ' + escapeHtml(message.at) + '</span>' +
          escapeHtml(message.text) +
          '</div>';
      }).join("");
      nodes.messages.scrollTop = nodes.messages.scrollHeight;
    }

    async function loadDebugLogs() {
      nodes.debugList.innerHTML = '<div class="muted">加载中...</div>';
      try {
        const response = await fetch("/api/debug/context-logs?limit=20");
        const body = await response.json();
        if (!response.ok) {
          throw new Error(body.error || "加载失败");
        }
        renderLogs(body.logs || []);
      } catch (error) {
        nodes.debugList.innerHTML = '<div class="error">' + escapeHtml(error.message || String(error)) + '</div>';
      }
    }

    async function loadApiSettings() {
      nodes.apiSettingsState.textContent = "加载中...";
      try {
        const response = await fetch("/api/settings/model-api");
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "加载失败");
        nodes.apiEnabled.checked = Boolean(config.enabled);
        nodes.apiBaseUrl.value = config.baseUrl || "";
        nodes.apiModel.value = config.model || "";
        nodes.apiKey.value = "";
        nodes.apiTemperature.value = config.temperature ?? "";
        nodes.apiMaxTokens.value = config.maxTokens ?? "";
        nodes.apiSettingsState.textContent = config.apiKeySet ? "Key: " + config.apiKeyMasked : "Key: 未设置";
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
      }
    }

    async function saveApiSettings() {
      nodes.apiSettingsState.textContent = "保存中...";
      const payload = {
        enabled: nodes.apiEnabled.checked,
        baseUrl: nodes.apiBaseUrl.value.trim(),
        model: nodes.apiModel.value.trim(),
        temperature: optionalNumber(nodes.apiTemperature.value),
        maxTokens: optionalInteger(nodes.apiMaxTokens.value)
      };
      if (nodes.apiKey.value) {
        payload.apiKey = nodes.apiKey.value;
      }
      try {
        const response = await fetch("/api/settings/model-api", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload)
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "保存失败");
        nodes.apiKey.value = "";
        nodes.apiSettingsState.textContent = config.apiKeySet ? "已保存，Key: " + config.apiKeyMasked : "已保存，Key: 未设置";
        setStatus("API 设置已保存");
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      }
    }

    async function clearApiKey() {
      nodes.apiSettingsState.textContent = "清除中...";
      try {
        const response = await fetch("/api/settings/model-api", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clearApiKey: true })
        });
        const config = await response.json();
        if (!response.ok) throw new Error(config.error || "清除失败");
        nodes.apiKey.value = "";
        nodes.apiSettingsState.textContent = config.apiKeySet ? "Key: " + config.apiKeyMasked : "Key: 未设置";
        setStatus("API Key 已清除");
      } catch (error) {
        nodes.apiSettingsState.textContent = error.message || String(error);
        setStatus(error.message || String(error), true);
      }
    }

    function renderLogs(logs) {
      if (!logs.length) {
        nodes.debugList.innerHTML = '<div class="muted">暂无上下文日志。发送一条消息后会显示最近运行记录。</div>';
        return;
      }
      nodes.debugList.innerHTML = logs.map((log) => {
        const eventTypes = Array.isArray(log.events) ? log.events.map((event) => event.type) : [];
        const actionTypes = Array.isArray(log.actions) ? log.actions.map((action) => action.actionType + ":" + action.status) : [];
        const compact = {
          sessionId: log.sessionId,
          mode: log.mode,
          requestText: log.requestText,
          systemPrompt: log.systemPrompt,
          messageCountBefore: log.messageCountBefore,
          toolNames: log.toolNames,
          reply: log.reply
        };
        return '<section class="log">' +
          '<h3>' + escapeHtml(log.createdAt) + '</h3>' +
          '<div class="muted">' + escapeHtml(log.requestText || "") + '</div>' +
          '<div class="pills">' + eventTypes.slice(0, 10).map((type) => '<span class="pill">' + escapeHtml(type) + '</span>').join("") + '</div>' +
          '<div class="pills">' + actionTypes.map((type) => '<span class="pill">' + escapeHtml(type) + '</span>').join("") + '</div>' +
          '<pre>' + escapeHtml(JSON.stringify(compact, null, 2)) + '</pre>' +
          '</section>';
      }).join("");
    }

    function formatActions(actions) {
      return actions.map((action) => action.actionType + " · " + action.status).join("\\n");
    }

    function roleLabel(role) {
      if (role === "user") return "你";
      if (role === "assistant") return "Agent";
      if (role === "tool") return "Tool";
      return role;
    }

    function setStatus(text, isError) {
      nodes.status.textContent = text;
      nodes.status.classList.toggle("error", Boolean(isError));
    }

    function optionalNumber(value) {
      if (value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    }

    function optionalInteger(value) {
      if (value === "") return null;
      const number = Number(value);
      return Number.isFinite(number) ? Math.floor(number) : null;
    }

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }
  </script>
</body>
</html>`;
}
