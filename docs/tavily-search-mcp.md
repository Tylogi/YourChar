# Tavily Search MCP

## Scope

YourChar exposes live web search through a local built-in MCP module. The module
wraps Tavily's official REST API instead of giving the model a remote MCP URL
containing credentials. The Agent only receives the `tavily_search` tool and
never receives the Tavily API Key.

The implementation follows Tavily's official
[Search endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/search)
and [authentication](https://docs.tavily.com/documentation/api-reference/authentication)
contracts. Connection diagnostics use the official
[usage endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/usage).

## Enablement

Search requires two independent conditions:

1. A Tavily API Key is saved under **Settings > Tavily Web Search**.
2. `mcp:tavily-search` is enabled under **Management > MCP**.

An optional Tavily-only HTTPS proxy can be saved in the same Settings section.
It accepts `http://` or `https://` proxy URLs, including URLs with credentials.
This follows Tavily's documented
[proxy support](https://docs.tavily.com/sdk/javascript/reference) while keeping
proxy behavior isolated from model and notification traffic.

The module is disabled by default. Saving a Key does not enable the module, and
enabling the module without a Key does not register the tool. Changing either
condition invalidates active Pi handles while preserving conversation history;
the next turn receives the new capability set.

## MCP contract

The local server is named `rp-agent-tavily-search` and exposes one read-only,
open-world tool:

| Tool | Inputs | Defaults and limits |
|---|---|---|
| `tavily_search` | `query`, `searchDepth`, `topic`, `timeRange`, `maxResults`, `includeDomains`, `excludeDomains` | `basic`, `general`, 5 results; query at most 1000 characters and results capped at 10 |

The tool returns ranked titles, source URLs, and snippets. Raw page content,
generated answers, images, and favicons are disabled to keep the model context
bounded. Snippets are capped at 2000 characters per result. Prompts require the
Agent to preserve source URLs and distinguish retrieved evidence from inference.

`basic`, `fast`, and `ultra-fast` searches use one Tavily credit, while
`advanced` uses two according to Tavily's
[search-depth documentation](https://docs.tavily.com/documentation/api-reference/endpoint/search).
Metered search is blocked while composing proactive due-reminder messages.

## Credential handling

The Key and optional proxy URL are stored at `<stateDir>/tavily.json` with mode
`0600` using atomic replacement. HTTP responses expose only Key status, a short
Key mask, proxy status, a proxy URL with any credentials replaced by `***`, and
`updatedAt`. Neither credential is included in model context, debug traces,
audit actions, or `/api/v1/export`. Upstream error text is bounded and exact
credentials are redacted before an error can reach the application.

Direct connections are the default. When configured, an Undici `ProxyAgent`
handles only Tavily requests. Network failures retain a safe low-level code such
as `ECONNRESET` plus a prompt to inspect outbound HTTPS and proxy settings; a
network failure occurs before API Key validation and must not be reported as an
invalid Key.

Search audit records contain a SHA-256 query digest, query length, search mode,
result count, request ID, and reported credit usage. They do not contain the raw
query or result snippets. Operational backups can contain `tavily.json` and must
therefore be handled as secrets.

## HTTP contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/settings/tavily` | Return safe Key status and mask |
| PATCH | `/api/settings/tavily` | Save `apiKey` and/or `proxyUrl`; clear independently with `clearApiKey` or `clearProxyUrl` |
| POST | `/api/v1/diagnostics/tavily/test` | Authenticate against Tavily `/usage` and return status/latency |
| GET | `/api/v1/readiness` | Include the boolean `tavilyConfigured` state |

Configuration errors return HTTP 400 with `TAVILY_CONFIG_INVALID`. Upstream
Tavily failures return HTTP 502 with `TAVILY_API_ERROR` and a bounded upstream
status. The supported deployment remains loopback-only; these settings routes
must not be exposed publicly without authentication and CSRF protection.

## Test requirements

Automated tests use an injected Tavily base URL and a local fake HTTP server;
they never spend credits or call production Tavily. Coverage must verify both
enablement gates, Bearer authentication, request mapping, proxy dispatcher use,
source URLs in tool results, credential persistence/masking/clearing, export
redaction, query-free audits, desktop/mobile settings workflows, and absence of
browser console errors.
