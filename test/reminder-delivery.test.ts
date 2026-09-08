import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestRuntime } from "../src/testing/index.js";
import { ScheduleScheduler } from "../src/schedule/scheduler.js";
import { reminderPolicy } from "../src/schedule/reminder-policy.js";
import { CaptureNotificationSink } from "../src/notifications/sink.js";
import { ImNotificationSink, reminderCode } from "../src/notifications/im-sink.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { AppDatabase } from "../src/storage/database.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { VirtualClock } from "../src/app/clock.js";
import { createServer } from "node:http";
import type { ImGateway, ImInboundEventInput } from "../src/im/index.js";

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const gateway: ImGateway = { configured: true, supportsAttachments: true,
  startBinding: async () => { throw new Error("not needed"); },getBindingSession: async () => { throw new Error("not needed"); },
  cancelBindingSession: async () => { throw new Error("not needed"); },disconnect: async () => {} };

function setupWechat(runtime: ReturnType<typeof createTestRuntime>) {
  const repo = runtime.kernel.imIntegrations.repository, now=runtime.clock.now().toISOString();
  const character=runtime.kernel.createCharacter({name:"提醒角色"});
  repo.setCharacterRoute("wechat",character.id,now);
  repo.upsertConnection({provider:"wechat",gatewayConnectionId:"connection",bindingGeneration:"generation",accountId:"account",ownerId:"owner",connectedAt:now,now});
  const event: ImInboundEventInput = {provider:"wechat",eventId:"owner-hello",connectionId:"connection",bindingGeneration:"generation",externalChatId:"owner-chat",externalUserId:"owner",chatType:"direct",text:"你好"};
  repo.claimInboundEvent({event,bindingGeneration:"generation",characterId:character.id,payloadDigest:"hello",now});
  repo.failInboundEvent("wechat",event.eventId,"fixture already verified owner",now);
  return {repo,event,character};
}
function multiScheduler(runtime: ReturnType<typeof createTestRuntime>) {
  const ui=new CaptureNotificationSink();
  const scheduler=new ScheduleScheduler(runtime.kernel.scheduleService.repository,runtime.kernel.scheduleService,ui,runtime.clock,new SeededIdGenerator("multi"),undefined,undefined,undefined,
    {additionalSinks:[new ImNotificationSink("wechat",runtime.kernel.imIntegrations,runtime.clock)]});
  return {ui,scheduler};
}

test("event time, notification lead and draft lead are independent; legacy schedules keep their policy",async()=>{
  let calls=0;
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",reminderMessageComposer:{compose:async()=>{calls++;return{body:"会议 10:00 开始，记得准备。",agentGenerated:true};}}});
  try {
    const created=runtime.kernel.createScheduleItem({kind:"event",title:"会议",startAt:"2026-09-08T02:00:00Z",timezone:"Asia/Shanghai",reminder:{enabled:true,leadMinutes:15,prepareMinutes:10}});
    assert.equal(created.occurrence?.dueAt,"2026-09-08T01:45:00.000Z");
    assert.equal(created.occurrence?.eventAt,"2026-09-08T02:00:00.000Z");
    runtime.clock.advance(34*60000);await runtime.schedulerTick();await flush();assert.equal(calls,0);
    runtime.clock.advance(60000);await runtime.schedulerTick();await flush();assert.equal(calls,1);assert.equal(runtime.notifications.length,0);
    assert.equal(runtime.kernel.scheduleService.repository.getDraft(created.occurrence!.id)?.status,"ready");
    runtime.clock.advance(10*60000);await runtime.schedulerTick();assert.equal(runtime.notifications.length,1);assert.equal(runtime.notifications[0].agentGenerated,true);
    const reminder=runtime.kernel.createScheduleItem({kind:"reminder",title:"明确时刻",startAt:"2026-09-08T03:00:00Z",timezone:"Asia/Shanghai"});
    assert.equal(reminder.occurrence?.dueAt,"2026-09-08T03:00:00.000Z");
    assert.deepEqual(reminder.item.reminder?.channels,["in_app","wechat"]);
    runtime.kernel.database.connection.prepare("UPDATE schedule_items SET reminder_json=NULL WHERE id=?").run(reminder.item.id);
    assert.deepEqual(reminderPolicy(runtime.kernel.getScheduleItem(reminder.item.id)).channels,["in_app"]);
  } finally {runtime.dispose();}
});

