import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "cloakbrowser";
import { strToU8, zipSync } from "fflate";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createHttpServer } from "../dist/src/http/router.js";
import { createTestRuntime } from "../dist/src/testing/index.js";
import { runSocialThemeComponentChecks } from "./ui-social-theme.browser.mjs";
import { runDiaryBrowserChecks } from "./character-diaries.browser.mjs";
import { runWorldSocialThemeChecks } from "./world-social-theme.browser.mjs";
import { runHistoryPaginationChecks } from "./history-pagination.browser.mjs";
import { runAppearanceChecks } from "./appearance.browser.mjs";
import { runWorldMapChecks } from "./world-map.browser.mjs";
import { runCharacterDeletionChecks } from "./character-deletion.browser.mjs";
import { runCharacterLifeChecks } from "./character-life.browser.mjs";
import { runCreatorChecks } from "./creator.browser.mjs";
import { runStreamingOrderChecks } from "./streaming-order.browser.mjs";
import { runReminderDeliveryChecks } from "./reminder-delivery.browser.mjs";
import { runImSettingsChecks } from "./im-settings.browser.mjs";

const artifactsDir = resolve("browser-artifacts");
mkdirSync(artifactsDir, { recursive: true });
const avatarPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const scenePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwBfFbMYzpSH8OITBAtxmnf11wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgF1gxDT+l6ZFAAAAABJRU5ErkJggg==", "base64");
const okfBrowserZip = Buffer.from(zipSync({
  "index.md": strToU8("# Imported Knowledge\n\n* [Preference](preference.md) - Browser import\n* [Runbook](runbook.md) - Unsupported type\n"),
  "preference.md": strToU8("---\ntype: preference\ntitle: 日程沟通偏好\ntags: [browser, okf]\n---\n用户希望日程变更先说明影响。\n"),
  "runbook.md": strToU8("---\ntype: Playbook\ntitle: 通用操作手册\n---\n这不是个人记忆类型。\n"),
}));

