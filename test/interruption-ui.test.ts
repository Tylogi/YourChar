import assert from "node:assert/strict";
import { Script } from "node:vm";
import test from "node:test";
import { parseHTML } from "linkedom";
import { renderAppHtml } from "../src/http/ui.js";

test("chat interruption controls and upload settings render with valid browser scripts", () => {
  const html = renderAppHtml();
  const { document } = parseHTML(html);
  const limit = document.querySelector("#uploadLimitMiB");
  assert.equal(limit?.getAttribute("value"), "100");
  assert.equal(limit?.closest("section")?.id, "documentSettingsPanel");
  assert.ok(document.querySelector("#resumePrivateQueueBtn"));
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gu)) new Script(match[1]);
});

test("inbox UI discards interrupted deltas and old completion cannot stop the current reply", async () => {
  const html = renderAppHtml();
  const handler = html.match(/async function handlePrivateInboxEvent\([\s\S]*?(?=\n    function captureInsightReceiptBaseline)/u)?.[0];
  assert.ok(handler);
  const state = {
    activeSessionId: "session", conversationSpaceEpoch: 0, conversationViewEpoch: 0, conversationSpace: "normal",
    privateActiveBurstId: "old" as string | null, privateInboxRunning: true, privateInboxPaused: false,
    privateInboxMessages: [{ id: "new-message", burstId: "new", status: "processing" }],
    privateInterruptedBursts: new Set<string>(), uiMode: "normal",
  };
  const deltas: string[] = [];
  const outcomes: unknown[] = [];
  const context: Record<string, any> = {
    state, conversationViewIsCurrent: () => true, ensureMessageHistory: () => ({}),
    privateBurstIndex: () => -1, setStatus() {}, renderMessages() {}, updateDirectGenerationControls() {},
    applyPrivateAgentEvent: (_id: string, event: { delta: string }) => deltas.push(event.delta),
    finishPrivateBurst() {}, applyTurnOutcome: (event: unknown) => outcomes.push(event),
    async refreshSessionMessages() {}, async loadConversationScene() {}, isConversationVisible: () => false,
    async loadSessions() {}, showConversationInsightReceipt() {},
  };
  new Script(handler + "\nthis.handle = handlePrivateInboxEvent;").runInNewContext(context);
  await context.handle({ type: "burst_interrupted", burstId: "old", reason: "new_message" });
  await context.handle({ type: "agent_event", burstId: "old", event: { delta: "stale" } });
  state.privateActiveBurstId = "new";
  await context.handle({ type: "agent_event", burstId: "new", event: { delta: "current" } });
  await context.handle({ type: "burst_done", burstId: "old", messageIds: ["old-message"], response: { status: "cancelled" } });
  assert.deepEqual(deltas, ["current"]);
  assert.equal(state.privateInboxRunning, true);
  assert.equal(state.privateActiveBurstId, "new");
  assert.equal(state.privateInboxMessages.length, 1);
  assert.equal(outcomes.length, 0);
  await context.handle({ type: "queue_state", paused: true });
  assert.equal(state.privateInboxPaused, true);
});

test("waiting for upload settings does not move an attachment into a newly selected conversation", async () => {
  const html = renderAppHtml();
  const uploadFunction = html.match(/async function uploadWorkspaceFiles\([\s\S]*?(?=\n    function formatFileSize)/u)?.[0];
  assert.ok(uploadFunction);
  const state = { activeConversationKind: "direct", activeSessionId: "original", sessionDraft: false, conversationSpace: "secret" };
  let releaseSettings!: (settings: { maxFileBytes: number; maxFileMiB: number }) => void;
  const settings = new Promise(resolve => { releaseSettings = resolve; });
  const urls: string[] = [];
  const context: Record<string, any> = {
    state, URLSearchParams, encodeURIComponent,
    loadUploadSettings: () => settings,
    withConversationSpace: (url: string) => url + "&conversationSpace=" + state.conversationSpace,
    async fetch(url: string) {
      urls.push(url);
      return { ok: true, async json() { return { entry: { path: "uploads/input.txt" } }; } };
    },
  };
  new Script(uploadFunction + "\nthis.upload = uploadWorkspaceFiles;").runInNewContext(context);
  const pending = context.upload([{ name: "input.txt", size: 5, type: "text/plain" }], "uploads", true);
  state.activeSessionId = "replacement";
  state.conversationSpace = "normal";
  releaseSettings({ maxFileBytes: 100 * 1024 * 1024, maxFileMiB: 100 });
  await pending;
  assert.equal(urls.length, 1);
  assert.match(urls[0], /sessions\/original\/workspace/);
  assert.match(urls[0], /conversationSpace=secret/);
});
