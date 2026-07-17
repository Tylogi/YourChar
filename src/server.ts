import { createHttpServer, disposeHttpServerOwnedResources } from "./http/router.js";

const port = Number(process.env.PORT ?? 8765);
const host = process.env.HOST ?? "127.0.0.1";
const testMode = process.env.RP_AGENT_TEST_MODE === "1";
const forceShutdownAfterMs = 10_000;
const hardExitAfterMs = 1_000;

if (testMode && host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
  throw new Error("RP_AGENT_TEST_MODE may only bind to a loopback host");
}

const server = createHttpServer({ testMode });
server.listen(port, host, () => {
  const address = server.address();
  const listeningPort = address && typeof address === "object" ? address.port : port;
  console.log(`RP Agent listening on http://${host}:${listeningPort}`);
});

let shutdownStarted = false;

function shutdown(signal: "SIGTERM" | "SIGINT"): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`RP Agent received ${signal}; shutting down.`);

  let hardExitTimer: NodeJS.Timeout | undefined;
  const forceTimer = setTimeout(() => {
    console.error("RP Agent graceful shutdown timed out; closing active HTTP connections.");
    server.closeAllConnections();
    hardExitTimer = setTimeout(() => {
      console.error("RP Agent forced shutdown did not complete.");
      disposeHttpServerOwnedResources(server);
      process.exit(1);
    }, hardExitAfterMs);
  }, forceShutdownAfterMs);

  server.close((error) => {
    clearTimeout(forceTimer);
    if (hardExitTimer) clearTimeout(hardExitTimer);
    const notRunning = (error as NodeJS.ErrnoException | undefined)?.code === "ERR_SERVER_NOT_RUNNING";
    if (error && !notRunning) {
      console.error("RP Agent shutdown failed while releasing service resources.");
      process.exitCode = 1;
      return;
    }
    console.log("RP Agent stopped.");
    process.exitCode = 0;
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
