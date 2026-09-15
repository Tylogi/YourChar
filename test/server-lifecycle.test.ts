import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CHARACTER_AVATAR_PATH } from "../src/app/default-character.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";

test("createHttpServer leaves an injected kernel under caller ownership", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-http-ownership-"));
  const injected = new CompanionKernel({ stateDir, startScheduler: false });
  const originalDispose = injected.dispose.bind(injected);
  let disposeCalls = 0;
  injected.dispose = () => {
    disposeCalls += 1;
    originalDispose();
  };
  const server = createHttpServer({ kernel: injected });
  try {
    await listen(server);
    await close(server);
    assert.equal(disposeCalls, 0);
    injected.dispose();
    assert.equal(disposeCalls, 1);
  } finally {
    if (server.listening) await close(server);
    if (disposeCalls === 0) injected.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("SIGTERM releases the service writer lease for an immediate process restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-service-sigterm-"));
  const port = await reservePort();
  let first: ChildProcessWithoutNullStreams | undefined;
  let second: ChildProcessWithoutNullStreams | undefined;
  try {
    first = spawnService(stateDir, port);
    await waitForHealthy(first, port);
    const firstCharacters = await listServiceCharacters(port);
    assert.equal(firstCharacters.length, 1);
    assert.equal(firstCharacters[0]?.name, "红莉栖");
    assert.match(firstCharacters[0]?.soulMarkdown ?? "", /脑科学研究者/u);
    assert.equal(firstCharacters[0]?.avatarUrl, DEFAULT_CHARACTER_AVATAR_PATH);
    const defaultAvatar = await fetch(`http://127.0.0.1:${port}${DEFAULT_CHARACTER_AVATAR_PATH}`);
    assert.equal(defaultAvatar.status, 200);
    assert.equal(defaultAvatar.headers.get("content-type"), "image/jpeg");
    const defaultAvatarBytes = Buffer.from(await defaultAvatar.arrayBuffer());
    assert.equal(
      createHash("sha256").update(defaultAvatarBytes).digest("hex"),
      "4b0a73bb70f1558e69afd75afaa45a7590b1be4ef7ba05a3ea4d8cb5df176dff",
    );
    const defaultCharacterId = firstCharacters[0]!.id;
    const firstExit = await stopService(first, "SIGTERM");
    assert.deepEqual(firstExit, { code: 0, signal: null });
    first = undefined;

    second = spawnService(stateDir, port);
    await waitForHealthy(second, port);
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    const restartedCharacters = await listServiceCharacters(port);
    assert.equal(restartedCharacters.length, 1);
    assert.equal(restartedCharacters[0]?.id, defaultCharacterId);
    const secondExit = await stopService(second, "SIGTERM");
    assert.deepEqual(secondExit, { code: 0, signal: null });
    second = undefined;
  } finally {
    if (first) await forceStop(first);
    if (second) await forceStop(second);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("service entry point refuses a non-loopback listener", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-service-bind-"));
  const port = await reservePort();
  const child = spawnService(stateDir, port, "0.0.0.0");
  const output: string[] = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  try {
    const result = await waitForExit(child, 8_000);
    assert.notEqual(result.code, 0);
    assert.match(output.join(""), /may only bind to a loopback host/);
  } finally {
    await forceStop(child);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function spawnService(
  stateDir: string,
  port: number,
  host = "127.0.0.1",
): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "dist/src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port),
      RP_AGENT_STATE_DIR: stateDir,
      RP_AGENT_TEST_MODE: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function listServiceCharacters(port: number): Promise<Array<{
  id: string;
  name: string;
  soulMarkdown: string;
  avatarUrl?: string;
}>> {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/characters`);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    characters: Array<{ id: string; name: string; soulMarkdown: string; avatarUrl?: string }>;
  };
  return body.characters;
}

async function waitForHealthy(child: ChildProcessWithoutNullStreams, port: number): Promise<void> {
  const output: string[] = [];
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`service exited before health check: ${redactOutput(output.join(""))}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.status === 200) return;
    } catch {
      // The listener may not be bound yet.
    }
    await delay(40);
  }
  throw new Error(`service health check timed out: ${redactOutput(output.join(""))}`);
}

async function stopService(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const exited = waitForExit(child, 8_000);
  assert.equal(child.kill(signal), true);
  return exited;
}

async function forceStop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = waitForExit(child, 2_000);
  child.kill("SIGKILL");
  await exited.catch(() => undefined);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("service process did not exit in time")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function listen(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: ReturnType<typeof createHttpServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactOutput(value: string): string {
  return value.replaceAll(process.cwd(), "<cwd>").slice(-1_000);
}
