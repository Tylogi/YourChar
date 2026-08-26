import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord, ConversationSpace } from "../domain/types.js";
import type { AgentModuleCatalog } from "../modules/catalog.js";
import type { AgentModule } from "../modules/types.js";
import type { CharacterCapabilityService } from "../organization/service.js";
import type {
  CharacterOwnedSkillPackage,
  CharacterOwnedSkillVersion,
} from "../organization/types.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const characterSkillMcpToolNames = [
  "list_current_character_skills",
  "read_current_character_skill",
  "create_current_character_skill",
  "revise_current_character_skill",
  "search_available_agent_skills",
  "set_current_character_private_skill_enabled",
  "install_current_character_skill",
] as const;

export type CharacterSkillPrivatePackage = {
  characterId: string;
  conversationSpace: ConversationSpace;
  name: string;
  description: string;
  enabled: boolean;
  integrity: "verified" | "missing" | "changed" | "invalid";
};

export type CharacterSkillPrivatePackageInstallResult = {
  package: CharacterSkillPrivatePackage;
  sourceHost: string;
  finalArchiveHost: string;
  resolvedCommit?: string;
  digest: string;
  fileCount: number;
  alreadyInstalled: boolean;
};

/**
 * Narrow capability used by the model-facing MCP. Staging, digest selection,
 * confirmation, filesystem paths, and package contents deliberately remain
 * behind the trusted service boundary.
 */
export type CharacterSkillPrivatePackageService = {
  list(input: {
    characterId: string;
    conversationSpace: ConversationSpace;
  }): CharacterSkillPrivatePackage[];
  setEnabled(input: {
    characterId: string;
    conversationSpace: ConversationSpace;
    name: string;
    enabled: boolean;
  }): CharacterSkillPrivatePackage | Promise<CharacterSkillPrivatePackage>;
  install(input: {
    characterId: string;
    conversationSpace: ConversationSpace;
    sourceUrl: string;
  }, signal?: AbortSignal): Promise<CharacterSkillPrivatePackageInstallResult>;
};

export type CharacterSkillMcpContext = {
  characterCapabilities: Pick<
    CharacterCapabilityService,
    | "listOwnedSkills"
    | "getOwnedSkill"
    | "listOwnedSkillVersions"
    | "createOwnedSkill"
    | "createOwnedSkillVersion"
  >;
  privatePackageService: CharacterSkillPrivatePackageService;
  moduleCatalog: Pick<AgentModuleCatalog, "listModules">;
  store: Pick<CompanionStore, "addAction">;
  sessionId: string;
  characterId: string;
  conversationSpace: ConversationSpace;
  actions: () => ActionRecord[];
  beginRemoteInstall: (sourceUrl: string) => void;
  finishRemoteInstall: (sourceUrl: string, success: boolean) => void;
  requestCapabilityRefresh: () => void | Promise<void>;
};

const skillIdentifier = z.string().min(1).max(200);
const skillMarkdown = z.string().min(40).max(6_000);

