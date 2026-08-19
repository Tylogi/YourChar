import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const controlCookieName = `rp_agent_local_control_${randomBytes(8).toString("hex")}`;
const controlToken = randomBytes(32).toString("base64url");

export type LocalControlPlaneErrorCode =
  | "LOCAL_CONTROL_METHOD_REJECTED"
  | "LOCAL_CONTROL_HOST_REJECTED"
  | "LOCAL_CONTROL_ORIGIN_REJECTED"
  | "LOCAL_CONTROL_CONTENT_TYPE_REJECTED"
  | "LOCAL_CONTROL_FETCH_CONTEXT_REJECTED"
  | "LOCAL_CONTROL_TOKEN_REJECTED";

export class LocalControlPlaneRequestError extends Error {
  constructor(
    readonly code: LocalControlPlaneErrorCode,
    readonly status: 403 | 405 | 415,
    message: string,
  ) {
    super(message);
    this.name = "LocalControlPlaneRequestError";
  }
}

/**
 * Give the same-origin browser UI a process-lifetime control-plane capability.
 * The HttpOnly cookie keeps the capability out of page source and JavaScript.
 */
export function attachLocalControlPlaneCookie(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const secure = isAuthenticatedLazycatIngressEnvelope(request) ? "; Secure" : "";
  response.setHeader(
    "set-cookie",
    `${controlCookieName}=${controlToken}; HttpOnly; SameSite=Strict; Path=/${secure}`,
  );
}

/**
 * Protect a sensitive local JSON mutation such as installing or activating a
 * downloaded Skill. Existing API routes remain unchanged until they opt in.
 */
export function assertLocalControlPlaneMutation(request: IncomingMessage): void {
  if (request.method !== "POST" && request.method !== "PATCH" && request.method !== "DELETE") {
    throw new LocalControlPlaneRequestError(
      "LOCAL_CONTROL_METHOD_REJECTED",
      405,
      "only POST, PATCH, and DELETE control-plane mutations are allowed",
    );
  }
  const expectedOrigin = requestOrigin(request);
  const suppliedOrigin = singleHeader(request, "origin");
  const contentType = singleHeader(request, "content-type");
  if (!isJsonContentType(contentType)) {
    throw new LocalControlPlaneRequestError(
      "LOCAL_CONTROL_CONTENT_TYPE_REJECTED",
      415,
      "application/json with an optional UTF-8 charset is required",
    );
  }

  const fetchSite = singleHeader(request, "sec-fetch-site");
  const fetchMode = singleHeader(request, "sec-fetch-mode");
  const fetchDest = singleHeader(request, "sec-fetch-dest");
  if (
    (fetchSite !== undefined && fetchSite.toLowerCase() !== "same-origin") ||
    fetchMode?.toLowerCase() === "no-cors"
  ) {
    throw rejected(
      "LOCAL_CONTROL_FETCH_CONTEXT_REJECTED",
      "cross-site and no-cors browser requests are not allowed",
    );
  }

  const suppliedTokens = cookieValues(request, controlCookieName);
  if (suppliedTokens.length !== 1 || !tokensEqual(suppliedTokens[0], controlToken)) {
    throw rejected(
      "LOCAL_CONTROL_TOKEN_REJECTED",
      "the local control-plane capability is missing or invalid",
    );
  }

  if (
    suppliedOrigin !== expectedOrigin &&
    !isAuthenticatedLazycatUiRequest(request, suppliedOrigin, fetchSite, fetchMode, fetchDest)
  ) {
    throw rejected(
      "LOCAL_CONTROL_ORIGIN_REJECTED",
      "a same-origin browser request is required",
    );
  }
}

/**
 * Lazycat's authenticated ingress terminates HTTPS and rewrites Host to the
 * private loopback listener. Trust that narrowly identified ingress envelope,
 * not arbitrary Forwarded/X-Forwarded-Host values or an origin reported by
 * page JavaScript. The ingress must keep the app behind its login boundary and
 * overwrite these identity headers before forwarding the request.
 */