test("a slow draft cannot delay delivery or publish a late second message",async()=>{
  let finish!: (value:{body:string;agentGenerated:boolean})=>void;let signal:AbortSignal|undefined;
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",reminderMessageComposer:{compose:(_,s)=>{signal=s;return new Promise(resolve=>{finish=resolve;});}}});
  try{
    const created=runtime.kernel.createScheduleItem({kind:"reminder",title:"出门",startAt:"2026-09-08T01:05:00Z",timezone:"Asia/Shanghai"});await flush();
    assert.equal(signal?.aborted,false);const before=performance.now();await runtime.schedulerTick();assert.ok(performance.now()-before<200);
    runtime.clock.advance(5*60000);await runtime.schedulerTick();assert.equal(signal?.aborted,true);assert.match(runtime.notifications[0].body,/出门[\s\S]*09:05/);
    finish({body:"过期草稿",agentGenerated:true});await flush();await runtime.schedulerTick();assert.equal(runtime.notifications.length,1);
    assert.notEqual(runtime.kernel.scheduleService.repository.getDraft(created.occurrence!.id)?.status,"ready");
  } finally{runtime.dispose();}
});

test("editing and cancelling invalidate in-flight drafts",async()=>{
  const completions:Array<(value:{body:string;agentGenerated:boolean})=>void>=[];
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",reminderMessageComposer:{compose:()=>new Promise(resolve=>completions.push(resolve))}});
  try{
    const created=runtime.kernel.createScheduleItem({kind:"reminder",title:"原事项",startAt:"2026-09-08T01:05:00Z",timezone:"Asia/Shanghai"});await flush();
    runtime.kernel.updateScheduleItem(created.item.id,{title:"新事项"});await flush();
    completions[0]({body:"旧草稿",agentGenerated:true});await flush();
    assert.notEqual(runtime.kernel.scheduleService.repository.getDraft(created.occurrence!.id)?.body,"旧草稿");
    runtime.kernel.cancelScheduleItem(created.item.id);completions[1]({body:"取消后的草稿",agentGenerated:true});await flush();
    runtime.clock.advance(5*60000);await runtime.schedulerTick();assert.equal(runtime.notifications.length,0);
  } finally{runtime.dispose();}
});

test("UI and WeChat settle independently; platform queueing is not delivery",async()=>{
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",imGateway:gateway});const {repo}=setupWechat(runtime);const {scheduler,ui}=multiScheduler(runtime);
  try{
    const created=runtime.kernel.createScheduleItem({kind:"reminder",title:"双通道",startAt:"2026-09-08T01:01:00Z",timezone:"Asia/Shanghai"});runtime.clock.advance(60000);
    assert.deepEqual(await scheduler.tick(),{claimed:1,delivered:1,failed:0});assert.equal(ui.deliveries.length,1);
    let wechat=runtime.kernel.listNotificationHistory().find(e=>e.channel==="wechat")!;assert.equal(wechat.status,"pending");
    const outgoing=runtime.kernel.claimImPendingOutbox({provider:"wechat"});assert.equal(outgoing.length,1);assert.equal(outgoing[0].externalChatId,"owner-chat");assert.ok(outgoing[0].notificationOutboxId);assert.equal(outgoing[0].inboundEventId,undefined);
    runtime.kernel.acknowledgeImOutbox({id:outgoing[0].id,leaseToken:outgoing[0].leaseToken!,delivered:true});
    runtime.clock.advance(1000);await scheduler.tick();wechat=runtime.kernel.listNotificationHistory().find(e=>e.channel==="wechat")!;assert.equal(wechat.status,"delivered");
    await scheduler.tick();assert.equal(ui.deliveries.length,1);assert.equal(repo.claimPendingOutbox({now:runtime.clock.now().toISOString(),leaseToken:"lease",leaseExpiresAt:"2027-01-01T00:00:00Z"}).length,0);
    assert.equal(runtime.kernel.getScheduleItem(created.item.id).status,"scheduled");
  }finally{scheduler.stop();runtime.dispose();}
});

test("acknowledging in UI revokes pending external authorization; duplicate snooze is rejected",async()=>{
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",imGateway:gateway});setupWechat(runtime);const {scheduler}=multiScheduler(runtime);
  try{
    const created=runtime.kernel.createScheduleItem({kind:"reminder",title:"确认",startAt:"2026-09-08T01:01:00Z",timezone:"Asia/Shanghai"});runtime.clock.advance(60000);await scheduler.tick();
    const outgoing=runtime.kernel.claimImPendingOutbox({provider:"wechat"})[0];runtime.kernel.acknowledgeReminder(created.occurrence!.id);
    assert.throws(()=>runtime.kernel.authorizeImOutbox(outgoing.id,outgoing.leaseToken!),/lease/);
    await scheduler.tick();assert.ok(runtime.kernel.listReminderOccurrences()[0].acknowledgedAt);
    const next=runtime.kernel.snoozeReminder(created.occurrence!.id,10);assert.equal(next.dueAt,"2026-09-08T01:11:00.000Z");
    assert.throws(()=>runtime.kernel.snoozeReminder(created.occurrence!.id,10),/no longer active/);
  }finally{scheduler.stop();runtime.dispose();}
});

