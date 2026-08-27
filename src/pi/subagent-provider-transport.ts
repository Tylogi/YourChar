import { AsyncLocalStorage } from "node:async_hooks";
import {
  Agent,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";

/**
 * Delegated tasks already have a frozen wall-clock deadline. The provider
 * transport must not introduce Undici's independent five-minute idle cutoff.
 */
export const subagentProviderTransportIdleTimeoutMs = 0;

type ScopedProviderTransport = {
  dispatcher: Dispatcher;
};

const scopedProviderTransport = new AsyncLocalStorage<ScopedProviderTransport>();
let fallbackFetch: typeof globalThis.fetch | undefined;

const scopedFetch: typeof globalThis.fetch = async (input, init) => {
  const scope = scopedProviderTransport.getStore();
  if (!scope) {
    if (!fallbackFetch) throw new Error("Global fetch is unavailable");
    return fallbackFetch(input, init);
  }

  // Provider SDKs create their clients inside the scoped model call. Route
  // those requests through npm Undici with an explicit per-task dispatcher;
  // unrelated application fetches continue through the original global fetch.
  return undiciFetch(input as never, {
    ...(init ?? {}),
    dispatcher: scope.dispatcher,
  } as never) as unknown as Promise<Response>;
};

function installScopedFetch(): void {
  if (globalThis.fetch === scopedFetch) return;
  if (typeof globalThis.fetch !== "function") {
    throw new Error("Global fetch is unavailable");
  }
  fallbackFetch = globalThis.fetch;
  globalThis.fetch = scopedFetch;
}

export type SubagentProviderHttpTransport = {
  run<T>(callback: () => T): T;
  close(): Promise<void>;
};

/**
 * Create a transport dedicated to one delegated task. AsyncLocalStorage keeps
 * the override scoped even when several parent and child model calls overlap.
 */
export function createSubagentProviderHttpTransport(
  dispatcher: Dispatcher = new Agent({
    allowH2: false,
    connectTimeout: subagentProviderTransportIdleTimeoutMs,
    headersTimeout: subagentProviderTransportIdleTimeoutMs,
    bodyTimeout: subagentProviderTransportIdleTimeoutMs,
  }),
): SubagentProviderHttpTransport {
  installScopedFetch();
  let closed = false;
  return {
    run<T>(callback: () => T): T {
      if (closed) throw new Error("Subagent provider transport is closed");
      return scopedProviderTransport.run({ dispatcher }, callback);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await dispatcher.close();
    },
  };
}