const browserStateDir = mkdtempSync(join(tmpdir(), "rp-agent-browser-"));
let browserRuntime;
browserRuntime = createTestRuntime({
  stateDir: browserStateDir,
  seed: "browser-workflow",
  startPrivateInboxCoordinator: true,
  privateInboxOptions: {
    initialWaitMs: 500,
    quietWindowMs: 80,
    maximumWaitMs: 900,
    afterTurnQuietMs: 80,
  },
  worldMessenger: async (input) => {
    const text = input.candidate?.decisionDetails?.kind === "character_contact"
      ? "林澈说你在找我，我就过来问问。"
      : "刚在书店翻到一页很有意思的内容，突然想和你说一声。";
    const handle = await browserRuntime.kernel.sessionRuntime.getOrCreate(input.sessionId, "sms", input.characterId);
    const message = fauxAssistantMessage(text);
    message.timestamp = browserRuntime.clock.now().getTime();
    browserRuntime.kernel.sessionRuntime.appendMessages(handle, [message]);
    browserRuntime.kernel.sessionRuntime.annotateLastAssistantTurn(handle, "completed", false);
    return { sessionId: input.sessionId, text };
  },
});
const kernel = browserRuntime.kernel;
const browserSharedHtml = [
  "<!doctype html>",
  "<meta charset=\"utf-8\">",
  "<meta http-equiv=\"refresh\" content=\"0;url=https://example.invalid/escape\">",
  "<style>body{font-family:sans-serif;color:#075b35}</style>",
  "<h1>角色附件预览成功</h1>",
  "<a id=\"external-link\" href=\"https://example.invalid/link\">外部链接</a>",
  "<img id=\"external-image\" src=\"https://example.invalid/tracker.png\">",
  "<script>globalThis.browserAttachmentScriptRan = true</script>",
].join("\n");
const browserSharedHtmlEntry = kernel.uploadWorkspaceFile({
  directory: "browser-shared",
  name: "角色页面.html",
  bytes: Buffer.from(browserSharedHtml, "utf8"),
});
kernel.patchModelApiConfig({ enabled: false });
const browserWorldModelResponses = [];
const browserWorldModelRequests = [];
const browserWorldModelServer = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  browserWorldModelRequests.push(JSON.parse(body));
  const content = browserWorldModelResponses.shift();
  if (content === undefined) {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: { message: "browser world model response queue is empty" } }));
    return;
  }
  writeChatCompletionStream(response, "browser-world-model", content);
});
await new Promise((resolvePromise) => browserWorldModelServer.listen(0, "127.0.0.1", resolvePromise));
const browserWorldModelAddress = browserWorldModelServer.address();
assert.ok(browserWorldModelAddress && typeof browserWorldModelAddress === "object");
const browserWorldModelBaseUrl = `http://127.0.0.1:${browserWorldModelAddress.port}/v1`;
kernel.patchAgentPermissions({ realityMemoryWriteEnabled: true, characterMemoryWriteEnabled: true });
kernel.createScheduleItem({
  kind: "event",
  title: "浏览器每周复盘",
  startAt: "2026-01-05T01:00:00.000Z",
  timezone: "Asia/Shanghai",
  recurrenceRule: "FREQ=WEEKLY",
  ownerType: "user",
});
kernel.memoryLifecycle.propose({
  realm: "reality",
  type: "preference",
  key: "browser.pending.preference",
  content: "浏览器待确认现实偏好",
  sourceSessionId: "browser-candidate",
  sourceMessageId: "browser-pending-message",
  idempotencyKey: "browser-pending-memory",
});
kernel.store.addModelContextTrace({
  sessionId: "browser-trace",
  mode: "sms",
  turnKind: "user",
  requestText: "上一轮简短调用",
  payload: {
    model: "browser-model",
    messages: [{ role: "user", content: "上一轮消息" }],
  },
});
kernel.contextEconomics.record({
  sessionId: "browser-economics",
  mode: "sms",
  conversationSpace: "normal",
  turnKind: "user",
  systemHash: "browser-system-hash",
  toolSchemaHash: "browser-tools-hash",
  messageCount: 4,
  estimatedInputTokens: 420,
  stableEstimatedTokens: 180,
  dynamicEstimatedTokens: 90,
  memoryEstimatedTokens: 42,
  toolEstimatedTokens: 108,
  memoryIds: ["browser-memory-diagnostic"],
  plannerBudgetTokens: 900,
  plannerTruncated: false,
  lcpMessageCount: 3,
  lcpEstimatedTokens: 270,
  prefixReuseRatio: 0.6429,
  cacheBreakReason: null,
  messageDigests: [],
  plan: {
    schemaVersion: 1,
    sessionId: "browser-economics",
    mode: "sms",
    conversationSpace: "normal",
    generatedAt: "2026-07-16T02:00:00.000Z",
    timezone: "Asia/Shanghai",
    query: null,
    queryHash: "browser-query-hash",
    bootstrapApplied: false,
    bootstrapAlreadyConsumed: true,
    budgets: { dynamicTokens: 900, memoryTokens: 360, realityMemoryTokens: 220, roleplayMemoryTokens: 220, sceneTokens: 220, worldCoreTokens: 900, worldRuntimeTokens: 420, interactionTokens: 180, realityItems: 3, roleplayItems: 3, bootstrapItems: 3 },
    sections: [{ id: "reality_memory", placement: "dynamic", characters: 80, estimatedTokens: 42, budgetTokens: 220, included: true, truncated: false }],
    retrieval: [{
      realm: "reality",
      query: null,
      normalizedQuery: null,
      bootstrapRequested: false,
      candidateCount: 1,
      selectedMemoryIds: ["browser-memory-diagnostic"],
      candidates: [{
        memoryId: "browser-memory-diagnostic",
        realm: "reality",
        type: "preference",
        updatedAt: "2026-07-16T02:00:00.000Z",
        version: "browser-version",
        estimatedTokens: 42,
        score: 0.8123,
        breakdown: { relevance: 0.9, salience: 0.8, recency: 1, confidence: 0.9, exactKey: false, exactTag: true, exactContent: false, fts: 0.5, lexical: 0.6 },
        reason: "exact_tag+fts_bm25",
        selected: true,
        bootstrap: false,
      }],
    }],
    selectedMemoryIds: ["browser-memory-diagnostic"],
    selectedMemoryVersions: { "browser-memory-diagnostic": "browser-version" },
    excludedCount: 0,
    truncated: false,
    stableEstimatedTokens: 180,
    dynamicEstimatedTokens: 90,
    memoryEstimatedTokens: 42,
  },
});
kernel.store.addModelContextTrace({
  sessionId: "browser-trace",
  mode: "sms",
  turnKind: "user",
  requestText: "帮我检查完整上下文",
  payload: {
    model: "browser-model",
    temperature: 0.2,
    messages: [
      { role: "system", content: "You are YourChar.\n" + "Follow the complete system policy without omitting context.\n".repeat(12) },
      { role: "user", content: "帮我检查完整上下文" },
      { role: "assistant", content: "我会调用工具确认。", tool_calls: [{ id: "call-1", function: { name: "list_schedule_items", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "[]" },
    ],
    tools: [{ type: "function", function: { name: "list_schedule_items", description: "Return complete schedule state. ".repeat(12), parameters: { type: "object" } } }],
  },
});
kernel.store.addModelContextTrace({
  sessionId: "character-function:browser-character",
  mode: "sms",
  turnKind: "character_function_inference",
  requestText: "为角色推断初始职能",
  payload: {
    model: "browser-model",
    messages: [
      { role: "system", content: "Infer a concise character function profile." },
      { role: "user", content: "根据角色人设推断擅长的任务。" },
    ],
  },
});
const server = createHttpServer({ kernel });
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await launch({ headless: true });

try {
  await runSocialThemeComponentChecks(browser, artifactsDir);
  await runDiaryBrowserChecks(browser, artifactsDir);
  await runWorldSocialThemeChecks(browser, artifactsDir);
  await runHistoryPaginationChecks(browser, artifactsDir);
  await runAppearanceChecks(browser, artifactsDir);
  await runWorldMapChecks(browser, artifactsDir);
  await runCharacterDeletionChecks(browser, artifactsDir);
  await runCharacterLifeChecks(browser, artifactsDir);
  await runCreatorChecks(browser, artifactsDir);
  await runStreamingOrderChecks(browser, artifactsDir);
  await runReminderDeliveryChecks(browser, artifactsDir);
  await runImSettingsChecks(browser, artifactsDir);
  await runDesktopWorkflow(browser, baseUrl, artifactsDir);
  await runCompactDesktopWorkflow(browser, baseUrl, artifactsDir);
  await runMobileWorkflow(browser, baseUrl, artifactsDir);
  console.log(`Browser artifacts: ${artifactsDir}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  await new Promise((resolvePromise, reject) => browserWorldModelServer.close((error) => error ? reject(error) : resolvePromise()));
  browserRuntime.dispose();
  rmSync(browserStateDir, { recursive: true, force: true });
}

async function runDesktopWorkflow(browser, baseUrl, outputDir) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = collectErrors(page);
  const sessionConflicts = [];
  page.on("response", (response) => {
    if (/\/api\/v1\/sessions\/[^/]+\/messages/.test(response.url()) && response.status() === 409) {
      sessionConflicts.push(response.url());
    }
  });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await assertSocialTheme(page);
  await assertViewport(page);
  await assertInteractiveBounds(page);
  await page.locator(".conversation-sidebar").waitFor({ state: "visible" });
  assert.equal(await page.locator("#conversationListToggle").isHidden(), true);
  assert.equal(await page.locator("#conversationList .conversation-item").count(), 0);
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "visible" });
  await page.locator("#newConversationError").filter({ hasText: "请先在角色页创建角色" }).waitFor();
  assert.equal(await page.locator("#createConversationBtn").isDisabled(), true);
  await page.getByRole("button", { name: "关闭新建对话" }).click();
  await page.locator("#textInput").fill("没有角色时不能发送");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator("#status").filter({ hasText: "请先选择角色" }).waitFor();
  assert.equal(await page.locator("#messages .message-row.user").count(), 0);

  await page.getByRole("button", { name: "Debug" }).click();
  await page.locator("#debugPane").waitFor({ state: "visible" });
  await page.locator(".trace-index-item.active").waitFor({ state: "visible" });
  assert.equal(await page.locator("#conversationTraceCount").textContent(), "2");
  assert.equal(await page.locator("#backgroundTraceCount").textContent(), "1");
  assert.equal(await page.locator(".trace-index-item").count(), 2);
  assert.equal(await page.locator(".trace-block.system").count(), 1);
  assert.equal(await page.locator(".trace-block.user").count(), 1);
  assert.equal(await page.locator(".trace-block.assistant").count(), 1);
  assert.equal(await page.locator(".trace-block.tool").count(), 1);
  assert.equal(await page.locator(".trace-block.schema").count(), 1);
  const quantitySummary = page.locator('[aria-label="上下文数量汇总"]');
  await quantitySummary.waitFor({ state: "visible" });
  await quantitySummary.filter({ hasText: "上下文总数" }).filter({ hasText: "4" }).waitFor();
  await quantitySummary.filter({ hasText: "System" }).filter({ hasText: "User" })
    .filter({ hasText: "Assistant" }).filter({ hasText: "Tool Schema" }).waitFor();
  assert.match(await page.locator(".trace-index-item.active .trace-index-meta").textContent(), /4 条上下文 · 1 个 Schema/);
  await page.locator("#backgroundTraceScopeBtn").click();
  await page.locator("#traceDetailTitle").filter({ hasText: "为角色推断初始职能" }).waitFor();
  assert.equal(await page.locator(".trace-index-item").count(), 1);
  await page.locator("#traceDetailMeta").filter({ hasText: "会话外" }).filter({ hasText: "角色职能推断" }).waitFor();
  await page.locator("#conversationTraceScopeBtn").click();
  await page.locator("#traceDetailTitle").filter({ hasText: "帮我检查完整上下文" }).waitFor();
  await page.getByRole("tab", { name: "Context Economics" }).click();
  await page.locator("#traceDetailTitle").filter({ hasText: "420 estimated tokens" }).waitFor();
  await page.locator("#traceContent").filter({ hasText: "Cache read" }).filter({ hasText: "unknown" }).waitFor();
  await page.locator("#traceContent").filter({ hasText: "Memory Retrieval Plan" }).waitFor();
  await assertPanelInsideMain(page, "#debugPane");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "context-economics.png"), fullPage: false });
  await page.getByRole("tab", { name: "Provider Trace" }).click();
  await page.getByRole("tab", { name: "原始 JSON" }).click();
  await page.locator(".trace-json").filter({ hasText: "list_schedule_items" }).waitFor();
  await page.getByRole("tab", { name: "语义上下文" }).click();
  await page.getByRole("button", { name: "全部展开" }).click();
  assert.equal(await page.locator(".trace-block.schema[open]").count(), 1);
  await page.getByRole("button", { name: "不换行" }).click();
  assert.equal(await page.locator("#traceContent.nowrap").count(), 1);
  await page.getByRole("button", { name: "自动换行" }).click();
  await page.locator(".trace-index-item").filter({ hasText: "上一轮简短调用" }).click();
  await page.locator("#traceDetailTitle").filter({ hasText: "上一轮简短调用" }).waitFor();
  await page.locator(".trace-index-item").filter({ hasText: "帮我检查完整上下文" }).click();
  await assertPanelInsideMain(page, "#debugPane");
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "debug-trace.png"), fullPage: false });

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.locator("#managementPage").waitFor({ state: "visible" });
  const planningModule = page.locator(".module-row").filter({ hasText: "daily-planning" });
  await planningModule.waitFor();
  const planningSpaces = planningModule.locator("select[data-module-spaces]");
  await planningSpaces.selectOption("normal");
  await page.locator("#status").filter({ hasText: "daily-planning 可用空间已更新" }).waitFor();
  assert.equal(await planningModule.locator("select[data-module-spaces]").inputValue(), "normal");
  assert.equal(await page.locator(".module-row").count(), 15);
  await page.locator(".module-row").filter({ hasText: "Tavily Search MCP" }).waitFor();
  assert.equal(await page.locator(".module-token").count(), 15);
  await page.locator(".module-row").filter({ hasText: "Git MCP" }).locator(".module-token").filter({ hasText: "约 620 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Memory Coordinator MCP" }).locator(".module-token").filter({ hasText: "约 430 tokens/轮" }).waitFor();
  assert.match(
    await page.locator(".module-row").filter({ hasText: "Subagent Delegation MCP" })
      .locator(".module-token").textContent() ?? "",
    /约 1,?100 tokens\/轮/,
  );
  await page.locator(".module-row").filter({ hasText: "Relationship State MCP" }).locator(".module-token").filter({ hasText: "约 230 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Tavily Search MCP" }).locator(".module-token").filter({ hasText: "约 350 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Vision MCP" }).locator(".module-token").filter({ hasText: "约 420 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Web Reader MCP" }).locator(".module-token").filter({ hasText: "约 260 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "World State MCP" }).locator(".module-token").filter({ hasText: "约 960 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Interaction State MCP" }).locator(".module-token").filter({ hasText: "约 650 tokens/轮" }).waitFor();
  await planningModule.locator(".module-token").filter({ hasText: /索引约 .*全文约 .*tokens\/调用/ }).waitFor();
  await page.locator("#permissionRuntime").filter({ hasText: "Bubblewrap 可用" }).waitFor();
  assert.match(await page.locator("#workspacePath").textContent(), /workspace$/);
  assert.equal(await page.locator("#networkPermissionInput").isDisabled(), true);
  assert.equal(
    await page.locator("#networkPermissionInput").evaluate((element) => getComputedStyle(element).cursor),
    "not-allowed",
  );
  assert.equal(await page.locator("#networkPermissionInput").getAttribute("title"), "请先启用终端执行");
  await page.getByRole("button", { name: "读写", exact: true }).click();
  await page.locator('button[data-workspace-access="read_write"].active').waitFor();
  await page.locator("#shellPermissionInput").check();
  await page.locator("#shellPermissionLabel").filter({ hasText: "已启用" }).waitFor();
  assert.equal(await page.locator("#networkPermissionInput").isDisabled(), false);
  assert.equal(await page.locator("#networkPermissionInput").isChecked(), false);
  // Simulate a tab surviving a service restart: its process-lifetime HttpOnly
  // capability is gone, but the loaded settings UI must recover automatically.
  const staleCapabilityErrorStart = errors.length;
  await page.context().clearCookies();
  assert.match(
    await page.locator("#networkPermissionInput").getAttribute("title"),
    /可能向外部服务发送当前可见的对话、记忆和 Workspace 内容/,
  );
  let networkWarning = "";
  page.once("dialog", async (dialog) => {
    networkWarning = dialog.message();
    await dialog.accept();
  });
  await page.locator("#networkPermissionInput").check();
  await page.locator("#networkPermissionLabel").filter({ hasText: "已启用" }).waitFor();
  assert.deepEqual(
    errors.splice(staleCapabilityErrorStart),
    ["Failed to load resource: the server responded with a status of 403 (Forbidden) (/api/v1/agent-permissions)"],
    "the stale capability must cause exactly one rejected mutation before automatic retry",
  );
  assert.match(networkWarning, /允许 Agent 联网/);
  assert.match(networkWarning, /私密模式和已启用的 Skill 不会自动关闭此权限/);
  assert.equal(await page.locator("#networkPermissionInput").isChecked(), true);
  await page.locator("#networkPermissionInput").uncheck();
  await page.locator("#networkPermissionLabel").filter({ hasText: "已关闭" }).waitFor();
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "management-modules.png"), fullPage: false });

  await page.getByRole("button", { name: "用户画像", exact: true }).click();
  await page.locator("#profilePanel").waitFor({ state: "visible" });
  await page.locator("#userInsightSummary").filter({ hasText: "1 条已写入" }).waitFor();
  const profileInsight = page.locator("#userInsightList .user-insight-row").filter({ hasText: "浏览器每周复盘" });
  await profileInsight.filter({ hasText: "已写入画像" }).waitFor();
  await profileInsight.locator("summary").click();
  await profileInsight.locator("pre").filter({ hasText: "FREQ=WEEKLY" }).waitFor();
  await profileInsight.getByRole("button", { name: "忽略画像观察" }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "忽略画像观察" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "忽略", exact: true }).click();
  await profileInsight.filter({ hasText: "用户已覆盖" }).waitFor();
  await profileInsight.getByRole("button", { name: "恢复自动判断" }).click();
  await profileInsight.filter({ hasText: "已写入画像" }).waitFor();
  const profileMarkdown = "# 用户画像\n\n## 基本信息\n\n- 称呼：Vector\n\n## 偏好与沟通\n\n- 直接、简洁，先给结论\n\n## 当前目标\n\n- 保持规律作息\n- 持续改进 YourChar";
  await page.locator("#profileMarkdown").fill(profileMarkdown);
  await page.locator("#profileCharacterCount").filter({ hasText: String([...profileMarkdown].length) + " / 2000" }).waitFor();
  await page.getByRole("button", { name: "保存画像" }).click();
  await page.locator("#profileState").filter({ hasText: "已保存" }).waitFor();
  assert.equal(await page.locator("#profileMarkdown").inputValue(), profileMarkdown);
  await page.locator("#userAvatarInput").setInputFiles({ name: "user.png", mimeType: "image/png", buffer: avatarPng });
  await page.locator("#userAvatarPreview img").waitFor();
  await page.locator("#brandUserAvatar img").waitFor();
  await page.locator("#profileState").filter({ hasText: "头像已更新" }).waitFor();
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "management-profile.png"), fullPage: false });

  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.locator("#memoryManagementPanel").waitFor({ state: "visible" });
  await page.locator("#memoryCoordinatorState").filter({ hasText: "1 个待确认" }).waitFor();
  const pendingReality = page.locator("#managedMemoryList .memory-row").filter({ hasText: "浏览器待确认现实偏好" });
  await pendingReality.getByRole("button", { name: "确认", exact: true }).click();
  await pendingReality.getByRole("button", { name: "纠正", exact: true }).waitFor();
  await page.locator("#retrievalPreviewQuery").fill("浏览器待确认现实偏好");
  await page.locator("#retrievalPreviewForm").getByRole("button", { name: "运行预览", exact: true }).click();
  await page.locator("#retrievalPreviewState").filter({ hasText: "1 个入选" }).waitFor();
  await page.locator("#retrievalPreviewResults").filter({ hasText: "入选" }).waitFor();

  await page.locator("#managedMemoryCreateContent").fill("浏览器固定现实事实");
  await page.locator("#managedMemoryForm").getByRole("button", { name: "固定记忆", exact: true }).click();
  const fixedReality = page.locator("#managedMemoryList .memory-row").filter({ hasText: "浏览器固定现实事实" });
  await fixedReality.waitFor();
  await fixedReality.getByRole("button", { name: "纠正", exact: true }).click();
  await page.locator("#sessionActionInput").fill("浏览器纠正后的现实事实");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").filter({ hasText: "记忆冲突已替换" }).waitFor({ state: "visible" });
  await page.locator("#sessionActionDescription").filter({ hasText: "浏览器固定现实事实" }).waitFor();
  await page.locator("#sessionActionDescription").filter({ hasText: "浏览器纠正后的现实事实" }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const correctedReality = page.locator("#managedMemoryList .memory-row").filter({ hasText: "浏览器纠正后的现实事实" });
  await correctedReality.getByRole("button", { name: "遗忘", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "遗忘记忆" }).waitFor({ state: "visible" });
  await page.locator("#sessionActionDialog").getByRole("button", { name: "遗忘", exact: true }).click();
  await correctedReality.filter({ hasText: "deleted" }).waitFor();
  await assertPanelInsideMain(page, "#managementPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "management-memory.png"), fullPage: false });

  await page.getByRole("button", { name: "文件", exact: true }).click();
  await page.locator("#workspaceFilesPanel").waitFor({ state: "visible" });
  await page.locator("#workspaceFileUploadInput").setInputFiles({
    name: "browser-note.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Workspace preview\n\nbrowser-file-ok\n", "utf8"),
  });
  const workspaceNote = page.locator("#workspaceFileList .workspace-file-row").filter({ hasText: "browser-note.md" });
  await workspaceNote.waitFor();
  await workspaceNote.getByRole("button", { name: "预览 browser-note.md" }).click();
  await page.locator("#workspaceFilePreviewDialog").waitFor({ state: "visible" });
  await page.locator("#workspaceFilePreviewContent").filter({ hasText: "browser-file-ok" }).waitFor();
  await page.getByRole("button", { name: "关闭文件预览" }).click();
  await workspaceNote.getByRole("button", { name: "移动 browser-note.md" }).click();
  await page.locator("#sessionActionInput").fill("browser-note-renamed.md");
  await page.locator("#sessionActionInput").press("Enter");
  const renamedWorkspaceNote = page.locator("#workspaceFileList .workspace-file-row").filter({ hasText: "browser-note-renamed.md" });
  await renamedWorkspaceNote.waitFor();
  await renamedWorkspaceNote.getByRole("button", { name: "删除 browser-note-renamed.md" }).click();
  await page.locator("#sessionActionDialog").getByRole("button", { name: "删除", exact: true }).click();
  await renamedWorkspaceNote.waitFor({ state: "detached" });
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "management-files.png"), fullPage: false });

  await page.getByRole("button", { name: "日程", exact: true }).click();
  await page.locator("#schedulePage").waitFor({ state: "visible" });
  await page.locator("#scheduleCalendar .calendar-day").filter({ has: page.locator(".calendar-day-number") }).first().waitFor();
  assert.equal(await page.locator("#scheduleCalendar .calendar-day").count(), 42);
  await assertCalendarNavigation(page);
  await page.locator("#scheduleCreateBtn").click();
  await page.locator("#scheduleEditorDialog").waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "schedule-editor-user.png"));
  await page.locator("#scheduleTitle").fill("浏览器验收提醒");
  await page.locator("#scheduleStart").fill(localDateTimeInput(Date.now() + 60 * 60_000));
  await page.getByRole("button", { name: "创建日程" }).click();
  await page.locator("#scheduleEditorDialog").waitFor({ state: "hidden" });
  const browserSchedule = page.locator("#scheduleList .schedule-row").filter({ hasText: "浏览器验收提醒" });
  await browserSchedule.waitFor();
  const cancelScheduleButton = browserSchedule.getByRole("button", { name: "取消", exact: true });
  await cancelScheduleButton.click();
  await page.locator("#sessionActionDialog").filter({ hasText: "取消日程" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "cancel");
  await cancelScheduleButton.click();
  await page.waitForFunction(() => document.activeElement?.id === "confirmSessionActionBtn");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll("#scheduleList .schedule-row")]
      .find((entry) => entry.textContent?.includes("浏览器验收提醒"));
    return !row || !row.querySelector('[data-action="cancel"]');
  });
  await page.locator("#scheduleCreateBtn").click();
  await page.locator("#scheduleKind").selectOption("task");
  await page.locator("#scheduleTitle").fill("浏览器任务清单验收");
  await page.getByRole("button", { name: "创建日程" }).click();
  const browserTask = page.locator("#taskList .task-item").filter({ hasText: "浏览器任务清单验收" });
  await browserTask.waitFor();
  await browserTask.getByRole("button", { name: "完成任务" }).click();
  await browserTask.waitFor({ state: "detached" });
  await page.locator("#taskAllBtn").click();
  await page.locator("#taskList .task-item.completed").filter({ hasText: "浏览器任务清单验收" }).waitFor();
  await page.screenshot({ path: resolve(outputDir, "schedule-calendar-tasks.png"), fullPage: false });

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.locator("#charactersPage").waitFor({ state: "visible" });
  assert.equal(await page.locator("#characterDetail").isHidden(), true);
  await page.locator("#characterListEmpty").filter({ hasText: "还没有角色" }).waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-empty.png"));
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.locator("#characterDetail").waitFor({ state: "visible" });
  await page.locator("#characterName").fill("林澈");
  const characterSoul = "# SOUL.md - 林澈\n\n## 核心身份\n\n林澈是用户长期信任的同行者。\n\n## 气质与表达\n\n克制、敏锐、自然，不使用客服式套话。\n\n## 边界\n\n- 不替用户作现实决定。\n\n## 连续性\n\n- 尊重当前场景与已确认长期记忆。";
  await page.locator("#characterSoulMarkdown").fill(characterSoul);
  await page.locator("#characterAvatarInput").setInputFiles({ name: "character.png", mimeType: "image/png", buffer: avatarPng });
  await page.locator("#characterAvatarPreview img").waitFor();
  assert.equal(await page.locator("#characterSoulCount").textContent(), `${[...characterSoul].length} / 8000`);
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await page.locator("#characterState").filter({ hasText: "已创建" }).waitFor();
  await page.locator('#characterCardGrid .character-card[data-character-card-id] img').waitFor();
  assert.equal(await page.locator("#characterSoulMarkdown").inputValue(), characterSoul);
  await assertInteractiveBounds(page);
  await page.locator("#charactersPage").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: resolve(outputDir, "characters-cards.png"), fullPage: false });
  await page.getByRole("tab", { name: "协作与技能", exact: true }).click();
  await page.locator("#characterFunctionAdvanced > summary").click();
  await page.locator("#characterPublicRole").fill("研究与规划负责人");
  await page.locator("#characterMaxConcurrentTasks").selectOption("2");
  await page.locator("#characterTaskPreferences").fill("严谨, 重视来源, 结果可验证");
  await page.getByRole("button", { name: "保存协作介绍", exact: true }).click();
  await page.locator("#characterFunctionState").filter({ hasText: "协作介绍已保存" }).waitFor();
  await page.getByRole("button", { name: "新建 Skill", exact: true }).click();
  await page.locator("#characterOwnedSkillDialog").waitFor({ state: "visible" });
  await page.locator("#characterOwnedSkillFormName").fill("来源核验");
  await page.locator("#characterOwnedSkillFormTags").fill("研究, 核验");
  await page.locator("#characterOwnedSkillFormDescription").fill("核对公开资料的出处、日期和证据链。");
  await page.locator("#characterOwnedSkillFormMarkdown").fill(
    "# 来源核验工作方法\n\n- 拆分事实主张。\n- 对照一手来源。\n- 标注证据和不确定性。",
  );
  await page.getByRole("button", { name: "保存 Skill", exact: true }).click();
  await page.locator("#characterOwnedSkillDialog").waitFor({ state: "hidden" });
  await page.locator("#characterOwnedSkillList .owned-skill-card").filter({ hasText: "来源核验" }).waitFor();
  await page.locator("#characterOwnedSkillMarkdown").filter({ hasText: "对照一手来源" }).waitFor();
  await page.locator("#characterFunctionPanel").evaluate((element) =>
    element.scrollIntoView({ block: "start" }));
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-capabilities.png"));
  await page.getByRole("tab", { name: "长期记忆", exact: true }).click();
  await page.getByRole("button", { name: "添加记忆", exact: true }).click();
  await page.locator("#memoryEditorDialog").waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-memory-editor.png"));
  await page.locator("#memoryContent").fill("用户重视可验证的软件质量");
  await page.getByRole("button", { name: "固定记忆" }).click();
  await page.locator("#memoryEditorDialog").waitFor({ state: "hidden" });
  const originalMemory = page.locator("#memoryList .memory-row").filter({ hasText: "可验证的软件质量" });
  await originalMemory.waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-memory.png"));
  const correctMemoryButton = originalMemory.getByRole("button", { name: "纠正", exact: true });
  await correctMemoryButton.click();
  await page.locator("#sessionActionDialog").filter({ hasText: "纠正长期记忆" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.memoryAction), "correct");
  await correctMemoryButton.click();
  await page.locator("#sessionActionInput").fill("用户重视可复现、可验证的软件质量");
  await page.locator("#sessionActionInput").press("Enter");
  const correctedMemory = page.locator("#memoryList .memory-row").filter({ hasText: "可复现、可验证" });
  await correctedMemory.waitFor();
  const deleteMemoryButton = correctedMemory.getByRole("button", { name: "删除", exact: true });
  await deleteMemoryButton.click();
  await page.locator("#sessionActionDialog").filter({ hasText: "删除长期记忆" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.memoryAction), "delete");
  await deleteMemoryButton.click();
  await page.waitForFunction(() => document.activeElement?.id === "confirmSessionActionBtn");
  await page.keyboard.press("Enter");
  await correctedMemory.waitFor({ state: "detached" });

  await page.getByRole("tab", { name: "关系", exact: true }).click();
  await page.locator("#relationshipOverview").filter({ hasText: "初识" }).waitFor();
  await page.locator("#relationshipOverview").filter({ hasText: "尚未建立浪漫关系" }).waitFor();
  await page.locator("#relationshipOverview").filter({ hasText: "尚未明确关系身份" }).waitFor();
  assert.equal(await page.locator("#relationshipOverview .relationship-metric").count(), 3);
  assert.deepEqual(
    await page.locator("#relationshipOverview .relationship-metric > strong").allTextContents(),
    ["35", "25", "0"],
  );
  await page.locator("#relationshipEventList").filter({ hasText: "还没有明确的关系变化记录" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-relationship.png"));
  await page.getByRole("button", { name: "重置", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "重置关系状态" }).waitFor({ state: "visible" });
  await page.locator("#sessionActionInput").fill("错误角色");
  await page.getByRole("button", { name: "重置", exact: true }).last().click();
  await page.locator("#sessionActionError").filter({ hasText: "角色名称不匹配" }).waitFor();
  await page.locator("#sessionActionInput").fill("林澈");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await page.locator("#relationshipState").filter({ hasText: "已重置" }).waitFor();

  await page.getByRole("tab", { name: "生活", exact: true }).click();
  await page.locator("#characterLifePanel").waitFor({ state: "visible" });
  await page.locator("#characterLifeEmpty").filter({ hasText: "选择一个共享世界" }).waitFor();
  await page.locator("#newWorldCardBtn").click();
  await page.locator("#worldManagerDialog").waitFor({ state: "visible" });
  await page.locator("#saveWorldBtn").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#saveWorldBtn")?.disabled);
  await page.locator("#worldName").fill("青岚市");
  await page.locator("#worldDescription").fill("角色共同生活的现代城市。");
  await page.locator("#worldRules").fill("# 世界规则\n\n- 时间连续推进。\n- 地点功能决定可执行的活动。");
  await page.getByRole("button", { name: "创建世界", exact: true }).click();
  await page.locator("#worldManagerState").filter({ hasText: "已创建" }).waitFor();
  await page.locator("#worldPlacesSection").waitFor({ state: "visible" });
  await page.locator("#worldPlaceName").fill("河岸书店");
  await page.locator("#worldPlaceDescription").fill("可以阅读、休息和给朋友发消息的安静书店。");
  await page.getByRole("checkbox", { name: "休息", exact: true }).check();
  await page.getByRole("checkbox", { name: "学习", exact: true }).check();
  await page.getByRole("checkbox", { name: "通信", exact: true }).check();
  await page.getByRole("button", { name: "添加地点", exact: true }).click();
  await page.locator("#worldManagerState").filter({ hasText: "地点已添加" }).waitFor();
  await page.locator("#worldPlaceList .world-place-row").filter({ hasText: "河岸书店" }).filter({ hasText: "学习" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-world-manager.png"));
  await page.getByRole("button", { name: "关闭世界管理" }).click();
  await page.locator("#worldManagerDialog").waitFor({ state: "hidden" });
  const worldCard = page.locator("#worldCardGrid .world-card").filter({ hasText: "青岚市" }).filter({ hasText: "默认模型" });
  await worldCard.waitFor();
  await worldCard.scrollIntoViewIfNeeded();
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-world-cards.png"));
  await page.locator("#characterWorldSelect").selectOption({ label: "青岚市" });
  await page.getByRole("button", { name: "保存归属", exact: true }).click();
  await page.locator("#characterLifeState").filter({ hasText: "已加入世界" }).waitFor();
  await page.locator("#characterLifeContent").waitFor({ state: "visible" });
  await page.locator("#lifeHomePlace").selectOption({ label: "河岸书店" });
  await page.locator("#lifeRuntimePlace").selectOption({ label: "河岸书店" });
  await page.locator("#lifeAutonomyEnabled").check();
  await page.locator("#lifeProactiveEnabled").check();
  await page.locator("#lifeProactiveCooldown").fill("90");
  await page.getByRole("button", { name: "保存生活设置", exact: true }).click();
  await page.locator("#characterLifeState").filter({ hasText: "已保存" }).waitFor();
  await page.getByRole("button", { name: "安排今日", exact: true }).click();
  await page.locator("#characterLifeState").filter({ hasText: /已安排 \d+ 项/ }).waitFor();
  await page.getByRole("button", { name: "模拟生活片段", exact: true }).click();
  await page.locator("#characterLifeState").filter({ hasText: "片段已发生，并已主动发出消息" }).waitFor();
  await page.locator("#lifeEventList .life-event-row").filter({ hasText: "河岸书店" }).waitFor();
  await page.locator("#lifeProactiveList .life-proactive-row").filter({ hasText: "已发送" }).waitFor();
  assert.equal(await page.locator("#lifeProactiveCooldown").inputValue(), "90");
  await assertPanelInsideMain(page, "#charactersPage");
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-life.png"));

  await page.getByRole("button", { name: "日程", exact: true }).click();
  await page.getByRole("tab", { name: "角色日程", exact: true }).click();
  await page.locator("#scheduleCharacterSelect").selectOption({ label: "林澈" });
  await page.locator("#conversationCharacter").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "角色日程" }).waitFor();
  await page.locator("#scheduleCreateBtn").click();
  await page.locator("#scheduleEditorScope").filter({ hasText: "不触发现实通知" }).waitFor();
  assert.equal(await page.locator('#scheduleKind option[value="reminder"]').evaluate((option) => option.disabled), true);
  assert.equal(await page.locator("#scheduleKind").inputValue(), "event");
  await captureValidatedScreenshot(page, resolve(outputDir, "schedule-editor-character.png"));
  await page.locator("#scheduleTitle").fill("傍晚去河岸");
  await page.getByRole("button", { name: "创建日程" }).click();
  const characterSchedule = page.locator("#scheduleList .schedule-row").filter({ hasText: "傍晚去河岸" });
  await characterSchedule.waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "schedule-character-calendar.png"));
  await page.getByRole("tab", { name: "用户日程", exact: true }).click();
  await page.locator("#conversationCharacter").filter({ hasText: "我的日程" }).waitFor();
  await page.locator("#scheduleList .schedule-row").filter({ hasText: "傍晚去河岸" }).waitFor({ state: "detached" });

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.route("**/api/v1/diagnostics/model/models", async (route) => {
    assert.equal(route.request().method(), "POST");
    const candidate = route.request().postDataJSON();
    assert.equal(candidate.profileId, "default");
    assert.equal(candidate.profilePatch.model, "");
    assert.equal(candidate.apiKey, "browser-candidate-key");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: ["browser-model-a", "browser-model-b"] }) });
  });
  await page.locator("#apiBaseUrl").fill("http://127.0.0.1:8317/v1");
  await page.locator("#apiModel").selectOption("");
  await page.locator("#apiKey").fill("browser-candidate-key");
  await page.getByRole("button", { name: "读取模型", exact: true }).click();
  await page.locator("#apiSettingsState").filter({ hasText: "2 个模型" }).waitFor();
  assert.deepEqual(await page.locator("#apiModel option").allTextContents(), ["读取模型后选择", "browser-model-a", "browser-model-b", "手动输入..."]);
  await page.locator("#apiKey").fill("");
  await page.locator("#apiModel").selectOption("browser-model-b");
  await page.locator("#apiContextWindowTokens").fill("65536");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.locator("#apiSettingsState").filter({ hasText: "已保存" }).waitFor();
  assert.equal(await page.locator("#apiContextWindowTokens").inputValue(), "65536");
  await page.unroute("**/api/v1/diagnostics/model/models");

  await page.getByRole("button", { name: "视觉", exact: true }).click();
  await page.locator("#visionSettingsState").filter({ hasText: "Key: 未设置" }).waitFor();
  await page.route("**/api/v1/diagnostics/vision/models", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: ["vision-browser-a", "vision-browser-b"] }) });
  });
  await page.locator("#visionBaseUrl").fill("https://vision.example.test/v1");
  await page.locator("#visionApiKey").fill("vision-browser-test-secret");
  await page.getByRole("button", { name: "读取模型", exact: true }).click();
  await page.locator("#visionSettingsState").filter({ hasText: "2 个模型" }).waitFor();
  await page.locator("#visionModel").selectOption("vision-browser-b");
  await page.locator("#visionDetail").selectOption("high");
  await page.locator("#visionMaxImages").fill("3");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.locator("#visionSettingsState").filter({ hasText: "已保存" }).filter({ hasText: "visi...cret" }).waitFor();
  const safeVisionConfig = await page.evaluate(async () => {
    const response = await fetch("/api/settings/vision");
    return response.json();
  });
  assert.equal(JSON.stringify(safeVisionConfig).includes("vision-browser-test-secret"), false);
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "settings-vision.png"), fullPage: false });
  await page.unroute("**/api/v1/diagnostics/vision/models");

  await page.getByRole("button", { name: "提示词", exact: true }).click();
  await page.locator("#systemPromptState").filter({ hasText: "已加载" }).waitFor();
  const customSmsPrompt = "# 私聊偏好\n\n- 回复先给结论。";
  await page.locator("#systemPromptCustom").fill(customSmsPrompt);
  await page.getByRole("button", { name: "保存提示词", exact: true }).click();
  await page.locator("#systemPromptState").filter({ hasText: "已保存" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "剧情演绎", exact: true }).count(), 0);
  assert.equal(await page.locator("#systemPromptCustom").inputValue(), customSmsPrompt);
  await page.locator("#promptSettingsPanel details").last().locator("summary").click();
  await page.locator("#systemPromptEffective").filter({ hasText: "IMMUTABLE POLICY BOUNDARY" }).waitFor();

  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.locator("#tavilySettingsState").filter({ hasText: "Key: 未设置" }).waitFor();
  await page.locator("#tavilyApiKey").fill("tvly-browser-test-secret");
  await page.locator("#tavilyProxyUrl").fill("http://127.0.0.1:7890");
  await page.getByRole("button", { name: "保存 Tavily 设置" }).click();
  await page.locator("#tavilySettingsState").filter({ hasText: "已保存 · Key: tvly...cret · 代理: http://127.0.0.1:7890" }).waitFor();
  assert.equal(await page.locator("#tavilyApiKey").inputValue(), "");
  assert.equal(await page.locator("#tavilyProxyUrl").inputValue(), "");
  const safeTavilyConfig = await page.evaluate(async () => {
    const response = await fetch("/api/settings/tavily");
    return response.json();
  });
  assert.equal(JSON.stringify(safeTavilyConfig).includes("tvly-browser-test-secret"), false);
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "settings-tavily.png"), fullPage: false });
  await page.getByRole("button", { name: "数据", exact: true }).click();
  await page.locator("#runtimeState").filter({ hasText: "数据库 ok" }).waitFor();
  await page.locator("#traceArchiveState").filter({ hasText: "已关闭" }).waitFor();
  await page.locator("#traceArchiveEnabled").check();
  await page.locator("#traceArchiveState").filter({ hasText: "已开启" }).waitFor();
  assert.match(await page.locator("#traceArchivePath").inputValue(), /trace-archive$/);
  const traceArchiveConfig = await page.evaluate(async () => {
    const response = await fetch("/api/settings/trace-archive");
    return response.json();
  });
  assert.equal(traceArchiveConfig.enabled, true);
  await page.locator("#traceArchiveEnabled").uncheck();
  await page.locator("#traceArchiveState").filter({ hasText: "已关闭" }).waitFor();
  await page.locator("#memoryVaultHealth").scrollIntoViewIfNeeded();
  await page.locator("#memoryVaultWriter").filter({ hasText: "writer" }).waitFor();
  await assertVaultHealthBounds(page);
  await page.screenshot({ path: resolve(outputDir, "vault-health-desktop.png"), fullPage: false });
  const okfDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 OKF", exact: true }).click();
  const okfDownload = await okfDownloadPromise;
  assert.match(okfDownload.suggestedFilename(), /^yourchar-memory-okf-\d{8}T\d{6}Z\.zip$/);
  await okfDownload.cancel();
  await page.locator("#okfImportInput").setInputFiles({
    name: "browser-okf.zip",
    mimeType: "application/zip",
    buffer: okfBrowserZip,
  });
  await page.locator("#okfImportState").filter({ hasText: "校验通过" }).waitFor();
  await page.locator("#okfPreviewSummary").filter({ hasText: "1 条可导入 · 1 条跳过" }).waitFor();
  await page.locator("#okfDocumentList .okf-document-row.ready").filter({ hasText: "日程沟通偏好" }).waitFor();
  await page.locator("#okfDocumentList .okf-document-row.unsupported").filter({ hasText: "通用操作手册" }).waitFor();
  assert.equal(await page.locator("#stageOkfImportBtn").isEnabled(), true);
  await page.locator("#okfImportPreview").scrollIntoViewIfNeeded();
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "settings-okf-import-preview.png"), fullPage: false });
  await page.getByRole("button", { name: "加入待审核", exact: true }).click();
  await page.locator("#okfImportState").filter({ hasText: "1 条记忆已加入待审核" }).waitFor();

  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#newConversationCharacter option:checked").textContent(), "林澈");
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "new-conversation-dialog.png"));
  await page.getByRole("button", { name: "打开私聊", exact: true }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "hidden" });
  await page.locator('#conversationList [data-conversation-group="__roles__"] .conversation-group-head').filter({ hasText: "角色" }).waitFor();
  await page.locator("#conversationList .conversation-item.active").waitFor();
  await page.locator("#conversationCharacter").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
  const proactiveBubble = page.locator("#messages .message-row.assistant").filter({ hasText: "突然想和你说一声" });
  await proactiveBubble.waitFor();
  await proactiveBubble.locator("details.proactive-feedback > summary").click();
  await proactiveBubble.locator(".proactive-feedback-panel").waitFor({ state: "visible" });
  assert.equal(
    await proactiveBubble.locator(".proactive-feedback-panel").evaluate((element) => getComputedStyle(element).opacity),
    "1"
  );
  await assertElementUnclipped(page, ".proactive-feedback-panel");
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-proactive-feedback-menu.png"));
  await proactiveBubble.getByRole("button", { name: "这条有帮助", exact: true }).click();
  await proactiveBubble.locator(".proactive-feedback-receipt").waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-proactive-feedback.png"));
  await page.locator("#textInput").fill("今晚见");
  await page.getByRole("button", { name: "选择表情", exact: true }).click();
  await page.locator("#emojiPicker").waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#emojiPicker");
  await page.getByRole("button", { name: "插入表情 😊", exact: true }).click();
  await page.getByRole("tab", { name: "爱心与关系", exact: true }).click();
  await page.getByRole("button", { name: "插入表情 ❤️‍🔥", exact: true }).click();
  assert.equal(await page.locator("#textInput").inputValue(), "今晚见😊❤️‍🔥");
  const renderedEmoji = page.locator("#emojiPicker img.emoji");
  assert.ok(await renderedEmoji.count() > 10);
  assert.equal(await renderedEmoji.first().evaluate((image) => image.complete && image.naturalWidth > 0), true);
  assert.match(await renderedEmoji.first().getAttribute("src"), /^\/assets\/twemoji\/svg\/[0-9a-f-]+\.svg$/);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-emoji-picker.png"));
  await page.keyboard.press("Escape");
  await page.locator("#emojiPicker").waitFor({ state: "hidden" });
  await page.locator("#textInput").fill("先建立角色私聊会话。");
  const userMessagesBeforeImeConfirmation = await page.locator("#messages .message-row.user").count();
  await page.locator("#textInput").evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "conversation" }));
    element.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      isComposing: true,
    }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "conversation" }));
  });
  assert.equal(await page.locator("#messages .message-row.user").count(), userMessagesBeforeImeConfirmation);
  assert.equal(await page.locator("#textInput").inputValue(), "先建立角色私聊会话。");
  await page.waitForTimeout(120);
  await page.locator("#textInput").press("Enter");
  const smsSystemEvent = page.locator("#messages .message-row.system").last();
  await smsSystemEvent.filter({ hasText: "模型当前未启用" }).waitFor();
  await page.waitForFunction(() => {
    const bubbles = document.querySelectorAll("#messages .bubble.user");
    return Boolean(bubbles.length && bubbles[bubbles.length - 1].getBoundingClientRect().height > 0);
  });
  const userBubbleHeight = await page.locator("#messages .bubble.user").last().evaluate((element) => element.getBoundingClientRect().height);
  assert.ok(userBubbleHeight < 56, `single-line user bubble is too tall: ${userBubbleHeight}`);
  assert.equal(await smsSystemEvent.locator(".message-avatar").count(), 0);
  assert.equal(await smsSystemEvent.locator(".bubble.assistant").count(), 0);
  await page.waitForFunction(() => document.querySelector("#modeSelect")?.disabled === true);
  const smsSessionId = await page.locator("#sessionSelect").inputValue();
  assert.ok(smsSessionId);
  const contextBudgetButton = page.locator("#contextBudgetBtn");
  await contextBudgetButton.waitFor({ state: "visible" });
  assert.equal((await contextBudgetButton.textContent()).trim(), "");
  assert.match(await contextBudgetButton.getAttribute("title"), /上下文已用.*%/);
  assert.equal(await contextBudgetButton.locator(".context-budget-ring").isVisible(), true);
  await contextBudgetButton.click();
  await page.locator("#contextBudgetDialog").waitFor({ state: "visible" });
  await page.locator("#contextBudgetMetrics")
    .filter({ hasText: "本地估算" })
    .filter({ hasText: "模型窗口" })
    .filter({ hasText: "安全保留" })
    .waitFor();
  await assertElementUnclipped(page, "#contextBudgetDialog");
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-context-budget.png"));
  await page.getByRole("button", { name: "关闭上下文余量" }).click();
  const smsMessagesRoute = "**/api/v1/sessions/" + smsSessionId + "/messages**";
  await page.route(smsMessagesRoute, (route) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify([
      { role: "user", content: [{ type: "text", text: "分两条告诉我" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "第一条自然消息。\n\n第二条自然消息。" }],
        turnStatus: "completed",
        attachments: [{
          path: browserSharedHtmlEntry.path,
          name: browserSharedHtmlEntry.name,
          contentType: browserSharedHtmlEntry.contentType,
          size: browserSharedHtmlEntry.size,
          previewKind: browserSharedHtmlEntry.previewKind,
        }],
      },
    ]),
  }));
  await page.evaluate(() => window.refreshSessionMessages(true));
  const splitAssistant = page.locator("#messages .message-row.assistant").last();
  assert.equal(await splitAssistant.locator(".message-bubble-content > .bubble").count(), 2);
  const sharedHtmlCard = splitAssistant.locator(".message-file-attachment").filter({ hasText: "角色页面.html" });
  await sharedHtmlCard.waitFor({ state: "visible" });
  assert.match(
    await sharedHtmlCard.getByRole("link", { name: "下载 角色页面.html" }).getAttribute("href"),
    /disposition=attachment/u,
  );
  await sharedHtmlCard.getByRole("button", { name: "预览 角色页面.html" }).click();
  await page.locator("#workspaceFilePreviewDialog").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#workspaceFilePreviewContent iframe").getAttribute("sandbox"),
    "",
  );
  const sharedHtmlFrame = page.frameLocator("#workspaceFilePreviewContent iframe");
  await sharedHtmlFrame.getByRole("heading", { name: "角色附件预览成功" }).waitFor();
  assert.equal(await sharedHtmlFrame.locator('meta[http-equiv="refresh"]').count(), 0);
  assert.equal(await sharedHtmlFrame.locator("#external-link").getAttribute("href"), null);
  assert.equal(await sharedHtmlFrame.locator("#external-image").getAttribute("src"), null);
  assert.equal(await sharedHtmlFrame.locator("script").count(), 0);
  assert.equal(
    await sharedHtmlFrame.locator("body").evaluate(() =>
      Boolean(globalThis.browserAttachmentScriptRan)),
    false,
  );
  await page.route("https://example.invalid/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: avatarPng,
  }));
  await page.getByRole("button", { name: "运行交互预览", exact: true }).click();
  assert.equal(
    await page.locator("#workspaceFilePreviewContent iframe").getAttribute("sandbox"),
    "allow-scripts",
  );
  await sharedHtmlFrame.getByRole("heading", { name: "角色附件预览成功" }).waitFor();
  assert.equal(await sharedHtmlFrame.locator('meta[http-equiv="refresh"]').count(), 0);
  assert.equal(await sharedHtmlFrame.locator("#external-link").getAttribute("href"), null);
  assert.equal(
    await sharedHtmlFrame.locator("#external-image").getAttribute("src"),
    "https://example.invalid/tracker.png",
  );
  assert.equal(
    await sharedHtmlFrame.locator("body").evaluate(() =>
      Boolean(globalThis.browserAttachmentScriptRan)),
    true,
  );
  await page.getByRole("button", { name: "切回安全预览", exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭文件预览" }).click();
  await page.unroute("https://example.invalid/**");
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-multi-bubble.png"));
  await page.unroute(smsMessagesRoute);
  await page.evaluate(() => window.refreshSessionMessages(true));
  const canonicalSmsSessions = await page.evaluate(async (selectedCharacterId) => {
    const response = await fetch("/api/v1/sessions");
    const body = await response.json();
    return body.sessions.filter((session) =>
      session.mode === "sms" && session.characterId === selectedCharacterId && session.canonicalDirect
    );
  }, await page.locator("#chatCharacterSelect").inputValue());
  assert.equal(canonicalSmsSessions.length, 1);
  assert.equal(canonicalSmsSessions[0].id, smsSessionId);
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationCharacter").selectOption({ label: "林澈" });
  await page.getByRole("button", { name: "打开私聊", exact: true }).click();
  assert.equal(await page.locator("#sessionSelect").inputValue(), smsSessionId);
  assert.equal(await page.locator("#modeSelect").isDisabled(), true);
  assert.equal(await page.locator("#chatCharacterSelect").isDisabled(), true);
  await page.locator("#conversationScene").filter({ hasText: "河岸书店" }).waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "system-event.png"));
  await smsSystemEvent.getByRole("button", { name: "前往模型设置" }).click();
  await page.locator("#settingsPage").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  assert.equal(await page.locator("#privateModeToggle").isVisible(), false);
  assert.equal(await page.locator("#incognitoModeToggle").isVisible(), false);
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitemcheckbox", { name: "进入私密模式", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitemcheckbox", { name: "进入无痕模式", exact: true }).waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#privateModeToggle");
  await assertElementUnclipped(page, "#incognitoModeToggle");
  await captureValidatedScreenshot(page, resolve(outputDir, "session-privacy-menu.png"));
  await page.getByRole("menuitemcheckbox", { name: "进入无痕模式", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "开启无痕会话" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "进入无痕会话", exact: true }).click();
  await page.locator("#incognitoNotice").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "会话操作" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitemcheckbox", { name: "退出无痕模式", exact: true }).click();
  await page.locator("#incognitoNotice").waitFor({ state: "hidden" });
  await page.waitForFunction(
    (expected) => document.querySelector("#sessionSelect")?.value === expected,
    smsSessionId,
  );
  assert.equal(await page.locator("#sessionSelect").inputValue(), smsSessionId);
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
  await page.locator("#sessionActionDialog").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sessionActionsMenuBtn");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
  await page.locator("#sessionActionInput").fill("日常私聊");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  const renamedSmsOption = page.locator(`#sessionSelect option[value="${smsSessionId}"]`).filter({ hasText: "日常私聊" });
  await renamedSmsOption.waitFor({ state: "attached" });
  assert.match(await renamedSmsOption.textContent(), /日常私聊/);
  await captureValidatedScreenshot(page, resolve(outputDir, "session-renamed-sms.png"));

  await page.getByRole("button", { name: "发起见面", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "约见" }).waitFor({ state: "visible" });
  await page.locator("#sessionActionInput").fill("未来道具研究所");
  await page.getByRole("button", { name: "约好", exact: true }).click();
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await page.locator("#conversationMode").filter({ hasText: "约好见面" }).waitFor();
  await page.locator("#conversationScene").filter({ hasText: "未来道具研究所" }).waitFor();
  const proposedMeetingEvent = page.locator("#messages .message-row.interaction").filter({ hasText: "约定在未来道具研究所见面" });
  await proposedMeetingEvent.waitFor();
  await proposedMeetingEvent.getByRole("button", { name: "我到了", exact: true }).click();
  await page.locator("#conversationMode").filter({ hasText: "现场" }).waitFor();
  await page.locator("#conversationScene").filter({ hasText: "未来道具研究所" }).waitFor();
  assert.equal(await page.locator("#textInput").getAttribute("placeholder"), "描述你在现场说的话或正在做的事");
  assert.equal(await page.getByRole("button", { name: "结束现场", exact: true }).isVisible(), true);
  // Rendering the new interaction state precedes the async transition's finally cleanup.
  await page.waitForFunction(() => !document.getElementById("interactionToggleBtn").disabled);
  assert.equal(await page.getByRole("button", { name: "结束现场", exact: true }).isEnabled(), true);
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-in-person-state.png"));
  await page.getByRole("button", { name: "结束现场", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "结束现场" }).waitFor({ state: "visible" });
  await page.locator("#confirmSessionActionBtn").click();
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
  await page.locator("#conversationScene").filter({ hasText: "河岸书店" }).waitFor({ state: "visible" });
  await page.locator("#messages .message-row.interaction").filter({ hasText: "结束在未来道具研究所的见面" }).waitFor();

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.locator("#characterName").fill("顾遥");
  await page.locator("#characterSoulMarkdown").fill("# SOUL.md - 顾遥\n\n沉静、善于倾听，以第一人称自然交流。");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await page.locator("#characterState").filter({ hasText: "已创建" }).waitFor();
  await page.locator("#characterCardGrid .character-card").filter({ hasText: "顾遥" }).waitFor();
  const sourceCharacter = kernel.listCharacters().find((entry) => entry.name === "林澈");
  const targetCharacter = kernel.listCharacters().find((entry) => entry.name === "顾遥");
  assert.ok(sourceCharacter && targetCharacter);
  const sourceLife = kernel.getCharacterLife(sourceCharacter.id);
  assert.ok(sourceLife.world && sourceLife.membership && sourceLife.runtime?.placeId);
  kernel.assignCharacterWorld(targetCharacter.id, {
    worldId: sourceLife.world.id,
    homePlaceId: sourceLife.membership.homePlaceId,
    currentPlaceId: sourceLife.runtime.placeId,
  });
  kernel.updateCharacterAutonomyPolicy(targetCharacter.id, {
    proactiveEnabled: true,
    dailyMessageLimit: 2,
    proactiveCooldownMinutes: 15,
    quietStart: "00:00",
    quietEnd: "00:00",
  });
  const seededCharacterChannel = kernel.characterChannels.startEpisode({
    initiatorCharacterId: sourceCharacter.id,
    targetCharacterId: targetCharacter.id,
    kind: "collaboration",
    source: "manual",
    idempotencyKey: "browser-character-channel",
    parentSessionId: smsSessionId,
    title: "整理河岸散步路线",
    objective: "一起确认雨后适合散步的路线。",
  });
  kernel.characterChannels.updateEpisode(seededCharacterChannel.episode.id, { status: "running" });
  kernel.characterChannels.appendCharacterMessage({
    channelId: seededCharacterChannel.channel.id,
    episodeId: seededCharacterChannel.episode.id,
    senderCharacterId: sourceCharacter.id,
    kind: "task",
    content: "顾遥，能帮我确认一下雨后河岸哪一段更适合散步吗？",
  });
  kernel.characterChannels.appendCharacterMessage({
    channelId: seededCharacterChannel.channel.id,
    episodeId: seededCharacterChannel.episode.id,
    senderCharacterId: targetCharacter.id,
    kind: "result",
    content: "书店往东的石板路积水少，我可以先去看一眼，再把路线告诉你。",
  });
  kernel.characterChannels.updateEpisode(seededCharacterChannel.episode.id, {
    status: "completed",
    resultText: "书店往东的石板路积水少。",
    completed: true,
  });
  browserRuntime.clock.advance(1_000);
  const laterCharacterChannelEpisode = kernel.characterChannels.startEpisode({
    initiatorCharacterId: targetCharacter.id,
    targetCharacterId: sourceCharacter.id,
    kind: "social",
    source: "manual",
    idempotencyKey: "browser-character-channel-later",
    title: "聊起书店的新书",
    objective: "确认下一次见面时想看的书。",
  });
  kernel.characterChannels.updateEpisode(laterCharacterChannelEpisode.episode.id, {
    status: "running",
  });
  kernel.characterChannels.appendCharacterMessage({
    channelId: laterCharacterChannelEpisode.channel.id,
    episodeId: laterCharacterChannelEpisode.episode.id,
    senderCharacterId: targetCharacter.id,
    content: "我还看到一本新到的旅行随笔。",
  });
  kernel.characterChannels.appendCharacterMessage({
    channelId: laterCharacterChannelEpisode.channel.id,
    episodeId: laterCharacterChannelEpisode.episode.id,
    senderCharacterId: sourceCharacter.id,
    content: "那我们下次一起翻翻。",
  });
  const unreadBeforeCollaborationFocus = kernel.listCharacterChannels({
    worldId: sourceLife.world.id,
  }).find((entry) => entry.id === seededCharacterChannel.channel.id)?.unreadCount;
  assert.ok(unreadBeforeCollaborationFocus);
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.evaluate(() => window.loadSessions());
  const characterChannelItem = page.locator(
    `#conversationList button[data-character-channel-id="${seededCharacterChannel.channel.id}"]`,
  );
  await characterChannelItem.waitFor();
  assert.equal(await characterChannelItem.locator(".character-channel-avatar > span").count(), 2);
  await characterChannelItem.locator(".conversation-unread")
    .filter({ hasText: String(unreadBeforeCollaborationFocus) }).waitFor();
  await page.locator(`#conversationList button[data-session-id="${smsSessionId}"]`).click();
  const collaborationCard = page.locator(
    `#messages .message-row.collaboration[data-character-episode-id="${seededCharacterChannel.episode.id}"]`,
  );
  await collaborationCard.filter({ hasText: "顾遥已经把结果交给林澈" })
    .filter({ hasText: "结果已返回" })
    .filter({ hasText: "确认雨后适合散步的路线" })
    .waitFor();
  await collaborationCard.getByRole("button", {
    name: "查看林澈与顾遥的往来",
    exact: true,
  }).click();
  await page.locator("#characterChannelDialog").waitFor({ state: "visible" });
  await page.locator("#characterChannelParticipants").filter({ hasText: "林澈 与 顾遥" }).filter({ hasText: "结果已返回" }).waitFor();
  await page.locator("#characterChannelMessages").filter({ hasText: "哪一段更适合散步" }).filter({ hasText: "石板路积水少" }).waitFor();
  const focusedCollaboration = page.locator(
    `#characterChannelMessages [data-character-channel-episode-id="${seededCharacterChannel.episode.id}"]`,
  );
  await focusedCollaboration.filter({ hasText: "整理河岸散步路线" }).waitFor();
  assert.equal(await focusedCollaboration.evaluate((element) => element.classList.contains("focused")), true);
  const laterEpisode = page.locator(
    `#characterChannelMessages [data-character-channel-episode-id="${laterCharacterChannelEpisode.episode.id}"]`,
  ).filter({ hasText: "聊起书店的新书" });
  await laterEpisode.filter({ hasText: "交流中" }).waitFor();
  assert.equal(await focusedCollaboration.locator(".character-channel-message-avatar").count(), 2);
  assert.equal(await laterEpisode.locator(".character-channel-message-avatar").count(), 2);
  await page.waitForTimeout(350);
  assert.equal(await focusedCollaboration.evaluate((element) => {
    const container = element.closest("#characterChannelMessages");
    if (!container) return false;
    const target = element.getBoundingClientRect();
    const viewport = container.getBoundingClientRect();
    return target.bottom > viewport.top && target.top < viewport.bottom;
  }), true);
  assert.equal(
    kernel.listCharacterChannels({ worldId: sourceLife.world.id })
      .find((entry) => entry.id === seededCharacterChannel.channel.id)?.unreadCount,
    unreadBeforeCollaborationFocus,
  );
  await characterChannelItem.locator(".conversation-unread")
    .filter({ hasText: String(unreadBeforeCollaborationFocus) }).waitFor();
  const channelScrollBeforeRefresh = await page.locator("#characterChannelMessages")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });
  await page.evaluate(
    async (channelId) => window.openCharacterChannel(channelId, true),
    seededCharacterChannel.channel.id,
  );
  assert.equal(
    await page.locator("#characterChannelMessages").evaluate((element) => element.scrollTop),
    channelScrollBeforeRefresh,
  );
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "character-private-channel.png"));
  await page.getByRole("button", { name: "关闭角色互动", exact: true }).click();
  await page.locator("#characterChannelDialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#newConversationCharacter option:checked").textContent(), "顾遥");
  await page.getByRole("button", { name: "世界", exact: true }).click();
  await page.locator("#newConversationWorld").selectOption(sourceLife.world.id);
  await page.getByRole("button", { name: "进入世界", exact: true }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "hidden" });
  await page.locator("#conversationCharacter").filter({ hasText: "青岚市" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "世界演绎 · 2 位角色" }).waitFor();
  assert.equal(await page.locator("#attachFileBtn").isDisabled(), false);
  const worldConversationItem = page.locator(`#conversationList button[data-world-id="${sourceLife.world.id}"]`);
  await worldConversationItem.waitFor();
  assert.equal(await worldConversationItem.locator(".group-avatar-cluster.compact > span").count(), 2);
  assert.equal(await page.locator("#conversationHeaderAvatar .group-avatar-cluster > span").count(), 2);
  await captureValidatedScreenshot(page, resolve(outputDir, "world-conversation.png"));
  const worldSection = page.locator('#conversationList [data-conversation-group="__worlds__"]');
  await worldSection.locator("button[data-conversation-group-toggle]").click();
  assert.equal(await worldSection.locator(".conversation-group-sessions").isHidden(), true);
  assert.equal(await worldSection.locator("button[data-conversation-group-toggle]").getAttribute("aria-expanded"), "false");
  await worldSection.locator("button[data-conversation-group-toggle]").click();
  await worldSection.locator(".conversation-group-sessions").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "批量管理会话" }).click();
  await worldSection.locator(".conversation-item.batch-disabled").filter({ hasText: "青岚市" }).waitFor();
  assert.equal(await worldSection.locator('input[type="checkbox"]').count(), 0);
  await page.getByRole("checkbox", { name: "选择会话 林澈" }).check();
  await page.locator("#conversationBatchCount").filter({ hasText: "已选 1 项" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "world-role-batch-selection.png"));
  await page.getByRole("button", { name: "完成批量管理" }).click();
  const activeWorldEvent = kernel.transitionWorldStoryEvent(sourceLife.world.id, {
    action: "begin",
    source: "user_control",
    title: "河岸散步",
    summary: "林澈、顾遥和用户在河岸书店展开一段共同经历。",
    objective: "决定接下来去哪里",
    placeId: sourceLife.runtime.placeId,
    participantIds: [sourceCharacter.id, targetCharacter.id],
  });
  assert.equal(activeWorldEvent?.status, "active");
  await page.evaluate(() => window.loadSessions());
  await page.locator("#conversationScene").filter({ hasText: "进行中 · 河岸散步" }).waitFor();
  await page.locator("#textInput").fill("我们继续沿着河岸聊聊。");
  await page.locator("#chatAttachmentInput").setInputFiles([
    { name: "scene-note.txt", mimeType: "text/plain", buffer: Buffer.from("river scene", "utf8") },
    { name: "scene.png", mimeType: "image/png", buffer: scenePng },
  ]);
  await page.locator("#attachmentQueue .attachment-chip").filter({ hasText: "scene-note.txt" }).waitFor();
  await page.locator("#attachmentQueue .attachment-chip").filter({ hasText: "scene.png" }).waitFor();
  const plainTextPastePrevented = await page.locator("#textInput").evaluate((input) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "普通剪贴板文字");
    const event = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(plainTextPastePrevented, false);
  await page.locator("#textInput").evaluate((input, payload) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(payload.image)], "clipboard-scene.png", { type: "image/png" }));
    transfer.items.add(new File(["clipboard note"], "clipboard-note.txt", { type: "text/plain" }));
    input.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, { image: [...scenePng] });
  await page.locator("#attachmentQueue .attachment-chip").filter({ hasText: "clipboard-scene.png" }).waitFor();
  await page.locator("#attachmentQueue .attachment-chip").filter({ hasText: "clipboard-note.txt" }).waitFor();
  assert.equal(await page.locator("#attachmentQueue .attachment-chip").count(), 4);
  assert.equal(await page.locator("#textInput").inputValue(), "我们继续沿着河岸聊聊。");
  kernel.patchModelApiConfig({
    enabled: true,
    baseUrl: browserWorldModelBaseUrl,
    model: "browser-world-model",
  });
  const worldModelRequestStart = browserWorldModelRequests.length;
  browserWorldModelResponses.push(
    "雨后的日光映在河岸书店的玻璃上。林澈把书合上，抬眼望向窗外湿润的河岸。\n\n“走吧，雨已经小了。”她推开门。顾遥替最后一个人扶住门，望向前面的河堤：“前面那段路安静些。”",
    JSON.stringify({
      event: {
        action: "advance",
        title: "河岸散步",
        summary: "三人离开书店，沿着雨后的河岸继续交谈。",
        objective: "决定接下来去哪里",
        placeId: sourceLife.runtime.placeId,
        participantIds: [sourceCharacter.id, targetCharacter.id],
        confidence: 0.98,
      },
      runtimeUpdates: [],
      observations: [
        { characterId: sourceCharacter.id, knowledge: "direct", summary: "用户愿意继续沿河交谈。", salience: 0.7 },
        { characterId: targetCharacter.id, knowledge: "direct", summary: "林澈提议在雨停后继续散步。", salience: 0.65 },
      ],
      relationships: [],
    }),
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const uploadedMessage = page.locator("#messages .message-row.user").last();
  await uploadedMessage.locator(".message-file-attachment").filter({ hasText: "scene-note.txt" }).waitFor();
  await uploadedMessage.locator(".message-file-attachment").filter({ hasText: "clipboard-note.txt" }).waitFor();
  const uploadedImage = uploadedMessage.getByRole("button", { name: "查看图片 scene.png" });
  await uploadedImage.waitFor();
  await uploadedMessage.getByRole("button", { name: "查看图片 clipboard-scene.png" }).waitFor();
  assert.equal((await uploadedMessage.textContent()).includes("uploads/scene.png"), false);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-user-image-thumbnail.png"));
  await uploadedImage.click();
  await page.locator("#chatImageDialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#chatImagePreview")?.naturalWidth > 0);
  assert.match(await page.locator("#chatImageDownloadBtn").getAttribute("href"), /scene\.png.*disposition=attachment/);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-user-image-preview.png"));
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await page.locator("#chatImageDialog").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#attachmentQueue").isHidden(), true);
  await page.locator("#status").filter({ hasText: "已完成" }).waitFor();
  assert.equal(browserWorldModelRequests.length - worldModelRequestStart, 2);
  assert.equal(browserWorldModelResponses.length, 0);
  kernel.patchModelApiConfig({ enabled: false });
  assert.equal(await page.locator("#messages .message-row.assistant").count(), 0);
  const worldSceneTurn = page.locator("#messages .world-scene-turn").last();
  await worldSceneTurn.filter({ hasText: "雨后的日光" }).filter({ hasText: "林澈" }).filter({ hasText: "顾遥" }).waitFor();
  assert.equal(await worldSceneTurn.locator(".world-scene-fragment").count(), 1);
  assert.equal(await worldSceneTurn.locator(".world-scene-mini-avatar").count(), 2);
  await page.locator("#conversationScene").filter({ hasText: "进行中 · 河岸散步" }).waitFor();
  await page.getByRole("button", { name: "场景信息" }).click();
  await page.locator("#sceneInfoDialog").waitFor({ state: "visible" });
  await page.locator("#sceneInfoContent").filter({ hasText: "河岸散步" }).filter({ hasText: "决定接下来去哪里" }).filter({ hasText: "林澈、顾遥" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "编辑场景", exact: true }).isHidden(), true);
  await captureValidatedScreenshot(page, resolve(outputDir, "world-event-info.png"));
  await page.getByRole("button", { name: "关闭场景信息" }).click();
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "world-event-active.png"));
  await page.getByRole("button", { name: "场景信息" }).click();
  await page.getByRole("button", { name: "结束并结算", exact: true }).click();
  await page.locator("#status").filter({ hasText: "事件已结束并结算" }).waitFor();
  await page.locator("#sceneInfoContent").filter({ hasText: "已结束" }).filter({ hasText: "结算 2 位角色" }).waitFor();
  const settledWorldEvent = kernel.getWorldConversation(sourceLife.world.id).events[0];
  assert.equal(settledWorldEvent?.status, "resolved");
  assert.ok(settledWorldEvent?.settledAt);
  assert.equal(kernel.searchRpMemories({
    characterId: sourceCharacter.id,
    type: "plot_event",
    confirmedOnly: true,
  }).some((entry) => entry.key === `world.event.${settledWorldEvent.id}.settlement`), true);
  await captureValidatedScreenshot(page, resolve(outputDir, "world-event-settled.png"));
  await page.getByRole("button", { name: "关闭场景信息" }).click();
  await page.getByRole("button", { name: "角色", exact: true }).click();
  const populatedWorldCard = page.locator("#worldCardGrid .world-card").filter({ hasText: "青岚市" }).filter({ hasText: "2 位角色" });
  await populatedWorldCard.waitFor();
  assert.equal(await populatedWorldCard.locator(".group-avatar-cluster > span").count(), 2);
  await populatedWorldCard.scrollIntoViewIfNeeded();
  await captureValidatedScreenshot(page, resolve(outputDir, "characters-world-card-members.png"));
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.locator("#conversationMode").filter({ hasText: "世界演绎 · 2 位角色" }).waitFor();

  const characterId = sourceCharacter.id;
  await page.locator(`#conversationList .conversation-item[data-session-id="${smsSessionId}"]`).click();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "归档会话" }).waitFor({ state: "visible" });
  await page.waitForFunction(() => document.activeElement?.id === "confirmSessionActionBtn");
  await page.locator("#closeSessionActionBtn").focus();
  await page.keyboard.press("Shift+Tab");
  await page.waitForFunction(() => document.activeElement?.id === "confirmSessionActionBtn");
  await page.keyboard.press("Tab");
  await page.waitForFunction(() => document.activeElement?.id === "closeSessionActionBtn");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sessionActionsMenuBtn");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.id === "confirmSessionActionBtn");
  await page.keyboard.press("Enter");
  await page.locator(`#sessionSelect option[value="${smsSessionId}"]`).waitFor({ state: "detached" });
  await page.locator("#conversationMode").filter({ hasText: "世界演绎 · 2 位角色" }).waitFor();
  assert.equal(await page.locator("#conversationScene").isHidden(), true);
  await page.locator("#messages .world-scene-turn").filter({ hasText: "林澈" }).filter({ hasText: "顾遥" }).waitFor();
  const archivedSessions = await page.evaluate(async () => {
    const response = await fetch("/api/v1/sessions?includeArchived=1");
    return (await response.json()).sessions;
  });
  assert.ok(archivedSessions.some((session) => session.id === smsSessionId && session.archivedAt));
  await captureValidatedScreenshot(page, resolve(outputDir, "session-archived-safe-switch.png"));

  await page.locator("#sidebarArchivedSessionsBtn").click();
  const archivedSmsRow = page.locator("#archivedSessionList .archived-row").filter({ hasText: "日常私聊" });
  await archivedSmsRow.waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "session-archive-list.png"));
  await archivedSmsRow.getByRole("button", { name: "恢复会话" }).click();
  await page.waitForFunction((expected) => document.querySelector("#sessionSelect")?.value === expected, smsSessionId);
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();

  const markdownReply = "## 进度测试完成\n\n- 支持 **Markdown** 列表\n- 支持 `行内代码`\n\n```js\nconst ready = true;\n```\n\n![角色发送的图片](workspace:uploads/scene.png)\n\n![越界图片](workspace:../secret.png)\n\n[安全链接](https://example.test)<script>window.markdownUnsafe = true</script>";
  const unreadObserverSession = await kernel.openCanonicalPrivateConversation(targetCharacter.id);
  const unreadObserverSessionId = unreadObserverSession.id;
  await page.evaluate(() => window.loadSessions());
  const directMessagesRoute = "**/api/v1/sessions/" + smsSessionId + "/messages**";
  await page.route(directMessagesRoute, (route) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify([
      { role: "user", content: [{ type: "text", text: "检查执行过程" }] },
      { role: "assistant", content: [{ type: "text", text: markdownReply }], turnStatus: "completed", canRetry: false },
      { role: "toolResult", content: [{ type: "text", text: "read · completed" }] },
    ]),
  }));
  await page.locator('#conversationList [data-session-id="' + smsSessionId + '"]').click();
  const storedProgress = page.locator("#messages .bubble.assistant").last().locator(".message-progress");
  await storedProgress.filter({ hasText: "已完成" }).waitFor();
  const desktopCharacterAvatar = page.locator("#messages .message-row.assistant .character-profile-trigger").last();
  await desktopCharacterAvatar.click();
  await page.locator("#characterProfileDialog").waitFor({ state: "visible" });
  await page.locator("#characterProfileName").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#characterProfileSoul").filter({ hasText: "长期信任" }).waitFor();
  assert.equal(await page.locator("#characterProfileAbout input, #characterProfileAbout textarea, #characterProfileAbout select").count(), 0);
  await captureValidatedScreenshot(page, resolve(outputDir, "character-profile-readonly.png"));
  await page.getByRole("button", { name: "关闭角色资料" }).click();
  const storedToolResult = storedProgress.locator(".progress-tool-result").filter({ hasText: "read · completed" });
  await storedToolResult.waitFor({ state: "attached" });
  assert.equal(await page.locator("#messages .bubble.tool").count(), 0);
  await page.locator("#textInput").fill("检查执行过程");
  kernel.patchModelApiConfig({
    enabled: true,
    baseUrl: "http://test.invalid/v1",
    model: "scripted-model",
  });
  browserRuntime.model.enqueue([
    { kind: "tool_call", name: "read", arguments: { path: "uploads/scene-note.txt" } },
    { kind: "assistant_text", text: markdownReply, thinking: "先核对工具结果，再组织最终回复。", delayMs: 1_500 },
  ]);
  const liveModelRequestStart = browserRuntime.model.requests.length;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), false);
  await page.locator("#messages .message-row.user").last().locator(".meta").filter({ hasText: "未读" }).waitFor();
  await page.locator("#textInput").fill("再补充工具结果。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator("#textInput").fill("最后一起回答。");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator("#messages .message-row.user").filter({ hasText: "再补充工具结果" }).waitFor();
  await page.locator("#messages .message-row.user").filter({ hasText: "最后一起回答" }).waitFor();
  const liveProgress = page.locator("#messages .bubble.assistant").last().locator(".message-progress");
  await liveProgress.filter({ hasText: "正在输入" }).waitFor({ timeout: 10_000 });
  assert.equal(await liveProgress.getAttribute("open"), null);
  assert.equal(await liveProgress.locator(".typing-dot").count(), 3);
  assert.equal(await liveProgress.locator(".progress-list").isHidden(), true);
  assert.match(
    await liveProgress.locator(".typing-dot").first().evaluate((element) => getComputedStyle(element).animationName),
    /message-typing-dot/,
  );
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-typing-indicator.png"));
  await liveProgress.locator(":scope > summary").click();
  assert.equal(await liveProgress.getAttribute("open"), "");
  const completedProgress = page.locator("#messages .bubble.assistant").last();
  await completedProgress.filter({ hasText: "进度测试完成" }).waitFor();
  await completedProgress.locator(".message-progress").filter({ hasText: "已完成" }).waitFor();
  const liveModelRequests = browserRuntime.model.requests.slice(liveModelRequestStart);
  assert.equal(liveModelRequests.length, 2);
  const liveProviderContext = JSON.stringify(liveModelRequests.at(-1)?.messages || []);
  assert.match(liveProviderContext, /检查执行过程/);
  assert.match(liveProviderContext, /再补充工具结果/);
  assert.match(liveProviderContext, /最后一起回答/);
  assert.equal((await completedProgress.locator(".message-progress > summary").innerText()).trim(), "已完成");
  assert.doesNotMatch(await completedProgress.locator(".message-progress > summary").innerText(), /执行过程/);
  assert.equal(await completedProgress.locator(".message-progress").getAttribute("open"), "");
  await completedProgress.locator(".message-progress > summary").click();
  assert.equal(await completedProgress.locator(".message-progress").getAttribute("open"), null);
  await completedProgress.locator(".message-progress > summary").click();
  await completedProgress.getByText("模型推理", { exact: true }).waitFor();
  await completedProgress.getByText("调用工具：读取文件", { exact: true }).waitFor();
  await completedProgress.getByText("回复完成", { exact: true }).waitFor();
  await completedProgress.locator(".markdown-body h2").filter({ hasText: "进度测试完成" }).waitFor();
  await completedProgress.locator(".markdown-body strong").filter({ hasText: "Markdown" }).waitFor();
  await completedProgress.locator(".markdown-body pre code").filter({ hasText: "const ready = true;" }).waitFor();
  const markdownLink = completedProgress.locator('.markdown-body a[href="https://example.test"]');
  await markdownLink.waitFor();
  assert.equal(await markdownLink.getAttribute("target"), "_blank");
  assert.equal(await completedProgress.locator("script").count(), 0);
  assert.equal(await page.evaluate(() => window.markdownUnsafe), undefined);
  await completedProgress.getByText("[图片路径不可用]", { exact: true }).waitFor();
  assert.equal(await completedProgress.getByRole("button", { name: "查看图片 越界图片" }).count(), 0);
  const agentImage = completedProgress.getByRole("button", { name: "查看图片 角色发送的图片" });
  await agentImage.waitFor();
  await agentImage.click();
  await page.locator("#chatImageDialog").waitFor({ state: "visible" });
  await page.locator("#chatImageTitle").filter({ hasText: "角色发送的图片" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-agent-image-preview.png"));
  await page.keyboard.press("Escape");
  await page.locator("#chatImageDialog").waitFor({ state: "hidden" });
  const toolResult = completedProgress.locator("details.progress-tool-result");
  await toolResult.waitFor();
  assert.equal(await toolResult.getAttribute("open"), null);
  const expandedToolResult = await toolResult.evaluate((details) => {
    details.open = true;
    return { open: details.open, text: details.textContent || "" };
  });
  assert.equal(expandedToolResult.open, true);
  assert.match(expandedToolResult.text, /river scene/);
  assert.equal(await page.locator("#messages .bubble.tool").count(), 0);
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-execution-progress.png"));

  await page.evaluate(async () => {
    const canonical = [...state.messages].reverse().find((message) =>
      message.role === "assistant" && String(message.text || "").includes("进度测试完成")
    );
    if (!canonical) throw new Error("completed assistant message is missing");
    const staleIndex = ensurePrivateBurstMessage("missed-completion-regression", new Date().toISOString());
    Object.assign(state.messages[staleIndex], {
      text: canonical.text,
      working: true,
      progress: [{ key: "generation", label: "生成回复", status: "active" }]
    });
    renderMessages();
    await handlePrivateInboxEvent({
      type: "snapshot",
      inbox: { messages: [], running: false }
    });
  });
  assert.equal(await page.locator("#messages .message-progress").filter({ hasText: "正在输入" }).count(), 0);
  assert.doesNotMatch(await page.locator("#status").textContent(), /正在输入/);
  await page.locator("#messages .bubble.assistant").filter({ hasText: "进度测试完成" }).waitFor();

  browserRuntime.model.enqueue([
    { kind: "assistant_text", text: "这条回复会在你离开当前会话后完成。", thinking: "先完整理解，再发送回复。", delayMs: 2_000 },
  ]);
  await page.locator("#textInput").fill("生成时我会切到另一会话");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const backgroundProgress = page.locator("#messages .bubble.assistant").last().locator(".message-progress");
  await backgroundProgress.filter({ hasText: "正在输入" }).waitFor({ timeout: 10_000 });
  await page.locator(`#conversationList .conversation-item[data-session-id="${unreadObserverSessionId}"]`).click();
  const backgroundReplyBadge = page.locator(`#conversationList .conversation-item[data-session-id="${smsSessionId}"] .conversation-unread`);
  await backgroundReplyBadge.waitFor({ timeout: 10_000 });
  assert.equal(await backgroundReplyBadge.textContent(), "1");
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-unread-background-reply.png"));
  await page.locator(`#conversationList .conversation-item[data-session-id="${smsSessionId}"]`).click();
  await backgroundReplyBadge.waitFor({ state: "detached" });

  kernel.patchModelApiConfig({ enabled: false });
  await page.unroute(directMessagesRoute);
  const sourcePrivateSessions = kernel.listConversationMetadata().filter((entry) =>
    entry.mode === "sms" && entry.characterId === sourceCharacter.id && !entry.archivedAt
  );
  assert.equal(sourcePrivateSessions.length, 1);
  assert.equal(sourcePrivateSessions[0].id, smsSessionId);
  const roleSection = page.locator('#conversationList [data-conversation-group="__roles__"]');
  await roleSection.locator(".conversation-group-head").filter({ hasText: "2 个私聊" }).waitFor();
  await roleSection.locator("button[data-conversation-group-toggle]").click();
  assert.equal(await roleSection.locator(".conversation-group-sessions").isHidden(), true);
  await roleSection.locator("button[data-conversation-group-toggle]").click();
  await roleSection.locator(".conversation-group-sessions").waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "conversation-world-role-hierarchy.png"));

  const contactRequest = kernel.worldCoordinator.requestCharacterContact({
    sourceCharacterId: sourceCharacter.id,
    targetCharacterId: targetCharacter.id,
    sourceSessionId: kernel.sessionRuntime.getCanonicalDirectConversation(sourceCharacter.id)?.id || "browser-source-contact",
    requestText: "用户希望你方便时主动联系他。",
    idempotencyKey: "browser-character-contact",
  });
  assert.equal(contactRequest.accepted, true);
  assert.equal((await kernel.tickWorldAutonomy(targetCharacter.id)).delivered, 1);
  const targetConversationItem = page.locator(`#conversationList .conversation-item[data-session-id="${unreadObserverSessionId}"]`);
  await targetConversationItem.locator(".conversation-unread").waitFor();
  await roleSection.locator(".conversation-group-head .conversation-unread").waitFor();
  assert.equal(await roleSection.locator(".conversation-group-head .conversation-unread").textContent(), "1");
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-unread-contact.png"));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#conversationListToggle").click();
  await page.waitForFunction(() => document.querySelector("#chatWorkspace")?.classList.contains("list-open"));
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-chat-unread-contact.png"));
  await page.locator("#conversationListToggle").click();
  await page.waitForFunction(() => !document.querySelector("#chatWorkspace")?.classList.contains("list-open"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await targetConversationItem.click();
  await page.locator("#messages .message-row.assistant").filter({ hasText: "林澈说你在找我" }).waitFor();
  await targetConversationItem.locator(".conversation-unread").waitFor({ state: "detached" });
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-contact-delivered.png"));
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  await page.locator("#confirmSessionActionBtn").click();
  await targetConversationItem.waitFor({ state: "detached" });
  await page.locator(`#conversationList .conversation-item[data-session-id="${smsSessionId}"]`).click();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("button", { name: "能力模块", exact: true }).click();
  const tavilyModule = page.locator(".module-row").filter({ hasText: "Tavily Search MCP" });
  const visionModule = page.locator(".module-row").filter({ hasText: "Vision MCP" });
  const subagentModule = page.locator(".module-row").filter({ hasText: "Subagent Delegation MCP" });
  const relationshipModule = page.locator(".module-row").filter({ hasText: "Relationship State MCP" });
  await subagentModule.getByRole("button", { name: "查看 Subagent Delegation MCP 详情" }).click();
  await page.locator("#moduleDetailContent").filter({ hasText: "delegate_task" }).filter({ hasText: "four tasks" }).waitFor();
  await page.locator("#subagentSettingsForm").waitFor({ state: "visible" });
  assert.equal(await page.locator("#subagentMaxConcurrentTasks").inputValue(), "4");
  assert.equal(await page.locator("#subagentMaxWorkModelCalls").inputValue(), "32");
  assert.equal(await page.locator("#subagentMaxOutputTokens").inputValue(), "16384");
  assert.equal(await page.locator("#subagentMaxResultCharacters").inputValue(), "64000");
  assert.equal(await page.locator("#subagentTimeoutSeconds").inputValue(), "1800");
  await page.locator("#subagentSettingsRuntime").filter({ hasText: "第 33 轮" }).filter({ hasText: "1830 秒" }).waitFor();
  await page.locator("#subagentSettingsForm").filter({ hasText: "多路并发结果共享当前父回合" }).waitFor();
  await page.locator("#subagentMaxConcurrentTasks").fill("5");
  await page.locator("#subagentMaxWorkModelCalls").fill("33");
  await page.locator("#subagentMaxOutputTokens").fill("20000");
  await page.locator("#subagentMaxResultCharacters").fill("70000");
  await page.locator("#subagentTimeoutSeconds").fill("1900");
  await page.getByRole("button", { name: "保存任务预算", exact: true }).click();
  await page.locator("#subagentSettingsState").filter({ hasText: "已保存" }).waitFor();
  await page.locator("#subagentSettingsRuntime").filter({ hasText: "第 34 轮" }).filter({ hasText: "1930 秒" }).waitFor();
  assert.equal(await page.locator("#subagentMaxConcurrentTasks").inputValue(), "5");
  assert.equal(await page.locator("#subagentMaxWorkModelCalls").inputValue(), "33");
  await captureValidatedScreenshot(page, resolve(outputDir, "management-subagent-settings.png"));
  await page.getByRole("button", { name: "关闭模块详情" }).click();
  await subagentModule.getByRole("button", { name: "查看 Subagent Delegation MCP 详情" }).click();
  await page.locator("#subagentSettingsForm").waitFor({ state: "visible" });
  assert.equal(await page.locator("#subagentMaxConcurrentTasks").inputValue(), "5");
  assert.equal(await page.locator("#subagentTimeoutSeconds").inputValue(), "1900");
  await page.getByRole("button", { name: "关闭模块详情" }).click();
  await relationshipModule.getByRole("button", { name: "查看 Relationship State MCP 详情" }).click();
  await page.locator("#moduleDetailContent").filter({ hasText: "get_relationship_state" }).filter({ hasText: "bounded changes" }).waitFor();
  await page.getByRole("button", { name: "关闭模块详情" }).click();
  await relationshipModule.locator('input[type="checkbox"]').check();
  await relationshipModule.getByText("已启用", { exact: true }).waitFor();
  await visionModule.getByRole("button", { name: "查看 Vision MCP 详情" }).click();
  await page.locator("#moduleDetailContent").filter({ hasText: "analyze_image" }).waitFor();
  await page.getByRole("button", { name: "关闭模块详情" }).click();
  await visionModule.locator('input[type="checkbox"]').check();
  await visionModule.getByText("已启用", { exact: true }).waitFor();
  await tavilyModule.getByRole("button", { name: "查看 Tavily Search MCP 详情" }).click();
  await page.locator("#moduleDetailDialog").waitFor({ state: "visible" });
  await page.locator("#moduleDetailContent").filter({ hasText: "tavily_search" }).waitFor();
  await page.getByRole("button", { name: "关闭模块详情" }).click();
  await tavilyModule.locator('input[type="checkbox"]').check();
  await tavilyModule.getByText("已启用", { exact: true }).waitFor();
  await page.screenshot({ path: resolve(outputDir, "management-tavily-enabled.png"), fullPage: false });
  await page.getByRole("button", { name: "聊天", exact: true }).click();

  await page.getByRole("button", { name: "Debug", exact: true }).click();
  await page.getByRole("tab", { name: "主动决策", exact: true }).click();
  await page.locator("#initiativeDebugPanel").waitFor({ state: "visible" });
  await page.locator("#initiativeDebugList .initiative-debug-row").filter({ hasText: "已发送" }).filter({ hasText: "有帮助" }).waitFor();
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "debug-initiative.png"));
  await page.getByRole("tab", { name: "功能测试", exact: true }).click();
  await page.locator("#featureTestPanel").waitFor({ state: "visible" });
  assert.ok(await page.locator("#featureTestList input[data-feature-test]").count() >= 10);
  assert.ok(await page.locator("#featureTestTargetModel").inputValue());
  assert.ok(await page.locator("#featureTestTargetModel option").count() >= 2);
  assert.ok(await page.locator("#featureTestJudgeModel option").count() >= 2);
  assert.equal(
    await page.locator("#featureTestJudgeModel").inputValue(),
    await page.locator("#featureTestTargetModel").inputValue(),
  );
  await assertPanelInsideMain(page, "#featureTestPanel");
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "debug-model-adaptation.png"));
  await page.getByRole("tab", { name: "任务测试台", exact: true }).click();
  await page.locator("#taskBenchPanel").waitFor({ state: "visible" });
  assert.equal(await page.locator("#taskBenchTargetMode").inputValue(), "character");
  assert.ok(await page.locator("#taskBenchCharacter").inputValue());
  assert.ok(await page.locator("#taskBenchTargetModel").inputValue());
  assert.ok(await page.locator("#taskBenchJudgeModel option").count() >= 2);
  assert.equal(
    await page.locator("#taskBenchJudgeModel").inputValue(),
    await page.locator("#taskBenchTargetModel").inputValue(),
  );
  assert.equal(await page.locator("#taskBenchTimeout").inputValue(), "1800");
  assert.equal(await page.locator("#taskBenchJudgeTimeout").inputValue(), "600");
  await page.locator("#taskBenchUploadInput").setInputFiles({
    name: "browser-evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("BROWSER_TASK_BENCH_EVIDENCE", "utf8"),
  });
  await page.locator("#taskBenchUploadList .task-bench-upload-item").filter({ hasText: "browser-evidence.txt" }).waitFor();
  await page.locator("#taskBenchUploadState").filter({ hasText: "1/1 个就绪" }).waitFor();
  await page.locator("#taskBenchTargetMode").selectOption("model");
  assert.equal(await page.locator("#taskBenchCharacter").isDisabled(), true);
  await page.locator("#taskBenchTargetMode").selectOption("character");
  assert.equal(await page.locator("#taskBenchCharacter").isEnabled(), true);
  await assertPanelInsideMain(page, "#taskBenchPanel");
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "debug-task-bench.png"));
  await page.locator("#taskBenchUploadList").getByRole("button", { name: "移除", exact: true }).click();
  await page.locator("#taskBenchUploadList .task-bench-upload-item").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "聊天", exact: true }).click();

  await page.screenshot({ path: resolve(outputDir, "desktop.png"), fullPage: false });
  await assertSocialTheme(page);
  assert.deepEqual(sessionConflicts, [], `session mismatch responses: ${sessionConflicts.join(" | ")}`);
  assert.deepEqual(errors, [], `desktop console errors: ${errors.join(" | ")}`);
  await page.close();
}

