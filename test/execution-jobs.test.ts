import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ExecutionJobNotFoundError,
  maximumExecutionOutputBytes,
} from "../src/execution/index.js";
import { createHttpServer } from "../src/http/router.js";
import { createTestRuntime } from "../src/testing/runtime.js";

test("background shell jobs use the capability seam and expose only bounded output pages", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-execution-job-"));
  const workspaceDir = join(root, "workspace");
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir,
    seed: "execution-job-capability",
  });
  const server = createHttpServer({ kernel: runtime.kernel });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const command = [
    ": PRIVATE_BACKGROUND_COMMAND_SENTINEL",
    "/usr/bin/head -c 20000 /dev/zero | /usr/bin/tr '\\0' A",
    "printf EXPLICIT_OUTPUT_; printf SENTINEL",
    "sleep 0.4",
  ].join("; ");
  try {
    runtime.kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
      networkEnabled: false,
    });
    runtime.model.enqueue([
      { kind: "tool_call", name: "start_shell_job", arguments: { command } },
      { kind: "assistant_text", text: "后台命令已提交。" },
    ]);
    const response = await runtime.kernel.sendMessage("execution-parent", {
      mode: "sms",
      text: "启动一个后台输出任务。",
    });
    assert.equal(response.status, "completed");
    const staticToolContextBytes = JSON.stringify(
      runtime.model.requests[0]?.providerPayload,
    ).length;
    for (const toolName of [
      "start_shell_job",
      "list_execution_jobs",
      "get_execution_job",
      "interrupt_execution_job",
    ]) {
      assert.equal(runtime.model.requests[0].toolNames.includes(toolName), true);
    }

    const admitted = runtime.kernel.listExecutionJobs("execution-parent")[0];
    assert.ok(admitted);
    assert.equal(admitted.status, "running");
    assert.equal(admitted.grants.workspaceAccess, "read_write");
    assert.equal(admitted.grants.networkEnabled, false);
    assert.doesNotMatch(JSON.stringify(admitted), /PRIVATE_BACKGROUND_COMMAND_SENTINEL/u);
    const startAction = response.actions.find((entry) => entry.actionType === "start_shell_job");
    assert.ok(startAction);
    assert.doesNotMatch(JSON.stringify(startAction), /PRIVATE_BACKGROUND_COMMAND_SENTINEL/u);
    const privateRow = runtime.kernel.database.connection.prepare(`
      SELECT command_text FROM execution_jobs WHERE id = ?
    `).get(admitted.id) as { command_text: string };
    assert.equal(privateRow.command_text, command);

    runtime.kernel.sessionRuntime.invalidateSessionCapabilities(
      "execution-parent",
      "test_handle_eviction",
    );
    assert.equal(runtime.kernel.executionJobs.hasActiveJob("execution-parent"), true);
    await waitFor(() =>
      runtime.kernel.getExecutionJob("execution-parent", admitted.id).status === "completed"
    );
    const completed = runtime.kernel.getExecutionJob("execution-parent", admitted.id);
    assert.equal(completed.run?.outputBytes, 20_024);
    assert.equal(completed.run?.outputTruncated, false);
    assert.equal(completed.run?.exitCode, 0);

    runtime.model.enqueue([
      {
        kind: "tool_call",
        name: "get_execution_job",
        arguments: { jobId: admitted.id, limitBytes: 4_096 },
      },
      { kind: "assistant_text", text: "已读取第一段输出。" },
    ]);
    await runtime.kernel.sendMessage("execution-parent", {
      mode: "sms",
      text: "读取后台任务的第一页输出。",
    });
    const pagedContext = JSON.stringify(runtime.model.requests.at(-1)?.providerPayload);
    assert.doesNotMatch(pagedContext, /EXPLICIT_OUTPUT_SENTINEL/u);
    assert.ok(
      pagedContext.length < staticToolContextBytes + 16_000,
      `paged context grew from ${staticToolContextBytes} to ${pagedContext.length} characters`,
    );

    let cursor = 0;
    let explicitOutput = "";
    let pageCount = 0;
    do {
      const page = runtime.kernel.getExecutionJobOutput(
        "execution-parent",
        admitted.id,
        { cursor, limitBytes: 4_096 },
      );
      explicitOutput += page.chunks.map((chunk) => chunk.text).join("");
      cursor = page.nextCursor;
      pageCount += 1;
      if (page.eof) break;
    } while (pageCount < 20);
    assert.ok(pageCount > 1);
    assert.match(explicitOutput, /EXPLICIT_OUTPUT_SENTINEL$/u);

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const collection = `${origin}/api/v1/sessions/execution-parent/execution-jobs`;
    const listed = await fetch(collection);
    assert.equal(listed.status, 200);
    assert.doesNotMatch(await listed.text(), /PRIVATE_BACKGROUND_COMMAND_SENTINEL/u);
    const outputResponse = await fetch(
      `${collection}/${encodeURIComponent(admitted.id)}/output?limitBytes=4096`,
    );
    assert.equal(outputResponse.status, 200);
    const outputPayload = await outputResponse.json() as { output: { returnedBytes: number } };
    assert.ok(outputPayload.output.returnedBytes <= 4_096);

    runtime.model.enqueue([{ kind: "assistant_text", text: "另一个会话。" }]);
    await runtime.kernel.sendMessage("other-execution-parent", {
      mode: "sms",
      text: "建立隔离会话。",
    });
    const crossSession = await fetch(
      `${origin}/api/v1/sessions/other-execution-parent/execution-jobs/${encodeURIComponent(admitted.id)}`,
    );
    assert.equal(crossSession.status, 404);
    assert.throws(
      () => runtime.kernel.getExecutionJob("other-execution-parent", admitted.id),
      ExecutionJobNotFoundError,
    );

    const overflowing = runtime.kernel.startExecutionJob("execution-parent", {
      command: `/usr/bin/head -c ${maximumExecutionOutputBytes + 1_024} /dev/zero`,
      timeoutSeconds: 30,
    });
    await waitFor(() =>
      runtime.kernel.getExecutionJob("execution-parent", overflowing.id).status === "completed",
      8_000,
    );
    const bounded = runtime.kernel.getExecutionJob("execution-parent", overflowing.id);
    assert.equal(bounded.run?.outputBytes, maximumExecutionOutputBytes);
    assert.equal(bounded.run?.outputTruncated, true);
    const retained = runtime.kernel.database.connection.prepare(`
      SELECT COALESCE(SUM(bytes), 0) AS bytes
      FROM execution_job_output_chunks WHERE job_id = ?
    `).get(overflowing.id) as { bytes: number };
    assert.equal(Number(retained.bytes), maximumExecutionOutputBytes);

    const unicode = runtime.kernel.startExecutionJob("execution-parent", {
      command: "for ((i=0; i<2000; i++)); do printf 你; done",
    });
    await waitFor(() =>
      runtime.kernel.getExecutionJob("execution-parent", unicode.id).status === "completed"
    );
    let unicodeCursor = 0;
    let unicodeOutput = "";
    do {
      const page = runtime.kernel.getExecutionJobOutput(
        "execution-parent",
        unicode.id,
        { cursor: unicodeCursor, limitBytes: 4_096 },
      );
      unicodeOutput += page.chunks.map((chunk) => chunk.text).join("");
      unicodeCursor = page.nextCursor;
      if (page.eof) break;
    } while (unicodeCursor < 10_000);
    assert.equal(unicodeOutput, "你".repeat(2_000));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("running execution jobs are interruptible and fence destructive control-plane work", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-execution-interrupt-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "execution-job-interrupt",
  });
  try {
    runtime.kernel.patchAgentPermissions({
      workspaceAccess: "read_write",
      shellEnabled: true,
    });
    runtime.model.enqueue([{ kind: "assistant_text", text: "会话已建立。" }]);
    await runtime.kernel.sendMessage("interrupt-parent", { mode: "sms", text: "你好" });
    const job = runtime.kernel.startExecutionJob("interrupt-parent", {
      command: "printf INTERRUPT_OUTPUT_SENTINEL; sleep 10",
      timeoutSeconds: 30,
    });
    await waitFor(() =>
      (runtime.kernel.getExecutionJob("interrupt-parent", job.id).run?.outputBytes ?? 0) > 0
    );
    assert.throws(
      () => runtime.kernel.patchAgentPermissions({ networkEnabled: false }),
      /后台命令|cannot be changed while a session is running/u,
    );
    const metadata = runtime.kernel.getConversationMetadata("interrupt-parent");
    assert.ok(metadata);
    assert.throws(
      () => runtime.kernel.assertConversationDeletable(
        metadata.id,
        metadata.title || metadata.id,
      ),
      /busy and cannot be deleted/u,
    );

    const cancelled = await runtime.kernel.interruptExecutionJob("interrupt-parent", job.id);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.run?.status, "cancelled");
    assert.equal(cancelled.run?.failureReason, "interrupted");
    assert.match(
      runtime.kernel.getExecutionJobOutput("interrupt-parent", job.id).chunks
        .map((chunk) => chunk.text).join(""),
      /INTERRUPT_OUTPUT_SENTINEL/u,
    );

    const timed = runtime.kernel.startExecutionJob("interrupt-parent", {
      command: "printf TIMEOUT_OUTPUT_SENTINEL; sleep 10",
      timeoutSeconds: 1,
    });
    await waitFor(() =>
      runtime.kernel.getExecutionJob("interrupt-parent", timed.id).status === "failed",
      3_000,
    );
    const timedOut = runtime.kernel.getExecutionJob("interrupt-parent", timed.id);
    assert.equal(timedOut.run?.timedOut, true);
    assert.equal(timedOut.run?.failureReason, "timeout");

    await runtime.kernel.deleteConversation(metadata.id, metadata.title || metadata.id);
    assert.equal(
      Number((runtime.kernel.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM execution_jobs WHERE parent_session_id = ?
      `).get(metadata.id) as { count: number }).count),
      0,
    );
    assert.equal(
      Number((runtime.kernel.database.connection.prepare(`
        SELECT COUNT(*) AS count FROM execution_job_output_chunks WHERE job_id = ?
      `).get(job.id) as { count: number }).count),
      0,
    );
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("secret execution artifacts and audits stay bound to their owning conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-execution-secret-"));
  const runtime = createTestRuntime({
    stateDir: join(root, "state"),
    workspaceDir: join(root, "workspace"),
    seed: "execution-job-secret",
  });
  try {
    const character = runtime.kernel.createCharacter({ name: "后台隔离角色" });
    const normal = await runtime.kernel.openCanonicalPrivateConversation(character.id, "normal");
    const secret = await runtime.kernel.openCanonicalPrivateConversation(character.id, "secret");
    runtime.kernel.patchAgentPermissions({ workspaceAccess: "read_write", shellEnabled: true });
    const command = "printf SECRET_EXECUTION_OUTPUT_SENTINEL";
    const job = runtime.kernel.startExecutionJob(secret.id, { command });
    await waitFor(() => runtime.kernel.getExecutionJob(secret.id, job.id).status === "completed");

    const completed = runtime.kernel.getExecutionJob(secret.id, job.id);
    assert.equal(completed.conversationSpace, "secret");
    assert.equal(completed.characterId, character.id);
    assert.equal(completed.secretOwnerCharacterId, character.id);
    assert.throws(
      () => runtime.kernel.getExecutionJob(normal.id, job.id),
      ExecutionJobNotFoundError,
    );
    assert.match(
      runtime.kernel.getExecutionJobOutput(secret.id, job.id).chunks
        .map((chunk) => chunk.text).join(""),
      /SECRET_EXECUTION_OUTPUT_SENTINEL/u,
    );
    const actions = runtime.kernel.store.actions.filter((entry) =>
      entry.payload.jobId === job.id
    );
    assert.ok(actions.some((entry) => entry.actionType === "start_shell_job"));
    assert.ok(actions.some((entry) => entry.actionType === "shell_job_terminal"));
    assert.equal(actions.every((entry) =>
      entry.conversationSpace === "secret" &&
      entry.secretOwnerCharacterId === character.id
    ), true);
    assert.doesNotMatch(JSON.stringify(actions), /SECRET_EXECUTION_OUTPUT_SENTINEL/u);
  } finally {
    runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("shutdown stages shell work as idle and only trusted explicit retry replays it with narrower grants", async () => {
  const root = mkdtempSync(join(tmpdir(), "yourchar-execution-recovery-"));
  const stateDir = join(root, "state");
  const workspaceDir = join(root, "workspace");
  const parentSessionId = "execution-recovery-parent";
  const command = [
    ": PRIVATE_RECOVERY_COMMAND_SENTINEL",
    "if { printf x >> retry-marker.txt; } 2>/dev/null",
    "then sleep 10",
    "else printf RETRIED_READ_ONLY_SENTINEL",
    "fi",
  ].join("; ");
  let first: ReturnType<typeof createTestRuntime> | undefined;
  let second: ReturnType<typeof createTestRuntime> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    first = createTestRuntime({ stateDir, workspaceDir, seed: "execution-recovery-first" });
    first.kernel.patchAgentPermissions({ workspaceAccess: "read_write", shellEnabled: true });
    first.model.enqueue([{ kind: "assistant_text", text: "父会话已建立。" }]);
    await first.kernel.sendMessage(parentSessionId, { mode: "sms", text: "建立会话" });
    const created = first.kernel.startExecutionJob(parentSessionId, {
      command,
      timeoutSeconds: 30,
    });
    await waitFor(() => existsSync(join(workspaceDir, "retry-marker.txt")));
    assert.equal(readFileSync(join(workspaceDir, "retry-marker.txt"), "utf8"), "x");
    first.dispose();
    first = undefined;

    second = createTestRuntime({ stateDir, workspaceDir, seed: "execution-recovery-second" });
    const staged = second.kernel.getExecutionJob(parentSessionId, created.id);
    assert.equal(staged.status, "idle");
    assert.equal(staged.run?.status, "abandoned");
    assert.equal(staged.run?.failureReason, "runtime_shutdown");
    assert.doesNotMatch(JSON.stringify(staged), /PRIVATE_RECOVERY_COMMAND_SENTINEL/u);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(readFileSync(join(workspaceDir, "retry-marker.txt"), "utf8"), "x");

    second.kernel.patchAgentPermissions({ workspaceAccess: "read_only" });
    server = createHttpServer({ kernel: second.kernel });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const retryUrl =
      `${origin}/api/v1/sessions/${parentSessionId}/execution-jobs/${encodeURIComponent(created.id)}/retry`;
    const rejected = await fetch(retryUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://untrusted.example" },
      body: "{}",
    });
    assert.equal(rejected.status, 403);
    assert.equal(second.kernel.getExecutionJob(parentSessionId, created.id).status, "idle");

    const bootstrap = await fetch(`${origin}/`);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const retried = await fetch(retryUrl, {
      method: "POST",
      headers: { "content-type": "application/json", origin, cookie },
      body: "{}",
    });
    assert.equal(retried.status, 202);
    await waitFor(() =>
      second!.kernel.getExecutionJob(parentSessionId, created.id).status === "completed"
    );
    const completed = second.kernel.getExecutionJob(parentSessionId, created.id);
    assert.equal(completed.currentAttempt, 2);
    assert.equal(completed.run?.workspaceAccess, "read_only");
    assert.equal(completed.run?.networkEnabled, false);
    assert.equal(readFileSync(join(workspaceDir, "retry-marker.txt"), "utf8"), "x");
    assert.match(
      second.kernel.getExecutionJobOutput(parentSessionId, created.id, { attempt: 2 }).chunks
        .map((chunk) => chunk.text).join(""),
      /RETRIED_READ_ONLY_SENTINEL/u,
    );
    assert.equal(
      Number((second.kernel.database.connection.prepare(
        "SELECT MAX(version) AS version FROM schema_migrations",
      ).get() as { version: number }).version),
      71,
    );
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    second?.dispose();
    first?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for execution job state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
