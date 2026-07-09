import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { CompanionKernel } from "../domain/index.js";
import type { MessageRequest } from "../domain/index.js";

export type HttpServerOptions = {
  kernel?: CompanionKernel;
};

export function createHttpServer(options: HttpServerOptions = {}) {
  const kernel = options.kernel ?? new CompanionKernel();
  return createServer(async (request, response) => {
    try {
      await route({ kernel, request, response });
    } catch (error) {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function route(input: {
  kernel: CompanionKernel;
  request: IncomingMessage;
  response: ServerResponse;
}) {
  const method = input.request.method ?? "GET";
  const url = new URL(input.request.url ?? "/", "http://127.0.0.1");

  if (method === "GET" && url.pathname === "/health") {
    sendJson(input.response, 200, { status: "ok" });
    return;
  }

  if (method === "GET" && url.pathname === "/") {
    sendJson(input.response, 200, {
      name: "RP Agent",
      status: "ok",
      messageEndpoint: "POST /api/sessions/{id}/messages",
    });
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
  if (messageMatch && method === "POST") {
    const body = (await readJson(input.request)) as MessageRequest;
    const result = await input.kernel.sendMessage(decodeURIComponent(messageMatch[1]), body);
    sendJson(input.response, 200, result);
    return;
  }

  if (messageMatch && method === "GET") {
    const session = input.kernel.getSession(decodeURIComponent(messageMatch[1]));
    sendJson(input.response, 200, session.messages);
    return;
  }

  sendJson(input.response, 404, { error: "Not Found" });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}
