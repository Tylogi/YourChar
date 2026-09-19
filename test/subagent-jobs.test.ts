import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
import {
  maximumSubagentFollowupTurns,
  maximumSubagentTranscriptBytes,
  SubagentJobStateError,
} from "../src/modules/subagent-jobs.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("legacy delegation records a durable, redacted job and exposes scoped list/get controls", async () => {
  const runtime = createTestRuntime({ seed: "subagent-durable-ledger" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const task = "DURABLE_SUBAGENT_TASK_SENTINEL: inspect the bounded fixture.";
  const context = "DURABLE_SUBAGENT_CONTEXT_SENTINEL";
  const output = "DURABLE_SUBAGENT_RESULT_SENTINEL: fixture is valid.";
  try {
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "delegate_task",
        arguments: { role: "reviewer", task, context },
      },
      { kind: "assistant_text", text: output },
      { kind: "assistant_text", text: "耐久子任务已经完成。" },
    ]);
    const response = await runtime.kernel.sendMessage("durable-subagent-parent", {
      mode: "sms",
      text: "请执行一次可追踪的独立核对。",
    });
    assert.equal(response.status, "completed");
    const initialRequest = runtime.model.requests[0];
    for (const toolName of [
      "delegate_task",
      "list_subagent_jobs",
      "get_subagent_job",
      "start_subagent_job",
      "interrupt_subagent_job",
      "send_subagent_message",
    ]) {
      assert.equal(initialRequest.toolNames.includes(toolName), true, `${toolName} must be mounted`);
    }

    const jobs = runtime.kernel.listSubagentJobs("durable-subagent-parent");
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    assert.equal(job.status, "completed");
    assert.equal(job.revision, 3);
    assert.match(job.childSessionId, /^subagent:durable-subagent-parent:/u);
    assert.equal(job.taskSha256, createHash("sha256").update(task).digest("hex"));
    assert.equal(job.taskCharacters, [...task].length);
    assert.equal(job.contextCharacters, [...context].length);
    assert.equal(job.grants.workspaceAccess, "read_only");
    assert.deepEqual(
      [...job.grants.toolNames].sort(),
      ["list_workspace", "read", "read_document"],
    );
    assert.equal(job.result?.modelCalls, 1);
    const summaryText = JSON.stringify(job);
    assert.doesNotMatch(summaryText, /DURABLE_SUBAGENT_(?:TASK|CONTEXT|RESULT)_SENTINEL/u);

    const detail = runtime.kernel.getSubagentJob("durable-subagent-parent", job.id);
    assert.equal(detail.output, output);
    assert.doesNotMatch(JSON.stringify(detail), /DURABLE_SUBAGENT_(?:TASK|CONTEXT)_SENTINEL/u);
    const raw = runtime.kernel.database.connection.prepare(`
      SELECT task_text, context_text FROM subagent_jobs WHERE id = ?
    `).get(job.id) as { task_text: string; context_text: string };
    assert.equal(raw.task_text, task);
    assert.equal(raw.context_text, context);

    const delegation = response.actions.find((action) => action.actionType === "delegate_subagent");
    assert.equal(delegation?.payload.jobId, job.id);
    assert.equal(delegation?.payload.childSessionId, job.childSessionId);
    assert.doesNotMatch(
      JSON.stringify(delegation),
      /DURABLE_SUBAGENT_(?:TASK|CONTEXT|RESULT)_SENTINEL/u,
    );

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const collectionPath = "/api/v1/sessions/durable-subagent-parent/subagent-jobs";
    const listedResponse = await fetch(`${baseUrl}${collectionPath}`);
    assert.equal(listedResponse.status, 200);
    const listedText = await listedResponse.text();
    assert.doesNotMatch(
      listedText,
      /DURABLE_SUBAGENT_(?:TASK|CONTEXT|RESULT)_SENTINEL/u,
    );
    const detailResponse = await fetch(`${baseUrl}${collectionPath}/${encodeURIComponent(job.id)}`);
    assert.equal(detailResponse.status, 200);
    const detailText = await detailResponse.text();
    assert.match(detailText, /DURABLE_SUBAGENT_RESULT_SENTINEL/u);
    assert.doesNotMatch(detailText, /DURABLE_SUBAGENT_(?:TASK|CONTEXT)_SENTINEL/u);

    runtime.model.enqueue([{ kind: "assistant_text", text: "另一个会话。" }]);
    await runtime.kernel.sendMessage("other-subagent-parent", {
      mode: "sms",
      text: "建立另一个隔离会话。",
    });
    const crossSession = await fetch(
      `${baseUrl}/api/v1/sessions/other-subagent-parent/subagent-jobs/${encodeURIComponent(job.id)}`,
    );
    assert.equal(crossSession.status, 404);

    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "list_subagent_jobs",
        arguments: { limit: 10 },
      },
      {
        kind: "tool_call",
        name: "get_subagent_job",
        arguments: { jobId: job.id, includeResult: true },
      },
      { kind: "assistant_text", text: "已核对耐久任务记录。" },
    ]);
    await runtime.kernel.sendMessage("durable-subagent-parent", {
      mode: "sms",
      text: "查看刚才的子任务状态和结果。",
    });
    const finalProviderPayload = JSON.stringify(runtime.model.requests.at(-1)?.providerPayload);
    assert.match(finalProviderPayload, /DURABLE_SUBAGENT_RESULT_SENTINEL/u);
    assert.match(finalProviderPayload, new RegExp(job.id, "u"));
    assert.equal(
      Number((runtime.kernel.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM subagent_job_deliveries WHERE job_id = ?
      `).get(job.id) as { count: number }).count),
      0,
      "blocking delegation already returns its result inline and must not enqueue a second delivery",
    );

    const metadata = runtime.kernel.listConversationMetadata()
      .find((entry) => entry.id === "durable-subagent-parent");
    assert.ok(metadata);
    await runtime.kernel.deleteConversation(
      metadata.id,
      metadata.title || metadata.id,
    );
    assert.equal(
      Number((runtime.kernel.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM subagent_jobs WHERE parent_session_id = ?
      `).get(metadata.id) as { count: number }).count),
      0,
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    runtime.dispose();
  }
});

test("a background Subagent job survives parent handle eviction and completes durably", async () => {
  const runtime = createTestRuntime({ seed: "subagent-background-completion" });
  const parentSessionId = "background-subagent-parent";
  const task = "BACKGROUND_SUBAGENT_PRIVATE_TASK_SENTINEL: inspect the isolated fixture.";
  const context = "BACKGROUND_SUBAGENT_PRIVATE_CONTEXT_SENTINEL";
  const output = "BACKGROUND_SUBAGENT_PRIVATE_RESULT_SENTINEL: fixture accepted.";
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立后台任务父会话。",
    });
    runtime.model.enqueue([{ kind: "assistant_text", text: output, delayMs: 120 }]);

    const admitted = runtime.kernel.startSubagentJob(parentSessionId, {
      role: "researcher",
      task,
      context,
    });
    assert.equal(admitted.status, "queued");
    assert.match(admitted.childSessionId, /^subagent:background-subagent-parent:/u);
    assert.equal(runtime.kernel.sessionRuntime.hasActiveSubagentJob(parentSessionId), true);

    runtime.kernel.sessionRuntime.invalidateSessionCapabilities(parentSessionId, "test_handle_eviction");
    await waitFor(() => runtime.model.requests.some((request) =>
      request.systemPrompt.includes("isolated researcher subagent")
    ));
    assert.throws(
      () => runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_only" }),
      /control-plane operations are unavailable while an Agent turn is active/u,
    );
    const metadata = runtime.kernel.getConversationMetadata(parentSessionId);
    assert.ok(metadata);
    assert.throws(
      () => runtime.kernel.assertConversationDeletable(
        parentSessionId,
        metadata.title || metadata.id,
      ),
      /busy and cannot be deleted/u,
    );

    await waitFor(() =>
      runtime.kernel.getSubagentJob(parentSessionId, admitted.id).status === "completed"
    );
    const completed = runtime.kernel.getSubagentJob(parentSessionId, admitted.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.output, output);
    assert.equal(completed.revision, 3);
    assert.equal(runtime.kernel.sessionRuntime.hasActiveSubagentJob(parentSessionId), false);
    assert.equal(runtime.model.pendingCount(), 0);
    const durableRun = runtime.kernel.database.connection.prepare(`
      SELECT status, attempt_count, model_calls, tool_calls, input_tokens,
        output_tokens, duration_ms, result_characters, checkpoint_at,
        owner_id, claim_token, lease_expires_at
      FROM subagent_job_runs WHERE job_id = ? AND generation = 1
    `).get(admitted.id) as Record<string, unknown>;
    assert.equal(durableRun.status, "completed");
    assert.equal(durableRun.attempt_count, 1);
    assert.equal(durableRun.model_calls, completed.result?.modelCalls);
    assert.equal(durableRun.tool_calls, completed.result?.toolCalls);
    assert.equal(durableRun.input_tokens, completed.result?.inputTokens);
    assert.equal(durableRun.output_tokens, completed.result?.outputTokens);
    assert.equal(durableRun.duration_ms, completed.result?.durationMs);
    assert.equal(durableRun.result_characters, [...output].length);
    assert.equal(typeof durableRun.checkpoint_at, "string");
    assert.equal(durableRun.owner_id, null);
    assert.equal(durableRun.claim_token, null);
    assert.equal(durableRun.lease_expires_at, null);

    const backgroundAudit = runtime.kernel.store.actions.find((action) =>
      action.actionType === "background_subagent_job" && action.payload.jobId === admitted.id
    );
    assert.equal(backgroundAudit?.status, "completed");
    assert.doesNotMatch(
      JSON.stringify(runtime.kernel.store.actions),
      /BACKGROUND_SUBAGENT_PRIVATE_(?:TASK|CONTEXT|RESULT)_SENTINEL/u,
    );
  } finally {
    runtime.dispose();
  }
});

