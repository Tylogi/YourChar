import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";

test("server serves chat UI and debug context logs", async () => {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /RP Agent/);
    assert.match(html, /最近上下文日志/);
    assert.match(html, /normalBtn/);
    assert.match(html, /debugBtn/);

    const message = await fetch(`${baseUrl}/api/sessions/ui-test/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "sms",
        text: "5分钟后提醒我喝水",
        now: "2026-07-09T12:00:00.000Z",
      }),
    });
    assert.equal(message.status, 200);

    const logs = await fetch(`${baseUrl}/api/debug/context-logs`);
    assert.equal(logs.status, 200);
    const body = (await logs.json()) as { logs: Array<{ requestText: string; toolNames: string[] }> };
    assert.equal(body.logs[0].requestText, "5分钟后提醒我喝水");
    assert.deepEqual(body.logs[0].toolNames, ["create_reminder", "write_memory"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
