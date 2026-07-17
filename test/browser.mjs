import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch } from "cloakbrowser";
import { strToU8, zipSync } from "fflate";
import { CompanionKernel } from "../dist/src/domain/index.js";
import { createHttpServer } from "../dist/src/http/router.js";

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
const kernel = new CompanionKernel({ stateDir: browserStateDir, startScheduler: false });
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
    generatedAt: "2026-07-16T02:00:00.000Z",
    timezone: "Asia/Shanghai",
    query: null,
    queryHash: "browser-query-hash",
    bootstrapApplied: false,
    bootstrapAlreadyConsumed: true,
    budgets: { dynamicTokens: 900, memoryTokens: 360, realityMemoryTokens: 220, roleplayMemoryTokens: 220, sceneTokens: 220, realityItems: 3, roleplayItems: 3, bootstrapItems: 3 },
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
      { role: "system", content: "You are RP Agent.\n" + "Follow the complete system policy without omitting context.\n".repeat(12) },
      { role: "user", content: "帮我检查完整上下文" },
      { role: "assistant", content: "我会调用工具确认。", tool_calls: [{ id: "call-1", function: { name: "list_schedule_items", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "[]" },
    ],
    tools: [{ type: "function", function: { name: "list_schedule_items", description: "Return complete schedule state. ".repeat(12), parameters: { type: "object" } } }],
  },
});
const server = createHttpServer({ kernel });
await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await launch({ headless: true });