test("background Subagent result delivery persists one reference and reconciles the post-append crash window", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-delivery-"));
  const parentSessionId = "background-subagent-delivery-parent";
  const task = "DELIVERY_PRIVATE_TASK_SENTINEL";
  const output = "DELIVERY_PRIVATE_RESULT_SENTINEL";
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "subagent-delivery-first",
  });
  try {
    first.kernel.setAgentModuleEnabled("mcp:subagent", true);
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立结果投递父会话。",
    });
    first.model.enqueue([{ kind: "assistant_text", text: output }]);
    const admitted = first.kernel.startSubagentJob(parentSessionId, {
      role: "worker",
      task,
    });
    await waitFor(() =>
      first?.kernel.getSubagentJob(parentSessionId, admitted.id).status === "completed"
    );
    await first.kernel.flushSubagentJobDeliveries(admitted.id);
    await waitFor(() => subagentDeliveryState(first!, admitted.id).status === "delivered");

    const delivered = await first.kernel.getSession(parentSessionId);
    const markers = subagentDeliveryMarkers(delivered.messages, admitted.id);
    assert.equal(markers.length, 1);
    assert.match(String(markers[0].content), new RegExp(admitted.id, "u"));
    assert.match(String(markers[0].content), /get_subagent_job/u);
    assert.doesNotMatch(String(markers[0].content), /DELIVERY_PRIVATE_(?:TASK|RESULT)_SENTINEL/u);
    assert.equal(
      first.kernel.store.allActions().filter((action) =>
        action.actionType === "deliver_subagent_job_result" &&
        action.payload.jobId === admitted.id
      ).length,
      1,
    );
    first.model.enqueue([{ kind: "assistant_text", text: "父 Agent 已收到结果引用。" }]);
    await first.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "检查刚才后台任务的状态。",
    });
    const nextParentRequest = first.model.requests.at(-1);
    assert.ok(nextParentRequest);
    assert.match(JSON.stringify(nextParentRequest.messages), new RegExp(admitted.id, "u"));
    assert.equal(nextParentRequest.toolNames.includes("get_subagent_job"), true);
    assert.doesNotMatch(
      JSON.stringify(nextParentRequest.messages),
      /DELIVERY_PRIVATE_(?:TASK|RESULT)_SENTINEL/u,
    );

    // Simulate a process loss after the Pi session append and audit commit but
    // before the delivery ACK reaches SQLite.
    first.kernel.database.connection.prepare(`
      UPDATE subagent_job_deliveries
      SET status = 'pending', delivered_at = NULL, updated_at = ?
      WHERE job_id = ? AND generation = 1
    `).run("2026-09-14T00:00:00.000Z", admitted.id);
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      seed: "subagent-delivery-second",
    });
    try {
      await second.kernel.flushSubagentJobDeliveries(admitted.id);
      await waitFor(() => subagentDeliveryState(second, admitted.id).status === "delivered");
      const reconciled = await second.kernel.getSession(parentSessionId);
      assert.equal(subagentDeliveryMarkers(reconciled.messages, admitted.id).length, 1);
      assert.equal(
        second.kernel.store.allActions().filter((action) =>
          action.actionType === "deliver_subagent_job_result" &&
          action.payload.jobId === admitted.id
        ).length,
        1,
      );
      assert.doesNotMatch(
        JSON.stringify(second.kernel.store.allActions()),
        /DELIVERY_PRIVATE_(?:TASK|RESULT)_SENTINEL/u,
      );
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a failed Subagent result append stays pending and retries without leaking diagnostics", async () => {
  const runtime = createTestRuntime({ seed: "subagent-delivery-retry" });
  const parentSessionId = "background-subagent-delivery-retry-parent";
  const privateOutput = "DELIVERY_RETRY_PRIVATE_RESULT_SENTINEL";
  const privateAppendError = "DELIVERY_RETRY_PRIVATE_APPEND_ERROR_SENTINEL";
  const sessionRuntime = runtime.kernel.sessionRuntime;
  const originalAppend = sessionRuntime.appendMessages.bind(sessionRuntime);
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立投递重试父会话。",
    });
    let rejectedOnce = false;
    sessionRuntime.appendMessages = ((handle, messages) => {
      if (!rejectedOnce && messages.some((message) =>
        message.role === "custom" && message.customType === "rp-agent/subagent_job_result"
      )) {
        rejectedOnce = true;
        throw new Error(privateAppendError);
      }
      originalAppend(handle, messages);
    }) as typeof sessionRuntime.appendMessages;
    runtime.model.enqueue([{ kind: "assistant_text", text: privateOutput }]);
    const admitted = runtime.kernel.startSubagentJob(parentSessionId, {
      role: "worker",
      task: "Run the private delivery retry fixture.",
    });
    await waitFor(() =>
      runtime.kernel.getSubagentJob(parentSessionId, admitted.id).status === "completed"
    );
    await waitFor(() => subagentDeliveryState(runtime, admitted.id).attempts >= 1);
    assert.equal(subagentDeliveryState(runtime, admitted.id).status, "pending");

    sessionRuntime.appendMessages = originalAppend;
    await runtime.kernel.flushSubagentJobDeliveries(admitted.id);
    await waitFor(() => subagentDeliveryState(runtime, admitted.id).status === "delivered");
    const parent = await runtime.kernel.getSession(parentSessionId);
    assert.equal(subagentDeliveryMarkers(parent.messages, admitted.id).length, 1);
    const audit = JSON.stringify(runtime.kernel.store.allActions());
    assert.match(audit, /deliver_subagent_job_result/u);
    assert.doesNotMatch(
      audit,
      /DELIVERY_RETRY_PRIVATE_(?:RESULT|APPEND_ERROR)_SENTINEL/u,
    );
  } finally {
    sessionRuntime.appendMessages = originalAppend;
    runtime.dispose();
  }
});