async function runMobileWorkflow(browser, baseUrl, outputDir) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const errors = collectErrors(page);
  const mobileMessagesRoute = /\/api\/v1\/sessions\/[^/]+\/messages(?:\?.*)?$/;
  await page.route(mobileMessagesRoute, (route) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify([
      { role: "user", content: [{ type: "text", text: "检查移动端工具结果" }] },
      { role: "assistant", content: [{ type: "text", text: "移动端执行详情已整理。\n\n![移动端角色图片](workspace:uploads/scene.png)" }], turnStatus: "completed" },
      {
        role: "toolResult",
        toolCallId: "mobile-tool",
        toolName: "list_workspace",
        content: [{ type: "text", text: "workspace/very-long-path/" + "result-segment-".repeat(12) }],
        isError: false,
      },
    ]),
  }));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(document.querySelector("#sessionSelect")?.value));
  await assertViewport(page);
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  const mobileSessionId = await page.locator("#sessionSelect").inputValue();
  assert.ok(mobileSessionId);
  await page.locator("#conversationCharacter").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
  const mobileContextBudgetButton = page.locator("#contextBudgetBtn");
  await mobileContextBudgetButton.waitFor({ state: "visible" });
  assert.equal((await mobileContextBudgetButton.textContent()).trim(), "");
  assert.equal(await mobileContextBudgetButton.locator(".context-budget-ring").isVisible(), true);
  assert.match(await mobileContextBudgetButton.getAttribute("title"), /上下文已用.*%/);
  await mobileContextBudgetButton.click();
  await page.locator("#contextBudgetDialog").waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#contextBudgetDialog");
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-context-budget.png"));
  await page.getByRole("button", { name: "关闭上下文余量" }).click();
  await page.locator("#conversationListToggle").click();
  await page.locator("#chatWorkspace").evaluate((element) => {
    if (!element.classList.contains("list-open")) throw new Error("mobile conversation list did not open");
  });
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-conversation-list.png"));
  await page.locator('#conversationList button[data-world-id]').filter({ hasText: "青岚市" }).click();
  await page.locator("#conversationMode").filter({ hasText: "世界演绎 · 2 位角色" }).waitFor();
  await page.locator("#messages .world-scene-turn").filter({ hasText: "林澈" }).filter({ hasText: "顾遥" }).waitFor();
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-world-story.png"));
  await page.locator("#conversationListToggle").click();
  await page.locator(`#conversationList .conversation-item[data-session-id="${mobileSessionId}"]`).click();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
  await page.locator("#conversationListToggle").click();
  await page.getByRole("button", { name: "批量管理会话" }).click();
  await page.getByRole("checkbox", { name: "选择全部角色会话" }).check();
  await page.locator("#conversationBatchCount").filter({ hasText: "已选 1 项" }).waitFor();
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-conversation-batch.png"));
  await page.getByRole("button", { name: "完成批量管理" }).click();
  const activeConversation = page.locator("#conversationList .conversation-item.active");
  await activeConversation.locator(".conversation-copy").click();
  await page.waitForFunction(() => !document.querySelector("#chatWorkspace")?.classList.contains("list-open"));
  const mobileProgress = page.locator("#messages .message-row.assistant").last().locator(".message-progress");
  await assertSocialTheme(page);
  await mobileProgress.filter({ hasText: "已完成" }).waitFor();
  await mobileProgress.locator(":scope > summary").click();
  await mobileProgress.locator(".progress-tool-result > summary").click();
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-execution-progress.png"));
  const mobileAgentImage = page.getByRole("button", { name: "查看图片 移动端角色图片" });
  await mobileAgentImage.waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-chat-image-thumbnail.png"));
  await mobileAgentImage.click();
  await page.locator("#chatImageDialog").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#chatImagePreview")?.naturalWidth > 0);
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-chat-image-preview.png"));
  await page.getByRole("button", { name: "关闭图片预览" }).click();
  await mobileProgress.locator(":scope > summary").click();
  await page.unroute(mobileMessagesRoute);
  await page.locator("#conversationScene").filter({ hasText: "河岸书店" }).waitFor();
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-role-chat.png"));
  await page.locator("#messages .message-row.assistant .character-profile-trigger").last().click();
  await page.locator("#characterProfileDialog").waitFor({ state: "visible" });
  await page.locator("#characterProfileName").filter({ hasText: "林澈" }).waitFor();
  assert.equal(await page.locator("#characterProfileAbout input, #characterProfileAbout textarea, #characterProfileAbout select").count(), 0);
  await assertElementUnclipped(page, "#characterProfileDialog");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-character-profile-readonly.png"));
  await page.getByRole("button", { name: "关闭角色资料" }).click();
  await page.getByRole("button", { name: "选择表情", exact: true }).click();
  await page.locator("#emojiPicker").waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#emojiPicker");
  await page.getByRole("tab", { name: "手势与人物", exact: true }).click();
  await page.getByRole("button", { name: "插入表情 🫶", exact: true }).click();
  assert.equal(await page.locator("#textInput").inputValue(), "🫶");
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-emoji-picker.png"));
  await page.keyboard.press("Escape");
  await page.locator("#emojiPicker").waitFor({ state: "hidden" });
  await page.locator("#textInput").fill("");
  assert.equal(await page.locator("#modeSelect").isDisabled(), true);
  assert.equal(await page.locator("#chatCharacterSelect").isDisabled(), true);
  await page.locator("#textInput").focus();
  await page.setViewportSize({ width: 390, height: 520 });
  await page.waitForFunction(() => document.body.classList.contains("keyboard-open"));
  const mobileKeyboardLayout = await page.evaluate(() => {
    const viewport = window.visualViewport;
    const app = document.querySelector(".app")?.getBoundingClientRect();
    const composer = document.querySelector("#composer")?.getBoundingClientRect();
    const messages = document.querySelector("#messages")?.getBoundingClientRect();
    const mobileNav = document.querySelector(".header-left");
    const input = document.querySelector("#textInput");
    return {
      viewportBottom: (viewport?.offsetTop || 0) + (viewport?.height || window.innerHeight),
      appBottom: app?.bottom || 0,
      composerBottom: composer?.bottom || 0,
      messagesHeight: messages?.height || 0,
      navVisible: mobileNav ? getComputedStyle(mobileNav).visibility !== "hidden" : true,
      inputFontSize: input ? getComputedStyle(input).fontSize : "",
    };
  });
  assert.equal(mobileKeyboardLayout.navVisible, false);
  assert.equal(mobileKeyboardLayout.inputFontSize, "16px");
  assert.ok(mobileKeyboardLayout.messagesHeight > 80);
  assert.ok(mobileKeyboardLayout.appBottom <= mobileKeyboardLayout.viewportBottom + 1);
  assert.ok(mobileKeyboardLayout.composerBottom <= mobileKeyboardLayout.viewportBottom + 1);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-keyboard-composer.png"));
  await page.locator("#textInput").evaluate((element) => element.blur());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(() => !document.body.classList.contains("keyboard-open"));
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menu").waitFor({ state: "visible" });
  await page.getByRole("menuitemcheckbox", { name: "进入私密模式", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitemcheckbox", { name: "进入无痕模式", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "永久删除会话", exact: true }).waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#sessionActionsMenu");
  await assertElementUnclipped(page, "#privateModeToggle");
  await assertElementUnclipped(page, "#incognitoModeToggle");
  await assertElementUnclipped(page, "#mobileRenameSessionBtn");
  await assertElementUnclipped(page, "#mobileArchiveSessionBtn");
  await assertElementUnclipped(page, "#mobileDeleteSessionBtn");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-session-management.png"));
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "会话列表" }).click();
  await page.locator("#sidebarArchivedSessionsBtn").click();
  await page.locator("#archivedSessionsDialog").waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#archivedSessionsDialog");
  await page.getByRole("button", { name: "关闭归档会话" }).click();
  await page.locator("#archivedSessionsDialog").waitFor({ state: "hidden" });
  await page.locator(`#conversationList .conversation-item[data-session-id="${mobileSessionId}"]`).click();
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "永久删除会话", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "永久删除会话" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sessionActionsMenuBtn");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
  await page.locator("#sessionActionDialog").waitFor({ state: "visible" });
  await page.locator("#sessionActionInput").fill("林澈私聊移动端");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sessionActionsMenuBtn");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "归档会话" }).waitFor({ state: "visible" });
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-action-dialog.png"));
  await page.keyboard.press("Escape");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sessionActionsMenuBtn");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menu").waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("button", { name: "会话操作" }).getAttribute("aria-expanded"), "false");

  await page.getByRole("button", { name: "会话列表" }).click();
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationCharacter").selectOption({ label: "林澈" });
  await page.getByRole("button", { name: "打开私聊", exact: true }).click();
  await page.locator("#textInput").fill("移动端会面状态测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator("#messages .message-row.system").filter({ hasText: "模型当前未启用" }).waitFor();
  await page.getByRole("button", { name: "发起见面", exact: true }).click();
  await page.locator("#sessionActionInput").fill("河岸书店");
  await page.getByRole("button", { name: "约好", exact: true }).click();
  const mobileMeetingEvent = page.locator("#messages .message-row.interaction").filter({ hasText: "约定在河岸书店见面" });
  await mobileMeetingEvent.waitFor();
  await mobileMeetingEvent.getByRole("button", { name: "我到了", exact: true }).click();
  await page.locator("#conversationMode").filter({ hasText: "现场" }).waitFor();
  await page.waitForFunction(() => document.querySelector("#interactionToggleBtn")?.disabled === false);
  assert.equal(await page.getByRole("button", { name: "结束现场", exact: true }).isEnabled(), true);
  await assertElementUnclipped(page, "#interactionToggleBtn");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-in-person-state.png"));
  await page.getByRole("button", { name: "结束现场", exact: true }).click();
  await page.locator("#confirmSessionActionBtn").click();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();

  await page.getByRole("button", { name: "Debug" }).click();
  await page.locator("#debugPane").waitFor({ state: "visible" });
  await page.locator("#mobileTraceSelect").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#mobileTraceSelect")?.options.length >= 1);
  await assertPanelInsideMain(page, "#debugPane");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  const mobileDebugLayout = await page.evaluate(() => {
    const header = document.querySelector(".header-right");
    const content = document.querySelector("#traceContent");
    const index = document.querySelector("#traceIndex");
    const selector = document.querySelector("#mobileTraceSelect");
    return {
      headerDisplay: header ? getComputedStyle(header).display : "missing",
      contentHeight: content?.getBoundingClientRect().height ?? 0,
      indexDisplay: index ? getComputedStyle(index).display : "missing",
      selectorDisplay: selector ? getComputedStyle(selector).display : "missing",
      selectorWidth: selector?.getBoundingClientRect().width ?? 0,
    };
  });
  assert.equal(mobileDebugLayout.headerDisplay, "none");
  assert.equal(mobileDebugLayout.indexDisplay, "none");
  assert.equal(mobileDebugLayout.selectorDisplay, "block");
  assert.ok(mobileDebugLayout.selectorWidth <= 374);
  assert.ok(mobileDebugLayout.contentHeight >= 400, JSON.stringify(mobileDebugLayout));
  await page.screenshot({ path: resolve(outputDir, "mobile-debug-trace.png"), fullPage: false });
  await page.getByRole("tab", { name: "Context Economics" }).click();
  await page.locator("#traceDetailTitle").filter({ hasText: "estimated tokens" }).waitFor();
  await page.locator("#traceContent").filter({ hasText: "Cache read" }).waitFor();
  await assertPanelInsideMain(page, "#debugPane");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-context-economics.png"), fullPage: false });
  await page.getByRole("tab", { name: "主动决策" }).click();
  await page.locator("#initiativeDebugPanel").waitFor({ state: "visible" });
  await page.locator("#initiativeDebugList .initiative-debug-row").first().waitFor();
  await assertPanelInsideMain(page, "#debugPane");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-debug-initiative.png"), fullPage: false });
  await page.getByRole("tab", { name: "功能测试", exact: true }).click();
  await page.locator("#featureTestPanel").waitFor({ state: "visible" });
  await page.locator("#featureTestTargetModel").waitFor({ state: "visible" });
  await assertPanelInsideMain(page, "#featureTestPanel");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-model-adaptation.png"));
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.locator("#managementPage").waitFor({ state: "visible" });
  await page.locator(".module-row").filter({ hasText: "Schedule MCP" }).waitFor();
  await page.locator("#permissionRuntime").filter({ hasText: "Bubblewrap 可用" }).waitFor();
  await assertPanelInsideMain(page, "#managementPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-management.png"), fullPage: false });
  await page.locator(".permission-section").scrollIntoViewIfNeeded();
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-management-permissions.png"), fullPage: false });
  await page.getByRole("button", { name: "用户画像", exact: true }).click();
  await page.locator("#profileMarkdown").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#profileMarkdown")?.value.includes("Vector"));
  const mobileProfile = await page.locator("#profileMarkdown").inputValue();
  assert.equal(await page.locator("#profileCharacterCount").textContent(), `${[...mobileProfile].length} / 2000`);
  await assertPanelInsideMain(page, "#managementPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-management-profile.png"), fullPage: false });
  const mobileProfileInsight = page.locator("#userInsightList .user-insight-row").filter({ hasText: "浏览器每周复盘" });
  await mobileProfileInsight.waitFor();
  await mobileProfileInsight.scrollIntoViewIfNeeded();
  await mobileProfileInsight.filter({ hasText: "已写入画像" }).waitFor();
  await assertPanelInsideMain(page, "#managementPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-management-profile-insights.png"), fullPage: false });
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await page.locator("#memoryManagementPanel").waitFor({ state: "visible" });
  await page.locator("#managedMemoryList").filter({ hasText: "浏览器待确认现实偏好" }).waitFor();
  await assertPanelInsideMain(page, "#managementPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-management-memory.png"), fullPage: false });
  await page.getByRole("button", { name: "日程", exact: true }).click();
  await page.locator("#schedulePage").waitFor({ state: "visible" });
  await page.locator("#scheduleAgendaViewBtn").waitFor({ state: "visible" });
  await page.locator("#scheduleState").filter({ hasText: /\d+ 项/ }).waitFor();
  await page.screenshot({ path: resolve(outputDir, "mobile-schedule-agenda.png"), fullPage: false });
  await page.locator("#scheduleCalendarViewBtn").click();
  await page.locator("#scheduleCalendar .calendar-day").first().waitFor({ state: "visible" });
  assert.equal(await page.locator("#scheduleCalendar .calendar-day").count(), 42);
  await assertPanelInsideMain(page, "#schedulePage");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-schedule-calendar.png"), fullPage: false });
  await assertCalendarNavigation(page);
  await page.getByRole("tab", { name: "角色日程", exact: true }).click();
  await page.locator("#scheduleCharacterSelect").selectOption({ label: "林澈" });
  await page.locator("#scheduleCalendarViewBtn").click();
  await page.locator("#scheduleCalendar .calendar-event").filter({ hasText: "傍晚去河岸" }).waitFor({ state: "visible" });
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-schedule-character.png"), fullPage: false });
  await page.locator("#scheduleCreateBtn").click();
  await page.locator("#scheduleEditorDialog").waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-schedule-editor-character.png"));
  await page.keyboard.press("Escape");
  await page.locator("#scheduleEditorDialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.locator("#charactersPage").waitFor({ state: "visible" });
  const mobileCharacterCard = page.locator("#characterCardGrid .character-card").filter({ hasText: "林澈" });
  await mobileCharacterCard.waitFor();
  await mobileCharacterCard.filter({ hasText: "个会话" }).waitFor();
  assert.equal(await page.locator("#characterDetail").isHidden(), true);
  await mobileCharacterCard.click();
  await page.locator("#characterDetail").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.querySelector("#characterSoulMarkdown")?.value.includes("长期信任"));
  const mobileSoul = await page.locator("#characterSoulMarkdown").inputValue();
  assert.equal(await page.locator("#characterSoulCount").textContent(), `${[...mobileSoul].length} / 8000`);
  await page.getByRole("tab", { name: "协作与技能", exact: true }).click();
  await page.locator("#characterFunctionRole").filter({ hasText: "研究与规划负责人" }).waitFor();
  await page.locator("#characterOwnedSkillMarkdown").filter({ hasText: "工作方法" }).waitFor();
  await assertPanelInsideMain(page, "#charactersPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-character-skill.png"), fullPage: false });
  await page.locator("#characterFunctionAdvanced > summary").click();
  await page.locator("#characterPublicRole").waitFor({ state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector("#characterPublicRole")?.value === "研究与规划负责人");
  assert.equal(await page.locator("#characterPublicRole").inputValue(), "研究与规划负责人");
  await page.locator("#characterTaskPreferences").waitFor();
  assert.equal(await page.locator("#characterTaskPreferences").inputValue(), "严谨, 重视来源, 结果可验证");
  await assertPanelInsideMain(page, "#charactersPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-character-capabilities.png"), fullPage: false });
  await page.getByRole("tab", { name: "关系", exact: true }).click();
  await page.locator("#relationshipOverview").filter({ hasText: "初识" }).waitFor();
  await page.locator("#relationshipOverview").filter({ hasText: "尚未建立浪漫关系" }).waitFor();
  assert.equal(await page.locator("#relationshipOverview .relationship-metric").count(), 3);
  await page.getByRole("tab", { name: "生活", exact: true }).click();
  await page.locator("#characterLifeContent").waitFor({ state: "visible" });
  await page.locator("#lifeCurrentPlace").filter({ hasText: "河岸书店" }).waitFor();
  await page.locator("#lifeEventList .life-event-row").first().waitFor();
  await assertPanelInsideMain(page, "#charactersPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-character-life.png"), fullPage: false });
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "视觉", exact: true }).click();
  await page.locator("#visionSettingsState").filter({ hasText: "Key: visi...cret" }).waitFor();
  await page.locator("#visionBaseUrl").scrollIntoViewIfNeeded();
  await assertPanelInsideMain(page, "#settingsPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-settings-vision.png"), fullPage: false });
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await page.locator("#tavilySettingsState").filter({ hasText: "Key: tvly...cret" }).waitFor();
  await page.locator("#tavilyApiKey").scrollIntoViewIfNeeded();
  assert.equal(await page.locator("#tavilyApiKey").inputValue(), "");
  await assertPanelInsideMain(page, "#settingsPage");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-settings-tavily.png"), fullPage: false });
  await page.getByRole("button", { name: "清除 Key", exact: true }).last().click();
  await page.locator("#tavilySettingsState").filter({ hasText: "Key: 未设置" }).waitFor();
  await page.getByRole("button", { name: "清除代理", exact: true }).click();
  await page.locator("#tavilySettingsState").filter({ hasText: "代理: 直连" }).waitFor();
  await page.getByRole("button", { name: "数据", exact: true }).click();
  await page.locator("#memoryVaultHealth").scrollIntoViewIfNeeded();
  await page.locator("#memoryVaultWriter").filter({ hasText: "writer" }).waitFor();
  await assertVaultHealthBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "vault-health-mobile.png"), fullPage: false });
  await page.locator("#okfImportInput").setInputFiles({
    name: "browser-okf.zip",
    mimeType: "application/zip",
    buffer: okfBrowserZip,
  });
  await page.locator("#okfImportState").filter({ hasText: "校验通过" }).waitFor();
  await page.locator("#okfImportPreview").scrollIntoViewIfNeeded();
  await assertPanelInsideMain(page, "#settingsPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "settings-okf-mobile.png"), fullPage: false });
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "会话列表" }).click();
  const resetWorldButton = page.locator('#conversationList button[data-world-id]').filter({ hasText: "青岚市" });
  const resetWorldId = await resetWorldButton.getAttribute("data-world-id");
  assert.ok(resetWorldId);
  await resetWorldButton.click();
  await page.locator("#conversationMode").filter({ hasText: "世界演绎 · 2 位角色" }).waitFor();
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重置世界会话", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "重置世界会话" }).waitFor({ state: "visible" });
  await page.getByLabel("输入世界名称确认").fill("青岚市");
  await captureValidatedScreenshot(page, resolve(outputDir, "world-conversation-reset.png"));
  await page.getByRole("button", { name: "重置并开始新会话", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "已开始新的世界会话");
  await page.locator("#messages .chat-empty").filter({ hasText: "青岚市" }).waitFor();
  assert.deepEqual(kernel.listWorldConversationMessages(resetWorldId), []);
  assert.equal(kernel.getWorldConversation(resetWorldId).events.some((event) => event.status === "resolved"), true);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "数据", exact: true }).click();
  const deleteAllDataButton = page.getByRole("button", { name: "删除全部数据", exact: true });
  await deleteAllDataButton.click();
  await page.locator("#sessionActionDialog").filter({ hasText: "删除全部数据" }).waitFor({ state: "visible" });
  await page.locator("#sessionActionInput").fill("WRONG");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionError").filter({ hasText: "确认短语不匹配" }).waitFor();
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-delete-data-dialog.png"));
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "deleteDataBtn");
  await deleteAllDataButton.click();
  await page.locator("#sessionActionInput").fill("DELETE_ALL_DATA");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.querySelector("#status")?.textContent ===
    "用户数据已删除；普通与私密 Workspace 文件及已安装 Skill 包仍保留但已禁用");
  assert.deepEqual(errors, [], `mobile console errors: ${errors.join(" | ")}`);
  await page.close();
}

