import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import type { Clock } from "../app/clock.js";
import { SystemClock } from "../app/clock.js";
import type {
  TavilyApiConfig,
  TavilyApiConfigPatch,
  TavilySearchInput,
  TavilySearchResponse,
  TavilySearchResult,
} from "./types.js";

type StoredTavilyConfig = { apiKey?: string; proxyUrl?: string; updatedAt?: string };
type TavilyFetch = (
  input: string,
  init?: RequestInit & { dispatcher?: ProxyAgent },
) => Promise<Response>;

export type TavilyServiceOptions = {
  stateDir?: string;
  clock?: Clock;
  baseUrl?: string;
  fetch?: TavilyFetch;
};

export class TavilyService {
  private readonly configPath?: string;
  private readonly clock: Clock;
  private readonly baseUrl: string;
  private readonly fetchImpl: TavilyFetch;
  private proxyAgent?: ProxyAgent;
  private proxyAgentUrl?: string;
  private config: StoredTavilyConfig;

  constructor(options: TavilyServiceOptions = {}) {
    this.configPath = options.stateDir ? join(options.stateDir, "tavily.json") : undefined;
    this.clock = options.clock ?? new SystemClock();
    this.baseUrl = (options.baseUrl ?? "https://api.tavily.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? (undiciFetch as unknown as TavilyFetch);
    this.config = this.load();
    if (this.configPath && existsSync(this.configPath)) chmodSync(this.configPath, 0o600);
  }

  getConfig(): TavilyApiConfig {
    return {
      apiKeySet: Boolean(this.config.apiKey),
      apiKeyMasked: this.config.apiKey ? maskSecret(this.config.apiKey) : "",
      proxyUrlSet: Boolean(this.config.proxyUrl),
      proxyUrlMasked: this.config.proxyUrl ? maskProxyUrl(this.config.proxyUrl) : "",
      updatedAt: this.config.updatedAt,
    };
  }

  getRawConfig(): StoredTavilyConfig {
    return { ...this.config };
  }

  patchConfig(patch: TavilyApiConfigPatch): TavilyApiConfig {
    if (patch.clearApiKey !== undefined && typeof patch.clearApiKey !== "boolean") {
      throw new TavilyConfigurationError("clearApiKey must be a boolean");
    }
    if (patch.clearProxyUrl !== undefined && typeof patch.clearProxyUrl !== "boolean") {
      throw new TavilyConfigurationError("clearProxyUrl must be a boolean");
    }
    if (patch.apiKey !== undefined) {
      if (typeof patch.apiKey !== "string") throw new TavilyConfigurationError("apiKey must be a string");
      const apiKey = patch.apiKey.trim();
      if (!apiKey) throw new TavilyConfigurationError("Tavily API Key must not be empty");
      this.config.apiKey = apiKey;
    }
    if (patch.clearApiKey) delete this.config.apiKey;
    if (patch.proxyUrl !== undefined) {
      if (typeof patch.proxyUrl !== "string") throw new TavilyConfigurationError("proxyUrl must be a string");
      this.config.proxyUrl = normalizeProxyUrl(patch.proxyUrl);
    }
    if (patch.clearProxyUrl) delete this.config.proxyUrl;
    this.resetProxyAgent();
    this.config.updatedAt = this.clock.now().toISOString();
    this.persist();
    return this.getConfig();
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  contextStatus(moduleEnabled: boolean): string {
    if (!moduleEnabled) {
      return "Capability status: Tavily Search MCP is disabled. Do not claim to search the web.";
    }
    return this.isConfigured()
      ? "Capability status: Tavily Search MCP is enabled and configured for live web search."
      : "Capability status: Tavily Search MCP is enabled but has no API Key, so live web search is unavailable.";
  }

  async testConnection(): Promise<{ ok: true; status: number; latencyMs: number }> {
    const startedAt = performance.now();
    const response = await this.request("/usage", { method: "GET" }, 10_000);
    await response.text();
    return {
      ok: true,
      status: response.status,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }

  async search(input: TavilySearchInput, signal?: AbortSignal): Promise<TavilySearchResponse> {
    const query = input.query.trim();
    if (!query) throw new TavilyConfigurationError("Tavily search query must not be empty");
    const maxResults = Math.max(1, Math.min(10, Math.floor(input.maxResults ?? 5)));
    const response = await this.request("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        search_depth: input.searchDepth ?? "basic",
        topic: input.topic ?? "general",
        max_results: maxResults,
        ...(input.timeRange ? { time_range: input.timeRange } : {}),
        ...(input.includeDomains?.length ? { include_domains: input.includeDomains } : {}),
        ...(input.excludeDomains?.length ? { exclude_domains: input.excludeDomains } : {}),
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        include_favicon: false,
        include_usage: true,
      }),
      signal,
    }, 30_000);
    const body = await parseJson(response);
    if (!isRecord(body) || !Array.isArray(body.results)) {
      throw new TavilyApiError(response.status, "Tavily returned an invalid search response");
    }
    return {
      query: typeof body.query === "string" ? body.query : query,
      results: body.results.slice(0, maxResults).map(normalizeResult).filter((item): item is TavilySearchResult => Boolean(item)),
      responseTime: numeric(body.response_time),
      requestId: typeof body.request_id === "string" ? body.request_id : undefined,
      credits: isRecord(body.usage) ? numeric(body.usage.credits) : undefined,
    };
  }

