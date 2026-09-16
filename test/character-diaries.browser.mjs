import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

export async function runDiaryBrowserChecks(browser, outputDir) {
  let version = 0;
  const calls = [];
  const runtime = createTestRuntime({ diaryGenerator: async input => { calls.push(input); return input.kind === "memory"
    ? { points: [{ kind: "fact", text: "我与顾遥整理了书店的新书。", evidence: "我与顾遥整理了书店的新书。" }], relationships: [] }
    : `第 ${++version} 版 · 雨停后的书店\n\n新书堆在窗边。顾遥递来最后一本，我把它放进书架，恰好看见夕阳从书脊间落下来。\n\n今天没发生什么惊天动地的事情，却是我想记住的一天。\n\n<img src=x onerror="window.diaryXss=true"><script>window.diaryXss=true</script>`; } });
  const kernel = runtime.kernel;
  kernel.setAgentModuleEnabled("mcp:memory-coordinator", true);
  kernel.patchAgentPermissions({ characterMemoryWriteEnabled: true });
  const alice = kernel.createCharacter({ name: "林澈", soulMarkdown: "细心而独立，喜欢有阳光的书店。" });
  const bob = kernel.createCharacter({ name: "顾遥" });
  const shared = kernel.importMeetingPreset({ name: "日常见面 · 克制", source: { prompts: [{ identifier: "style", name: "叙事文风", role: "system", content: "保持 {{char}} 的声音", enabled: true }] } });
  const custom = kernel.importMeetingPreset({ name: "日记 · 生活片段", source: { prompts: [{ identifier: "style", name: "叙事文风", role: "system", content: "围绕一次重要经历展开", enabled: true }] } });
  kernel.updateCharacter(alice.id, { meetingPresetId: shared.id });
  const world = kernel.createWorld({ name: "河岸小城" });
  for (const character of [alice, bob]) kernel.assignCharacterWorld(character.id, { worldId: world.id });
  const entry = kernel.characterDiaries.capture({ kind: "activity", id: "browser-experience", characterId: alice.id, characterName: alice.name,
    worldId: world.id, worldName: world.name, timezone: "Asia/Shanghai", title: '雨停后的书店 <img src=x>', occurredAt: runtime.clock.now().toISOString(),
    soul: alice.soulMarkdown, observations: ["我与顾遥整理了书店的新书。"], statements: [] });
  await kernel.characterDiaries.drain();
  const memoryBefore = JSON.stringify(kernel.characterDiaries.get(alice.id, entry.id).memory);
  const server = createHttpServer({ kernel });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const width of [320, 390, 1440]) {
      kernel.characterDiaries.updateSettings(alice.id, { narrativeEnabled: true, preset: "", presetMode: "inherit" });
      const page = await browser.newPage({ viewport: { width, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto(origin, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(id => typeof state !== "undefined" && state.characters.some(character => character.id === id), alice.id);
        await page.evaluate(id => openCharacterProfile(id), alice.id);
        await page.locator("#characterProfileDialog").waitFor({ state: "visible" });
        assert.equal(await page.locator("#characterProfileDiary").isVisible(), false);
        await page.locator("#characterProfileDiaryBtn").click();
        await page.locator(".diary-prose").filter({ hasText: "雨停后的书店" }).waitFor();
        assert.equal(await page.evaluate(() => window.diaryXss), undefined);
        assert.equal(await page.locator(".diary-entry header img").count(), 0);
        await page.locator(".diary-memory summary").click();
        await page.locator(".diary-memory li").filter({ hasText: "整理了书店的新书" }).waitFor();
        assert.match(await page.locator(".diary-prose").evaluate(node => getComputedStyle(node).fontFamily), /system-ui/);
        await page.locator(".diary-settings summary").click();
        assert.equal(await page.locator("#characterDiaryPresetSelect").inputValue(), "inherit");
        assert.match(await page.locator("#characterDiaryPresetSelect").innerText(), /日常见面 · 克制/);
        await page.locator("#characterDiaryPresetSelect").selectOption("preset:" + custom.id);
        await page.locator("#characterDiaryPreset").fill("第一人称，清爽克制，保留具体细节。");
        await page.locator("#saveCharacterDiarySettingsBtn").click();
        await page.locator("#characterDiaryStatus").filter({ hasText: "设置已保存" }).waitFor();
        assert.equal(kernel.characterDiaries.settings(alice.id).preset, "第一人称，清爽克制，保留具体细节。");
        assert.equal(kernel.characterDiaries.settings(alice.id).presetId, custom.id);
        assert.equal(kernel.getCharacter(alice.id).meetingPresetId, shared.id);
        const controlsOverflow = await page.locator(".diary-settings").evaluate(root => [...root.querySelectorAll("button,select,textarea")]
          .filter(node => node.getClientRects().length).filter(node => { const box = node.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth; }).map(node => node.id));
        assert.deepEqual(controlsOverflow, []);
        await page.screenshot({ path: resolve(outputDir, `character-diary-presets-${width}.png`) });
        if (width === 1440) {
          page.once("dialog", dialog => dialog.accept());
          await page.locator("#manageCharacterDiaryPresetsBtn").click();
          await page.locator("#meetingPresetEditor").waitFor({ state: "visible" });
          assert.equal(await page.locator("#meetingPresetSelect").inputValue(), custom.id);
          assert.equal(await page.locator("#meetingPresetName").inputValue(), custom.name);
          await page.locator(".meeting-preset-prompt-row summary").first().click();
          await page.locator("[data-meeting-prompt-content]").first().fill("共享编辑器里改过的日记文风");
          await page.locator("#saveMeetingPresetBtn").click();
          await page.locator("#meetingPresetState").filter({ hasText: "已保存" }).waitFor();
          assert.equal(kernel.getMeetingPreset(custom.id).prompts[0].content, "共享编辑器里改过的日记文风");
          await page.evaluate(id => { setUiMode("normal"); return openCharacterProfile(id); }, alice.id);
          await page.locator("#characterProfileDiaryBtn").click();
          await page.locator(".diary-prose").waitFor({ state: "visible" });
          assert.equal(await page.locator("#characterDiaryPresetSelect").inputValue(), "preset:" + custom.id);
        }
        await page.locator(".diary-settings").evaluate(node => { node.open = false; });
        const clipped = await page.locator("#characterProfileDiary").evaluate(root => [...root.querySelectorAll("button,textarea,summary,header")]
          .filter(node => node.getClientRects().length).filter(node => { const box = node.getBoundingClientRect(); return box.left < -1 || box.right > innerWidth + 1; }).map(node => node.id || node.tagName));
        assert.deepEqual(clipped, [], `diary controls at ${width}px`);
        await page.screenshot({ path: resolve(outputDir, `character-diary-${width}.png`) });
        if (width === 1440) {
          await page.locator('[data-diary-retry="narrative"]').click();
          await kernel.characterDiaries.drain();
          await page.locator("#refreshCharacterDiaryBtn").click();
          await page.locator(".diary-prose").filter({ hasText: "第 2 版" }).waitFor();
          assert.equal(JSON.stringify(kernel.characterDiaries.get(alice.id, entry.id).memory), memoryBefore);
          assert.equal(calls.at(-1).narrativePreset.id, custom.id);
          assert.equal(calls.at(-1).narrativePreset.prompts[0].content, "共享编辑器里改过的日记文风");
        }
        await page.locator("#closeCharacterProfileBtn").click();
        await page.evaluate(id => openCharacterProfile(id), bob.id);
        await page.locator("#characterProfileDiaryBtn").click();
        await page.locator("#characterDiaryEntries").filter({ hasText: "还没有日记" }).waitFor();
        assert.doesNotMatch(await page.locator("#characterDiaryEntries").innerText(), /雨停后的书店/);
        assert.deepEqual(errors, []);
        console.log(`Character diary browser checks passed at ${width}px`);
      } finally { await page.close(); }
    }
  } finally { await new Promise(resolve => server.close(resolve)); runtime.dispose(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts"); mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runDiaryBrowserChecks(browser, outputDir); }
  finally { await browser.close(); }
}
