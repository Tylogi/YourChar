import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RpService } from "../rp/service.js";
import type { CompanionStore } from "./store.js";
import type { ActionRecord, Mode } from "./types.js";
import type { ContextPlan } from "../context/types.js";

type RuntimeState = {
  store: CompanionStore;
  rpService: RpService;
  sessionId: string;
  mode: Mode;
  characterId?: string;
  actions: ActionRecord[];
  stableContextPrompt: string;
  turnContextPrompt: string;
  contextPlan?: ContextPlan;
  memoryTouchCompleted: boolean;
  pendingEconomicsIds: string[];
  cacheBreakReason?: string;
  timezone: string;
  traceKind: "user" | "reminder_due";
  traceRequestText: string;
  currentUserText: string;
  toolMutationsAllowed: boolean;
  realWorldMutationConfirmed: boolean;
  confirmedMutationId?: string;
  confirmedToolName?: string;
  outputGuardRetryUsed: boolean;
  outputGuardBlocked: boolean;
  outputGuardRecoveryPrompt?: string;
  toolProtocolLeakBlocked: boolean;
  toolProtocolLeakRetryUsed: boolean;
  interactiveThinkingRequired: boolean;
  interactiveThinkingMissing: boolean;
  interactiveThinkingRetryCount: number;
  interactiveThinkingRetryPrompt?: string;
  toolCallObserved: boolean;
  workspaceSharePaths: string[];
};

export type CompanionToolRuntimeState = RuntimeState;

export function createRpTools(state: RuntimeState): ToolDefinition<any, any>[] {
  if (!state.characterId) return [];
  return state.mode === "rp" ? [updateSceneTool(state)] : [];
}

const updateSceneParameters = Type.Object({
  location: Type.Optional(Type.String()),
  inWorldTime: Type.Optional(Type.String()),
  participants: Type.Optional(Type.Array(Type.String())),
  currentObjective: Type.Optional(Type.String()),
  openThreads: Type.Optional(Type.Array(Type.String())),
  summary: Type.Optional(Type.String()),
});


function updateSceneTool(state: RuntimeState): ToolDefinition<typeof updateSceneParameters, unknown> {
  return defineTool({
    name: "update_scene",
    label: "Update RP scene",
    description: "Update durable current-scene state after a meaningful RP transition. Do not copy ordinary dialogue into the summary.",
    parameters: updateSceneParameters,
    executionMode: "sequential",
    async execute(toolCallId, input) {
      if (state.mode !== "rp" || !state.characterId) {
        throw new Error("update_scene requires an RP session with a selected character");
      }
      const scene = state.rpService.updateScene(
        state.sessionId,
        input,
        state.characterId,
        toolCallId,
      );
      const action = state.store.addAction("update_scene", "completed", {
        roleSessionId: scene.roleSessionId,
        location: scene.location,
      });
      state.actions.push(action);
      return {
        content: [{ type: "text", text: "当前场景已更新。" }],
        details: scene,
      };
    },
  });
}
