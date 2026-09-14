import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const HEADLESS_API_ROOT = "/api/headless/v1";
export const HEADLESS_API_VERSION = "1";

const minimumTokenLength = 32;
const maximumTokenLength = 512;
const authorizedRequests = new WeakSet<IncomingMessage>();

export type HeadlessApiErrorCode =
  | "HEADLESS_API_DISABLED"
  | "HEADLESS_API_REMOTE_PEER_REJECTED"
  | "HEADLESS_API_AUTH_REQUIRED";

export class HeadlessApiRequestError extends Error {
  constructor(
    readonly code: HeadlessApiErrorCode,
    readonly status: 401 | 403 | 503,
    message: string,
  ) {
    super(message);
    this.name = "HeadlessApiRequestError";
  }
}

/** Resolve the process-owned API token without ever returning it to an API response. */
export function resolveHeadlessApiToken(
  configured: string | false | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (configured === false) return undefined;
  const raw = configured ??
    environment.YOURCHAR_HEADLESS_API_TOKEN ??
    environment.RP_AGENT_HEADLESS_API_TOKEN;
  if (raw === undefined || raw.trim() === "") {
    if (configured !== undefined) {
      throw new Error("headlessApiToken must not be empty");
    }
    return undefined;
  }
  const token = raw.trim();
  if (
    token.length < minimumTokenLength || token.length > maximumTokenLength ||
    !/^[A-Za-z0-9._~+/-]+={0,2}$/u.test(token)
  ) {
    throw new Error(
      `YOURCHAR_HEADLESS_API_TOKEN must be ${minimumTokenLength}-${maximumTokenLength} visible token characters`,
    );
  }
  return token;
}

/** Map only the explicitly versioned headless namespace onto the existing v1 contract. */
export function mappedHeadlessApiPath(pathname: string): string | undefined {
  if (pathname === HEADLESS_API_ROOT) return "/api";
  if (!pathname.startsWith(`${HEADLESS_API_ROOT}/`)) return undefined;
  return `/api/v1/${pathname.slice(HEADLESS_API_ROOT.length + 1)}`;
}

export function authenticateHeadlessApiRequest(
  request: IncomingMessage,
  token: string | undefined,
): void {
  if (!token) {
    throw new HeadlessApiRequestError(
      "HEADLESS_API_DISABLED",
      503,
      "the headless API is disabled",
    );
  }
  if (!isLoopbackAddress(normalizedAddress(request.socket.remoteAddress))) {
    throw new HeadlessApiRequestError(
      "HEADLESS_API_REMOTE_PEER_REJECTED",
      403,
      "the headless API accepts loopback peers only",
    );
  }
  const authorization = singleAuthorizationHeader(request);
  const expected = `Bearer ${token}`;
  if (!authorization || !secretsEqual(authorization, expected)) {
    throw new HeadlessApiRequestError(
      "HEADLESS_API_AUTH_REQUIRED",
      401,
      "a valid Bearer token is required",
    );
  }
  authorizedRequests.add(request);
}

export function isAuthenticatedHeadlessApiRequest(request: IncomingMessage): boolean {
  return authorizedRequests.has(request);
}

function singleAuthorizationHeader(request: IncomingMessage): string | undefined {
  const values = request.headersDistinct.authorization;
  if (!values || values.length !== 1) return undefined;
  const value = values[0];
  if (value !== value.trim()) return undefined;
  if (value.includes(",") || /[\u0000-\u001f\u007f]/u.test(value)) return undefined;
  return value;
}

function normalizedAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(value);
  return mappedIpv4?.[1] ?? value.toLowerCase();
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (value === "::1") return true;
  return value !== undefined && /^127(?:\.\d{1,3}){3}$/u.test(value) &&
    value.split(".").every((entry) => Number(entry) <= 255);
}

function secretsEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
