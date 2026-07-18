import assert from "node:assert/strict";
import test from "node:test";
import { WebReaderError, WebReaderService } from "../src/web-reader/index.js";
import { createTestRuntime } from "../src/testing/index.js";

const publicResolution = async () => [{ address: "93.184.216.34", family: 4 as const }];

test("Web Reader extracts readable HTML without executing page content", async () => {
  const service = new WebReaderService({
    resolve: publicResolution,
    fetch: async () => new Response(`<!doctype html><html><head><title>Daily Notes</title></head><body>
      <nav>Navigation noise</nav><main><article><h1>Daily Notes</h1><p>This is the useful paragraph with enough readable content for extraction.</p></article></main>
      <script>globalThis.pageExecuted = true</script></body></html>`, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  const result = await service.read({ url: "https://example.com/notes" });
  assert.equal(result.title, "Daily Notes");
  assert.match(result.content, /useful paragraph/);
  assert.doesNotMatch(result.content, /pageExecuted/);
  assert.equal(result.truncated, false);
});

test("Web Reader blocks private targets, redirect pivots, credentials, ports, MIME, and oversized bodies", async () => {
  let fetchCalls = 0;
  const privateService = new WebReaderService({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    fetch: async () => {
      fetchCalls += 1;
      return new Response("should not run");
    },
  });
  await assert.rejects(
    privateService.read({ url: "http://example.com" }),
    (error: unknown) => error instanceof WebReaderError && error.code === "PRIVATE_ADDRESS",
  );
  assert.equal(fetchCalls, 0);

  const mixedTunResolution = new WebReaderService({
    resolve: async (hostname) => hostname === "198.19.0.45"
      ? [{ address: "198.19.0.45", family: 4 }]
      : [
          { address: "198.19.0.45", family: 4 },
          { address: "2606:4700:10::6814:179a", family: 6 },
        ],
    fetch: async () => new Response("TUN-compatible public result", { headers: { "content-type": "text/plain" } }),
  });
  assert.match((await mixedTunResolution.read({ url: "https://example.com" })).content, /TUN-compatible/);
  await assert.rejects(
    mixedTunResolution.read({ url: "http://198.19.0.45" }),
    (error: unknown) => error instanceof WebReaderError && error.code === "PRIVATE_ADDRESS",
  );

  const redirectService = new WebReaderService({
    resolve: async (hostname) => hostname === "public.example"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }],
    fetch: async () => new Response(null, { status: 302, headers: { location: "http://metadata.example/latest" } }),
  });
  await assert.rejects(
    redirectService.read({ url: "https://public.example/start" }),
    (error: unknown) => error instanceof WebReaderError && error.code === "PRIVATE_ADDRESS",
  );

  const service = new WebReaderService({
    resolve: publicResolution,
    fetch: async (url) => url.includes("mime")
      ? new Response("binary", { headers: { "content-type": "application/octet-stream" } })
      : new Response("small", { headers: { "content-type": "text/plain", "content-length": String(3 * 1024 * 1024) } }),
  });
  await assert.rejects(service.read({ url: "https://example.com/mime" }), /unsupported web page content type/);
  await assert.rejects(service.read({ url: "https://example.com/large" }), /exceeds 2 MiB/);
  await assert.rejects(service.read({ url: "https://user:pass@example.com/" }), /credentials/);
  await assert.rejects(service.read({ url: "https://example.com:8443/" }), /ports 80 and 443/);
});

test("Web Reader MCP is opt-in, returns untrusted page text, and audits without storing the URL", async () => {
  const service = new WebReaderService({
    resolve: publicResolution,
    fetch: async () => new Response("Public source body", {
      headers: { "content-type": "text/plain" },
    }),
  });
  const runtime = createTestRuntime({ seed: "web-reader-mcp", webReaderService: service });
  try {
    runtime.model.enqueue([
      { kind: "assistant_text", text: "当前不能直接读取。" },
      { kind: "tool_call", name: "read_web_page", arguments: { url: "https://example.com/source" } },
      { kind: "assistant_text", text: "已读取来源。" },
    ]);
    await runtime.kernel.sendMessage("web-reader", { mode: "sms", text: "打开这个网页" });
    assert.equal(runtime.model.requests[0].toolNames.includes("read_web_page"), false);

    runtime.kernel.setAgentModuleEnabled("mcp:web-reader", true);
    const response = await runtime.kernel.sendMessage("web-reader", { mode: "sms", text: "读取 https://example.com/source" });
    assert.equal(runtime.model.requests[1].toolNames.includes("read_web_page"), true);
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /\[untrusted_web_page\]/);
    assert.match(JSON.stringify(runtime.model.requests[2].messages), /Public source body/);
    const action = response.actions.find((entry) => entry.actionType === "read_web_page");
    assert.ok(action);
    assert.equal(action.payload.hostname, "example.com");
    assert.equal(typeof action.payload.urlSha256, "string");
    assert.equal(JSON.stringify(action.payload).includes("/source"), false);
  } finally {
    runtime.dispose();
  }
});
