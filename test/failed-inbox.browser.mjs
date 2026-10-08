import assert from "node:assert/strict";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

const runtime = createTestRuntime({ seed: "failed-inbox-browser", startPrivateInboxCoordinator: false });
const kernel = runtime.kernel;
const character = kernel.createCharacter({ name: "消息恢复测试" });
const session = await kernel.openCanonicalPrivateConversation(character.id, "normal");
runtime.model.enqueue([{ kind: "assistant_text", text: "之前的回复" }]);
await kernel.sendMessage(session.id, { mode: "sms", characterId: character.id, text: "之前的消息" });
await kernel.enqueuePrivateMessage(session.id, { mode: "sms", characterId: character.id, text: "历史截图不用归档" }, "orphan");
const orphan = kernel.privateInbox.repository.claimBurst({ sessionId: session.id, burstId: "orphan-burst", now: runtime.clock.now().toISOString(), maximumMessages: 10, maximumCharacters: 10000 });
assert.ok(orphan);
kernel.privateInbox.repository.finishBurst(orphan.id, "failed", runtime.clock.now().toISOString(), "legacy preparation failure");
const original = kernel.sessionRuntime.compactBeforeTurnIfNeeded.bind(kernel.sessionRuntime);
kernel.sessionRuntime.compactBeforeTurnIfNeeded = async () => { throw new Error("controlled preparation failure"); };
await kernel.enqueuePrivateMessage(session.id, { mode: "sms", characterId: character.id, text: "新的截图只是问问题" }, "new-failure");
await kernel.flushPrivateMessageInbox(session.id);
kernel.sessionRuntime.compactBeforeTurnIfNeeded = original;
const server = createHttpServer({ kernel });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const open = async () => {
    await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => state.characters.length === 1);
    await page.evaluate(id => openPersistentDirectConversation(id, "normal"), character.id);
    await page.waitForFunction(() => !state.conversationViewLoading && messageHistory?.initialized);
  };
  for (let pass = 0; pass < 2; pass++) {
    await open();
    for (const text of ["历史截图不用归档", "新的截图只是问问题"]) {
      const row = page.locator("#messages > .message-row.user").filter({ hasText: text });
      await row.waitFor();
      assert.equal(await row.count(), 1, "refresh must preserve failed input without duplicating transcript messages");
      assert.match(await row.innerText(), /发送失败/);
    }
  }
  const oldRow = page.locator("#messages > .message-row.user").filter({ hasText: "历史截图不用归档" });
  await oldRow.locator('[data-message-action="restore"]').click();
  assert.equal(await page.locator("#textInput").inputValue(), "历史截图不用归档");
  runtime.model.enqueue([{ kind: "assistant_text", text: "修复后可以正常回复了。" }]);
  await page.locator("#textInput").fill("新的正常问题");
  await page.locator("#textInput").press("Enter");
  await page.waitForFunction(() => state.privateInboxMessages.some(message => message.text === "新的正常问题"));
  await kernel.flushPrivateMessageInbox(session.id);
  await page.getByText("修复后可以正常回复了。", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Failed inbox browser checks passed: legacy recovery, reload, no duplicate, draft restore, and subsequent reply.");
  await page.close();
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  runtime.dispose();
}
