import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ActionRecord } from "../src/domain/types.js";
import type { MemoryCandidateInput } from "../src/memory-coordinator/types.js";
import { createHttpServer } from "../src/http/router.js";
import type { RpMemory } from "../src/rp/types.js";
import { AppDatabase } from "../src/storage/database.js";
import { createTestRuntime, type TestRuntime } from "../src/testing/runtime.js";

const QUERY = "isolationquery";
const NORMAL_MEMORY = "NORMAL_MEMORY_SENTINEL";
const NORMAL_RP_MEMORY = "NORMAL_RP_MEMORY_SENTINEL";
const NORMAL_PROFILE = "NORMAL_PROFILE_SENTINEL";
const NORMAL_HISTORY = "NORMAL_HISTORY_SENTINEL";
const SECRET_A_MEMORY = "SECRET_A_MEMORY_SENTINEL";
const SECRET_A_RP_MEMORY = "SECRET_A_RP_MEMORY_SENTINEL";
const SECRET_A_HISTORY = "SECRET_A_HISTORY_SENTINEL";
const SECRET_B_MEMORY = "SECRET_B_MEMORY_SENTINEL";
const SECRET_CAPTURE = "SECRET_CAPTURE_SENTINEL";
const SECRET_A_ACTION = "SECRET_A_ACTION_SENTINEL";
const SECRET_B_ACTION = "SECRET_B_ACTION_SENTINEL";
const SECRET_A_WORKSPACE_ACTION = "SECRET_A_WORKSPACE_ACTION_SENTINEL";