async function runCompactDesktopWorkflow(browser, baseUrl, outputDir) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = collectErrors(page);
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#normalBtn").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.locator("#header-right, .header-right").first().waitFor({ state: "visible" });
  await assertHeaderControlsDoNotOverlap(page);
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "compact-chat-header.png"));

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.locator("#charactersPage").waitFor({ state: "visible" });
  await assertStandardPageControls(page, "#charactersPage");
  assert.equal(await page.locator("#characterDetail").isHidden(), true);
  await page.locator("#characterCardGrid .character-card").filter({ hasText: "林澈" }).click();
  await page.locator("#characterDetail").waitFor({ state: "visible" });
  await assertPanelPadding(page, "#characterSettingsPanel", 14);
  await captureValidatedScreenshot(page, resolve(outputDir, "compact-characters.png"));

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.locator("#managementPage").waitFor({ state: "visible" });
  await assertStandardPageControls(page, "#managementPage");
  await assertPanelPadding(page, "#modulesPanel", 18);
  await captureValidatedScreenshot(page, resolve(outputDir, "compact-management.png"));

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.locator("#settingsPage").waitFor({ state: "visible" });
  await assertStandardPageControls(page, "#settingsPage");
  await assertPanelPadding(page, "#modelSettingsPanel", 16);
  await captureValidatedScreenshot(page, resolve(outputDir, "compact-settings.png"));
  assert.deepEqual(errors, [], `compact desktop console errors: ${errors.join(" | ")}`);
  await page.close();
}

