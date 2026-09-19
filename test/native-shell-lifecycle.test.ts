import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { VirtualClock } from "../src/app/clock.js";
import { SeededIdGenerator } from "../src/app/id-generator.js";
import { CompanionStore } from "../src/domain/store.js";
import { ExecutionJobService } from "../src/execution/shell-jobs.js";
import { shellSandboxAvailability } from "../src/execution/shell-sandbox.js";
import { createSandboxedShellTool } from "../src/pi/sandboxed-shell-tool.js";
import { AppDatabase } from "../src/storage/database.js";

const availability = shellSandboxAvailability();
const native = process.platform === "linux" || process.platform === "darwin";
const options = { skip: !native || !availability.available ? availability.reason ?? "No native backend" : false, timeout: 15_000 };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "yourchar-native-lifecycle-")));
  const workspaceDir = join(root, "state", "workspace");
  mkdirSync(workspaceDir, { recursive: true });
  const clock = new VirtualClock("2026-01-01T00:00:00Z");
  const ids = new SeededIdGenerator("native-lifecycle");
  const store = new CompanionStore({ stateDir: false, clock, idGenerator: ids });
  const database = new AppDatabase(":memory:");
  const protectedPaths = [join(root, "state")];
  const jobs = new ExecutionJobService(database, clock, ids, undefined, protectedPaths);
  const policy = { workspaceDir, workspaceAccess: "read_write" as const, networkEnabled: true };
  const tool = createSandboxedShellTool({ ...policy, protectedPaths, store, sessionId: "foreground", actions: () => [] });
  const input = { ...policy, parentSessionId: "background", mode: "sms" as const,
    conversationSpace: "normal" as const, workspaceKey: "normal" };
  return { root, workspaceDir, store, jobs, input,
    run: (command: string, timeoutSeconds = 5, signal?: AbortSignal) =>
      // The shell tool does not consume the extension host context.
      tool.execute("native-call", { command, timeoutSeconds }, signal, undefined, {} as Parameters<typeof tool.execute>[4]),
    async cleanup() {
      try {
        for (const job of jobs.list("background")) await jobs.interrupt("background", job.id);
      } finally {
        jobs.dispose();
        database.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await pause(20);
  assert.ok(predicate(), "native command did not reach the expected state");
}

test("native foreground tool writes only its Workspace and bounds audited output", options, async () => {
  const f = fixture();
  try {
    const privateFile = join(f.root, "state", "credentials.json");
    writeFileSync(privateFile, "fixture-private-credential");
    const result = await f.run(`: PRIVATE_COMMAND_SENTINEL; printf allowed > allowed.txt; ` +
      `if cat ${quote(privateFile)} 2>/dev/null; then exit 51; fi; ` +
      "head -c 70000 /dev/zero | tr '\\0' A");
    const details = result.details as Record<string, unknown>;
    assert.equal(details.exitCode, 0);
    assert.equal(details.truncated, true);
    assert.equal(Buffer.byteLength(String(details.output)), 65_536);
    assert.equal(details.backend, availability.backend);
    assert.equal(readFileSync(join(f.workspaceDir, "allowed.txt"), "utf8"), "allowed");
    const audit = f.store.actions.at(-1)!;
    assert.equal(audit.actionType, "workspace_shell");
    assert.equal(audit.payload.sandboxBackend, availability.backend);
    assert.equal(audit.payload.outputTruncated, true);
    assert.doesNotMatch(JSON.stringify(audit), /PRIVATE_COMMAND_SENTINEL|fixture-private-credential/);
  } finally { await f.cleanup(); }
});

test("native foreground timeout and abort stop descendant work", options, async () => {
  const f = fixture();
  try {
    const ticker = "while :; do printf x >> ticks; sleep 0.02; done & wait";
    const timedOut = await f.run(ticker, 1);
    assert.equal((timedOut.details as Record<string, unknown>).timedOut, true);
    const before = readFileSync(join(f.workspaceDir, "ticks"), "utf8");
    await pause(100);
    assert.equal(readFileSync(join(f.workspaceDir, "ticks"), "utf8"), before);
    const controller = new AbortController();
    const pending = f.run(ticker.replace("ticks", "abort-ticks"), 5, controller.signal);
    try { await waitFor(() => existsSync(join(f.workspaceDir, "abort-ticks"))); }
    finally { controller.abort(); }
    const aborted = await pending;
    assert.equal((aborted.details as Record<string, unknown>).aborted, true);
    const afterAbort = readFileSync(join(f.workspaceDir, "abort-ticks"), "utf8");
    await pause(100);
    assert.equal(readFileSync(join(f.workspaceDir, "abort-ticks"), "utf8"), afterAbort);
  } finally { await f.cleanup(); }
});

test("native background jobs keep private files out and paginate output by session", options, async () => {
  const f = fixture();
  try {
    const privateFile = join(f.root, "state", "credentials.json");
    writeFileSync(privateFile, "fixture-private-credential");
    const job = f.jobs.start({ ...f.input, command: `printf written > background.txt; ` +
      `if cat ${quote(privateFile)} 2>/dev/null; then exit 51; fi; head -c 20000 /dev/zero | tr '\\0' B` });
    await waitFor(() => f.jobs.get("background", job.id)?.status !== "running");
    assert.equal(f.jobs.get("background", job.id)?.status, "completed");
    assert.equal(f.jobs.get("other-session", job.id), undefined);
    assert.throws(() => f.jobs.output("other-session", job.id), { code: "EXECUTION_JOB_NOT_FOUND" });
    const first = f.jobs.output("background", job.id, { limitBytes: 4096 });
    assert.ok(first.returnedBytes <= 4096);
    assert.equal(first.totalBytes, 20000);
    assert.equal(first.eof, false);
    let cursor = 0;
    let output = "";
    for (let i = 0; i < 20; i += 1) {
      const page = f.jobs.output("background", job.id, { cursor, limitBytes: 4096 });
      output += page.chunks.map(chunk => chunk.text).join("");
      if (page.eof) break;
      assert.ok(page.nextCursor > cursor);
      cursor = page.nextCursor;
    }
    assert.equal(output, "B".repeat(20000));
    assert.equal(readFileSync(join(f.workspaceDir, "background.txt"), "utf8"), "written");
  } finally { await f.cleanup(); }
});

test("native background jobs can be interrupted and time out without surviving workers", options, async () => {
  const f = fixture();
  try {
    const job = f.jobs.start({ ...f.input, command: "while :; do printf x >> ticks; sleep 0.02; done & wait" });
    await waitFor(() => existsSync(join(f.workspaceDir, "ticks")));
    const stopped = await f.jobs.interrupt("background", job.id);
    assert.equal(stopped.status, "cancelled");
    assert.equal(stopped.run?.failureReason, "interrupted");
    const before = readFileSync(join(f.workspaceDir, "ticks"), "utf8");
    await pause(100);
    assert.equal(readFileSync(join(f.workspaceDir, "ticks"), "utf8"), before);
    const timeoutJob = f.jobs.start({ ...f.input, command: "sleep 30", timeoutSeconds: 1 });
    await waitFor(() => f.jobs.get("background", timeoutJob.id)?.status !== "running");
    const finished = f.jobs.get("background", timeoutJob.id)!;
    assert.equal(finished.status, "failed");
    assert.equal(finished.run?.timedOut, true);
    assert.equal(finished.run?.failureReason, "timeout");
    assert.equal(f.jobs.hasActiveJob(), false);
  } finally { await f.cleanup(); }
});

test("native background retry honors a narrower Workspace grant", options, async () => {
  const f = fixture();
  try {
    const job = f.jobs.start({ ...f.input, command: "test -f retry-ready || exit 7; cat retry-ready; " +
      "if touch forbidden.txt 2>/dev/null; then exit 52; fi" });
    await waitFor(() => f.jobs.get("background", job.id)?.status !== "running");
    assert.equal(f.jobs.get("background", job.id)?.run?.exitCode, 7);
    writeFileSync(join(f.workspaceDir, "retry-ready"), "retry-ok");
    f.jobs.retry({ ...f.input, jobId: job.id, workspaceAccess: "read_only" });
    await waitFor(() => f.jobs.get("background", job.id)?.status !== "running");
    const finished = f.jobs.get("background", job.id)!;
    assert.equal(finished.status, "completed");
    assert.equal(finished.run?.attempt, 2);
    assert.equal(finished.run?.workspaceAccess, "read_only");
    assert.equal(f.jobs.output("background", job.id).chunks.map(chunk => chunk.text).join(""), "retry-ok");
    assert.equal(existsSync(join(f.workspaceDir, "forbidden.txt")), false);
  } finally { await f.cleanup(); }
});
