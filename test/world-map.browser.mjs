import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runWorldMapChecks(browser, outputDir) {
  const runtime = createTestRuntime({ seed: "world-map-browser" });
  const kernel = runtime.kernel;
  const characters = ["林澈", "顾遥", "许宁", "陈望", "温晴"].map((name) => kernel.createCharacter({ name }));
  const world = kernel.createWorld({ name: "青岚市" });
  const bookshop = kernel.createWorldPlace({ worldId: world.id, name: "河岸书店", capabilityIds: ["study", "rest"] });
  const station = kernel.createWorldPlace({ worldId: world.id, name: "中央车站", capabilityIds: ["travel", "socialize"] });
  const park = kernel.createWorldPlace({ worldId: world.id, name: "临江公园", capabilityIds: ["exercise", "observe"] });
  kernel.assignCharacterWorld(characters[0].id, { worldId: world.id, homePlaceId: bookshop.id, currentPlaceId: bookshop.id });
  kernel.assignCharacterWorld(characters[1].id, { worldId: world.id, homePlaceId: bookshop.id, currentPlaceId: bookshop.id });
  kernel.assignCharacterWorld(characters[2].id, { worldId: world.id, homePlaceId: station.id, currentPlaceId: station.id });
  kernel.assignCharacterWorld(characters[3].id, { worldId: world.id, homePlaceId: park.id, currentPlaceId: park.id });
  kernel.assignCharacterWorld(characters[4].id, { worldId: world.id, homePlaceId: null, currentPlaceId: null });
  kernel.updateCharacterRuntime(characters[0].id, { activity: "整理新到的书", availability: "busy" });
  kernel.updateCharacterRuntime(characters[2].id, { activity: "搭乘夜班列车", availability: "traveling" });
  kernel.updateCharacterRuntime(characters[3].id, { activity: "在长椅上休息", availability: "resting" });
  kernel.transitionWorldStoryEvent(world.id, {
    action: "begin",
    source: "user_control",
    title: "书店闭店前",
    summary: "大家准备在闭店前碰面。",
    placeId: bookshop.id,
    participantIds: [characters[0].id, characters[1].id],
  });

  const server = createHttpServer({ kernel });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [320, 390, 1440]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        colorScheme: width === 390 ? "dark" : "light",
        reducedMotion: "reduce",
      });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.locator("#charactersBtn").click();
        await page.waitForFunction(({ worldId, characterCount }) =>
          state.worldMaps.some((entry) => entry.worldId === worldId) && state.characters.length === characterCount,
        { worldId: world.id, characterCount: characters.length });
        const card = page.locator(`#worldCardGrid [data-world-card-id="${world.id}"]`);
        await card.waitFor();
        await card.scrollIntoViewIfNeeded();
        assert.equal(await card.locator("[data-world-map-place-id]").count(), 3);
        assert.equal(await card.locator("[data-world-map-character-id]").count(), 5);
        await card.locator(`[data-world-map-place-id="${bookshop.id}"]`).filter({ hasText: "林澈" }).filter({ hasText: "顾遥" }).waitFor();
        await card.locator("[data-world-map-transit]").filter({ hasText: "许宁" }).filter({ hasText: "中央车站" }).waitFor();
        await card.locator("[data-world-map-unknown]").filter({ hasText: "温晴" }).waitFor();
        await card.locator(`[data-world-map-place-id="${bookshop.id}"]`).filter({ hasText: "事件中" }).waitFor();
        await assertContained(page, "#charactersPage", "#worldCardGrid, .world-map-card, .world-map-stage, .world-map-place, .world-map-person");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        if (width !== 320) await page.screenshot({ path: resolve(outputDir, `world-map-${width}.png`), fullPage: true });
        await card.locator(`[data-world-map-select="${bookshop.id}"]`).click();
        await card.locator(".world-map-detail").filter({ hasText: "整理新到的书" }).waitFor();
        assert.equal(await card.locator(".world-map-place-trigger[aria-expanded=true]").count(), 1);
        await card.locator(".world-map-residents [data-world-map-character-id]").first().click();
        await page.locator("#characterProfileDialog").waitFor({ state: "visible" });
        await page.locator("#closeCharacterProfileBtn").click();
        await card.locator(".world-map-manage").click();
        await page.locator("#worldManagerDialog").waitFor({ state: "visible" });
        await page.locator("#worldManagerDialog").filter({ hasText: "青岚市" }).waitFor();
        console.log(`World map checks passed at ${width}px`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    runtime.dispose();
  }
}

async function assertContained(page, rootSelector, selectors) {
  const clipped = await page.locator(rootSelector).evaluate((root, childSelectors) => {
    const bounds = root.getBoundingClientRect();
    return [...root.querySelectorAll(childSelectors)].filter((element) => element.getClientRects().length).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left < Math.max(0, bounds.left) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1;
    }).map((element) => element.className);
  }, selectors);
  assert.deepEqual(clipped, [], `${rootSelector}: horizontal overflow`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try {
    await runWorldMapChecks(browser, outputDir);
  } finally {
    await browser.close();
  }
}
