import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("startup migration keeps the latest SMS session, moves queued input, and removes legacy RP", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-canonical-direct-"));
  const clock = new VirtualClock("2026-07-19T01:00:00.000Z");
  try {
    const first = new CompanionKernel({
      stateDir,
      clock,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
    });
    const character = first.createCharacter({ name: "迁移角色" });
    await first.sendMessage("legacy-sms-old", {
      mode: "sms",
      characterId: character.id,
      text: "较早的私聊",
    });
    clock.advance(1_000);
    await first.sendMessage("legacy-sms-latest", {
      mode: "sms",
      characterId: character.id,
      text: "最后使用的私聊",
    });
    clock.advance(1_000);
    await first.sendMessage("legacy-rp", {
      mode: "rp",
      characterId: character.id,
      text: "独立剧情不参与迁移",
    });
    first.privateInbox.repository.create({
      id: "legacy-queued-message",
      clientMessageId: "legacy-client-message",
      sessionId: "legacy-sms-old",
      characterId: character.id,
      mode: "sms",
      text: "升级前尚未处理的消息",
      timezone: "Asia/Shanghai",
      attachments: [],
      now: clock.now().toISOString(),
    });
    first.dispose();

    const second = new CompanionKernel({
      stateDir,
      clock,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
    });
    try {
      const metadata = second.listConversationMetadata();
      const old = metadata.find((entry) => entry.id === "legacy-sms-old");
      const latest = metadata.find((entry) => entry.id === "legacy-sms-latest");
      const rp = metadata.find((entry) => entry.id === "legacy-rp");
      assert.ok(old?.archivedAt);
      assert.equal(old?.canonicalDirect, undefined);
      assert.equal(latest?.archivedAt, undefined);
      assert.equal(latest?.canonicalDirect, true);
      assert.equal(rp, undefined);

      const queued = second.privateInbox.repository.get("legacy-queued-message");
      assert.equal(queued?.sessionId, "legacy-sms-latest");
      assert.equal(second.privateInboxSnapshot("legacy-sms-latest").messages[0]?.text, "升级前尚未处理的消息");
      assert.equal((await second.getSession("legacy-sms-old")).messages.length > 0, true);
      assert.equal((await second.openCanonicalPrivateConversation(character.id)).id, "legacy-sms-latest");
    } finally {
      second.dispose();
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("direct conversation API reopens one canonical SMS thread and draft sends resolve to it", async () => {
  const kernel = new CompanionKernel({
    stateDir: false,
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
  });
  const character = kernel.createCharacter({ name: "唯一私聊角色" });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const open = async () => {
      const response = await fetch(`${baseUrl}/api/v1/direct-conversations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: character.id }),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { session: { id: string; canonicalDirect: boolean } };
    };

    const first = await open();
    const second = await open();
    assert.equal(second.session.id, first.session.id);
    assert.equal(second.session.canonicalDirect, true);

    const archived = await fetch(`${baseUrl}/api/v1/sessions/${encodeURIComponent(first.session.id)}/archive`, {
      method: "POST",
    });
    assert.equal(archived.status, 200);
    const reopened = await open();
    assert.equal(reopened.session.id, first.session.id);
    assert.equal(reopened.session.canonicalDirect, true);
    assert.equal(reopened.session.id, first.session.id);

    const synchronous = await fetch(`${baseUrl}/api/v1/sessions/another-client-draft/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "sms",
        characterId: character.id,
        text: "同步接口也应进入已有窗口",
      }),
    });
    assert.equal(synchronous.status, 200);
    assert.equal(((await synchronous.json()) as { sessionId: string }).sessionId, first.session.id);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "another-client-draft"), false);

    const queued = await fetch(`${baseUrl}/api/v1/sessions/new-client-draft/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientMessageId: "canonical-api-message",
        mode: "sms",
        characterId: character.id,
        text: "这条消息应进入已有窗口",
      }),
    });
    assert.equal(queued.status, 202);
    const queuedBody = (await queued.json()) as {
      message: { sessionId: string };
      inbox: { messages: Array<{ sessionId: string }> };
    };
    assert.equal(queuedBody.message.sessionId, first.session.id);
    assert.equal(queuedBody.inbox.messages[0]?.sessionId, first.session.id);
    assert.equal(kernel.listConversationMetadata().filter((entry) =>
      entry.mode === "sms" && entry.characterId === character.id && !entry.archivedAt
    ).length, 1);
    assert.equal(kernel.listConversationMetadata().some((entry) => entry.id === "new-client-draft"), false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    kernel.dispose();
  }
});
