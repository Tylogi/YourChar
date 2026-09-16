import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runAppearanceChecks(browser, outputDir) {
  const runtime = createTestRuntime(); const kernel = runtime.kernel;
  kernel.patchModelApiConfig({ enabled: false });
  const character = kernel.createCharacter({ name: "林澈" });
  const world = kernel.createWorld({ name: "夜色河岸" });
  kernel.assignCharacterWorld(character.id, { worldId: world.id });
  const session = await kernel.openCanonicalPrivateConversation(character.id);
  const handle = await kernel.sessionRuntime.getOrCreate(session.id, "sms", character.id);
  kernel.sessionRuntime.appendMessages(handle, [
    { role: "user", content: "夜色正好，沿河走一会儿吧。\n\n[今晚的计划](https://example.invalid) · `慢慢来`", timestamp: runtime.clock.now().getTime() },
    fauxAssistantMessage("好，等我拿上外套。\n\n河边应该已经安静下来了，我们就走到书店那一段。")
  ]);
  const server = createHttpServer({ kernel }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "zh-CN", colorScheme: "dark", reducedMotion: "reduce" });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        await page.waitForFunction(id => typeof state !== "undefined" && state.sessions.some(entry => entry.id === id), session.id);
        await page.evaluate(id => applySession(state.sessions.find(entry => entry.id === id)), session.id);
        await expectStyle(page, ".bubble.user", { backgroundColor: "rgb(52, 52, 52)", color: "rgb(247, 247, 247)" });
        await expectStyle(page, ".bubble.user a", { color: "rgb(247, 247, 247)" });
        await expectStyle(page, "#textInput", { backgroundColor: "rgba(0, 0, 0, 0)", color: "rgb(237, 237, 237)" });
        await expectStyle(page, "#composer", { backgroundColor: "rgb(34, 34, 34)" });
        await expectStyle(page, "#messages", { color: "rgb(237, 237, 237)" });
        await expectStyle(page, ".message-avatar", { backgroundColor: "rgb(54, 54, 54)" });
        assert.equal(await page.locator("#contextBudgetBtn .context-budget-ring").isVisible(), true);
        await noBrightSurfaces(page);
        if (width !== 320) await page.screenshot({ path: resolve(outputDir, `appearance-chat-dark-${width}.png`) });
        await page.locator("#historySearchBtn").click();
        await expectStyle(page, "#historySearchDialog", { backgroundColor: "rgb(34, 34, 34)" });
        await page.keyboard.press("Escape");
        await page.locator("#contextBudgetBtn").click();
        await noBrightSurfaces(page);
        await page.getByRole("button", { name: "关闭上下文余量" }).click();
        await page.locator("#scheduleBtn").click();
        await page.waitForFunction(() => document.querySelectorAll("#scheduleCalendar .calendar-day").length === 42);
        await noBrightSurfaces(page);
        await expectStyle(page, ".calendar-panel", { backgroundColor: "rgb(34, 34, 34)" });
        if (width !== 320) await page.screenshot({ path: resolve(outputDir, `appearance-calendar-dark-${width}.png`) });
        await page.locator("#normalBtn").click();
        await page.evaluate(async worldId => {
          await applyWorldConversation(state.worldConversations.find(entry => entry.worldId === worldId));
          state.messages = [{ role: "assistant", worldNarration: true, worldTurnId: "dark-world", text: "书店里只剩下一盏灯，河岸慢慢安静下来。", at: "22:30" }];
          renderMessages();
        }, world.id);
        await expectStyle(page, ".world-scene-turn", { backgroundColor: "rgb(34, 34, 34)" });
        await expectStyle(page, ".world-scene-text", { color: "rgb(237, 237, 237)" });
        await noBrightSurfaces(page);
        if (width !== 320) await page.screenshot({ path: resolve(outputDir, `appearance-world-dark-${width}.png`) });
        await page.locator("#settingsBtn").click();
        for (const tab of ["model", "im", "vision", "document", "git", "search", "prompt", "data"]) {
          await page.locator("#" + tab + "SettingsTabBtn").click();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await noBrightSurfaces(page);
        }
        await page.locator("#appearanceSettingsTabBtn").click();
        await page.locator('[data-theme-choice="dark"]').click();
        await expectStyle(page, "#appearanceSettingsPanel", { backgroundColor: "rgb(34, 34, 34)" });
        await noBrightSurfaces(page);
        assert.equal(await page.locator('[data-theme-choice="dark"]').getAttribute("aria-pressed"), "true");
        if (width !== 320) await page.screenshot({ path: resolve(outputDir, `appearance-settings-dark-${width}.png`) });
        await page.emulateMedia({ colorScheme: "light" });
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        await page.reload({ waitUntil: "domcontentloaded" });
        assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
        await page.locator("#settingsBtn").click();
        await page.locator("#appearanceSettingsTabBtn").click();
        await page.locator('[data-theme-choice="system"]').click();
        assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
        await page.locator('[data-theme-choice="light"]').click();
        await page.locator("#normalBtn").click();
        await page.evaluate(id => applySession(state.sessions.find(entry => entry.id === id)), session.id);
        await expectStyle(page, ".bubble.user", { backgroundColor: "rgb(36, 36, 36)", color: "rgb(247, 247, 247)" });
        await expectStyle(page, "#sendBtn", { backgroundColor: "rgb(26, 26, 26)", color: "rgb(255, 255, 255)" });
        if (width !== 320) await page.screenshot({ path: resolve(outputDir, `appearance-chat-light-${width}.png`) });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        console.log(`Appearance/ring checks passed at ${width}px`);
      } finally { await page.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); runtime.dispose(); }
}

async function expectStyle(page, selector, expected) {
  const actual = await page.locator(selector).first().evaluate(el => { const css = getComputedStyle(el); return { backgroundColor: css.backgroundColor, color: css.color }; });
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, selector + " " + key);
}
async function noBrightSurfaces(page) {
  const bright = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => {
    if (el.closest(".appearance-swatch, .im-qr-stage")) return false;
    const rect = el.getBoundingClientRect(); const css = getComputedStyle(el);
    if (rect.width * rect.height < 3000 || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth || css.visibility === "hidden") return false;
    const rgb = css.backgroundColor.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
    return rgb && Math.min(...rgb.slice(1).map(Number)) > 180;
  }).map(el => el.tagName + "#" + el.id + "." + el.className));
  assert.deepEqual(bright, [], "unexpected bright surfaces in dark mode");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runAppearanceChecks(browser, outputDir); } finally { await browser.close(); }
}
