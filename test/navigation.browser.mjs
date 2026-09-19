import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHttpServer } from "../dist/src/http/router.js";
import { createTestRuntime } from "../dist/src/testing/index.js";

export async function runNavigationChecks(browser, outputDir) {
  const workspaceDir = mkdtempSync(join(tmpdir(), "yourchar-navigation-"));
  const runtime = createTestRuntime({ workspaceDir });
  const kernel = runtime.kernel;
  kernel.patchModelApiConfig({ enabled: false });
  const config = kernel.store.getModelApiConfig();
  kernel.usageService.recordModelCall({
    provider: config.provider, model: config.model,
    usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000 },
  });
  kernel.usageService.saveSettings({
    priceOverrides: { [config.model]: { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 } },
  });
  const server = createHttpServer({ kernel });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [1280, 375]) {
      for (const locale of ["zh-CN", "en"]) {
        kernel.usageService.saveSettings({ monthlyBudgetYuan: null });
        const page = await browser.newPage({
          viewport: { width, height: 900 }, locale,
          colorScheme: locale === "zh-CN" ? "dark" : "light", reducedMotion: "reduce",
        });
        const errors = [];
        let workspaceRequests = 0;
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
          if (new URL(request.url()).pathname.startsWith("/api/v1/workspace/files")) workspaceRequests++;
        });
        try {
          await page.addInitScript(value => localStorage.setItem("yourchar.locale", value), locale);
          await page.goto(origin, { waitUntil: "domcontentloaded" });
          await page.waitForFunction(() => typeof state !== "undefined" && state.modelProfiles.length > 0);
          assert.deepEqual(await page.locator(".nav-segmented > button").evaluateAll(buttons => buttons.map(button => button.id)), [
            "normalBtn", "scheduleBtn", "charactersBtn", "workspaceFilesBtn",
            "managementBtn", "settingsBtn", "debugBtn",
          ]);
          assert.equal(await page.locator("#workspaceFilesBtn span").textContent(), locale === "en" ? "Files" : "文件");
          await page.locator("#workspaceFilesBtn").click();
          await page.locator("#workspaceFilesPage").waitFor({ state: "visible" });
          await page.waitForFunction(() => !nodes.workspaceFileUploadBtn.disabled);
          assert.equal(await page.locator("#managementPage").isVisible(), false);
          assert.equal(await page.locator("#workspaceFilesBtn").getAttribute("class"), "active");

          const name = `navigation-${locale}-${width}.txt`;
          await page.locator("#workspaceFileUploadInput").setInputFiles({
            name, mimeType: "text/plain", buffer: Buffer.from("Navigation file preview works."),
          });
          const row = page.locator(".workspace-file-row").filter({ hasText: name });
          await row.waitFor();
          await row.locator(".workspace-file-name").click();
          await page.locator("#workspaceFilePreviewDialog").waitFor({ state: "visible" });
          await page.locator("#workspaceFilePreviewContent").filter({ hasText: "Navigation file preview works." }).waitFor();
          assert.match(await page.locator("#workspaceFilePreviewContent").textContent(), /Navigation file preview works/);
          await page.locator("#closeWorkspaceFilePreviewBtn").click();
          await assertNoPageOverflow(page);
          if (outputDir) await page.screenshot({ path: resolve(outputDir, `navigation-files-${locale}-${width}.png`) });

          await page.locator("#managementBtn").click();
          await page.locator("#usageTabBtn").click();
          await page.locator("#usagePanel").waitFor({ state: "visible" });
          await page.waitForFunction(() => Boolean(state.usageSummary));
          assert.equal(await page.locator("#workspaceFilesPage").isVisible(), false);
          assert.equal(await page.locator("#managementBtn").getAttribute("class"), "active");
          assert.equal(await page.locator("#usageTabBtn").getAttribute("class"), "active");
          assert.equal(await page.locator("#usageCalls").textContent(), "1");
          await page.locator("#usageBudgetInput").fill("0");
          const saved = page.waitForResponse(response => response.url().endsWith("/api/v1/usage/settings") && response.request().method() === "POST");
          await page.locator("#usageBudgetSaveBtn").click();
          assert.equal((await saved).status(), 200);
          await page.waitForFunction(() => state.usageSummary?.budget.limitYuan === 0 && state.usageSummary?.budget.exceeded);
          assert.equal(await page.locator("#usageBudgetText").getAttribute("class"), "usage-budget-text over");
          await assertNoPageOverflow(page);
          if (outputDir) await page.screenshot({ path: resolve(outputDir, `navigation-usage-${locale}-${width}.png`) });

          await page.locator("#workspaceFilesBtn").click();
          await row.waitFor({ state: "visible" });
          await page.locator("#managementBtn").click();
          assert.equal(await page.locator("#usagePanel").isVisible(), true, "Manage remembers its Usage tab");

          // A private context without a bound session must not fall back to the
          // shared Workspace now that Files has its own top-level entry.
          await page.locator("#normalBtn").click();
          const previousRequests = workspaceRequests;
          await page.evaluate(() => {
            state.conversationSpace = "secret";
            state.selectedCharacterId = "";
            state.activeSessionId = "";
            clearWorkspaceManagerState();
            setUiMode("files");
          });
          assert.equal(await page.locator("#workspaceFileUploadBtn").isDisabled(), true);
          assert.equal(await page.locator(".workspace-file-row").count(), 0);
          assert.equal(workspaceRequests, previousRequests);
          assert.ok((await page.locator("#workspaceFileState").textContent()).length > 0);

          // Test the navigation lock without opening a real incognito runtime.
          await page.evaluate(() => {
            state.conversationSpace = "normal";
            setUiMode("normal");
            state.activeSessionId = "navigation-incognito";
            state.activeConversationKind = "direct";
            state.incognitoConversation = { id: state.activeSessionId, incognito: true };
            updateIncognitoModeChrome();
            setUiMode("files");
          });
          assert.equal(await page.locator("#workspaceFilesBtn").isDisabled(), true);
          assert.equal(await page.locator("#managementBtn").isDisabled(), true);
          assert.equal(await page.evaluate(() => state.uiMode), "normal");
          assert.equal(await page.locator("#workspaceFilesPage").isVisible(), false);
          assert.deepEqual(errors, []);
          console.log(`Navigation checks passed: ${locale}, ${width}px`);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    runtime.dispose();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

async function assertNoPageOverflow(page) {
  const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.scrollWidth <= layout.width, `page overflows: ${JSON.stringify(layout)}`);
}
