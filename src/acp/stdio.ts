#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { createYourCharAcpAgent, yourCharAcpEnvironment } from "./bridge.js";

try {
  const configured = yourCharAcpEnvironment(process.env);
  const app = createYourCharAcpAgent({
    client: configured.client,
    ...configured.bridge,
    diagnostic: (message, error) => {
      console.error(message, error instanceof Error ? error.message : error ?? "");
    },
  });
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  await connection.closed;
} catch (error) {
  console.error(
    "YourChar ACP bridge failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
}
