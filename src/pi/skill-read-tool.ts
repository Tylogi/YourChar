import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { defineTool, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkspaceAccess } from "../modules/types.js";

const maxReadableBytes = 1024 * 1024;

const readParameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number({ minimum: 1 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000 })),
});

export function createSkillReadTool(
  skills: Skill[],
  appRoot: string,
  workspaceDir?: string,
  workspaceAccess: WorkspaceAccess = "off",
): ToolDefinition<typeof readParameters, unknown> | undefined {
  if (!skills.length && workspaceAccess === "off") return undefined;
  const skillRoots = skills.map((skill) => realpathSync(skill.baseDir));
  const workspaceRoot = workspaceDir && workspaceAccess !== "off"
    ? realpathSync(workspaceDir)
    : undefined;
  return defineTool({
    name: "read",
    label: "Read allowed file",
    description: workspaceRoot
      ? "Read a text file in the dedicated workspace or an enabled Skill directory. Other filesystem paths are blocked."
      : "Read a text file inside an enabled Skill directory. Other filesystem paths are blocked.",
    parameters: readParameters,
    executionMode: "parallel",
    async execute(_toolCallId, input) {
      const path = resolveReadablePath(input.path, appRoot, skillRoots, workspaceRoot);
      if (!statSync(path).isFile()) throw new Error("read path must be a file");
      const stats = statSync(path);
      if (stats.size > maxReadableBytes) throw new Error("read path exceeds the 1 MiB limit");
      const content = readFileSync(path, "utf8");
      if (content.includes("\0")) throw new Error("read only supports text files");
      const lines = content.split(/\r?\n/);
      const offset = Math.max(1, Math.floor(input.offset ?? 1));
      const limit = Math.min(2_000, Math.max(1, Math.floor(input.limit ?? 500)));
      const selected = lines.slice(offset - 1, offset - 1 + limit);
      return {
        content: [{ type: "text", text: selected.map((line, index) => `${offset + index}: ${line}`).join("\n") }],
        details: { path, offset, lines: selected.length, totalLines: lines.length },
      };
    },
  });
}

function resolveReadablePath(
  requestedPath: string,
  appRoot: string,
  skillRoots: string[],
  workspaceRoot?: string,
): string {
  const candidates = isAbsolute(requestedPath)
    ? [requestedPath]
    : [
        ...(workspaceRoot ? [resolve(workspaceRoot, requestedPath)] : []),
        resolve(appRoot, requestedPath),
      ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    if (
      (workspaceRoot && isWithin(workspaceRoot, path)) ||
      skillRoots.some((root) => isWithin(root, path))
    ) {
      return path;
    }
  }
  throw new Error("read is restricted to the workspace and enabled Skill directories");
}

function isWithin(root: string, path: string): boolean {
  const nested = relative(root, path);
  return nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`));
}
