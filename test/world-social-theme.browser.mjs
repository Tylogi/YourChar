import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

// Exercise the real world and character-channel renderers with isolated fixture data.
export async function runWorldSocialThemeChecks(browser, outputDir) {
  const runtime = createTestRuntime();
  const kernel = runtime.kernel;
  kernel.patchModelApiConfig({ enabled: false });
  const characters = ["林澈", "顾遥", "许宁", "陈望", "温晴", "沈知"].map(name => kernel.createCharacter({ name }));
  const world = kernel.createWorld({ name: "河岸小城" });
  for (const character of characters) kernel.assignCharacterWorld(character.id, { worldId: world.id });
  const server = createHttpServer({ kernel });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [320, 390, 768, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(id => typeof state !== "undefined" && state.worldConversations.some(entry => entry.worldId === id), world.id);
        await page.evaluate(async ({ worldId, characterId }) => {
          await applyWorldConversation(state.worldConversations.find(entry => entry.worldId === worldId));
          state.messages = [
            { role: "user", text: "雨停了，我们沿着河岸走一会儿吧。", at: "17:40" },
            { role: "assistant", worldNarration: true, worldTurnId: "scene-1", at: "17:41", text: "雨后的日光落在书店的玻璃上。大家把借来的书放回窗边，推开门时，河风正好吹进来。\n\n林澈慢了一步，回头确认你有没有跟上。顾遥站在屋檐下，指了指远处刚亮起的路灯。" },
            { role: "assistant", senderId: characterId, worldTurnId: "scene-2", at: "17:42", text: "前面那段路很安静。\n\n我们可以慢慢走，不用着急。" },
          ];
          renderMessages();
        }, { worldId: world.id, characterId: characters[0].id });
        await expectStyle(page, ".world-scene-turn", { backgroundColor: "rgb(255, 255, 255)", borderBottomWidth: "0px", borderRadius: "10px", boxShadow: "none" });
        await expectStyle(page, ".world-scene-head", { backgroundColor: "rgba(0, 0, 0, 0)", paddingTop: "0px", borderBottomWidth: "0px" });
        await expectStyle(page, ".world-scene-mini-avatar", { width: "32px", height: "32px", borderRadius: "8px" });
        await expectStyle(page, ".world-scene-text", { color: "rgb(26, 26, 26)", fontSize: "16px" });
        assert.match(await page.locator(".world-scene-text").first().evaluate(el => getComputedStyle(el).fontFamily), /^system-ui,/);
        assert.equal(await page.locator(".world-scene-turn").first().locator(".world-scene-mini-avatar").count(), 6);
        assert.equal(await page.locator(".world-scene-identity .message-avatar").count(), 1);
        await assertContained(page, "#messages", ".world-scene-turn, .world-scene-head, .world-scene-participants, .world-scene-mini-avatar, .world-scene-text");
        if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `world-social-${width}.png`) });
        await page.locator(".world-scene-identity .message-avatar").click();
        await page.locator("#characterProfileName").filter({ hasText: "林澈" }).waitFor();
        await page.locator("#closeCharacterProfileBtn").click();
        await page.locator(".world-scene-mini-avatar").first().click();
        await page.locator("#characterProfileDialog").waitFor({ state: "visible" });
        await page.locator("#closeCharacterProfileBtn").click();

        await page.evaluate(ids => {
          const createdAt = "2026-09-07T09:40:00.000Z";
          renderCharacterChannel({
            channel: { id: "theme-channel", characterIds: ids, characterNames: ["林澈", "顾遥"] },
            episodes: [{ id: "theme-episode", kind: "social", title: "雨停后的书店与河岸散步", objective: "一起收好窗边的书，再出去走走。", status: "completed", createdAt }],
            messages: [{ episodeId: "theme-episode", senderType: "character", senderCharacterId: ids[0], content: "我把最后一本书放好了。", createdAt }],
            scenes: [{ episodeId: "theme-episode", narrativeText: "新书堆在窗边，夕阳从书脊之间落下来。\n顾遥递来最后一本。林澈把它放进书架，才发现门外的雨已经停了。" }],
            reflections: [{ episodeId: "theme-episode", characterId: ids[0], summary: "今天一起整理了书店的新书。" }],
          }, false);
          document.getElementById("characterChannelDialog").showModal();
        }, characters.slice(0, 2).map(character => character.id));
        await expectStyle(page, ".character-channel-messages", { backgroundColor: "rgb(245, 245, 245)", backgroundImage: "none" });
        await expectStyle(page, ".character-interaction-scene", { backgroundColor: "rgb(255, 255, 255)", boxShadow: "none", borderTopWidth: "0px" });
        await expectStyle(page, ".character-interaction-prose", { fontSize: "16px", color: "rgb(26, 26, 26)" });
        await expectStyle(page, ".character-interaction-prose p", { textIndent: "0px" });
        assert.match(await page.locator(".character-interaction-prose").evaluate(el => getComputedStyle(el).fontFamily), /^system-ui,/);
        await page.locator(".character-interaction-notes > summary").click();
        await page.locator(".character-interaction-reflection").waitFor({ state: "visible" });
        await page.locator(".character-interaction-audit > summary").click();
        await expectStyle(page, ".character-channel-message-avatar", { backgroundColor: "rgb(230, 230, 230)", borderRadius: "8px" });
        await assertContained(page, "#characterChannelDialog", ".character-channel-episode-head, .character-interaction-scene, .character-interaction-prose, summary, .character-channel-message-bubble");
        if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `world-interaction-social-${width}.png`) });
        assert.deepEqual(errors, []);
        console.log(`World social theme checks passed at ${width}px`);
      } finally { await page.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); runtime.dispose(); }
}

async function expectStyle(page, selector, expected) {
  const actual = await page.locator(selector).first().evaluate((el, keys) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(keys.map(key => [key, style[key]]));
  }, Object.keys(expected));
  assert.deepEqual(actual, expected, selector);
}

async function assertContained(page, rootSelector, selectors) {
  const clipped = await page.locator(rootSelector).evaluate((root, selectors) => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll(selectors)].filter(el => el.getClientRects().length).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.left < Math.max(0, bounds.left) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1;
    }).map(el => el.className);
  }, selectors);
  assert.deepEqual(clipped, [], `${rootSelector}: horizontal overflow`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runWorldSocialThemeChecks(browser, outputDir); }
  finally { await browser.close(); }
}
