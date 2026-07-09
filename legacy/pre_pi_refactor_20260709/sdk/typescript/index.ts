export type Mode = "sms" | "rp";
export type ConfirmationDecision = "approved" | "rejected";

export interface SendMessageOptions {
  now?: string;
  timezone?: string;
  characterId?: string;
}

export interface KernelClientOptions {
  baseUrl?: string;
}

export interface SubscribeEventsOptions {
  follow?: boolean;
  includePending?: boolean;
  clientId?: string;
  leaseSeconds?: number;
  intervalSeconds?: number;
}

export interface OpenAICompatibleConfigPatch {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  headers?: Record<string, string>;
  temperature?: number | null;
  maxTokens?: number | null;
  contextWindowTokens?: number | null;
}

export class KernelClient {
  private baseUrl: string;

  constructor(options: KernelClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:8765").replace(/\/$/, "");
  }

  async sendMessage(sessionId: string, mode: Mode, text: string, options: SendMessageOptions = {}) {
    return this.request("POST", `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      mode,
      text,
      timezone: options.timezone ?? "Asia/Shanghai",
      now: options.now,
      characterId: options.characterId,
    });
  }

  subscribeEvents(handler: (event: unknown) => void, options: SubscribeEventsOptions = {}): EventSource {
    const query = new URLSearchParams({
      follow: String(options.follow ?? true),
      includePending: String(options.includePending ?? true),
      clientId: options.clientId ?? "typescript-sdk",
      leaseSeconds: String(options.leaseSeconds ?? 60),
      intervalSeconds: String(options.intervalSeconds ?? 5),
    });
    const source = new EventSource(`${this.baseUrl}/api/events/stream?${query.toString()}`);
    source.onmessage = (message) => handler(JSON.parse(message.data));
    return source;
  }

  async listSchedule(range: { start?: string; end?: string } = {}) {
    const query = new URLSearchParams();
    if (range.start) query.set("start", range.start);
    if (range.end) query.set("end", range.end);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.request("GET", `/api/calendar/events${suffix}`);
  }

  async confirmAction(actionId: string, decision: ConfirmationDecision) {
    return this.request("POST", `/api/confirmations/${encodeURIComponent(actionId)}`, { decision });
  }

  async ackEvent(deliveryId: string, options: { clientId?: string } = {}) {
    return this.request("POST", `/api/events/${encodeURIComponent(deliveryId)}/delivery`, {
      status: "acked",
      clientId: options.clientId ?? "typescript-sdk",
    });
  }

  async getFeatures() {
    return this.request("GET", "/api/features");
  }

  async setFeature(name: string, enabled: boolean) {
    return this.request("PATCH", "/api/features", { flags: { [name]: enabled } });
  }

  async getOpenAICompatibleConfig() {
    return this.request("GET", "/api/model-config/openai-compatible");
  }

  async setOpenAICompatibleConfig(config: OpenAICompatibleConfigPatch) {
    return this.request("PATCH", "/api/model-config/openai-compatible", config);
  }

  async listOpenAICompatibleModels() {
    return this.request("GET", "/api/model-config/openai-compatible/models");
  }

  async importCharacterCard(fileName: string, options: { content?: string; contentBase64?: string }) {
    return this.request("POST", "/api/characters/import-card", { fileName, ...options });
  }

  async runEval(cases: unknown[], options: Record<string, unknown> = {}) {
    return this.request("POST", "/api/eval/run", { cases, ...options });
  }

  private async request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`RP Agent Kernel request failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }
}
