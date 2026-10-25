export const creatorCss = `
.management-tabs { grid-template-columns:repeat(5,minmax(0,1fr)); }
#creatorPanel { padding:0; overflow:hidden; background:var(--panel); color:var(--text); }
#creatorPanel[hidden] { display:none; }
.creator-heading { display:flex; gap:12px; align-items:center; padding:22px 24px; border-bottom:1px solid var(--line); }
.creator-avatar { width:42px; height:42px; flex-shrink:0; display:grid; place-items:center; border-radius:13px; background:var(--text); color:var(--panel); }
.creator-avatar svg { width:22px; height:22px; }
.creator-heading h3 { margin:0 0 4px; font-size:16px; }
.creator-heading p { margin:0; color:var(--muted); font-size:12px; }
.creator-heading > button { margin-left:auto; }
.creator-layout { display:grid; grid-template-columns:188px minmax(0,1fr) 320px; height:clamp(510px,69vh,880px); }
.creator-sessions { display:flex; flex-direction:column; min-height:0; border-right:1px solid var(--line); padding:14px 10px; gap:4px; overflow-y:auto; }
.creator-sessions-head { display:flex; align-items:center; justify-content:space-between; padding:12px 8px 4px; font-size:11px; color:var(--muted); letter-spacing:.06em; }
.creator-sessions-head button { height:26px; min-width:0; padding:0 8px; font-size:11px; border-radius:7px; }
.creator-session { display:grid; grid-template-columns:16px minmax(0,1fr) auto; gap:8px; align-items:center; width:100%; text-align:left; background:transparent; border:0; border-radius:9px; padding:8px; color:var(--text); font-size:13px; cursor:pointer; }
.creator-session:hover { background:var(--selected,rgba(127,127,127,.08)); }
.creator-session[aria-current="true"] { background:var(--selected,rgba(127,127,127,.12)); font-weight:600; }
.creator-session svg { width:15px; height:15px; color:var(--muted); }
.creator-session > span { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.creator-session > em { font-style:normal; font-size:10px; color:var(--panel); background:var(--text); border-radius:999px; padding:1px 6px; }
.creator-session > b.creator-busy-dot { width:7px; height:7px; border-radius:50%; background:var(--text); animation:creatorPulse 1.2s ease-in-out infinite; }
@keyframes creatorPulse { 50% { opacity:.25; } }
.creator-sessions-empty { padding:6px 8px; font-size:12px; color:var(--muted); line-height:1.7; }
.creator-conversation { display:flex; flex-direction:column; min-width:0; min-height:0; }
.creator-messages { flex:1; overflow-y:auto; min-height:0; padding:24px clamp(18px,3vw,40px); scroll-behavior:auto; }
.creator-empty { display:grid; gap:14px; align-content:center; min-height:300px; max-width:480px; margin:auto; }
.creator-empty small { color:var(--muted); letter-spacing:.12em; font-size:10px; }
.creator-empty h4 { font-size:25px; font-weight:550; letter-spacing:-.6px; margin:0; line-height:1.5; }
.creator-empty p { color:var(--muted); font-size:13px; line-height:1.9; margin:0 0 10px; }
.creator-empty button { background:transparent; text-align:left; color:var(--text); border:1px solid var(--line); padding:13px 15px; border-radius:10px; font-size:13px; }
.creator-start-options { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.creator-empty .creator-start-option { display:grid; gap:6px; align-content:start; padding:14px; border-radius:12px; }
.creator-empty .creator-start-option strong { display:flex; gap:8px; align-items:center; font-size:14px; }
.creator-empty .creator-start-option strong svg { width:17px; height:17px; }
.creator-empty .creator-start-option span { color:var(--muted); font-size:12px; line-height:1.7; }
.creator-empty .creator-start-option.featured { border-color:var(--text); }
.creator-examples { display:grid; gap:8px; }
.creator-examples > small { margin-top:6px; }
.creator-composer.builder-mode { border-color:var(--text); }
.creator-composer.builder-mode textarea { min-height:92px; }
.creator-compose-actions .creator-mode-hint { color:var(--text); font-weight:550; }
.creator-compose-actions #creatorBuilderToggle { display:inline-flex; gap:6px; align-items:center; padding:0 10px; font-size:12px; }
.creator-compose-actions #creatorBuilderToggle svg { width:14px; height:14px; }
.creator-compose-actions #creatorBuilderToggle[aria-pressed="true"] { background:var(--text); color:var(--panel); border-color:var(--text); }
.creator-message .markdown-body { font-size:14px; line-height:1.85; margin-top:8px; }
.creator-message .markdown-body > :first-child { margin-top:0; }
.creator-message .markdown-body > :last-child { margin-bottom:0; }
.creator-message .markdown-body h1, .creator-message .markdown-body h2, .creator-message .markdown-body h3 { font-size:15px; margin:18px 0 6px; }
.creator-message .markdown-body ul, .creator-message .markdown-body ol { padding-left:20px; margin:6px 0; }
.creator-message .markdown-body table { border-collapse:collapse; font-size:13px; margin:8px 0; }
.creator-message .markdown-body th, .creator-message .markdown-body td { border:1px solid var(--line); padding:6px 9px; text-align:left; vertical-align:top; }
.creator-message .markdown-body code { font-size:12px; }
.creator-message.pending > p { color:var(--muted); font-size:13px; }
.creator-review-bar { display:flex; gap:8px; align-items:center; margin:0 0 16px; }
.creator-review-bar span { font-size:12px; color:var(--muted); margin-right:auto; }
.creator-review-bar button { min-height:32px; font-size:12px; }
.creator-proposal > .creator-proposal-actions { margin:10px 0 4px; }
.creator-proposal-group { margin:0 0 22px; }
.creator-proposal-group > header { display:flex; gap:8px; align-items:center; padding:10px 0; border-top:2px solid var(--text); }
.creator-proposal-group > header a { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-size:13px; font-weight:600; color:var(--text); text-decoration:none; }
.creator-proposal-group > header a:hover { text-decoration:underline; }
.creator-proposal-group > header span { flex-shrink:0; font-size:11px; color:var(--muted); margin-right:auto; }
.creator-proposal-group > header button { flex-shrink:0; min-height:30px; font-size:12px; }
.creator-field { display:block; margin:10px 0; }
.creator-field > span { display:block; font-size:11px; color:var(--muted); margin-bottom:4px; }
.creator-field textarea, .creator-field input { width:100%; box-sizing:border-box; font:12px/1.7 var(--font-ui, sans-serif); color:var(--text); background:var(--selected,rgba(127,127,127,.08)); border:1px solid transparent; border-radius:8px; padding:8px 10px; resize:vertical; }
.creator-field textarea:focus, .creator-field input:focus { border-color:var(--line); outline:none; }
.creator-field.edited > span::after { content:" · 已修改"; color:var(--text); }
.creator-message { margin-bottom:24px; overflow-wrap:anywhere; }
#creatorOlder { display:block; margin:0 auto 24px; }
.creator-message > small { color:var(--muted); font-size:11px; }
.creator-message > p { white-space:pre-wrap; font-size:14px; line-height:1.85; margin:8px 0 0; }
.creator-message.user { margin-left:auto; width:fit-content; max-width:90%; padding:12px 16px; border-radius:14px 14px 4px 14px; background:var(--text); color:var(--panel); }
.creator-message.user > p { margin:0; }
.creator-message.system { color:var(--muted); border-left:2px solid var(--line); padding-left:12px; }
.creator-message.system > p { font-size:12px; }
.creator-composer { margin:0 20px 18px; border:1px solid var(--line); border-radius:14px; padding:12px; }
.creator-composer textarea { width:100%; border:0; resize:vertical; min-height:68px; max-height:200px; background:transparent; color:var(--text); padding:0 2px; box-shadow:none; font-size:14px; line-height:1.6; }
.creator-compose-actions { display:flex; gap:8px; align-items:center; margin-top:10px; }
.creator-compose-actions span { margin-right:auto; font-size:11px; color:var(--muted); }
.creator-compose-actions button { min-width:36px; height:34px; border-radius:9px; }
#creatorSend { background:var(--text); color:var(--panel); border:0; }
#creatorStatus { margin:0; padding:0 22px 12px; color:var(--muted); font-size:12px; min-height:24px; }
.creator-review { display:block; overflow-y:auto; min-width:0; padding:24px 20px; border-left:1px solid var(--line); }
.creator-review h4 { margin:0 0 8px; font-size:13px; font-weight:600; }
.creator-review > p { margin:0 0 24px; font-size:12px; color:var(--muted); line-height:1.8; }
.creator-proposal { padding:18px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
.creator-proposal > small { font-size:11px; color:var(--muted); }
.creator-proposal h5 { font-size:14px; line-height:1.6; margin:6px 0; }
.creator-proposal p, .creator-proposal summary { font-size:12px; line-height:1.8; color:var(--muted); }
.creator-proposal summary { cursor:pointer; padding-block:5px; }
.creator-proposal pre { white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.8 var(--font-ui, sans-serif); margin:8px 0; }
.creator-diff { margin:10px 0; padding:10px; background:var(--selected,rgba(127,127,127,.08)); border-radius:8px; }
.creator-diff strong, .creator-diff small { display:block; font-size:11px; color:var(--muted); }
.creator-proposal-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
.creator-proposal-actions button { min-height:32px; font-size:12px; }
.creator-review-empty { padding:20px 0; font-size:12px; color:var(--muted); line-height:1.9; }
@media(max-width:1100px) {
 .creator-layout { grid-template-columns:168px minmax(0,1fr) 280px; }
}
@media(max-width:900px) {
 .creator-layout { grid-template-columns:minmax(0,1fr); height:auto; }
 .creator-sessions { flex-direction:row; border-right:0; border-bottom:1px solid var(--line); overflow-x:auto; overflow-y:hidden; padding:8px 10px; }
 .creator-sessions-head { padding:0 4px; } .creator-sessions-head > span { display:none; }
 .creator-session { width:auto; max-width:180px; flex-shrink:0; }
 .creator-sessions-empty { display:none; }
 .creator-start-options { grid-template-columns:1fr; }
 .creator-conversation { height:600px; max-height:78dvh; }
 .creator-review { border-left:0; border-top:1px solid var(--line); max-height:65dvh; }
 .creator-heading { padding:18px; } .creator-heading p { max-width:210px; line-height:1.7; }
 .creator-heading > button { font-size:12px; } .creator-composer { margin-inline:14px; }
 .management-tabs { display:flex; overflow-x:auto; max-width:100%; } .management-tabs button { flex-shrink:0; }
}
`;