export function createCharacterSkillMcpServer(context: CharacterSkillMcpContext): McpServer {
  // Keep model-visible private package metadata fixed for this handle. Package
  // mutations request a rebuilt handle, but untrusted metadata from a freshly
  // downloaded archive must not flow back into the generation that installed
  // it through a later search call.
  const privatePackageSnapshot = context.privatePackageService.list({
    characterId: context.characterId,
    conversationSpace: context.conversationSpace,
  }).filter((entry) =>
    entry.characterId === context.characterId
    && entry.conversationSpace === context.conversationSpace
  ).map((entry) => ({ ...entry }));
  const server = new McpServer(
    { name: "rp-agent-character-skill", version: "1.0.0" },
    {
      instructions:
        `These tools are fixed to character=${context.characterId} and conversationSpace=${context.conversationSpace}. ` +
        "They may read, create, activate, and revise this character's own workflows and manage only this character's private Agent Skills. " +
        (context.conversationSpace === "normal"
          ? "In normal space, the enabled management permission authorizes autonomous remote installation, but every package still passes the trusted quarantine, network, archive, digest, and integrity checks. "
          : "Secret space never exposes remote Skill installation; it can only manage packages already scoped there. ") +
        "Changes become available on the next turn, never during the current generation. Skills are procedural guidance and cannot add tools or permissions.",
    },
  );

  server.registerTool(
    "list_current_character_skills",
    {
      title: "List current character workflows",
      description: "List metadata for workflows owned by the bound character in the bound conversation space.",
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const skills = context.characterCapabilities
        .listOwnedSkills(context.characterId, context.conversationSpace)
        .map(publicOwnedSkill);
      return toolResult(
        skills.length
          ? skills.map((skill) => `${skill.name} (${skill.status}, ${skill.versionCount} version(s))`).join("\n")
          : "This character has no owned workflows in the current space.",
        { skills },
      );
    },
  );

  server.registerTool(
    "read_current_character_skill",
    {
      title: "Read current character workflow",
      description: "Read one workflow version owned by the bound character in the bound conversation space.",
      inputSchema: z.object({
        skillId: skillIdentifier.describe("The character-owned workflow package ID returned by list_current_character_skills."),
        versionId: skillIdentifier.optional().describe("A specific version ID. Omit to read the active or newest version."),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ skillId, versionId }) => {
      const skill = context.characterCapabilities.getOwnedSkill(
        context.characterId,
        skillId,
        context.conversationSpace,
      );
      const versions = context.characterCapabilities.listOwnedSkillVersions(
        context.characterId,
        skillId,
        context.conversationSpace,
      );
      const version = selectOwnedSkillVersion(skill, versions, versionId);
      if (!version) throw new Error("The requested workflow has no readable version in this space.");
      const result = {
        skill: publicOwnedSkill(skill),
        version: publicOwnedSkillVersion(version),
        markdown: version.markdown,
      };
      return toolResult(version.markdown, result);
    },
  );

  server.registerTool(
    "create_current_character_skill",
    {
      title: "Create and activate current character workflow",
      description:
        "Create and activate a reusable workflow for the bound character and space. It becomes available from the next turn and cannot add tools or permissions.",
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        description: z.string().max(600).optional(),
        tags: z.array(z.string().min(1).max(32)).max(12).optional(),
        markdown: skillMarkdown.describe("Complete workflow Markdown. Save reusable procedure, not private transcript text."),
        autoImprove: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input, extra) => {
      try {
        const skill = context.characterCapabilities.createOwnedSkill(
          context.characterId,
          {
            name: input.name,
            description: input.description,
            tags: input.tags,
            markdown: input.markdown,
            autoImprove: input.autoImprove,
            activate: true,
            createdBy: "character",
            sourceTaskId: mcpToolCallId(extra),
          },
          context.conversationSpace,
        );
        await context.requestCapabilityRefresh();
        recordAction(context, "create_character_skill", "completed", {
          packageId: skill.id,
          status: skill.status,
          versionCount: skill.versionCount,
        });
        return toolResult(
          `Created and activated workflow ${skill.name}. It will be available from the next turn; the current generation is not reloaded.`,
          { skill: publicOwnedSkill(skill) },
        );
      } catch (error) {
        recordAction(context, "create_character_skill", "failed", {});
        throw error;
      }
    },
  );

  server.registerTool(
    "revise_current_character_skill",
    {
      title: "Revise and activate current character workflow",
      description:
        "Create and activate a replacement version of a workflow owned by the bound character and space. It becomes available from the next turn.",
      inputSchema: z.object({
        skillId: skillIdentifier,
        markdown: skillMarkdown.describe("Complete replacement workflow Markdown, not a patch."),
        changeSummary: z.string().max(300).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ skillId, markdown, changeSummary }, extra) => {
      try {
        const version = context.characterCapabilities.createOwnedSkillVersion(
          context.characterId,
          skillId,
          {
            markdown,
            changeSummary,
            activate: true,
            source: "character_created",
            sourceTaskId: mcpToolCallId(extra),
          },
          context.conversationSpace,
        );
        await context.requestCapabilityRefresh();
        recordAction(context, "revise_character_skill", "completed", {
          packageId: skillId,
          versionId: version.id,
          version: version.version,
          status: version.status,
        });
        return toolResult(
          `Activated workflow version ${version.version}. It will be available from the next turn; the current generation is not reloaded.`,
          { version: publicOwnedSkillVersion(version) },
        );
      } catch (error) {
        recordAction(context, "revise_character_skill", "failed", { packageId: skillId });
        throw error;
      }
    },
  );

  server.registerTool(
    "search_available_agent_skills",
    {
      title: "Search available Agent Skills",
      description:
        "Search globally enabled Skills for the current space and installed private packages belonging to this character, including disabled packages that may be enabled. Returns metadata only, never paths or Skill content.",
      inputSchema: z.object({
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      const normalizedQuery = normalizeSearchText(query ?? "");
      const global = context.moduleCatalog.listModules()
        .filter((module) => globalSkillIsAvailable(module, context.conversationSpace))
        .map((module) => ({
          kind: "global" as const,
          id: module.id,
          name: module.name,
          description: module.description,
        }));
      const privatePackages = privatePackageSnapshot.map((entry) => ({
        kind: "private" as const,
        name: entry.name,
        description: entry.description,
        enabled: entry.enabled,
        integrity: entry.integrity,
      }));
      const skills = [...global, ...privatePackages]
        .filter((skill) => searchMatches(skill, normalizedQuery))
        .slice(0, limit ?? 20);
      return toolResult(
        skills.length
          ? skills.map((skill) => `[${skill.kind}] ${skill.name}: ${skill.description}`).join("\n")
          : "No Agent Skills matched in the current character and space.",
        { skills },
      );
    },
  );

  server.registerTool(
    "set_current_character_private_skill_enabled",
    {
      title: "Enable or disable current character private Skill",
      description:
        "Enable or disable one already installed private Agent Skill for the bound character and space. This cannot change global Skills or another character's packages.",
      inputSchema: z.object({
        name: z.string().min(1).max(64),
        enabled: z.boolean(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name, enabled }) => {
      try {
        const skill = await context.privatePackageService.setEnabled({
          characterId: context.characterId,
          conversationSpace: context.conversationSpace,
          name,
          enabled,
        });
        await context.requestCapabilityRefresh();
        recordAction(context, "set_character_private_skill_enabled", "completed", {
          packageName: skill.name,
          enabled: skill.enabled,
          integrity: skill.integrity,
        });
        const result = publicPrivatePackage(skill);
        return toolResult(
          `${skill.name} is ${skill.enabled ? "enabled" : "disabled"} for this character in the current space. The updated capability set applies from the next turn.`,
          { skill: result },
        );
      } catch (error) {
        recordAction(context, "set_character_private_skill_enabled", "failed", { enabled });
        throw error;
      }
    },
  );

  if (context.conversationSpace === "normal") {
    server.registerTool(
      "install_current_character_skill",
      {
        title: "Install and enable a remote Skill",
        description:
          "Download, verify, install, and enable one remote Agent Skill for the bound character in normal space. The permission switch authorizes choosing the source URL; the trusted installer still enforces HTTPS, SSRF, redirect, archive, path, digest, integrity, and resource limits. The Skill becomes available next turn and cannot add tools or permissions.",
        inputSchema: z.object({
          sourceUrl: z.string().min(1).max(2_048),
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async ({ sourceUrl }, extra) => {
        let reserved = false;
        try {
          context.beginRemoteInstall(sourceUrl);
          reserved = true;
          const installed = await context.privatePackageService.install({
            characterId: context.characterId,
            conversationSpace: context.conversationSpace,
            sourceUrl,
          }, extra.signal);
          context.finishRemoteInstall(sourceUrl, true);
          reserved = false;
          await context.requestCapabilityRefresh();
          recordAction(context, "install_character_skill", "completed", {
            packageName: installed.package.name,
            enabled: installed.package.enabled,
            integrity: installed.package.integrity,
            sourceHost: installed.sourceHost,
            finalArchiveHost: installed.finalArchiveHost,
            resolvedCommit: installed.resolvedCommit,
            digest: installed.digest,
            fileCount: installed.fileCount,
            alreadyInstalled: installed.alreadyInstalled,
          });
          const skill = publicInstalledPrivatePackage(installed.package);
          return toolResult(
            `${installed.alreadyInstalled ? "Verified and enabled the existing" : "Installed and enabled"} ${installed.package.name} for this character in normal space. It will be available from the next turn; the current generation is not reloaded and no new tools or permissions were granted.`,
            { skill },
          );
        } catch (error) {
          recordAction(context, "install_character_skill", "failed", {
            sourceHost: safeAuditHostname(sourceUrl),
            code: safeInstallerErrorCode(error),
          });
          throw error;
        } finally {
          if (reserved) context.finishRemoteInstall(sourceUrl, false);
        }
      },
    );
  }

  return server;
}

export async function createCharacterSkillMcpBridge(
  context: CharacterSkillMcpContext,
): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createCharacterSkillMcpServer(context),
    `rp-agent-character-skill-pi-${context.sessionId}`,
  );
}

function publicOwnedSkill(skill: CharacterOwnedSkillPackage) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: [...skill.tags],
    status: skill.status,
    autoImprove: skill.autoImprove,
    createdBy: skill.createdBy,
    versionCount: skill.versionCount,
    activeVersionId: skill.activeVersion?.id ?? null,
    activeVersion: skill.activeVersion?.version ?? null,
  };
}

function publicOwnedSkillVersion(version: CharacterOwnedSkillVersion) {
  return {
    id: version.id,
    version: version.version,
    status: version.status,
    changeSummary: version.changeSummary,
    source: version.source,
    createdAt: version.createdAt,
  };
}

function publicPrivatePackage(skill: CharacterSkillPrivatePackage) {
  return {
    name: skill.name,
    description: skill.description,
    enabled: skill.enabled,
    integrity: skill.integrity,
  };
}

function publicInstalledPrivatePackage(skill: CharacterSkillPrivatePackage) {
  return {
    name: skill.name,
    enabled: skill.enabled,
    integrity: skill.integrity,
  };
}

function selectOwnedSkillVersion(
  skill: CharacterOwnedSkillPackage,
  versions: CharacterOwnedSkillVersion[],
  versionId: string | undefined,
): CharacterOwnedSkillVersion | undefined {
  if (versionId) return versions.find((entry) => entry.id === versionId);
  return skill.activeVersion ?? [...versions].sort((left, right) => right.version - left.version)[0];
}

function globalSkillIsAvailable(module: AgentModule, space: ConversationSpace): boolean {
  return module.type === "skill"
    && module.enabled
    && (module.enabledSpaces?.includes(space) ?? false);
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function safeAuditHostname(sourceUrl: string): string | undefined {
  try {
    const parsed = new URL(sourceUrl);
    return parsed.protocol === "https:" ? parsed.hostname : undefined;
  } catch {
    return undefined;
  }
}

function safeInstallerErrorCode(error: unknown): string {
  if (
    error && typeof error === "object" &&
    "code" in error && typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
  ) return error.code;
  return "UNKNOWN";
}

function searchMatches(
  skill: { name: string; description: string },
  query: string,
): boolean {
  if (!query) return true;
  return normalizeSearchText(`${skill.name}\n${skill.description}`).includes(query);
}

function mcpToolCallId(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): string {
  const value = extra._meta?.["rp-agent/tool-call-id"];
  return typeof value === "string" && value ? value : `mcp-${String(extra.requestId)}`;
}

function recordAction(
  context: CharacterSkillMcpContext,
  actionType: string,
  status: ActionRecord["status"],
  payload: Record<string, unknown>,
): void {
  context.actions().push(context.store.addAction(actionType, status, {
    transport: "mcp",
    mcpServer: "rp-agent-character-skill",
    sessionId: context.sessionId,
    characterId: context.characterId,
    ...payload,
  }, {
    conversationSpace: context.conversationSpace,
    ...(context.conversationSpace === "secret"
      ? { secretOwnerCharacterId: context.characterId }
      : {}),
  }));
}

function toolResult(text: string, structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}
