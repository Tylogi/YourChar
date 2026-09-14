import { join, resolve } from "node:path";
import { EPHEMERAL_STATE_DIRECTORY_NAME } from "./app/state-directory.js";
import { CompanionKernel, CompanionStore } from "./domain/index.js";
import {
  createImGatewayFromEnvironment,
  LocalImGateway,
  type LocalImCore,
  UnavailableImGateway,
} from "./im/index.js";
import { createHttpServer, disposeHttpServerOwnedResources } from "./http/router.js";
import { createBundledTypeScriptLspRuntimeConfiguration } from "./lsp/index.js";

const port = Number(process.env.PORT ?? 8765);
const host = process.env.HOST ?? "127.0.0.1";
const testMode = process.env.RP_AGENT_TEST_MODE === "1";
const forceShutdownAfterMs = 10_000;
const hardExitAfterMs = 1_000;

if (!isLoopbackHost(host)) {
  throw new Error(
    "YourChar browser UI may only bind to a loopback host; headless authentication does not authorize a remote bind",
  );
}

const imRuntimeMode = resolveImRuntimeMode(process.env, testMode);
const store = new CompanionStore();
const workspaceDir = resolve(
  store.stateDir
    ? join(store.stateDir, "workspace")
    : join(process.cwd(), EPHEMERAL_STATE_DIRECTORY_NAME, "workspace"),
);
if (store.stateDirectoryMigrationNeeded) {
  console.warn(
    `Using legacy state directory ${store.stateDir}; stop YourChar and run npm run migrate:state before removing .rp-agent compatibility`,
  );
}
const localImGateway = imRuntimeMode === "local"
  ? new LocalImGateway(requiredStateDirectory(store.stateDir), workspaceDir)
  : undefined;
const imGateway = localImGateway ?? (imRuntimeMode === "external"
  ? createImGatewayFromEnvironment({
      ...process.env,
      YOURCHAR_IM_GATEWAY_URL: process.env.YOURCHAR_IM_GATEWAY_URL ??
        process.env.RP_AGENT_IM_GATEWAY_URL,
      YOURCHAR_IM_GATEWAY_TOKEN: process.env.YOURCHAR_IM_GATEWAY_TOKEN ??
        process.env.RP_AGENT_IM_GATEWAY_TOKEN,
    })
  : new UnavailableImGateway("IM Channel Runtime 已由 YOURCHAR_IM_RUNTIME_MODE=off 禁用"));
const lspRuntimeConfiguration = createBundledTypeScriptLspRuntimeConfiguration();
const kernel = new CompanionKernel({
  store,
  workspaceDir,
  imGateway,
  agentCapabilityPackages: lspRuntimeConfiguration.packages,
  agentRuntimeProfiles: lspRuntimeConfiguration.profiles,
});

if (localImGateway) {
  const localCore: LocalImCore = {
    isWechatTypingEnabled: () => kernel.isWechatTypingEnabled(),
    receiveInboundEvent: (event) => kernel.receiveImInboundEvent(event),
    claimPendingOutbox: (input) => kernel.claimImPendingOutbox(input),
    acknowledgeOutbox: (input) => kernel.acknowledgeImOutbox(input),
    authorizeOutbox: (id, leaseToken) => kernel.authorizeImOutbox(id, leaseToken),
  };
  try {
    await localImGateway.attachCore(localCore);
  } catch (error) {
    try {
      await localImGateway.dispose();
    } finally {
      kernel.dispose();
    }
    throw error;
  }
  console.log("Bundled IM Channel Runtime started (Feishu + WeChat).");
} else if (imRuntimeMode === "external") {
  console.log(`External IM Channel Runtime selected: ${imGateway.detail ?? "configured"}`);
}

const server = createHttpServer({ kernel, testMode });
server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  console.log(`YourChar listening on http://${host}:${listeningPort}`);
});

let shutdownStarted = false;
let resourceDisposalOperation: Promise<void> | undefined;

function disposeResources(): Promise<void> {
  if (resourceDisposalOperation) return resourceDisposalOperation;
  resourceDisposalOperation = (async () => {
    const errors: Error[] = [];
    if (localImGateway) {
      try {
        await localImGateway.dispose();
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      kernel.dispose();
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "failed to dispose YourChar resources");
  })();
  return resourceDisposalOperation;
}

function shutdown(signal: "SIGTERM" | "SIGINT"): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`YourChar received ${signal}; shutting down.`);

  let hardExitTimer: NodeJS.Timeout | undefined;
  const forceTimer = setTimeout(() => {
    console.error("YourChar graceful shutdown timed out; closing active HTTP connections.");
    server.closeAllConnections();
    hardExitTimer = setTimeout(() => {
      console.error("YourChar forced shutdown did not complete.");
      disposeHttpServerOwnedResources(server);
      void disposeResources().finally(() => process.exit(1));
    }, hardExitAfterMs);
  }, forceShutdownAfterMs);

  server.close(async (error) => {
    const notRunning = (error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING";
    if (error && !notRunning) {
      console.error("YourChar shutdown failed while releasing service resources.");
      process.exitCode = 1;
    }
    try {
      await disposeResources();
    } catch (disposeError) {
      console.error("YourChar shutdown failed while disposing runtime resources.", disposeError);
      process.exitCode = 1;
    } finally {
      clearTimeout(forceTimer);
      if (hardExitTimer) clearTimeout(hardExitTimer);
    }
    if (!process.exitCode) {
      console.log("YourChar stopped.");
      process.exitCode = 0;
    }
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function isLoopbackHost(value: string): boolean {
  if (value === "::1") return true;
  const octets = value.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const number = Number(octet);
    return number >= 0 && number <= 255;
  });
}

type ImRuntimeMode = "local" | "external" | "off";

function resolveImRuntimeMode(
  environment: NodeJS.ProcessEnv,
  isTestMode: boolean,
): ImRuntimeMode {
  const configured = (
    environment.YOURCHAR_IM_RUNTIME_MODE ??
    environment.RP_AGENT_IM_RUNTIME_MODE ??
    "auto"
  ).trim().toLowerCase();
  if (
    configured !== "auto" && configured !== "local" &&
    configured !== "external" && configured !== "off"
  ) {
    throw new Error("YOURCHAR_IM_RUNTIME_MODE must be auto, local, external, or off");
  }
  if (configured === "local" || configured === "external" || configured === "off") {
    return configured;
  }
  if (
    environment.YOURCHAR_IM_GATEWAY_URL?.trim() ||
    environment.RP_AGENT_IM_GATEWAY_URL?.trim()
  ) {
    return "external";
  }
  return isTestMode ? "off" : "local";
}

function requiredStateDirectory(value: string | undefined): string {
  if (!value) {
    throw new Error("Bundled IM Channel Runtime requires a persistent YourChar state directory");
  }
  return value;
}
