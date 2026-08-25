import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { WorkspaceAccess } from "../modules/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import { MAX_WORKSPACE_ATTACHMENTS_PER_TURN } from "./workspace-attachments.js";

const maxFileBytes = 1024 * 1024;

const listParameters = Type.Object({
  path: Type.Optional(Type.String({ description: "Workspace-relative directory; defaults to the workspace root." })),
});

const writeParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path." }),
  content: Type.String({ description: "Complete file content." }),
});

const editParameters = Type.Object({
  path: Type.String({ description: "Workspace-relative file path." }),
  oldText: Type.String({ description: "Exact text to replace." }),
  newText: Type.String({ description: "Replacement text." }),
  replaceAll: Type.Optional(Type.Boolean({ description: "Replace every exact occurrence; defaults to false." })),
});

const shareParameters = Type.Object({
  path: Type.String({
    maxLength: 500,
    description: "Workspace-relative path of an existing file to attach to the current reply.",
  }),
});

export type WorkspaceToolContext = {
  workspaceDir: string;
  workspaceFiles?: WorkspaceFileService;
  access: WorkspaceAccess;
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
  sharePaths?: () => string[];
  assertWriteAllowed?: (additionalBytes: number) => void;
};

export function createWorkspaceTools(context: WorkspaceToolContext): ToolDefinition[] {
  if (context.access === "off") return [];
  const tools: ToolDefinition[] = [createListTool(context)];
  if (context.workspaceFiles && context.sharePaths) {
    tools.push(createShareTool({
      ...context,
      workspaceFiles: context.workspaceFiles,
      sharePaths: context.sharePaths,
    }));
  }
  if (context.access === "read_write") {
    tools.push(createWriteTool(context), createEditTool(context));
  }
  return tools;
}

type WorkspaceShareToolContext = WorkspaceToolContext & {
  workspaceFiles: WorkspaceFileService;
  sharePaths: () => string[];
};

function createShareTool(
  context: WorkspaceShareToolContext,
): ToolDefinition<typeof shareParameters, unknown> {
  return defineTool({
    name: "share_workspace_file",
    label: "Share workspace file",
    description: [
      "Attach one existing Workspace file to the current user-facing reply.",
      "Call this only after the file has actually been created or downloaded.",
      "The application validates the path and renders a preview/download card; do not handwrite an internal URL or attachment marker.",
    ].join(" "),
    parameters: shareParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input) {
      try {
        const entry = context.workspaceFiles.asset(input.path, "attachment").entry;
        const paths = context.sharePaths();
        if (!paths.includes(entry.path)) {
          if (paths.length >= MAX_WORKSPACE_ATTACHMENTS_PER_TURN) {
            throw new Error(
              `at most ${MAX_WORKSPACE_ATTACHMENTS_PER_TURN} Workspace files can be shared per turn`,
            );
          }
          paths.push(entry.path);
        }
        context.actions().push(context.store.addAction(
          "share_workspace_file",
          "completed",
          {
            transport: "pi-tool",
            sessionId: context.sessionId,
            path: entry.path,
            bytes: entry.size,
            previewKind: entry.previewKind ?? "unsupported",
          },
        ));
        return {
          content: [{
            type: "text",
            text: `Validated ${entry.path} and queued it as an attachment to the final reply.`,
          }],
          details: { entry },
        };
      } catch (error) {
        context.actions().push(context.store.addAction(
          "share_workspace_file",
          "failed",
          {
            transport: "pi-tool",
            sessionId: context.sessionId,
            path: input.path.slice(0, 500),
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          },
        ));
        throw error;
      }
    },
  });
}

function createListTool(context: WorkspaceToolContext): ToolDefinition<typeof listParameters, unknown> {
  return defineTool({
    name: "list_workspace",
    label: "List workspace",
    description: "List files and directories inside the dedicated workspace. Host paths are not accessible.",
    parameters: listParameters,
    executionMode: "parallel",
    async execute(_toolCallId, input) {
      const path = existingWorkspacePath(context.workspaceDir, input.path ?? ".");
      if (!statSync(path).isDirectory()) throw new Error("list_workspace path must be a directory");
      const entries = readdirSync(path, { withFileTypes: true })
        .slice(0, 500)
        .map((entry) => `${entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?"} ${entry.name}`);
      return {
        content: [{ type: "text", text: entries.length ? entries.join("\n") : "(empty workspace directory)" }],
        details: { path: workspaceRelative(context.workspaceDir, path), entries: entries.length },
      };
    },
  });
}

function createWriteTool(context: WorkspaceToolContext): ToolDefinition<typeof writeParameters, unknown> {
  return defineTool({
    name: "write",
    label: "Write workspace file",
    description: "Create or replace a text file inside the dedicated workspace. The path must be workspace-relative.",
    parameters: writeParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input) {
      const path = writableWorkspacePath(context.workspaceDir, input.path);
      try {
        atomicWrite(path, input.content, context.assertWriteAllowed);
        recordFileAction(context, "workspace_write", "completed", input.path, input.content);
        return {
          content: [{ type: "text", text: `Wrote ${Buffer.byteLength(input.content, "utf8")} bytes to ${input.path}` }],
          details: { path: input.path, bytes: Buffer.byteLength(input.content, "utf8") },
        };
      } catch (error) {
        recordFileAction(context, "workspace_write", "failed", input.path);
        throw error;
      }
    },
  });
}

