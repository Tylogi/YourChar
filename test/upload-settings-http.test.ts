import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse, type Server } from "node:http";
import { Socket } from "node:net";
import test from "node:test";
import { createHttpServer, disposeHttpServerOwnedResources } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/index.js";

// Dispatch real router handlers in memory, without binding a network listener.
async function dispatch(server: Server, path: string, method = "GET", body?: Buffer, headers: Record<string, string> = {}) {
  const socket = new Socket();
  Object.defineProperties(socket, {
    localAddress: { value: "127.0.0.1" }, localPort: { value: 8080 }, remoteAddress: { value: "127.0.0.1" },
  });
  const request = new IncomingMessage(socket);
  request.method = method;
  request.url = path;
  request.headers = { host: "127.0.0.1:8080", ...headers };
  const response = new ServerResponse(request);
  const completed = new Promise<string>(resolve => {
    response.end = ((chunk: unknown) => { resolve(String(chunk ?? "")); return response; }) as typeof response.end;
  });
  if (body) request.push(body);
  request.push(null);
  server.emit("request", request, response);
  const text = await completed;
  socket.destroy();
  return { status: response.statusCode, headers: response.getHeaders(), text, json: () => JSON.parse(text) };
}

test("upload settings routes authorize changes and enforce live limits with and without Content-Length", async () => {
  const runtime = createTestRuntime({ seed: "upload-http", startPrivateInboxCoordinator: false });
  const server = createHttpServer({ kernel: runtime.kernel });
  try {
    const initial = await dispatch(server, "/api/settings/uploads");
    assert.equal(initial.json().settings.maxFileMiB, 100);
    const bootstrap = await dispatch(server, "/");
    const cookie = String(bootstrap.headers["set-cookie"]).split(";")[0];
    const headers = { "content-type": "application/json", origin: "http://127.0.0.1:8080" };
    const patch = Buffer.from(JSON.stringify({ maxFileMiB: 1 }));
    assert.equal((await dispatch(server, "/api/settings/uploads", "PATCH", patch, headers)).status, 403);
    const updated = await dispatch(server, "/api/settings/uploads", "PATCH", patch, { ...headers, cookie });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.json().settings.maxFileBytes, 1024 * 1024);
    assert.equal((await dispatch(server, "/api/settings/uploads", "PATCH", Buffer.from('{"maxFileMiB":0}'), { ...headers, cookie })).status, 400);
    const character = runtime.kernel.createCharacter({ name: "文件角色" });
    const message = await runtime.kernel.enqueuePrivateMessage("upload-http", {
      mode: "sms", characterId: character.id, text: "hello",
    }, "initial");
    for (const path of [
      "/api/v1/workspace/files/upload?name=limit.bin",
      `/api/v1/sessions/${encodeURIComponent(message.sessionId)}/workspace/files/upload?name=limit.bin`,
      "/api/v1/task-bench/uploads?name=limit.bin",
    ]) {
      const oversized = Buffer.alloc(1024 * 1024 + 1);
      assert.equal((await dispatch(server, path, "POST", oversized)).status, 413, path);
      assert.equal((await dispatch(server, path, "POST", undefined, { "content-length": String(oversized.length) })).status, 413, path);
      assert.equal((await dispatch(server, path, "POST", oversized.subarray(0, 1024 * 1024))).status, 201, path);
    }
    const cancel = await dispatch(server, `/api/v1/sessions/${message.sessionId}/messages/cancel`, "POST");
    assert.equal(cancel.status, 200, cancel.text);
    assert.equal(runtime.kernel.privateInboxSnapshot(message.sessionId).paused, true);
    const resume = await dispatch(server, `/api/v1/sessions/${message.sessionId}/inbox/resume`, "POST");
    assert.equal(resume.status, 200, resume.text);
    assert.equal(resume.json().inbox.paused, false);
  } finally { disposeHttpServerOwnedResources(server); runtime.dispose(); }
});