test("Subagent delivery rechecks the parent after loading its transcript", async () => {
  const runtime = createTestRuntime({ seed: "subagent-delivery-archive-race" });
  const parentSessionId = "background-subagent-delivery-archive-parent";
  const sessionRuntime = runtime.kernel.sessionRuntime;
  const originalTranscript = sessionRuntime.getConversationTranscript.bind(sessionRuntime);
  let archivedDuringRead = false;
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立归档竞态父会话。",
    });
    sessionRuntime.getConversationTranscript = (async (sessionId) => {
      const transcript = await originalTranscript(sessionId);
      if (sessionId === parentSessionId && !archivedDuringRead) {
        archivedDuringRead = true;
        runtime.kernel.archiveConversation(parentSessionId);
      }
      return transcript;
    }) as typeof sessionRuntime.getConversationTranscript;
    runtime.model.enqueue([{ kind: "assistant_text", text: "ARCHIVED_PRIVATE_RESULT_SENTINEL" }]);
    const admitted = runtime.kernel.startSubagentJob(parentSessionId, {
      role: "worker",
      task: "Complete the archive-race fixture.",
    });
    await waitFor(() =>
      runtime.kernel.getSubagentJob(parentSessionId, admitted.id).status === "completed"
    );
    await waitFor(() => subagentDeliveryState(runtime, admitted.id).status === "discarded");
    assert.equal(archivedDuringRead, true);
    assert.equal(
      subagentDeliveryMarkers(await originalTranscript(parentSessionId), admitted.id).length,
      0,
    );
  } finally {
    sessionRuntime.getConversationTranscript = originalTranscript;
    runtime.dispose();
  }
});

test("startup-style Subagent delivery drains more than one outbox page", async () => {
  const runtime = createTestRuntime({ seed: "subagent-delivery-pagination" });
  const parentSessionId = "background-subagent-delivery-pagination-parent";
  try {
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立积压投递父会话。",
    });
    const settings = runtime.kernel.getSubagentSettings();
    const budgets = {
      maxConcurrentTasks: settings.maxConcurrentTasks,
      maxWorkModelCalls: settings.maxWorkModelCalls,
      maxOutputTokens: settings.maxOutputTokens,
      maxResultCharacters: settings.maxResultCharacters,
      timeoutSeconds: settings.timeoutSeconds,
      timeoutMs: settings.timeoutSeconds * 1_000,
    };
    const grants = {
      workspaceAccess: "off" as const,
      moduleIds: [] as string[],
      skillNames: [] as string[],
      toolNames: [] as string[],
    };
    const jobIds: string[] = [];
    for (let index = 0; index < 101; index += 1) {
      const job = runtime.kernel.subagentJobs.create({
        parentSessionId,
        role: "worker",
        task: `Drain fixture ${index}`,
        mode: "sms",
        conversationSpace: "normal",
        budgets,
        grants,
        notifyParent: true,
      });
      runtime.kernel.subagentJobs.start(job.id, grants);
      runtime.kernel.subagentJobs.complete(job.id, subagentCompletion(`result ${index}`));
      jobIds.push(job.id);
    }

    assert.equal(await runtime.kernel.flushSubagentJobDeliveries(), 101);
    const counts = runtime.kernel.database.connection.prepare(`
      SELECT status, COUNT(*) AS count FROM subagent_job_deliveries GROUP BY status
    `).all() as Array<{ status: string; count: number }>;
    assert.deepEqual(
      counts.map((row) => ({ status: row.status, count: row.count })),
      [{ status: "delivered", count: 101 }],
    );
    const transcript = await runtime.kernel.getSession(parentSessionId);
    assert.equal(
      transcript.messages.filter((message) =>
        message.role === "custom" && message.customType === "rp-agent/subagent_job_result"
      ).length,
      jobIds.length,
    );
  } finally {
    runtime.dispose();
  }
});

test("interrupting a background Subagent job propagates cancellation and is idempotent", async () => {
  const runtime = createTestRuntime({ seed: "subagent-background-interrupt" });
  const parentSessionId = "interrupt-subagent-parent";
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立可取消任务的父会话。",
    });
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "INTERRUPTED_BACKGROUND_RESULT_MUST_NOT_PERSIST",
      delayMs: 500,
    }]);

    const admitted = runtime.kernel.startSubagentJob(parentSessionId, {
      role: "worker",
      task: "Wait until the host interrupts this background job.",
    });
    await waitFor(() => runtime.model.requests.some((request) =>
      request.systemPrompt.includes("isolated worker subagent")
    ));

    const cancelled = await runtime.kernel.interruptSubagentJob(parentSessionId, admitted.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.failure?.failureKind, "cancelled");
    assert.equal(runtime.kernel.getSubagentJob(parentSessionId, admitted.id).output, undefined);
    assert.equal(runtime.kernel.sessionRuntime.hasActiveSubagentJob(parentSessionId), false);
    const repeated = await runtime.kernel.interruptSubagentJob(parentSessionId, admitted.id);
    assert.equal(repeated.status, "cancelled");
    assert.equal(repeated.revision, cancelled.revision);
    await runtime.kernel.flushSubagentJobDeliveries(admitted.id);
    await waitFor(() => subagentDeliveryState(runtime, admitted.id).status === "delivered");
    const parent = await runtime.kernel.getSession(parentSessionId);
    const delivery = subagentDeliveryMarkers(parent.messages, admitted.id);
    assert.equal(delivery.length, 1);
    assert.match(String(delivery[0].content), /已取消/u);
    assert.doesNotMatch(String(delivery[0].content), /INTERRUPTED_BACKGROUND_RESULT_MUST_NOT_PERSIST/u);

    const backgroundAudit = runtime.kernel.store.actions.find((action) =>
      action.actionType === "background_subagent_job" && action.payload.jobId === admitted.id
    );
    assert.equal(backgroundAudit?.status, "failed");
    assert.equal(backgroundAudit?.payload.failureKind, "cancelled");
  } finally {
    runtime.dispose();
  }
});

test("background Subagent HTTP controls require the local capability and remain session-scoped", async () => {
  const runtime = createTestRuntime({ seed: "subagent-background-http" });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const parentSessionId = "http-subagent-parent";
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "HTTP 父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立 HTTP 后台任务父会话。",
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const endpoint = `${origin}/api/v1/sessions/${parentSessionId}/subagent-jobs`;
    const requestBody = {
      role: "reviewer",
      task: "HTTP_BACKGROUND_PRIVATE_TASK_SENTINEL",
      context: "HTTP_BACKGROUND_PRIVATE_CONTEXT_SENTINEL",
    };

    const rejected = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: JSON.stringify(requestBody),
    });
    assert.equal(rejected.status, 403);
    assert.equal(runtime.kernel.listSubagentJobs(parentSessionId).length, 0);

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const headers = { "content-type": "application/json", origin, cookie };
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "HTTP_BACKGROUND_PRIVATE_RESULT_SENTINEL",
      delayMs: 100,
    }]);
    const accepted = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const acceptedBody = await accepted.json() as { job: { id: string; status: string } };
    assert.equal(acceptedBody.job.status, "queued");
    await waitFor(() =>
      runtime.kernel.getSubagentJob(parentSessionId, acceptedBody.job.id).status === "completed"
    );
    const detailResponse = await fetch(`${endpoint}/${encodeURIComponent(acceptedBody.job.id)}`);
    assert.equal(detailResponse.status, 200);
    assert.match(await detailResponse.text(), /HTTP_BACKGROUND_PRIVATE_RESULT_SENTINEL/u);

    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "HTTP_FOLLOWUP_PRIVATE_RESULT_SENTINEL",
      delayMs: 100,
    }]);
    const followupResponse = await fetch(
      `${endpoint}/${encodeURIComponent(acceptedBody.job.id)}/messages`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ message: "HTTP_FOLLOWUP_PRIVATE_INPUT_SENTINEL" }),
      },
    );
    assert.equal(followupResponse.status, 202, await followupResponse.clone().text());
    const followupBody = await followupResponse.json() as {
      job: { status: string; continuation: { followupCount: number } };
    };
    assert.equal(followupBody.job.status, "queued");
    assert.equal(followupBody.job.continuation.followupCount, 1);
    await waitFor(() =>
      runtime.kernel.getSubagentJob(parentSessionId, acceptedBody.job.id).status === "completed"
    );
    const continuedDetailResponse = await fetch(
      `${endpoint}/${encodeURIComponent(acceptedBody.job.id)}`,
    );
    const continuedDetailText = await continuedDetailResponse.text();
    assert.match(continuedDetailText, /HTTP_FOLLOWUP_PRIVATE_RESULT_SENTINEL/u);
    assert.doesNotMatch(continuedDetailText, /HTTP_FOLLOWUP_PRIVATE_INPUT_SENTINEL/u);

    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "HTTP_INTERRUPTED_RESULT_MUST_NOT_PERSIST",
      delayMs: 500,
    }]);
    const interruptibleResponse = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ role: "planner", task: "Wait for HTTP interruption." }),
    });
    assert.equal(interruptibleResponse.status, 202);
    const interruptible = await interruptibleResponse.json() as { job: { id: string } };
    await waitFor(() =>
      runtime.kernel.getSubagentJob(parentSessionId, interruptible.job.id).status === "running"
    );
    const interrupted = await fetch(
      `${endpoint}/${encodeURIComponent(interruptible.job.id)}/interrupt`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(interrupted.status, 200, await interrupted.clone().text());
    const interruptedBody = await interrupted.json() as {
      job: { status: string; failure?: { failureKind: string } };
    };
    assert.equal(interruptedBody.job.status, "cancelled");
    assert.equal(interruptedBody.job.failure?.failureKind, "cancelled");

    runtime.model.enqueue([{ kind: "assistant_text", text: "另一个 HTTP 父会话。" }]);
    await runtime.kernel.sendMessage("other-http-subagent-parent", {
      mode: "sms",
      text: "建立另一个会话。",
    });
    const crossSessionInterrupt = await fetch(
      `${origin}/api/v1/sessions/other-http-subagent-parent/subagent-jobs/${encodeURIComponent(acceptedBody.job.id)}/interrupt`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(crossSessionInterrupt.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())
    );
    runtime.dispose();
  }
});

