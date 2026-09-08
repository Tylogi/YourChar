import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runReminderDeliveryChecks(browser,outputDir) {
  for (const [width,colorScheme] of [[390,"dark"],[1440,"light"]]) {
    const runtime=createTestRuntime({now:"2026-09-08T01:00:00Z"});
    const character=runtime.kernel.createCharacter({name:"提醒测试角色"});
    const session=await runtime.kernel.openCanonicalPrivateConversation(character.id);
    const server=createHttpServer({kernel:runtime.kernel}); await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    const page=await browser.newPage({viewport:{width,height:900},colorScheme,reducedMotion:"reduce"});const errors=[];page.on("pageerror",error=>errors.push(error.message));
    try{
      await page.goto("http://127.0.0.1:"+server.address().port,{waitUntil:"domcontentloaded"});
      await page.waitForFunction(()=>state.characters.length===1);
      await page.evaluate(id=>openPersistentDirectConversation(id,"normal"),character.id);
      await page.evaluate(()=>{setUiMode("schedule");openNewScheduleEditor();});
      await page.locator("#scheduleEditorDialog").waitFor({state:"visible"});
      assert.equal(await page.locator("#scheduleReminderEnabled").isChecked(),true);
      assert.equal(await page.locator("#scheduleReminderWechat").isChecked(),true);
      assert.equal(await page.locator("#scheduleReminderLead").inputValue(),"0");
      await page.locator("#scheduleKind").selectOption("event");
      await page.locator("#scheduleReminderEnabled").check();
      assert.equal(await page.locator("#scheduleReminderLead").inputValue(),"15");
      await page.locator("#scheduleTitle").fill("提醒提前量测试");
      await page.locator("#scheduleStart").fill("2026-09-08T10:00");
      await page.locator("#scheduleStart").dispatchEvent("change");
      assert.match(await page.locator("#scheduleReminderPreview").innerText(),/通知时间.*09:45/);
      assert.equal(await page.locator("#scheduleReminderEnabled").evaluate(el=>{
        const box=el.getBoundingClientRect(), label=el.nextElementSibling.getBoundingClientRect();
        return Math.abs((box.top+box.height/2)-(label.top+label.height/2))<3;
      }),true,"the reminder switch and its label must share one row");
      await page.screenshot({path:resolve(outputDir,`reminder-editor-${width}.png`),fullPage:true});
      assert.equal(await page.locator("#scheduleEditorDialog").evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.locator("#saveScheduleBtn").click();await page.locator("#scheduleEditorDialog").waitFor({state:"hidden"});
      assert.equal(runtime.kernel.listScheduleItems()[0].reminder.leadMinutes,15);
      await page.evaluate(()=>setUiMode("normal"));
      const created=runtime.kernel.createScheduleItem({kind:"reminder",title:"测试通知 <script>window.reminderXss=true</script>",startAt:"2026-09-08T01:01:00Z",timezone:"Asia/Shanghai",sourceSessionId:session.id});
      runtime.clock.advance(60000);await runtime.schedulerTick();
      await page.evaluate(()=>refreshReminderNotifications());
      assert.equal(await page.locator("#reminderToast").isVisible(),true);
      await page.locator("#reminderInboxBtn").click();await page.locator("#reminderInboxDialog").waitFor({state:"visible"});
      assert.equal(await page.locator(".reminder-card").count(),1);assert.equal(await page.evaluate(()=>Boolean(window.reminderXss)),false);
      await page.screenshot({path:resolve(outputDir,`reminder-inbox-${width}.png`),fullPage:true});
      assert.equal(await page.locator("#reminderInboxDialog").evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
      await page.locator('[data-reminder-action="acknowledge"]').click();await page.waitForFunction(()=>document.querySelector("#reminderInboxList")?.textContent.includes("已确认"));
      assert.ok(runtime.kernel.listReminderOccurrences(created.item.id)[0].acknowledgedAt);
      await page.locator("#closeReminderInboxBtn").click();
      await page.evaluate(()=>{state.conversationSpace="secret";state.conversationSpaceEpoch++;updatePrivateModeChrome();});
      await page.evaluate(()=>refreshReminderNotifications());assert.equal(await page.locator("#reminderInboxBadge").isVisible(),false);assert.equal(await page.locator("#reminderInboxList").innerText(),"");
      assert.deepEqual(errors,[]);console.log(`Reminder delivery UI checks passed (${width}px, ${colorScheme})`);
    }finally{await page.close();await new Promise(resolve=>server.close(resolve));runtime.dispose();}
  }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const outputDir=resolve("browser-artifacts");mkdirSync(outputDir,{recursive:true});const browser=await launch({headless:true});
  try{await runReminderDeliveryChecks(browser,outputDir);}finally{await browser.close();}
}
