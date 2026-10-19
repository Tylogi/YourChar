import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { createHttpServer } from "../dist/src/http/router.js";
import { createTestRuntime } from "../dist/src/testing/index.js";

export async function runCodexLoginChecks(browser, outputDir) {
  const runtime = createTestRuntime({ stateDir: false });
  const kernel = runtime.kernel;
  kernel.patchModelApiConfig({ enabled: false });
  const server = createHttpServer({ kernel });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    for (const locale of ["zh-CN", "en"]) {
      for (const width of [390, 1280]) {
        kernel.patchModelApiConfig({ provider: "openai_compatible", model: "", clearApiKey: true });
        const page = await browser.newPage({ viewport: { width, height: 1100 }, locale, reducedMotion: "reduce" });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        let flow;
        let authorized = false;
        let cancelled = false;
        await page.route("**/api/v1/model-profiles/default/oauth/*", async route => {
          const operation = new URL(route.request().url()).pathname.split("/").at(-1);
          const body = route.request().postDataJSON();
          if (operation === "start") {
            assert.equal(body.expectedRevision, kernel.getModelApiConfig().credentialRevision || 0);
            flow = { id: "browser-test-" + Date.now(), profileId: "default", method: body.method, status: "authorizing", expiresAt: new Date(Date.now() + 60000).toISOString(),
              ...(body.method === "device_code" ? { verificationUri: "https://auth.openai.com/codex/device", userCode: "TEST-CODE" }
                : { authUrl: "https://auth.openai.com/oauth/authorize?state=browser-test", manualCode: true }) };
            authorized = false;
          } else if (operation === "status" && authorized && flow.status !== "complete") {
            kernel.store.setModelOAuthCredential("default", {
              type: "oauth", access: "browser-only-fake-access", refresh: "browser-only-fake-refresh", expires: Date.now() + 3600000, accountId: "browser-test",
            }, kernel.getModelApiConfig().credentialRevision || 0);
            flow = { ...flow, status: "complete", authUrl: undefined, verificationUri: undefined, userCode: undefined, manualCode: undefined };
          } else if (operation === "cancel") { cancelled = true; flow = { ...flow, status: "cancelled" }; }
          else if (operation === "logout") {
            const profile = kernel.logoutCodex("default", body.expectedRevision);
            await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ profile }) });
            return;
          }
          await route.fulfill({ status: operation === "start" ? 202 : 200, contentType: "application/json", body: JSON.stringify({ login: flow }) });
        });
        try {
          await page.addInitScript(value => localStorage.setItem("yourchar.locale", value), locale);
          await page.goto(origin, { waitUntil: "domcontentloaded" });
          await page.locator("#settingsBtn").click();
          await page.waitForFunction(() => document.querySelectorAll("#apiProvider option").length >= 5);
          await page.locator("#apiProvider").selectOption("openai-codex");
          await page.locator("#codexLoginPanel").waitFor({ state: "visible" });
          assert.equal(await page.locator("#apiKey").isVisible(), false);
          assert.equal(await page.locator("#apiBaseUrl").isVisible(), false);
          assert.equal(await page.locator("#apiTemperature").isVisible(), false);
          assert.equal(await page.locator("#codexBrowserLoginBtn").textContent(), locale === "en" ? "Browser sign-in" : "浏览器登录");
          await page.locator("#codexBrowserLoginBtn").click();
          await page.locator("#codexAuthLink").waitFor({ state: "visible" });
          assert.equal(await page.locator("#codexAuthLink").getAttribute("rel"), "noopener noreferrer");
          assert.equal(await page.locator("#codexManualPanel").isVisible(), true);
          await page.locator("#codexCancelLoginBtn").click();
          await page.locator("#codexAuthLink").waitFor({ state: "hidden" });
          assert.equal(cancelled, true);

          await page.locator("#codexDeviceLoginBtn").click();
          await page.locator("#codexDeviceCode").filter({ hasText: "TEST-CODE" }).waitFor();
          assert.equal(await page.locator("#apiKey").inputValue(), "");
          assert.equal(await page.locator("#codexBrowserLoginBtn").isDisabled(), true);
          const geometry = await page.evaluate(() => ({ width: innerWidth, page: document.documentElement.scrollWidth,
            panel: document.querySelector("#modelSettingsPanel").clientWidth,
            scroll: document.querySelector("#modelSettingsPanel").scrollWidth }));
          assert.ok(geometry.page <= geometry.width && geometry.scroll <= geometry.panel + 1, "Codex login fits narrow screens");
          if (outputDir) await page.screenshot({ path: resolve(outputDir, "codex-login-" + locale + "-" + width + ".png") });
          authorized = true;
          await page.locator("#codexLogoutBtn").waitFor({ state: "visible" });
          await page.waitForFunction(() => document.querySelectorAll("#apiModel option").length > 1);
          await page.locator("#codexAuthLink").waitFor({ state: "hidden" });
          assert.equal(await page.locator("#codexDeviceCode").textContent(), "");
          assert.equal(await page.locator("#rollbackApiKeyBtn").isVisible(), false);
          const model = openaiCodexProvider().getModels().find(model => model.input.includes("image")).id;
          await page.locator("#apiModel").selectOption(model);
          await page.locator("#apiVisionInputEnabled").check();
          const savedResponse = page.waitForResponse(response => response.request().method() === "PATCH" && response.url().endsWith("/api/v1/model-profiles/default"));
          await page.locator("#saveApiSettingsBtn").click();
          const saved = await savedResponse;
          assert.equal(saved.status(), 200, await saved.text());
          await page.waitForFunction(() => state.loadedModelCredentialStatus === "active");
          assert.equal(kernel.getModelApiConfig().model, model);
          assert.equal(kernel.getModelApiConfig().credentialType, "oauth");
          await page.locator("#codexLogoutBtn").click();
          await page.locator("#codexLogoutBtn").waitFor({ state: "hidden" });
          assert.equal(kernel.getModelApiConfig().credentialStatus, "revoked");
          await page.locator("#apiProvider").selectOption("openai_compatible");
          await page.locator("#codexLoginPanel").waitFor({ state: "hidden" });
          assert.equal(await page.locator("#apiKey").isVisible(), true);
          assert.deepEqual(errors, []);
        } finally { await page.close(); }
      }
    }
    console.log("Codex browser/device login, cancellation, model selection, sign-out, and responsive locale checks passed");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    runtime.dispose();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runCodexLoginChecks(browser, outputDir); } finally { await browser.close(); }
}
