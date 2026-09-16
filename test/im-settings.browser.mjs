import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "cloakbrowser";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

const imageData = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Local-only connector: exercise binding controls without contacting an IM provider.
function fixtureGateway() {
  const sessions = new Map();
  const bindingRequests = [];
  return {
    configured: true,
    bindingRequests,
    getCapabilities: () => [
      { provider: "wechat", connectorKind: "wechat_tencent_ilink", state: "ready" },
      { provider: "feishu", connectorKind: "feishu_personal_agent", state: "ready", domains: ["feishu", "lark"] },
    ],
    async startBinding(provider, options) {
      bindingRequests.push({ provider, ...options });
      const session = {
        id: "fixture-binding-" + sessions.size, provider,
        status: provider === "wechat" ? "connected" : "waiting_scan",
        qrCodeUrl: imageData,
        ...(provider === "wechat" ? { connection: {
          id: "fixture-wechat", accountId: "fixture-account", ownerId: "fixture-owner",
          displayName: "我的微信", connectedAt: "2026-09-09T01:00:00Z",
        } } : { domain: options.domain }),
      };
      sessions.set(session.id, session);
      return session;
    },
    async getBindingSession(id) { return sessions.get(id); },
    async cancelBindingSession(id) {
      const session = { ...sessions.get(id), status: "cancelled" };
      sessions.set(id, session);
      return session;
    },
    async disconnect() {},
  };
}

