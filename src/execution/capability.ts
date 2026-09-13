import type { CompanionStore } from "../domain/store.js";
import type {
  SessionCapability,
  SessionCapabilityDescriptor,
} from "../pi/session-capability.js";
import type { ExecutionJobService } from "./shell-jobs.js";
import { createExecutionJobTools } from "./tools.js";

export const executionJobCapabilityDescriptor: SessionCapabilityDescriptor = Object.freeze({
  id: "builtin:execution:shell-jobs",
  order: 850,
});

/**
 * Bind the host-owned execution service through the generic session capability
 * seam. PiSessionRuntime does not need to know this service or its tool names.
 */
export function createExecutionJobCapability(options: Readonly<{
  service: ExecutionJobService;
  store: CompanionStore;
}>): SessionCapability {
  return Object.freeze({
    ...executionJobCapabilityDescriptor,
    mount(context) {
      if (
        context.incognitoChild ||
        !context.permissions.shellEnabled ||
        !context.permissions.shellAvailable
      ) {
        return undefined;
      }
      return {
        tools: createExecutionJobTools({
          store: options.store,
          sessionId: context.sessionId,
          actions: context.actions,
          start: (input) => options.service.start({
            parentSessionId: context.sessionId,
            command: input.command,
            mode: context.mode,
            conversationSpace: context.conversationSpace,
            ...(context.characterId ? { characterId: context.characterId } : {}),
            ...(context.conversationSpace === "secret" && context.characterId
              ? { secretOwnerCharacterId: context.characterId }
              : {}),
            workspaceKey: context.workspace.key,
            workspaceDir: context.workspace.dir,
            workspaceAccess: context.permissions.workspaceAccess,
            networkEnabled: context.permissions.networkEnabled,
            ...(input.timeoutSeconds === undefined
              ? {}
              : { timeoutSeconds: input.timeoutSeconds }),
          }),
          interrupt: (jobId) =>
            options.service.interrupt(context.sessionId, jobId),
          list: (limit) => options.service.list(context.sessionId, limit),
          get: (jobId) => options.service.get(context.sessionId, jobId),
          output: (jobId, outputOptions) =>
            options.service.output(context.sessionId, jobId, outputOptions),
        }),
      };
    },
  });
}
