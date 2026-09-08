import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runCharacterLifeChecks(browser, outputDir) {
  for (const theme of ["light", "dark"]) {
    const runtime = createTestRuntime({ seed: `life-browser-${theme}` });
    const kernel = runtime.kernel;
    const alice = kernel.createCharacter({ name: "林澈" });
    const bob = kernel.createCharacter({ name: "顾遥" });
    const world = kernel.createWorld({ name: "河岸" });
    for (const character of [alice, bob]) kernel.assignCharacterWorld(character.id, { worldId: world.id });
    kernel.worldConversationService.applyRelationshipDelta({ worldId: world.id, subjectCharacterId: bob.id, objectCharacterId: alice.id,
      affinityDelta: 1, trustDelta: 1, tensionDelta: 0, intimacyDelta: 0, summary: "一起生活过" });
    kernel.deleteCharacter(alice.id, alice.name);
    await kernel.openCanonicalPrivateConversation(bob.id);
    const server = createHttpServer({ kernel });
    await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    const page = await browser.newPage({ viewport: { width: theme === "dark" ? 390 : 1280, height: 980 }, colorScheme: theme, reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.characters.length === 1 && !state.conversationViewLoading);
      await page.evaluate(async id => { await openPersistentDirectConversation(id, "normal"); await openCharacterProfile(id); }, bob.id);
      await page.locator("#characterProfileRecentBtn").click();
      await page.locator("#characterRecentDepartures").getByText("林澈", { exact: true }).waitFor();
      await page.locator("#characterGoalCreate > summary").click();
      await page.locator("#characterGoalKind").selectOption("wish");
      await page.locator("#characterGoalTitle").fill("准备周末的读书会 <img src=x>");
      await page.locator("#characterGoalNextStep").fill("先挑一本书，不急着邀请别人");
      await page.locator('#characterGoalForm button[type="submit"]').click();
      await page.locator("#characterRecentGoals").getByText("准备周末的读书会 <img src=x>", { exact: true }).waitFor();
      assert.equal(await page.locator("#characterRecentGoals img").count(), 0);
      await page.locator('[data-life-action="pause"]').click();
      await page.locator("#confirmSessionActionBtn").click();
      await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
      await page.locator('[data-life-action="resume"]').waitFor();
      await page.screenshot({ path: resolve(outputDir, `character-life-${theme}.png`), fullPage: true });
      const bounds = await page.locator("#characterProfileRecent").evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
      assert.ok(bounds.scroll <= bounds.width + 1, "recent activity should fit a narrow screen");
      await page.evaluate(async id => { closeCharacterProfile(); await openPersistentDirectConversation(id, "secret"); await openCharacterProfile(id); }, bob.id);
      await page.locator("#characterProfileRecentBtn").click();
      await page.waitForFunction(() => characterRecentData?.conversationSpace === "secret");
      assert.equal(await page.locator("#characterRecentDepartures").textContent(), "");
      assert.doesNotMatch(await page.locator("#characterRecentGoals").textContent(), /读书会/);
      assert.equal(await page.locator('#characterGoalKind option[value="wish"]').evaluate(option => option.disabled), true,
        await page.evaluate(() => JSON.stringify({ scope: recentScope(), data: characterRecentData?.scope, status: document.getElementById('characterRecentStatus').textContent, form: document.getElementById('characterGoalKind').outerHTML })));
      assert.deepEqual(errors, []);
      console.log(`Character life browser checks passed (${theme})`);
    } finally { await page.close(); await new Promise(resolvePromise => server.close(resolvePromise)); runtime.dispose(); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runCharacterLifeChecks(browser, outputDir); } finally { await browser.close(); }
}