export const creatorHtml = `
<section id="creatorPanel" class="management-panel" hidden>
  <div class="creator-heading"><span class="creator-avatar" aria-hidden="true"><i data-lucide="feather"></i></span>
    <div><h3>创作助手</h3><p>世界之外的编辑 · 使用默认模型</p></div><button id="creatorRefresh" class="secondary" type="button">刷新</button>
  </div>
  <div class="creator-layout">
    <nav id="creatorSessions" class="creator-sessions" aria-label="创作助手会话"></nav>
    <div class="creator-conversation">
      <div id="creatorMessages" class="creator-messages" aria-label="创作助手管理记录"></div>
      <p id="creatorStatus" role="status" aria-live="polite"></p>
      <form id="creatorForm" class="creator-composer">
        <textarea id="creatorInput" rows="2" maxlength="8000" required aria-label="给创作助手的消息" placeholder="说说你想创造或调整的世界…"></textarea>
        <div class="creator-compose-actions"><span id="creatorModeHint">独立记录，不进入角色记忆</span><button id="creatorBuilderToggle" class="secondary" type="button" aria-pressed="false" title="开启一个新的一键建构会话"><i data-lucide="sparkles" aria-hidden="true"></i>一键建构</button><button id="creatorCancel" class="secondary" type="button" hidden>停止</button><button id="creatorSend" type="submit" aria-label="发送给创作助手"><i data-lucide="arrow-up" aria-hidden="true"></i></button></div>
      </form>
    </div>
    <aside class="creator-review" aria-label="变更审核"><h4 id="creatorReviewTitle">变更草案</h4><p>先查看，再确认。可以直接修改草案内容；讨论本身不会改变世界。</p><div id="creatorReviewBar" class="creator-review-bar" hidden><span id="creatorPendingCount"></span><button id="creatorApplyAll" class="primary" type="button">全部应用</button></div><div id="creatorProposals"></div></aside>
  </div>
</section>`;