async function assertSocialTheme(page) {
  const style = await page.evaluate(() => ({
    loaded: Boolean(document.querySelector("#yourchar-social-theme")),
    font: getComputedStyle(document.body).fontFamily,
    background: getComputedStyle(document.body).backgroundColor,
    rail: getComputedStyle(document.querySelector(".header-left")).backgroundColor,
    send: getComputedStyle(document.querySelector("#sendBtn")).backgroundColor,
    sendDisabled: document.querySelector("#sendBtn").disabled,
    inputSize: getComputedStyle(document.querySelector("#textInput")).fontSize,
    messageSizes: [...document.querySelectorAll(".bubble.assistant, .bubble.user")].map(element => getComputedStyle(element).fontSize),
    avatars: [...document.querySelectorAll(".message-avatar")].map(element => getComputedStyle(element).width),
  }));
  assert.equal(style.loaded, true);
  assert.match(style.font, /^system-ui,/);
  assert.equal(style.background, "rgb(245, 245, 245)");
  assert.equal(style.rail, page.viewportSize().width > 900 ? "rgb(237, 237, 237)" : "rgb(255, 255, 255)");
  assert.equal(style.inputSize, "16px");
  for (const size of style.messageSizes) assert.equal(size, "16px");
  for (const width of style.avatars) assert.ok(parseFloat(width) >= 36, width);
  assert.equal(style.send, style.sendDisabled ? "rgb(230, 230, 230)" : "rgb(26, 26, 26)");
}