try {
  await runDesktopWorkflow(browser, baseUrl, artifactsDir);
  await runCompactDesktopWorkflow(browser, baseUrl, artifactsDir);
  await runMobileWorkflow(browser, baseUrl, artifactsDir);
  console.log(`Browser artifacts: ${artifactsDir}`);
} finally {
  await browser.close();
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  kernel.dispose();
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
  await page.goto(baseUrl, { waitUntil: "networkidle" });
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
  assert.equal(await page.locator(".trace-index-item").count(), 2);
  assert.equal(await page.locator(".trace-block.system").count(), 1);
  assert.equal(await page.locator(".trace-block.user").count(), 1);
  assert.equal(await page.locator(".trace-block.assistant").count(), 1);
  assert.equal(await page.locator(".trace-block.tool").count(), 1);
  assert.equal(await page.locator(".trace-block.schema").count(), 1);
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
  await planningModule.locator('input[type="checkbox"]').check();
  await planningModule.getByText("已启用", { exact: true }).waitFor();
  assert.equal(await page.locator(".module-row").count(), 9);
  await page.locator(".module-row").filter({ hasText: "Tavily Search MCP" }).waitFor();
  assert.equal(await page.locator(".module-token").count(), 9);
  await page.locator(".module-row").filter({ hasText: "Memory Coordinator MCP" }).locator(".module-token").filter({ hasText: "约 430 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Subagent Delegation MCP" }).locator(".module-token").filter({ hasText: "约 390 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Relationship State MCP" }).locator(".module-token").filter({ hasText: "约 230 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Tavily Search MCP" }).locator(".module-token").filter({ hasText: "约 350 tokens/轮" }).waitFor();
  await page.locator(".module-row").filter({ hasText: "Vision MCP" }).locator(".module-token").filter({ hasText: "约 420 tokens/轮" }).waitFor();
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
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "management-modules.png"), fullPage: false });

  await page.getByRole("button", { name: "用户画像", exact: true }).click();
  await page.locator("#profilePanel").waitFor({ state: "visible" });
  const profileMarkdown = "# 用户画像\n\n## 基本信息\n\n- 称呼：Vector\n\n## 偏好与沟通\n\n- 直接、简洁，先给结论\n\n## 当前目标\n\n- 保持规律作息\n- 持续改进 RP Agent";
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
  assert.equal(await page.locator("#relationshipOverview .relationship-metric").count(), 5);
  assert.deepEqual(
    await page.locator("#relationshipOverview .relationship-metric > strong").allTextContents(),
    ["35", "20", "25", "50", "5"],
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
  await page.route("**/api/v1/diagnostics/model/models?**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ models: ["browser-model-a", "browser-model-b"] }) });
  });
  await page.locator("#apiBaseUrl").fill("http://127.0.0.1:8317/v1");
  await page.getByRole("button", { name: "读取模型", exact: true }).click();
  await page.locator("#apiSettingsState").filter({ hasText: "2 个模型" }).waitFor();
  assert.deepEqual(await page.locator("#apiModel option").allTextContents(), ["读取模型后选择", "browser-model-a", "browser-model-b", "手动输入..."]);
  await page.locator("#apiModel").selectOption("browser-model-b");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await page.locator("#apiSettingsState").filter({ hasText: "已保存" }).waitFor();
  await page.unroute("**/api/v1/diagnostics/model/models?**");

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
  await page.getByRole("button", { name: "剧情演绎", exact: true }).last().click();
  assert.equal(await page.locator("#systemPromptCustom").inputValue(), "");
  await page.getByRole("button", { name: "角色私聊", exact: true }).last().click();
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
  await page.locator("#memoryVaultHealth").scrollIntoViewIfNeeded();
  await page.locator("#memoryVaultWriter").filter({ hasText: "writer" }).waitFor();
  await assertVaultHealthBounds(page);
  await page.screenshot({ path: resolve(outputDir, "vault-health-desktop.png"), fullPage: false });
  const okfDownloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 OKF", exact: true }).click();
  const okfDownload = await okfDownloadPromise;
  assert.match(okfDownload.suggestedFilename(), /^rp-agent-memory-okf-\d{8}T\d{6}Z\.zip$/);
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
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "hidden" });
  await page.locator("#conversationList .conversation-group-head").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#conversationList .conversation-item.active").waitFor();
  await page.locator("#conversationCharacter").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
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
  assert.match(smsSessionId, /^conversation-/);
  assert.equal(await page.locator("#modeSelect").isDisabled(), true);
  assert.equal(await page.locator("#chatCharacterSelect").isDisabled(), true);
  assert.equal(await page.locator("#conversationScene").isHidden(), true);
  await captureValidatedScreenshot(page, resolve(outputDir, "system-event.png"));
  await smsSystemEvent.getByRole("button", { name: "前往模型设置" }).click();
  await page.locator("#settingsPage").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "聊天", exact: true }).click();
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

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("button", { name: "新建角色", exact: true }).click();
  await page.locator("#characterName").fill("顾遥");
  await page.locator("#characterSoulMarkdown").fill("# SOUL.md - 顾遥\n\n沉静、善于倾听，以第一人称自然交流。");
  await page.getByRole("button", { name: "创建角色", exact: true }).click();
  await page.locator("#characterState").filter({ hasText: "已创建" }).waitFor();
  await page.locator("#characterCardGrid .character-card").filter({ hasText: "顾遥" }).waitFor();
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#newConversationCharacter option:checked").textContent(), "顾遥");
  await page.getByRole("button", { name: "群聊", exact: true }).click();
  await page.locator("#newConversationGroupTitle").fill("河岸小组");
  assert.equal(await page.locator('#newConversationMembers input[type="checkbox"]:checked').count(), 2);
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.locator("#newConversationDialog").waitFor({ state: "hidden" });
  await page.locator("#conversationCharacter").filter({ hasText: "河岸小组" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "角色群聊 · 2 人" }).waitFor();
  assert.equal(await page.locator("#attachFileBtn").isDisabled(), true);
  await page.locator("#textInput").fill("大家在吗？");
  await page.locator("#textInput").press("Enter");
  await page.locator("#status").filter({ hasText: "本轮角色调用失败" }).waitFor();
  await page.locator("#messages .message-row.user").filter({ hasText: "大家在吗" }).waitFor();
  assert.equal(await page.locator("#messages .message-row.assistant").count(), 0);
  const groupConversationItem = page.locator("#conversationList button[data-group-chat-id]").filter({ hasText: "河岸小组" });
  await groupConversationItem.waitFor();
  assert.equal(await groupConversationItem.locator(".group-avatar-cluster.compact > span").count(), 2);
  assert.equal(await page.locator("#conversationHeaderAvatar .group-avatar-cluster > span").count(), 2);
  await captureValidatedScreenshot(page, resolve(outputDir, "group-chat.png"));

  await page.getByRole("button", { name: "批量管理会话" }).click();
  await page.getByRole("checkbox", { name: "选择群聊 河岸小组" }).check();
  await page.locator("#conversationBatchCount").filter({ hasText: "已选 1 项" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "group-chat-batch-selection.png"));
  await page.locator("#conversationBatchArchiveBtn").click();
  await page.locator("#sessionActionDialog").filter({ hasText: "批量归档" }).waitFor({ state: "visible" });
  await page.locator("#confirmSessionActionBtn").click();
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await page.locator('#conversationList [data-group-chat-id]').filter({ hasText: "河岸小组" }).waitFor({ state: "detached" });
  await page.locator("#sidebarArchivedSessionsBtn").click();
  const archivedGroup = page.locator("#archivedSessionList [data-group-id]").filter({ hasText: "河岸小组" });
  await archivedGroup.waitFor();
  await archivedGroup.getByRole("button", { name: "恢复群聊" }).click();
  await page.locator("#archivedSessionsDialog").waitFor({ state: "hidden" });
  await page.locator('#conversationList [data-group-chat-id]').filter({ hasText: "河岸小组" }).waitFor();

  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationCharacter").selectOption({ label: "林澈" });
  await page.locator("#newConversationRpBtn").click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.locator("#conversationMode").filter({ hasText: "剧情演绎" }).waitFor();
  await page.locator("#textInput").fill("剧情里我们继续沿着河岸散步。");
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
  assert.equal(await page.locator("#textInput").inputValue(), "剧情里我们继续沿着河岸散步。");
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
  const rpSystemEvent = page.locator("#messages .message-row.system").last();
  await rpSystemEvent.filter({ hasText: "模型当前未启用" }).waitFor();
  assert.equal(await rpSystemEvent.locator(".message-avatar").count(), 0);
  await page.waitForFunction(() => document.querySelector("#modeSelect")?.disabled === true);
  const rpSessionId = await page.locator("#sessionSelect").inputValue();
  const characterId = await page.locator("#chatCharacterSelect").inputValue();
  assert.notEqual(rpSessionId, smsSessionId);
  assert.equal(await page.locator("#modeSelect").isDisabled(), true);
  assert.equal(await page.locator("#chatCharacterSelect").isDisabled(), true);
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
  await page.locator("#sessionActionInput").fill("河岸剧情");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  const renamedRpOption = page.locator(`#sessionSelect option[value="${rpSessionId}"]`).filter({ hasText: "河岸剧情" });
  await renamedRpOption.waitFor({ state: "attached" });
  assert.match(await renamedRpOption.textContent(), /河岸剧情/);
  const sceneResponse = await page.evaluate(async ({ sessionId, selectedCharacterId }) => {
    const response = await fetch("/api/v1/sessions/" + encodeURIComponent(sessionId) + "/scene", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterId: selectedCharacterId,
        location: "河岸",
        currentObjective: "走到桥边",
        summary: "两人沿着河岸继续散步。"
      })
    });
    return response.status;
  }, { sessionId: rpSessionId, selectedCharacterId: characterId });
  assert.equal(sceneResponse, 200);
  await page.locator(`#conversationList .conversation-item[data-session-id="${smsSessionId}"]`).click();
  await page.locator("#conversationMode").filter({ hasText: "角色私聊" }).waitFor();
  await page.locator(`#conversationList .conversation-item[data-session-id="${rpSessionId}"]`).click();
  await page.locator("#conversationMode").filter({ hasText: "剧情演绎" }).waitFor();
  await page.locator("#conversationScene").filter({ hasText: "地点 河岸" }).waitFor();
  await page.locator("#conversationScene").filter({ hasText: "目标 走到桥边" }).waitFor();
  await page.getByRole("button", { name: "场景信息" }).click();
  await page.locator("#sceneInfoDialog").waitFor({ state: "visible" });
  await page.locator("#sceneInfoContent").filter({ hasText: "河岸" }).filter({ hasText: "走到桥边" }).waitFor();
  await page.getByRole("button", { name: "编辑场景", exact: true }).click();
  await page.locator("#sceneForm").waitFor({ state: "visible" });
  await page.locator("#sceneSummary").fill("两人沿着河岸散步，并准备走到桥边。");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator("#sceneForm").waitFor({ state: "hidden" });
  await page.locator("#sceneInfoContent").filter({ hasText: "准备走到桥边" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-scene-info.png"));
  await page.getByRole("button", { name: "关闭场景信息" }).click();
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-session-rp-scene.png"));

  await page.locator(`#conversationList .conversation-item[data-session-id="${smsSessionId}"]`).click();
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
  await page.waitForFunction((expected) => document.querySelector("#sessionSelect")?.value === expected, rpSessionId);
  assert.equal(await page.locator(`#sessionSelect option[value="${smsSessionId}"]`).count(), 0);
  await page.locator("#conversationMode").filter({ hasText: "剧情演绎" }).waitFor();
  await page.locator("#conversationScene").filter({ hasText: "地点 河岸" }).waitFor();
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
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).click();
  await page.locator("#confirmSessionActionBtn").click();
  await page.waitForFunction((expected) => document.querySelector("#sessionSelect")?.value === expected, rpSessionId);
  await page.locator("#sidebarArchivedSessionsBtn").click();
  const archivedSmsForDelete = page.locator("#archivedSessionList .archived-row").filter({ hasText: "日常私聊" });
  await archivedSmsForDelete.waitFor();
  await archivedSmsForDelete.getByRole("button", { name: "永久删除归档会话" }).click();
  await page.locator("#sessionActionInput").fill("错误名称");
  await page.getByRole("button", { name: "永久删除", exact: true }).click();
  await page.locator("#sessionActionError").filter({ hasText: "会话名称不匹配" }).waitFor();
  await page.locator("#sessionActionInput").fill("日常私聊");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await archivedSmsForDelete.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "关闭归档会话" }).click();

  const markdownReply = "## 进度测试完成\n\n- 支持 **Markdown** 列表\n- 支持 `行内代码`\n\n```js\nconst ready = true;\n```\n\n![角色发送的图片](workspace:uploads/scene.png)\n\n![越界图片](workspace:../secret.png)\n\n[安全链接](https://example.test)<script>window.markdownUnsafe = true</script>";
  const rpMessagesRoute = "**/api/v1/sessions/" + rpSessionId + "/messages";
  const rpStreamRoute = rpMessagesRoute + "/stream";
  await page.route(rpMessagesRoute, (route) => route.fulfill({
    status: 200,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify([
      { role: "user", content: [{ type: "text", text: "检查执行过程" }] },
      { role: "assistant", content: [{ type: "text", text: markdownReply }], turnStatus: "completed", canRetry: false },
      { role: "toolResult", content: [{ type: "text", text: "read · completed" }] },
    ]),
  }));
  await page.route(rpStreamRoute, async (route) => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    const events = [
      { type: "lifecycle", eventType: "agent_start" },
      { type: "reasoning_status", phase: "start" },
      { type: "reasoning_status", phase: "end" },
      { type: "tool_start", toolName: "read", toolCallId: "progress-tool" },
      {
        type: "tool_end",
        toolName: "read",
        toolCallId: "progress-tool",
        isError: false,
        result: { content: [{ type: "text", text: "read · completed" }] },
      },
      { type: "delta", delta: markdownReply },
      { type: "done", response: { reply: markdownReply, actions: [{ actionType: "read", status: "completed" }], events: [], status: "completed", canRetry: false, messageType: "assistant" } },
    ];
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""),
    });
  });
  await page.locator('[data-session-id="' + rpSessionId + '"]').click();
  const storedProgress = page.locator("#messages .bubble.assistant").last().locator(".message-progress");
  await storedProgress.filter({ hasText: "已完成" }).waitFor();
  const storedToolResult = storedProgress.locator(".progress-tool-result").filter({ hasText: "read · completed" });
  await storedToolResult.waitFor({ state: "attached" });
  assert.equal(await page.locator("#messages .bubble.tool").count(), 0);
  await page.locator("#textInput").fill("检查执行过程");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const liveProgress = page.locator("#messages .bubble.assistant").last().locator(".message-progress");
  await liveProgress.filter({ hasText: "正在输入" }).waitFor();
  assert.equal(await liveProgress.getAttribute("open"), null);
  assert.equal(await liveProgress.locator(".typing-dot").count(), 3);
  assert.equal(await liveProgress.locator(".progress-list").isHidden(), true);
  assert.match(
    await liveProgress.locator(".typing-dot").first().evaluate((element) => getComputedStyle(element).animationName),
    /message-typing-dot/,
  );
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-typing-indicator.png"));
  await liveProgress.locator("summary").click();
  assert.equal(await liveProgress.getAttribute("open"), "");
  const completedProgress = page.locator("#messages .bubble.assistant").last();
  await completedProgress.filter({ hasText: "进度测试完成" }).waitFor();
  await completedProgress.locator(".message-progress").filter({ hasText: "已完成" }).waitFor();
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
  assert.match(expandedToolResult.text, /read · completed/);
  assert.equal(await page.locator("#messages .bubble.tool").count(), 0);
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "chat-execution-progress.png"));
  await page.unroute(rpStreamRoute);
  await page.unroute(rpMessagesRoute);

  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationCharacter").selectOption({ label: "林澈" });
  await page.locator("#newConversationSmsBtn").click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.locator("#textInput").fill("临时删除会话 A");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator("#messages .message-row.system").filter({ hasText: "模型当前未启用" }).waitFor();
  const temporarySessionA = await page.locator("#sessionSelect").inputValue();
  assert.notEqual(temporarySessionA, rpSessionId);
  await page.getByRole("button", { name: "新建对话" }).click();
  await page.locator("#newConversationCharacter").selectOption({ label: "林澈" });
  await page.locator("#newConversationRpBtn").click();
  await page.getByRole("button", { name: "开始对话", exact: true }).click();
  await page.locator("#textInput").fill("临时删除会话 B");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.locator("#messages .message-row.system").filter({ hasText: "模型当前未启用" }).waitFor();
  const temporarySessionB = await page.locator("#sessionSelect").inputValue();
  assert.notEqual(temporarySessionB, temporarySessionA);

  const characterGroup = page.locator("#conversationList .conversation-group").filter({ hasText: "林澈" });
  assert.equal(await characterGroup.count(), 1);
  await characterGroup.locator(".conversation-group-copy").filter({ hasText: "3 个会话" }).waitFor();
  await characterGroup.locator("button[data-conversation-group-toggle]").click();
  assert.equal(await characterGroup.locator(".conversation-group-sessions").isHidden(), true);
  await characterGroup.locator("button[data-conversation-group-toggle]").click();
  await characterGroup.locator(".conversation-group-sessions").waitFor({ state: "visible" });
  await captureValidatedScreenshot(page, resolve(outputDir, "conversation-grouped-sessions.png"));

  await page.getByRole("button", { name: "批量管理会话" }).click();
  await page.getByRole("checkbox", { name: "选择会话 临时删除会话 A" }).check();
  await page.getByRole("checkbox", { name: "选择会话 临时删除会话 B" }).check();
  await page.locator("#conversationBatchCount").filter({ hasText: "已选 2 项" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "conversation-batch-selection.png"));
  await page.locator("#conversationBatchDeleteBtn").click();
  await page.locator("#sessionActionDialog").filter({ hasText: "批量永久删除" }).waitFor({ state: "visible" });
  await page.locator("#sessionActionInput").fill("永久删除 2 个会话");
  await page.locator("#sessionActionInput").press("Enter");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  await page.waitForFunction((expected) => document.querySelector("#sessionSelect")?.value === expected, rpSessionId);
  assert.equal(await page.locator(`#sessionSelect option[value="${temporarySessionA}"]`).count(), 0);
  assert.equal(await page.locator(`#sessionSelect option[value="${temporarySessionB}"]`).count(), 0);
  await page.locator("#conversationScene").filter({ hasText: "地点 河岸" }).waitFor();
  await captureValidatedScreenshot(page, resolve(outputDir, "session-batch-delete-safe-switch.png"));

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("button", { name: "能力模块", exact: true }).click();
  const tavilyModule = page.locator(".module-row").filter({ hasText: "Tavily Search MCP" });
  const visionModule = page.locator(".module-row").filter({ hasText: "Vision MCP" });
  const subagentModule = page.locator(".module-row").filter({ hasText: "Subagent Delegation MCP" });
  const relationshipModule = page.locator(".module-row").filter({ hasText: "Relationship State MCP" });
  await subagentModule.getByRole("button", { name: "查看 Subagent Delegation MCP 详情" }).click();
  await page.locator("#moduleDetailContent").filter({ hasText: "delegate_task" }).filter({ hasText: "three tasks" }).waitFor();
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
  await page.getByRole("tab", { name: "功能测试", exact: true }).click();
  await page.locator("#featureTestPanel").waitFor({ state: "visible" });
  assert.ok(await page.locator("#featureTestList input[data-feature-test]").count() >= 10);
  await page.getByRole("button", { name: "聊天", exact: true }).click();

  await page.screenshot({ path: resolve(outputDir, "desktop.png"), fullPage: false });
  assert.deepEqual(sessionConflicts, [], `session mismatch responses: ${sessionConflicts.join(" | ")}`);
  assert.deepEqual(errors, [], `desktop console errors: ${errors.join(" | ")}`);
  await page.close();
}

