import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createHttpServer } from "../dist/src/http/router.js";
import { createTestRuntime } from "../dist/src/testing/index.js";

export async function runModelSettingsLayoutChecks(browser, outputDir) {
  // Use an isolated, disabled profile: no real credentials or provider requests.
  const runtime = createTestRuntime({ stateDir: false });
  runtime.kernel.patchModelApiConfig({ enabled: false, model: "example-chat-model" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    for (const width of [320, 390, 700, 900, 920, 1024, 1280]) {
      for (const locale of ["zh-CN", "en"]) {
        for (const colorScheme of ["light", "dark"]) {
          const page = await browser.newPage({
            viewport: { width, height: 1100 }, locale, colorScheme, reducedMotion: "reduce",
          });
          const errors = [];
          page.on("pageerror", error => errors.push(error.message));
          const scenario = [width, locale, colorScheme].join("-");
          try {
            await page.addInitScript(value => localStorage.setItem("yourchar.locale", value), locale);
            await page.goto(origin, { waitUntil: "domcontentloaded" });
            await openModelSettings(page);
            await page.evaluate(() => document.fonts.ready);
            await assertModelLayout(page, scenario);
            if (outputDir && (
              (width === 1280 && locale === "zh-CN" && colorScheme === "dark")
              || (width === 1024 && locale === "en" && colorScheme === "light")
              || (width === 390 && locale === "zh-CN" && colorScheme === "dark")
            )) {
              await page.screenshot({ path: resolve(outputDir, "model-settings-" + scenario + ".png") });
            }

            // The second model input must not stretch the adjacent API-key field.
            await page.locator("#apiModel").selectOption("__custom__");
            await page.locator("#apiModelCustom").waitFor({ state: "visible" });
            await page.locator("#apiModelCustom").fill("custom-layout-model");
            assert.equal(await page.locator("#apiModelCustom").getAttribute("aria-label"),
              locale === "en" ? "Enter a model name" : "输入模型名");
            await page.locator("#apiModel").focus();
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), "apiModelCustom");
            await page.keyboard.press("Tab");
            assert.equal(await page.evaluate(() => document.activeElement.id), "apiKey");
            await assertModelLayout(page, scenario + " custom model");

            // Provider-dependent fields must collapse without leaving blank grid cells.
            await page.locator("#apiProvider").selectOption("anthropic");
            assert.equal(await page.locator("#apiBaseUrl").isVisible(), false);
            assert.equal(await page.locator("#apiThinkingTokenBudgetField").isVisible(), false);
            assert.equal(await page.locator("#apiModelCustom").isVisible(), false);
            await assertModelLayout(page, scenario + " native provider");
            await page.locator("#apiProvider").selectOption("openai_compatible");

            // Long hints/status and the extra credential action exercise wrapping.
            await page.evaluate(() => {
              document.querySelector("#apiReasoningEffortHint").textContent += " Additional provider details.".repeat(12);
              document.querySelector("#apiProviderDescription").textContent += " https://example.invalid/" + "details".repeat(40);
              document.querySelector("#apiSettingsState").textContent = "Saved profile: " + "long-model-name-".repeat(40);
              document.querySelector("#rollbackApiKeyBtn").hidden = false;
            });
            await assertModelLayout(page, scenario + " long descriptions");
            assert.deepEqual(errors, [], scenario);
            console.log("Model settings layout checks passed: " + scenario);
          } finally {
            await page.close();
          }
        }
      }
    }
    await checkModelForm(browser, origin, runtime.kernel);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    runtime.dispose();
  }
}

async function openModelSettings(page) {
  await page.waitForFunction(() => typeof state !== "undefined"
    && state.modelProviders.length > 1 && state.modelProfiles.length > 0);
  await page.locator("#settingsBtn").click();
  await page.waitForFunction(() =>
    document.querySelector("#apiProfileName").value.length > 0
    && document.querySelectorAll("#apiProvider option").length > 1);
}

