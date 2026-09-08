import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  Agent,
  fetch as undiciFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import { CompanionKernel } from "../src/domain/index.js";
import { subagentProviderTransportIdleTimeoutMs } from "../src/pi/subagent-provider-transport.js";

const scaledIdleTimeoutMs = 100;
// Undici's timeout wheel advances at roughly one-second granularity. This
// delay must cross that boundary or the short-timeout baseline can pass.
const delayedWirePhaseMs = 1_200;

test("concurrent delegated OpenAI wires bypass transport idle cutoffs without leaking scope", {
  timeout: 20_000,
}, async () => {
  assert.equal(subagentProviderTransportIdleTimeoutMs, 0);

  const originalDispatcher = getGlobalDispatcher();
  const originalFetch = globalThis.fetch;
  const shortDispatcher = new Agent({
    connectTimeout: 0,
    headersTimeout: scaledIdleTimeoutMs,
    bodyTimeout: scaledIdleTimeoutMs,
  });
  const probeKinds: string[] = [];
  const modelRequestKinds: string[] = [];
  let activeChildren = 0;
  let maximumActiveChildren = 0;
  let childrenStartedResolve: (() => void) | undefined;
  const childrenStarted = new Promise<void>((resolve) => {
    childrenStartedResolve = resolve;
  });

  const modelServer = createServer(async (request, response) => {
    const probeKind = request.headers["x-wire-probe"];
    if (probeKind === "headers" || probeKind === "body") {
      request.resume();
      probeKinds.push(probeKind);
      await writeDelayedProbe(response, probeKind);
      return;
    }

    const payload = await readJsonBody(request);
    const serialized = JSON.stringify(payload);
    if (serialized.includes("isolated reviewer subagent")) {
      const marker = serialized.includes("WIRE_CHILD_A") ? "A" : "B";
      modelRequestKinds.push(`child-${marker}`);
      activeChildren += 1;
      maximumActiveChildren = Math.max(maximumActiveChildren, activeChildren);
      if (activeChildren === 2) childrenStartedResolve?.();
      try {
        await writeDelayedTextStream(response, `WIRE_CHILD_RESULT_${marker}`);
      } finally {
        activeChildren -= 1;
      }
      return;
    }

    if (serialized.includes("WIRE_CHILD_RESULT_A") && serialized.includes("WIRE_CHILD_RESULT_B")) {
      modelRequestKinds.push("parent-final");
      writeTextStream(response, "WIRE_PARENT_FINAL");
      return;
    }

    modelRequestKinds.push("parent-initial");
    writeParallelDelegationStream(response);
  });

  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  let kernel: CompanionKernel | undefined;
  setGlobalDispatcher(shortDispatcher);
  try {
    await expectUndiciTimeout(
      async () => {
        const response = await undiciFetch(endpoint, {
          method: "POST",
          headers: { "x-wire-probe": "headers" },
          body: "{}",
          dispatcher: shortDispatcher,
        });
        await response.text();
      },
      "UND_ERR_HEADERS_TIMEOUT",
    );
    await expectUndiciTimeout(
      async () => {
        const response = await undiciFetch(endpoint, {
          method: "POST",
          headers: { "x-wire-probe": "body" },
          body: "{}",
          dispatcher: shortDispatcher,
        });
        await response.text();
      },
      "UND_ERR_BODY_TIMEOUT",
    );

    kernel = new CompanionKernel({
      stateDir: false,
      startScheduler: false,
      startWorldCoordinator: false,
      startPrivateInboxCoordinator: false,
      quietHours: false,
      characterSkillReflector: false,
      memoryExtractor: async () => ({ candidates: [] }),
      relationshipExtractor: async () => ({ significant: false, confidence: 0 }),
      subagentTimeoutMs: 8_000,
    });
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "subagent-wire-model",
      temperature: 0,
      maxTokens: 512,
    });
    kernel.setAgentModuleEnabled("mcp:subagent", true);

    const messagePromise = kernel.sendMessage("subagent-real-wire", {
      mode: "sms",
      text: "Delegate both independent wire checks.",
    });
    await childrenStarted;

    // Child providers receive a request-local fetch implementation. A
    // concurrent request outside either child keeps the short global
    // dispatcher, and global fetch itself is never replaced.
    assert.equal(globalThis.fetch, originalFetch);
    await expectUndiciTimeout(
      async () => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "x-wire-probe": "headers" },
          body: "{}",
        });
        await response.text();
      },
      "UND_ERR_HEADERS_TIMEOUT",
    );

    const result = await messagePromise;
    assert.equal(result.status, "completed");
    assert.equal(result.reply, "WIRE_PARENT_FINAL");
    const delegations = result.actions.filter((action) => action.actionType === "delegate_subagent");
    assert.equal(delegations.length, 2);
    assert.ok(delegations.every((action) => action.status === "completed"));
    assert.equal(maximumActiveChildren, 2);
    assert.equal(modelRequestKinds[0], "parent-initial");
    assert.deepEqual(modelRequestKinds.slice(1, -1).sort(), ["child-A", "child-B"]);
    assert.equal(modelRequestKinds.at(-1), "parent-final");
    assert.deepEqual(probeKinds, ["headers", "body", "headers"]);
    assert.equal(getGlobalDispatcher(), shortDispatcher);
    assert.equal(globalThis.fetch, originalFetch);
  } finally {
    kernel?.dispose();
    setGlobalDispatcher(originalDispatcher);
    await shortDispatcher.close();
    await new Promise<void>((resolve, reject) => {
      modelServer.close((error) => error ? reject(error) : resolve());
    });
  }
});

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text || "{}") as Record<string, unknown>;
}

