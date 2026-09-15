import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompanionKernel,
  CompanionStore,
  ControlPlaneBusyError,
  ModelCredentialStore,
  ModelCredentialValidationError,
  redactModelCredentialValue,
} from "../src/domain/index.js";
import { createHttpServer } from "../src/http/router.js";

const incognitoRoot = "/dev/shm";
const incognitoPrefix = "yourchar-incognito-";

test("legacy model keys migrate to a mode-0600 host credential store", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-model-credential-migration-"));
  const secret = "p4c-legacy-secret-sentinel";
  try {
    writeFileSync(join(stateDir, "model-api.json"), JSON.stringify({
      enabled: true,
      provider: "openai_compatible",
      baseUrl: "https://models.invalid/v1",
      model: "legacy-model",
      visionInputEnabled: false,
      apiKey: secret,
    }));

    const store = new CompanionStore({ stateDir });
    const safe = store.getModelApiConfig();
    assert.equal(safe.credentialStatus, "active");
    assert.equal(safe.credentialRevision, 1);
    assert.equal(safe.apiKeySet, true);
    assert.equal(JSON.stringify(safe).includes(secret), false);
    assert.match(safe.credentialRef ?? "", /^model-credential-[0-9a-f]{32}$/);

    const modelDocument = readFileSync(join(stateDir, "model-api.json"), "utf8");
    assert.equal(modelDocument.includes(secret), false);
    assert.equal(modelDocument.includes('"apiKey"'), false);
    assert.equal((JSON.parse(modelDocument) as { version: number }).version, 3);

    const credentialPath = join(stateDir, "model-credentials.json");
    const credentialDocument = readFileSync(credentialPath, "utf8");
    assert.equal(credentialDocument.includes(secret), true);
    assert.equal(lstatSync(credentialPath).mode & 0o777, 0o600);
    assert.equal(new CompanionStore({ stateDir }).getRawModelApiConfig().apiKey, secret);

    store.addModelContextTrace({
      sessionId: "credential-trace",
      mode: "sms",
      conversationSpace: "normal",
      payload: { apiKey: secret, nested: { authorization: `Bearer ${secret}` } },
      requestText: "credential redaction",
      turnKind: "user",
    });
    assert.equal(JSON.stringify(store.recentModelContextTraces()).includes(secret), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("external credential resolution and redaction discard untrusted secret fields", () => {
  const credentialRef = "model-credential-0123456789abcdef0123456789abcdef";
  const secret = "external-resolver-secret";
  const store = new ModelCredentialStore({
    clock: { now: () => new Date("2026-09-14T00:00:00.000Z") },
    externalResolver: () => ({
      credentialRef,
      status: "revoked",
      revision: 3,
      masked: secret,
      canRollback: true,
      apiKey: secret,
      createdAt: "not-a-timestamp",
    }),
  });
  const resolution = store.resolve(credentialRef, "default");
  assert.equal(resolution.status, "revoked");
  assert.equal(resolution.apiKey, undefined);
  assert.equal(resolution.masked, "");
  assert.equal(resolution.createdAt, undefined);
  assert.equal(JSON.stringify(resolution).includes(secret), false);

  const frozen = Object.freeze({
    content: Object.freeze([Object.freeze({ text: `echo ${secret}` })]),
  });
  const redacted = redactModelCredentialValue(frozen, secret);
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  assert.match(JSON.stringify(redacted), /redacted-model-credential/);
  assert.equal(JSON.stringify(frozen).includes(secret), true);
});

test("credential lifecycle verifies before commit and enforces CAS, rollback, and revoke", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-model-credential-lifecycle-"));
  const authorizations: string[] = [];
  const modelServer = createServer(async (request, response) => {
    const authorization = String(request.headers.authorization ?? "");
    authorizations.push(authorization);
    for await (const _chunk of request) {
      // Drain the candidate diagnostic body without retaining it.
    }
    if (authorization === "Bearer rejected-key") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "rejected-key" }));
      return;
    }
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        data: [{ id: `echo-${authorization.replace(/^Bearer /u, "")}` }],
      }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));

  const kernel = new CompanionKernel({
    stateDir,
    startScheduler: false,
    characterSkillReflector: false,
  });
  const httpServer = createHttpServer({ kernel });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  try {
    const modelAddress = modelServer.address();
    const httpAddress = httpServer.address();
    assert.ok(modelAddress && typeof modelAddress === "object");
    assert.ok(httpAddress && typeof httpAddress === "object");
    kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
      model: "credential-test-model",
    });
    const baseUrl = `http://127.0.0.1:${httpAddress.port}`;
    const credentialUrl = `${baseUrl}/api/v1/model-profiles/default/credential`;
    const bootstrap = await fetch(`${baseUrl}/`);
    const controlCookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(controlCookie);
    const controlHeaders = {
      cookie: controlCookie,
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    };
    const credentialRequest = (
      url: string,
      method: "PUT" | "POST",
      body: Record<string, unknown>,
    ) => jsonRequest(url, method, body, controlHeaders);

    const unauthorized = await jsonRequest(credentialUrl, "PUT", {
      apiKey: "must-not-be-sent",
      expectedRevision: 0,
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(authorizations.length, 0);

    const candidateDiscoveryUrl = `${baseUrl}/api/v1/diagnostics/model/models`;
    const unauthorizedDiscovery = await jsonRequest(candidateDiscoveryUrl, "POST", {
      profileId: "default",
      apiKey: "must-not-be-sent",
      expectedRevision: 0,
      profilePatch: { model: "" },
    });
    assert.equal(unauthorizedDiscovery.status, 403);
    assert.equal(authorizations.length, 0);

    const candidateDiscovery = await credentialRequest(candidateDiscoveryUrl, "POST", {
      profileId: "default",
      apiKey: "candidate-discovery-key",
      expectedRevision: 0,
      profilePatch: {
        enabled: true,
        baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        model: "",
      },
    });
    assert.equal(candidateDiscovery.status, 200);
    assert.deepEqual(candidateDiscovery.body.models, ["echo-[redacted-model-credential]"]);
    assert.equal(authorizations.at(-1), "Bearer candidate-discovery-key");
    assert.equal(kernel.getModelApiConfig().apiKeySet, false);
    assert.equal(kernel.getModelApiConfig().model, "credential-test-model");

    const callsBeforeInvalid = authorizations.length;
    const invalid = await credentialRequest(credentialUrl, "PUT", {
      expectedRevision: 0,
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.body.code, "MODEL_CREDENTIAL_INVALID");
    assert.equal(authorizations.length, callsBeforeInvalid);

    const incomplete = await credentialRequest(credentialUrl, "PUT", {
      apiKey: "incomplete-key",
      expectedRevision: 0,
      verify: true,
      profilePatch: { model: "" },
    });
    assert.equal(incomplete.status, 502);
    assert.equal(incomplete.body.code, "MODEL_CREDENTIAL_VERIFICATION_FAILED");
    assert.match(String(incomplete.body.error), /model is required/u);
    assert.equal(JSON.stringify(incomplete.body).includes("incomplete-key"), false);
    assert.equal(authorizations.length, callsBeforeInvalid);

    const created = await credentialRequest(credentialUrl, "PUT", {
      apiKey: "first-key",
      expectedRevision: 0,
      verify: true,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.profile.credentialStatus, "active");
    assert.equal(created.body.profile.credentialRevision, 1);
    assert.equal(JSON.stringify(created.body).includes("first-key"), false);
    assert.equal(kernel.store.getRawModelApiConfig().apiKey, "first-key");

    const rejected = await credentialRequest(credentialUrl, "PUT", {
      apiKey: "rejected-key",
      expectedRevision: 1,
      verify: true,
    });
    assert.equal(rejected.status, 502);
    assert.equal(rejected.body.code, "MODEL_CREDENTIAL_VERIFICATION_FAILED");
    assert.match(String(rejected.body.error), /model endpoint returned 401/u);
    assert.match(String(rejected.body.error), /redacted-model-credential/u);
    assert.equal(JSON.stringify(rejected.body).includes("rejected-key"), false);
    assert.equal(kernel.getModelApiConfig().credentialRevision, 1);
    assert.equal(kernel.store.getRawModelApiConfig().apiKey, "first-key");

    const rotated = await credentialRequest(credentialUrl, "PUT", {
      apiKey: "second-key",
      expectedRevision: 1,
      verify: true,
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.profile.credentialRevision, 2);
    assert.equal(rotated.body.profile.credentialCanRollback, true);

    const requestsBeforeConflict = authorizations.length;
    const conflicted = await credentialRequest(credentialUrl, "PUT", {
      apiKey: "stale-key",
      expectedRevision: 1,
      verify: true,
    });
    assert.equal(conflicted.status, 409);
    assert.equal(conflicted.body.code, "MODEL_CREDENTIAL_CONFLICT");
    assert.equal(conflicted.body.actualRevision, 2);
    assert.equal(authorizations.length, requestsBeforeConflict);
    assert.equal(kernel.store.getRawModelApiConfig().apiKey, "second-key");

    const rolledBack = await credentialRequest(`${credentialUrl}/rollback`, "POST", {
      expectedRevision: 2,
    });
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.body.profile.credentialRevision, 3);
    assert.equal(rolledBack.body.profile.credentialCanRollback, false);
    assert.equal(kernel.store.getRawModelApiConfig().apiKey, "first-key");

    const discovery = await fetch(
      `${baseUrl}/api/v1/diagnostics/model/models?profileId=default`,
    );
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json() as { models: string[] }).models, [
      "echo-[redacted-model-credential]",
    ]);

    const revoked = await credentialRequest(`${credentialUrl}/revoke`, "POST", {
      expectedRevision: 3,
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.profile.credentialStatus, "revoked");
    assert.equal(revoked.body.profile.credentialRevision, 4);
    assert.equal(kernel.store.getRawModelApiConfig().apiKey, undefined);
    assert.equal(kernel.modelProviders.isConfigured(kernel.store.getRawModelApiConfig()), false);

    const callsBeforeUnavailableDiagnostic = authorizations.length;
    const unavailable = await fetch(
      `${baseUrl}/api/v1/diagnostics/model/test?profileId=default`,
      { method: "POST" },
    );
    assert.equal(unavailable.status, 400);
    assert.equal(authorizations.length, callsBeforeUnavailableDiagnostic);
    const unavailableDiscovery = await fetch(
      `${baseUrl}/api/v1/diagnostics/model/models?profileId=default`,
    );
    assert.equal(unavailableDiscovery.status, 400);
    assert.equal(authorizations.length, callsBeforeUnavailableDiagnostic);

    const audit = JSON.stringify(kernel.store.allActions());
    const exported = JSON.stringify(await kernel.exportUserData());
    for (const secret of [
      "candidate-discovery-key",
      "incomplete-key",
      "first-key",
      "second-key",
      "rejected-key",
      "stale-key",
    ]) {
      assert.equal(audit.includes(secret), false);
      assert.equal(exported.includes(secret), false);
    }
  } finally {
    await closeServer(httpServer);
    kernel.dispose();
    await closeServer(modelServer);
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("credential references are profile-owned and a damaged credential store fails closed", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-model-credential-scope-"));
  try {
    const store = new CompanionStore({ stateDir });
    const first = store.patchModelApiConfig({ apiKey: "default-profile-key" });
    const second = store.createModelApiProfile({
      name: "second",
      apiKey: "second-profile-key",
    });
    assert.ok(first.credentialRef);
    assert.ok(second.credentialRef);

    const modelPath = join(stateDir, "model-api.json");
    const document = JSON.parse(readFileSync(modelPath, "utf8")) as {
      profiles: Array<{ id: string; credentialRef?: string }>;
    };
    const secondStored = document.profiles.find((profile) => profile.id === second.id);
    assert.ok(secondStored);
    secondStored.credentialRef = first.credentialRef;
    writeFileSync(modelPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });

    const reloaded = new CompanionStore({ stateDir });
    assert.equal(reloaded.getModelApiProfile(second.id)?.credentialStatus, "missing");
    assert.equal(reloaded.getRawModelApiProfile(second.id)?.apiKey, undefined);
    assert.equal(reloaded.getRawModelApiConfig().apiKey, "default-profile-key");
    const repaired = reloaded.setModelApiCredential(second.id, "repaired-profile-key", 0);
    assert.equal(repaired.credentialStatus, "active");
    assert.notEqual(repaired.credentialRef, first.credentialRef);
    assert.equal(reloaded.getRawModelApiProfile(second.id)?.apiKey, "repaired-profile-key");
    assert.equal(reloaded.getRawModelApiConfig().apiKey, "default-profile-key");

    const modelBeforeDamage = readFileSync(modelPath, "utf8");
    writeFileSync(join(stateDir, "model-credentials.json"), "{damaged", { mode: 0o600 });
    assert.throws(
      () => new CompanionStore({ stateDir }),
      ModelCredentialValidationError,
    );
    assert.equal(readFileSync(modelPath, "utf8"), modelBeforeDamage);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("verified backup and restore preserve the separate credential store without manifest leaks", () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-model-credential-backup-"));
  const stateDir = join(root, "state");
  const backupDir = join(root, "backup");
  const restoredDir = join(root, "restored");
  const secret = "backup-model-key-sentinel";
  let kernel: CompanionKernel | undefined;
  try {
    kernel = new CompanionKernel({
      stateDir,
      startScheduler: false,
      characterSkillReflector: false,
    });
    kernel.patchModelApiConfig({ apiKey: secret });
    kernel.dispose();
    kernel = undefined;

    execFileSync(process.execPath, ["scripts/backup-state.mjs", stateDir, backupDir], {
      cwd: process.cwd(),
    });
    const manifestText = readFileSync(join(backupDir, "backup-manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText) as {
      containsModelCredentials?: boolean;
      credentials?: { modelConfigPresent?: boolean; modelCredentialStorePresent?: boolean };
    };
    assert.equal(manifest.containsModelCredentials, true);
    assert.equal(manifest.credentials?.modelConfigPresent, true);
    assert.equal(manifest.credentials?.modelCredentialStorePresent, true);
    assert.equal(manifestText.includes(secret), false);
    assert.equal(readFileSync(join(backupDir, "model-api.json"), "utf8").includes(secret), false);
    assert.equal(readFileSync(join(backupDir, "model-credentials.json"), "utf8").includes(secret), true);

    execFileSync(process.execPath, ["scripts/restore-state.mjs", backupDir, restoredDir], {
      cwd: process.cwd(),
    });
    assert.equal(new CompanionStore({ stateDir: restoredDir }).getRawModelApiConfig().apiKey, secret);
  } finally {
    kernel?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("incognito resolves a selected credential without copying its secret file", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-model-credential-incognito-"));
  const snapshotTmpRoot = mkdtempSync(join(incognitoRoot, "yourchar-model-credential-snapshots-"));
  const secret = "incognito-scoped-model-key";
  const rootsBefore = incognitoSnapshotRoots(snapshotTmpRoot);
  const authorizations: string[] = [];
  const modelServer = createServer(async (request, response) => {
    authorizations.push(String(request.headers.authorization ?? ""));
    for await (const _chunk of request) {
      // Drain request bytes without retaining credential-bearing headers or bodies.
    }
    writeChatCompletionStream(
      response,
      authorizations.length === 1 ? "无痕凭据可用" : `恶意回显 ${secret}`,
    );
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const kernel = new CompanionKernel({
    stateDir,
    incognitoTmpRoot: snapshotTmpRoot,
    startScheduler: false,
    characterSkillReflector: false,
  });
  try {
    const address = modelServer.address();
    assert.ok(address && typeof address === "object");
    const profile = kernel.patchModelApiConfig({
      enabled: true,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "incognito-model",
      apiKey: secret,
    });
    const character = kernel.createCharacter({ name: "无痕凭据测试" });
    const incognito = await kernel.openIncognitoConversation(character.id);
    const snapshotRoot = [...incognitoSnapshotRoots(snapshotTmpRoot)]
      .find((path) => !rootsBefore.has(path));
    assert.ok(snapshotRoot);
    assert.equal(existsSync(join(snapshotRoot, "model-credentials.json")), false);
    const snapshotModel = readFileSync(join(snapshotRoot, "model-api.json"), "utf8");
    assert.equal(snapshotModel.includes(secret), false);
    assert.equal(snapshotModel.includes(profile.credentialRef ?? "missing-ref"), true);

    const response = await kernel.sendMessage(incognito.id, { text: "检查模型凭据" });
    assert.equal(response.reply, "无痕凭据可用");
    const echoed = await kernel.sendMessage(incognito.id, { text: "检查回显防护" });
    assert.equal(echoed.reply.includes(secret), false);
    assert.match(echoed.reply, /redacted-model-credential/);
    assert.equal(
      JSON.stringify(await kernel.getConversationTranscript(incognito.id)).includes(secret),
      false,
    );
    assert.deepEqual(authorizations, [`Bearer ${secret}`, `Bearer ${secret}`]);
    assert.throws(
      () => kernel.revokeModelApiCredential("default", profile.credentialRevision ?? 0),
      ControlPlaneBusyError,
    );
    await kernel.closeIncognitoConversation(incognito.id);
    assert.equal(existsSync(snapshotRoot), false);
  } finally {
    kernel.dispose();
    await closeServer(modelServer);
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(snapshotTmpRoot, { recursive: true, force: true });
  }
});

async function jsonRequest(
  url: string,
  method: "PUT" | "POST",
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, any> }> {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, any>,
  };
}

function incognitoSnapshotRoots(root = incognitoRoot): Set<string> {
  if (!existsSync(root)) return new Set();
  return new Set(readdirSync(root)
    .filter((name) => name.startsWith(incognitoPrefix))
    .map((name) => join(root, name)));
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function writeChatCompletionStream(response: ServerResponse, content: string): void {
  response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-p4c",
    object: "chat.completion.chunk",
    created: 1,
    model: "incognito-model",
    choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    id: "chatcmpl-p4c",
    object: "chat.completion.chunk",
    created: 1,
    model: "incognito-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  response.end("data: [DONE]\n\n");
}
