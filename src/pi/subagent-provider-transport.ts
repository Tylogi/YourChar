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

export type SubagentProviderHttpTransport = {
  fetch: typeof globalThis.fetch;
  close(): Promise<void>;
};

/**
 * Create a transport dedicated to one delegated task. Pi injects this fetch
 * implementation into only that task's provider requests, so unrelated
 * application traffic and concurrent parent calls keep their own dispatchers.
 */
export function createSubagentProviderHttpTransport(
  dispatcher: Dispatcher = new Agent({
    allowH2: false,
    connectTimeout: subagentProviderTransportIdleTimeoutMs,
    headersTimeout: subagentProviderTransportIdleTimeoutMs,
    bodyTimeout: subagentProviderTransportIdleTimeoutMs,
  }),
): SubagentProviderHttpTransport {
  let closed = false;
  return {
    async fetch(input, init) {
      if (closed) throw new Error("Subagent provider transport is closed");
      return undiciFetch(input as never, {
        ...(init ?? {}),
        dispatcher,
      } as never) as unknown as Promise<Response>;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await dispatcher.close();
    },
  };
}
