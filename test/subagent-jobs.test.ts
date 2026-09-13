import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHttpServer } from "../src/http/router.js";
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
    for (const toolName of ["delegate_task", "list_subagent_jobs", "get_subagent_job"]) {
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
    } finally {
      second.dispose();
    }
  } finally {
    first?.dispose();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