export const creatorScript = String.raw`
    let creatorSnapshot = null;
    let creatorSending = false;
    let creatorLoading = false;
    let creatorRefreshSequence = 0;
    let creatorViewGeneration = 0;
    let creatorPollTimer = null;
    let creatorReloadPending = false;
    // The view a send started from; a send keeps running when the user switches away.
    let creatorSendingGeneration = -1;
    // A failed first send may still have been recorded; resending the same text reuses its request id.
    let creatorRetry = null;
    // sessionId: an existing session; draft: a new session that is created by its first message.
    // Neither set is the start page.
    let creatorView = { sessionId: null, draft: null };
    const creatorViewKey = "yourchar.creator.view";
    try { const saved = localStorage.getItem(creatorViewKey); if (saved && saved !== "home") creatorView.sessionId = saved; } catch { /* Start page. */ }
    const creatorLabels = { create_world:"创建世界", update_world:"修改世界", create_character:"创建角色", update_character:"修改角色",
      create_place:"新增地点", update_place:"修改地点", assign_character:"调整世界归属", update_autonomy:"调整自主生活" };
    const creatorStatuses = { pending:"待确认", applied:"已应用", rejected:"已撤销", stale:"已过期", applying:"应用中", interrupted:"中断 · 待核对", failed:"未完成 · 待核对" };
    const creatorFields = { name:"名称", description:"描述", rulesMarkdown:"世界规则", timezone:"时区", soulMarkdown:"完整角色设定 · SOUL",
      capabilityIds:"地点能力", characterId:"角色 ID", worldId:"世界 ID", homePlaceId:"居所 ID", currentPlaceId:"当前位置 ID",
      enabled:"自主生活", proactiveEnabled:"主动消息", socialEnabled:"角色社交", dailyMessageLimit:"每日消息上限", socialDailyLimit:"每日社交上限", quietStart:"安静时段开始", quietEnd:"安静时段结束" };
    const creatorEl = id => document.getElementById(id);
    const creatorEditable = new Set(["name", "description", "rulesMarkdown", "timezone", "soulMarkdown"]);
    const creatorEdits = new Map();
    const creatorVisible = () => state.uiMode === "management" && state.managementTab === "creator" && !incognitoConversationIsActive();
    const creatorOnStartPage = () => !creatorView.sessionId && !creatorView.draft;
    function rememberCreatorView() {
      try { localStorage.setItem(creatorViewKey, creatorView.sessionId || "home"); } catch { /* Per-viewer convenience only. */ }
    }
    function setCreatorView(next) {
      creatorView = { sessionId: next.sessionId || null, draft: next.sessionId ? null : next.draft || null };
      creatorViewGeneration++; creatorRefreshSequence++; clearTimeout(creatorPollTimer);
      if (!creatorView.draft) rememberCreatorView();
      creatorEl("creatorStatus").textContent = creatorIdleStatus();
      applyCreatorComposerMode();
    }
    function openCreatorStart() { setCreatorView({}); if (creatorSnapshot) { creatorSnapshot = { ...creatorSnapshot, messages: [], before: null }; renderCreator(); } void loadCreator(); }
    function openCreatorSession(id) {
      setCreatorView({ sessionId: id });
      // Never show the previous session's transcript under the newly selected one while it loads.
      if (creatorSnapshot) { creatorSnapshot = { ...creatorSnapshot, sessionId: id, messages: [], before: null, proposals: [] }; renderCreator(); }
      void loadCreator();
    }
    function startCreatorDraft(mode, text = "") {
      setCreatorView({ draft: mode });
      if (creatorSnapshot) { creatorSnapshot = { ...creatorSnapshot, sessionId: null, session: null, messages: [], before: null }; renderCreator(); }
      const input = creatorEl("creatorInput");
      if (text) input.value = text;
      input.focus();
    }
    function applyCreatorComposerMode() {
      const builder = creatorView.draft === "world_builder";
      creatorEl("creatorBuilderToggle").setAttribute("aria-pressed", String(builder));
      const input = creatorEl("creatorInput");
      creatorEl("creatorForm").classList.toggle("builder-mode", builder);
      input.setAttribute("rows", builder ? "4" : "2");
      input.setAttribute("placeholder", builder ? "描述你的世界灵感，一句话就够——例如：废土星球上最后一座图书馆的守护者" : "说说你想创造或调整的世界…");
      const hint = creatorEl("creatorModeHint");
      hint.classList.toggle("creator-mode-hint", builder);
      hint.textContent = builder ? "✦ 新的一键建构会话：一句灵感，生成世界与角色草案" : creatorView.draft ? "新会话 · 独立记录，不进入角色记忆" : "独立记录，不进入角色记忆";
    }
    function clearCreatorView() {
      creatorView = { sessionId: null, draft: null }; rememberCreatorView();
      creatorViewGeneration++; creatorRefreshSequence++; clearTimeout(creatorPollTimer);
      creatorSnapshot = null;
      creatorEl("creatorMessages").replaceChildren(); creatorEl("creatorProposals").replaceChildren(); creatorEl("creatorSessions").replaceChildren(); creatorEdits.clear();
      creatorEl("creatorInput").value = ""; creatorEl("creatorStatus").textContent = "";
      applyCreatorComposerMode(); creatorButtons();
    }
    async function creatorApi(path, body = {}) {
      const response = await controlPlaneFetch("/api/v1/creator/" + path, { method:"POST", body:JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || "创作助手暂时不可用"); error.status = response.status; throw error; }
      return result;
    }
    document.getElementById("creatorTabBtn").addEventListener("click", () => setManagementTab("creator"));
    creatorEl("creatorRefresh").addEventListener("click", () => void loadCreator());
    creatorEl("creatorCancel").addEventListener("click", async () => {
      try { await creatorApi("cancel"); creatorEl("creatorStatus").textContent = "正在停止…"; }
      catch(error) { creatorEl("creatorStatus").textContent = error.message; }
    });
    creatorEl("creatorInput").addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !creatorEl("creatorSend").disabled) { event.preventDefault(); creatorEl("creatorForm").requestSubmit(); }
    });
    creatorEl("creatorForm").addEventListener("submit", event => { event.preventDefault(); void sendCreator(); });
    creatorEl("creatorSessions").addEventListener("click", event => {
      if (event.target.closest("[data-creator-home]")) return openCreatorStart();
      if (event.target.closest("[data-creator-new]")) return startCreatorDraft("chat");
      const session = event.target.closest("[data-creator-session]");
      if (session) openCreatorSession(session.dataset.creatorSession);
    });
    creatorEl("creatorMessages").addEventListener("click", event => {
      const start = event.target.closest("[data-creator-start]");
      if (start) return startCreatorDraft(start.dataset.creatorStart);
      const example = event.target.closest("[data-creator-example]");
      if (example) return startCreatorDraft(example.dataset.creatorExample || "chat", example.textContent.trim());
      if (event.target.closest("#creatorOlder")) void loadCreator(true);
    });
    creatorEl("creatorBuilderToggle").addEventListener("click", () => creatorView.draft === "world_builder" ? startCreatorDraft("chat") : startCreatorDraft("world_builder"));
    creatorEl("creatorProposals").addEventListener("click", event => {
      const link = event.target.closest("[data-creator-open-session]");
      if (link) { event.preventDefault(); return openCreatorSession(link.dataset.creatorOpenSession); }
      const applySession = event.target.closest("[data-creator-apply-session]");
      if (applySession) return void applyAllCreator(applySession.dataset.creatorApplySession, applySession);
      void reviewCreator(event);
    });
    creatorEl("creatorProposals").addEventListener("input", event => {
      const field = event.target.closest("[data-creator-field]");
      if (!field) return;
      const id = field.closest("[data-proposal-id]").dataset.proposalId;
      const edits = creatorEdits.get(id) || {};
      if (field.value === field.dataset.original) delete edits[field.dataset.creatorField]; else edits[field.dataset.creatorField] = field.value;
      if (Object.keys(edits).length) creatorEdits.set(id, edits); else creatorEdits.delete(id);
      field.closest(".creator-field").classList.toggle("edited", field.value !== field.dataset.original);
    });
    creatorEl("creatorApplyAll").addEventListener("click", () => void applyAllCreator());
    function creatorButtons() {
      const busy = creatorSending || creatorSnapshot?.busy;
      creatorEl("creatorSend").disabled = Boolean(busy || creatorLoading || !creatorSnapshot);
      creatorEl("creatorCancel").hidden = !busy;
      creatorEl("creatorInput").disabled = Boolean(busy);
      creatorEl("creatorProposals").querySelectorAll("[data-creator-review], [data-creator-apply-session]").forEach(button => { button.disabled = Boolean(busy || creatorLoading); });
      creatorEl("creatorApplyAll").disabled = Boolean(busy || creatorLoading);
    }
    function creatorIdleStatus() {
      if (creatorSending && creatorSendingGeneration !== creatorViewGeneration) return "另一个会话正在回复，完成后可以继续。";
      if (creatorSnapshot?.busy && creatorSnapshot.activeSessionId !== creatorView.sessionId) return "另一个会话正在回复，完成后可以继续。";
      if (creatorSnapshot?.busy) return "正在整理思路与变更草案…";
      return "可编辑角色与世界；不读取私聊，不开放删除和 MCP 安装。";
    }
    async function loadCreator(older = false) {
      if (!creatorVisible()) return;
      // A view switch during a load must not be dropped: reload once the current load settles.
      if (creatorLoading) { creatorReloadPending = true; return; }
      creatorLoading = true; creatorButtons();
      let sequence = ++creatorRefreshSequence;
      const list = creatorEl("creatorMessages");
      const height = list.scrollHeight;
      try {
        const body = { sessionId: creatorView.sessionId, ...(older && creatorSnapshot?.before ? { before: creatorSnapshot.before } : {}) };
        let result;
        try { result = await creatorApi("snapshot", body); }
        catch(error) {
          // A remembered session can disappear (data reset); fall back to the start page.
          if (error.status !== 404 || !creatorView.sessionId) throw error;
          setCreatorView({}); sequence = creatorRefreshSequence;
          result = await creatorApi("snapshot", { sessionId: null });
        }
        if (sequence !== creatorRefreshSequence || !creatorVisible()) return;
        if (older && creatorSnapshot) result.messages = [...result.messages, ...creatorSnapshot.messages];
        if (creatorView.draft) result = { ...result, messages: creatorSnapshot?.messages?.filter(message => message.optimistic) || [] };
        creatorSnapshot = result; renderCreator();
        if (older) list.scrollTop = list.scrollHeight - height;
        if (!creatorSending || creatorSendingGeneration !== creatorViewGeneration) creatorEl("creatorStatus").textContent = creatorIdleStatus();
      } catch(error) { if (creatorVisible()) creatorEl("creatorStatus").textContent = error.message; }
      finally {
        creatorLoading = false; creatorButtons(); clearTimeout(creatorPollTimer);
        if (creatorReloadPending) { creatorReloadPending = false; void loadCreator(); }
        else if (creatorVisible() && creatorSnapshot?.busy && !creatorSending) creatorPollTimer = setTimeout(() => void loadCreator(), 2000);
      }
    }
    function renderCreatorSessions() {
      const sessions = creatorSnapshot?.sessions || [];
      const item = (attrs, icon, title, current, extra = "") => '<button type="button" class="creator-session" ' + attrs + ' aria-current="' + current + '">' +
        '<i data-lucide="' + icon + '" aria-hidden="true"></i><span>' + escapeHtml(title) + '</span>' + extra + '</button>';
      creatorEl("creatorSessions").innerHTML = item("data-creator-home", "house", "开始", creatorOnStartPage()) +
        '<div class="creator-sessions-head"><span>会话</span><button type="button" class="secondary" data-creator-new>新会话</button></div>' +
        (creatorView.draft ? item("data-creator-draft", creatorView.draft === "world_builder" ? "sparkles" : "message-circle", creatorView.draft === "world_builder" ? "新的一键建构" : "新会话", true) : '') +
        (sessions.length ? sessions.map(session => item('data-creator-session="' + escapeHtml(session.id) + '" title="' + escapeHtml(session.title) + '"',
          session.mode === "world_builder" ? "sparkles" : "message-circle", session.title, session.id === creatorView.sessionId,
          creatorSnapshot.busy && creatorSnapshot.activeSessionId === session.id ? '<b class="creator-busy-dot" aria-label="正在回复"></b>'
            : session.pendingCount ? '<em aria-label="' + session.pendingCount + ' 份待确认">' + session.pendingCount + '</em>' : '')).join('')
          : (creatorView.draft ? '' : '<div class="creator-sessions-empty">还没有会话。从“开始”选一种方式吧。</div>'));
    }
    function creatorStartPage() {
      return '<div class="creator-empty"><small>YOUR WORLD, YOUR WAY</small><h4>让世界，从一个想法开始。</h4>' +
        '<p>角色的性格、街角的书店，或一段更自然的日常。选一种方式开始，每次都会开启一个独立会话。</p>' +
        '<div class="creator-start-options">' +
          '<button type="button" class="creator-start-option featured" data-creator-start="world_builder"><strong><i data-lucide="sparkles" aria-hidden="true"></i>一键建构世界与角色</strong><span>只说一句灵感，直接生成世界与角色草案，确认后生效。</span></button>' +
          '<button type="button" class="creator-start-option" data-creator-start="chat"><strong><i data-lucide="message-circle" aria-hidden="true"></i>自由对话</strong><span>和创作助手商量设定，慢慢打磨角色、世界与地点。</span></button>' +
        '</div>' +
        '<div class="creator-examples"><small>试试这些</small>' +
          '<button type="button" data-creator-example="world_builder">我穿越到了《命运石之门》的世界，和主角们一起冒险</button>' +
          '<button type="button" data-creator-example="chat">设计一位住在海边、经营旧书店的角色</button>' +
          '<button type="button" data-creator-example="chat">看看我现有的世界，有哪些可以完善的地方？</button>' +
        '</div></div>';
    }
    function creatorDraftIntro() {
      return creatorView.draft === "world_builder"
        ? '<div class="creator-empty"><small>一键建构</small><h4>一句灵感就够了。</h4><p>在下方写下你的灵感。创作助手会搭好世界和主要角色的草案，你在右侧确认后才会生效。确认世界后发送“继续”，再补上地点和角色的落脚处。</p></div>'
        : '<div class="creator-empty"><small>新会话</small><h4>想创造或调整什么？</h4><p>这是一个独立会话，不会带上其他会话的记录。</p></div>';
    }
    function renderCreator() {
      if (!creatorSnapshot) return;
      renderCreatorSessions();
      const messages = creatorSnapshot.messages || [];
      const replyingHere = creatorSending && creatorSendingGeneration === creatorViewGeneration || creatorSnapshot.busy && creatorSnapshot.activeSessionId && creatorSnapshot.activeSessionId === creatorView.sessionId;
      creatorEl("creatorMessages").innerHTML = (creatorSnapshot.before ? '<button id="creatorOlder" class="secondary" type="button">查看更早记录</button>' : '') +
        (messages.length ? messages.map(message => '<article class="creator-message ' + escapeHtml(message.role) + '">' +
          (message.role === "assistant" ? '<small>创作助手</small><div class="markdown-body">' + renderMarkdown(message.text) + '</div>' : '<p>' + escapeHtml(creatorDisplayText(message)) + '</p>') + '</article>').join('') +
          (replyingHere ? '<article class="creator-message assistant pending"><small>创作助手</small><p>正在构思设定与草案…</p></article>' : '') :
        creatorOnStartPage() ? creatorStartPage() : creatorView.draft ? creatorDraftIntro() : '');
      // A draft session has no drafts yet; the start page gathers pending drafts from every session.
      const proposals = creatorView.draft ? [] : creatorSnapshot.proposals;
      const sessionTitles = Object.fromEntries((creatorSnapshot.sessions || []).map(session => [session.id, session.title]));
      creatorEl("creatorReviewTitle").textContent = creatorOnStartPage() ? "全部待确认草案" : "变更草案";
      const pendingCount = proposals.filter(proposal => proposal.status === "pending").length;
      // The start page gathers drafts from every session, so it only offers per-draft confirmation.
      creatorEl("creatorReviewBar").hidden = pendingCount < 2 || creatorOnStartPage();
      creatorEl("creatorPendingCount").textContent = pendingCount + " 份待确认";
      for (const id of creatorEdits.keys()) if (!creatorSnapshot.proposals.some(proposal => proposal.id === id && proposal.status === "pending")) creatorEdits.delete(id);
      const focused = document.activeElement?.closest?.("[data-creator-field]");
      const focus = focused ? { id: focused.closest("[data-proposal-id]").dataset.proposalId, field: focused.dataset.creatorField,
        start: focused.selectionStart, end: focused.selectionEnd, scroll: focused.scrollTop } : null;
      const proposalCard = proposal => {
        const op = proposal.operation;
        const fields = op.patch || op.input || Object.fromEntries(Object.entries(op).filter(([key]) => key !== "kind"));
        let old = proposal.before || {};
        if (op.kind === "update_autonomy") old = old.autonomy || {};
        const pending = proposal.status === "pending";
        const blocked = creatorSending || creatorSnapshot.busy;
        const edits = creatorEdits.get(proposal.id) || {};
        const editable = pending && (op.input || op.patch);
        const fieldHtml = ([key,value]) => {
          if (editable && creatorEditable.has(key) && typeof value === "string") {
            const current = key in edits ? edits[key] : value;
            const long = key === "soulMarkdown" || key === "rulesMarkdown" || key === "description";
            const control = long
              ? '<textarea data-creator-field="' + escapeHtml(key) + '" data-original="' + escapeHtml(value) + '" rows="' + (key === "soulMarkdown" ? 10 : 4) + '">\n' + escapeHtml(current) + '</textarea>'
              : '<input data-creator-field="' + escapeHtml(key) + '" data-original="' + escapeHtml(value) + '" value="' + escapeHtml(current) + '" />';
            return '<label class="creator-field' + (key in edits ? ' edited' : '') + '"><span>' + escapeHtml(creatorFields[key] || key) + '</span>' +
              (op.patch ? '<small>原值</small><pre>' + escapeHtml(creatorValue(old[key])) + '</pre>' : '') + control + '</label>';
          }
          return '<div class="creator-diff"><strong>' + escapeHtml(creatorFields[key] || key) + '</strong>' +
            (op.patch ? '<small>原值</small><pre>' + escapeHtml(creatorValue(old[key])) + '</pre><small>修改为</small>' : '') + '<pre>' + escapeHtml(creatorValue(value)) + '</pre></div>';
        };
        return '<article class="creator-proposal" data-proposal-id="' + escapeHtml(proposal.id) + '"><small>' + escapeHtml(creatorLabels[op.kind]) + ' · ' + escapeHtml(creatorStatuses[proposal.status]) + '</small><h5>' + escapeHtml(proposal.title) + '</h5><p>' + escapeHtml(proposal.reason) + '</p>' +
          (pending ? '<div class="creator-proposal-actions"><button class="primary" type="button" data-creator-review="apply"' + (blocked?' disabled':'') + '>确认应用</button><button class="secondary" type="button" data-creator-review="reject"' + (blocked?' disabled':'') + '>撤销草案</button></div>' : '') +
          '<details' + (Object.keys(edits).length ? ' open' : '') + '><summary>' + (editable ? '查看与修改内容' : '查看变更') + '</summary>' + Object.entries(fields).map(fieldHtml).join('') +
          '<details><summary>目标与原始快照</summary><pre>' + escapeHtml(JSON.stringify(proposal.before, null, 2)) + '</pre></details></details>' +
          (proposal.error ? '<p>' + escapeHtml(proposal.error) + '</p>' : '') +
          (proposal.result ? '<details><summary>执行回执</summary><pre>' + escapeHtml(JSON.stringify(proposal.result, null, 2)) + '</pre></details>' : '') + '</article>';
      };
      // The start page groups pending drafts by session, in the sidebar's order, each with its own "apply all".
      const groupHtml = () => {
        const order = (creatorSnapshot.sessions || []).map(session => session.id);
        const groups = new Map();
        for (const proposal of proposals) {
          const key = proposal.sessionId || "";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(proposal);
        }
        const rank = key => { const index = order.indexOf(key); return index < 0 ? order.length : index; };
        return [...groups.entries()].sort(([left], [right]) => rank(left) - rank(right)).map(([sessionId, items]) =>
          '<section class="creator-proposal-group" data-creator-group="' + escapeHtml(sessionId) + '"><header>' +
            (sessionId ? '<a href="#" data-creator-open-session="' + escapeHtml(sessionId) + '" title="打开这个会话">' + escapeHtml(sessionTitles[sessionId] || "会话") + '</a>' : '<a>其他</a>') +
            '<span>' + items.length + ' 份待确认</span>' +
            (sessionId && items.length > 1 ? '<button class="primary" type="button" data-creator-apply-session="' + escapeHtml(sessionId) + '"' + (creatorSending || creatorSnapshot.busy ? ' disabled' : '') + '>全部应用</button>' : '') +
          '</header>' + items.map(proposalCard).join('') + '</section>').join('');
      };
      creatorEl("creatorProposals").innerHTML = (creatorOnStartPage() ? groupHtml() : proposals.map(proposalCard).join('')) ||
        '<div class="creator-review-empty">' + (creatorOnStartPage() ? '所有会话都没有待确认的草案。' : '这个会话还没有变更草案。<br />需要修改时，我会把具体内容放在这里，等你确认。') + '</div>';
      // Polling re-renders the panel; keep the caret of a field being edited.
      const restored = focus && [...creatorEl("creatorProposals").querySelectorAll("[data-creator-field]")]
        .find(field => field.dataset.creatorField === focus.field && field.closest("[data-proposal-id]").dataset.proposalId === focus.id);
      if (restored) { restored.focus(); restored.setSelectionRange(focus.start, focus.end); restored.scrollTop = focus.scroll; }
      refreshIcons(); creatorButtons();
    }
    // Transcripts saved before the instruction moved server-side still carry it; show only the user's words.
    function creatorDisplayText(message) {
      const text = String(message.text || "");
      if (message.role !== "user" || !text.startsWith("[WORLD_BUILDER_MODE]")) return text;
      const marker = text.lastIndexOf("用户灵感：");
      return marker < 0 ? text : text.slice(marker + "用户灵感：".length).trim();
    }
    function creatorValue(value) { return value === undefined || value === null ? "未设置" : typeof value === "boolean" ? (value ? "开启" : "关闭") : typeof value === "string" ? value : JSON.stringify(value, null, 2); }
    async function sendCreator() {
      const raw = creatorEl("creatorInput").value.trim();
      if (!raw || creatorSending || creatorSnapshot?.busy || creatorLoading || !creatorVisible()) return;
      // Typing on the start page starts an ordinary new session.
      if (creatorOnStartPage()) setCreatorView({ draft: "chat" });
      const target = creatorView.sessionId ? { sessionId: creatorView.sessionId } : { newSession: true, mode: creatorView.draft || "chat" };
      const draftMode = creatorView.draft;
      const sameRetry = creatorRetry && creatorRetry.raw === raw && creatorRetry.sessionId === creatorView.sessionId && creatorRetry.draft === draftMode;
      const requestId = sameRetry ? creatorRetry.requestId : crypto.randomUUID();
      creatorRetry = null;
      const generation = creatorViewGeneration;
      creatorSending = true; creatorSendingGeneration = generation;
      creatorEl("creatorInput").value = "";
      creatorSnapshot = { ...creatorSnapshot, messages: [...(creatorSnapshot.messages || []), { role:"user", text:raw, optimistic:true }] };
      renderCreator();
      creatorEl("creatorMessages").scrollTop = creatorEl("creatorMessages").scrollHeight;
      creatorEl("creatorStatus").textContent = "";
      try {
        const result = await creatorApi("messages", { text:raw, requestId, ...target });
        if (generation !== creatorViewGeneration) return;
        creatorRetry = null;
        creatorView = { sessionId: result.sessionId, draft: null }; rememberCreatorView(); applyCreatorComposerMode();
        if (creatorVisible()) {
          creatorSnapshot = result; renderCreator();
          creatorEl("creatorMessages").scrollTop = creatorEl("creatorMessages").scrollHeight;
          creatorEl("creatorStatus").textContent = result.status === "completed" ? "回复完成。草案需要你确认后才会生效。" : result.status === "partial" ? "本轮在上限处停下，已提出的草案已保留。" : "本轮未完成，没有自动应用变更。";
        }
      } catch(error) {
        if (generation === creatorViewGeneration && creatorVisible()) {
          creatorSending = false;
          if (creatorSnapshot) creatorSnapshot = { ...creatorSnapshot, messages: (creatorSnapshot.messages || []).filter(message => !message.optimistic) };
          await loadCreator();
          // If the server never recorded the message, give the user's words back instead of losing them.
          const lastUser = (creatorSnapshot?.messages || []).filter(message => message.role === "user").at(-1);
          const recorded = Boolean(creatorView.sessionId) && lastUser && creatorDisplayText(lastUser) === raw;
          if (!recorded && !creatorEl("creatorInput").value) {
            if (draftMode && !creatorView.sessionId && creatorView.draft !== draftMode) startCreatorDraft(draftMode);
            creatorEl("creatorInput").value = raw;
            creatorRetry = { raw, requestId, sessionId: creatorView.sessionId, draft: creatorView.draft };
          }
          creatorEl("creatorStatus").textContent = error.message + (recorded ? "；请刷新核对结果后再发送，避免重复请求。" : "；内容已放回输入框，可以直接重新发送。");
        }
      } finally {
        creatorSending = false; creatorSendingGeneration = -1; creatorButtons();
        // If the user switched views meanwhile, refresh so the sidebar shows the new or updated session.
        if (creatorVisible()) { renderCreator(); if (creatorSnapshot?.busy || generation !== creatorViewGeneration) void loadCreator(); }
      }
    }
    async function reviewCreator(event) {
      const button = event.target.closest("[data-creator-review]");
      if (!button || button.disabled || !creatorVisible()) return;
      const proposal = creatorSnapshot?.proposals.find(value => value.id === button.closest("[data-proposal-id]").dataset.proposalId);
      if (!proposal) return;
      const action = button.dataset.creatorReview;
      await openActionDialog({ title: action === "apply" ? "应用这份创作草案？" : "撤销这份草案？",
        description: proposal.title + (action === "apply" ? "。只应用刚才预览的这一份变更，不会自动执行后续步骤。" : "。角色和世界不会发生变化。"),
        confirmLabel: action === "apply" ? "确认应用" : "撤销草案", opener:button,
        onConfirm: async () => {
          // Re-read on every attempt: a failed attempt refreshes the snapshot, so retries use the current digest.
          const current = creatorSnapshot?.proposals.find(value => value.id === proposal.id) || proposal;
          const edits = action === "apply" ? creatorEdits.get(current.id) : undefined;
          try { await creatorApi("review", { id:current.id, digest:current.digest, action, ...(edits ? { edits } : {}) }); }
          catch(error) { await loadCreator(); throw error; }
          creatorEdits.delete(current.id); await loadCreator(); void loadCharacters();
        } });
    }
    /** Applies one session's pending drafts: the current session, or the group chosen on the start page. */
    async function applyAllCreator(sessionId = creatorView.sessionId, opener = creatorEl("creatorApplyAll")) {
      if (!sessionId || !creatorVisible()) return;
      // The snapshot lists pending drafts newest first (by insertion), so reverse for proposal order.
      const pending = (creatorView.draft ? [] : creatorSnapshot?.proposals || [])
        .filter(proposal => proposal.status === "pending" && proposal.sessionId === sessionId).reverse();
      if (!pending.length) return;
      const title = (creatorSnapshot.sessions || []).find(session => session.id === sessionId)?.title;
      await openActionDialog({ title: "应用全部 " + pending.length + " 份草案？",
        description: (creatorOnStartPage() && title ? "只应用会话「" + title + "」里的草案。" : "") + "按提出顺序逐份应用，包括你在草案里做的修改。某一份失败时会停下，已应用的不会回滚。",
        confirmLabel: "全部应用", opener,
        onConfirm: async () => {
          try {
            for (const { id } of pending) {
              const proposal = creatorSnapshot?.proposals.find(value => value.id === id);
              if (!proposal || proposal.status !== "pending") continue;
              const edits = creatorEdits.get(proposal.id);
              try { await creatorApi("review", { id:proposal.id, digest:proposal.digest, action:"apply", ...(edits ? { edits } : {}) }); }
              catch(error) { throw new Error("「" + proposal.title + "」未能应用：" + error.message); }
              creatorEdits.delete(proposal.id);
            }
          } finally { await loadCreator(); void loadCharacters(); }
        } });
    }
`;