function isAuthenticatedLazycatUiRequest(
  request: IncomingMessage,
  suppliedOrigin: string | undefined,
  fetchSite: string | undefined,
  fetchMode: string | undefined,
  fetchDest: string | undefined,
): boolean {
  return Boolean(
    isAuthenticatedLazycatIngressEnvelope(request) &&
    suppliedOrigin !== undefined &&
    canonicalHttpsOrigin(suppliedOrigin) === suppliedOrigin &&
    fetchSite?.toLowerCase() === "same-origin" &&
    (fetchMode?.toLowerCase() === "cors" || fetchMode?.toLowerCase() === "same-origin") &&
    fetchDest?.toLowerCase() === "empty"
  );
}

function isAuthenticatedLazycatIngressEnvelope(request: IncomingMessage): boolean {
  return isLoopbackAddress(normalizedLocalAddress(request.socket.remoteAddress)) &&
    singleHeader(request, "x-forwarded-by") === "lzc-ingress" &&
    singleHeader(request, "x-forwarded-proto") === "https" &&
    isSafeLazycatUserId(singleHeader(request, "x-hc-user-id"));
}

function requestOrigin(request: IncomingMessage): string {
  const localAddress = normalizedLocalAddress(request.socket.localAddress);
  const localPort = request.socket.localPort;
  const host = singleHeader(request, "host");
  const authority = parseLoopbackAuthority(host);
  if (
    localAddress === undefined ||
    localPort === undefined ||
    authority === undefined ||
    authority.address !== localAddress ||
    authority.port !== localPort
  ) {
    throw rejected(
      "LOCAL_CONTROL_HOST_REJECTED",
      "Host must exactly match the literal loopback listener address",
    );
  }
  return `http://${authority.serialized}`;
}

function parseLoopbackAuthority(
  value: string | undefined,
): { address: string; port: number; serialized: string } | undefined {
  if (!value) return undefined;
  const ipv6 = /^\[::1\](?::([1-9]\d{0,4}))?$/u.exec(value);
  if (ipv6) {
    const port = parsedPort(ipv6[1]);
    if (port === undefined) return undefined;
    return {
      address: "::1",
      port,
      serialized: port === 80 ? "[::1]" : `[::1]:${port}`,
    };
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::([1-9]\d{0,4}))?$/u.exec(value);
  if (!ipv4) return undefined;
  const octets = ipv4.slice(1, 5);
  if (octets.some((entry) => Number(entry) > 255 || String(Number(entry)) !== entry)) {
    return undefined;
  }
  if (octets[0] !== "127") return undefined;
  const port = parsedPort(ipv4[5]);
  if (port === undefined) return undefined;
  const address = octets.join(".");
  return {
    address,
    port,
    serialized: port === 80 ? address : `${address}:${port}`,
  };
}

function parsedPort(value: string | undefined): number | undefined {
  if (value === undefined) return 80;
  const port = Number(value);
  return port >= 1 && port <= 65_535 ? port : undefined;
}

function normalizedLocalAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(value);
  return mappedIpv4?.[1] ?? value.toLowerCase();
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (value === "::1") return true;
  return value !== undefined && /^127(?:\.\d{1,3}){3}$/u.test(value) &&
    value.split(".").every((entry) => Number(entry) <= 255);
}

function canonicalHttpsOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash
  ) return undefined;
  return parsed.origin;
}

function isSafeLazycatUserId(value: string | undefined): boolean {
  return value !== undefined && value.length >= 1 && value.length <= 256 &&
    !/[\u0000-\u0020\u007f,]/u.test(value);
}

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const segments = value.split(";").map((entry) => entry.trim().toLowerCase());
  if (segments[0] !== "application/json") return false;
  if (segments.length === 1) return true;
  return segments.length === 2 && /^charset=(?:utf-8|"utf-8")$/u.test(segments[1]);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value?.trim();
}

function cookieValues(request: IncomingMessage, name: string): string[] {
  const header = singleHeader(request, "cookie");
  if (!header) return [];
  const values: string[] = [];
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    values.push(item.slice(separator + 1).trim());
  }
  return values;
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function rejected(code: LocalControlPlaneErrorCode, message: string): LocalControlPlaneRequestError {
  return new LocalControlPlaneRequestError(code, 403, message);
}
