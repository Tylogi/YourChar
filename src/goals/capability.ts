import type { CompanionStore } from "../domain/store.js";
import type {
  SessionCapability,
  SessionCapabilityDescriptor,
} from "../pi/session-capability.js";
import type { SessionGoalService, SessionGoalScope } from "./session-goals.js";
import { createSessionGoalTools } from "./tools.js";

export const sessionGoalCapabilityDescriptor: SessionCapabilityDescriptor = Object.freeze({
  id: "builtin:planning:session-goals",
  order: 875,
});

/** Bind durable planning through the generic handle-scoped capability seam. */
export function createSessionGoalCapability(options: Readonly<{
  service: SessionGoalService;
  store: CompanionStore;
}>): SessionCapability {
  return Object.freeze({
    ...sessionGoalCapabilityDescriptor,
    mount(context) {
      if (context.incognitoChild) return undefined;
      const scope: SessionGoalScope = Object.freeze({
        parentSessionId: context.sessionId,
        mode: context.mode,
        conversationSpace: context.conversationSpace,
        ...(context.characterId ? { characterId: context.characterId } : {}),
        ...(context.conversationSpace === "secret" && context.characterId
          ? { secretOwnerCharacterId: context.characterId }
          : {}),
      });
      return {
        tools: createSessionGoalTools({
          store: options.store,
          sessionId: context.sessionId,
          actions: context.actions,
          create: (input) => options.service.create(scope, input, "agent"),
          list: (listOptions) => options.service.list(context.sessionId, listOptions),
          get: (goalId, transitionLimit) =>
            options.service.get(context.sessionId, goalId, transitionLimit),
          update: (goalId, input) =>
            options.service.update(context.sessionId, goalId, input, "agent"),
          transition: (goalId, input) =>
            options.service.transition(context.sessionId, goalId, input, "agent"),
          setDependencies: (
            goalId,
            expectedRevision,
            dependencyGoalIds,
            transitionNote,
          ) => options.service.setDependencies(
            context.sessionId,
            goalId,
            expectedRevision,
            dependencyGoalIds,
            "agent",
            transitionNote,
          ),
          createTodo: (goalId, input) =>
            options.service.createTodo(context.sessionId, goalId, input, "agent"),
          updateTodo: (goalId, todoId, input) =>
            options.service.updateTodo(context.sessionId, goalId, todoId, input, "agent"),
          transitionTodo: (goalId, todoId, input) =>
            options.service.transitionTodo(
              context.sessionId,
              goalId,
              todoId,
              input,
              "agent",
            ),
        }),
      };
    },
  });
}