test("a completed Subagent transcript supports a scoped follow-up after process restart", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-continuation-"));
  const parentSessionId = "persistent-subagent-continuation-parent";
  const task = "PERSISTENT_SUBAGENT_ORIGINAL_TASK_SENTINEL";
  const firstOutput = "PERSISTENT_SUBAGENT_FIRST_RESULT_SENTINEL";
  const followup = "PERSISTENT_SUBAGENT_FOLLOWUP_INPUT_SENTINEL";
  const secondOutput = "PERSISTENT_SUBAGENT_SECOND_RESULT_SENTINEL";
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "subagent-continuation-first",
  });
  try {
    first.kernel.patchAgentPermissions({ workspaceAccess: "off" });
    first.kernel.setAgentModuleEnabled("mcp:subagent", true);
    first.model.enqueue([{ kind: "assistant_text", text: "持久父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, {
      mode: "sms",
      text: "建立可继续的子任务父会话。",
    });
    first.model.enqueue([{ kind: "assistant_text", text: firstOutput }]);
    const admitted = first.kernel.startSubagentJob(parentSessionId, {
      role: "planner",
      task,
    });
    await waitFor(() =>
      first?.kernel.getSubagentJob(parentSessionId, admitted.id).status === "completed"
    );
    const completed = first.kernel.getSubagentJob(parentSessionId, admitted.id);
    assert.equal(completed.continuation.transcriptStored, true);
    assert.equal(completed.continuation.available, true);
    assert.equal(completed.continuation.followupCount, 0);
    assert.equal(completed.grants.workspaceAccess, "off");

    first.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      seed: "subagent-continuation-second",
    });
    try {
      second.model.enqueue([{ kind: "assistant_text", text: secondOutput }]);
      const queued = second.kernel.sendSubagentMessage(
        parentSessionId,
        admitted.id,
        followup,
      );
      assert.equal(queued.status, "queued");
      assert.equal(queued.childSessionId, admitted.childSessionId);
      assert.equal(queued.continuation.followupCount, 1);
      assert.equal(queued.grants.workspaceAccess, "off");
      await waitFor(() =>
        second.kernel.getSubagentJob(parentSessionId, admitted.id).status === "completed"
      );

      const continued = second.kernel.getSubagentJob(parentSessionId, admitted.id);
      assert.equal(continued.output, secondOutput);
      assert.equal(continued.childSessionId, admitted.childSessionId);
      assert.equal(continued.continuation.transcriptStored, true);
      assert.equal(continued.continuation.available, true);
      assert.equal(continued.continuation.followupCount, 1);
      assert.deepEqual(continued.grants.toolNames, []);
      assert.equal(second.model.requests.length, 1);
      assert.deepEqual(second.model.requests[0].toolNames, []);
      const restoredProviderContext = JSON.stringify(second.model.requests[0].messages);
      assert.match(restoredProviderContext, new RegExp(task, "u"));
      assert.match(restoredProviderContext, new RegExp(firstOutput, "u"));
      assert.match(restoredProviderContext, new RegExp(followup, "u"));

      const raw = second.kernel.database.connection.prepare(`
        SELECT transcript_json, pending_input_text, followup_count
        FROM subagent_jobs WHERE id = ?
      `).get(admitted.id) as {
        transcript_json: string;
        pending_input_text: string | null;
        followup_count: number;
      };
      assert.match(raw.transcript_json, new RegExp(task, "u"));
      assert.match(raw.transcript_json, new RegExp(firstOutput, "u"));
      assert.match(raw.transcript_json, new RegExp(followup, "u"));
      assert.match(raw.transcript_json, new RegExp(secondOutput, "u"));
      assert.equal(raw.pending_input_text, null);
      assert.equal(raw.followup_count, 1);
      assert.doesNotMatch(
        JSON.stringify(continued),
        /PERSISTENT_SUBAGENT_(?:ORIGINAL_TASK|FIRST_RESULT|FOLLOWUP_INPUT)_SENTINEL/u,
      );
      assert.doesNotMatch(
        JSON.stringify(second.kernel.store.actions),
        /PERSISTENT_SUBAGENT_(?:ORIGINAL_TASK|FIRST_RESULT|FOLLOWUP_INPUT|SECOND_RESULT)_SENTINEL/u,
      );
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("Subagent continuation is CAS-bounded, cannot widen grants, and degrades safely at the transcript limit", () => {
  const runtime = createTestRuntime({ seed: "subagent-continuation-bounds" });
  try {
    const settings = runtime.kernel.getSubagentSettings();
    const budgets = {
      maxConcurrentTasks: settings.maxConcurrentTasks,
      maxWorkModelCalls: settings.maxWorkModelCalls,
      maxOutputTokens: settings.maxOutputTokens,
      maxResultCharacters: settings.maxResultCharacters,
      timeoutSeconds: settings.timeoutSeconds,
      timeoutMs: settings.timeoutSeconds * 1_000,
    };
    const grants = {
      workspaceAccess: "off" as const,
      moduleIds: [] as string[],
      skillNames: [] as string[],
      toolNames: [] as string[],
    };
    const created = runtime.kernel.subagentJobs.create({
      parentSessionId: "bounded-continuation-parent",
      role: "reviewer",
      task: "Review the bounded continuation fixture.",
      mode: "sms",
      conversationSpace: "normal",
      budgets,
      grants,
    });
    runtime.kernel.subagentJobs.start(created.id, grants);
    let transcript: unknown[] = [
      { role: "user", content: "initial private input" },
      { role: "assistant", content: [{ type: "text", text: "initial private output" }] },
    ];
    runtime.kernel.subagentJobs.complete(created.id, subagentCompletion("initial result"), transcript);

    assert.throws(
      () => runtime.kernel.subagentJobs.queueFollowup(
        created.parentSessionId,
        created.id,
        "attempt to widen",
        { ...grants, workspaceAccess: "read_only" },
      ),
      SubagentJobStateError,
    );
    assert.equal(runtime.kernel.subagentJobs.get(created.parentSessionId, created.id)?.revision, 3);

    for (let turn = 1; turn <= maximumSubagentFollowupTurns; turn += 1) {
      const prompt = `PRIVATE_BOUNDED_FOLLOWUP_${turn}`;
      const execution = runtime.kernel.subagentJobs.queueFollowup(
        created.parentSessionId,
        created.id,
        prompt,
        grants,
      );
      assert.equal(execution.job.status, "queued");
      assert.equal(execution.job.continuation.followupCount, turn);
      assert.equal(execution.prompt, prompt);
      assert.doesNotMatch(JSON.stringify(execution.job), /PRIVATE_BOUNDED_FOLLOWUP_/u);
      runtime.kernel.subagentJobs.start(created.id, grants);
      transcript = [
        ...transcript,
        { role: "user", content: prompt },
        { role: "assistant", content: [{ type: "text", text: `result ${turn}` }] },
      ];
      runtime.kernel.subagentJobs.complete(
        created.id,
        subagentCompletion(`result ${turn}`),
        transcript,
      );
    }
    const exhausted = runtime.kernel.subagentJobs.get(created.parentSessionId, created.id);
    assert.equal(exhausted?.continuation.available, false);
    assert.equal(exhausted?.continuation.followupCount, maximumSubagentFollowupTurns);
    assert.throws(
      () => runtime.kernel.subagentJobs.queueFollowup(
        created.parentSessionId,
        created.id,
        "one follow-up too many",
        grants,
      ),
      SubagentJobStateError,
    );

    const oversized = runtime.kernel.subagentJobs.create({
      parentSessionId: "bounded-continuation-parent",
      role: "worker",
      task: "Complete even if the private transcript is oversized.",
      mode: "sms",
      conversationSpace: "normal",
      budgets,
      grants,
    });
    runtime.kernel.subagentJobs.start(oversized.id, grants);
    const oversizedTranscript = [{
      role: "user",
      content: "x".repeat(maximumSubagentTranscriptBytes + 1),
    }];
    const completedWithoutTranscript = runtime.kernel.subagentJobs.complete(
      oversized.id,
      subagentCompletion("bounded result remains available"),
      oversizedTranscript,
    );
    assert.equal(completedWithoutTranscript.status, "completed");
    assert.equal(completedWithoutTranscript.output, "bounded result remains available");
    assert.equal(completedWithoutTranscript.continuation.transcriptStored, false);
    assert.equal(completedWithoutTranscript.continuation.available, false);
    const deliveries = runtime.kernel.database.connection.prepare(`
      SELECT generation, status FROM subagent_job_deliveries
      WHERE job_id = ? ORDER BY generation
    `).all(created.id) as Array<{ generation: number; status: string }>;
    assert.equal(deliveries.length, maximumSubagentFollowupTurns);
    assert.deepEqual(
      deliveries.map((delivery) => delivery.generation),
      Array.from({ length: maximumSubagentFollowupTurns }, (_, index) => index + 1),
    );
    assert.deepEqual(
      deliveries.map((delivery) => delivery.status),
      [...Array(maximumSubagentFollowupTurns - 1).fill("discarded"), "pending"],
    );
    const runs = runtime.kernel.database.connection.prepare(`
      SELECT generation, status, attempt_count FROM subagent_job_runs
      WHERE job_id = ? ORDER BY generation
    `).all(created.id) as Array<{
      generation: number;
      status: string;
      attempt_count: number;
    }>;
    assert.deepEqual(
      runs.map((run) => ({
        generation: run.generation,
        status: run.status,
        attemptCount: run.attempt_count,
      })),
      Array.from({ length: maximumSubagentFollowupTurns + 1 }, (_, index) => ({
        generation: index + 1,
        status: "completed",
        attemptCount: 1,
      })),
    );
  } finally {
    runtime.dispose();
  }
});

test("Subagent run claims fence stale writers and enforce cumulative frozen budgets", () => {
  const runtime = createTestRuntime({ seed: "subagent-run-claim-fencing" });
  try {
    const grants = {
      workspaceAccess: "off" as const,
      moduleIds: [] as string[],
      skillNames: [] as string[],
      toolNames: [] as string[],
    };
    const budgets = {
      maxConcurrentTasks: 1,
      maxWorkModelCalls: 1,
      maxOutputTokens: 512,
      maxResultCharacters: 1_000,
      timeoutSeconds: 60,
      timeoutMs: 60_000,
    };
    assert.throws(
      () => runtime.kernel.subagentJobs.create({
        parentSessionId: "invalid-budget-parent",
        role: "worker",
        task: "Reject a frozen budget beyond the configured ceiling.",
        mode: "sms",
        conversationSpace: "normal",
        budgets: { ...budgets, maxWorkModelCalls: 65 },
        grants,
      }),
      /budget maxWorkModelCalls is invalid/u,
    );
    const created = runtime.kernel.subagentJobs.create({
      parentSessionId: "fenced-run-parent",
      role: "worker",
      task: "Exercise durable run fencing and cumulative budgets.",
      mode: "sms",
      conversationSpace: "normal",
      budgets,
      grants,
    });
    const claim = runtime.kernel.subagentJobs.claimRun(
      created.id,
      grants,
      "test-run-owner",
    );
    assert.equal(claim.generation, 1);
    assert.equal(claim.attempt, 1);
    assert.deepEqual(claim.baseline, {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      resultCharacters: 0,
    });

    const checkpointTranscript = [{
      role: "assistant",
      content: [{ type: "text", text: "PRIVATE_RUN_CHECKPOINT_SENTINEL" }],
    }];
    const usage = runtime.kernel.subagentJobs.checkpointRun(
      claim,
      {
        modelCalls: 1,
        toolCalls: 0,
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 100,
      },
      checkpointTranscript,
    );
    assert.deepEqual(usage, {
      modelCalls: 1,
      toolCalls: 0,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 100,
      resultCharacters: 0,
    });
    const nonRegressingUsage = runtime.kernel.subagentJobs.checkpointRun(
      claim,
      {
        modelCalls: 0,
        toolCalls: 0,
        inputTokens: 1,
        outputTokens: 2,
        durationMs: 50,
      },
      checkpointTranscript,
    );
    assert.deepEqual(nonRegressingUsage, usage);
    assert.throws(
      () => runtime.kernel.subagentJobs.checkpointRun(
        claim,
        {
          modelCalls: 3,
          toolCalls: 0,
          inputTokens: 10,
          outputTokens: 20,
          durationMs: 100,
        },
        checkpointTranscript,
      ),
      /frozen cumulative run budget/u,
    );
    assert.throws(
      () => runtime.kernel.subagentJobs.complete(
        created.id,
        subagentCompletion("bounded"),
        checkpointTranscript,
        claim,
      ),
      /frozen result-size budget/u,
    );

    const failed = runtime.kernel.subagentJobs.fail(
      created.id,
      {
        failureKind: "runtime_error",
        modelCalls: 1,
        toolCalls: 0,
        inputTokens: 5,
        outputTokens: 10,
        durationMs: 110,
        forcedFinalization: false,
        retryable: true,
      },
      claim,
    );
    assert.equal(failed.status, "failed");
    assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_RUN_CHECKPOINT_SENTINEL/u);
    assert.throws(
      () => runtime.kernel.subagentJobs.checkpointRun(
        claim,
        {
          modelCalls: 1,
          toolCalls: 0,
          inputTokens: 10,
          outputTokens: 20,
          durationMs: 120,
        },
        checkpointTranscript,
      ),
      /active fenced run claim/u,
    );

    const persisted = runtime.kernel.database.connection.prepare(`
      SELECT status, attempt_count, model_calls, tool_calls,
        input_tokens, output_tokens, duration_ms, owner_id, claim_token
      FROM subagent_job_runs WHERE job_id = ? AND generation = 1
    `).get(created.id) as Record<string, unknown>;
    assert.deepEqual({ ...persisted }, {
      status: "failed",
      attempt_count: 1,
      model_calls: 1,
      tool_calls: 0,
      input_tokens: 10,
      output_tokens: 20,
      duration_ms: 110,
      owner_id: null,
      claim_token: null,
    });
  } finally {
    runtime.dispose();
  }
});

