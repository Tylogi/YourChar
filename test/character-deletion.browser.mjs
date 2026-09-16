import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runCharacterDeletionChecks(browser, outputDir) {
  for (const space of ["normal", "secret"]) {
    const runtime = createTestRuntime({ seed: `delete-browser-${space}` });
    const kernel = runtime.kernel;
    const owner = kernel.createCharacter({ name: "待删除角色" });
    const peer = kernel.createCharacter({ name: "保留角色" });
    await kernel.openCanonicalPrivateConversation(owner.id);
    await kernel.openCanonicalPrivateConversation(owner.id, "secret");
    const peerSession = await kernel.openCanonicalPrivateConversation(peer.id);
    const server = createHttpServer({ kernel });
    await new Promise(resolvePromise => server.listen(0, "127.0.0.1", resolvePromise));
    const page = await browser.newPage({ viewport: { width: space === "secret" ? 390 : 1440, height: 1000 }, locale: "zh-CN", colorScheme: space === "secret" ? "dark" : "light", reducedMotion: "reduce" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => state.characters.length === 2 && !state.conversationViewLoading);
      await page.evaluate(async ({ characterId, space }) => {
        await openPersistentDirectConversation(characterId, space);
      }, { characterId: space === "secret" ? owner.id : peer.id, space });
      await page.locator("#charactersBtn").click();
      if (space === "normal") {
        await page.locator("#newCharacterBtn").click();
        assert.equal(await page.locator("#deleteCharacterBtn").isVisible(), false);
      }
      await page.locator(`[data-character-card-id="${owner.id}"]`).click();
      await page.locator("#deleteCharacterBtn").click();
      await page.locator("#sessionActionDescription").filter({ hasText: "普通及私密会话" }).waitFor();
      await page.locator("#cancelSessionActionBtn").click();
      assert.equal(kernel.listCharacters().length, 2);
      await page.locator("#deleteCharacterBtn").click();
      await page.locator("#sessionActionInput").fill("错误名称");
      await page.locator("#confirmSessionActionBtn").click();
      await page.locator("#sessionActionError").filter({ hasText: "名称不匹配" }).waitFor();
      assert.equal(kernel.listCharacters().length, 2);
      await page.screenshot({ path: resolve(outputDir, `character-delete-${space}.png`), fullPage: true });
      await page.locator("#sessionActionInput").fill(owner.name);
      await page.locator("#confirmSessionActionBtn").click();
      await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
      assert.equal(await page.locator(`[data-character-card-id="${owner.id}"]`).count(), 0);
      assert.deepEqual(kernel.listCharacters().map(character => character.id), [peer.id]);
      assert.ok(kernel.listConversationMetadata().every(session => session.characterId !== owner.id));
      assert.equal(await page.evaluate(() => state.conversationSpace), "normal");
      if (space === "normal") assert.equal(await page.evaluate(() => state.activeSessionId), peerSession.id);
      await page.locator(`[data-character-card-id="${peer.id}"]`).click();
      await page.locator("#deleteCharacterBtn").click();
      await page.locator("#sessionActionInput").fill(peer.name);
      await page.locator("#confirmSessionActionBtn").click();
      await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
      await page.locator("#characterListEmpty").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => state.selectedCharacterId), "");
      assert.deepEqual(kernel.listCharacters(), []);
      assert.deepEqual(errors, []);
      console.log(`Character deletion browser checks passed (${space})`);
    } finally {
      await page.close();
      await new Promise(resolvePromise => server.close(resolvePromise));
      runtime.dispose();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runCharacterDeletionChecks(browser, outputDir); }
  finally { await browser.close(); }
}
