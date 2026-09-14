import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http/router.js";
import {
  createIdempotencyKey,
  YourCharAbortError,
  YourCharAuthenticationError,
  YourCharClient,
  YourCharConflictError,
  YourCharNotFoundError,
  YourCharProtocolError,
  YourCharValidationError,
} from "../src/sdk/index.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/runtime.js";

const token = "sdk-test-token-0123456789-abcdefghi";
const wrongToken = "sdk-wrong-token-0123456789-abcdefgh";

test("typed SDK covers sessions, idempotent goals, ownership, and stable errors", async () => {
  await withSdk(async ({ client, origin, runtime }) => {
    const character = runtime.kernel.createCharacter({ name: "SDK 角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    const otherSession = await runtime.kernel.openCanonicalPrivateConversation(
      runtime.kernel.createCharacter({ name: "另一个 SDK 角色" }).id,
    );

    assert.deepEqual(await client.health(), { status: "ok" });
    assert.equal((await client.listSessions()).some((entry) => entry.id === session.id), true);

    for (const reply of ["第一条回复", "第二条回复", "第三条回复"]) {
      runtime.model.enqueue([{ kind: "assistant_text", text: reply }]);
      const response = await client.sendMessage(session.id, { text: `请求 ${reply}` });
      assert.equal(response.reply, reply);
      assert.equal(response.sessionId, session.id);
    }
    assert.ok((await client.listMessages(session.id)).length >= 6);

    const historyPages = [];
    for await (const page of client.iterateMessageHistory(session.id, { limit: 2 })) {
      historyPages.push(page);
    }
    assert.ok(historyPages.length >= 3);
    assert.equal(historyPages.at(-1)?.page.hasEarlier, false);

    const idempotencyKey = "sdk-goal-create-00000001";
    const goalInput = {
      title: "SDK 幂等目标",
      successCriteria: "只创建一个持久目标",
      priority: "high" as const,
    };
    const first = await client.createGoal(session.id, goalInput, { idempotencyKey });
    const replay = await client.createGoal(session.id, goalInput, { idempotencyKey });
    assert.equal(replay.id, first.id);
    assert.equal((await client.listGoals(session.id)).filter((goal) => goal.id === first.id).length, 1);

    const withTodo = await client.createGoalTodo(session.id, first.id, {
      expectedGoalRevision: first.revision,
      title: "验证 SDK",
    });
    const todo = withTodo.todos[0];
    const completedTodo = await client.transitionGoalTodo(session.id, first.id, todo.id, {
      expectedGoalRevision: withTodo.revision,
      expectedTodoRevision: todo.revision,
      status: "completed",
      note: "已验证",
    });
    const completedGoal = await client.transitionGoal(session.id, first.id, {
      expectedRevision: completedTodo.revision,
      status: "completed",
      note: "完成",
    });
    assert.equal(completedGoal.status, "completed");
    assert.equal((await client.getGoal(session.id, first.id)).recentTransitions.length >= 3, true);

    await assert.rejects(
      client.createGoal(session.id, { ...goalInput, title: "冲突目标" }, { idempotencyKey }),
      (error) => error instanceof YourCharConflictError &&
        error.apiCode === "HEADLESS_IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      client.getGoal(otherSession.id, first.id),
      (error) => error instanceof YourCharNotFoundError && error.status === 404,
    );
    await assert.rejects(
      new YourCharClient({ baseUrl: origin, token: wrongToken }).health(),
      (error) => error instanceof YourCharAuthenticationError &&
        error.apiCode === "HEADLESS_API_AUTH_REQUIRED",
    );
  });
});

test("typed SDK parses streaming events and propagates transport cancellation", async () => {
  await withSdk(async ({ client, runtime }) => {
    const character = runtime.kernel.createCharacter({ name: "SDK 流式角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    runtime.model.enqueue([{ kind: "stream_chunks", chunks: ["流式", "完成"] }]);
    const events = [];
    for await (const event of client.streamMessage(session.id, { text: "流式请求" })) {
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "delta"), true);
    const done = events.find((event) => event.type === "done");
    assert.ok(done?.type === "done");
    assert.equal(done.response.reply, "流式完成");
    assert.equal(done.response.sessionId, session.id);
  });

  const controller = new AbortController();
  const pendingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    })) satisfies typeof fetch;
  const client = new YourCharClient({
    baseUrl: "http://127.0.0.1:8765",
    token,
    fetch: pendingFetch,
  });
  const request = client.health(controller.signal);
  controller.abort();
  await assert.rejects(request, YourCharAbortError);
});