export async function runImSettingsChecks(browser, outputDir) {
  for (const width of [320, 390, 768, 1440]) {
    for (const colorScheme of ["light", "dark"]) {
      const gateway = fixtureGateway();
      const runtime = createTestRuntime({ now: "2026-09-09T01:00:00Z", imGateway: gateway });
      const { kernel } = runtime;
      const character = kernel.createCharacter({ name: "红莉栖" });
      const other = kernel.createCharacter({ name: "林澈" });
      const conversation = await kernel.openCanonicalPrivateConversation(character.id);
      kernel.setImCharacterRoute("wechat", character.id);
      await kernel.startImBinding("wechat");
      const server = createHttpServer({ kernel });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const page = await browser.newPage({ viewport: { width, height: 1000 }, locale: "zh-CN", colorScheme, reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      try {
        await page.goto("http://127.0.0.1:" + server.address().port, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(id => typeof state !== "undefined" && state.activeSessionId === id && !state.sessionDraft, conversation.id);
        await page.evaluate(() => { setUiMode("settings"); setSettingsTab("im"); });
        await page.waitForFunction(() => state.imRuntimeSettings && !nodes.refreshImChannelsBtn.disabled);
        assert.equal(await page.locator("html").getAttribute("data-theme"), colorScheme);
        const defaultAvatar = page.locator('[data-im-card="wechat"] .im-character-avatar img');
        assert.equal(await defaultAvatar.count(), 1);
        assert.match(await defaultAvatar.getAttribute("src"), /\/assets\/default-characters\/kurisu-avatar-crop\.png/u);
        assert.equal(await page.locator('[data-im-card="wechat"] .im-channel-status').innerText(), "已绑定");
        assert.equal(await page.locator('[data-im-card="wechat"] [data-im-action="bind"]').count(), 0);
        assert.equal(await page.locator('[data-im-card="feishu"] [data-im-action="bind"]').isDisabled(), true);
        await expectStyle(page, ".im-channel-card", { backgroundColor: colorScheme === "dark" ? "rgb(34, 34, 34)" : "rgb(255, 255, 255)" });
        await expectStyle(page, ".im-channel-mark", { backgroundImage: "none", backgroundColor: colorScheme === "dark" ? "rgb(29, 29, 29)" : "rgb(247, 247, 247)" });
        for (const selector of [".im-privacy-note", ".im-gateway-state", ".im-channel-status", ".im-setting-row"]) {
          await expectStyle(page, selector, { backgroundColor: "rgba(0, 0, 0, 0)" });
        }
        assert.equal(await page.locator(".im-privacy-note").getAttribute("open"), null);
        await page.locator(".im-privacy-note summary").click();
        assert.match(await page.locator(".im-privacy-note p").innerText(), /平台本身仍会保留已传输的消息/);
        await page.locator(".im-privacy-note summary").click();

        // Role changes and ordinary refreshes must update the avatar and preserve region selection.
        await page.getByLabel("飞书对话角色").selectOption(other.id);
        await page.waitForFunction(id => state.imChannels.find(c => c.provider === "feishu")?.characterId === id, other.id);
        assert.equal(await page.locator('[data-im-card="feishu"] .im-character-avatar').innerText(), "林");
        assert.equal(kernel.getImCharacterRoute("feishu").characterId, other.id);
        await page.getByLabel("飞书服务区域").selectOption("lark");
        await page.evaluate(() => loadImSettingsView(true));
        assert.equal(await page.getByLabel("飞书服务区域").inputValue(), "lark");

        const reminder = page.getByRole("switch", { name: "微信接收日程提醒" });
        assert.equal(await reminder.isChecked(), true);
        await expectStyle(page, '[data-im-setting="wechat-reminders"]', { width: "42px", height: "24px", appearance: "none" });
        await reminder.focus();
        await expectStyle(page, '[data-im-setting="wechat-reminders"]', { outlineStyle: "solid", outlineWidth: "2px" });
        await page.keyboard.press("Space");
        await page.waitForFunction(() => state.imRuntimeSettings.wechatRemindersEnabled === false && !state.imSettingsSaving);
        assert.equal(kernel.getImRuntimeSettings().wechatRemindersEnabled, false);
        assert.equal(kernel.getImRuntimeSettings().feishuRemindersEnabled, true);
        await reminder.check();
        await page.waitForFunction(() => state.imRuntimeSettings.wechatRemindersEnabled === true && !state.imSettingsSaving);
        await page.getByRole("switch", { name: "微信处理时显示正在输入" }).uncheck();
        await page.waitForFunction(() => state.imRuntimeSettings.wechatTypingEnabled === false && !state.imSettingsSaving);
        assert.equal(kernel.getImRuntimeSettings().wechatTypingEnabled, false);
        assert.equal(await page.getByLabel("飞书服务区域").inputValue(), "lark");
        await assertContained(page, "#imSettingsPanel");
        assert.equal(await page.locator("#imChannelList").evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length), width <= 900 ? 1 : 2);
        await page.locator("#imSettingsPanel").evaluate(el => el.closest(".settings-page").scrollTop = 0);
        await page.screenshot({ path: resolve(outputDir, `im-settings-${colorScheme}-${width}.png`) });

        // Real avatar images use the shared local avatar endpoint and fixed-size crop.
        kernel.updateCharacterAvatar(other.id, imageData);
        await page.evaluate(() => loadImSettingsView(true));
        const avatar = page.locator('[data-im-card="feishu"] .im-character-avatar img');
        await avatar.scrollIntoViewIfNeeded();
        await avatar.evaluate(img => img.decode());
        assert.match(await avatar.getAttribute("src"), /\/api\/v1\/avatars\/characters\//);
        await expectStyle(page, '[data-im-card="feishu"] .im-character-avatar img', { objectFit: "cover", width: "52px", height: "52px" });

        await page.locator('[data-im-card="feishu"] [data-im-action="bind"]').click();
        await page.locator("#imQrDialog").waitFor({ state: "visible" });
        await page.waitForFunction(() => state.imBindingSession?.status === "waiting_scan");
        assert.deepEqual(gateway.bindingRequests.at(-1), { provider: "feishu", domain: "lark" });
        await expectStyle(page, "#imQrStage", { backgroundColor: "rgb(255, 255, 255)" });
        await expectStyle(page, "#imQrMessage", { color: colorScheme === "dark" ? "rgb(184, 184, 184)" : "rgb(97, 97, 97)" });
        await assertContained(page, "#imQrDialog");
        await page.screenshot({ path: resolve(outputDir, `im-binding-${colorScheme}-${width}.png`) });
        await page.locator("#cancelImBindingBtn").click();
        await page.locator("#closeImQrBtn").click();
        await page.locator("#imQrDialog").waitFor({ state: "hidden" });

        await page.getByLabel("飞书对话角色").selectOption("");
        await page.waitForFunction(() => !state.imChannels.find(c => c.provider === "feishu")?.characterId);
        assert.equal(await page.locator('[data-im-card="feishu"] .im-character-avatar img').count(), 0);
        assert.equal(await page.locator('[data-im-card="feishu"] [data-im-action="bind"]').isDisabled(), true);
        assert.equal(kernel.getImCharacterRoute("feishu"), undefined);
        assert.deepEqual(errors, []);
        console.log(`IM settings checks passed (${width}px, ${colorScheme})`);
      } finally {
        await page.close();
        await new Promise(resolve => server.close(resolve));
        runtime.dispose();
      }
    }
  }
}

async function expectStyle(page, selector, expected) {
  const actual = await page.locator(selector).first().evaluate((el, keys) => {
    const css = getComputedStyle(el);
    return Object.fromEntries(keys.map(key => [key, css[key]]));
  }, Object.keys(expected));
  assert.deepEqual(actual, expected, selector);
}

async function assertContained(page, selector) {
  const overflow = await page.locator(selector).evaluate(root => {
    const bounds = root.getBoundingClientRect();
    return [root, ...root.querySelectorAll("input, select, button, summary, .im-character-avatar")]
      .filter(el => el.getClientRects().length)
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.left < Math.max(0, bounds.left) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1;
      }).map(el => el.tagName + "." + el.className);
  });
  assert.deepEqual(overflow, [], "controls overflow " + selector);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputDir = resolve("browser-artifacts");
  mkdirSync(outputDir, { recursive: true });
  const browser = await launch({ headless: true });
  try { await runImSettingsChecks(browser, outputDir); } finally { await browser.close(); }
}
