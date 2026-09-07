import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runHistoryPaginationChecks(browser, outputDir) {
  const runtime = createTestRuntime(); const kernel = runtime.kernel;
  kernel.patchModelApiConfig({ enabled: false });
  const alice = kernel.createCharacter({ name: "林澈" }); const bob = kernel.createCharacter({ name: "顾遥" });
  const world = kernel.createWorld({ name: "河岸历史世界" });
  for (const character of [alice, bob]) kernel.assignCharacterWorld(character.id, { worldId: world.id });
  const session = await kernel.openCanonicalPrivateConversation(alice.id);
  const handle = await kernel.sessionRuntime.getOrCreate(session.id, "sms", alice.id);
  const baseTime = runtime.clock.now().getTime();
  for (let index = 0; index < 220; index++) {
    const text = `第 ${index} 条往事。${index === 12 ? "唯一针尖 <script>window.historyXss=true</script>" : "雨停后，我们沿着河岸走了很久。"}\n\n![回忆 ${index}](/history-images/${index}.png)`;
    const message = index % 2 ? fauxAssistantMessage(text) : { role: "user", content: text, timestamp: baseTime + index * 1000 };
    message.timestamp = baseTime + index * 1000;
    kernel.sessionRuntime.appendMessages(handle, [message]);
  }
  const now = runtime.clock.now().toISOString();
  kernel.worldConversationService.repository.ensureConversation(world.id, now);
  kernel.worldConversationService.repository.createTurn({ id: "history-browser-turn", worldId: world.id, status: "completed", modelCalls: 0, actorCount: 0, startedAt: now });
  const group = kernel.createGroupChat({ characterIds: [alice.id, bob.id], title: "河岸群聊" });
  kernel.groupChatService.repository.createTurn({ id: "history-group-turn", groupId: group.id, status: "completed", modelCalls: 0, speakerCount: 0, messageCount: 0, startedAt: now });
  for (let index = 0; index < 220; index++) {
    const content = `世界记录 ${index} · ${index === 15 ? "世界独有线索" : "河岸书店的日常"}`;
    kernel.worldConversationService.repository.appendMessage({ id: `world-history-${index}`, worldId: world.id, turnId: "history-browser-turn", senderType: index % 2 ? "director" : "user", content, attachments: [], createdAt: new Date(baseTime + index * 1000).toISOString() });
    kernel.groupChatService.repository.appendMessage({ id: `group-history-${index}`, groupId: group.id, turnId: "history-group-turn", senderType: "character", senderId: bob.id, content: `群聊记录 ${index}`, createdAt: now });
  }
  const server = createHttpServer({ kernel }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors = []; const images = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/history-images/*.png", route => { images.push(Number(route.request().url().match(/(\d+)\.png$/)[1])); return route.fulfill({ status: 200, contentType: "image/png", body: png }); });
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(id => typeof state !== "undefined" && state.sessions.some(entry => entry.id === id), session.id);
        await page.evaluate(id => applySession(state.sessions.find(entry => entry.id === id)), session.id);
        await page.waitForFunction(() => messageHistory?.initialized && messageHistory.raw.length === 40 && !state.conversationViewLoading);
        assert.equal(await page.locator("#messages [data-history-id]").count(), 40);
        const budgetButton = page.locator("#contextBudgetBtn");
        assert.equal((await budgetButton.textContent()).trim(), "");
        assert.equal(await budgetButton.locator(".context-budget-ring").isVisible(), true);
        const ringSize = await budgetButton.locator(".context-budget-ring").boundingBox();
        assert.equal(ringSize.width, 18);
        assert.equal(ringSize.height, 18);
        assert.match(await budgetButton.getAttribute("aria-label"), /查看上下文余量.*已用.*%/);
        if ([390, 1440].includes(width)) await page.locator(".header-right").screenshot({ path: resolve(outputDir, `context-ring-${width}.png`) });
        await budgetButton.click();
        await page.locator("#contextBudgetDialog").waitFor({ state: "visible" });
        await page.getByRole("button", { name: "关闭上下文余量" }).click();
        assert.equal(await page.locator("#messages").innerText().then(text => text.includes("唯一针尖")), false);
        await page.waitForFunction(() => document.querySelector("#messages img[data-history-src][src]") !== null);
        assert.ok(images.length < 20, `only viewport-adjacent images load, got ${images.length}`);
        assert.ok(images.every(index => index >= 180), `old images downloaded: ${images}`);
        await page.evaluate(() => { window.retainedHistoryImage = document.querySelector("#messages img[data-history-src][src]"); renderMessages({ preserveScroll: true }); });
        assert.equal(await page.evaluate(() => document.getElementById("messages").contains(window.retainedHistoryImage)), true);
        await page.locator("#messages").evaluate(el => { el.scrollTop = 0; });
        const anchor = await page.evaluate(() => captureHistoryAnchor());
        await page.locator('[data-history-load="before"]').click();
        await page.waitForFunction(() => messageHistory.raw.length === 80 && !messageHistory.loading);
        const delta = await page.evaluate(anchor => {
          const row = document.querySelector('[data-history-id="' + CSS.escape(anchor.id) + '"]');
          return row.getBoundingClientRect().top - document.getElementById("messages").getBoundingClientRect().top - anchor.offset;
        }, anchor);
        assert.ok(Math.abs(delta) < 3, `prepend must keep the visible anchor, drift=${delta}`);
        await page.evaluate(() => refreshSessionMessages(true));
        assert.equal(await page.evaluate(() => messageHistory.raw.length), 80);
        // Scrolling upward loads one extra page without needing the explicit button.
        await page.locator("#messages").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new WheelEvent("wheel", { deltaY: -120 })); });
        await page.waitForFunction(() => messageHistory.raw.length === 120 && !messageHistory.loading);
        for (let index = 0; index < 3; index++) await page.evaluate(() => loadHistoryPage("before"));
        assert.equal(await page.evaluate(() => messageHistory.raw.length), 160);
        assert.equal(await page.locator("#historyPositionBar").isVisible(), true);
        await page.locator("#historySearchBtn").click();
        await page.locator("#historySearchInput").fill("唯一针尖");
        await page.locator("#historySearchForm").getByRole("button", { name: "搜索", exact: true }).click();
        await page.locator(".history-search-result").waitFor();
        assert.equal(await page.locator(".history-search-result").count(), 1);
        assert.equal(await page.evaluate(() => window.historyXss), undefined);
        assert.equal(await page.locator("#historySearchResults script").count(), 0);
        if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `history-search-${width}.png`) });
        await page.locator(".history-search-result").click();
        await page.locator(".history-focus").filter({ hasText: "唯一针尖" }).waitFor();
        assert.equal(await page.evaluate(() => messageHistory.raw.length), 40);
        assert.equal(await page.locator("#historyPositionBar").isVisible(), true);
        const found = await page.locator(".history-focus").boundingBox();
        assert.ok(found.y >= 0 && found.y < 900);
        await page.evaluate(() => refreshSessionMessages(true));
        assert.ok(await page.locator("#messages").innerText().then(text => text.includes("唯一针尖")), "background refresh must preserve a located history window");
        if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `history-located-${width}.png`) });
        await page.locator("#historyLatestBtn").click();
        await page.waitForFunction(() => !messageHistory.loading && !messageHistory.page.hasLater && messageHistory.raw.length === 40);
        assert.match(await page.locator("#messages").innerText(), /第 219 条/);
        assert.doesNotMatch(await page.locator("#messages").innerText(), /唯一针尖/);

        await page.evaluate(id => applyWorldConversation(state.worldConversations.find(entry => entry.worldId === id)), world.id);
        assert.equal(await page.locator("#historySearchInput").inputValue(), "");
        assert.equal(await page.evaluate(() => messageHistory.raw.length), 40);
        await page.locator("#historySearchBtn").click();
        await page.locator("#historySearchInput").fill("世界独有线索");
        await page.locator("#historySearchForm").getByRole("button", { name: "搜索", exact: true }).click();
        await page.locator(".history-search-result").click();
        await page.locator(".history-focus").filter({ hasText: "世界独有线索" }).waitFor();
        const worldAnchor = await page.evaluate(() => captureHistoryAnchor());
        await page.evaluate(() => refreshWorldMessages(true));
        const worldDrift = await page.evaluate(anchor => {
          const row = document.querySelector('[data-history-id="' + CSS.escape(anchor.id) + '"]');
          return row.getBoundingClientRect().top - document.getElementById("messages").getBoundingClientRect().top - anchor.offset;
        }, worldAnchor);
        assert.ok(Math.abs(worldDrift) < 3, `world refresh moved the located history, drift=${worldDrift}`);
        await page.evaluate(group => { state.groupChats = [group]; return applyGroupChat(group); }, group);
        assert.equal(await page.evaluate(() => messageHistory.raw.length), 40);
        assert.doesNotMatch(await page.locator("#messages").innerText(), /世界独有线索|唯一针尖/);
        await page.locator("#historySearchBtn").click();
        await page.locator("#historySearchInput").fill("群聊记录");
        await page.locator("#historySearchForm").getByRole("button", { name: "搜索", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".history-search-result").length === 20);
        await page.locator("#historySearchMoreBtn").click();
        await page.waitForFunction(() => document.querySelectorAll(".history-search-result").length === 40);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#historySearchDialog").isVisible(), false);
        if (width === 390) {
          // A delayed result from the previous conversation must never populate the new one.
          let releaseSearch; let searchArrived;
          const release = new Promise(resolve => { releaseSearch = resolve; });
          const arrived = new Promise(resolve => { searchArrived = resolve; });
          const searchRoute = "**/group-chats/" + group.id + "/messages/search?**";
          await page.route(searchRoute, async route => {
            searchArrived(); await release;
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ id: "stale-result", role: "user", snippet: "STALE_SEARCH_SENTINEL", timestamp: baseTime }], next: null }) }).catch(() => {});
          });
          await page.locator("#historySearchBtn").click();
          await page.locator("#historySearchForm").getByRole("button", { name: "搜索", exact: true }).click();
          await arrived;
          await page.evaluate(id => applySession(state.sessions.find(entry => entry.id === id)), session.id);
          releaseSearch();
          await page.unrouteAll({ behavior: "wait" });
          assert.equal(await page.locator("#historySearchInput").inputValue(), "");
          assert.equal(await page.locator(".history-search-result").count(), 0);
          assert.doesNotMatch(await page.locator("#messages").innerText(), /群聊记录|STALE_SEARCH_SENTINEL/);
          // An authoritative empty refresh clears cached records after reset/retraction.
          await page.evaluate(() => { acceptHistoryPage({ messages: [], page: { first: null, last: null, hasEarlier: false, hasLater: false } }); state.messages = normalizeHistoryMessages(messageHistory.raw); renderMessages(); });
          assert.equal(await page.locator("#messages [data-history-id]").count(), 0);
          assert.equal(await page.locator("#historyPositionBar").isVisible(), false);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        console.log(`History pagination/search/image checks passed at ${width}px`);
      } finally { await page.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); runtime.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runHistoryPaginationChecks(browser, outputDir); }
  finally { await browser.close(); }
}
