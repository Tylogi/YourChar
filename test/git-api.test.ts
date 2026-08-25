import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionKernel } from "../src/domain/index.js";
import type { GitAccessConfig } from "../src/git/index.js";
import { createHttpServer } from "../src/http/router.js";

type TestHarness = {
  kernel: CompanionKernel;
  server: Server;
  origin: string;
  controlHeaders: Record<string, string>;
};

type JsonResult<T> = {
  response: Response;
  text: string;
  body: T;
};

test("Git access HTTP API exposes one SSH identity, enforces local control and persists revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-git-access-api-"));
  let first: TestHarness | undefined;
  let second: TestHarness | undefined;
  try {
    first = await startHarness(root);

    const initial = await jsonRequest<GitAccessConfig>(first, "/api/settings/git-access");
    assert.equal(initial.response.status, 200, initial.text);
    assert.deepEqual(initial.body, {
      revision: 0,
      credential: { kind: "unconfigured" },
      proxyMode: "direct",
      proxyPort: 61090,
      configured: false,
    });

    const unauthorized = await jsonRequest<unknown>(first, "/api/settings/git-access", {
      method: "PATCH",
      body: { expectedRevision: 0, proxyMode: "hclient", proxyPort: 61090 },
      control: false,
    });
    assert.equal(unauthorized.response.status, 403, unauthorized.text);

    const forgedManaged = await jsonRequest<unknown>(first, "/api/settings/git-access", {
      method: "PATCH",
      body: {
        expectedRevision: 0,
        credential: { kind: "managed-ed25519", keyRef: "credentials/forged/id_ed25519" },
      },
    });
    assert.equal(forgedManaged.response.status, 400, forgedManaged.text);

    const forgedFingerprint = await jsonRequest<unknown>(first, "/api/settings/git-access", {
      method: "PATCH",
      body: { expectedRevision: 0, fingerprint: "SHA256:browser-forged" },
    });
    assert.equal(forgedFingerprint.response.status, 400, forgedFingerprint.text);
    assert.equal((await getAccess(first)).revision, 0);

    const generated = await jsonRequest<{
      access: GitAccessConfig;
      publicKey: string;
      fingerprint: string;
    }>(first, "/api/settings/git-access/generate-key", {
      method: "POST",
      body: { expectedRevision: 0 },
    });
    assert.equal(generated.response.status, 200, generated.text);
    assert.equal(generated.body.access.revision, 1);
    assert.deepEqual(generated.body.access.credential, { kind: "managed-ed25519" });
    assert.equal(generated.body.access.configured, true);
    assert.match(generated.body.publicKey, /^ssh-ed25519 [A-Za-z0-9+/]+=*/u);
    assert.match(generated.body.fingerprint, /^SHA256:/u);

    const privateKeyPath = join(root, "git", "credentials", "default", "id_ed25519");
    const privateKey = readFileSync(privateKeyPath, "utf8").trim();
    assert.equal(lstatSync(privateKeyPath).mode & 0o777, 0o600);
    assert.equal(generated.text.includes("OPENSSH PRIVATE KEY"), false);
    assert.equal(generated.text.includes(privateKey), false);

    const publicKey = await jsonRequest<{ publicKey?: string; fingerprint?: string }>(
      first,
      "/api/settings/git-access/public-key",
    );
    assert.equal(publicKey.response.status, 200, publicKey.text);
    assert.equal(publicKey.body.publicKey, generated.body.publicKey);
    assert.equal(publicKey.body.fingerprint, generated.body.fingerprint);
    assert.equal(publicKey.text.includes(privateKey), false);

    const stale = await jsonRequest<unknown>(first, "/api/settings/git-access", {
      method: "PATCH",
      body: { expectedRevision: 0, proxyMode: "hclient", proxyPort: 61091 },
    });
    assert.equal(stale.response.status, 409, stale.text);
    assert.equal((await getAccess(first)).revision, 1);

    const proxyUpdated = await jsonRequest<GitAccessConfig>(first, "/api/settings/git-access", {
      method: "PATCH",
      body: { expectedRevision: 1, proxyMode: "hclient", proxyPort: 61091 },
    });
    assert.equal(proxyUpdated.response.status, 200, proxyUpdated.text);
    assert.equal(proxyUpdated.body.revision, 2);
    assert.deepEqual(proxyUpdated.body.credential, { kind: "managed-ed25519" });
    assert.equal(proxyUpdated.body.proxyMode, "hclient");
    assert.equal(proxyUpdated.body.proxyPort, 61091);

    const external = await jsonRequest<GitAccessConfig>(first, "/api/settings/git-access", {
      method: "PATCH",
      body: {
        expectedRevision: 2,
        credential: { kind: "external-file", privateKeyPath },
        proxyMode: "direct",
        proxyPort: 61090,
      },
    });
    assert.equal(external.response.status, 200, external.text);
    assert.equal(external.body.revision, 3);
    assert.deepEqual(external.body.credential, { kind: "external-file", privateKeyPath });
    assert.equal(external.body.configured, true);

    for (const removedPath of [
      "/api/settings/git-registry",
      "/api/settings/git-repository",
      "/api/settings/git-projects",
      "/api/settings/git-identities",
    ]) {
      const removed: JsonResult<{ error?: string }> = await jsonRequest<{ error?: string }>(first, removedPath);
      assert.equal(removed.response.status, 404, `${removedPath}: ${removed.text}`);
    }

    await stopHarness(first);
    first = undefined;
    second = await startHarness(root);
    const persisted = await getAccess(second);
    assert.equal(persisted.revision, 3);
    assert.deepEqual(persisted.credential, { kind: "external-file", privateKeyPath });
    assert.equal(persisted.proxyMode, "direct");
    assert.equal(persisted.configured, true);
  } finally {
    if (first) await stopHarness(first);
    if (second) await stopHarness(second);
    rmSync(root, { recursive: true, force: true });
  }
});

async function startHarness(stateDir: string): Promise<TestHarness> {
  const kernel = new CompanionKernel({
    stateDir,
    workspaceDir: join(stateDir, "workspace"),
    startScheduler: false,
    startWorldCoordinator: false,
    startPrivateInboxCoordinator: false,
    characterSkillReflector: false,
    imGateway: false,
  });
  const server = createHttpServer({ kernel });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${origin}/`);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
  await bootstrap.body?.cancel();
  assert.ok(cookie, "the UI bootstrap must issue the local-control cookie");
  return {
    kernel,
    server,
    origin,
    controlHeaders: {
      "content-type": "application/json",
      cookie,
      origin,
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    },
  };
}

async function stopHarness(harness: TestHarness): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    harness.server.close((error) => error ? reject(error) : resolve());
  });
  harness.kernel.dispose();
}

async function getAccess(harness: TestHarness): Promise<GitAccessConfig> {
  const result = await jsonRequest<GitAccessConfig>(harness, "/api/settings/git-access");
  assert.equal(result.response.status, 200, result.text);
  return result.body;
}

async function jsonRequest<T>(
  harness: TestHarness,
  pathname: string,
  options: { method?: string; body?: unknown; control?: boolean } = {},
): Promise<JsonResult<T>> {
  const method = options.method ?? "GET";
  const headers = options.control === false
    ? (options.body === undefined ? undefined : { "content-type": "application/json" })
    : harness.controlHeaders;
  const response = await fetch(`${harness.origin}${pathname}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    assert.fail(`Expected JSON from ${method} ${pathname}, received: ${text}`);
  }
  return { response, text, body };
}
