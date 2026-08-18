import { createHttpServer, disposeHttpServerOwnedResources } from "./http/router.js";

const port = Number(process.env.PORT ?? 8765);
const host = process.env.HOST ?? "127.0.0.1";
const testMode = process.env.RP_AGENT_TEST_MODE === "1";
const forceShutdownAfterMs = 10_000;
const hardExitAfterMs = 1_000;

if (!isLoopbackHost(host)) {
  throw new Error("YourChar has no HTTP authentication and may only bind to a loopback host");
}

const server = createHttpServer({ testMode });
server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  console.log(`YourChar listening on http://${host}:${listeningPort}`);
});

let shutdownStarted = false;

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
      process.exit(1);
    }, hardExitAfterMs);
  }, forceShutdownAfterMs);

  server.close((error) => {
    clearTimeout(forceTimer);
    if (hardExitTimer) clearTimeout(hardExitTimer);
    const notRunning = (error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING";
    if (error && !notRunning) {
      console.error("YourChar shutdown failed while releasing service resources.");
      process.exitCode = 1;
      return;
    }
    console.log("YourChar stopped.");
    process.exitCode = 0;
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
