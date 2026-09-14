import type { CompanionStore } from "../domain/store.js";
import type {
  SessionCapability,
  SessionCapabilityContext,
  SessionCapabilityDescriptor,
} from "../pi/session-capability.js";
import type { SessionWorkflowCoordinator } from "./coordinator.js";
import type {
  SessionWorkflowGrantCeiling,
  SessionWorkflowScope,
  SessionWorkflowService,
} from "./session-workflows.js";
import { createSessionWorkflowTools } from "./tools.js";

export const sessionWorkflowCapabilityDescriptor: SessionCapabilityDescriptor = Object.freeze({
  id: "builtin:orchestration:workflows",
  order: 880,
});

export function createSessionWorkflowCapability(options: Readonly<{
  service: SessionWorkflowService;
  coordinator: () => SessionWorkflowCoordinator;
  store: CompanionStore;
  grantCeiling: (context: SessionCapabilityContext) => SessionWorkflowGrantCeiling;
}>): SessionCapability {
  return Object.freeze({
    ...sessionWorkflowCapabilityDescriptor,
    mount(context) {
      if (context.incognitoChild) return undefined;
      const scope: SessionWorkflowScope = Object.freeze({
        parentSessionId: context.sessionId,
        mode: context.mode,
        conversationSpace: context.conversationSpace,
        ...(context.characterId ? { characterId: context.characterId } : {}),
        ...(context.conversationSpace === "secret" && context.characterId
          ? { secretOwnerCharacterId: context.characterId }
          : {}),
      });
      return {
        tools: createSessionWorkflowTools({
          store: options.store,
          sessionId: context.sessionId,
          actions: context.actions,
          create: (input) => options.service.create(
            scope,
            input,
            options.grantCeiling(context),
            "agent",
          ),
          start: (workflowId, expectedRevision) => options.coordinator().start(
            context.sessionId,
            workflowId,
            expectedRevision,
            "agent",
          ),
          cancel: (workflowId, expectedRevision, note) => options.coordinator().cancel(
            context.sessionId,
            workflowId,
            expectedRevision,
            note,
            "agent",
          ),
          list: (listOptions) => options.service.list(context.sessionId, listOptions),
          get: (workflowId, eventLimit) =>
            options.service.get(context.sessionId, workflowId, eventLimit),
        }),
      };
    },
  });
}