function createEditTool(context: WorkspaceToolContext): ToolDefinition<typeof editParameters, unknown> {
  return defineTool({
    name: "edit",
    label: "Edit workspace file",
    description: "Replace exact text in an existing text file inside the dedicated workspace.",
    parameters: editParameters,
    executionMode: "sequential",
    async execute(_toolCallId, input) {
      const path = existingWorkspacePath(context.workspaceDir, input.path);
      try {
        if (!statSync(path).isFile()) throw new Error("edit path must be a file");
        const current = readTextFile(path);
        const occurrences = countOccurrences(current, input.oldText);
        if (!occurrences) throw new Error("oldText was not found in the file");
        if (!input.replaceAll && occurrences !== 1) {
          throw new Error(`oldText matched ${occurrences} times; provide more context or set replaceAll`);
        }
        const next = input.replaceAll
          ? current.split(input.oldText).join(input.newText)
          : current.replace(input.oldText, input.newText);
        atomicWrite(path, next, context.assertWriteAllowed);
        recordFileAction(context, "workspace_edit", "completed", input.path, next, occurrences);
        return {
          content: [{ type: "text", text: `Edited ${input.path}; replaced ${input.replaceAll ? occurrences : 1} occurrence(s)` }],
          details: { path: input.path, replacements: input.replaceAll ? occurrences : 1 },
        };
      } catch (error) {
        recordFileAction(context, "workspace_edit", "failed", input.path);
        throw error;
      }
    },
  });
}

function existingWorkspacePath(workspaceDir: string, inputPath: string): string {
  const requested = lexicalWorkspacePath(workspaceDir, inputPath);
  if (!existsSync(requested)) throw new Error(`workspace path does not exist: ${inputPath}`);
  const root = realpathSync(workspaceDir);
  const path = realpathSync(requested);
  if (!isWithin(root, path)) throw new Error("workspace path escapes the dedicated workspace");
  return path;
}

function writableWorkspacePath(workspaceDir: string, inputPath: string): string {
  const requested = lexicalWorkspacePath(workspaceDir, inputPath);
  const root = realpathSync(workspaceDir);
  let ancestor = dirname(requested);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!isWithin(root, realpathSync(ancestor))) {
    throw new Error("workspace path escapes the dedicated workspace");
  }
  mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  if (!isWithin(root, realpathSync(dirname(requested)))) {
    throw new Error("workspace path escapes the dedicated workspace");
  }
  if (existsSync(requested) && !isWithin(root, realpathSync(requested))) {
    throw new Error("workspace path escapes the dedicated workspace");
  }
  return requested;
}

function lexicalWorkspacePath(workspaceDir: string, inputPath: string): string {
  if (!inputPath.trim()) throw new Error("workspace path is required");
  if (isAbsolute(inputPath)) throw new Error("workspace paths must be relative");
  const root = resolve(workspaceDir);
  const path = resolve(root, inputPath);
  if (!isWithin(root, path)) throw new Error("workspace path escapes the dedicated workspace");
  return path;
}

function atomicWrite(
  path: string,
  content: string,
  assertWriteAllowed?: (additionalBytes: number) => void,
): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxFileBytes) throw new Error("workspace files must not exceed 1 MiB");
  if (content.includes("\0")) throw new Error("workspace tools only support text files");
  // Atomic replacement temporarily needs space for the complete new file even
  // when an older destination will be removed by rename.
  assertWriteAllowed?.(bytes);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function readTextFile(path: string): string {
  const stats = statSync(path);
  if (stats.size > maxFileBytes) throw new Error("workspace files must not exceed 1 MiB");
  const content = readFileSync(path, "utf8");
  if (content.includes("\0")) throw new Error("workspace tools only support text files");
  return content;
}

function recordFileAction(
  context: WorkspaceToolContext,
  actionType: string,
  status: ActionRecord["status"],
  path: string,
  content?: string,
  replacements?: number,
): void {
  context.actions().push(context.store.addAction(actionType, status, {
    transport: "pi-tool",
    sessionId: context.sessionId,
    path,
    ...(content === undefined ? {} : { bytes: Buffer.byteLength(content, "utf8") }),
    ...(replacements === undefined ? {} : { replacements }),
  }));
}

function countOccurrences(content: string, search: string): number {
  if (!search) throw new Error("oldText must not be empty");
  let count = 0;
  let cursor = 0;
  while ((cursor = content.indexOf(search, cursor)) !== -1) {
    count += 1;
    cursor += search.length;
  }
  return count;
}

function workspaceRelative(workspaceDir: string, path: string): string {
  return relative(realpathSync(workspaceDir), path) || ".";
}

function isWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}