async function assertModelLayout(page, scenario) {
  const layout = await page.evaluate(async () => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const panel = document.querySelector("#modelSettingsPanel");
    const visible = element => element.getBoundingClientRect().height > 0;
    const rect = element => element.getBoundingClientRect().toJSON();
    const fields = [...panel.querySelectorAll(".settings-field")].filter(visible).map(field => {
      const control = [...field.querySelectorAll("input, select")].find(visible);
      return { id: control.id, field: rect(field), label: rect(field.querySelector("label")), control: rect(control) };
    });
    return {
      viewport: innerWidth, pageWidth: document.documentElement.scrollWidth,
      panel: rect(panel), panelWidth: panel.clientWidth, panelScrollWidth: panel.scrollWidth,
      fields,
      toolbar: [...panel.querySelector(".model-profile-bar").children].filter(visible).map(rect),
      checkboxes: [...panel.querySelectorAll(".checkbox-row")].filter(visible).map(label => ({
        label: rect(label), input: rect(label.querySelector("input")),
      })),
      controls: [...panel.querySelectorAll("input, select, button")].filter(visible).map(element => ({
        id: element.id, type: element.type, ...rect(element),
      })),
      buttons: [...panel.querySelectorAll(".settings-actions button")].filter(visible).map(rect),
      status: rect(document.querySelector("#apiSettingsState")),
    };
  });
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) <= 1, scenario + ": " + message + " (" + actual + " vs " + expected + ")");
  assert.ok(layout.pageWidth <= layout.viewport, scenario + ": page overflows horizontally");
  assert.ok(layout.panelScrollWidth <= layout.panelWidth + 1, scenario + ": panel overflows horizontally");
  for (const field of layout.fields) {
    near(field.control.top - field.label.bottom, 6, field.id + " label gap");
    near(field.control.width, field.field.width, field.id + " field width");
    for (const peer of layout.fields.filter(other => Math.abs(other.field.top - field.field.top) <= 1)) {
      near(field.control.top, peer.control.top, field.id + " aligns with " + peer.id);
    }
  }
  for (const control of layout.controls) {
    near(control.height, control.type === "checkbox" ? 16 : 36, control.id + " height");
    assert.ok(control.left >= layout.panel.left && control.right <= layout.panel.right, scenario + ": " + control.id + " outside panel");
  }
  for (const control of layout.toolbar) near(control.top, layout.toolbar[0].top, "profile toolbar alignment");
  for (const checkbox of layout.checkboxes) near(checkbox.input.left, checkbox.label.left, "checkbox native margin");
  near(layout.checkboxes[0].input.left, layout.fields[0].field.left, "checkbox field alignment");
  if (layout.status.height > 0) {
    assert.ok(layout.status.top >= Math.max(...layout.buttons.map(button => button.bottom)) + 9,
      scenario + ": status must have its own row below the actions");
  }
}

async function checkModelForm(browser, origin, kernel) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, locale: "zh-CN" });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => localStorage.setItem("yourchar.locale", "zh-CN"));
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await openModelSettings(page);
    await page.route("**/api/v1/diagnostics/model/models", async route => {
      assert.equal(route.request().method(), "POST");
      assert.equal(route.request().postDataJSON().profileId, "default");
      await route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ models: ["layout-model-a", "layout-model-b"] }),
      });
    });
    await page.locator("#discoverModelsBtn").click();
    await page.locator("#apiSettingsState").filter({ hasText: "2 个模型" }).waitFor();
    assert.ok((await page.locator("#apiModel option").allTextContents()).includes("layout-model-b"));
    await page.locator("#apiModel").selectOption("__custom__");
    await page.locator("#apiModelCustom").fill("saved-custom-model");
    await page.locator("#apiVisionInputEnabled").check();
    await page.locator("#apiContextWindowTokens").fill("65536");
    await page.locator("#saveApiSettingsBtn").click();
    await page.locator("#apiSettingsState").filter({ hasText: "已保存" }).waitFor();
    const config = kernel.store.getModelApiConfig();
    assert.equal(config.model, "saved-custom-model");
    assert.equal(config.visionInputEnabled, true);
    assert.equal(config.contextWindowTokens, 65536);
    assert.equal(config.enabled, false);
    await page.reload({ waitUntil: "domcontentloaded" });
    await openModelSettings(page);
    assert.equal(await page.locator("#apiModel").inputValue(), "saved-custom-model");
    assert.equal(await page.locator("#apiVisionInputEnabled").isChecked(), true);
    assert.equal(await page.locator("#apiContextWindowTokens").inputValue(), "65536");
    await assertModelLayout(page, "saved profile");
    assert.deepEqual(errors, []);
    console.log("Model settings discovery, custom model, and save checks passed");
  } finally {
    await page.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runModelSettingsLayoutChecks(browser, outputDir); } finally { await browser.close(); }
}
