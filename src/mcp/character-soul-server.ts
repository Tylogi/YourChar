import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { CompanionStore } from "../domain/store.js";
import type { ActionRecord } from "../domain/types.js";
import type { RpService } from "../rp/service.js";
import { connectMcpServerToPi, type McpPiBridge } from "./pi-adapter.js";

export const characterSoulMcpToolNames = [
  "get_current_character_soul",
  "update_current_character_soul",
] as const;

export type CharacterSoulMcpContext = {
  rpService: RpService;
  store: CompanionStore;
  sessionId: string;
  characterId: string;
  actions: () => ActionRecord[];
};

export function createCharacterSoulMcpServer(context: CharacterSoulMcpContext): McpServer {
  const server = new McpServer(
    { name: "rp-agent-character-soul", version: "1.0.0" },
    {
      instructions:
        "SOUL.md is the authoritative identity of the current role-play character. Preserve the complete document and change it only when the user explicitly asks to revise enduring character identity, voice, values, relationship defaults, or boundaries. Never use it for transient scene state.",
    },
  );

  server.registerTool(
    "get_current_character_soul",
    {
      title: "Get current character SOUL.md",
      description: "Read the complete SOUL.md for the character bound to this RP session before replacing it.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const character = context.rpService.getCharacter(context.characterId);
      return {
        content: [{ type: "text" as const, text: character.soulMarkdown }],
        structuredContent: {
          characterId: character.id,
          characterName: character.name,
          markdown: character.soulMarkdown,
          characterCount: character.soulCharacterCount,
          maxCharacters: character.soulMaxCharacters,
        },
      };
    },
  );

  server.registerTool(
    "update_current_character_soul",
    {
      title: "Update current character SOUL.md",
      description:
        "Replace the complete SOUL.md for the current RP character after an explicit user request. Read it first, preserve still-valid identity, and keep transient scene facts in scene or memory tools instead.",
      inputSchema: z.object({
        markdown: z.string().describe("The complete replacement SOUL.md document, not a patch."),
        reason: z.string().describe("A short explanation of the explicit character-setting change."),
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ markdown, reason }) => {
      const character = context.rpService.updateCharacter(context.characterId, { soulMarkdown: markdown });
      context.actions().push(
        context.store.addAction("update_character_soul", "completed", {
          transport: "mcp",
          mcpServer: "rp-agent-character-soul",
          sessionId: context.sessionId,
          characterId: character.id,
          characterCount: character.soulCharacterCount,
          reason,
        }),
      );
      return {
        content: [{
          type: "text" as const,
          text: `角色 ${character.name} 的 SOUL.md 已更新（${character.soulCharacterCount}/${character.soulMaxCharacters}）。请明确告知用户。`,
        }],
        structuredContent: {
          characterId: character.id,
          characterName: character.name,
          markdown: character.soulMarkdown,
          characterCount: character.soulCharacterCount,
          maxCharacters: character.soulMaxCharacters,
        },
      };
    },
  );

  return server;
}

export async function createCharacterSoulMcpBridge(
  context: CharacterSoulMcpContext,
): Promise<McpPiBridge> {
  return connectMcpServerToPi(
    createCharacterSoulMcpServer(context),
    `rp-agent-character-soul-pi-${context.sessionId}`,
  );
}