test("normal and per-character secret memory stay isolated in provider payloads, Vault, jobs, and restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-secret-memory-"));
  let runtime: TestRuntime | undefined;
  try {
    runtime = createTestRuntime({ stateDir, seed: "secret-memory-first" });
    const alpha = runtime.kernel.createCharacter({ name: "Secret Alpha" });
    const beta = runtime.kernel.createCharacter({ name: "Secret Beta" });
    runtime.kernel.updateUserProfile(`# 用户画像\n\n- ${NORMAL_PROFILE}`);

    const normal = active(runtime, {
      realm: "reality",
      type: "user_fact",
      content: `${QUERY} ${NORMAL_MEMORY}`,
    }, "same-idempotency-key");
    const normalRp = active(runtime, {
      realm: "roleplay",
      type: "plot_event",
      characterId: alpha.id,
      content: `${QUERY} ${NORMAL_RP_MEMORY}`,
    }, "normal-rp");
    const secretA = active(runtime, {
      conversationSpace: "secret",
      secretOwnerCharacterId: alpha.id,
      realm: "reality",
      type: "user_fact",
      content: `${QUERY} ${SECRET_A_MEMORY}`,
    }, "same-idempotency-key");
    const secretARp = active(runtime, {
      conversationSpace: "secret",
      secretOwnerCharacterId: alpha.id,
      realm: "roleplay",
      type: "plot_event",
      characterId: alpha.id,
      content: `${QUERY} ${SECRET_A_RP_MEMORY}`,
    }, "secret-a-rp");
    const secretB = active(runtime, {
      conversationSpace: "secret",
      secretOwnerCharacterId: beta.id,
      realm: "reality",
      type: "user_fact",
      content: `${QUERY} ${SECRET_B_MEMORY}`,
    }, "same-idempotency-key");

    assert.throws(() => active(runtime!, {
      conversationSpace: "secret",
      secretOwnerCharacterId: alpha.id,
      realm: "roleplay",
      type: "plot_event",
      characterId: beta.id,
      content: "SECRET_OWNER_MISMATCH_MUST_FAIL",
    }, "secret-owner-mismatch"), /secret character owner/);

    assert.notEqual(normal.id, secretA.id, "raw idempotency keys are scoped by conversation space");
    assert.notEqual(secretA.id, secretB.id, "secret idempotency keys are scoped by owner");
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, /SECRET_[AB]_/);

    const normalPlan = JSON.stringify(runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-normal",
      conversationSpace: "normal",
      characterId: alpha.id,
      query: QUERY,
      allowBootstrap: false,
    }));
    assert.match(normalPlan, new RegExp(NORMAL_MEMORY));
    assert.match(normalPlan, new RegExp(NORMAL_RP_MEMORY));
    assert.match(normalPlan, new RegExp(NORMAL_PROFILE));
    assertNoSentinels(normalPlan, [SECRET_A_MEMORY, SECRET_A_RP_MEMORY, SECRET_B_MEMORY]);

    const secretAPlan = JSON.stringify(runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-secret-a",
      conversationSpace: "secret",
      characterId: alpha.id,
      query: QUERY,
      allowBootstrap: false,
    }));
    assert.match(secretAPlan, new RegExp(SECRET_A_MEMORY));
    assert.match(secretAPlan, new RegExp(SECRET_A_RP_MEMORY));
    assertNoSentinels(secretAPlan, [NORMAL_MEMORY, NORMAL_RP_MEMORY, NORMAL_PROFILE, SECRET_B_MEMORY]);

    const secretBPlan = JSON.stringify(runtime.kernel.previewContextPlan({
      mode: "sms",
      sessionId: "preview-secret-b",
      conversationSpace: "secret",
      characterId: beta.id,
      query: QUERY,
      allowBootstrap: false,
    }));
    assert.match(secretBPlan, new RegExp(SECRET_B_MEMORY));
    assertNoSentinels(secretBPlan, [NORMAL_MEMORY, NORMAL_PROFILE, SECRET_A_MEMORY, SECRET_A_RP_MEMORY]);

    const normalVault = runtime.kernel.listMemoryVaultDocuments();
    const secretAVault = runtime.kernel.listMemoryVaultDocuments("secret", alpha.id);
    const secretBVault = runtime.kernel.listMemoryVaultDocuments("secret", beta.id);
    assert.equal(normalVault.some((entry) => entry.id === normal.id), true);
    assert.equal(normalVault.some((entry) => entry.id === normalRp.id), true);
    assert.equal(normalVault.some((entry) => entry.id === secretA.id || entry.id === secretB.id), false);
    assert.deepEqual(
      new Set(secretAVault.filter((entry) => entry.kind === "memory").map((entry) => entry.id)),
      new Set([secretA.id, secretARp.id]),
    );
    assert.deepEqual(
      secretBVault.filter((entry) => entry.kind === "memory").map((entry) => entry.id),
      [secretB.id],
    );
    const secretAPath = join(
      stateDir,
      "memory-vault",
      "secret",
      "characters",
      alpha.id,
      "memories",
      `${secretA.id}.md`,
    );
    assert.equal(existsSync(secretAPath), true);
    assert.match(
      readFileSync(secretAPath, "utf8"),
      new RegExp(`schemaVersion: 4[\\s\\S]*conversationSpace: secret[\\s\\S]*secretOwnerCharacterId: ${alpha.id}`),
    );

    runtime.model.enqueue([
      { kind: "assistant_text", text: "normal turn" },
      { kind: "assistant_text", text: "secret turn" },
      { kind: "assistant_text", text: "secret capture" },
      { kind: "assistant_text", text: "normal after secret" },
    ]);
    await runtime.kernel.sendMessage("memory-space-normal", {
      mode: "sms",
      conversationSpace: "normal",
      characterId: alpha.id,
      text: `${QUERY} ${NORMAL_HISTORY}`,
    });
    await runtime.kernel.sendMessage("memory-space-secret-a", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: alpha.id,
      text: `${QUERY} ${SECRET_A_HISTORY}`,
    });

    const firstNormalPayload = JSON.stringify(runtime.model.requests[0].providerPayload);
    assert.match(firstNormalPayload, new RegExp(NORMAL_MEMORY));
    assert.match(firstNormalPayload, new RegExp(NORMAL_PROFILE));
    assertNoSentinels(firstNormalPayload, [SECRET_A_MEMORY, SECRET_A_RP_MEMORY, SECRET_B_MEMORY, SECRET_A_HISTORY]);
    const firstSecretPayload = JSON.stringify(runtime.model.requests[1].providerPayload);
    assert.match(firstSecretPayload, new RegExp(SECRET_A_MEMORY));
    assert.match(firstSecretPayload, new RegExp(SECRET_A_RP_MEMORY));
    assertNoSentinels(firstSecretPayload, [NORMAL_MEMORY, NORMAL_RP_MEMORY, NORMAL_PROFILE, NORMAL_HISTORY, SECRET_B_MEMORY]);

    await runtime.kernel.sendMessage("memory-space-secret-a", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: alpha.id,
      text: `请记住：${QUERY} ${SECRET_CAPTURE}`,
    });
    await runtime.kernel.memoryCoordinator.drain();
    assert.equal(runtime.kernel.getMemoryCoordinatorStatus().recentJobs.some((entry) =>
      entry.sessionId === "memory-space-secret-a"
    ), false);
    const secretJob = runtime.kernel.getMemoryCoordinatorStatus("secret", alpha.id).recentJobs.find((entry) =>
      entry.sessionId === "memory-space-secret-a" && entry.triggerKind === "explicit"
    );
    assert.ok(secretJob);
    assert.equal(secretJob.conversationSpace, "secret");
    assert.equal(secretJob.secretOwnerCharacterId, alpha.id);
    assert.equal(secretJob.status, "completed");
    const captured = runtime.kernel.listMemories({
      query: SECRET_CAPTURE,
      realm: "reality",
      validity: "active",
      conversationSpace: "secret",
      secretOwnerCharacterId: alpha.id,
    });
    assert.equal(captured.length, 1);
    assert.equal(runtime.kernel.listMemories({
      query: SECRET_CAPTURE,
      realm: "reality",
      validity: "active",
      conversationSpace: "normal",
    }).length, 0);
    assert.equal(runtime.kernel.getUserInsightStatus().observationCount, 0);
    assert.doesNotMatch(runtime.kernel.getUserProfile().markdown, new RegExp(SECRET_CAPTURE));

    await runtime.kernel.sendMessage("memory-space-normal", {
      mode: "sms",
      conversationSpace: "normal",
      characterId: alpha.id,
      text: `${QUERY} NORMAL_AFTER_SECRET`,
    });
    const normalAfterSecret = JSON.stringify(runtime.model.requests[3].providerPayload);
    assertNoSentinels(normalAfterSecret, [SECRET_A_MEMORY, SECRET_A_RP_MEMORY, SECRET_A_HISTORY, SECRET_CAPTURE]);

    const blockedSoulUpdate = await runtime.kernel.sendMessage("memory-space-secret-a", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: alpha.id,
      text: "请修改你自己的人设。",
    });
    assert.equal(blockedSoulUpdate.actions[0]?.actionType, "request_character_soul_update");
    assert.equal(blockedSoulUpdate.actions[0]?.conversationSpace, "secret");
    assert.equal(blockedSoulUpdate.actions[0]?.secretOwnerCharacterId, alpha.id);

    const workspaceEntry = runtime.kernel.uploadSessionWorkspaceFile(
      "memory-space-secret-a",
      {
        name: `${SECRET_A_WORKSPACE_ACTION}.txt`,
        bytes: Buffer.from("private workspace action"),
      },
    );
    const movedWorkspaceEntry = runtime.kernel.moveSessionWorkspaceFile(
      "memory-space-secret-a",
      workspaceEntry.path,
      `${SECRET_A_WORKSPACE_ACTION}-moved.txt`,
    );
    runtime.kernel.deleteSessionWorkspaceFile(
      "memory-space-secret-a",
      movedWorkspaceEntry.path,
    );
    const workspaceActions = runtime.kernel.store.allActions().filter((action) =>
      action.actionType.startsWith("workspace_ui_") &&
      action.payload.sessionId === "memory-space-secret-a"
    );
    assert.equal(workspaceActions.length, 3);
    assert.ok(workspaceActions.every((action) =>
      action.conversationSpace === "secret" &&
      action.secretOwnerCharacterId === alpha.id
    ));

    const beforeEdit = await runtime.kernel.getConversationTranscript("memory-space-secret-a");
    const editableUser = beforeEdit.find((entry) => entry.role === "user" && entry.latestUser);
    assert.ok(editableUser);
    runtime.model.enqueue([{ kind: "assistant_text", text: "secret edited turn" }]);
    await runtime.kernel.editLatestUserMessage(
      "memory-space-secret-a",
      editableUser.entryId,
      "secret edited message",
    );
    await runtime.kernel.memoryCoordinator.drain();
    const beforeRetract = await runtime.kernel.getConversationTranscript("memory-space-secret-a");
    const retractableUser = beforeRetract.find((entry) => entry.role === "user" && entry.latestUser);
    assert.ok(retractableUser);
    await runtime.kernel.retractLatestUserMessage(
      "memory-space-secret-a",
      retractableUser.entryId,
    );
    for (const actionType of ["edit_user_message", "retract_user_message"]) {
      const scopedAction: ActionRecord | undefined = [
        ...runtime.kernel.store.allActions(),
      ].reverse().find((entry: ActionRecord) =>
        entry.actionType === actionType && entry.payload.sessionId === "memory-space-secret-a"
      );
      assert.equal(scopedAction?.conversationSpace, "secret");
      assert.equal(scopedAction?.secretOwnerCharacterId, alpha.id);
    }
    runtime.kernel.store.withActionScope({
      conversationSpace: "secret",
      secretOwnerCharacterId: alpha.id,
    }, () => runtime!.kernel.store.addAction("secret_action_fixture", "failed", {
      error: SECRET_A_ACTION,
    }));
    runtime.kernel.store.withActionScope({
      conversationSpace: "secret",
      secretOwnerCharacterId: beta.id,
    }, () => runtime!.kernel.store.addAction("secret_action_fixture", "failed", {
      error: SECRET_B_ACTION,
    }));

    const normalExport = JSON.stringify(await runtime.kernel.exportUserData());
    assert.match(normalExport, new RegExp(NORMAL_MEMORY));
    assert.match(normalExport, new RegExp(NORMAL_HISTORY));
    assertNoSentinels(normalExport, [
      SECRET_A_MEMORY,
      SECRET_A_RP_MEMORY,
      SECRET_A_HISTORY,
      SECRET_B_MEMORY,
      SECRET_CAPTURE,
      SECRET_A_ACTION,
      SECRET_B_ACTION,
      SECRET_A_WORKSPACE_ACTION,
    ]);
    const secretAExport = JSON.stringify(
      await runtime.kernel.exportUserData("secret", alpha.id),
    );
    assert.match(secretAExport, new RegExp(SECRET_A_MEMORY));
    assert.match(secretAExport, new RegExp(SECRET_A_RP_MEMORY));
    assert.match(secretAExport, new RegExp(SECRET_A_HISTORY));
    assert.match(secretAExport, new RegExp(SECRET_CAPTURE));
    assert.match(secretAExport, new RegExp(SECRET_A_ACTION));
    assert.match(secretAExport, new RegExp(SECRET_A_WORKSPACE_ACTION));
    assertNoSentinels(secretAExport, [
      NORMAL_MEMORY,
      NORMAL_RP_MEMORY,
      NORMAL_PROFILE,
      NORMAL_HISTORY,
      SECRET_B_MEMORY,
      SECRET_B_ACTION,
    ]);
    const normalExportActions = (await runtime.kernel.exportUserData()).actions;
    assert.equal(normalExportActions.some((action) =>
      action.actionType === "edit_user_message" ||
      action.actionType === "retract_user_message" ||
      (action.actionType.startsWith("workspace_ui_") &&
        action.payload.sessionId === "memory-space-secret-a")
    ), false);

    assert.equal(runtime.kernel.recentContextLogs(100).some((entry) =>
      entry.conversationSpace !== "normal" || entry.sessionId === "memory-space-secret-a"
    ), false);
    assert.equal(runtime.kernel.recentModelContextTraces(100).some((entry) =>
      entry.conversationSpace !== "normal" || entry.sessionId === "memory-space-secret-a"
    ), false);
    assert.equal(runtime.kernel.recentContextEconomics(100).some((entry) =>
      entry.conversationSpace !== "normal" || entry.sessionId === "memory-space-secret-a"
    ), false);
    assert.ok(runtime.kernel.store.recentContextLogs(100, "secret", alpha.id).some((entry) =>
      entry.sessionId === "memory-space-secret-a"
    ));
    assert.ok(runtime.kernel.contextEconomics.recent(100, "secret", alpha.id).some((entry) =>
      entry.sessionId === "memory-space-secret-a"
    ));

    const server = createHttpServer({ kernel: runtime.kernel });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const alphaScope = `conversationSpace=secret&characterId=${encodeURIComponent(alpha.id)}`;
      const betaScope = `conversationSpace=secret&characterId=${encodeURIComponent(beta.id)}`;
      const fetchJson = async (path: string) => JSON.stringify(await (await fetch(`${baseUrl}${path}`)).json());

      const normalLogs = await fetchJson("/api/debug/context-logs?limit=100");
      assert.match(normalLogs, /memory-space-normal/);
      assert.doesNotMatch(normalLogs, /memory-space-secret-a/);
      const secretLogs = await fetchJson(`/api/debug/context-logs?limit=100&${alphaScope}`);
      assert.match(secretLogs, /memory-space-secret-a/);
      assert.doesNotMatch(secretLogs, /memory-space-normal/);
      assert.doesNotMatch(await fetchJson(`/api/debug/context-logs?limit=100&${betaScope}`), /memory-space-secret-a/);

      const normalTraces = await fetchJson("/api/debug/model-traces?limit=20");
      assert.match(normalTraces, /memory-space-normal/);
      assert.doesNotMatch(normalTraces, /memory-space-secret-a/);
      const secretTraces = await fetchJson(`/api/debug/model-traces?limit=20&${alphaScope}`);
      assert.match(secretTraces, /memory-space-secret-a/);
      assert.doesNotMatch(secretTraces, /memory-space-normal/);

      const normalEconomics = await fetchJson("/api/debug/context-economics?limit=100");
      assert.match(normalEconomics, /memory-space-normal/);
      assert.doesNotMatch(normalEconomics, /memory-space-secret-a/);
      const secretEconomics = await fetchJson(`/api/debug/context-economics?limit=100&${alphaScope}`);
      assert.match(secretEconomics, /memory-space-secret-a/);
      assert.doesNotMatch(secretEconomics, /memory-space-normal/);

      assert.equal((await fetch(
        `${baseUrl}/api/debug/context-logs?conversationSpace=secret`,
      )).status, 400);
      const normalCoordinator = await fetchJson("/api/v1/memory-coordinator/status");
      assert.doesNotMatch(normalCoordinator, /memory-space-secret-a/);
      const secretCoordinator = await fetchJson(`/api/v1/memory-coordinator/status?${alphaScope}`);
      assert.match(secretCoordinator, /memory-space-secret-a/);

      const normalMemoryControlPlane = await fetchJson(
        `/api/v1/memories?query=${encodeURIComponent(QUERY)}`,
      );
      assert.match(normalMemoryControlPlane, new RegExp(NORMAL_RP_MEMORY));
      assertNoSentinels(normalMemoryControlPlane, [
        SECRET_A_MEMORY,
        SECRET_A_RP_MEMORY,
        SECRET_B_MEMORY,
      ]);
      const secretAMemoryControlPlane = await fetchJson(
        `/api/v1/memories?query=${encodeURIComponent(QUERY)}&${alphaScope}`,
      );
      assert.match(secretAMemoryControlPlane, new RegExp(SECRET_A_MEMORY));
      assert.match(secretAMemoryControlPlane, new RegExp(SECRET_A_RP_MEMORY));
      assertNoSentinels(secretAMemoryControlPlane, [NORMAL_MEMORY, NORMAL_RP_MEMORY, SECRET_B_MEMORY]);
      const secretBMemoryControlPlane = await fetchJson(
        `/api/v1/memories?query=${encodeURIComponent(QUERY)}&${betaScope}`,
      );
      assert.match(secretBMemoryControlPlane, new RegExp(SECRET_B_MEMORY));
      assertNoSentinels(secretBMemoryControlPlane, [NORMAL_MEMORY, SECRET_A_MEMORY, SECRET_A_RP_MEMORY]);

      const secretBHttpSentinel = "SECRET_B_HTTP_RP_MEMORY_SENTINEL";
      const createSecretBResponse = await fetch(`${baseUrl}/api/v1/memories?${betaScope}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          realm: "roleplay",
          scope: "character",
          type: "plot_event",
          characterId: beta.id,
          content: `${QUERY} ${secretBHttpSentinel}`,
          confirmed: true,
          idempotencyKey: "secret-b-http-roleplay",
        }),
      });
      assert.equal(createSecretBResponse.status, 201);
      const createdSecretB = (await createSecretBResponse.json() as {
        memory: RpMemory;
      }).memory;
      assert.equal(createdSecretB.conversationSpace, "secret");
      assert.equal(createdSecretB.secretOwnerCharacterId, beta.id);
      assert.equal((await fetch(`${baseUrl}/api/v1/memories?${betaScope}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          realm: "roleplay",
          scope: "character",
          type: "plot_event",
          characterId: alpha.id,
          content: "SECRET_WRONG_OWNER_CREATE_MUST_FAIL",
          confirmed: true,
        }),
      })).status, 400);

      const correctedSecretASentinel = "SECRET_A_HTTP_CORRECTED_SENTINEL";
      assert.equal((await fetch(
        `${baseUrl}/api/v1/memories/${encodeURIComponent(secretARp.id)}/correct?${betaScope}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: correctedSecretASentinel }),
        },
      )).status, 404);
      assert.equal((await fetch(
        `${baseUrl}/api/v1/memories/${encodeURIComponent(secretARp.id)}/correct?${alphaScope}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: `${QUERY} ${correctedSecretASentinel}` }),
        },
      )).status, 200);
      assert.equal((await fetch(
        `${baseUrl}/api/v1/memories/${encodeURIComponent(secretARp.id)}/correct`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "NORMAL_MUST_NOT_CORRECT_SECRET" }),
        },
      )).status, 404);
      assert.match(
        await fetchJson(`/api/v1/memories?query=${encodeURIComponent(correctedSecretASentinel)}&${alphaScope}`),
        new RegExp(correctedSecretASentinel),
      );
      assert.doesNotMatch(
        await fetchJson(`/api/v1/memories?query=${encodeURIComponent(correctedSecretASentinel)}`),
        new RegExp(correctedSecretASentinel),
      );
      assert.equal((await fetch(
        `${baseUrl}/api/v1/memories/${encodeURIComponent(createdSecretB.id)}?${alphaScope}`,
        { method: "DELETE" },
      )).status, 404);
      assert.equal((await fetch(
        `${baseUrl}/api/v1/memories/${encodeURIComponent(createdSecretB.id)}?${betaScope}`,
        { method: "DELETE" },
      )).status, 200);

      const secretRealityHttpSentinel = "SECRET_A_HTTP_REALITY_MEMORY_SENTINEL";
      const createRealityResponse = await fetch(
        `${baseUrl}/api/v1/reality-memories?${alphaScope}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "user_fact",
            content: `${QUERY} ${secretRealityHttpSentinel}`,
            idempotencyKey: "secret-a-http-reality",
          }),
        },
      );
      assert.equal(createRealityResponse.status, 201);
      assert.match(
        await fetchJson(`/api/v1/memories?query=${encodeURIComponent(secretRealityHttpSentinel)}&${alphaScope}`),
        new RegExp(secretRealityHttpSentinel),
      );
      assert.doesNotMatch(
        await fetchJson(`/api/v1/memories?query=${encodeURIComponent(secretRealityHttpSentinel)}`),
        new RegExp(secretRealityHttpSentinel),
      );

      runtime.kernel.database.connection.prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'failed', attempts = 1, last_error = 'test failure'
        WHERE id = ?
      `).run(secretJob.id);
      const hiddenRetry = await fetch(
        `${baseUrl}/api/v1/memory-coordinator/jobs/${encodeURIComponent(secretJob.id)}/retry`,
        { method: "POST" },
      );
      assert.notEqual(hiddenRetry.status, 200);
      assert.equal(runtime.kernel.memoryCoordinator.repository.getJob(secretJob.id)?.status, "failed");
      const scopedRetry = await fetch(
        `${baseUrl}/api/v1/memory-coordinator/jobs/${encodeURIComponent(secretJob.id)}/retry?${alphaScope}`,
        { method: "POST" },
      );
      assert.equal(scopedRetry.status, 200);
      await runtime.kernel.memoryCoordinator.drain();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }

    runtime.dispose();
    runtime = undefined;
    runtime = createTestRuntime({ stateDir, seed: "secret-memory-restart" });
    runtime.model.enqueue([
      { kind: "assistant_text", text: "normal restart" },
      { kind: "assistant_text", text: "secret restart" },
    ]);
    await runtime.kernel.sendMessage("memory-space-normal", {
      mode: "sms",
      conversationSpace: "normal",
      characterId: alpha.id,
      text: `${QUERY} NORMAL_RESTART`,
    });
    await runtime.kernel.sendMessage("memory-space-secret-a", {
      mode: "sms",
      conversationSpace: "secret",
      characterId: alpha.id,
      text: `${QUERY} SECRET_RESTART`,
    });
    const restartedNormal = JSON.stringify(runtime.model.requests[0].providerPayload);
    assert.match(restartedNormal, new RegExp(NORMAL_MEMORY));
    assert.match(restartedNormal, new RegExp(NORMAL_HISTORY));
    assertNoSentinels(restartedNormal, [SECRET_A_MEMORY, SECRET_A_RP_MEMORY, SECRET_A_HISTORY, SECRET_CAPTURE]);
    assert.doesNotMatch(
      JSON.stringify(await runtime.kernel.exportUserData()),
      new RegExp(`${SECRET_A_ACTION}|${SECRET_B_ACTION}`),
    );
    const restartedSecretExport = JSON.stringify(
      await runtime.kernel.exportUserData("secret", alpha.id),
    );
    assert.match(restartedSecretExport, new RegExp(SECRET_A_ACTION));
    assert.doesNotMatch(restartedSecretExport, new RegExp(SECRET_B_ACTION));
    const restartedSecret = JSON.stringify(runtime.model.requests[1].providerPayload);
    assert.match(restartedSecret, new RegExp(SECRET_A_MEMORY));
    assert.match(restartedSecret, new RegExp(SECRET_CAPTURE));
    assert.match(restartedSecret, new RegExp(SECRET_A_HISTORY));
    assertNoSentinels(restartedSecret, [NORMAL_MEMORY, NORMAL_RP_MEMORY, NORMAL_PROFILE, NORMAL_HISTORY, SECRET_B_MEMORY]);

    assert.deepEqual(runtime.kernel.listMemories({
      query: SECRET_CAPTURE,
      realm: "reality",
      validity: "active",
      conversationSpace: "secret",
      secretOwnerCharacterId: alpha.id,
    }).map((entry) => entry.id), captured.map((entry) => entry.id));
  } finally {
    runtime?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("v37 upgrades pre-space memory storage as normal and rebuilds scoped FTS", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-memory-v37-"));
  const databasePath = join(stateDir, "rp-agent.sqlite");
  let runtime: TestRuntime | undefined;
  try {
    runtime = createTestRuntime({ stateDir, seed: "memory-v37-fixture" });
    const memory = active(runtime, {
      realm: "reality",
      type: "project",
      content: `${QUERY} V37_NORMAL_MIGRATION_SENTINEL`,
    }, "v37-old-idempotency");
    runtime.dispose();
    runtime = undefined;

    downgradeMemoryScopeToV36(databasePath);
    const migrated = new AppDatabase(databasePath);
    try {
      const schema = migrated.connection.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number };
      assert.equal(Number(schema.version), 53);
      const row = migrated.connection.prepare(
        `SELECT conversation_space, secret_owner_character_id, idempotency_key
         FROM rp_memories WHERE id = ?`,
      ).get(memory.id) as Record<string, unknown>;
      assert.equal(row.conversation_space, "normal");
      assert.equal(row.secret_owner_character_id, null);
      assert.equal(row.idempotency_key, "v37:normal:v37-old-idempotency");
      const ftsColumns = migrated.connection.prepare("PRAGMA table_info(rp_memories_fts)")
        .all().map((entry) => String((entry as Record<string, unknown>).name));
      assert.deepEqual(ftsColumns, [
        "memory_id",
        "conversation_space",
        "secret_owner_character_id",
        "content",
        "tags",
      ]);
      const fts = migrated.connection.prepare(
        `SELECT memory_id FROM rp_memories_fts
         WHERE conversation_space = 'normal' AND secret_owner_character_id IS NULL
           AND rp_memories_fts MATCH 'isolationquery'`,
      ).all() as Array<{ memory_id: string }>;
      assert.deepEqual(fts.map((entry) => entry.memory_id), [memory.id]);
    } finally {
      migrated.close();
    }

    runtime = createTestRuntime({ stateDir, seed: "memory-v37-restart" });
    assert.deepEqual(runtime.kernel.listMemories({
      query: "V37_NORMAL_MIGRATION_SENTINEL",
      realm: "reality",
      validity: "active",
    }).map((entry) => entry.id), [memory.id]);
    assert.equal(runtime.kernel.listMemories({
      query: "V37_NORMAL_MIGRATION_SENTINEL",
      realm: "reality",
      validity: "active",
      conversationSpace: "secret",
      secretOwnerCharacterId: runtime.kernel.createCharacter({ name: "Migration Secret Owner" }).id,
    }).length, 0);
  } finally {
    runtime?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("stale reused v36-v38 markers repair the missing private-space schema", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "rp-agent-private-schema-drift-"));
  const databasePath = join(stateDir, "rp-agent.sqlite");
  let runtime: TestRuntime | undefined;
  try {
    runtime = createTestRuntime({ stateDir, seed: "private-schema-drift" });
    const memory = active(runtime, {
      realm: "reality",
      type: "project",
      content: `${QUERY} PRIVATE_SCHEMA_DRIFT_SENTINEL`,
    }, "private-schema-drift-key");
    runtime.kernel.database.connection.prepare(`
      INSERT INTO agent_module_settings(module_id, enabled, updated_at)
      VALUES ('skill:drift-fixture', 1, ?)
      ON CONFLICT(module_id) DO UPDATE SET enabled = 1, updated_at = excluded.updated_at
    `).run(runtime.clock.now().toISOString());
    runtime.dispose();
    runtime = undefined;

    downgradeMemoryScopeToV36(databasePath);
    const stale = new DatabaseSync(databasePath);
    try {
      stale.exec(`
        DROP TABLE agent_skill_space_settings;
        INSERT INTO schema_migrations(version, applied_at)
        VALUES (37, '2026-01-01T00:00:00.000Z');
      `);
    } finally {
      stale.close();
    }

    const repaired = new AppDatabase(databasePath);
    try {
      assert.equal(
        (repaired.connection.prepare(`
          SELECT normal_enabled FROM agent_skill_space_settings
          WHERE module_id = 'skill:drift-fixture'
        `).get() as { normal_enabled: number }).normal_enabled,
        1,
      );
      const row = repaired.connection.prepare(`
        SELECT conversation_space, secret_owner_character_id, idempotency_key
        FROM rp_memories WHERE id = ?
      `).get(memory.id) as Record<string, unknown>;
      assert.equal(row.conversation_space, "normal");
      assert.equal(row.secret_owner_character_id, null);
      assert.equal(row.idempotency_key, "v37:normal:private-schema-drift-key");
      assert.equal(
        (repaired.connection.prepare(`
          SELECT COUNT(*) AS count FROM schema_migrations WHERE version IN (36, 37, 38)
        `).get() as { count: number }).count,
        3,
      );
    } finally {
      repaired.close();
    }
  } finally {
    runtime?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function active(
  runtime: TestRuntime,
  input: Omit<MemoryCandidateInput, "sourceSessionId" | "sourceMessageId" | "idempotencyKey">,
  idempotencyKey: string,
): RpMemory {
  const sourceMessageId = runtime.kernel.store.idGenerator.next("secret-memory-source");
  return runtime.kernel.createControlPlaneMemory({
    ...input,
    sourceSessionId: "secret-memory-control-plane",
    sourceMessageId,
    idempotencyKey,
  });
}

function assertNoSentinels(payload: string, sentinels: string[]): void {
  for (const sentinel of sentinels) assert.doesNotMatch(payload, new RegExp(sentinel));
}

function downgradeMemoryScopeToV36(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      BEGIN IMMEDIATE;
      DROP INDEX rp_memories_character_idx;
      DROP INDEX rp_memories_key_idx;
      DROP INDEX rp_memories_retrieval_idx;
      DROP TABLE rp_memories_fts;
      ALTER TABLE rp_memories DROP COLUMN secret_owner_character_id;
      ALTER TABLE rp_memories DROP COLUMN conversation_space;
      UPDATE rp_memories
      SET idempotency_key = substr(idempotency_key, 12)
      WHERE idempotency_key LIKE 'v37:normal:%';
      CREATE INDEX rp_memories_character_idx
        ON rp_memories(realm, character_id, validity, confirmed);
      CREATE INDEX rp_memories_key_idx
        ON rp_memories(realm, character_id, memory_key, validity);
      CREATE INDEX rp_memories_retrieval_idx
        ON rp_memories(realm, validity, confirmed, salience DESC, updated_at DESC);
      CREATE VIRTUAL TABLE rp_memories_fts USING fts5(
        memory_id UNINDEXED, content, tags, tokenize = 'unicode61'
      );
      INSERT INTO rp_memories_fts(memory_id, content, tags)
      SELECT id, content, replace(replace(tags_json, '[', ''), ']', '')
      FROM rp_memories
      WHERE validity NOT IN ('rejected', 'archived', 'deleted');

      DROP INDEX memory_extraction_jobs_work_idx;
      DROP INDEX memory_extraction_jobs_recent_idx;
      DROP INDEX memory_extraction_jobs_lease_idx;
      ALTER TABLE memory_extraction_jobs DROP COLUMN secret_owner_character_id;
      ALTER TABLE memory_extraction_jobs DROP COLUMN conversation_space;
      CREATE INDEX memory_extraction_jobs_work_idx
        ON memory_extraction_jobs(status, available_at, created_at);
      CREATE INDEX memory_extraction_jobs_recent_idx
        ON memory_extraction_jobs(updated_at DESC, id DESC);
      CREATE INDEX memory_extraction_jobs_lease_idx
        ON memory_extraction_jobs(status, lease_expires_at, available_at);

      DROP INDEX context_economics_session_idx;
      ALTER TABLE context_economics DROP COLUMN secret_owner_character_id;
      ALTER TABLE context_economics DROP COLUMN conversation_space;
      CREATE INDEX context_economics_session_idx
        ON context_economics(session_id, sequence DESC);

      ALTER TABLE memory_context_sessions DROP COLUMN secret_owner_character_id;
      ALTER TABLE memory_context_sessions DROP COLUMN conversation_space;
      DROP INDEX memory_context_items_session_idx;
      ALTER TABLE memory_context_items DROP COLUMN secret_owner_character_id;
      ALTER TABLE memory_context_items DROP COLUMN conversation_space;
      CREATE INDEX memory_context_items_session_idx
        ON memory_context_items(session_id, injected_at DESC);

      DROP INDEX context_log_summaries_created_idx;
      DROP INDEX context_log_summaries_session_idx;
      ALTER TABLE context_log_summaries DROP COLUMN secret_owner_character_id;
      ALTER TABLE context_log_summaries DROP COLUMN conversation_space;
      CREATE INDEX context_log_summaries_created_idx
        ON context_log_summaries(created_at DESC);
      CREATE INDEX context_log_summaries_session_idx
        ON context_log_summaries(session_id, created_at DESC);

      DROP INDEX model_context_traces_session_idx;
      ALTER TABLE model_context_traces DROP COLUMN secret_owner_character_id;
      ALTER TABLE model_context_traces DROP COLUMN conversation_space;
      CREATE INDEX model_context_traces_session_idx
        ON model_context_traces(session_id, sequence DESC);

      DELETE FROM schema_migrations WHERE version = 37;
      COMMIT;
    `);
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  } finally {
    database.close();
  }
}
