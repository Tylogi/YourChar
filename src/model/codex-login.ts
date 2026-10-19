import { randomUUID } from "node:crypto";
import type { AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { ModelCredentialConflictError, ModelCredentialValidationError } from "./credential-store.js";

export type CodexLoginMethod = "browser" | "device_code";
export type CodexLoginState = {
  id: string;
  profileId: string;
  method: CodexLoginMethod;
  status: "pending" | "authorizing" | "complete" | "failed" | "cancelled";
  expiresAt: string;
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  manualCode?: boolean;
  error?: string;
};

type Login = {
  state: CodexLoginState;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  submit?: (code: string) => void;
};

/** Bridges Pi's interactive OAuth flow to a bounded, host-controlled web flow. */
export class CodexLoginManager {
  private readonly logins = new Map<string, Login>();

  constructor(private readonly oauth: OAuthAuth = openaiCodexProvider().auth.oauth!) {}

  start(
    profileId: string,
    method: CodexLoginMethod,
    complete: (credential: OAuthCredential) => void,
  ): CodexLoginState {
    if (method !== "browser" && method !== "device_code") {
      throw new ModelCredentialValidationError("login method must be browser or device_code");
    }
    if (method === "browser" && [...this.logins.values()].some((entry) =>
      entry.state.profileId !== profileId && entry.state.method === "browser" && isPending(entry.state)
    )) throw new ModelCredentialConflictError("请先完成或取消另一项浏览器登录。");
    this.cancelProfile(profileId);
    const controller = new AbortController();
    const duration = 15 * 60_000;
    const login: Login = {
      state: { id: randomUUID(), profileId, method, status: "pending", expiresAt: new Date(Date.now() + duration).toISOString() },
      controller,
      timer: setTimeout(() => {
        if (!isPending(login.state)) return;
        login.state.status = "failed";
        login.state.error = "登录已超时，请重新开始。";
        clearChallenge(login);
        controller.abort();
      }, duration),
    };
    login.timer.unref();
    this.logins.set(profileId, login);
    void this.oauth.login({
      signal: controller.signal,
      prompt: (prompt) => this.prompt(login, prompt),
      notify: (event) => {
        if (controller.signal.aborted || !isPending(login.state)) return;
        if (event.type === "auth_url") {
          login.state.authUrl = officialAuthUrl(event.url);
          login.state.status = "authorizing";
        } else if (event.type === "device_code") {
          login.state.verificationUri = officialAuthUrl(event.verificationUri);
          login.state.userCode = event.userCode;
          login.state.status = "authorizing";
        }
      },
    }).then((credential) => {
      if (controller.signal.aborted || this.logins.get(profileId) !== login) return;
      complete(credential);
      login.state.status = "complete";
    }).catch((error: unknown) => {
      if (controller.signal.aborted || this.logins.get(profileId) !== login) return;
      login.state.status = "failed";
      // Pi errors can contain raw token responses. Never expose their bodies.
      const message = error instanceof Error ? error.message : "";
      login.state.error = error instanceof ModelCredentialConflictError
        ? "模型配置或登录状态已变更，请重新登录。"
        : error && typeof error === "object" && "code" in error && error.code === "CONTROL_PLANE_BUSY"
          ? "当前有对话或无痕会话正在运行，请结束后重新登录。"
          : /device.*(?:not enabled|disabled)/i.test(message)
            ? "账号尚未开启设备码登录，请改用浏览器登录或在 ChatGPT 安全设置中开启。"
            : "Codex 登录未完成，请检查网络与账号权限后重试。";
    }).finally(() => {
      clearTimeout(login.timer);
      clearChallenge(login);
    });
    return this.snapshot(login);
  }

  status(profileId: string, id: string): CodexLoginState {
    return this.snapshot(this.require(profileId, id));
  }

  submit(profileId: string, id: string, value: string): CodexLoginState {
    const login = this.require(profileId, id);
    if (!isPending(login.state) || !login.submit || !login.state.authUrl) {
      throw new ModelCredentialConflictError("登录当前不接受回调地址。");
    }
    // Requiring the full callback URL also preserves OAuth state verification
    // in Pi's manual fallback, which otherwise accepts a bare code.
    let url: URL;
    try { url = new URL(typeof value === "string" && value.length <= 16_384 ? value.trim() : ""); }
    catch { throw new ModelCredentialValidationError("请粘贴完整的登录回调地址。"); }
    const expected = new URL(login.state.authUrl).searchParams.get("state");
    if (url.origin !== "http://localhost:1455" || url.pathname !== "/auth/callback" ||
        url.username || url.password || !url.searchParams.get("code") || !expected ||
        url.searchParams.get("state") !== expected) {
      throw new ModelCredentialValidationError("回调地址与当前登录不匹配，请重新授权。");
    }
    login.submit(url.toString());
    login.submit = undefined;
    delete login.state.manualCode;
    return this.snapshot(login);
  }

  cancel(profileId: string, id: string): CodexLoginState {
    const login = this.require(profileId, id);
    this.cancelProfile(profileId);
    return this.snapshot(login);
  }

  cancelProfile(profileId: string): void {
    const login = this.logins.get(profileId);
    if (!login || !isPending(login.state)) return;
    login.state.status = "cancelled";
    clearTimeout(login.timer);
    clearChallenge(login);
    login.controller.abort();
  }

  remove(profileId: string): void {
    this.cancelProfile(profileId);
    this.logins.delete(profileId);
  }

  dispose(): void {
    for (const id of this.logins.keys()) this.cancelProfile(id);
    this.logins.clear();
  }

  private prompt(login: Login, prompt: AuthPrompt): Promise<string> {
    if (prompt.type === "select") return Promise.resolve(login.state.method);
    if (prompt.type !== "manual_code") return Promise.reject(new Error("unsupported login prompt"));
    return new Promise((resolve, reject) => {
      const signals = [login.controller.signal, prompt.signal].filter((signal): signal is AbortSignal => Boolean(signal));
      const cleanup = () => {
        signals.forEach((signal) => signal.removeEventListener("abort", abort));
        login.submit = undefined;
        delete login.state.manualCode;
      };
      const abort = () => { cleanup(); reject(new Error("Login cancelled")); };
      if (signals.some((signal) => signal.aborted)) return abort();
      signals.forEach((signal) => signal.addEventListener("abort", abort, { once: true }));
      login.submit = (code) => { cleanup(); resolve(code); };
      login.state.manualCode = true;
    });
  }

  private require(profileId: string, id: string): Login {
    const login = this.logins.get(profileId);
    if (!login || login.state.id !== id) throw new ModelCredentialConflictError("登录已失效，请重新开始。");
    return login;
  }

  private snapshot(login: Login): CodexLoginState { return { ...login.state }; }
}

function isPending(state: CodexLoginState): boolean {
  return state.status === "pending" || state.status === "authorizing";
}

function clearChallenge(login: Login): void {
  delete login.state.authUrl;
  delete login.state.userCode;
  delete login.state.verificationUri;
  delete login.state.manualCode;
}

function officialAuthUrl(value: string): string {
  const url = new URL(value);
  if (url.origin !== "https://auth.openai.com" || url.username || url.password) throw new Error("unexpected OAuth URL");
  return url.toString();
}
