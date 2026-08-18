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
    const html = await response.text();
    assert.doesNotMatch(html, /rp_agent_local_control=/u);
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
      origin: `http://attacker.example:${address.port}`,
      cookie,
      "content-type": "application/json",
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
): Promise<void> {
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      attachLocalControlPlaneCookie(response);
      response.writeHead(204);
      response.end();
      return;
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
  headers: Record<string, string>,
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
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: string };
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
