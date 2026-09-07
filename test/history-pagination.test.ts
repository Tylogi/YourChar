import assert from "node:assert/strict";
import test from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createTestRuntime } from "../src/testing/index.js";
import { createHttpServer } from "../src/http/router.js";
import { HistoryQueryError, pageEntries, type HistoryPage, type HistorySearch } from "../src/history/pagination.js";

test("history cursors are stable, bounded, exclusive and locate a small surrounding window", () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({ id: String(index) }));
  const identify = (entry: { id: string }) => entry.id;
  const latest = pageEntries(entries, identify, {});
  assert.equal(latest.messages.length, 40);
  assert.equal(latest.page.first, "210");
  assert.equal(latest.page.hasEarlier, true);
  assert.equal(latest.page.hasLater, false);
  const before = pageEntries([...entries, { id: "250" }], identify, { before: "210" });
  assert.equal(before.page.last, "209");
  assert.equal(before.page.first, "170");
  const around = pageEntries(entries, identify, { around: "17" });
  assert.equal(around.messages.length, 40);
  assert.ok(around.messages.some(entry => entry.id === "17"));
  assert.equal(around.page.hasEarlier, false);
  assert.equal(around.page.hasLater, true);
  assert.equal(pageEntries(entries, identify, { after: "249" }).messages.length, 0);
  for (const query of [{ before: "missing" }, { before: "1", after: "2" }, { limit: NaN }, { limit: 0 }, { limit: 101 }, { before: "" }]) {
    assert.throws(() => pageEntries(entries, identify, query), HistoryQueryError);
  }
});

