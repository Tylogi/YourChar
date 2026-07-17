import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { WorkspaceAccess } from "../modules/types.js";

const bubblewrapPath = "/usr/bin/bwrap";
const maxOutputBytes = 64 * 1024;
const defaultTimeoutMs = 30_000;

const bashParameters = Type.Object({
  command: Type.String({ minLength: 1, maxLength: 32_768 }),
  timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 120 })),
});

export type SandboxedShellContext = {
  workspaceDir: string;
  workspaceAccess: WorkspaceAccess;
  networkEnabled: boolean;
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
};

export function createSandboxedShellTool(
  context: SandboxedShellContext,
): ToolDefinition<typeof bashParameters, unknown> {
  return defineTool({
    name: "bash",
    label: "Run sandboxed shell",
    description:
      `Run a Bash command in an OS sandbox. Only /workspace is exposed (${context.workspaceAccess}); ` +
      `host files are hidden and network is ${context.networkEnabled ? "enabled" : "disabled"}.`,
    parameters: bashParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      const startedAt = performance.now();
      const result = await runSandboxedCommand(
        context,
        input.command,
        Math.round((input.timeoutSeconds ?? defaultTimeoutMs / 1000) * 1000),
        signal,
      );
      const durationMs = Math.round(performance.now() - startedAt);
      context.actions().push(context.store.addAction("workspace_shell", result.exitCode === 0 ? "completed" : "failed", {
        transport: "pi-tool",
        sessionId: context.sessionId,
        commandLength: [...input.command].length,
        commandSha256: createHash("sha256").update(input.command).digest("hex"),
        exitCode: result.exitCode,
        durationMs,
        timedOut: result.timedOut,
        aborted: result.aborted,
        outputTruncated: result.truncated,
        networkEnabled: context.networkEnabled,
      }));
      const status = result.timedOut
        ? "Command timed out"
        : result.aborted
          ? "Command aborted"
          : `Command exited with code ${result.exitCode}`;
      return {
        content: [{ type: "text", text: result.output ? `${result.output}\n${status}` : status }],
        details: { ...result, durationMs },
      };
    },
  });
}

async function runSandboxedCommand(
  context: SandboxedShellContext,
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}> {
  const args = sandboxArguments(context, command);
  const child = spawn(bubblewrapPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
  });
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  let truncated = false;
  let timedOut = false;
  let aborted = false;

  const append = (chunk: Buffer) => {
    const remaining = maxOutputBytes - retainedBytes;
    if (remaining > 0) {
      const selected = chunk.subarray(0, remaining);
      chunks.push(selected);
      retainedBytes += selected.length;
    }
    if (chunk.length > remaining) truncated = true;
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const terminate = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const abort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      output: Buffer.concat(chunks).toString("utf8").trimEnd(),
      exitCode,
      timedOut,
      aborted,
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function sandboxArguments(context: SandboxedShellContext, command: string): string[] {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
  ];
  if (context.networkEnabled) args.push("--share-net");
  args.push(
    "--ro-bind", "/usr", "/usr",
    "--symlink", "usr/bin", "/bin",
    "--symlink", "usr/lib", "/lib",
    "--symlink", "usr/lib64", "/lib64",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--dir", "/tmp/home",
  );
  if (context.workspaceAccess === "read_write") {
    args.push("--bind", realpathSync(context.workspaceDir), "/workspace");
  } else if (context.workspaceAccess === "read_only") {
    args.push("--ro-bind", realpathSync(context.workspaceDir), "/workspace");
  } else {
    args.push("--dir", "/workspace");
  }
  if (context.networkEnabled) {
    for (const path of [
      "/etc/resolv.conf",
      "/etc/hosts",
      "/etc/nsswitch.conf",
      "/etc/gai.conf",
      "/etc/ssl/certs",
    ]) {
      args.push("--ro-bind-try", path, path);
    }
  }
  args.push(
    "--chdir", "/workspace",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "HOME", "/tmp/home",
    "--setenv", "LANG", "C.UTF-8",
    "--",
    "/usr/bin/bash", "--noprofile", "--norc", "-c", command,
  );
  return args;
}