test("Subagent tool intents commit private results and make external replay explicit", () => {
  const runtime = createTestRuntime({ seed: "subagent-tool-journal" });
  try {
    const grants = {
      workspaceAccess: "off" as const,
      moduleIds: ["mcp:tavily-search"],
      skillNames: [] as string[],
      toolNames: ["tavily_search"],
    };
    const settings = runtime.kernel.getSubagentSettings();
    const created = runtime.kernel.subagentJobs.create({
      parentSessionId: "tool-journal-parent",
      role: "researcher",
      task: "Exercise the private tool side-effect journal.",
      mode: "sms",
      conversationSpace: "normal",
      budgets: {
        maxConcurrentTasks: settings.maxConcurrentTasks,
        maxWorkModelCalls: settings.maxWorkModelCalls,
        maxOutputTokens: settings.maxOutputTokens,
        maxResultCharacters: settings.maxResultCharacters,
        timeoutSeconds: settings.timeoutSeconds,
        timeoutMs: settings.timeoutSeconds * 1_000,
      },
      grants,
    });
    const claim = runtime.kernel.subagentJobs.claimRun(
      created.id,
      grants,
      "tool-journal-test-owner",
    );
    assert.throws(
      () => runtime.kernel.subagentJobs.recordToolCallStart(
        claim,
        { toolCallId: "ungranted-tool", toolName: "read", input: { path: "secret" } },
        {
          modelCalls: 1,
          toolCalls: 1,
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 1,
        },
        [{ role: "assistant", content: [] }],
      ),
      /tool inside the frozen run grant/u,
    );
    const firstCall = {
      toolCallId: "journal-tool-1",
      toolName: "tavily_search",
      input: { query: "PRIVATE_TOOL_ARGUMENT_SENTINEL" },
    };
    const firstTranscript = [{
      role: "assistant",
      content: [{
        type: "toolCall",
        id: firstCall.toolCallId,
        name: firstCall.toolName,
        arguments: firstCall.input,
      }],
    }];
    runtime.kernel.subagentJobs.recordToolCallStart(
      claim,
      firstCall,
      {
        modelCalls: 1,
        toolCalls: 1,
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 100,
      },
      firstTranscript,
    );
    const started = runtime.kernel.database.connection.prepare(`
      SELECT status, replay_policy, result_json FROM subagent_job_tool_calls
      WHERE job_id = ? AND generation = 1 AND attempt = 1 AND tool_call_id = ?
    `).get(created.id, firstCall.toolCallId) as Record<string, unknown>;
    assert.deepEqual({ ...started }, {
      status: "started",
      replay_policy: "explicit",
      result_json: null,
    });
    const checkpoint = runtime.kernel.database.connection.prepare(`
      SELECT transcript_json FROM subagent_jobs WHERE id = ?
    `).get(created.id) as { transcript_json: string };
    assert.match(checkpoint.transcript_json, /PRIVATE_TOOL_ARGUMENT_SENTINEL/u);
    assert.throws(
      () => runtime.kernel.subagentJobs.recordToolCallStart(
        claim,
        firstCall,
        {
          modelCalls: 1,
          toolCalls: 1,
          inputTokens: 10,
          outputTokens: 20,
          durationMs: 100,
        },
        firstTranscript,
      ),
      /new fenced tool call journal-tool-1/u,
    );
    const firstResult = {
      ...firstCall,
      content: [{ type: "text", text: "PRIVATE_TOOL_RESULT_SENTINEL" }],
      details: { resultCount: 1 },
      isError: false,
    };
    runtime.kernel.subagentJobs.recordToolCallResult(claim, firstResult);
    runtime.kernel.subagentJobs.recordToolCallResult(claim, firstResult);
    assert.throws(
      () => runtime.kernel.subagentJobs.recordToolCallResult(claim, {
        ...firstResult,
        content: [{ type: "text", text: "a different result" }],
      }),
      /immutable tool result commit/u,
    );

    const secondCall = {
      toolCallId: "journal-tool-2",
      toolName: "tavily_search",
      input: { query: "PRIVATE_UNSERIALIZABLE_ARGUMENT_CONTEXT" },
    };
    runtime.kernel.subagentJobs.recordToolCallStart(
      claim,
      secondCall,
      {
        modelCalls: 1,
        toolCalls: 2,
        inputTokens: 10,
        outputTokens: 20,
        durationMs: 120,
      },
      [{
        role: "assistant",
        content: [
          ...firstTranscript[0].content,
          {
            type: "toolCall",
            id: secondCall.toolCallId,
            name: secondCall.toolName,
            arguments: secondCall.input,
          },
        ],
      }],
    );
    const circularDetails: Record<string, unknown> = {};
    circularDetails.self = circularDetails;
    runtime.kernel.subagentJobs.recordToolCallResult(claim, {
      ...secondCall,
      content: [{ type: "text", text: "PRIVATE_UNSTORED_TOOL_RESULT_SENTINEL" }],
      details: circularDetails,
      isError: true,
    });

    const rows = runtime.kernel.database.connection.prepare(`
      SELECT model_call, tool_call_id, tool_name, replay_policy, status, arguments_sha256,
        arguments_bytes, result_json, result_sha256, result_bytes, is_error,
        result_reason
      FROM subagent_job_tool_calls
      WHERE job_id = ? AND generation = 1 ORDER BY tool_call_id
    `).all(created.id) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.deepEqual({ ...rows[0] }, {
      tool_call_id: "journal-tool-1",
      model_call: 1,
      tool_name: "tavily_search",
      replay_policy: "explicit",
      status: "committed",
      arguments_sha256: rows[0].arguments_sha256,
      arguments_bytes: rows[0].arguments_bytes,
      result_json: rows[0].result_json,
      result_sha256: rows[0].result_sha256,
      result_bytes: rows[0].result_bytes,
      is_error: 0,
      result_reason: null,
    });
    assert.match(String(rows[0].arguments_sha256), /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(rows[0]), /PRIVATE_TOOL_ARGUMENT_SENTINEL/u);
    assert.match(String(rows[0].result_json), /PRIVATE_TOOL_RESULT_SENTINEL/u);
    assert.match(String(rows[0].result_sha256), /^[a-f0-9]{64}$/u);
    assert.deepEqual({ ...rows[1] }, {
      tool_call_id: "journal-tool-2",
      model_call: 1,
      tool_name: "tavily_search",
      replay_policy: "explicit",
      status: "result_unavailable",
      arguments_sha256: rows[1].arguments_sha256,
      arguments_bytes: rows[1].arguments_bytes,
      result_json: null,
      result_sha256: null,
      result_bytes: null,
      is_error: 1,
      result_reason: "not_json",
    });
    assert.doesNotMatch(JSON.stringify(rows[1]), /PRIVATE_(?:UNSERIALIZABLE|UNSTORED)_/u);
    assert.doesNotMatch(
      JSON.stringify(runtime.kernel.subagentJobs.get(created.parentSessionId, created.id)),
      /PRIVATE_TOOL_(?:ARGUMENT|RESULT)_SENTINEL/u,
    );
    runtime.kernel.subagentJobs.fail(created.id, {
      failureKind: "runtime_error",
      modelCalls: 1,
      toolCalls: 2,
      inputTokens: 10,
      outputTokens: 20,
      durationMs: 130,
      forcedFinalization: false,
      retryable: true,
    }, claim);
  } finally {
    runtime.dispose();
  }
});

