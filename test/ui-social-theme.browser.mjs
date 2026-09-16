import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { renderAppHtml } from "../dist/src/http/ui.js";

// Use the real DOM and CSS without starting the app or touching any user state.
export async function runSocialThemeComponentChecks(browser, outputDir) {
  const html = renderAppHtml().replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "");
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
    try {
      await page.route("**/*", route => route.request().resourceType() === "document"
        ? route.fulfill({ status: 200, contentType: "text/html", body: html })
        : route.abort());
      await page.goto("http://yourchar.test/theme-check", { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        document.querySelector("#chatWorkspace").classList.remove("list-open");
      });
      await expectStyle(page, "#sendBtn", { backgroundColor: "rgb(26, 26, 26)", color: "rgb(255, 255, 255)" });
      await page.locator("#sendBtn").hover();
      await expectStyle(page, "#sendBtn", { backgroundColor: "rgb(51, 51, 51)" });
      await page.locator("#sendBtn").evaluate(el => { el.disabled = true; });
      await expectStyle(page, "#sendBtn", { backgroundColor: "rgb(230, 230, 230)", color: "rgb(97, 97, 97)" });
      await page.locator("#sendBtn").evaluate(el => { el.disabled = false; });
      await page.mouse.move(0, 0);
      await page.locator("#sendBtn").focus();
      await expectStyle(page, "#sendBtn", { outlineStyle: "solid", outlineWidth: "2px" });

      await page.evaluate(() => {
        document.querySelector("#sceneInfoContent").innerHTML = '<dl><div class="scene-info-row"><dt>地点</dt><dd>河岸书店</dd></div><div class="scene-info-row"><dt>参与者</dt><dd>林澈、顾遥</dd></div><div class="scene-info-row"><dt>场景摘要</dt><dd>雨停后，一起在书店门口聊聊最近的生活。</dd></div></dl>';
        document.querySelector("#sceneInfoDialog").showModal();
      });
      await expectStyle(page, ".scene-info-row", { fontSize: "14px", borderBottomColor: "rgb(227, 227, 227)" });
      await expectStyle(page, ".scene-info-row dt", { fontSize: "13px", color: "rgb(97, 97, 97)" });
      await assertContained(page, "#sceneInfoDialog");
      if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `social-scene-${width}.png`) });
      await page.locator("#sceneInfoDialog").evaluate(el => el.close());

      await page.evaluate(() => {
        document.body.dataset.uiMode = "settings";
        document.querySelector("#chatWorkspace").hidden = true;
        document.querySelector("#settingsPage").hidden = false;
        for (const panel of document.querySelectorAll(".settings-panel")) panel.hidden = panel.id !== "promptSettingsPanel";
        document.querySelector("#systemPromptSettingsView").hidden = true;
        document.querySelector("#meetingPresetSettingsView").hidden = false;
        document.querySelector("#meetingPresetEmpty").hidden = true;
        document.querySelector("#meetingPresetEditor").hidden = false;
        document.querySelector("#meetingPresetName").value = "日常见面 · 轻描写";
        document.querySelector("#meetingPresetParameters").value = '{"temperature": 0.8}';
        document.querySelector("#meetingPresetCompatibility").hidden = false;
        document.querySelector("#meetingPresetCompatibility").innerHTML = '<strong>预设兼容说明</strong><span>动态上下文由系统填充。</span><span class="warn">扩展脚本不会执行。</span>';
        document.querySelector("#meetingPresetPromptList").innerHTML = '<details class="meeting-preset-prompt-row enabled" open><summary><input type="checkbox" checked aria-label="启用现场描写"><strong>现场描写</strong><span class="meeting-preset-prompt-role">system</span><span class="meeting-preset-prompt-kind">动态上下文</span></summary><div class="meeting-preset-prompt-editor"><label>名称<input value="现场描写"></label><label>Role<select><option>system</option></select></label><label class="full">内容<textarea>保留人物的语气与动作，以自然、简洁的描写推进场景。</textarea></label></div></details>';
        for (const id of ["modelSettingsTabBtn", "systemPromptSettingsViewBtn"]) document.getElementById(id).classList.remove("active");
        for (const id of ["promptSettingsTabBtn", "meetingPresetSettingsViewBtn"]) document.getElementById(id).classList.add("active");
      });
      await expectStyle(page, ".meeting-preset-compatibility", { backgroundColor: "rgb(247, 247, 247)", color: "rgb(97, 97, 97)", fontSize: "12px" });
      await expectStyle(page, ".meeting-preset-compatibility strong", { color: "rgb(26, 26, 26)" });
      await expectStyle(page, ".meeting-preset-compatibility .warn", { color: "rgb(139, 100, 22)" });
      await expectStyle(page, ".meeting-preset-prompt-kind", { backgroundColor: "rgb(247, 247, 247)", fontSize: "12px" });
      await expectStyle(page, ".meeting-preset-prompt-editor label", { fontSize: "13px" });
      await expectStyle(page, ".meeting-preset-prompt-row input[type=checkbox]", { accentColor: "rgb(38, 38, 38)" });
      await expectStyle(page, "#meetingPresetParametersEnabled", { backgroundColor: "rgb(227, 227, 227)" });
      await page.locator("#meetingPresetParametersEnabled").check();
      await expectStyle(page, "#meetingPresetParametersEnabled", { backgroundColor: "rgb(38, 38, 38)" });
      await page.locator("#meetingPresetParametersEnabled").uncheck();
      const promptFont = await page.locator(".meeting-preset-prompt-editor textarea").evaluate(el => getComputedStyle(el).fontFamily);
      assert.match(promptFont, /^system-ui,/);
      const jsonFont = await page.locator("#meetingPresetParameters").evaluate(el => getComputedStyle(el).fontFamily);
      assert.match(jsonFont, /monospace/);
      await assertContained(page, "#meetingPresetSettingsView");
      await assertContained(page, ".settings-tabs");
      if (width <= 600) await expectStyle(page, "#promptSettingsTabBtn", { whiteSpace: "nowrap" });
      if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `social-preset-${width}.png`) });
      await page.locator(".meeting-preset-prompt-row summary").click();
      assert.equal(await page.locator(".meeting-preset-prompt-editor").isVisible(), false);
      await page.locator(".meeting-preset-prompt-row summary").click();
      await page.locator(".meeting-preset-prompt-editor textarea").fill("新的现场描写风格");
      assert.equal(await page.locator(".meeting-preset-prompt-editor textarea").inputValue(), "新的现场描写风格");
      await page.locator("#meetingPresetCompatibility").evaluate(el => { el.hidden = true; });
      assert.equal(await page.locator("#meetingPresetCompatibility").isVisible(), false);
      await page.locator("#meetingPresetImportPanel").evaluate(el => { el.hidden = false; });
      await expectStyle(page, "#meetingPresetImportPanel", { backgroundColor: "rgb(247, 247, 247)" });
      await assertContained(page, "#meetingPresetImportPanel");

      await page.evaluate(() => {
        document.querySelector("#promptSettingsPanel").hidden = true;
        document.querySelector("#dataSettingsPanel").hidden = false;
        document.querySelector("#okfImportPreview").hidden = false;
        document.querySelector("#okfPreviewSummary").innerHTML = '<strong>格式合规</strong><span>1 条可导入 · 1 条跳过</span>';
        document.querySelector("#okfDocumentList").innerHTML = '<div class="okf-document-row ready"><svg></svg><div class="okf-document-copy"><strong>日程沟通偏好</strong><span>用户希望日程变更先说明影响。</span></div><span class="okf-document-status">待审核</span></div>';
        document.querySelector(".vault-history-list").innerHTML = '<div class="vault-history-entry"><div class="vault-history-entry-main"><strong>批量记忆更新</strong><div class="vault-history-entry-meta">2 个文档 · 示例记录</div></div><button class="secondary">恢复</button></div>';
      });
      await expectStyle(page, ".okf-version", { backgroundColor: "rgb(247, 247, 247)", fontSize: "12px" });
      await expectStyle(page, "#okfPreviewSummary", { color: "rgb(97, 97, 97)", fontSize: "13px" });
      await expectStyle(page, "#okfPreviewSummary strong", { color: "rgb(26, 26, 26)" });
      await expectStyle(page, ".vault-history-entry", { backgroundColor: "rgb(247, 247, 247)", borderTopColor: "rgb(227, 227, 227)", borderTopWidth: "1px" });
      await assertContained(page, "#okfImportPreview");
      await page.locator("#okfImportPreview").scrollIntoViewIfNeeded();
      if ([390, 1440].includes(width)) await page.screenshot({ path: resolve(outputDir, `social-data-${width}.png`) });
      console.log(`Social theme components passed at ${width}px`);
    } finally {
      await page.close();
    }
  }
}

async function expectStyle(page, selector, expected) {
  const actual = await page.locator(selector).first().evaluate((el, properties) => {
    const style = getComputedStyle(el);
    return Object.fromEntries(properties.map(property => [property, style[property]]));
  }, Object.keys(expected));
  assert.deepEqual(actual, expected, selector);
}

async function assertContained(page, selector) {
  const overflow = await page.locator(selector).evaluate(root => {
    const bounds = root.getBoundingClientRect();
    return [root, ...root.querySelectorAll("input:not([hidden]), select, textarea, button, summary, .meeting-preset-prompt-kind")]
      .filter(el => el.getClientRects().length)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.left < Math.max(0, bounds.left) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1;
      }).map(el => el.id || el.className || el.tagName);
  });
  assert.deepEqual(overflow, [], `${selector}: horizontally clipped controls`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runSocialThemeComponentChecks(browser, outputDir); }
  finally { await browser.close(); }
}