  dispose(): void {
    this.resetProxyAgent();
  }

  private async request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const apiKey = this.config.apiKey;
    if (!apiKey) throw new TavilyConfigurationError("Tavily API Key is not configured");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      const dispatcher = this.getProxyAgent();
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...headersFrom(init.headers),
          authorization: `Bearer ${apiKey}`,
        },
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (error) {
      if (error instanceof TavilyConfigurationError) throw error;
      throw new TavilyApiError(0, formatNetworkError(error, apiKey, this.config.proxyUrl));
    }
    if (!response.ok) {
      const details = (await response.text()).replaceAll(apiKey, "[REDACTED]").slice(0, 500);
      throw new TavilyApiError(
        response.status,
        response.status === 401
          ? "Tavily API Key is invalid or inactive"
          : `Tavily returned ${response.status}${details ? `: ${details}` : ""}`,
      );
    }
    return response;
  }

  private load(): StoredTavilyConfig {
    if (!this.configPath || !existsSync(this.configPath)) return {};
    try {
      const value = JSON.parse(readFileSync(this.configPath, "utf8")) as unknown;
      if (!isRecord(value)) return {};
      return {
        apiKey: typeof value.apiKey === "string" && value.apiKey.trim() ? value.apiKey.trim() : undefined,
        proxyUrl: loadProxyUrl(value.proxyUrl),
        updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
      };
    } catch {
      return {};
    }
  }

  private persist(): void {
    if (!this.configPath) return;
    mkdirSync(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.configPath}.${process.pid}.tmp`;
    try {
      writeFileSync(temporaryPath, JSON.stringify(this.config, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.configPath);
      chmodSync(this.configPath, 0o600);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }

  private getProxyAgent(): ProxyAgent | undefined {
    const proxyUrl = this.config.proxyUrl;
    if (!proxyUrl) return undefined;
    if (!this.proxyAgent || this.proxyAgentUrl !== proxyUrl) {
      this.resetProxyAgent();
      this.proxyAgent = new ProxyAgent(proxyUrl);
      this.proxyAgentUrl = proxyUrl;
    }
    return this.proxyAgent;
  }

  private resetProxyAgent(): void {
    if (this.proxyAgent) void this.proxyAgent.destroy().catch(() => undefined);
    this.proxyAgent = undefined;
    this.proxyAgentUrl = undefined;
  }
}

export class TavilyConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TavilyConfigurationError";
  }
}

export class TavilyApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "TavilyApiError";
  }
}

function normalizeResult(value: unknown): TavilySearchResult | undefined {
  if (!isRecord(value) || typeof value.url !== "string") return undefined;
  return {
    title: typeof value.title === "string" ? value.title : value.url,
    url: value.url,
    content: typeof value.content === "string" ? value.content.slice(0, 2_000) : "",
    score: numeric(value.score),
  };
}

function numeric(value: unknown): number | undefined {
  const result = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(result) ? result : undefined;
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new TavilyApiError(response.status, "Tavily returned non-JSON data");
  }
}

function headersFrom(headers: HeadersInit | undefined): Record<string, string> {
  return Object.fromEntries(new Headers(headers).entries());
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new TavilyConfigurationError("Tavily proxy URL must not be empty");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TavilyConfigurationError("Tavily proxy URL must be a valid http:// or https:// URL");
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new TavilyConfigurationError("Tavily proxy URL must use http:// or https://");
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new TavilyConfigurationError("Tavily proxy URL must not contain a path, query, or fragment");
  }
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

function loadProxyUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return normalizeProxyUrl(value);
  } catch {
    return undefined;
  }
}

function maskProxyUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    url.username = "***";
    url.password = "***";
  }
  return url.toString().replace(/\/$/, "");
}

function formatNetworkError(error: unknown, apiKey: string, proxyUrl?: string): string {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (current && !chain.includes(current)) {
    chain.push(current);
    current = current instanceof Error && "cause" in current ? current.cause : undefined;
  }
  const detail = chain.at(-1);
  const code = isRecord(detail) && typeof detail.code === "string" ? detail.code : undefined;
  const rawMessage = detail instanceof Error ? detail.message : error instanceof Error ? error.message : String(error);
  const secrets = [apiKey, proxyUrl, proxyUrl ? new URL(proxyUrl).username : undefined, proxyUrl ? new URL(proxyUrl).password : undefined]
    .filter((value): value is string => Boolean(value));
  const message = secrets.reduce((result, secret) => result.replaceAll(secret, "[REDACTED]"), rawMessage).slice(0, 300);
  return `Tavily network request failed${code ? ` (${code})` : ""}: ${message}. Check outbound HTTPS and Tavily proxy settings.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
