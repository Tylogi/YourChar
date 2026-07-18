import type { Mode } from "../domain/types.js";
import type { ContextPlan } from "../context/types.js";
import { createRuntimeEnvelope } from "../context/turn-envelope.js";

export const TURN_CONTEXT_CUSTOM_TYPE = "rp-agent/turn_context";

export type TurnContextInput = {
  mode: Mode;
  timezone: string;
  now: Date;
  context: string;
  plan?: ContextPlan;
};

export function createTurnContextMessage(input: TurnContextInput) {
  const runtime = input.plan
    ? { content: input.plan.runtimeEnvelope, timezone: input.plan.timezone }
    : createRuntimeEnvelope(input.now, input.timezone);
  return {
    customType: TURN_CONTEXT_CUSTOM_TYPE,
    content: [
      runtime.content,
      input.context,
    ].filter(Boolean).join("\n\n"),
    display: false,
    details: {
      schemaVersion: input.plan ? 3 : 2,
      mode: input.mode,
      timezone: runtime.timezone,
      precision: "minute",
      snapshotId: input.plan ? `${input.plan.sessionId}:${input.plan.generatedAt}` : undefined,
      queryHash: input.plan?.queryHash,
      memoryIds: input.plan?.selectedMemoryIds ?? [],
      memoryVersions: input.plan?.selectedMemoryVersions ?? {},
      volatileContent: input.plan
        ? [runtime.content, input.plan.volatileContext].filter(Boolean).join("\n\n")
        : undefined,
      memoryContent: input.plan?.memoryContext,
      dynamicEstimatedTokens: input.plan?.dynamicEstimatedTokens,
    },
  } as const;
}
