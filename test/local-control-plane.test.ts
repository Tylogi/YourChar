import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import test from "node:test";
import {
  assertLocalControlPlaneMutation,
  attachLocalControlPlaneCookie,
  LocalControlPlaneRequestError,
} from "../src/http/local-control-plane.js";
import { CompanionKernel } from "../src/domain/kernel.js";
import { createHttpServer } from "../src/http/router.js";

test("YourChar UI receives an HttpOnly same-site token without exposing it in HTML", async () => {
  const kernel = new CompanionKernel({ stateDir: false, startScheduler: false });
  const server = createHttpServer({ kernel });
  await listen(server);
  try {
    const response = await fetch(`${originOf(server)}/`);
    const cookie = response.headers.get("set-cookie");
    assert.match(
      cookie ?? "",
      /^rp_agent_local_control_[a-f0-9]{16}=[A-Za-z0-9_-]{43};/u,
    );
    assert.match(cookie ?? "", /; HttpOnly;/u);
    assert.match(cookie ?? "", /; SameSite=Strict;/u);
    assert.match(cookie ?? "", /; Path=\/$/u);
    assert.doesNotMatch(cookie ?? "", /; Secure/u);
    const html = await response.text();
    assert.doesNotMatch(html, /rp_agent_local_control=/u);

    const ingressResponse = await fetch(`${originOf(server)}/`, {
      headers: {
        "x-forwarded-by": "lzc-ingress",
        "x-forwarded-proto": "https",
        "x-hc-user-id": "user-123",
      },
    });
    assert.match(ingressResponse.headers.get("set-cookie") ?? "", /; Path=\/; Secure$/u);
    await ingressResponse.body?.cancel();
  } finally {
    await close(server);
    kernel.dispose();
  }
});

test("local control-plane guard accepts same-origin JSON POST, PATCH, and DELETE", async () => {
  await withProbeServer(async ({ origin, cookie }) => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await fetch(`${origin}/installer-probe`, {
        method,
        headers: {
          "content-type": "application/json; charset=utf-8",
          cookie,
          origin,
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        body: "{}",
      });
      assert.equal(response.status, 204);
    }
  });
});

test("local control-plane guard accepts an authenticated Lazycat HTTPS ingress request", async () => {
  await withProbeServer(async ({ server, cookie }) => {
    const uiOrigin = "https://yourchar.example";
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const fetchMode of ["cors", "same-origin"]) {
      const response = await rawRequest(address.port, {
        host: `127.0.0.1:${address.port}`,
        ...lazycatIngressHeaders(uiOrigin, cookie, { "sec-fetch-mode": fetchMode }),
      });
      assert.equal(response.status, 204, `Sec-Fetch-Mode=${fetchMode}`);
    }
  });
});

test("Lazycat ingress requires every unambiguous authentication marker", async () => {
  await withProbeServer(async ({ server, origin, cookie }) => {
    const uiOrigin = "https://yourchar.example";
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const markers = [
      ["x-forwarded-by", "lzc-ingress"],
      ["x-forwarded-proto", "https"],
      ["x-hc-user-id", "user-123"],
    ] as const;
    for (const [name, validValue] of markers) {
      const missing = await rawRequest(address.port, {
        host: `127.0.0.1:${address.port}`,
        ...lazycatIngressHeaders(uiOrigin, cookie, { [name]: undefined }),
      });
      assert.equal(missing.status, 403, `missing ${name}`);

      const duplicate = await rawRequest(address.port, [
        "Host", `127.0.0.1:${address.port}`,
        ...headerLines(lazycatIngressHeaders(uiOrigin, cookie, { [name]: undefined })),
        name, validValue,
        name, validValue,
      ]);
      assert.equal(duplicate.status, 403, `duplicate ${name}`);

      const commaValue = await rawRequest(address.port, {
        host: `127.0.0.1:${address.port}`,
        ...lazycatIngressHeaders(uiOrigin, cookie, { [name]: `${validValue},${validValue}` }),
      });
      assert.equal(commaValue.status, 403, `comma-separated ${name}`);
    }

    for (const emptyUserId of ["", "   "]) {
      const emptyIdentity = await rawRequest(address.port, {
        host: `127.0.0.1:${address.port}`,
        ...lazycatIngressHeaders(uiOrigin, cookie, { "x-hc-user-id": emptyUserId }),
      });
      assert.equal(emptyIdentity.status, 403, "empty signed-in user identity");
    }
  });
});

