import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROTOCOL_VERSION,
  RequestError,
  client as createAcpClient,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { promptText, yourCharAcpEnvironment } from "../src/acp/index.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/runtime.js";

const token = "acp-test-token-0123456789-abcdefghijklmnopqrstuvwxyz";

test("stdio ACP bridge interoperates with the DeepSeek Harness request sequence and cancellation", async () => {
  await withRuntime(async ({ runtime, origin, workspaceDir }) => {
    const character = runtime.kernel.createCharacter({ name: "ACP 角色" });
    runtime.model.enqueue([{ kind: "stream_chunks", chunks: ["ACP", " 已连通"] }]);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/acp/stdio.js", import.meta.url))],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          YOURCHAR_BASE_URL: origin,
          YOURCHAR_HEADLESS_API_TOKEN: token,
          YOURCHAR_ACP_CHARACTER_ID: character.id,
          YOURCHAR_ACP_CWD: workspaceDir,
          YOURCHAR_ACP_TIMEZONE: "Asia/Shanghai",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    try {
      const updates: SessionUpdate[] = [];
      const connection = createAcpClient({ name: "deepseek-harness-subagent-acp" })
        .onNotification(methods.client.session.update, ({ params }) => {
          updates.push(params.update);
        })
        .connect(ndJsonStream(
          Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
        ));

      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
      assert.deepEqual(initialized.agentCapabilities, {
        loadSession: false,
        promptCapabilities: {},
        mcpCapabilities: {},
        sessionCapabilities: {},
      });

      await assert.rejects(
        connection.agent.request(methods.agent.session.new, {
          cwd: workspaceDir,
          mcpServers: [{ name: "untrusted", command: "false", args: [], env: [] }],
        }),
        (error) => error instanceof RequestError && error.code === -32602,
      );
      await assert.rejects(
        connection.agent.request(methods.agent.session.new, {
          cwd: workspaceDir,
          additionalDirectories: [tmpdir()],
          mcpServers: [],
        }),
        (error) => error instanceof RequestError && error.code === -32602,
      );
      const created = await connection.agent.request(methods.agent.session.new, {
        cwd: workspaceDir,
        mcpServers: [],
      });

      const completed = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "来自 DSH 的任务" }],
      });
      assert.equal(completed.stopReason, "end_turn");
      assert.equal(agentText(updates), "ACP 已连通");
      assert.match(JSON.stringify(runtime.model.requests.at(-1)?.messages), /来自 DSH 的任务/u);

      await assert.rejects(
        connection.agent.request(methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: "image", data: "AA==", mimeType: "image/png" }],
        }),
        (error) => error instanceof RequestError && error.code === -32602,
      );
      await assert.rejects(
        connection.agent.request(methods.agent.session.new, { cwd: workspaceDir, mcpServers: [] }),
        (error) => error instanceof RequestError && error.code === -32600,
      );

      const requestCount = runtime.model.requests.length;
      runtime.model.enqueue([{ kind: "assistant_text", text: "不应完成", delayMs: 1_000 }]);
      const pending = connection.agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "取消这个任务" }],
      });
      await waitFor(() => runtime.model.requests.length > requestCount);
      await connection.agent.notify(methods.agent.session.cancel, { sessionId: created.sessionId });
      assert.equal((await pending).stopReason, "cancelled");

      connection.close();
      child.stdin.end();
      const exit = await waitForExit(child);
      assert.equal(exit.code, 0, Buffer.concat(stderr).toString("utf8"));
      assert.equal(Buffer.concat(stderr).toString("utf8"), "");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

test("ACP prompt projection is bounded and never fetches resource links", () => {
  assert.equal(promptText([
    { type: "text", text: "inspect" },
    { type: "resource_link", name: "README", uri: "file:///project/README.md" },
  ]), "inspect\n[Resource: README] file:///project/README.md");
  assert.throws(
    () => promptText([{ type: "audio", data: "AA==", mimeType: "audio/wav" }]),
    (error) => error instanceof RequestError && error.code === -32602,
  );
  assert.throws(
    () => promptText([{ type: "text", text: "12345" }], 4),
    (error) => error instanceof RequestError && error.code === -32602,
  );
});

test("ACP deployment configuration requires an explicit character and loopback SDK target", () => {
  assert.throws(
    () => yourCharAcpEnvironment({ YOURCHAR_HEADLESS_API_TOKEN: token }, "/workspace"),
    /YOURCHAR_ACP_CHARACTER_ID is required/u,
  );
  assert.throws(
    () => yourCharAcpEnvironment({
      YOURCHAR_HEADLESS_API_TOKEN: token,
      YOURCHAR_ACP_CHARACTER_ID: "character",
      YOURCHAR_ACP_CWD: "relative",
    }, "/workspace"),
    /must be an absolute path/u,
  );
  assert.throws(
    () => yourCharAcpEnvironment({
      YOURCHAR_HEADLESS_API_TOKEN: token,
      YOURCHAR_ACP_CHARACTER_ID: "character",
      YOURCHAR_BASE_URL: "https://example.com",
    }, "/workspace"),
    /loopback origin/u,
  );
});

function agentText(updates: readonly SessionUpdate[]): string {
  return updates.flatMap((update) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : []
  ).join("");
}

async function withRuntime(
  run: (context: {
    runtime: TestRuntime;
    origin: string;
    workspaceDir: string;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "yourchar-acp-bridge-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({
    seed: "acp-bridge",
    stateDir: join(root, "state"),
    workspaceDir,
    startPrivateInboxCoordinator: false,
  });
  const server = createHttpServer({ kernel: runtime.kernel, headlessApiToken: token });
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run({ runtime, origin: `http://127.0.0.1:${address.port}`, workspaceDir });
  } finally {
    await close(server);
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition did not become true before timeout");
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 5_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("ACP child did not exit")), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