async function writeDelayedProbe(response: ServerResponse, kind: "headers" | "body"): Promise<void> {
  if (kind === "headers") {
    await delay(delayedWirePhaseMs);
    if (response.destroyed) return;
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("late headers");
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.flushHeaders();
  await delay(delayedWirePhaseMs);
  if (!response.destroyed) response.end("late body");
}

async function writeDelayedTextStream(response: ServerResponse, content: string): Promise<void> {
  await delay(delayedWirePhaseMs);
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.flushHeaders();
  await delay(delayedWirePhaseMs);
  if (response.destroyed) return;
  writeTextStreamBody(response, content);
}

function writeParallelDelegationStream(response: ServerResponse): void {
  writeStreamChunks(response, [
    { delta: { role: "assistant" }, finish_reason: null },
    {
      delta: {
        tool_calls: [
          delegationToolCall(0, "wire-delegate-a", "WIRE_CHILD_A: return result A."),
          delegationToolCall(1, "wire-delegate-b", "WIRE_CHILD_B: return result B."),
        ],
      },
      finish_reason: null,
    },
    { delta: {}, finish_reason: "tool_calls" },
  ]);
}

function delegationToolCall(index: number, id: string, task: string): Record<string, unknown> {
  return {
    index,
    id,
    type: "function",
    function: {
      name: "delegate_task",
      arguments: JSON.stringify({ role: "reviewer", task }),
    },
  };
}

function writeTextStream(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  writeTextStreamBody(response, content);
}

function writeTextStreamBody(response: ServerResponse, content: string): void {
  writeStreamChunk(response, { delta: { role: "assistant" }, finish_reason: null });
  writeStreamChunk(response, { delta: { content }, finish_reason: null });
  writeStreamChunk(response, { delta: {}, finish_reason: "stop" });
  response.end("data: [DONE]\n\n");
}

function writeStreamChunks(
  response: ServerResponse,
  chunks: Array<{ delta: Record<string, unknown>; finish_reason: string | null }>,
): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  for (const chunk of chunks) writeStreamChunk(response, chunk);
  response.end("data: [DONE]\n\n");
}

function writeStreamChunk(
  response: ServerResponse,
  choice: { delta: Record<string, unknown>; finish_reason: string | null },
): void {
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-subagent-wire",
    object: "chat.completion.chunk",
    created: 1,
    model: "subagent-wire-model",
    choices: [{ index: 0, ...choice }],
  })}\n\n`);
}

async function expectUndiciTimeout(callback: () => Promise<void>, code: string): Promise<void> {
  await assert.rejects(callback, (error) => errorChainIncludesCode(error, code));
}

function errorChainIncludesCode(error: unknown, code: string): boolean {
  const visited = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
