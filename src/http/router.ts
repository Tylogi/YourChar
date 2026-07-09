import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { CompanionKernel } from "../domain/index.js";
import type { MessageRequest } from "../domain/index.js";
import { renderAppHtml } from "./ui.js";

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
  const pathname = normalizePath(url.pathname);

  if (method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
    sendJson(input.response, 200, { status: "ok" });
    return;
  }

  if (
    method === "GET" &&
    (pathname === "/" || pathname === "/ui" || pathname === "/ui/index.html" || pathname === "/index.html")
  ) {
    sendHtml(input.response, 200, renderAppHtml());
    return;
  }

  if (method === "GET" && pathname === "/api") {
    sendJson(input.response, 200, {
      name: "RP Agent",
      status: "ok",
      ui: "/ui",
      messageEndpoint: "POST /api/sessions/{id}/messages",
      debugContextLogs: "GET /api/debug/context-logs",
    });
    return;
  }

  const messageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
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

  if (method === "GET" && pathname === "/api/debug/context-logs") {
    const limit = Number(url.searchParams.get("limit") ?? "20");
    sendJson(input.response, 200, { logs: input.kernel.recentContextLogs(limit) });
    return;
  }

  if (method === "GET" && !pathname.startsWith("/api/")) {
    sendHtml(input.response, 200, renderAppHtml());
    return;
  }

  sendJson(input.response, 404, { error: "Not Found" });
}

function normalizePath(pathname: string): string {
  let path = pathname;
  if (path === "/ui/api" || path.startsWith("/ui/api/")) {
    path = path.slice("/ui".length);
  } else if (path === "/ui/health") {
    path = "/health";
  }
  if (path.length > 1 && path.endsWith("/")) {
    path = path.slice(0, -1);
  }
  return path || "/";
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

function sendHtml(response: ServerResponse, statusCode: number, html: string): void {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}
