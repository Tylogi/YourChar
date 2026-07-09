import assert from "node:assert/strict";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

test("server serves chat UI and debug context logs", async () => {
  const server = createHttpServer({ kernel: new CompanionKernel({ stateDir: false }) });
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
    assert.match(html, /模型 API 设置/);
    assert.match(html, /normalBtn/);
    assert.match(html, /settingsBtn/);
    assert.match(html, /debugBtn/);

    const pageWithSlash = await fetch(`${baseUrl}/ui/`);
    assert.equal(pageWithSlash.status, 200);
    assert.match(await pageWithSlash.text(), /RP Agent/);

    const apiHealth = await fetch(`${baseUrl}/api/health`);
    assert.equal(apiHealth.status, 200);
    assert.deepEqual(await apiHealth.json(), { status: "ok" });

    const uiApiRoot = await fetch(`${baseUrl}/ui/api`);
    assert.equal(uiApiRoot.status, 200);
    assert.equal(((await uiApiRoot.json()) as { status: string }).status, "ok");

    const savedSettings = await fetch(`${baseUrl}/api/settings/model-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        baseUrl: "http://127.0.0.1:8317/v1",
        model: "local-model",
        apiKey: "client-secret",
        temperature: 0.7,
        maxTokens: 2048,
      }),
    });
    assert.equal(savedSettings.status, 200);
    const savedBody = await savedSettings.json();
    assert.equal(savedBody.apiKeySet, true);
    assert.equal(savedBody.apiKeyMasked, "clie...cret");
    assert.equal(JSON.stringify(savedBody).includes("client-secret"), false);

    const fetchedSettings = await fetch(`${baseUrl}/api/model-config/openai-compatible`);
    assert.equal(fetchedSettings.status, 200);
    const fetchedBody = await fetchedSettings.json();
    assert.equal(fetchedBody.model, "local-model");
    assert.equal(JSON.stringify(fetchedBody).includes("client-secret"), false);

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