test("Lazycat ingress rejects unsafe origins, fetch contexts, and a missing cookie", async () => {
  await withProbeServer(async ({ server, origin, cookie }) => {
    const uiOrigin = "https://yourchar.example";
    const address = server.address();
    assert.ok(address && typeof address === "object");
    for (const [label, headers] of [
      ["HTTP origin", lazycatIngressHeaders("http://yourchar.example", cookie)],
      ["same-site", lazycatIngressHeaders(uiOrigin, cookie, { "sec-fetch-site": "same-site" })],
      ["no-cors", lazycatIngressHeaders(uiOrigin, cookie, { "sec-fetch-mode": "no-cors" })],
      ["non-empty destination", lazycatIngressHeaders(uiOrigin, cookie, { "sec-fetch-dest": "document" })],
    ] as const) {
      const response = await rawRequest(address.port, {
        host: `127.0.0.1:${address.port}`,
        ...headers,
      });
      assert.equal(response.status, 403, label);
    }

    const selfReportedOrigin = await fetch(`${origin}/installer-probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://attacker.example",
        "x-yourchar-ui-origin": "https://attacker.example",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      body: "{}",
    });
    assert.equal(selfReportedOrigin.status, 403);

    const missingCookie = await fetch(`${origin}/installer-probe`, {
      method: "POST",
      headers: lazycatIngressHeaders(uiOrigin),
      body: "{}",
    });
    assert.equal(missingCookie.status, 403);
    assert.equal(await errorCode(missingCookie), "LOCAL_CONTROL_TOKEN_REJECTED");
  });
});

test("Lazycat ingress requires a loopback socket peer", async () => {
  await withProbeServer(async ({ origin, cookie }) => {
    const response = await fetch(`${origin}/installer-probe`, {
      method: "POST",
      headers: lazycatIngressHeaders("https://yourchar.example", cookie),
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "LOCAL_CONTROL_ORIGIN_REJECTED");
  }, { mutationRemoteAddress: "192.0.2.10" });
});

test("local control-plane guard rejects hostile Origin and DNS-rebinding Host", async () => {
  await withProbeServer(async ({ server, origin, cookie }) => {
    const hostileOrigin = await fetch(`${origin}/installer-probe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        origin: "https://attacker.example",
      },
      body: "{}",
    });
    assert.equal(hostileOrigin.status, 403);
    assert.equal(await errorCode(hostileOrigin), "LOCAL_CONTROL_ORIGIN_REJECTED");

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const rebound = await rawRequest(address.port, {
      host: `attacker.example:${address.port}`,
      ...lazycatIngressHeaders("https://yourchar.example", cookie),
    });
    assert.equal(rebound.status, 403);
    assert.equal(rebound.code, "LOCAL_CONTROL_HOST_REJECTED");
  });
});

test("local control-plane guard rejects unsafe content types and no-cors requests", async () => {
  await withProbeServer(async ({ server, origin, cookie }) => {
    for (const contentType of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const response = await fetch(`${origin}/installer-probe`, {
        method: "POST",
        headers: { "content-type": contentType, cookie, origin },
        body: "{}",
      });
      assert.equal(response.status, 415);
      assert.equal(await errorCode(response), "LOCAL_CONTROL_CONTENT_TYPE_REJECTED");
    }

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const noCors = await rawRequest(address.port, {
      host: `127.0.0.1:${address.port}`,
      "content-type": "application/json",
      cookie,
      origin,
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "same-origin",
    });
    assert.equal(noCors.status, 403);
    assert.equal(noCors.code, "LOCAL_CONTROL_FETCH_CONTEXT_REJECTED");
  });
});

test("local control-plane guard rejects missing, incorrect, and duplicate tokens", async () => {
  await withProbeServer(async ({ origin, cookie }) => {
    const cookieName = cookie.slice(0, cookie.indexOf("="));
    assert.match(cookieName, /^rp_agent_local_control_[a-f0-9]{16}$/u);
    for (const suppliedCookie of [undefined, `${cookieName}=wrong`, `${cookie}; ${cookie}`]) {
      const response = await fetch(`${origin}/installer-probe`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin,
          ...(suppliedCookie ? { cookie: suppliedCookie } : {}),
        },
        body: "{}",
      });
      assert.equal(response.status, 403);
      assert.equal(await errorCode(response), "LOCAL_CONTROL_TOKEN_REJECTED");
    }
  });
});

async function withProbeServer(
  run: (context: { server: Server; origin: string; cookie: string }) => Promise<void>,
  options: { mutationRemoteAddress?: string } = {},
): Promise<void> {
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      attachLocalControlPlaneCookie(request, response);
      response.writeHead(204);
      response.end();
      return;
    }
    if (options.mutationRemoteAddress) {
      Object.defineProperty(request.socket, "remoteAddress", {
        configurable: true,
        value: options.mutationRemoteAddress,
      });
    }
    try {
      assertLocalControlPlaneMutation(request);
      response.writeHead(204);
      response.end();
    } catch (error) {
      if (!(error instanceof LocalControlPlaneRequestError)) throw error;
      response.writeHead(error.status, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: error.code }));
    }
  });
  await listen(server);
  try {
    const origin = originOf(server);
    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    await run({ server, origin, cookie });
  } finally {
    await close(server);
  }
}

async function rawRequest(
  port: number,
  headers: Record<string, string> | string[],
): Promise<{ status: number | undefined; code: string | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/installer-probe",
      method: "POST",
      headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const body = text ? JSON.parse(text) as { code?: string } : {};
        resolve({ status: response.statusCode, code: body.code });
      });
    });
    request.once("error", reject);
    request.end("{}");
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { code?: string }).code;
}

function lazycatIngressHeaders(
  origin: string,
  cookie?: string,
  overrides: Readonly<Record<string, string | undefined>> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin,
    "x-forwarded-by": "lzc-ingress",
    "x-forwarded-proto": "https",
    "x-hc-user-id": "user-123",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
    ...(cookie ? { cookie } : {}),
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return headers;
}

function headerLines(headers: Readonly<Record<string, string>>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => [name, value]);
}

function originOf(server: Server): string {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
