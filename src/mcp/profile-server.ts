import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import { profileManualSection, replaceProfileManualSection } from "../profile/managed-memory.js";
import type { UserProfileService } from "../profile/service.js";
import type { UserProfileDocument } from "../profile/types.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const userProfileMcpToolNames = [
  "get_user_profile",
  "update_user_profile",
] as const;

export type UserProfileMcpContext = {
  profileService: UserProfileService;
  store: CompanionStore;
  sessionId: string;
  actions: () => ActionRecord[];
  allowWrite?: boolean;
};

export function createUserProfileMcpServer(context: UserProfileMcpContext): McpServer {
  const server = new McpServer(
    { name: "rp-agent-user-profile", version: "1.0.0" },
    {
      instructions:
        "The User Profile tool manages only the manual compact reality/global summary, limited to 2000 Unicode characters together with the hidden managed section. Confirmed reality memories are the durable fact store and their managed projection is Coordinator-owned. Never store secrets, guesses, temporary moods, character memory, or fictional role-play facts.",
    },
  );

  server.registerTool(
    "get_user_profile",
    {
      title: "Get user profile",
      description: "Read the model-visible manual user-profile Markdown before replacing that manual section.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const profile = modelVisibleProfile(context.profileService.get());
      return {
        content: [{ type: "text" as const, text: profile.markdown }],
        structuredContent: { ...profile },
      };
    },
  );

  if (context.allowWrite ?? true) {
    server.registerTool(
      "update_user_profile",
      {
        title: "Update user profile",
        description:
          "Replace only the manual user-profile Markdown after the user clearly reveals stable, useful information. Read it first, preserve still-valid manual content, stay within the shared 2000-character limit, and do not update for ordinary conversation. The Coordinator-owned managed memory section is preserved automatically.",
        inputSchema: z.object({
          markdown: z.string().describe("The complete replacement manual Markdown section, not a patch."),
          reason: z.string().optional().describe("A short explanation of the stable information being incorporated."),
        }),
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      async ({ markdown, reason }) => {
        const current = context.profileService.get();
        const persisted = context.profileService.update(
          replaceProfileManualSection(current.markdown, markdown),
        );
        const profile = modelVisibleProfile(persisted);
        context.actions().push(
          context.store.addAction("update_user_profile", "completed", {
            transport: "mcp",
            mcpServer: "rp-agent-user-profile",
            sessionId: context.sessionId,
            characterCount: profile.characterCount,
            reason,
          }),
        );
        return {
          content: [{ type: "text" as const, text: `用户画像已更新（${profile.characterCount}/2000）。` }],
          structuredContent: { ...profile },
        };
      },
    );
  }

  return server;
}

function modelVisibleProfile(profile: UserProfileDocument): UserProfileDocument {
  const markdown = profileManualSection(profile.markdown);
  return {
    ...profile,
    markdown,
    characterCount: [...markdown].length,
  };
}

export async function createUserProfileMcpBridge(
  context: UserProfileMcpContext,
): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createUserProfileMcpServer(context),
    `rp-agent-profile-pi-${context.sessionId}`,
  );
}
