import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runCreatorChecks(browser, outputDir) {
  for (const theme of ["light", "dark"]) {
    const runtime = createTestRuntime({ seed: `creator-browser-${theme}` });
    const kernel = runtime.kernel;
    const server = createHttpServer({ kernel });
    await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    const page = await browser.newPage({ viewport: { width: theme === "dark" ? 390 : 1440, height: 1000 }, locale: "zh-CN", colorScheme: theme, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.locator("#managementBtn").click();
      await page.locator("#creatorTabBtn").click();
      await page.locator(".creator-empty").waitFor();
      await page.screenshot({ path: resolve(outputDir, `creator-empty-${theme}.png`), fullPage: true });
      runtime.model.enqueue([
        { kind: "tool_calls", calls: [{ name: "creator_propose", arguments: {
          title: "一位安静的旧书店主人", reason: "保留日常感，给角色留下慢慢相识的空间。",
          operation: { kind: "create_character", input: { name: "林澈", soulMarkdown: "# 林澈\n住在海边，经营一间旧书店。说话简洁，会记得熟客喜欢的书。\n测试文本 <img src=x onerror=alert(1)>" } },
        } }] },
        { kind: "assistant_text", text: "我为林澈准备了一份设定草案。\n他不必一上来就有复杂的身世，从书店和日常生活慢慢展开就很好。\n你可以先看看右侧的完整设定，确认后再发布。" },
      ]);
      await page.locator("#creatorInput").fill("帮我设计一位海边旧书店的主人，性格克制、温和。准备好设定草案。");
      await page.locator("#creatorSend").click();
      await page.locator(".creator-proposal").waitFor();
      assert.equal(kernel.listCharacters().length, 0, "chat only proposes changes");
      await page.locator(".creator-proposal > details > summary").first().click();
      assert.equal(await page.locator("#creatorProposals img").count(), 0);
      await page.screenshot({ path: resolve(outputDir, `creator-preview-${theme}.png`), fullPage: true });
      await page.locator('[data-creator-review="apply"]').click();
      assert.equal(kernel.listCharacters().length, 0, "opening confirmation still does not apply");
      await page.locator("#confirmSessionActionBtn").click();
      await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
      await page.waitForFunction(() => creatorSnapshot?.proposals[0]?.status === "applied");
      assert.equal(kernel.listCharacters().length, 1);
      await page.locator("#creatorRefresh").click();
      await page.waitForFunction(() => !creatorLoading);
      assert.equal(kernel.listCharacters().length, 1);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("#managementBtn").click(); await page.locator("#creatorTabBtn").click();
      await page.locator(".creator-proposal").waitFor();
      assert.match(await page.locator("#creatorMessages").textContent(), /已确认并应用/);
      const bounds = await page.locator("#creatorPanel").evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(bounds.scroll <= bounds.width + 1, "creator fits narrow screens");
      await kernel.deleteAllUserData();
      await page.evaluate(() => clearCreatorView());
      assert.equal(await page.locator("#creatorMessages").textContent(), "");
      assert.equal(await page.locator("#creatorProposals").textContent(), "");
      await page.locator("#creatorRefresh").click();
      await page.locator(".creator-empty").waitFor();
      assert.deepEqual(errors, []);
      console.log(`Creator browser checks passed (${theme})`);
    } finally { await page.close(); await new Promise(resolvePromise => server.close(resolvePromise)); runtime.dispose(); }
  }
  await runCreatorSessionChecks(browser, outputDir);
}

async function runCreatorSessionChecks(browser, outputDir) {
  const runtime = createTestRuntime({ seed: "creator-browser-sessions" });
  const kernel = runtime.kernel;
  const server = createHttpServer({ kernel });
  await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: "zh-CN", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const reply = (text, titles, delayMs) => runtime.model.enqueue([
    ...(titles ? [{ kind: "tool_calls", calls: [titles].flat().map(title => ({ name: "creator_propose", arguments: { title, reason: "测试", operation: { kind: "create_world", input: { name: title } } } })) }] : []),
    { kind: "assistant_text", text, ...(delayMs ? { delayMs } : {}) },
  ]);
  const idle = () => page.waitForFunction(() => !creatorSending && !creatorLoading && !creatorReloadPending);
  const viewIs = id => page.waitForFunction(value => creatorView.sessionId === value && creatorSnapshot?.sessionId === value && !creatorLoading, id);
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const open = async () => {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.locator("#managementBtn").click();
      await page.locator("#creatorTabBtn").click();
    };
    await open();
    await page.locator(".creator-start-options").waitFor();

    // 一键建构 opens its own session; a later chat session is isolated from it.
    await page.locator('[data-creator-start="world_builder"]').click();
    assert.equal(await page.locator("#creatorBuilderToggle").getAttribute("aria-pressed"), "true");
    reply("世界草案已准备好。", ["猎人世界", "流星街世界"]);
    await page.locator("#creatorInput").fill("我穿越到了全职猎人的世界");
    await page.locator("#creatorSend").click();
    await page.locator(".creator-proposal").first().waitFor(); await idle();
    const builderId = await page.evaluate(() => creatorView.sessionId);
    await page.locator("[data-creator-new]").click();
    reply("书店很好。", "海边小镇");
    await page.locator("#creatorInput").fill("设计一位海边书店主人");
    await page.locator("#creatorSend").click();
    await page.waitForFunction(() => !creatorSending && creatorView.sessionId); await idle();
    const chatId = await page.evaluate(() => creatorView.sessionId);
    assert.notEqual(chatId, builderId);
    assert.doesNotMatch(await page.locator("#creatorMessages").textContent(), /全职猎人/);
    assert.deepEqual(await page.locator(".creator-proposal h5").allTextContents(), ["海边小镇"], "each session shows only its own drafts");
    await page.locator(`[data-creator-session="${builderId}"]`).click(); await viewIs(builderId);
    assert.match(await page.locator("#creatorMessages").textContent(), /全职猎人/);
    await page.locator("[data-creator-home]").click(); await viewIs(null);
    assert.equal(await page.locator("#creatorReviewBar").isHidden(), true, "no cross-session apply-all on the start page");
    assert.equal(await page.locator(".creator-proposal-group").count(), 2, "pending drafts are grouped by session");
    const builderGroup = page.locator(`.creator-proposal-group[data-creator-group="${builderId}"]`);
    assert.equal(await builderGroup.locator(".creator-proposal").count(), 2);
    assert.equal(await page.locator(`.creator-proposal-group[data-creator-group="${chatId}"] [data-creator-apply-session]`).count(), 0, "a single draft is confirmed on its own");
    await page.screenshot({ path: resolve(outputDir, "creator-sessions-start.png"), fullPage: true });
    await builderGroup.locator("[data-creator-apply-session]").click();
    await page.locator("#confirmSessionActionBtn").click();
    await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
    await idle();
    assert.deepEqual(kernel.listWorlds().map(world => world.name).sort(), ["流星街世界", "猎人世界"], "only that session's drafts are applied, in order");
    assert.deepEqual(kernel.creator.snapshot(undefined, chatId).proposals.map(proposal => proposal.status), ["pending"], "other sessions are untouched");
    assert.equal(await page.locator(".creator-proposal-group").count(), 1);

    // Switching while a load is still in flight lands on the requested view.
    let delayed = true;
    await page.route("**/api/v1/creator/snapshot", async route => {
      if (delayed) { delayed = false; await new Promise(resolvePromise => setTimeout(resolvePromise, 600)); }
      await route.continue();
    });
    await page.locator("#creatorRefresh").click();
    await page.locator(`[data-creator-session="${chatId}"]`).click();
    await viewIs(chatId);
    assert.match(await page.locator("#creatorMessages").textContent(), /海边书店/);
    await page.unroute("**/api/v1/creator/snapshot");

    // A send keeps running after switching away; the other session neither shows its pending bubble nor goes silent.
    await page.locator(`[data-creator-session="${builderId}"]`).click(); await viewIs(builderId);
    reply("补充完毕。", undefined, 1500);
    await page.locator("#creatorInput").fill("继续");
    await page.locator("#creatorSend").click();
    await page.locator(".creator-message.assistant.pending").waitFor();
    await page.locator(`[data-creator-session="${chatId}"]`).click();
    await page.waitForFunction(value => creatorView.sessionId === value, chatId);
    assert.equal(await page.locator(".creator-message.assistant.pending").count(), 0);
    await page.waitForFunction(() => !creatorLoading && !creatorReloadPending);
    assert.equal(await page.locator(".creator-message.assistant.pending").count(), 0);
    assert.match(await page.locator("#creatorMessages").textContent(), /海边书店/);
    assert.match(await page.locator("#creatorStatus").textContent(), /另一个会话正在回复/);
    await idle();

    // A remembered session that no longer exists falls back to the start page.
    await page.evaluate(() => localStorage.setItem("yourchar.creator.view", "creator-session-missing"));
    await open();
    await page.locator(".creator-start-options").waitFor();
    await idle();
    assert.equal(await page.evaluate(() => creatorView.sessionId), null);
    assert.equal(await page.locator("#creatorSend").isDisabled(), false);

    // A lost response for a recorded first message: resending reuses it instead of starting a duplicate session.
    await page.locator('[data-creator-start="chat"]').click();
    const sessionsBefore = kernel.creator.sessions().length;
    const modelCallsBefore = runtime.model.requests.length;
    reply("收到。");
    let dropOnce = true;
    await page.route("**/api/v1/creator/messages", async route => {
      if (!dropOnce) return route.continue();
      dropOnce = false;
      await route.fetch();
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "网关超时" }) });
    });
    await page.locator("#creatorInput").fill("帮我想一个城市");
    await page.locator("#creatorSend").click();
    await page.waitForFunction(() => creatorEl("creatorInput").value === "帮我想一个城市"); await idle();
    await page.locator("#creatorSend").click();
    await page.waitForFunction(() => !creatorSending && creatorView.sessionId); await idle();
    assert.equal(kernel.creator.sessions().length, sessionsBefore + 1, "no duplicate session");
    assert.equal(runtime.model.requests.length, modelCallsBefore + 1, "the model is not called twice");
    await page.unroute("**/api/v1/creator/messages");

    await page.setViewportSize({ width: 390, height: 900 });
    const bounds = await page.locator("#creatorPanel").evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(bounds.scroll <= bounds.width + 1, "sessions fit narrow screens");
    assert.deepEqual(errors, []);
    console.log("Creator session browser checks passed");
  } finally { await page.close(); await new Promise(resolvePromise => server.close(resolvePromise)); runtime.dispose(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runCreatorChecks(browser, outputDir); } finally { await browser.close(); }
}