test("private history returns only one page without image/thinking blobs; search excludes hidden data", async () => {
  const runtime = createTestRuntime();
  try {
    const character = runtime.kernel.createCharacter({ name: "历史角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    const handle = await runtime.kernel.sessionRuntime.getOrCreate(session.id, "sms", character.id);
    for (let index = 0; index < 180; index++) {
      const message = fauxAssistantMessage(`往事 ${index} · 搜索needle 中文_% <script>安全文字</script>`);
      message.content.push({ type: "thinking", thinking: "HIDDEN_THINKING_SENTINEL" }, { type: "image", data: "BASE64_SENTINEL".repeat(1000), mimeType: "image/png" } as never);
      runtime.kernel.sessionRuntime.appendMessages(handle, [message]);
    }
    handle.sessionManager.appendCustomMessageEntry("hidden-history", "HIDDEN_CUSTOM_SENTINEL", false);
    const page = await runtime.kernel.getMessageHistory(session.id, {}) as unknown as HistoryPage<Record<string, unknown>>;
    assert.equal(page.messages.length, 40);
    assert.match(String(page.messages[0].content), /往事 140/);
    assert.doesNotMatch(JSON.stringify(page), /BASE64_SENTINEL|HIDDEN_THINKING_SENTINEL|HIDDEN_CUSTOM_SENTINEL/);
    assert.ok(JSON.stringify(page).length < 40000);
    const older = await runtime.kernel.getMessageHistory(session.id, { before: page.page.first! }) as unknown as HistoryPage<Record<string, unknown>>;
    assert.match(String(older.messages[0].content), /往事 100/);
    const search = await runtime.kernel.getMessageHistory(session.id, { limit: 20 }, "NEEDLE") as HistorySearch;
    assert.equal(search.results.length, 20); assert.ok(search.next);
    const next = await runtime.kernel.getMessageHistory(session.id, { limit: 20, before: search.next! }, "needle") as HistorySearch;
    assert.equal(next.results.length, 20);
    assert.ok(next.results.every(result => !search.results.some(previous => previous.id === result.id)));
    const focused = await runtime.kernel.getMessageHistory(session.id, { around: next.results[0].id }) as unknown as HistoryPage<Record<string, unknown>>;
    assert.ok(focused.messages.some(message => message.entryId === next.results[0].id));
    for (const query of ["HIDDEN_THINKING_SENTINEL", "HIDDEN_CUSTOM_SENTINEL", "BASE64_SENTINEL"]) {
      assert.deepEqual((await runtime.kernel.getMessageHistory(session.id, {}, query) as HistorySearch).results, []);
    }
    const literal = await runtime.kernel.getMessageHistory(session.id, { limit: 1 }, "中文_%") as HistorySearch;
    assert.equal(literal.results.length, 1);
    runtime.kernel.uploadSessionWorkspaceFile(session.id, { directory: "history", name: "note.txt", bytes: Buffer.from("分页附件") });
    runtime.kernel.sessionRuntime.publishWorkspaceAttachments(handle, ["history/note.txt"]);
    const attachmentPage = await runtime.kernel.getMessageHistory(session.id, { limit: 1 }) as unknown as HistoryPage<Record<string, unknown>>;
    assert.equal(attachmentPage.messages.length, 1);
    assert.match(JSON.stringify(attachmentPage.messages[0].attachments), /history\/note.txt/);
    assert.doesNotMatch(JSON.stringify(attachmentPage), /workspace_attachments|targetAssistantEntryId/);
    const olderAttachmentPage = await runtime.kernel.getMessageHistory(session.id, { before: attachmentPage.page.first!, limit: 1 }) as unknown as HistoryPage<Record<string, unknown>>;
    assert.equal(olderAttachmentPage.messages[0].attachments, undefined, "attachments must not leak onto an adjacent page");
  } finally { runtime.dispose(); }
});

test("world/group history paginates beyond the old 500-message cap and scopes every anchor/search", async () => {
  const runtime = createTestRuntime();
  try {
    const kernel = runtime.kernel;
    const alice = kernel.createCharacter({ name: "Alice" }); const bob = kernel.createCharacter({ name: "Bob" });
    const world = kernel.createWorld({ name: "历史世界" });
    const otherWorld = kernel.createWorld({ name: "另一个世界" });
    const group = kernel.createGroupChat({ characterIds: [alice.id, bob.id] });
    const now = runtime.clock.now().toISOString();
    kernel.worldConversationService.repository.ensureConversation(world.id, now);
    kernel.worldConversationService.repository.createTurn({ id: "world-history-turn", worldId: world.id, status: "completed", modelCalls: 0, actorCount: 0, startedAt: now });
    kernel.groupChatService.repository.createTurn({ id: "group-history-turn", groupId: group.id, status: "completed", modelCalls: 0, speakerCount: 0, messageCount: 0, startedAt: now });
    for (let index = 0; index < 610; index++) {
      const content = `历史 ${index} · 中文_% match`;
      kernel.worldConversationService.repository.appendMessage({ id: `world-${index}`, worldId: world.id, turnId: "world-history-turn", senderType: "director", content, attachments: [], createdAt: now });
      kernel.groupChatService.repository.appendMessage({ id: `group-${index}`, groupId: group.id, turnId: "group-history-turn", senderType: "character", senderId: alice.id, content, createdAt: now });
    }
    for (const [kind, id] of [["world", world.id], ["group", group.id]] as const) {
      const seen = new Set<string>(); let before: string | undefined;
      while (true) {
        const result = kernel.getSharedMessageHistory(kind, id, { before }) as HistoryPage<Record<string, unknown>>;
        assert.ok(result.messages.length <= 40);
        for (const message of result.messages) { assert.equal(seen.has(String(message.id)), false); seen.add(String(message.id)); }
        if (!result.page.hasEarlier) break;
        before = result.page.first!;
      }
      assert.equal(seen.size, 610);
      const found = kernel.getSharedMessageHistory(kind, id, {}, "中文_%") as HistorySearch;
      assert.equal(found.results.length, 40);
      assert.ok(found.next);
      const around = kernel.getSharedMessageHistory(kind, id, { around: `${kind}-5` }) as HistoryPage<Record<string, unknown>>;
      assert.ok(around.messages.some(message => message.id === `${kind}-5`));
      assert.equal(around.page.hasLater, true);
      assert.throws(() => kernel.getSharedMessageHistory(kind, id, { around: "wrong-conversation" }), HistoryQueryError);
    }
    assert.throws(() => kernel.getSharedMessageHistory("world", otherWorld.id, { around: "world-5" }), HistoryQueryError);
  } finally { runtime.dispose(); }
});

test("HTTP pagination/search preserves private owner isolation, validates cursors and keeps the legacy API", async () => {
  const runtime = createTestRuntime(); const kernel = runtime.kernel;
  const alice = kernel.createCharacter({ name: "Alice" }); const bob = kernel.createCharacter({ name: "Bob" });
  const normal = await kernel.openCanonicalPrivateConversation(alice.id);
  const secret = await kernel.openCanonicalPrivateConversation(alice.id, "secret");
  for (const [session, content] of [[normal, "NORMAL_ONLY"], [secret, "SECRET_ONLY"]] as const) {
    const handle = await kernel.sessionRuntime.getOrCreate(session.id, "sms", alice.id);
    kernel.sessionRuntime.appendMessages(handle, [fauxAssistantMessage(content)]);
  }
  const server = createHttpServer({ kernel }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1/sessions/`;
  try {
    assert.ok(Array.isArray(await (await fetch(`${base}${normal.id}/messages`)).json()));
    const response = await fetch(`${base}${normal.id}/messages?paged=1&limit=10`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    for (const query of ["limit=101", "limit=abc", "before=a&after=b", "around=wrong"]) {
      assert.ok((await fetch(`${base}${normal.id}/messages?paged=1&${query}`)).status >= 400);
    }
    assert.equal((await fetch(`${base}${normal.id}/messages/search?q=`)).status, 400);
    assert.equal((await fetch(`${base}${secret.id}/messages/search?q=SECRET`)).status, 404);
    assert.equal((await fetch(`${base}${secret.id}/messages/search?q=SECRET&conversationSpace=secret&characterId=${bob.id}`)).status, 404);
    const secretResult = await (await fetch(`${base}${secret.id}/messages/search?q=SECRET&conversationSpace=secret&characterId=${alice.id}`)).json() as HistorySearch;
    assert.equal(secretResult.results.length, 1);
    const scoped = await (await fetch(`${base}${normal.id}/messages/search?q=SECRET`)).json() as HistorySearch;
    assert.equal(scoped.results.length, 0);
    assert.equal((await fetch(`${base}${normal.id}/messages?paged=1&around=${secretResult.results[0].id}`)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); runtime.dispose(); }
});
