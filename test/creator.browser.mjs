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
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runCreatorChecks(browser, outputDir); } finally { await browser.close(); }
}
