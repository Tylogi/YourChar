import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { launch } from "cloakbrowser";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runLocaleChecks(browser) {
  const runtime = createTestRuntime();
  const kernel = runtime.kernel;
  kernel.patchModelApiConfig({ enabled: false });
  const character = kernel.createCharacter({ name: "设置" });
  const session = await kernel.openCanonicalPrivateConversation(character.id);
  const handle = await kernel.sessionRuntime.getOrCreate(session.id, "sms", character.id);
  kernel.sessionRuntime.appendMessages(handle, [
    { role: "user", content: "聊天", timestamp: runtime.clock.now().getTime() },
    fauxAssistantMessage("日程"),
  ]);
  const server = createHttpServer({ kernel });
  await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US", reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem("yourchar.locale", "en"));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(id => typeof state !== "undefined" && state.sessions.some(entry => entry.id === id), session.id);
    await page.evaluate(id => applySession(state.sessions.find(entry => entry.id === id)), session.id);
    await page.waitForFunction(() => document.querySelector("#normalBtn span")?.textContent === "Chat");

    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.equal(await page.locator("html").getAttribute("data-locale-preference"), "en");
    assert.equal(await page.locator("#normalBtn span").textContent(), "Chat");
    assert.equal(await page.locator("#scheduleBtn span").textContent(), "Schedule");
    assert.equal(await page.locator("#charactersBtn span").textContent(), "Characters");
    assert.equal(await page.locator("#managementBtn span").textContent(), "Management");
    assert.equal(await page.locator("#settingsBtn span").textContent(), "Settings");
    assert.equal(await page.locator("#conversationCharacter").textContent(), "设置", "character names are user data");
    assert.equal((await page.locator(".bubble.user .markdown-body").textContent()).trim(), "聊天", "user messages are not translated");
    assert.equal((await page.locator(".bubble.assistant .markdown-body").textContent()).trim(), "日程", "character messages are not translated");

    await page.locator("#charactersBtn").click();
    assert.equal((await page.locator(`[data-character-card-id="${character.id}"] strong`).textContent()).trim(), "设置", "character names in cards are not translated");

    await page.locator("#scheduleBtn").click();
    await page.waitForFunction(() => document.querySelectorAll("#scheduleCalendar .calendar-day").length === 42);
    const month = await page.locator("#scheduleMonthLabel").textContent();
    assert.match(month, /[A-Za-z]/);
    assert.doesNotMatch(month, /[年月]/u);

    await page.locator("#settingsBtn").click();
    await page.locator("#appearanceSettingsTabBtn").click();
    assert.equal((await page.locator("#appearanceSettingsTabBtn").textContent()).trim(), "Appearance & language");
    assert.equal((await page.locator("#appearanceSettingsPanel h4").textContent()).trim(), "Interface language");
    assert.equal(await page.locator('[data-locale-choice="en"]').getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("#localeStatus").textContent(), /Currently English/i);

    if (process.env.YOURCHAR_LOCALE_AUDIT === "1") {
      const audit = {};
      for (const [name, selector] of [["chat", "#normalBtn"], ["schedule", "#scheduleBtn"], ["characters", "#charactersBtn"], ["management", "#managementBtn"]]) {
        await page.locator(selector).click();
        await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
        audit[name] = await visibleChineseUi(page);
      }
      await page.locator("#scheduleBtn").click();
      for (const [name, selector] of [["user", "#userScheduleTabBtn"], ["character", "#characterScheduleTabBtn"]]) {
        await page.locator(selector).click();
        await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
        audit["schedule:" + name] = await visibleChineseUi(page);
      }
      await page.locator("#charactersBtn").click();
      await page.locator(`[data-character-card-id="${character.id}"]`).click();
      for (const [name, selector] of [["settings", "#characterSettingsTabBtn"], ["function", "#characterFunctionTabBtn"], ["memory", "#characterMemoryTabBtn"], ["relationship", "#characterRelationshipTabBtn"], ["life", "#characterLifeTabBtn"]]) {
        await page.locator(selector).click();
        await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
        audit["characters:" + name] = await visibleChineseUi(page);
      }
      await page.locator("#managementBtn").click();
      for (const [name, selector] of [["creator", "#creatorTabBtn"], ["modules", "#modulesTabBtn"], ["profile", "#profileTabBtn"], ["memory", "#memoryManagementTabBtn"], ["files", "#workspaceFilesTabBtn"]]) {
        await page.locator(selector).click();
        await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
        audit["management:" + name] = await visibleChineseUi(page);
      }
      await page.locator("#settingsBtn").click();
      for (const tab of ["model", "im", "vision", "document", "git", "search", "prompt", "data", "appearance"]) {
        await page.locator("#" + tab + "SettingsTabBtn").click();
        await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
        audit["settings:" + tab] = await visibleChineseUi(page);
      }
      await page.locator("#debugBtn").click();
      for (const [name, selector] of [["traces", "#debugTracesBtn"], ["economics", "#debugEconomicsBtn"], ["initiative", "#debugInitiativeBtn"], ["feature-tests", "#debugFeatureTestsBtn"], ["task-bench", "#debugTaskBenchBtn"]]) {
        await page.locator(selector).click();
        await page.evaluate(() => new Promise(resolvePromise => requestAnimationFrame(() => requestAnimationFrame(resolvePromise))));
        audit["debug:" + name] = await visibleChineseUi(page);
      }
      console.log("LOCALE_AUDIT=" + JSON.stringify(audit, null, 2));
      await page.locator("#settingsBtn").click();
      await page.locator("#appearanceSettingsTabBtn").click();
    }

    await page.locator('[data-locale-choice="zh-CN"]').click();
    await page.waitForFunction(() => document.documentElement.lang === "zh-CN" && document.querySelector("#normalBtn span")?.textContent === "聊天");
    assert.equal(await page.locator('[data-locale-choice="zh-CN"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#conversationCharacter").textContent(), "设置");

    await page.locator('[data-locale-choice="en"]').click();
    await page.waitForFunction(() => document.documentElement.lang === "en" && document.querySelector("#normalBtn span")?.textContent === "Chat");
    assert.equal(await page.evaluate(() => localStorage.getItem("yourchar.locale")), "en");
    assert.deepEqual(errors, []);
    console.log("Locale settings checks passed (system/zh-CN/en)");
  } finally {
    await page.close();
    await new Promise(resolvePromise => server.close(resolvePromise));
    runtime.dispose();
  }
}

async function visibleChineseUi(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll("body *")].filter(element => {
    if (element.children.length || element.closest("#messages, #conversationCharacter, #conversationScene, [data-i18n-user-content], pre, code, textarea")) return false;
    const text = (element.textContent || "").trim();
    if (!/[\u3400-\u9fff]/u.test(text)) return false;
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return !element.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }).map(element => (element.textContent || "").trim()))].sort((left, right) => left.localeCompare(right, "zh-CN")));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await launch({ headless: true });
  try { await runLocaleChecks(browser); } finally { await browser.close(); }
}
