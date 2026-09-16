import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runStreamingOrderChecks(browser, outputDir) {
  for (const [space, width] of [["normal", 1440], ["secret", 390]]) {
    const runtime = createTestRuntime({ startPrivateInboxCoordinator: false });
    const kernel = runtime.kernel;
    const character = kernel.createCharacter({ name: "流式排序测试角色" });
    const session = await kernel.openCanonicalPrivateConversation(character.id, space);
    const server = createHttpServer({ kernel });
    await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    const page = await browser.newPage({ viewport: { width, height: 960 }, locale: "zh-CN", colorScheme: width === 390 ? "dark" : "light", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const t = Date.now();
    const history = [
      { role: "user", content: "之前的用户记录", entryId: "old-user", timestamp: t - 10000 },
      { role: "assistant", content: "之前的角色回复", entryId: "old-assistant", timestamp: t - 9000 },
    ];
    let rawMessages = history;
    let inboxMessages = [];
    let holdNextHistoryResponse = null;
    const inbox = (id, text, time) => ({ id, clientMessageId: "client-" + id, sessionId: session.id, characterId: character.id,
      text, status: "processing", burstId: "live-burst", createdAt: new Date(time).toISOString(), attachments: [] });
    const inputA = inbox("input-a", "这是一条测试消息", t);
    const inputB = inbox("input-b", "这是同一批的第二条消息", t + 800);
    const nextInput = { ...inbox("input-next", "这是后面排队的消息", t + 5000), status: "queued", burstId: undefined };
    // Neither a later completion timestamp nor an early provider timestamp changes parentage.
    const finalReply = { role: "assistant", content: "这一批的完整回复", entryId: "final-reply", timestamp: t + (space === "normal" ? 10000 : 500) };
    const user = (message, persistedTime) => ({ role: "user", content: message.text, entryId: "stored-" + message.id, timestamp: persistedTime });
    await page.route("**/api/v1/sessions/" + session.id + "/messages?*", async route => {
      const response = { status: 200, contentType: "application/json", body: JSON.stringify({ messages: rawMessages,
        page: { first: rawMessages[0]?.entryId ?? null, last: rawMessages.at(-1)?.entryId ?? null, hasEarlier: false, hasLater: false } }) };
      if (holdNextHistoryResponse) {
        const hold = holdNextHistoryResponse; holdNextHistoryResponse = null;
        hold(() => route.fulfill(response));
      } else await route.fulfill(response);
    });
    await page.route("**/api/v1/sessions/" + session.id + "/inbox?*", route => route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify({ messages: inboxMessages, running: inboxMessages.some(message => message.status === "processing") }),
    }));
    const assertOrder = async (expected, label) => {
      const rows = await page.locator("#messages > .message-row").evaluateAll(elements => elements.map(element => ({
        id: element.dataset.historyId, role: element.classList.contains("user") ? "user" : element.classList.contains("assistant") ? "assistant" : "other",
      })));
      assert.deepEqual(rows.map(row => row.role), expected, label + ": " + JSON.stringify(rows));
      assert.equal(rows.filter(row => row.id === "private-burst:live-burst").length, 1);
    };
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.characters.length === 1);
      await page.evaluate(async ({ id, space }) => { await openPersistentDirectConversation(id, space); closePrivateInboxEvents(); }, { id: character.id, space });
      await page.waitForFunction(() => !state.conversationViewLoading && messageHistory?.initialized);
      await page.evaluate(() => {
        const originalRender = renderMessages;
        renderMessages = function (...args) {
          originalRender(...args);
          if (window.completionFrames) window.completionFrames.push([...document.querySelectorAll("#messages > .message-row")].map(el => ({
            id: el.dataset.historyId, role: el.classList.contains("user") ? "user" : el.classList.contains("assistant") ? "assistant" : "other",
          })));
        };
      });
      for (const inputs of [[inputA], [inputA, inputB]]) {
        rawMessages = history; inboxMessages = [];
        await page.evaluate(async () => { state.privateInboxMessages = []; state.messages = []; resetMessageHistory(); await refreshSessionMessages(true); });
        inboxMessages = inputs;
        await page.evaluate(messages => handlePrivateInboxEvent({ type: "burst_started", burst: { id: "live-burst", messages } }), inputs);
        rawMessages = [...history, ...inputs.map((message, index) => user(message, index === inputs.length - 1 ? t + 2263 : t))];
        inboxMessages = [...inputs, nextInput];
        await page.evaluate(message => handlePrivateInboxEvent({ type: "message_queued", message }), nextInput);
        const expected = ["user", "assistant", ...inputs.map(() => "user"), "assistant", "user"];
        const checks = [];
        for (let round = 0; round < 3; round++) {
          await page.evaluate(round => handlePrivateInboxEvent({ type: "agent_event", burstId: "live-burst", event: { type: "delta", delta: "正在回复片段" + round } }), round);
          await assertOrder(expected, "delta before refresh");
          await page.evaluate(() => refreshSessionMessages(true));
          await assertOrder(expected, "persisted user timestamp must not invert the live reply");
          await page.evaluate(messages => handlePrivateInboxEvent({ type: "snapshot", inbox: { messages, running: true } }), inboxMessages);
          await page.evaluate(() => { renderCurrentCharacterCollaborations(); renderMessages(); });
          await assertOrder(expected, "queue snapshots and collaboration refresh keep the same anchor");
          checks.push(await page.locator('[data-history-id="private-burst:live-burst"] .bubble-text').innerText());
        }
        assert.ok(checks[2].includes("片段0") && checks[2].includes("片段2"), "polling preserves partial output");
        await page.evaluate(() => loadHistoryPage("latest"));
        await assertOrder(expected, "returning to latest during generation keeps the reply");
        assert.match(await page.locator('[data-history-id="private-burst:live-burst"] .bubble-text').innerText(), /片段0.*片段2/s);
        await page.screenshot({ path: resolve(outputDir, `streaming-order-${space}-${inputs.length}.png`), fullPage: true });
        await page.evaluate(() => { window.completionFrames = []; });
        // Pi can persist its reply before the inbox coordinator emits burst_done.
        const preCompletionMessages = rawMessages;
        rawMessages = [...rawMessages, finalReply];
        await page.evaluate(() => refreshSessionMessages(true));
        await assertOrder(expected, "early persistence must not render the final reply beside its live placeholder");
        rawMessages = preCompletionMessages;
        inboxMessages = [nextInput];
        await page.evaluate(() => refreshSessionMessages(true));
        await assertOrder(expected, "split history/inbox reads must not remove the reply while its replacement is missing");
        inboxMessages = [...inputs, nextInput];
        // A user-triggered "latest" page can also finish after the completion event.
        let releaseOldPage;
        const pageHeld = new Promise(resolvePromise => { holdNextHistoryResponse = release => { releaseOldPage = release; resolvePromise(); }; });
        await page.evaluate(() => { window.oldLatestPage = loadHistoryPage("latest"); });
        await pageHeld;
        // A periodic refresh starts before completion, but its old transcript arrives last.
        let releaseOldHistory;
        const historyHeld = new Promise(resolvePromise => { holdNextHistoryResponse = release => { releaseOldHistory = release; resolvePromise(); }; });
        await page.evaluate(() => { window.oldStreamingRefresh = refreshSessionMessages(true); });
        await historyHeld;
        rawMessages = [...rawMessages, finalReply];
        inboxMessages = [nextInput];
        if (inputs.length === 1) {
          await page.evaluate(ids => handlePrivateInboxEvent({ type: "burst_done", burstId: "live-burst", messageIds: ids,
            response: { reply: "这一批的完整回复", status: "completed", actions: [] } }), inputs.map(message => message.id));
        } else {
          // Reconnection can recover completion from a snapshot without seeing burst_done.
          await page.evaluate(messages => handlePrivateInboxEvent({ type: "snapshot", inbox: { messages, running: false } }), inboxMessages);
        }
        const finalRoles = await page.locator("#messages > .message-row").evaluateAll(elements => elements.map(element => element.classList.contains("user") ? "user" : "assistant"));
        assert.deepEqual(finalRoles, expected, "settling replaces the live row without changing logical order");
        assert.equal(await page.locator('[data-history-id="private-burst:live-burst"]').count(), 0);
        assert.equal(await page.locator('[data-history-id="final-reply"]').count(), 1);
        await releaseOldHistory();
        await page.evaluate(() => window.oldStreamingRefresh);
        await releaseOldPage();
        assert.equal(await page.evaluate(() => window.oldLatestPage), false, "an old latest-page request is invalidated by completion");
        const frames = await page.evaluate(() => window.completionFrames);
        for (const [index, rows] of frames.entries()) {
          assert.deepEqual(rows.map(row => row.role), expected, "every completion render keeps one reply in place, frame " + index + ": " + JSON.stringify(rows));
        }
        assert.equal(await page.locator('[data-history-id="final-reply"]').count(), 1, "late polling must not resurrect the streaming placeholder");
        assert.equal(await page.locator('[data-history-id="private-burst:live-burst"]').count(), 0);
        await page.evaluate(() => { window.completionFrames = null; });
        await page.evaluate(() => refreshSessionMessages(true));
        assert.equal(await page.locator('[data-history-id="final-reply"]').count(), 1);
      }
      assert.deepEqual(errors, []);
      console.log(`Streaming reply order checks passed (${space}, ${width}px)`);
    } finally { await page.close(); await new Promise(resolvePromise => server.close(resolvePromise)); runtime.dispose(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runStreamingOrderChecks(browser, outputDir); } finally { await browser.close(); }
}
