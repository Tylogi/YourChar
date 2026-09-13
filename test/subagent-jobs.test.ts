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
  } finally {
    runtime.dispose();
  }
});

test("startup recovery fails interrupted Subagent jobs closed without silently replaying work", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "yourchar-subagent-job-recovery-"));
  let first: ReturnType<typeof createTestRuntime> | undefined = createTestRuntime({
    stateDir,
    seed: "subagent-job-recovery-first",
  });
  try {
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
      budgets: {
        maxConcurrentTasks: settings.maxConcurrentTasks,
        maxWorkModelCalls: settings.maxWorkModelCalls,
        maxOutputTokens: settings.maxOutputTokens,
        maxResultCharacters: settings.maxResultCharacters,
        timeoutSeconds: settings.timeoutSeconds,
        timeoutMs: settings.timeoutSeconds * 1_000,
      },
      grants: {
        workspaceAccess: "off",
        moduleIds: [],
        skillNames: [],
        toolNames: [],
      },
    });
    assert.equal(queued.status, "queued");
    const continuable = first.kernel.subagentJobs.create({
      parentSessionId: "recoverable-subagent-parent",
      role: "worker",
      task: "RECOVERED_SUBAGENT_CONTINUATION_ORIGINAL_SENTINEL",
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
      grants: {
        workspaceAccess: "off",
        moduleIds: [],
        skillNames: [],
        toolNames: [],
      },
    });
    first.kernel.subagentJobs.start(continuable.id, continuable.grants);
    first.kernel.subagentJobs.complete(
      continuable.id,
      subagentCompletion("RECOVERED_SUBAGENT_CONTINUATION_FIRST_RESULT_SENTINEL"),
      [
        { role: "user", content: "RECOVERED_SUBAGENT_CONTINUATION_ORIGINAL_SENTINEL" },
        {
          role: "assistant",
          content: [{
            type: "text",
            text: "RECOVERED_SUBAGENT_CONTINUATION_FIRST_RESULT_SENTINEL",
          }],
        },
      ],
    );
    const queuedFollowup = first.kernel.subagentJobs.queueFollowup(
      continuable.parentSessionId,
      continuable.id,
      "RECOVERED_SUBAGENT_PENDING_FOLLOWUP_SENTINEL",
      continuable.grants,
    );
    assert.equal(queuedFollowup.job.status, "queued");
    first.dispose();
    first = undefined;

    const second = createTestRuntime({
      stateDir,
      seed: "subagent-job-recovery-second",
    });
    try {
      const recovered = second.kernel.getSubagentJob(
        "recoverable-subagent-parent",
        queued.id,
      );
      assert.equal(recovered.status, "failed");
      assert.equal(recovered.revision, 2);
      assert.equal(recovered.recoveryCount, 1);
      assert.equal(recovered.failure?.failureKind, "interrupted");
      assert.equal(recovered.failure?.retryable, true);
      assert.equal(recovered.output, undefined);
      assert.doesNotMatch(
        JSON.stringify(recovered),
        /RECOVERED_SUBAGENT_PRIVATE_(?:TASK|CONTEXT)_SENTINEL/u,
      );
      assert.equal(second.model.requests.length, 0, "recovery must not repeat model work");
      const raw = second.kernel.database.connection.prepare(
        "SELECT task_text, context_text FROM subagent_jobs WHERE id = ?",
      ).get(queued.id) as { task_text: string; context_text: string };
      assert.equal(raw.task_text, "RECOVERED_SUBAGENT_PRIVATE_TASK_SENTINEL");
      assert.equal(raw.context_text, "RECOVERED_SUBAGENT_PRIVATE_CONTEXT_SENTINEL");

      const recoveredFollowup = second.kernel.getSubagentJob(
        "recoverable-subagent-parent",
        continuable.id,
      );
      assert.equal(recoveredFollowup.status, "failed");
      assert.equal(recoveredFollowup.failure?.failureKind, "interrupted");
      assert.equal(recoveredFollowup.recoveryCount, 1);
      assert.equal(recoveredFollowup.continuation.followupCount, 1);
      assert.equal(recoveredFollowup.continuation.transcriptStored, true);
      assert.equal(recoveredFollowup.continuation.available, false);
      assert.doesNotMatch(
        JSON.stringify(recoveredFollowup),
        /RECOVERED_SUBAGENT_(?:CONTINUATION|PENDING_FOLLOWUP)_/u,
      );
      const rawFollowup = second.kernel.database.connection.prepare(`
        SELECT transcript_json, pending_input_text
        FROM subagent_jobs WHERE id = ?
      `).get(continuable.id) as {
        transcript_json: string;
        pending_input_text: string;
      };
      assert.match(rawFollowup.transcript_json, /RECOVERED_SUBAGENT_CONTINUATION_ORIGINAL_SENTINEL/u);
      assert.equal(
        rawFollowup.pending_input_text,
        "RECOVERED_SUBAGENT_PENDING_FOLLOWUP_SENTINEL",
      );
    } finally {
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
