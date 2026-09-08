export const lifeCss = `
.character-profile-tabs { grid-template-columns:repeat(3,minmax(0,1fr)); width:min(330px,calc(100% - 44px)); }
.character-recent-panel { min-width:0; padding:20px 22px 28px; }
.character-recent-panel[hidden], .character-removal-choice[hidden] { display:none; }
#characterRecentStatus { font-size:12px; line-height:1.7; margin:0 0 18px; }
.life-heading { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:10px 0 18px; }
.life-heading h3 { margin:0; font-size:15px; font-weight:600; }
.life-card { padding:16px 0; border-top:1px solid var(--line); overflow-wrap:anywhere; }
.life-card header { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:0; border:0; background:transparent; min-height:0; }
.life-card header strong { font-size:14px; font-weight:600; }
.life-card small, .life-card time { color:var(--muted); font-size:12px; }
.life-card p { margin:8px 0; white-space:pre-wrap; font-size:13px; line-height:1.7; }
.life-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; }
.life-actions button { min-height:32px; font-size:12px; }
.life-state { flex-shrink:0; font-size:12px; color:var(--muted); }
.life-card details { margin-top:10px; font-size:13px; }
.life-card summary, .life-section > summary { cursor:pointer; color:var(--muted); padding:8px 0; }
.life-section { border-top:1px solid var(--line); margin-top:18px; }
.life-form { display:grid; gap:12px; padding:16px 0; }
.life-form label { display:grid; gap:6px; font-size:12px; color:var(--muted); }
.life-form input, .life-form select, .life-form textarea { width:100%; min-width:0; color:var(--text); background:var(--panel); }
.life-form textarea { resize:vertical; }
.life-empty { padding:20px 0; color:var(--muted); font-size:13px; line-height:1.8; }
.character-removal-choice { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin:12px 0; color:var(--muted); font-size:12px; }
.character-removal-choice select { max-width:100%; }
@media (max-width:600px) { .character-recent-panel { padding-inline:18px; } .character-profile-tabs { width:calc(100% - 36px); } }
`;

export const lifePanelHtml = `
<section id="characterProfileRecent" class="character-recent-panel" role="tabpanel" aria-labelledby="characterProfileRecentBtn" hidden>
  <div class="life-heading"><h3>最近惦记的事</h3><button id="refreshCharacterRecentBtn" class="secondary" type="button">刷新</button></div>
  <p id="characterRecentStatus" class="muted" role="status" aria-live="polite"></p>
  <div id="characterRecentGoals"></div>
  <details id="characterGoalCreate" class="life-section"><summary>记下一件持续的事</summary>
    <form id="characterGoalForm" class="life-form">
      <label>类型<select id="characterGoalKind"><option value="request">用户委托 · 仅私聊可见</option><option value="wish">世界心愿 · 可以影响自主日程</option></select></label>
      <label>这件事是什么<input id="characterGoalTitle" maxlength="160" required placeholder="例如：为周末的读书会做准备" /></label>
      <label>下一步或等待条件<textarea id="characterGoalNextStep" maxlength="800" rows="2" placeholder="例如：先挑一本适合一起读的书，不必急着邀请别人"></textarea></label>
      <p class="muted">每类最多一件未结束事项。心愿在开启自主生活后可影响世界日程；用户委托只在私聊中继续，不会授予额外工具权限或自动在后台执行。</p>
      <button class="primary" type="submit">记下这件事</button>
    </form>
  </details>
  <details class="life-section" id="characterRecentWork"><summary>后台活动</summary><div id="characterRecentTasks"></div></details>
  <section id="characterRecentDepartures"></section>
</section>`;