async function assertCalendarNavigation(page) {
  const month = await page.locator("#scheduleMonthLabel").textContent();
  await page.locator("#scheduleNextMonthBtn").click();
  assert.notEqual(await page.locator("#scheduleMonthLabel").textContent(), month);
  await page.locator("#schedulePreviousMonthBtn").click();
  assert.equal(await page.locator("#scheduleMonthLabel").textContent(), month);
  assert.equal(await page.locator("#scheduleCalendar .calendar-day").count(), 42);
  const day = page.locator("#scheduleCalendar .calendar-day:not(.outside):not(.selected)").first();
  const date = await day.getAttribute("data-date");
  await day.click();
  assert.equal(await page.locator('#scheduleCalendar [aria-pressed="true"]').getAttribute("data-date"), date);
  if (page.viewportSize().width <= 900) {
    assert.equal(await page.locator("#schedulePage").getAttribute("data-mobile-view"), "agenda");
    await page.locator("#scheduleCalendarViewBtn").click();
  }
  await page.locator("#scheduleTodayBtn").click();
  assert.equal(await page.locator('#scheduleCalendar [aria-current="date"]').getAttribute("aria-pressed"), "true");
}

function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      const url = message.location().url;
      const path = url && /^https?:/.test(url) ? new URL(url).pathname : "";
      errors.push(message.text() + (path ? ` (${path})` : ""));
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function assertViewport(page) {
  const metrics = await page.evaluate(() => ({
    innerWidth,
    innerHeight,
    bodyWidth: document.body.getBoundingClientRect().width,
    bodyHeight: document.body.getBoundingClientRect().height,
    documentScrollWidth: document.documentElement.scrollWidth,
    documentScrollHeight: document.documentElement.scrollHeight,
  }));
  assert.equal(metrics.bodyWidth, metrics.innerWidth);
  assert.equal(metrics.bodyHeight, metrics.innerHeight);
  assert.ok(metrics.documentScrollWidth <= metrics.innerWidth, JSON.stringify(metrics));
  assert.ok(metrics.documentScrollHeight <= metrics.innerHeight, JSON.stringify(metrics));
}