test("orderly shutdown releases a live Subagent fence for immediate restart recovery", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-orderly-recovery-"));
  const parentSessionId = "orderly-recovery-parent";
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "orderly-recovery-first",
  });
  try {
    first.kernel.setAgentModuleEnabled("mcp:subagent", true);
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, { mode: "sms", text: "建立恢复父会话。" });
    first.model.enqueue([{
      kind: "assistant_text",
      text: "ORDERLY_RECOVERY_STALE_RESULT_MUST_NOT_COMMIT",
      delayMs: 250,
    }]);
    const started = first.kernel.startSubagentJob(parentSessionId, {
      role: "worker",
      task: "ORDERLY_RECOVERY_PRIVATE_TASK_SENTINEL",
    });
    await waitFor(() => first?.kernel.getSubagentJob(parentSessionId, started.id).status === "running");
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      seed: "orderly-recovery-second",
      initialModelResponses: [{
        kind: "assistant_text",
        text: "ORDERLY_RECOVERY_FRESH_RESULT_SENTINEL",
      }],
    });
    try {
      await waitFor(() => second.kernel.getSubagentJob(parentSessionId, started.id).status === "completed");
      const recovered = second.kernel.getSubagentJob(parentSessionId, started.id);
      assert.equal(recovered.output, "ORDERLY_RECOVERY_FRESH_RESULT_SENTINEL");
      assert.equal(recovered.recoveryCount, 1);
      const run = second.kernel.database.connection.prepare(`
        SELECT status, attempt_count, owner_id, claim_token
        FROM subagent_job_runs WHERE job_id = ? AND generation = 1
      `).get(started.id) as Record<string, unknown>;
      assert.deepEqual({ ...run }, {
        status: "completed",
        attempt_count: 2,
        owner_id: null,
        claim_token: null,
      });
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("recovery never steals a live lease and fences its owner after expiry", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-lease-recovery-"));
  const parentSessionId = "lease-recovery-parent";
  const runtime = createTestRuntime({
    stateDir,
    seed: "lease-recovery-first",
  });
  try {
    runtime.kernel.setAgentModuleEnabled("mcp:subagent", true);
    runtime.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await runtime.kernel.sendMessage(parentSessionId, { mode: "sms", text: "建立租约恢复父会话。" });
    const settings = runtime.kernel.getSubagentSettings();
    const created = runtime.kernel.subagentJobs.create({
      parentSessionId,
      role: "worker",
      task: "LEASE_RECOVERY_PRIVATE_TASK_SENTINEL",
      mode: "sms",
      conversationSpace: "normal",
      budgets: { ...settings, timeoutMs: settings.timeoutSeconds * 1_000 },
      grants: {
        workspaceAccess: "off",
        moduleIds: [],
        skillNames: [],
        toolNames: [],
      },
    });
    const originalClaim = runtime.kernel.subagentJobs.claimRun(
      created.id,
      created.grants,
      "lease-recovery-live-owner",
    );

    assert.equal(runtime.kernel.sessionRuntime.recoverSubagentJobs(), 0);
    const stillOwned = runtime.kernel.getSubagentJob(parentSessionId, created.id);
    assert.equal(stillOwned.status, "running");
    assert.equal(stillOwned.recoveryCount, 0);
    assert.equal(runtime.model.requests.length, 1);

    runtime.kernel.database.connection.prepare(`
      UPDATE subagent_job_runs SET lease_expires_at = ?
      WHERE job_id = ? AND generation = 1
    `).run("2025-12-31T23:59:59.000Z", created.id);
    runtime.model.enqueue([{
      kind: "assistant_text",
      text: "LEASE_RECOVERY_FRESH_RESULT_SENTINEL",
    }]);
    assert.equal(runtime.kernel.sessionRuntime.recoverSubagentJobs(), 1);
    await waitFor(() => runtime.kernel.getSubagentJob(parentSessionId, created.id).status === "completed");
    const recovered = runtime.kernel.getSubagentJob(parentSessionId, created.id);
    assert.equal(recovered.output, "LEASE_RECOVERY_FRESH_RESULT_SENTINEL");
    assert.equal(recovered.recoveryCount, 1);
    const run = runtime.kernel.database.connection.prepare(`
      SELECT status, attempt_count, owner_id, claim_token
      FROM subagent_job_runs WHERE job_id = ? AND generation = 1
    `).get(created.id) as Record<string, unknown>;
    assert.deepEqual({ ...run }, {
      status: "completed",
      attempt_count: 2,
      owner_id: null,
      claim_token: null,
    });
    assert.throws(
      () => runtime.kernel.subagentJobs.checkpointRun(
        originalClaim,
        { modelCalls: 1, toolCalls: 0, inputTokens: 1, outputTokens: 1, durationMs: 1 },
        [],
      ),
      /fenced run claim/u,
    );
  } finally {
    runtime.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("startup recovery automatically resumes durable queued Subagent work", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-job-recovery-"));
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "subagent-job-recovery-first",
  });
  try {
    first.kernel.setAgentModuleEnabled("mcp:subagent", true);
    first.kernel.patchAgentPermissions({ workspaceAccess: "read_write" });
    first.model.enqueue([{ kind: "assistant_text", text: "持久父会话已建立。" }]);
    await first.kernel.sendMessage("recoverable-subagent-parent", {
      mode: "sms",
      text: "建立用于恢复测试的父会话。",
    });
    const settings = first.kernel.getSubagentSettings();
    const queued = first.kernel.subagentJobs.create({
      parentSessionId: "recoverable-subagent-parent",
      role: "planner",
      task: "RECOVERED_SUBAGENT_PRIVATE_TASK_SENTINEL",
      context: "RECOVERED_SUBAGENT_PRIVATE_CONTEXT_SENTINEL",
      mode: "sms",
      conversationSpace: "normal",
      timezone: "America/Los_Angeles",
      budgets: {
        maxConcurrentTasks: settings.maxConcurrentTasks,
        maxWorkModelCalls: settings.maxWorkModelCalls,
        maxOutputTokens: settings.maxOutputTokens,
        maxResultCharacters: settings.maxResultCharacters,
        timeoutSeconds: settings.timeoutSeconds,
        timeoutMs: settings.timeoutSeconds * 1_000,
      },
      grants: {
        workspaceAccess: "read_only",
        moduleIds: [],
        skillNames: [],
        toolNames: [],
      },
    });
    assert.equal(queued.status, "queued");
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      seed: "subagent-job-recovery-second",
      initialModelResponses: [{
        kind: "assistant_text",
        text: "RECOVERED_SUBAGENT_AUTOMATIC_RESULT_SENTINEL",
      }],
    });
    try {
      await waitFor(() => second.kernel.getSubagentJob(
        "recoverable-subagent-parent",
        queued.id,
      ).status === "completed");
      const recovered = second.kernel.getSubagentJob(
        "recoverable-subagent-parent",
        queued.id,
      );
      assert.equal(recovered.status, "completed");
      assert.equal(recovered.output, "RECOVERED_SUBAGENT_AUTOMATIC_RESULT_SENTINEL");
      assert.equal(recovered.recoveryCount, 1);
      assert.equal(recovered.recovery, undefined);
      assert.doesNotMatch(
        JSON.stringify(recovered),
        /RECOVERED_SUBAGENT_PRIVATE_(?:TASK|CONTEXT)_SENTINEL/u,
      );
      assert.equal(second.model.requests.length, 1);
      assert.match(second.model.requests[0].systemPrompt, /\(America\/Los_Angeles\)/u);
      assert.deepEqual(
        [...second.model.requests[0].toolNames].sort(),
        ["list_workspace", "read", "read_document"],
      );
      assert.match(
        JSON.stringify(second.model.requests[0].messages),
        /RECOVERED_SUBAGENT_PRIVATE_TASK_SENTINEL/u,
      );
      const raw = second.kernel.database.connection.prepare(
        "SELECT task_text, context_text FROM subagent_jobs WHERE id = ?",
      ).get(queued.id) as { task_text: string; context_text: string };
      assert.equal(raw.task_text, "RECOVERED_SUBAGENT_PRIVATE_TASK_SENTINEL");
      assert.equal(raw.context_text, "RECOVERED_SUBAGENT_PRIVATE_CONTEXT_SENTINEL");
      const recoveredRun = second.kernel.database.connection.prepare(`
        SELECT status, attempt_count, owner_id, claim_token, lease_expires_at
        FROM subagent_job_runs WHERE job_id = ? AND generation = 1
      `).get(queued.id) as Record<string, unknown>;
      assert.deepEqual({ ...recoveredRun }, {
        status: "completed",
        attempt_count: 1,
        owner_id: null,
        claim_token: null,
        lease_expires_at: null,
      });
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("startup recovery reconciles committed results and safely retries interrupted local reads", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-tool-recovery-"));
  const parentSessionId = "tool-recovery-parent";
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "tool-recovery-first",
  });
  try {
    first.kernel.setAgentModuleEnabled("mcp:subagent", true);
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, { mode: "sms", text: "建立恢复父会话。" });
    const settings = first.kernel.getSubagentSettings();
    const grants = {
      workspaceAccess: "off" as const,
      moduleIds: [] as string[],
      skillNames: [] as string[],
      toolNames: ["tavily_search", "read"],
    };
    const created = first.kernel.subagentJobs.create({
      parentSessionId,
      role: "researcher",
      task: "RECOVERY_RECONCILIATION_PRIVATE_TASK_SENTINEL",
      mode: "sms",
      conversationSpace: "normal",
      budgets: {
        ...settings,
        timeoutMs: settings.timeoutSeconds * 1_000,
      },
      grants,
    });
    const claim = first.kernel.subagentJobs.claimRun(
      created.id,
      grants,
      "tool-recovery-owner",
    );
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "RECOVERY_RECONCILIATION_PRIVATE_TASK_SENTINEL" }],
      timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
    };
    const assistantMessage = {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "committed-external-call",
          name: "tavily_search",
          arguments: { query: "RECOVERY_EXTERNAL_ARGUMENT_SENTINEL" },
        },
        {
          type: "toolCall",
          id: "interrupted-local-read",
          name: "read",
          arguments: { path: "RECOVERY_LOCAL_READ_ARGUMENT_SENTINEL" },
        },
      ],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
    };
    const transcript = [userMessage, assistantMessage];
    first.kernel.subagentJobs.recordToolCallStart(
      claim,
      {
        toolCallId: "committed-external-call",
        toolName: "tavily_search",
        input: { query: "RECOVERY_EXTERNAL_ARGUMENT_SENTINEL" },
      },
      { modelCalls: 1, toolCalls: 1, inputTokens: 10, outputTokens: 10, durationMs: 100 },
      transcript,
    );
    first.kernel.subagentJobs.recordToolCallStart(
      claim,
      {
        toolCallId: "interrupted-local-read",
        toolName: "read",
        input: { path: "RECOVERY_LOCAL_READ_ARGUMENT_SENTINEL" },
      },
      { modelCalls: 1, toolCalls: 2, inputTokens: 10, outputTokens: 10, durationMs: 120 },
      transcript,
    );
    first.kernel.subagentJobs.recordToolCallResult(claim, {
      toolCallId: "committed-external-call",
      toolName: "tavily_search",
      input: { query: "RECOVERY_EXTERNAL_ARGUMENT_SENTINEL" },
      content: [{ type: "text", text: "RECOVERY_COMMITTED_TOOL_RESULT_SENTINEL" }],
      isError: false,
    });
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      now: "2026-01-01T01:00:00.000Z",
      seed: "tool-recovery-second",
      initialModelResponses: [{
        kind: "assistant_text",
        text: "RECOVERY_RECONCILIATION_FINAL_RESULT_SENTINEL",
      }],
    });
    try {
      await waitFor(() => second.kernel.getSubagentJob(parentSessionId, created.id).status === "completed");
      const recovered = second.kernel.getSubagentJob(parentSessionId, created.id);
      assert.equal(recovered.output, "RECOVERY_RECONCILIATION_FINAL_RESULT_SENTINEL");
      assert.equal(recovered.recoveryCount, 1);
      assert.equal(second.model.requests.length, 1);
      const providerContext = JSON.stringify(second.model.requests[0].messages);
      assert.match(providerContext, /RECOVERY_COMMITTED_TOOL_RESULT_SENTINEL/u);
      assert.match(providerContext, /prior local read was interrupted/u);
      const run = second.kernel.database.connection.prepare(`
        SELECT status, attempt_count, model_calls, tool_calls
        FROM subagent_job_runs WHERE job_id = ? AND generation = 1
      `).get(created.id) as Record<string, unknown>;
      assert.equal(run.status, "completed");
      assert.equal(run.attempt_count, 2);
      assert.equal(run.model_calls, 2);
      assert.equal(run.tool_calls, 2);
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("ambiguous external effects stay idle until the local control plane explicitly retries", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-explicit-recovery-"));
  const parentSessionId = "explicit-recovery-parent";
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "explicit-recovery-first",
  });
  try {
    first.kernel.setAgentModuleEnabled("mcp:subagent", true);
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, { mode: "sms", text: "建立恢复父会话。" });
    const settings = first.kernel.getSubagentSettings();
    const grants = {
      workspaceAccess: "off" as const,
      moduleIds: [] as string[],
      skillNames: [] as string[],
      toolNames: ["tavily_search"],
    };
    const created = first.kernel.subagentJobs.create({
      parentSessionId,
      role: "researcher",
      task: "EXPLICIT_RECOVERY_PRIVATE_TASK_SENTINEL",
      mode: "sms",
      conversationSpace: "normal",
      budgets: { ...settings, timeoutMs: settings.timeoutSeconds * 1_000 },
      grants,
    });
    const claim = first.kernel.subagentJobs.claimRun(
      created.id,
      grants,
      "explicit-recovery-owner",
    );
    const transcript = [
      {
        role: "user",
        content: [{ type: "text", text: "EXPLICIT_RECOVERY_PRIVATE_TASK_SENTINEL" }],
        timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
      },
      {
        role: "assistant",
        content: [{
          type: "toolCall",
          id: "ambiguous-external-call",
          name: "tavily_search",
          arguments: { query: "EXPLICIT_RECOVERY_PRIVATE_ARGUMENT_SENTINEL" },
        }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
        usage: {
          input: 10,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 20,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
      },
    ];
    first.kernel.subagentJobs.recordToolCallStart(
      claim,
      {
        toolCallId: "ambiguous-external-call",
        toolName: "tavily_search",
        input: { query: "EXPLICIT_RECOVERY_PRIVATE_ARGUMENT_SENTINEL" },
      },
      { modelCalls: 1, toolCalls: 1, inputTokens: 10, outputTokens: 10, durationMs: 100 },
      transcript,
    );
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      now: "2026-01-01T01:00:00.000Z",
      seed: "explicit-recovery-second",
      initialModelResponses: [{
        kind: "assistant_text",
        text: "EXPLICIT_RECOVERY_FINAL_RESULT_SENTINEL",
      }],
    });
    const server = createHttpServer({ kernel: second.kernel });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const staged = second.kernel.getSubagentJob(parentSessionId, created.id);
      assert.equal(staged.status, "idle");
      assert.deepEqual(staged.recovery, {
        state: "decision_required",
        reason: "external_effect_ambiguous",
        generation: 1,
        attemptCount: 1,
        recoverableToolCalls: 0,
        ambiguousToolCalls: 1,
      });
      assert.equal(second.model.requests.length, 0);
      assert.doesNotMatch(
        JSON.stringify(staged),
        /EXPLICIT_RECOVERY_PRIVATE_(?:TASK|ARGUMENT)_SENTINEL/u,
      );

      const address = server.address();
      assert.ok(address && typeof address === "object");
      const origin = `http://127.0.0.1:${address.port}`;
      const retryEndpoint =
        `${origin}/api/v1/sessions/${parentSessionId}/subagent-jobs/${encodeURIComponent(created.id)}/retry`;
      const rejected = await fetch(retryEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://untrusted.example" },
        body: "{}",
      });
      assert.equal(rejected.status, 403);
      assert.equal(second.kernel.getSubagentJob(parentSessionId, created.id).status, "idle");
      const bootstrap = await fetch(`${origin}/`);
      const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const retryResponse = await fetch(
        retryEndpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: "{}",
        },
      );
      assert.equal(retryResponse.status, 202);
      await waitFor(() => second.kernel.getSubagentJob(parentSessionId, created.id).status === "completed");
      const recovered = second.kernel.getSubagentJob(parentSessionId, created.id);
      assert.equal(recovered.output, "EXPLICIT_RECOVERY_FINAL_RESULT_SENTINEL");
      assert.equal(second.model.requests.length, 1);
      assert.match(
        JSON.stringify(second.model.requests[0].messages),
        /user explicitly authorized a retry/u,
      );
      const transcriptRow = second.kernel.database.connection.prepare(`
        SELECT transcript_json FROM subagent_jobs WHERE id = ?
      `).get(created.id) as { transcript_json: string };
      assert.match(transcriptRow.transcript_json, /user explicitly authorized a retry/u);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve())
      );
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for Subagent job state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function subagentCompletion(output: string) {
  return {
    output,
    modelCalls: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 1,
    truncated: false,
    forcedFinalization: false,
    maxResultCharacters: 64_000,
  };
}

function subagentDeliveryState(
  runtime: ReturnType<typeof createTestRuntime>,
  jobId: string,
): { status: string; attempts: number } {
  return runtime.kernel.database.connection.prepare(`
    SELECT status, attempts FROM subagent_job_deliveries
    WHERE job_id = ? ORDER BY generation DESC LIMIT 1
  `).get(jobId) as { status: string; attempts: number };
}

function subagentDeliveryMarkers(messages: readonly unknown[], jobId: string): Array<{
  content: unknown;
}> {
  return messages.filter((message): message is { content: unknown } => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false;
    const record = message as Record<string, unknown>;
    if (record.role !== "custom" || record.customType !== "rp-agent/subagent_job_result") return false;
    const details = record.details;
    return Boolean(details && typeof details === "object" && !Array.isArray(details) &&
      (details as Record<string, unknown>).subagentJobId === jobId);
  });
}