test("owner WeChat confirmation synchronizes acknowledgement without a model call",async()=>{
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",imGateway:gateway});const {event}=setupWechat(runtime);const {scheduler}=multiScheduler(runtime);
  try{
    const created=runtime.kernel.createScheduleItem({kind:"reminder",title:"确认回执",startAt:"2026-09-08T01:01:00Z",timezone:"Asia/Shanghai"});runtime.clock.advance(60000);await scheduler.tick();
    const outgoing=runtime.kernel.claimImPendingOutbox({provider:"wechat"})[0];runtime.kernel.acknowledgeImOutbox({id:outgoing.id,leaseToken:outgoing.leaseToken!,delivered:true});
    const receipt=await runtime.kernel.receiveImInboundEvent({...event,eventId:"ack",text:"知道了 "+reminderCode(created.occurrence!.id)});
    assert.match(receipt.delivery.text,/已确认/);assert.equal(runtime.model.requests.length,0);assert.equal(runtime.kernel.listReminderOccurrences()[0].acknowledgedVia,"wechat");
    assert.equal(runtime.kernel.listNotificationHistory().find(entry=>entry.channel==="wechat")?.status,"delivered");
    assert.equal((await runtime.kernel.receiveImInboundEvent({...event,eventId:"ack",text:"知道了 "+reminderCode(created.occurrence!.id)})).duplicate,true);
    await assert.rejects(runtime.kernel.receiveImInboundEvent({...event,eventId:"stranger",externalUserId:"stranger",text:"知道了"}),/不是当前绑定用户/);
  }finally{scheduler.stop();runtime.dispose();}
});

test("rebind never retargets an already-queued reminder",async()=>{
  const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z",imGateway:gateway});const {repo}=setupWechat(runtime);const {scheduler,ui}=multiScheduler(runtime);
  try{
    runtime.kernel.createScheduleItem({kind:"reminder",title:"旧账号提醒",startAt:"2026-09-08T01:01:00Z",timezone:"Asia/Shanghai"});runtime.clock.advance(60000);await scheduler.tick();
    const now=runtime.clock.now().toISOString();repo.upsertConnection({provider:"wechat",gatewayConnectionId:"connection",bindingGeneration:"new-generation",accountId:"new-account",ownerId:"new-owner",connectedAt:now,now});
    runtime.clock.advance(1000);await scheduler.tick();assert.equal(runtime.kernel.claimImPendingOutbox({provider:"wechat"}).length,0);assert.equal(ui.deliveries.length,1);
    assert.match(runtime.kernel.listNotificationHistory().find(e=>e.channel==="wechat")!.lastError!,/binding/);
  }finally{scheduler.stop();runtime.dispose();}
});