async function assertPanelInsideMain(page, selector) {
  const boxes = await page.evaluate((panelSelector) => {
    const main = document.querySelector("#mainPane")?.getBoundingClientRect();
    const panel = document.querySelector(panelSelector)?.getBoundingClientRect();
    return { main: main && { top: main.top, bottom: main.bottom }, panel: panel && { top: panel.top, bottom: panel.bottom } };
  }, selector);
  assert.ok(boxes.main && boxes.panel);
  assert.ok(boxes.panel.top >= boxes.main.top - 1, JSON.stringify(boxes));
  assert.ok(boxes.panel.bottom <= boxes.main.bottom + 1, JSON.stringify(boxes));
}

async function assertVaultHealthBounds(page) {
  const metrics = await page.locator("#memoryVaultHealth").evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: style.overflowY,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  assert.equal(metrics.overflowY, "auto");
  assert.ok(metrics.clientHeight <= 164, JSON.stringify(metrics));
  assert.ok(metrics.scrollHeight > metrics.clientHeight, JSON.stringify(metrics));
  assert.ok(metrics.left >= -1 && metrics.right <= metrics.viewport.width + 1, JSON.stringify(metrics));
  assert.ok(metrics.top >= -1 && metrics.bottom <= metrics.viewport.height + 1, JSON.stringify(metrics));
}