test("typed SDK handles Workspace bytes and bounded execution-output pagination", async () => {
  await withSdk(async ({ client, runtime }) => {
    const uploaded = await client.uploadWorkspaceFile({
      name: "sdk.txt",
      bytes: new Blob(["SDK 文件内容"], { type: "text/plain" }),
      contentType: "text/plain; charset=utf-8",
    });
    assert.equal(uploaded.name, "sdk.txt");
    assert.equal((await client.listWorkspaceFiles({ path: "uploads" })).entries.length, 1);
    const preview = await client.previewWorkspaceFile(uploaded.path);
    assert.equal(preview.content, "SDK 文件内容");
    const downloaded = await client.downloadWorkspaceFile(uploaded.path);
    assert.equal(new TextDecoder().decode(downloaded.bytes), "SDK 文件内容");

    const moved = await client.moveWorkspaceFile(
      uploaded.path,
      "uploads/sdk-renamed.txt",
      { idempotencyKey: "sdk-file-move-00000001" },
    );
    assert.equal(moved.path, "uploads/sdk-renamed.txt");
    const deleted = await client.deleteWorkspaceFile(moved.path, {
      idempotencyKey: "sdk-file-delete-0000001",
    });
    assert.equal(deleted.path, moved.path);

    const character = runtime.kernel.createCharacter({ name: "SDK 作业角色" });
    const session = await runtime.kernel.openCanonicalPrivateConversation(character.id);
    const permissions = await client.getAgentPermissions();
    if (permissions.shellAvailable) {
      await client.patchAgentPermissions(
        { shellEnabled: true },
        { idempotencyKey: "sdk-enable-shell-00000001" },
      );
      const job = await client.startExecutionJob(
        session.id,
        { command: "for ((i=0; i<3000; i++)); do printf ab; done", timeoutSeconds: 5 },
        { idempotencyKey: "sdk-execution-start-00001" },
      );
      await waitFor(async () => (await client.getExecutionJob(session.id, job.id)).status === "completed");
      const chunks = [];
      for await (const page of client.iterateExecutionOutput(session.id, job.id, { limitBytes: 4_096 })) {
        chunks.push(...page.chunks.map((chunk) => chunk.text));
      }
      assert.equal(chunks.join(""), "ab".repeat(3_000));
    }
  });
});

test("SDK validates endpoint and event protocol before exposing payloads", async () => {
  assert.throws(
    () => new YourCharClient({ baseUrl: "https://example.com", token }),
    (error) => error instanceof YourCharValidationError && error.apiCode === "SDK_BASE_URL_INVALID",
  );
  assert.doesNotThrow(() => new YourCharClient({ baseUrl: "http://[::1]:8765", token }));
  assert.match(createIdempotencyKey("goal"), /^goal:[0-9a-f-]{36}$/u);

  const missingVersion = new YourCharClient({
    baseUrl: "http://127.0.0.1:8765",
    token,
    fetch: async () => new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(missingVersion.health(), YourCharProtocolError);

  const invalidStream = new YourCharClient({
    baseUrl: "http://127.0.0.1:8765",
    token,
    fetch: async () => new Response('data: {"type":"unknown"}\n\n', {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-yourchar-api-version": "1",
      },
    }),
  });
  await assert.rejects(async () => {
    for await (const _event of invalidStream.streamMessage("session", { text: "test" })) {
      // Consume the stream so its schema is validated.
    }
  }, YourCharProtocolError);
});

async function withSdk(
  run: (context: {
    client: YourCharClient;
    origin: string;
    runtime: TestRuntime;
    server: Server;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yourchar-sdk-client-"));
  const runtime = createTestRuntime({
    seed: "sdk-client",
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    startPrivateInboxCoordinator: false,
  });
  const server = createHttpServer({ kernel: runtime.kernel, headlessApiToken: token });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    await run({ client: new YourCharClient({ baseUrl: origin, token }), origin, runtime, server });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition did not become true before timeout");
}
