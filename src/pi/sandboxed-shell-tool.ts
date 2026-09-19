import { createHash } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { WorkspaceAccess } from "../modules/types.js";
import { bubblewrapArguments, spawnSandboxedShell, type ShellSandboxBackend } from "../execution/shell-sandbox.js";

export { bubblewrapPath } from "../execution/shell-sandbox.js";
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
  protectedPaths?: readonly string[];
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
};

export type SandboxedShellPolicy = Pick<
  SandboxedShellContext,
  "workspaceDir" | "workspaceAccess" | "networkEnabled"
>;

export function createSandboxedShellTool(
  context: SandboxedShellContext,
): ToolDefinition<typeof bashParameters, unknown> {
  const networkEnabledAtCreation = effectiveNetworkEnabled(context);
  return defineTool({
    name: "bash",
    label: "Run sandboxed shell",
    description:
      `Run a Bash command in a file-confined OS sandbox (${context.workspaceAccess}). ` +
      `Use workspace-relative paths; on macOS the working directory is the native Workspace path, ` +
      `and on Linux/WSL2 it is /workspace. Private host files and application credentials are not exposed. ` +
      `Network is ${networkEnabledAtCreation ? "enabled (host network)" : "disabled"}.`,
    parameters: bashParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input, signal) {
      const startedAt = performance.now();
      const networkEnabled = effectiveNetworkEnabled(context);
      const result = await runSandboxedCommand(
        context,
        input.command,
        Math.round((input.timeoutSeconds ?? defaultTimeoutMs / 1000) * 1000),
        signal,
        networkEnabled,
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
        networkEnabled,
        sandboxBackend: result.backend,
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
  networkEnabled = effectiveNetworkEnabled(context),
): Promise<{
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  backend: ShellSandboxBackend;
}> {
  signal?.throwIfAborted();
  const running = spawnSandboxedShell({ ...context, networkEnabled }, command);
  const child = running.child;
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
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const terminate = running.terminate;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminate();
  }, timeoutMs);
  const abort = () => {
    aborted = true;
    terminate();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
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
      backend: running.backend,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function sandboxArguments(
  context: SandboxedShellPolicy,
  command: string,
  networkEnabled = effectiveNetworkEnabled(context),
): string[] {
  return bubblewrapArguments({ ...context, networkEnabled }, command);
}

function effectiveNetworkEnabled(context: SandboxedShellPolicy): boolean {
  return context.networkEnabled;
}