test("schema 56 preserves legacy IM deliveries and does not opt old reminders into WeChat",()=>{
  const dir=mkdtempSync(join(tmpdir(),"yourchar-reminder-migration-")),path=join(dir,"state.sqlite");
  try{
    const old=new AppDatabase(path,{maxMigrationVersion:55});
    old.connection.exec(`INSERT INTO im_inbound_events(provider,event_id,gateway_connection_id,external_chat_id,external_user_id,chat_type,binding_generation,character_id,payload_digest,status,created_at,updated_at)
      VALUES('wechat','old-event','old-connection','old-chat','old-owner','direct','old-generation','old-character','digest','completed','2026-01-01','2026-01-01');
      INSERT INTO im_outbox(id,provider,gateway_connection_id,binding_generation,external_chat_id,inbound_event_id,text,status,available_at,created_at,updated_at)
      VALUES('old-outbox','wechat','old-connection','old-generation','old-chat','old-event','existing reply','delivered','2026-01-01','2026-01-01','2026-01-01');
      INSERT INTO schedule_items(id,kind,title,start_at,timezone,status,created_at,updated_at) VALUES('old-reminder','reminder','legacy','2026-12-01T00:00:00Z','Asia/Shanghai','scheduled','2026-01-01','2026-01-01');`);old.close();
    const current=new AppDatabase(path);try{const row=current.connection.prepare("SELECT * FROM im_outbox WHERE id='old-outbox'").get()!;
      assert.equal(row.text,"existing reply");assert.equal(row.status,"delivered");assert.equal(row.inbound_event_id,"old-event");assert.equal(row.notification_outbox_id,null);
      assert.equal(current.connection.prepare("SELECT reminder_json FROM schedule_items WHERE id='old-reminder'").get()!.reminder_json,null);
      assert.deepEqual(current.connection.prepare("PRAGMA foreign_key_check").all(),[]);
    }finally{current.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("a missing owner contact does not block UI; retry only resends the failed channel", async () => {
  const runtime = createTestRuntime({ now: "2026-09-08T01:00:00Z", imGateway: gateway });
  const { scheduler, ui } = multiScheduler(runtime);
  try {
    runtime.kernel.createScheduleItem({ kind: "reminder", title: "重要事项", startAt: "2026-09-08T01:01:00Z", timezone: "Asia/Shanghai" });
    runtime.clock.advance(60_000);
    await scheduler.tick();
    assert.equal(ui.deliveries.length, 1);
    assert.match(runtime.kernel.listNotificationHistory().find(e => e.channel === "wechat")!.lastError!, /本人.*私聊/);
    for (const delay of [60_000, 120_000]) { runtime.clock.advance(delay); await scheduler.tick(); }
    const failed = runtime.kernel.listNotificationHistory().find(e => e.channel === "wechat")!;
    assert.equal(failed.status, "failed");
    setupWechat(runtime);
    runtime.kernel.scheduleService.retryNotification(failed.id);
    await scheduler.tick();
    assert.equal(ui.deliveries.length, 1);
    assert.equal(runtime.kernel.claimImPendingOutbox({ provider: "wechat" }).length, 1);
  } finally { scheduler.stop(); runtime.dispose(); }
});

test("cancelling after UI delivery revokes an unsent WeChat lease", async () => {
  const runtime = createTestRuntime({ now: "2026-09-08T01:00:00Z", imGateway: gateway });
  setupWechat(runtime);
  const { scheduler, ui } = multiScheduler(runtime);
  try {
    const created = runtime.kernel.createScheduleItem({ kind: "reminder", title: "稍后取消", startAt: "2026-09-08T01:01:00Z", timezone: "Asia/Shanghai" });
    runtime.clock.advance(60_000); await scheduler.tick();
    const leased = runtime.kernel.claimImPendingOutbox({ provider: "wechat" })[0];
    runtime.kernel.cancelScheduleItem(created.item.id);
    assert.throws(() => runtime.kernel.authorizeImOutbox(leased.id, leased.leaseToken!), /lease/);
    runtime.clock.advance(60_000); await scheduler.tick();
    assert.equal(ui.deliveries.length, 1);
    assert.equal(runtime.kernel.listNotificationHistory().find(e => e.channel === "wechat")?.suppressedAt, runtime.kernel.getScheduleItem(created.item.id).updatedAt);
  } finally { scheduler.stop(); runtime.dispose(); }
});

test("private-source reminders neither prepare nor escape through notifications", async () => {
  let drafts = 0;
  const runtime = createTestRuntime({ now: "2026-09-08T01:00:00Z", reminderMessageComposer: { compose: async () => { drafts++; return { body: "private", agentGenerated: true }; } } });
  try {
    const character = runtime.kernel.createCharacter({ name: "私密角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    const input = { kind: "reminder" as const, title: "私密事项", startAt: "2026-09-08T01:01:00Z", timezone: "Asia/Shanghai", sourceSessionId: session.id };
    assert.throws(() => runtime.kernel.createScheduleItem(input), /私密/);
    // Defense in depth for an existing row or a caller bypassing the HTTP facade.
    runtime.kernel.scheduleService.create(input);
    await flush(); runtime.clock.advance(60_000); await runtime.schedulerTick();
    assert.equal(drafts, 0); assert.equal(runtime.notifications.length, 0);
    assert.deepEqual(runtime.kernel.reminderInbox(), []);
  } finally { runtime.dispose(); }
});

test("daily recurrence follows event wall time across DST and snoozing preserves the event time", async () => {
  const runtime = createTestRuntime({ now: "2026-03-07T07:00:00Z" });
  try {
    const created = runtime.kernel.createScheduleItem({ kind: "event", title: "晨会", startAt: "2026-03-07T08:10:00Z", timezone: "America/New_York", recurrenceRule: "FREQ=DAILY", reminder: { enabled: true, leadMinutes: 30 } });
    assert.equal(created.occurrence?.dueAt, "2026-03-07T07:40:00.000Z");
    runtime.clock.advance(40 * 60_000); await runtime.schedulerTick();
    const next = runtime.kernel.listReminderOccurrences(created.item.id).find(e => e.id !== created.occurrence!.id)!;
    assert.equal(next.eventAt, "2026-03-08T07:10:00.000Z");
    assert.equal(next.dueAt, "2026-03-08T06:40:00.000Z");
    const snoozed = runtime.kernel.snoozeReminder(created.occurrence!.id, 10);
    assert.equal(snoozed.eventAt, created.occurrence?.eventAt);
    runtime.clock.advance(10 * 60_000); await runtime.schedulerTick();
    assert.equal(runtime.kernel.listReminderOccurrences(created.item.id).length, 3);
  } finally { runtime.dispose(); }
});

test("notification delivery does not wait for source Pi or MCP initialization", async () => {
  const runtime = createTestRuntime({ now: "2026-09-08T01:00:00Z" });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sessions = runtime.kernel.sessionRuntime;
  const original = sessions.getOrCreateCanonicalDirect.bind(sessions);
  try {
    const character = runtime.kernel.createCharacter({ name: "慢加载角色" });
    const source = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    runtime.kernel.createScheduleItem({ kind: "reminder", title: "不等会话加载", startAt: "2026-09-08T01:01:00Z", timezone: "Asia/Shanghai", sourceSessionId: source.id });
    sessions.getOrCreateCanonicalDirect = async (...args) => { await blocked; return original(...args); };
    runtime.clock.advance(60_000);
    const result = await Promise.race([runtime.schedulerTick(), new Promise<never>((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("delivery waited for session initialization")), 2000);
      timeout.unref();
    })]);
    assert.equal(result.delivered, 1);
    assert.equal(runtime.notifications.length, 1);
  } finally { release(); await flush(); sessions.getOrCreateCanonicalDirect = original; runtime.dispose(); }
});

test("partial policy updates preserve disabled state and reject malformed policies", () => {
  const runtime = createTestRuntime({ now: "2026-09-08T01:00:00Z" });
  try {
    const created = runtime.kernel.createScheduleItem({ kind: "reminder", title: "仅日历", startAt: "2026-09-08T02:00:00Z", allDay: true, timezone: "Asia/Shanghai", reminder: { enabled: false } });
    assert.equal(runtime.kernel.updateScheduleItem(created.item.id, { reminder: { channels: ["in_app"] } }).item.reminder?.enabled, false);
    for (const invalid of [null, [], { channels: [] }, { prepareMinutes: 0 }, { leadMinutes: -1 }, { recipients: ["stranger"] }]) {
      assert.throws(() => runtime.kernel.updateScheduleItem(created.item.id, { reminder: invalid as never }), /reminder/);
    }
  } finally { runtime.dispose(); }
});

test("the production draft composer uses an isolated request and does not append a foreground turn", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: ' + JSON.stringify({ id: "draft", choices: [{ index: 0, delta: { role: "assistant", content: "记得在 09:05 出门。" }, finish_reason: "stop" }] }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const clock = new VirtualClock("2026-09-08T01:00:00Z"), sink = new CaptureNotificationSink();
  const kernel = new CompanionKernel({ stateDir: false, clock, notificationSink: sink, startScheduler: false, characterSkillReflector: false, quietHours: false });
  try {
    const address = server.address(); assert.ok(address && typeof address === "object");
    kernel.patchModelApiConfig({ enabled: true, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "draft-fixture", apiKey: "fixture" });
    const character = kernel.createCharacter({ name: "提醒角色" });
    const session = await kernel.openCanonicalPrivateConversation(character.id, "normal");
    const before = (await kernel.getSession(session.id)).messages;
    const created = kernel.createScheduleItem({ kind: "reminder", title: "出门", startAt: "2026-09-08T01:05:00Z", timezone: "Asia/Shanghai", sourceSessionId: session.id });
    const deadline = Date.now() + 5000;
    while (kernel.scheduleService.repository.getDraft(created.occurrence!.id)?.status === "preparing" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(kernel.scheduleService.repository.getDraft(created.occurrence!.id)?.status, "ready");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].tools, undefined);
    assert.equal((requests[0].messages as unknown[]).length, 2);
    assert.deepEqual((await kernel.getSession(session.id)).messages, before);
    assert.equal(sink.deliveries.length, 0);
    clock.advance(5 * 60_000); await kernel.scheduler.tick();
    assert.equal(sink.deliveries[0].agentGenerated, true);
    assert.equal(requests.length, 1);
    await flush();
  } finally {
    kernel.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
