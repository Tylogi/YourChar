import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ActionRecord, ConversationSpace, Mode } from "../domain/types.js";
import type { AgentPermissions } from "../modules/types.js";
import type { ScopedWorkspace } from "../workspace/scope.js";

const capabilityIdPattern = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const defaultCapabilityOrder = 10_000;

export type SessionCapabilityContext = Readonly<{
  sessionId: string;
  mode: Mode;
  conversationSpace: ConversationSpace;
  characterId?: string;
  workspace: ScopedWorkspace;
  permissions: Readonly<AgentPermissions>;
  incognitoChild: boolean;
  currentUserText: () => string;
  timezone: () => string;
  actions: () => ActionRecord[];
}>;

/**
 * One handle-scoped resource contribution. MCP bridges satisfy this interface,
 * but a trusted extension may also contribute native Pi tools directly.
 */
export type SessionCapabilityMount = Readonly<{
  tools: readonly ToolDefinition[];
  close?: () => void | Promise<void>;
}>;

/**
 * Deployment-trusted capability definition. Product settings and permissions
 * remain separate inputs; a definition must enforce its own admission policy.
 */
export type SessionCapability = Readonly<{
  id: string;
  order?: number;
  mount: (
    context: SessionCapabilityContext,
  ) => SessionCapabilityMount | undefined | Promise<SessionCapabilityMount | undefined>;
}>;

export type MountedSessionCapability = Readonly<{
  id: string;
  tools: readonly ToolDefinition[];
  close: () => Promise<void>;
}>;

export type SessionCapabilityDescriptor = Readonly<{
  id: string;
  order: number;
}>;

type NormalizedSessionCapability = Readonly<{
  id: string;
  order: number;
  mount: SessionCapability["mount"];
}>;

export class SessionCapabilityRegistrationError extends Error {
  readonly code = "SESSION_CAPABILITY_REGISTRATION_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SessionCapabilityRegistrationError";
  }
}

export class SessionCapabilityMountError extends Error {
  readonly code = "SESSION_CAPABILITY_MOUNT_FAILED";
  readonly capabilityId: string;

  constructor(capabilityId: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SessionCapabilityMountError";
    this.capabilityId = capabilityId;
  }
}

/**
 * Immutable registry used to assemble one Agent handle. Mounting is ordered and
 * transactional: a failure closes the current contribution and rolls back all
 * earlier contributions in reverse order.
 */
export class SessionCapabilityRegistry {
  private readonly capabilities: readonly NormalizedSessionCapability[];

  constructor(capabilities: readonly SessionCapability[] = []) {
    const ids = new Set<string>();
    const normalized = capabilities.map((capability) => {
      if (!capability || typeof capability !== "object") {
        throw new SessionCapabilityRegistrationError("session capability must be an object");
      }
      const id = typeof capability.id === "string" ? capability.id.trim() : "";
      if (!id || !capabilityIdPattern.test(id)) {
        throw new SessionCapabilityRegistrationError(
          `invalid session capability id: ${String(capability.id)}`,
        );
      }
      if (ids.has(id)) {
        throw new SessionCapabilityRegistrationError(`duplicate session capability id: ${id}`);
      }
      ids.add(id);
      if (typeof capability.mount !== "function") {
        throw new SessionCapabilityRegistrationError(
          `session capability ${id} must provide a mount function`,
        );
      }
      const order = capability.order ?? defaultCapabilityOrder;
      if (!Number.isSafeInteger(order)) {
        throw new SessionCapabilityRegistrationError(
          `session capability ${id} order must be a safe integer`,
        );
      }
      return Object.freeze({ id, order, mount: capability.mount });
    });
    this.capabilities = Object.freeze(
      normalized.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    );
  }

  list(): readonly SessionCapabilityDescriptor[] {
    return this.capabilities.map(({ id, order }) => Object.freeze({ id, order }));
  }

  async mountAll(
    context: SessionCapabilityContext,
    reservedToolNames: readonly string[] = [],
  ): Promise<MountedSessionCapability[]> {
    const mounted: MountedSessionCapability[] = [];
    const toolOwners = new Map<string, string>();
    for (const name of reservedToolNames) {
      if (typeof name !== "string" || !name.trim()) {
        throw new SessionCapabilityMountError(
          "host:tools",
          "host runtime supplied a tool without a valid name",
        );
      }
      const owner = toolOwners.get(name);
      if (owner) {
        throw new SessionCapabilityMountError(
          "host:tools",
          `host tool ${name} conflicts with ${owner}`,
        );
      }
      toolOwners.set(name, "host runtime");
    }

    for (const capability of this.capabilities) {
      let current: MountedSessionCapability | undefined;
      try {
        const contribution = await capability.mount(context);
        if (!contribution) continue;
        try {
          current = normalizeMount(capability.id, contribution);
        } catch (error) {
          await Promise.resolve(contribution.close?.()).catch(() => undefined);
          throw error;
        }
        for (const tool of current.tools) {
          const owner = toolOwners.get(tool.name);
          if (owner) {
            throw new SessionCapabilityMountError(
              capability.id,
              `tool ${tool.name} from ${capability.id} conflicts with ${owner}`,
            );
          }
          toolOwners.set(tool.name, capability.id);
        }
        mounted.push(current);
        current = undefined;
      } catch (error) {
        if (current) await current.close().catch(() => undefined);
        await closeMountedSessionCapabilities(mounted).catch(() => undefined);
        if (error instanceof SessionCapabilityMountError) throw error;
        throw new SessionCapabilityMountError(
          capability.id,
          `failed to mount session capability ${capability.id}`,
          error,
        );
      }
    }

    return mounted;
  }
}

export async function closeMountedSessionCapabilities(
  mounts: readonly MountedSessionCapability[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const mount of [...mounts].reverse()) {
    try {
      await mount.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, "one or more session capabilities failed to close");
  }
}

function normalizeMount(
  capabilityId: string,
  mount: SessionCapabilityMount,
): MountedSessionCapability {
  if (!mount || typeof mount !== "object" || !Array.isArray(mount.tools)) {
    throw new SessionCapabilityMountError(
      capabilityId,
      `session capability ${capabilityId} returned an invalid mount`,
    );
  }
  if (mount.close !== undefined && typeof mount.close !== "function") {
    throw new SessionCapabilityMountError(
      capabilityId,
      `session capability ${capabilityId} returned an invalid close handler`,
    );
  }
  const tools = [...mount.tools];
  for (const tool of tools) {
    if (
      !tool ||
      typeof tool !== "object" ||
      typeof tool.name !== "string" ||
      !tool.name.trim() ||
      tool.name !== tool.name.trim()
    ) {
      throw new SessionCapabilityMountError(
        capabilityId,
        `session capability ${capabilityId} returned a tool without a valid name`,
      );
    }
  }
  let closed = false;
  return Object.freeze({
    id: capabilityId,
    tools: Object.freeze(tools),
    async close() {
      if (closed) return;
      closed = true;
      await mount.close?.();
    },
  });
}
