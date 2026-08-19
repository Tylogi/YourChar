# YourChar

A local-first, open-source runtime for persistent AI characters and digital
lives, layered on the original Pi agent runtime.

The codebase uses the original `@earendil-works/pi-coding-agent` session runtime
and adds the RP companion domain on top:

- provider-neutral agent messages;
- structured lifecycle events;
- model-driven tool calls;
- MCP-discovered schedule tools over a reusable JSON-RPC adapter;
- deterministic domain validation and tool policy boundaries;
- Pi-owned persistent session state with application metadata;
- SQLite schedule, occurrence, and notification-outbox persistence;
- strict time resolution, recurrence, snooze, quiet hours, and delivery retry;
- due reminders that resume the source Pi context and send Agent-authored messages;
- deterministic virtual-clock and scripted-model interfaces for test agents;
- per-character SOUL.md files, scenes, typed long-term memory, and FTS5 retrieval;
- runtime MCP/Skill discovery and persisted capability toggles;
- optional Tavily live web search through a credential-isolated local MCP;
- optional SSRF-restricted Web Reader MCP for readable public URL contents;
- direct or independent Vision MCP image understanding for text-only primary models;
- optional isolated private-chat subagents for bounded work, research, planning, and review;
- automatic SOUL-derived functional roles, fixed capabilities, one visible versioned Skill per character, and trusted same-world specialist routing;
- optional per-character relationship and decaying affect state with trusted bounded updates;
- a 2000-character profile summary plus durable reality/global memory;
- persistent, retryable post-turn Memory Coordinator jobs with trusted review;
- permission-gated workspace file tools and a Bubblewrap-isolated shell;
- independently authorized User Profile and character SOUL editing;
- collapsible per-message execution progress without exposing hidden model reasoning;
- collapsed-by-default tool results and MCP/Skill token-impact estimates;
- one canonical private SMS thread per character and one shared timeline per world;
- optional single-owner WeChat and Feishu/Lark channels, each routed to a selected character's normal conversation;
- world-level narrative/Analyzer profiles; World turns never invoke character-bound chat models;
- event-scoped fixed World prompts with restart-safe append-only history and KV-cache metrics;
- first-class World Cards and turn-grouped third-person interactive-fiction rendering;
- event-end observer-scoped settlement into character records and bounded World chronicles;
- fictional-state policy that separates World events from real schedule changes;
- thin HTTP server as an adapter, not the core.

## Commands

```bash
npm install
npm test
npm run test:browser
npm run build
npm run dev
```

Pi runtime packages require Node `>=22.19.0`.

The repository pins Node `22.19.0` in `.nvmrc`. The target product architecture,
development milestones, and Agent-oriented test contracts are documented in
[`docs/development-spec.md`](docs/development-spec.md).
The reusable MCP module and proactive-event pattern is documented in
[`docs/mcp-agent-modules.md`](docs/mcp-agent-modules.md).
Module lifecycle and user-profile rules are documented in
[`docs/agent-modules-and-user-profile.md`](docs/agent-modules-and-user-profile.md).
Character identity and migration rules are documented in
[`docs/character-soul.md`](docs/character-soul.md).
Multi-model profiles, per-character routing, canonical World timelines, and the
retired RP/group migration policy are documented in
[`docs/world-conversation-mode.md`](docs/world-conversation-mode.md). The old
group contract remains only as a compatibility note in
[`docs/group-chat-multi-model.md`](docs/group-chat-multi-model.md).
Workspace, shell, and protected-document permissions are documented in
[`docs/workspace-capabilities.md`](docs/workspace-capabilities.md).
Per-character private-mode isolation, shared boundaries, backup behavior, and
the non-encryption threat model are documented in
[`docs/private-mode.md`](docs/private-mode.md).
Single-owner WeChat and Feishu/Lark setup, normal-only routing, attachment,
credential, and backup boundaries are documented in
[`docs/im-channels.md`](docs/im-channels.md).
Tavily module enablement, Key handling, tool limits, and test contracts are
documented in [`docs/tavily-search-mcp.md`](docs/tavily-search-mcp.md).
Read-only URL extraction, network boundaries, TUN behavior, and test contracts
are documented in [`docs/web-reader-mcp.md`](docs/web-reader-mcp.md).
Vision routing, upload boundaries, caching, and test contracts are documented in
[`docs/vision-mcp.md`](docs/vision-mcp.md).
Private-chat delegation, child isolation, budgets, and test contracts are
documented in [`docs/subagent-delegation.md`](docs/subagent-delegation.md).
Per-character relationship dimensions, affect decay, trusted update policy, MCP
boundaries, and test contracts are documented in
[`docs/relationship-affect.md`](docs/relationship-affect.md).
The current memory retrieval, context budget, resident snapshot, cache, and
token-economics contracts are documented in
[`docs/memory-architecture-r4.md`](docs/memory-architecture-r4.md). The capture
and lifecycle foundation remains in
[`docs/memory-architecture-r3.md`](docs/memory-architecture-r3.md). R5 crash
consistency, writer/job leases, startup recovery, backup verification, and Vault
Health contracts are documented in
[`docs/memory-architecture-r5.md`](docs/memory-architecture-r5.md).
Daily-chat capture policy, the failure audit, semantic retrieval tags, and the
configured-model evaluation are documented in
[`docs/memory-daily-capture.md`](docs/memory-daily-capture.md).
The per-scenario background thinking controls, compatibility fallback, token
ceilings, and configured-model corpus are documented in
[`docs/background-thinking-policy.md`](docs/background-thinking-policy.md).
Deterministic functional completeness, independent LLM-as-Judge quality scoring,
target-model sandbox routing, aggregate labels, and report interpretation are
documented in
[`docs/model-adaptation-evaluation.md`](docs/model-adaptation-evaluation.md).
Character organization, specialist workbench boundaries, capability routing,
task evidence, and gated Skill improvement are documented in
[`docs/character-organization-v2.md`](docs/character-organization-v2.md).