async function assertInteractiveBounds(page) {
  const violations = await page.evaluate(() => [...document.querySelectorAll("button, input, select, textarea")]
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
    })
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { tag: element.tagName, id: element.id, left: box.left, right: box.right, top: box.top, bottom: box.bottom };
    })
    .filter((box) => box.left < -1 || box.right > innerWidth + 1));
  assert.deepEqual(violations, [], JSON.stringify(violations));
}

async function assertHeaderControlsDoNotOverlap(page) {
  const result = await page.evaluate(() => {
    const header = document.querySelector(".header-right")?.getBoundingClientRect();
    const selectors = [
      "#conversationListToggle",
      "#conversationHeaderAvatar",
      "#conversationCharacter",
      "#conversationMode",
      "#conversationScene",
      "#sceneInfoBtn",
      "#sessionActionsMenuBtn",
    ];
    const boxes = selectors.flatMap((selector) => {
      const element = document.querySelector(selector);
      if (!element || getComputedStyle(element).display === "none" || element.getClientRects().length === 0) return [];
      const box = element.getBoundingClientRect();
      return [{ selector, left: box.left, right: box.right, top: box.top, bottom: box.bottom }];
    });
    const overlaps = [];
    for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
        const left = boxes[leftIndex];
        const right = boxes[rightIndex];
        const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        if (width > 0.5 && height > 0.5) overlaps.push(`${left.selector} x ${right.selector}`);
      }
    }
    const outside = !header ? ["missing header"] : boxes
      .filter((box) => box.left < header.left - 1 || box.right > header.right + 1 || box.top < header.top - 1 || box.bottom > header.bottom + 1)
      .map((box) => box.selector);
    return { overlaps, outside, boxes };
  });
  assert.deepEqual(result.overlaps, [], JSON.stringify(result));
  assert.deepEqual(result.outside, [], JSON.stringify(result));
}

async function assertStandardPageControls(page, rootSelector) {
  const result = await page.evaluate((selector) => {
    const buttons = [...document.querySelectorAll(`${selector} .primary, ${selector} .secondary`)]
      .filter((element) => getComputedStyle(element).display !== "none" && element.getClientRects().length > 0)
      .map((element) => {
        const box = element.getBoundingClientRect();
        const icon = element.querySelector("svg")?.getBoundingClientRect();
        const label = element.querySelector("span")?.getBoundingClientRect();
        return {
          id: element.id,
          height: box.height,
          iconLabelOffset: icon && label ? Math.abs((icon.top + icon.height / 2) - (label.top + label.height / 2)) : 0,
        };
      });
    return {
      heights: buttons.filter((button) => Math.abs(button.height - 36) > 0.5),
      alignment: buttons.filter((button) => button.iconLabelOffset > 1),
    };
  }, rootSelector);
  assert.deepEqual(result.heights, [], JSON.stringify(result));
  assert.deepEqual(result.alignment, [], JSON.stringify(result));
}

async function assertPanelPadding(page, selector, minimum) {
  const padding = await page.locator(selector).first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: Number.parseFloat(style.paddingLeft), right: Number.parseFloat(style.paddingRight) };
  });
  assert.ok(padding.left >= minimum && padding.right >= minimum, JSON.stringify({ selector, padding }));
}

async function assertElementUnclipped(page, selector) {
  const geometry = await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const visible = {
      left: Math.max(0, bounds.left),
      top: Math.max(0, bounds.top),
      right: Math.min(innerWidth, bounds.right),
      bottom: Math.min(innerHeight, bounds.bottom),
    };
    const clippingAncestors = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      const clipsX = /^(auto|scroll|hidden|clip)$/.test(style.overflowX);
      const clipsY = /^(auto|scroll|hidden|clip)$/.test(style.overflowY);
      if (!clipsX && !clipsY) continue;
      const ancestorBounds = ancestor.getBoundingClientRect();
      clippingAncestors.push({
        tag: ancestor.tagName,
        id: ancestor.id,
        className: ancestor.className,
        overflowX: style.overflowX,
        overflowY: style.overflowY,
      });
      if (clipsX) {
        visible.left = Math.max(visible.left, ancestorBounds.left);
        visible.right = Math.min(visible.right, ancestorBounds.right);
      }
      if (clipsY) {
        visible.top = Math.max(visible.top, ancestorBounds.top);
        visible.bottom = Math.min(visible.bottom, ancestorBounds.bottom);
      }
    }
    return {
      bounds: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      visible,
      clippingAncestors,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  const tolerance = 1;
  assert.ok(geometry.bounds.left >= -tolerance, JSON.stringify(geometry));
  assert.ok(geometry.bounds.top >= -tolerance, JSON.stringify(geometry));
  assert.ok(geometry.bounds.right <= geometry.viewport.width + tolerance, JSON.stringify(geometry));
  assert.ok(geometry.bounds.bottom <= geometry.viewport.height + tolerance, JSON.stringify(geometry));
  assert.ok(geometry.visible.left <= geometry.bounds.left + tolerance, JSON.stringify(geometry));
  assert.ok(geometry.visible.top <= geometry.bounds.top + tolerance, JSON.stringify(geometry));
  assert.ok(geometry.visible.right >= geometry.bounds.right - tolerance, JSON.stringify(geometry));
  assert.ok(geometry.visible.bottom >= geometry.bounds.bottom - tolerance, JSON.stringify(geometry));
}

async function captureValidatedScreenshot(page, path) {
  await assertViewport(page);
  const viewport = page.viewportSize();
  assert.ok(viewport);
  const png = await page.screenshot({ path, fullPage: false });
  const metrics = await page.evaluate(async ({ dataUrl }) => {
    const image = new Image();
    await new Promise((resolvePromise, reject) => {
      image.onload = resolvePromise;
      image.onerror = reject;
      image.src = dataUrl;
    });
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sampled = 0;
    let dark = 0;
    let bright = 0;
    let minimum = 255;
    let maximum = 0;
    const buckets = new Set();
    for (let y = 0; y < canvas.height; y += 6) {
      for (let x = 0; x < canvas.width; x += 6) {
        const offset = (y * canvas.width + x) * 4;
        const luminance = Math.round(0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2]);
        sampled += 1;
        if (luminance < 8) dark += 1;
        if (luminance > 248) bright += 1;
        minimum = Math.min(minimum, luminance);
        maximum = Math.max(maximum, luminance);
        buckets.add(Math.floor(luminance / 8));
      }
    }
    let borderSamples = 0;
    let darkBorder = 0;
    const luminanceAt = (x, y) => {
      const offset = (y * canvas.width + x) * 4;
      return 0.2126 * pixels[offset] + 0.7152 * pixels[offset + 1] + 0.0722 * pixels[offset + 2];
    };
    const inspect = (x, y) => {
      const luminance = luminanceAt(x, y);
      borderSamples += 1;
      if (luminance < 18) darkBorder += 1;
    };
    for (let x = 0; x < canvas.width; x += 4) {
      inspect(x, 0);
      inspect(x, canvas.height - 1);
    }
    for (let y = 0; y < canvas.height; y += 4) {
      inspect(0, y);
      inspect(canvas.width - 1, y);
    }
    let maxBlackRowRun = 0;
    let blackRowRun = 0;
    for (let y = 0; y < canvas.height; y += 1) {
      let nearBlack = 0;
      let rowSamples = 0;
      for (let x = 0; x < canvas.width; x += 4) {
        rowSamples += 1;
        if (luminanceAt(x, y) < 18) nearBlack += 1;
      }
      blackRowRun = nearBlack / rowSamples > 0.98 ? blackRowRun + 1 : 0;
      maxBlackRowRun = Math.max(maxBlackRowRun, blackRowRun);
    }
    let maxBlackColumnRun = 0;
    let blackColumnRun = 0;
    for (let x = 0; x < canvas.width; x += 1) {
      let nearBlack = 0;
      let columnSamples = 0;
      for (let y = 0; y < canvas.height; y += 4) {
        columnSamples += 1;
        if (luminanceAt(x, y) < 18) nearBlack += 1;
      }
      blackColumnRun = nearBlack / columnSamples > 0.98 ? blackColumnRun + 1 : 0;
      maxBlackColumnRun = Math.max(maxBlackColumnRun, blackColumnRun);
    }
    let maxBlackBlockRatio = 0;
    const blockColumns = 8;
    const blockRows = 6;
    for (let blockY = 0; blockY < blockRows; blockY += 1) {
      for (let blockX = 0; blockX < blockColumns; blockX += 1) {
        const startX = Math.floor(blockX * canvas.width / blockColumns);
        const endX = Math.floor((blockX + 1) * canvas.width / blockColumns);
        const startY = Math.floor(blockY * canvas.height / blockRows);
        const endY = Math.floor((blockY + 1) * canvas.height / blockRows);
        let nearBlack = 0;
        let blockSamples = 0;
        for (let y = startY; y < endY; y += 4) {
          for (let x = startX; x < endX; x += 4) {
            blockSamples += 1;
            if (luminanceAt(x, y) < 18) nearBlack += 1;
          }
        }
        maxBlackBlockRatio = Math.max(maxBlackBlockRatio, nearBlack / blockSamples);
      }
    }
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      darkRatio: dark / sampled,
      brightRatio: bright / sampled,
      borderDarkRatio: darkBorder / borderSamples,
      contrast: maximum - minimum,
      bucketCount: buckets.size,
      corners: [
        luminanceAt(0, 0),
        luminanceAt(canvas.width - 1, 0),
        luminanceAt(0, canvas.height - 1),
        luminanceAt(canvas.width - 1, canvas.height - 1),
      ],
      maxBlackRowRun,
      maxBlackColumnRun,
      maxBlackBlockRatio,
    };
  }, { dataUrl: `data:image/png;base64,${Buffer.from(png).toString("base64")}` });
  assert.equal(metrics.width, viewport.width, JSON.stringify(metrics));
  assert.equal(metrics.height, viewport.height, JSON.stringify(metrics));
  assert.ok(metrics.darkRatio < 0.85, JSON.stringify(metrics));
  assert.ok(metrics.brightRatio < 0.97, JSON.stringify(metrics));
  assert.ok(metrics.borderDarkRatio < 0.75, JSON.stringify(metrics));
  assert.ok(metrics.contrast >= 40, JSON.stringify(metrics));
  assert.ok(metrics.bucketCount >= 6, JSON.stringify(metrics));
  assert.ok(metrics.corners.every((value) => value >= 18), JSON.stringify(metrics));
  assert.ok(metrics.maxBlackRowRun < 4, JSON.stringify(metrics));
  assert.ok(metrics.maxBlackColumnRun < 4, JSON.stringify(metrics));
  assert.ok(metrics.maxBlackBlockRatio < 0.95, JSON.stringify(metrics));
}

function localDateTimeInput(timestamp) {
  const date = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function writeChatCompletionStream(response, model, content) {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-browser-world",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-browser-world",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
