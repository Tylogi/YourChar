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
.creator-layout { display:grid; grid-template-columns:minmax(0,1fr) 330px; height:clamp(510px,69vh,880px); }
.creator-conversation { display:flex; flex-direction:column; min-width:0; min-height:0; }
.creator-messages { flex:1; overflow-y:auto; min-height:0; padding:24px clamp(18px,3vw,40px); scroll-behavior:auto; }
.creator-empty { display:grid; gap:14px; align-content:center; min-height:300px; max-width:440px; margin:auto; }
.creator-empty small { color:var(--muted); letter-spacing:.12em; font-size:10px; }
.creator-empty h4 { font-size:25px; font-weight:550; letter-spacing:-.6px; margin:0; line-height:1.5; }
.creator-empty p { color:var(--muted); font-size:13px; line-height:1.9; margin:0 0 10px; }
.creator-empty button { background:transparent; text-align:left; color:var(--text); border:1px solid var(--line); padding:13px 15px; border-radius:10px; font-size:13px; }
.creator-message { margin-bottom:24px; overflow-wrap:anywhere; }
.creator-message > small { color:var(--muted); font-size:11px; }
.creator-message > p { white-space:pre-wrap; font-size:14px; line-height:1.85; margin:8px 0 0; }
.creator-message.user { margin-left:auto; width:fit-content; max-width:90%; padding:12px 16px; border-radius:14px 14px 4px 14px; background:var(--text); color:var(--panel); }
.creator-message.user > p { margin:0; }
.creator-message.system { color:var(--muted); border-left:2px solid var(--line); padding-left:12px; }
.creator-message.system > p { font-size:12px; }
.creator-composer { margin:0 20px 18px; border:1px solid var(--line); border-radius:14px; padding:12px; }
.creator-composer textarea { width:100%; border:0; resize:vertical; min-height:68px; max-height:200px; background:transparent; color:var(--text); padding:0 2px; box-shadow:none; font-size:14px; line-height:1.6; }
.creator-compose-actions { display:flex; gap:8px; align-items:center; }
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
@media(max-width:900px) {
 .creator-layout { grid-template-columns:minmax(0,1fr); height:auto; }
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
    <div class="creator-conversation">
      <div id="creatorMessages" class="creator-messages" aria-label="创作助手管理记录"></div>
      <p id="creatorStatus" role="status" aria-live="polite"></p>
      <form id="creatorForm" class="creator-composer">
        <textarea id="creatorInput" rows="2" maxlength="8000" required aria-label="给创作助手的消息" placeholder="说说你想创造或调整的世界…"></textarea>
        <div class="creator-compose-actions"><span>独立记录，不进入角色记忆</span><button id="creatorCancel" class="secondary" type="button" hidden>停止</button><button id="creatorSend" type="submit" aria-label="发送给创作助手"><i data-lucide="arrow-up" aria-hidden="true"></i></button></div>
      </form>
    </div>
    <aside class="creator-review" aria-label="变更审核"><h4>变更草案</h4><p>先查看，再确认。每份草案独立应用，讨论本身不会改变世界。</p><div id="creatorProposals"></div></aside>
  </div>
</section>`;

export const creatorScript = String.raw`
    let creatorSnapshot = null;
    let creatorSending = false;
    let creatorLoading = false;
    let creatorRefreshSequence = 0;
    let creatorViewGeneration = 0;
    let creatorPollTimer = null;
    const creatorLabels = { create_world:"创建世界", update_world:"修改世界", create_character:"创建角色", update_character:"修改角色",
      create_place:"新增地点", update_place:"修改地点", assign_character:"调整世界归属", update_autonomy:"调整自主生活" };
    const creatorStatuses = { pending:"待确认", applied:"已应用", rejected:"已撤销", stale:"已过期", applying:"应用中", interrupted:"中断 · 待核对", failed:"未完成 · 待核对" };
    const creatorFields = { name:"名称", description:"描述", rulesMarkdown:"世界规则", timezone:"时区", soulMarkdown:"完整角色设定 · SOUL",
      capabilityIds:"地点能力", characterId:"角色 ID", worldId:"世界 ID", homePlaceId:"居所 ID", currentPlaceId:"当前位置 ID",
      enabled:"自主生活", proactiveEnabled:"主动消息", socialEnabled:"角色社交", dailyMessageLimit:"每日消息上限", socialDailyLimit:"每日社交上限", quietStart:"安静时段开始", quietEnd:"安静时段结束" };
    const creatorEl = id => document.getElementById(id);
    const creatorVisible = () => state.uiMode === "management" && state.managementTab === "creator" && !incognitoConversationIsActive();
    function clearCreatorView() {
      creatorViewGeneration++; creatorRefreshSequence++; clearTimeout(creatorPollTimer);
      creatorSnapshot = null;
      creatorEl("creatorMessages").replaceChildren(); creatorEl("creatorProposals").replaceChildren();
      creatorEl("creatorInput").value = ""; creatorEl("creatorStatus").textContent = "";
      creatorButtons();
    }
    async function creatorApi(path, body = {}) {
      const response = await controlPlaneFetch("/api/v1/creator/" + path, { method:"POST", body:JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "创作助手暂时不可用");
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
    creatorEl("creatorMessages").addEventListener("click", event => {
      const example = event.target.closest("[data-creator-example]");
      if (example) { creatorEl("creatorInput").value = example.textContent; creatorEl("creatorInput").focus(); }
      if (event.target.closest("#creatorOlder")) void loadCreator(true);
    });
    creatorEl("creatorProposals").addEventListener("click", event => void reviewCreator(event));
    function creatorButtons() {
      const busy = creatorSending || creatorSnapshot?.busy;
      creatorEl("creatorSend").disabled = Boolean(busy || creatorLoading || !creatorSnapshot);
      creatorEl("creatorCancel").hidden = !busy;
      creatorEl("creatorInput").disabled = Boolean(busy);
      creatorEl("creatorProposals").querySelectorAll("[data-creator-review]").forEach(button => { button.disabled = Boolean(busy || creatorLoading); });
    }
    async function loadCreator(older = false) {
      if (!creatorVisible() || creatorLoading) return;
      creatorLoading = true; creatorButtons();
      const sequence = ++creatorRefreshSequence;
      const list = creatorEl("creatorMessages");
      const height = list.scrollHeight;
      try {
        const result = await creatorApi("snapshot", older && creatorSnapshot?.before ? {before:creatorSnapshot.before} : {});
        if (sequence !== creatorRefreshSequence || !creatorVisible()) return;
        if (older && creatorSnapshot) result.messages = [...result.messages, ...creatorSnapshot.messages];
        creatorSnapshot = result; renderCreator();
        if (older) list.scrollTop = list.scrollHeight - height;
        creatorEl("creatorStatus").textContent = result.busy ? "正在整理思路与变更草案…" : "可编辑角色与世界；不读取私聊，不开放删除和 MCP 安装。";
      } catch(error) { if (creatorVisible()) creatorEl("creatorStatus").textContent = error.message; }
      finally {
        creatorLoading = false; creatorButtons(); clearTimeout(creatorPollTimer);
        if (creatorVisible() && creatorSnapshot?.busy && !creatorSending) creatorPollTimer = setTimeout(() => void loadCreator(), 2000);
      }
    }
    function renderCreator() {
      if (!creatorSnapshot) return;
      const messages = creatorSnapshot.messages || [];
      creatorEl("creatorMessages").innerHTML = (creatorSnapshot.before ? '<button id="creatorOlder" class="secondary" type="button">查看更早记录</button>' : '') +
        (messages.length ? messages.map(message => '<article class="creator-message ' + escapeHtml(message.role) + '">' +
          (message.role === "assistant" ? '<small>创作助手</small>' : '') + '<p>' + escapeHtml(message.text) + '</p></article>').join('') :
        '<div class="creator-empty"><small>YOUR WORLD, YOUR WAY</small><h4>让世界，从一个想法开始。</h4><p>角色的性格、街角的书店，或一段更自然的日常。把想法告诉我，我们一起慢慢搭建。</p><button type="button" data-creator-example>设计一位住在海边、经营旧书店的角色</button><button type="button" data-creator-example>看看我现有的世界，有哪些可以完善的地方？</button></div>');
      creatorEl("creatorProposals").innerHTML = creatorSnapshot.proposals.map(proposal => {
        const op = proposal.operation;
        const fields = op.patch || op.input || Object.fromEntries(Object.entries(op).filter(([key]) => key !== "kind"));
        let old = proposal.before || {};
        if (op.kind === "update_autonomy") old = old.autonomy || {};
        const pending = proposal.status === "pending";
        const blocked = creatorSending || creatorSnapshot.busy;
        return '<article class="creator-proposal" data-proposal-id="' + escapeHtml(proposal.id) + '"><small>' + escapeHtml(creatorLabels[op.kind]) + ' · ' + escapeHtml(creatorStatuses[proposal.status]) + '</small><h5>' + escapeHtml(proposal.title) + '</h5><p>' + escapeHtml(proposal.reason) + '</p>' +
          '<details><summary>查看变更</summary>' + Object.entries(fields).map(([key,value]) => '<div class="creator-diff"><strong>' + escapeHtml(creatorFields[key] || key) + '</strong>' +
            (op.patch ? '<small>原值</small><pre>' + escapeHtml(creatorValue(old[key])) + '</pre><small>修改为</small>' : '') + '<pre>' + escapeHtml(creatorValue(value)) + '</pre></div>').join('') +
          '<details><summary>目标与原始快照</summary><pre>' + escapeHtml(JSON.stringify(proposal.before, null, 2)) + '</pre></details>' +
          (pending ? '<div class="creator-proposal-actions"><button class="primary" type="button" data-creator-review="apply"' + (blocked?' disabled':'') + '>确认应用</button><button class="secondary" type="button" data-creator-review="reject"' + (blocked?' disabled':'') + '>撤销草案</button></div>' : '') + '</details>' +
          (proposal.error ? '<p>' + escapeHtml(proposal.error) + '</p>' : '') +
          (proposal.result ? '<details><summary>执行回执</summary><pre>' + escapeHtml(JSON.stringify(proposal.result, null, 2)) + '</pre></details>' : '') + '</article>';
      }).join('') || '<div class="creator-review-empty">还没有变更草案。<br />需要修改时，我会把具体内容放在这里，等你确认。</div>';
      refreshIcons(); creatorButtons();
    }
    function creatorValue(value) { return value === undefined || value === null ? "未设置" : typeof value === "boolean" ? (value ? "开启" : "关闭") : typeof value === "string" ? value : JSON.stringify(value, null, 2); }
    async function sendCreator() {
      const text = creatorEl("creatorInput").value.trim();
      if (!text || creatorSending || creatorSnapshot?.busy || creatorLoading || !creatorVisible()) return;
      const requestId = crypto.randomUUID();
      const generation = creatorViewGeneration;
      creatorSending = true; creatorButtons();
      creatorEl("creatorStatus").textContent = "正在整理思路与变更草案…";
      try {
        const result = await creatorApi("messages", { text, requestId });
        if (generation !== creatorViewGeneration) return;
        creatorEl("creatorInput").value = "";
        if (creatorVisible()) {
          creatorSnapshot = result; renderCreator();
          creatorEl("creatorMessages").scrollTop = creatorEl("creatorMessages").scrollHeight;
          creatorEl("creatorStatus").textContent = result.status === "completed" ? "回复完成。草案需要你确认后才会生效。" : "本轮未完成，没有自动应用变更。";
        }
      } catch(error) {
        if (generation === creatorViewGeneration && creatorVisible()) { creatorEl("creatorStatus").textContent = error.message + "；请刷新核对结果后再发送，避免重复请求。"; await loadCreator(); }
      } finally { creatorSending = false; creatorButtons(); if (creatorVisible() && creatorSnapshot?.busy) void loadCreator(); }
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
        onConfirm: async () => { await creatorApi("review", { id:proposal.id, digest:proposal.digest, action }); await loadCreator(); void loadCharacters(); } });
    }
`;