export const lifeScript = String.raw`
    let characterRecentRequest = 0;
    let characterRecentData = null;
    const lifeStatusLabels = { active: "进行中", paused: "已暂停", completed: "已完成", cancelled: "已停止", pending: "等待处理", queued: "排队中", running: "处理中", failed: "未完成", declined: "未接受", settled: "已发生", planned: "已安排" };
    const lifeRomanceLabels = { none: "", interested: "表达过好感", dating: "交往中", committed: "已有承诺", former_partners: "曾经交往" };
    document.getElementById("characterProfileRecentBtn").addEventListener("click", () => { setCharacterProfileTab("recent"); void loadCharacterRecent(); });
    document.getElementById("refreshCharacterRecentBtn").addEventListener("click", () => void loadCharacterRecent());
    document.getElementById("characterGoalForm").addEventListener("submit", event => { event.preventDefault(); void createRecentGoal(); });
    document.getElementById("characterRecentGoals").addEventListener("click", event => void controlRecentGoal(event));
    document.getElementById("characterRecentTasks").addEventListener("click", event => void controlRecentTask(event));

    function recentScope() {
      const characterId = nodes.characterProfileDialog.dataset.characterId;
      if (!characterId || incognitoConversationIsActive()) return null;
      if (state.conversationSpace === "secret" && characterId !== state.selectedCharacterId) return null;
      return { characterId, space: state.conversationSpace, epoch: state.conversationSpaceEpoch };
    }
    function recentScopeMatches(scope) {
      const current = recentScope();
      return current && nodes.characterProfileDialog.open && current.characterId === scope.characterId && current.space === scope.space && current.epoch === scope.epoch;
    }
    function recentUrl(scope, path) { return "/api/v1/characters/" + encodeURIComponent(scope.characterId) + "/" + path + "?space=" + scope.space; }
    async function loadCharacterRecent() {
      const request = ++characterRecentRequest;
      const scope = recentScope();
      const status = document.getElementById("characterRecentStatus");
      characterRecentData = null;
      for (const id of ["characterRecentGoals", "characterRecentTasks", "characterRecentDepartures"]) document.getElementById(id).replaceChildren();
      document.getElementById("characterGoalCreate").hidden = !scope;
      if (!scope) { status.textContent = "无痕会话不维护持续事项；私密空间只显示当前角色的事项。"; return; }
      status.textContent = "正在读取近况…";
      try {
        const response = await fetch(recentUrl(scope, "recent-activity"));
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "读取近况失败");
        if (request !== characterRecentRequest || !recentScopeMatches(scope)) return;
        characterRecentData = { ...body, scope };
        const kind = document.getElementById("characterGoalKind");
        kind.querySelector('[value="wish"]').disabled = scope.space === "secret" || !body.worldId;
        if (kind.selectedOptions[0]?.disabled) kind.value = "request";
        status.textContent = scope.space === "secret" ? "仅当前角色的私密委托，不读取普通世界。" : body.autonomyEnabled ? "心愿可影响之后的自主日程；计划与已发生的经历分别记录。" : "开启角色的自主生活后，世界心愿才会影响日程。";
        document.getElementById("characterRecentGoals").innerHTML = (body.goals || []).map(goal => {
          const active = ["active", "paused"].includes(goal.status);
          const action = (name, label) => '<button type="button" class="secondary" data-life-goal="' + escapeHtml(goal.id) + '" data-life-action="' + name + '">' + label + '</button>';
          return '<article class="life-card"><small>' + (goal.kind === "wish" ? "世界心愿" : "用户委托 · 私人") + '</small><header><strong>' + escapeHtml(goal.title) + '</strong><span class="life-state">' + escapeHtml(lifeStatusLabels[goal.status] || goal.status) + '</span></header>' +
            (goal.nextStep ? '<p>' + escapeHtml(goal.nextStep) + '</p>' : '') +
            (goal.completionNote ? '<p class="muted">用户确认：' + escapeHtml(goal.completionNote) + '</p>' : '') +
            (goal.steps.length ? '<details><summary>日程与进展 · ' + goal.steps.length + '</summary>' + goal.steps.map(step => '<p>' + escapeHtml(lifeStatusLabels[step.status] || step.status) + ' · ' + escapeHtml(step.title) + (step.result ? '<br /><small>' + escapeHtml(step.result) + '</small>' : '') + '</p>').join('') + '</details>' : '') +
            (active ? '<div class="life-actions">' + action('edit', '调整下一步') + action(goal.status === 'paused' ? 'resume' : 'pause', goal.status === 'paused' ? '继续' : '暂停') + action('complete', '确认完成') + action('cancel', '不再继续') + '</div>' : '') + '</article>';
        }).join('') || '<p class="life-empty">还没有持续的事项。<br />可以记下一件委托，或一个不急着完成的心愿。</p>';
        document.getElementById("characterRecentTasks").innerHTML = (body.tasks || []).map(task => '<article class="life-card"><header><strong>' + escapeHtml(task.title) + '</strong><span class="life-state">' + escapeHtml(lifeStatusLabels[task.status] || task.status) + '</span></header>' +
          (task.error ? '<p class="muted">' + escapeHtml(task.error) + '</p>' : '') + '<div class="life-actions">' +
          (task.canCancel ? '<button class="secondary" type="button" data-life-task="' + escapeHtml(task.id) + '" data-life-action="cancel">停止</button>' : '') +
          (task.canRetry ? '<button class="secondary" type="button" data-life-task="' + escapeHtml(task.id) + '" data-life-action="retry">重新排队</button>' : '') + '</div></article>').join('') || '<p class="life-empty">暂无后台活动。</p>';
        document.getElementById("characterRecentDepartures").innerHTML = (body.departures || []).length ? '<div class="life-heading"><h3>曾经一起生活的人</h3></div>' + body.departures.map(entry =>
          '<article class="life-card"><header><strong>' + escapeHtml(entry.departedName) + '</strong><span class="life-state">已离开</span></header><p>' + escapeHtml(entry.summary) + '</p>' +
          (entry.relationship?.romanceStatus && lifeRomanceLabels[entry.relationship.romanceStatus] ? '<small>离开时的关系：' + escapeHtml(lifeRomanceLabels[entry.relationship.romanceStatus]) + ' · 离开不代表分手</small>' : '') +
          (entry.experiences.length ? '<details><summary>共同经历</summary>' + entry.experiences.map(experience => '<div class="life-card"><strong>' + escapeHtml(experience.title) + '</strong><p>' + escapeHtml(experience.text) + '</p></div>').join('') + '</details>' : '') + '</article>').join('') : '';
      } catch (error) { if (request === characterRecentRequest && recentScopeMatches(scope)) status.textContent = error.message || String(error); }
    }
    async function recentMutation(scope, path, method, payload) {
      if (!recentScopeMatches(scope)) throw new Error("角色或空间已经切换，请重新打开近况");
      const response = await controlPlaneFetch(recentUrl(scope, path), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "操作未完成");
      if (recentScopeMatches(scope)) await loadCharacterRecent();
    }
    async function createRecentGoal() {
      const scope = recentScope();
      if (!scope) return;
      const button = document.querySelector('#characterGoalForm button[type="submit"]');
      button.disabled = true;
      try {
        await recentMutation(scope, "goals", "POST", { kind: document.getElementById("characterGoalKind").value, title: document.getElementById("characterGoalTitle").value, nextStep: document.getElementById("characterGoalNextStep").value });
        if (recentScopeMatches(scope)) { document.getElementById("characterGoalForm").reset(); document.getElementById("characterGoalCreate").open = false; }
      } catch (error) { if (recentScopeMatches(scope)) document.getElementById("characterRecentStatus").textContent = error.message || String(error); }
      finally { button.disabled = false; }
    }
    async function controlRecentGoal(event) {
      const button = event.target.closest('[data-life-goal]');
      const data = characterRecentData;
      if (!button || !data || !recentScopeMatches(data.scope)) return;
      const goal = data.goals.find(value => value.id === button.dataset.lifeGoal);
      if (!goal) return;
      const action = button.dataset.lifeAction;
      await openActionDialog({ title: { edit: "调整下一步", pause: "暂停这件事", resume: "继续这件事", complete: "确认完成", cancel: "不再继续" }[action],
        description: action === 'complete' ? '请填写你确认完成的依据。该记录表示用户验收，不会冒充工具执行证明。未开始的关联日程会取消，已经发生的经历保留。' : action === 'edit' ? '调整之后的方向，不改写已经发生的经历。' : '暂停或结束后，尚未开始的关联日程会取消。正在发生和已经完成的经历保留；继续不会自动恢复已取消的日程。',
        ...(action === 'edit' || action === 'complete' ? { fieldLabel: action === 'complete' ? '完成依据' : '下一步或等待条件', value: action === 'edit' ? goal.nextStep : '', validate: value => value.length > 800 ? '最多 800 字' : action === 'complete' && !value.trim() ? '请填写完成依据' : '' } : {}),
        confirmLabel: '确认', onConfirm: value => recentMutation(data.scope, 'goals/' + encodeURIComponent(goal.id), 'PATCH', { action, revision: goal.revision, ...(action === 'edit' ? { nextStep: value } : {}), ...(action === 'complete' ? { completionNote: value } : {}) }) });
    }
    async function controlRecentTask(event) {
      const button = event.target.closest('[data-life-task]');
      const data = characterRecentData;
      if (!button || !data) return;
      const action = button.dataset.lifeAction;
      await openActionDialog({ title: action === 'cancel' ? '停止这次后台活动' : '重新排队', description: action === 'cancel' ? '阻止后续执行与迟到结果写入；已经完成的动作和已发送的消息不会撤销。' : '仍受角色调用额度限制；已保存的摘要检查点会复用。', confirmLabel: '确认',
        onConfirm: () => recentMutation(data.scope, 'background-tasks/' + encodeURIComponent(button.dataset.lifeTask), 'POST', { action }) });
    }
`;