The deterministic Agent test control API is disabled by default. Start a
loopback-only test server with:

```bash
RP_AGENT_TEST_MODE=1 npm run dev
```

Default dev server:

```text
http://127.0.0.1:8765
```

Persistent state is stored under `.rp-agent/` by default. Relevant runtime
settings are:

To keep existing installations upgrade-compatible, YourChar retains the legacy
`.rp-agent/` state directory, `RP_AGENT_*` environment variables,
`rp-agent.sqlite` database filename, `rp-agent.service` systemd unit, and
`rp-agent/*` internal protocol identifiers. Do not rename these identifiers in
an existing installation; they are compatibility names, not the product name.

| Variable | Default | Purpose |
|---|---|---|
| `RP_AGENT_STATE_DIR` | `.rp-agent` | Pi transcripts, metadata, model settings, and SQLite database |
| `RP_AGENT_TIMEZONE` | `Asia/Shanghai` | Timezone used by quiet hours |
| `RP_AGENT_QUIET_HOURS` | unset | Delivery pause window such as `22:00-07:00` |
| `RP_AGENT_DESKTOP_NOTIFICATIONS` | unset | Set to `1` to use the `notify-send` adapter |
| `RP_AGENT_TEST_MODE` | unset | Set to `1` to enable isolated Agent test controls |
| `HOST` / `PORT` | `127.0.0.1` / `8765` | HTTP listen address |

Desktop notifications require `notify-send` and a working desktop notification
daemon. Without that opt-in, reminders remain visible in the in-app notification
history and no external command is executed.

The scheduling API is rooted at `/api/v1/schedule-items`; notification history
and retry use `/api/v1/notifications`. Character, scene, and memory APIs use
`/api/v1/characters`, `/api/v1/sessions/{id}/scene`, and `/api/v1/memories`.
Canonical private chat opens through `/api/v1/direct-conversations`; World
timelines use `/api/v1/world-conversations` and
`/api/v1/worlds/{id}/conversation/*`.
WeChat and Feishu/Lark status, per-platform character routes, QR binding, and
typing settings use `/api/v1/im/*`. IM is normal-mode only and the main HTTP
service must remain loopback-only. The bundled/local Channel Runtime is the
supported deployment; external Gateway mode is experimental and limited to a
same-host loopback adapter, not a reason to expose or reverse-proxy `/api/*`.
Agent capability management uses `/api/v1/agent-modules` and
`/api/v1/agent-permissions`; the user-editable
profile Markdown uses `/api/v1/user-profile`. Roleplay memory creation remains
at `/api/v1/memories`; trusted reality-memory creation uses
`/api/v1/reality-memories`, and review/observability uses
`/api/v1/memory-coordinator/*`.
Per-character relationship inspection/reset uses
`/api/v1/characters/{id}/relationship`; background status and retries use
`/api/v1/relationship-coordinator/*`.
Read-only retrieval evaluation uses `/api/v1/context-plan/preview` and
`/api/v1/memory-retrieval/preview`; lightweight provider metrics use
`/api/debug/context-economics`. Metadata-only Vault durability status uses
`/api/v1/memory-vault/health` and `/api/v1/memory-vault/recovery`.
Tavily Key and optional HTTPS proxy status use `/api/settings/tavily`; its
connection diagnostic uses `POST /api/v1/diagnostics/tavily/test`.
In test mode, create an isolated run at
`POST /api/_test/v1/runs`, then send normal `/api/v1` requests with
`X-RP-Test-Run-Id`. The run exposes virtual clock, scripted model, scheduler
tick, captured notifications, event stream, and canonical snapshot controls.

