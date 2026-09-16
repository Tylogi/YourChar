export const reminderCss = `
.reminder-options{grid-column:1/-1;border-top:1px solid var(--line);padding-top:12px;display:grid;gap:12px;min-width:0}.reminder-options-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.schedule-form .reminder-options .checkbox-row{display:flex;align-items:center;gap:8px;flex-direction:row;margin:0;font-size:13px}.reminder-options input[type=checkbox]{width:16px;height:16px;min-height:0;flex:none;margin:0}.reminder-channels{display:flex;gap:14px;flex-wrap:wrap;margin:14px 0 10px}.reminder-help{font-size:12px;color:var(--muted);line-height:1.6;margin:0}
#reminderInboxBtn{position:relative}#reminderInboxBadge{position:absolute;right:0;top:0;width:7px;height:7px;border-radius:50%;background:var(--primary)}
.reminder-center{width:min(520px,calc(100vw - 28px));max-height:80dvh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:16px;padding:20px}.reminder-center-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px}.reminder-center-head h3{margin:0;font-size:17px}.reminder-card{border-top:1px solid var(--line);padding:16px 0;overflow-wrap:anywhere}.reminder-card h4{margin:0 0 8px;font-size:14px}.reminder-card p{white-space:pre-wrap;font-size:13px;line-height:1.6;margin:8px 0}.reminder-card small{color:var(--muted);font-size:12px}.reminder-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.reminder-toast{position:fixed;top:70px;right:20px;z-index:90;max-width:calc(100vw - 40px);display:flex;align-items:center;gap:10px;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:var(--panel);color:var(--text);box-shadow:var(--shadow);font-size:13px}
`;
export const reminderPolicyHtml = `
<div id="scheduleReminderOptions" class="reminder-options">
<label class="checkbox-row"><input id="scheduleReminderEnabled" type="checkbox" checked /><span>通知我</span></label>
<div id="scheduleReminderDetails"><div class="reminder-options-grid">
<label>重要性<select id="scheduleReminderImportance"><option value="important">重要</option><option value="normal">普通</option></select></label>
<label>提前通知<select id="scheduleReminderLead"><option value="0">按约定时间</option><option value="5">提前 5 分钟</option><option value="10">提前 10 分钟</option><option value="15">提前 15 分钟</option><option value="30">提前 30 分钟</option><option value="60">提前 1 小时</option></select></label></div>
<label>通知渠道<select id="scheduleReminderChannelMode"><option value="follow_settings">跟随 IM 设置（推荐）</option><option value="custom">为本提醒单独选择</option></select></label>
<p id="scheduleReminderFollowHint" class="reminder-help">站内 + IM 页面已勾选且已绑定的通道。普通提醒也会推送；不随重要性改变。</p>
<div id="scheduleReminderCustomChannels" class="reminder-channels" hidden><label class="checkbox-row"><input type="checkbox" checked disabled /><span>UI</span></label><label class="checkbox-row"><input id="scheduleReminderWechat" type="checkbox" /><span>微信</span></label><label class="checkbox-row"><input id="scheduleReminderFeishu" type="checkbox" /><span>飞书</span></label><label class="checkbox-row"><input id="scheduleReminderDesktop" type="checkbox" /><span>桌面</span></label></div>
<p id="scheduleReminderPreview" class="reminder-help"></p><p class="reminder-help">后台提前准备，到时模型未完成也会发送基础提醒。外部通道仅限本人已绑定的私聊；IM 总开关和勿扰时段仍生效。</p></div></div>`;
export const reminderCenterHtml = `
<dialog id="reminderInboxDialog" class="reminder-center" aria-labelledby="reminderInboxTitle"><div class="reminder-center-head"><h3 id="reminderInboxTitle">提醒中心</h3><button id="closeReminderInboxBtn" class="secondary icon-button" type="button" aria-label="关闭提醒中心">×</button></div><p id="reminderInboxStatus" class="muted" role="status"></p><div id="reminderInboxList"></div></dialog>
<div id="reminderToast" class="reminder-toast" role="status" hidden><span>有新的日程提醒</span><button id="openReminderToastBtn" type="button" class="secondary">查看</button><button id="dismissReminderToastBtn" type="button" class="secondary icon-button" aria-label="收起提醒">×</button></div>`;
export const reminderScript = String.raw`
    let reminderInboxData = [], reminderInboxSerial = 0, reminderEditorPrepareMinutes = 10, reminderToastTimer;
    const seenReminderIds = new Set();
    const reminderNode = id => document.getElementById(id);
    function reminderUiAllowed() { return state.conversationSpace === "normal" && !incognitoConversationIsActive() && !state.incognitoTransitioning; }
    function clearReminderUi() {
      ++reminderInboxSerial; reminderInboxData = []; reminderNode("reminderInboxList").replaceChildren();
      reminderNode("reminderInboxBadge").hidden = true; reminderNode("reminderToast").hidden = true;
      if (reminderNode("reminderInboxDialog").open) reminderNode("reminderInboxDialog").close();
    }
    async function refreshReminderNotifications() {
      reminderNode("reminderInboxBtn").disabled = !reminderUiAllowed();
      if (!reminderUiAllowed()) { clearReminderUi(); return; }
      const serial = ++reminderInboxSerial, epoch = state.conversationSpaceEpoch;
      try {
        const response = await fetch("/api/v1/reminder-inbox"), body = await response.json();
        if (serial !== reminderInboxSerial || epoch !== state.conversationSpaceEpoch || !reminderUiAllowed()) return;
        if (!response.ok) throw new Error(body.error || "提醒读取失败");
        reminderInboxData = Array.isArray(body.reminders) ? body.reminders : [];
        const pending = reminderInboxData.filter(e => !e.occurrence.acknowledgedAt && !["cancelled","snoozed"].includes(e.occurrence.status) && e.item.status === "scheduled");
        reminderNode("reminderInboxBadge").hidden = !pending.length;
        if (pending.some(e => !seenReminderIds.has(e.occurrence.id))) { reminderNode("reminderToast").hidden = false; clearTimeout(reminderToastTimer); reminderToastTimer = setTimeout(() => { reminderNode("reminderToast").hidden = true; },8000); }
        if (seenReminderIds.size > 500) seenReminderIds.clear(); reminderInboxData.forEach(e => seenReminderIds.add(e.occurrence.id)); renderReminderInbox();
      } catch (error) { if (serial === reminderInboxSerial) reminderNode("reminderInboxStatus").textContent = error.message; }
    }
    function reminderChannelLabel(channel) { return ({in_app:"UI",wechat:"微信",feishu:"飞书",desktop:"桌面"})[channel] || channel; }
    function renderReminderInbox() {
      reminderNode("reminderInboxStatus").textContent = reminderInboxData.length ? "发送成功不代表已读；各通道共享确认状态。" : "暂时没有已触发的提醒。";
      reminderNode("reminderInboxList").innerHTML = reminderInboxData.map(e => {
        const o=e.occurrence, stopped=o.acknowledgedAt || ["cancelled","snoozed"].includes(o.status) || e.item.status!=="scheduled";
        const body=e.channels.find(c=>c.deliveryBody)?.deliveryBody || e.item.title;
        const channels=e.channels.map(c=>reminderChannelLabel(c.channel)+"："+(c.suppressedAt?"已停止":notificationStatusLabel(c.status))+(c.lastError?"（"+c.lastError+"）":"")).join(" · ");
        return '<article class="reminder-card" data-reminder-id="'+escapeHtml(o.id)+'"><h4>'+escapeHtml(e.item.title)+'</h4><p>'+escapeHtml(body)+'</p><small>'+escapeHtml(channels)+'</small>'+(stopped?'<p class="muted">'+(o.acknowledgedAt?"已确认":"已停止本次提醒")+'</p>':'<div class="reminder-actions"><button class="primary" type="button" data-reminder-action="acknowledge">知道了</button><button class="secondary" type="button" data-reminder-action="snooze">稍后 10 分钟</button></div>')+'</article>';
      }).join("");
    }
    async function openReminderInbox() { if (!reminderUiAllowed()) return; reminderNode("reminderToast").hidden=true; if (!reminderNode("reminderInboxDialog").open) reminderNode("reminderInboxDialog").showModal(); await refreshReminderNotifications(); }
    function setScheduleReminderPolicy(policy) {
      const p=policy || {enabled:nodes.scheduleKind.value==="reminder",importance:"important",leadMinutes:nodes.scheduleKind.value==="event"?15:0,prepareMinutes:10,channelMode:"follow_settings",channels:["in_app"]};
      reminderNode("scheduleReminderChannelMode").value=p.channelMode || "custom";
      reminderEditorPrepareMinutes=p.prepareMinutes || 10; reminderNode("scheduleReminderEnabled").checked=Boolean(p.enabled); reminderNode("scheduleReminderImportance").value=p.importance || "normal";
      const select=reminderNode("scheduleReminderLead"); if (![...select.options].some(o=>o.value===String(p.leadMinutes))) select.add(new Option("提前 "+p.leadMinutes+" 分钟",String(p.leadMinutes))); select.value=String(p.leadMinutes || 0);
      for (const [id,channel] of [["Wechat","wechat"],["Feishu","feishu"],["Desktop","desktop"]]) reminderNode("scheduleReminder"+id).checked=(p.channels || ["in_app"]).includes(channel); updateReminderEditor();
    }
    function readScheduleReminderPolicy() { const channelMode=reminderNode("scheduleReminderChannelMode").value; return { enabled:state.scheduleOwnerType==="user" && !nodes.scheduleAllDay.checked && reminderNode("scheduleReminderEnabled").checked, importance:reminderNode("scheduleReminderImportance").value,leadMinutes:Number(reminderNode("scheduleReminderLead").value),prepareMinutes:reminderEditorPrepareMinutes,channelMode,channels:channelMode === "follow_settings" ? ["in_app"] : ["in_app",...["Wechat","Feishu","Desktop"].filter(id=>reminderNode("scheduleReminder"+id).checked).map(id=>id.toLowerCase())] }; }
    function updateReminderEditor() {
      reminderNode("scheduleReminderOptions").hidden=state.scheduleOwnerType!=="user" || nodes.scheduleAllDay.checked; reminderNode("scheduleReminderDetails").hidden=!reminderNode("scheduleReminderEnabled").checked;
      const p=readScheduleReminderPolicy(), start=nodes.scheduleStart.value && new Date(nodes.scheduleStart.value);
      reminderNode("scheduleReminderCustomChannels").hidden=p.channelMode !== "custom";
      reminderNode("scheduleReminderFollowHint").hidden=p.channelMode === "custom";
      reminderNode("scheduleReminderPreview").textContent=start && Number.isFinite(start.getTime()) && p.enabled
        ? (uiLocale() === "en" ? "Notification: " : "通知时间：") + new Date(start.getTime()-p.leadMinutes*60000).toLocaleString(uiLocale()) + (uiLocale() === "en" ? "; preparing " + p.prepareMinutes + " minutes early." : "；后台提前 "+p.prepareMinutes+" 分钟准备。")
        : (uiLocale() === "en" ? "For reminders at an exact time, choose “At the scheduled time”. Use a lead time for events." : "明确说几点提醒，就选择“按约定时间”；事件需要提前提醒时，再设置提前量。");
    }
    reminderNode("reminderInboxBtn").addEventListener("click",openReminderInbox); reminderNode("openReminderToastBtn").addEventListener("click",openReminderInbox);
    reminderNode("closeReminderInboxBtn").addEventListener("click",()=>reminderNode("reminderInboxDialog").close()); reminderNode("dismissReminderToastBtn").addEventListener("click",()=>{reminderNode("reminderToast").hidden=true;});
    reminderNode("reminderInboxList").addEventListener("click",async event=>{
      const button=event.target.closest("[data-reminder-action]"); if (!button || !reminderUiAllowed()) return; const id=button.closest("[data-reminder-id]").dataset.reminderId; button.disabled=true;
      try { const r=await fetch("/api/v1/reminder-occurrences/"+encodeURIComponent(id)+"/"+button.dataset.reminderAction,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({minutes:10})}); if (!r.ok) throw new Error((await r.json()).error || "提醒更新失败"); await refreshReminderNotifications(); } catch(error){reminderNode("reminderInboxStatus").textContent=error.message;} finally{button.disabled=false;}
    });
    nodes.scheduleForm.addEventListener("change",updateReminderEditor); nodes.scheduleKind.addEventListener("change",()=>{if(!state.editingScheduleId)setScheduleReminderPolicy();});
    window.setInterval(()=>void refreshReminderNotifications(),5000);
`;