async function runMobileWorkflow(browser, baseUrl, outputDir) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  const errors = collectErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await assertViewport(page);
  await page.getByRole("button", { name: "聊天", exact: true }).click();
  const mobileRpSessionId = await page.locator("#sessionSelect").inputValue();
  assert.ok(mobileRpSessionId);
  const mobileMessagesRoute = "**/api/v1/sessions/" + mobileRpSessionId + "/messages";
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
  await page.locator("#conversationCharacter").filter({ hasText: "林澈" }).waitFor();
  await page.locator("#conversationMode").filter({ hasText: "剧情演绎" }).waitFor();
  await page.locator("#conversationListToggle").click();
  await page.locator("#chatWorkspace").evaluate((element) => {
    if (!element.classList.contains("list-open")) throw new Error("mobile conversation list did not open");
  });
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-conversation-list.png"));
  await page.getByRole("button", { name: "批量管理会话" }).click();
  await page.getByRole("checkbox", { name: "选择 林澈 的全部会话" }).check();
  await page.locator("#conversationBatchCount").filter({ hasText: "已选 1 项" }).waitFor();
  await assertInteractiveBounds(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-conversation-batch.png"));
  await page.getByRole("button", { name: "完成批量管理" }).click();
  const activeConversation = page.locator("#conversationList .conversation-item.active");
  await activeConversation.locator(".conversation-copy").click();
  await page.waitForFunction(() => !document.querySelector("#chatWorkspace")?.classList.contains("list-open"));
  const mobileProgress = page.locator("#messages .bubble.assistant").last().locator(".message-progress");
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
  await page.locator("#conversationScene").filter({ hasText: "地点 河岸" }).waitFor();
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await captureValidatedScreenshot(page, resolve(outputDir, "mobile-role-chat.png"));
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
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "归档会话", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("menuitem", { name: "永久删除会话", exact: true }).waitFor({ state: "visible" });
  await assertElementUnclipped(page, "#sessionActionsMenu");
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
  await page.locator(`#conversationList .conversation-item[data-session-id="${mobileRpSessionId}"]`).click();
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "永久删除会话", exact: true }).click();
  await page.locator("#sessionActionDialog").filter({ hasText: "永久删除会话" }).waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await page.locator("#sessionActionDialog").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sessionActionsMenuBtn");
  await page.getByRole("button", { name: "会话操作" }).click();
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
  await page.locator("#sessionActionDialog").waitFor({ state: "visible" });
  await page.locator("#sessionActionInput").fill("河岸剧情移动端");
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
  await page.getByRole("button", { name: "Debug" }).click();
  await page.locator("#debugPane").waitFor({ state: "visible" });
  await page.locator(".trace-index-item.active").waitFor({ state: "visible" });
  await assertPanelInsideMain(page, "#debugPane");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-debug-trace.png"), fullPage: false });
  await page.getByRole("tab", { name: "Context Economics" }).click();
  await page.locator("#traceDetailTitle").filter({ hasText: "estimated tokens" }).waitFor();
  await page.locator("#traceContent").filter({ hasText: "Cache read" }).filter({ hasText: "unknown" }).waitFor();
  await assertPanelInsideMain(page, "#debugPane");
  await assertInteractiveBounds(page);
  await assertViewport(page);
  await page.screenshot({ path: resolve(outputDir, "mobile-context-economics.png"), fullPage: false });
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
  await page.getByRole("tab", { name: "角色日程", exact: true }).click();
  await page.locator("#scheduleCharacterSelect").selectOption({ label: "林澈" });
  await page.locator("#scheduleAgendaViewBtn").click();
  await page.locator("#scheduleList .schedule-row").filter({ hasText: "傍晚去河岸" }).waitFor({ state: "visible" });
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
  await page.getByRole("tab", { name: "关系", exact: true }).click();
  await page.locator("#relationshipOverview").filter({ hasText: "初识" }).waitFor();
  assert.equal(await page.locator("#relationshipOverview .relationship-metric").count(), 5);
  await assertPanelInsideMain(page, "#charactersPage");
  await assertInteractiveBounds(page);
  await page.screenshot({ path: resolve(outputDir, "mobile.png"), fullPage: false });
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
  await page.waitForFunction(() => document.querySelector("#status")?.textContent === "全部用户数据已删除");
  assert.deepEqual(errors, [], `mobile console errors: ${errors.join(" | ")}`);
  await page.close();
}

async function runCompactDesktopWorkflow(browser, baseUrl, outputDir) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = collectErrors(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
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

function collectErrors(page) {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
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