`npm run test:browser` launches CloakBrowser against an isolated in-memory RP
Agent server and covers desktop/mobile viewports, Debug bounds, schedule CRUD,
character/scene/memory workflows, streaming chat, console errors, and element
overflow. CloakBrowser downloads its Chromium binary to `~/.cloakbrowser` on
first use. On minimal Linux systems, set `CLOAKBROWSER_LIB_DIR` to a directory
containing Chromium runtime libraries; this workstation uses
`~/.local/share/cloakbrowser-libs/usr/lib/x86_64-linux-gnu`.

Managed service installation, offline consistent backup, verification, and
staged restore procedures are in
[`docs/operations.md`](docs/operations.md).

## Current Scope

M0-M13 baseline work is implemented: original Pi private sessions, persistent
scheduling and reminder delivery, per-character SOUL.md, confirmed long-term
memory, private meeting continuity, isolated Agent test controls, SSE streaming,
diagnostics, export/deletion, persistent audit summaries, and browser automation.
Each character has one canonical private SMS thread. Each shared world has one
application-owned third-person timeline using one world-bound narrative model
and a post-turn Analyzer. Character-bound models are used only by private chats.
Legacy standalone RP sessions and group records are removed without transcript
migration.

Versioned model profiles support system, character, World narrative, and Analyzer
bindings. An optional Subagent Delegation MCP remains confined to private chat.
Relationship State MCP maintains each character's relationship with the user;
World analysis separately maintains directional character-to-character state.
M5 moves schedule operations behind an MCP server/client boundary and makes due
reminders resume the originating Pi session before delivery. Debug also retains
the latest 10 final provider request payloads, with role-colored messages and a
complete raw JSON view; credential fields are redacted.
M6 adds persisted, space-aware MCP/Skill switches, Pi-native Skill discovery
with package-scoped reading, a reviewed host-side HTTPS Skill installer, a
management UI, and a switchable User Profile MCP backed by one Agent-maintained
Markdown document.
M7 adds a dedicated workspace, permission-gated read/write/edit tools, an
OS-isolated Bubblewrap shell with a separate network switch, and independent
Agent-edit authorization for User Profile and character SOUL Markdown.
M8 adds an optional Tavily Search MCP, a masked Key settings flow, metered-tool
policy, credential-safe audits, and deterministic fake-upstream tests.
M9 adds direct primary-model image input, an independent Vision MCP fallback,
bounded image caching, secure upload-only raster access, and visual settings.
The current memory architecture adds an Obsidian-compatible Vault as the source
of truth, realm-bound reality and roleplay memories, a persistent post-turn
Coordinator, trusted confirmation/forget lifecycle, and deterministic managed
profile projection. Provider context receives the manual profile section plus,
only while Memory Coordinator is enabled, selected confirmed memory in hidden
turn context; the human-visible managed profile block is never injected twice.
R4 removes arbitrary no-match fallback, adds bounded per-realm retrieval and
one-time core bootstrap, reconstructs resident memory from actual Pi history
after restart/compaction, and records estimate-vs-actual context economics with
canonical provider-prefix evidence.
R5 adds a durable staged Vault journal, expiring writer and Coordinator leases,
per-commit fencing, deterministic startup replay, verified schema-v3 backups,
staged restore, and metadata-only Vault Health UI/API. Markdown remains the
authority; SQLite, FTS, journal checkpoints, mirrors, and context state remain
rebuildable runtime data.

The old Python implementation was intentionally removed from the working tree.
It remains available through Git history.
