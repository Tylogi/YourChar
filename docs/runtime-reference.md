# Runtime reference

[Project home](../README.md) · [Documentation index](README.md)

This reference collects the detailed capability inventory, environment
variables, HTTP routes, and implementation history previously embedded in the
project README. Start with the [quick start](../README.md#quick-start) for a
first installation, or [Operations](operations.md) for deployment and backup.

## Capability inventory

- provider-neutral agent messages;
- structured lifecycle events;
- model-driven tool calls;
- MCP-discovered schedule tools over a reusable JSON-RPC adapter;
- deterministic domain validation and tool policy boundaries;
- Pi-owned persistent session state with application metadata;
- SQLite schedule, occurrence, and notification-outbox persistence;
- strict time resolution, recurrence, snooze, quiet hours, and delivery retry;
- rolling, evidence-referenced character checkpoints with bounded model requests and local fallback;
- early background reminder drafts, deadline fallbacks, and independent UI/owner-IM delivery with shared acknowledgement;
- user-controlled WeChat/Feishu reminder switches, independent of model-assigned importance;
- deterministic virtual-clock and scripted-model interfaces for test agents;
- per-character SOUL.md files, scenes, typed long-term memory, and FTS5 retrieval;
- runtime MCP/Skill discovery and persisted capability toggles;
- optional Tavily live web search through a credential-isolated local MCP;
- optional SSRF-restricted Web Reader MCP for readable public URL contents;
- direct or independent Vision MCP image understanding for text-only primary models;
- optional isolated private-chat subagents for bounded work, research, planning, and review;
- automatic SOUL-derived functional roles, multiple exclusive versioned Skills per character, Skill-aware same-world delegation, and reviewed self-improvement proposals;
- opt-in character-bound Skill autonomy with next-turn workflow activation and safety-checked, character/space-private Agent Skill installation;
- optional per-character trust/bond state, decaying tension and affect, with trusted bounded updates;
- a 2000-character profile summary plus durable reality/global memory;
- persistent, retryable post-turn Memory Coordinator jobs with trusted review;
- permission-gated workspace file tools and a Bubblewrap-isolated shell;
- optional SSH Git access that keeps cloned repositories in a fixed Workspace tree;
- a network-isolated `officeparser` worker for bounded PDF and Office document reading;
- optional MinerU API parsing for richer document layout, formulas, tables, and OCR, behind a separate MCP switch;
- independently authorized User Profile and character SOUL editing;
- collapsible per-message execution progress without exposing hidden model reasoning;
- collapsed-by-default tool results and MCP/Skill token-impact estimates;
- one canonical private SMS thread per character and one shared timeline per world;
- a durable per-character private partition plus disposable incognito snapshots for testing without committing the resulting turns;
- optional single-owner WeChat and Feishu/Lark channels, each routed to a selected character's normal conversation;
- world-level narrative/Analyzer profiles; World turns never invoke character-bound chat models;
- event-scoped fixed World prompts with restart-safe append-only history and KV-cache metrics;
- versioned runtime-event streams with projection replay, hash-chain verification, and bounded checkpoints;
- first-class World Cards and turn-grouped third-person interactive-fiction rendering;
- event-end observer-scoped settlement into character records and bounded World chronicles;
- fictional-state policy that separates World events from real schedule changes;
- thin HTTP server as an adapter, not the core.

Additional Agent-runtime capabilities include trusted capability profiles and
reload, continuable subagents, durable shell jobs, goals/todos, workflow DAGs,
default-off LSP navigation, native provider adapters, credential references,
the headless API/SDK, and the optional ACP bridge. Their contracts and release
evidence are in the [modernization plan](agent-runtime-modernization-plan.md).

## Isolated Agent test API

The deterministic Agent test control API is disabled by default. Start a
loopback-only test server with:

```bash
RP_AGENT_TEST_MODE=1 npm run dev
```

Default dev server:

```text
http://127.0.0.1:8765
```

## State and environment

Persistent state is stored under `.yourchar/` by default.

To keep existing installations upgrade-compatible, YourChar retains the legacy
`RP_AGENT_*` environment variables, `rp-agent.sqlite` database filename,
`rp-agent.service` systemd unit, and `rp-agent/*` internal protocol identifiers.
`YOURCHAR_STATE_DIR` takes precedence over the legacy `RP_AGENT_STATE_DIR`. With
neither set, a sole existing `.rp-agent/` remains readable; if `.yourchar/` and
`.rp-agent/` both exist, startup and maintenance scripts fail closed until the
operator resolves the ambiguity.

The user-service installer migrates a sole legacy directory automatically. It
stops the existing unit, verifies that no Vault writer is active, creates a
verified timestamped backup under `backups/`, and atomically renames
`.rp-agent/` to `.yourchar/` without copying. Symlinks, non-directories, wrong
ownership, a second state directory, or a failed backup or rename aborts
installation. Do not rename compatibility database, service, or protocol
identifiers.

| Variable | Default | Purpose |
|---|---|---|
| `YOURCHAR_STATE_DIR` | `.yourchar` | Pi transcripts, metadata, model settings, and SQLite database |
| `RP_AGENT_STATE_DIR` | unset | Legacy state-directory override, used only when `YOURCHAR_STATE_DIR` is unset |
| `RP_AGENT_TIMEZONE` | `Asia/Shanghai` | Timezone used by quiet hours |
| `RP_AGENT_QUIET_HOURS` | unset | Delivery pause window such as `22:00-07:00` |
| `RP_AGENT_DESKTOP_NOTIFICATIONS` | unset | Set to `1` to use the `notify-send` adapter |
| `RP_AGENT_TEST_MODE` | unset | Set to `1` to enable isolated Agent test controls |
| `YOURCHAR_HEADLESS_API_TOKEN` | unset | Enables authenticated loopback automation under `/api/headless/v1` |
| `YOURCHAR_ACP_CHARACTER_ID` | unset | Character selected by the optional one-session ACP stdio bridge |
| `YOURCHAR_ACP_CWD` | process cwd | Exact cwd admitted by the optional ACP bridge |
| `HOST` / `PORT` | `127.0.0.1` / `8765` | HTTP listen address |

Desktop notifications require `notify-send` and a working desktop notification
daemon. Without that opt-in, reminders remain visible in the in-app notification
history and no external command is executed.

## HTTP resource map

The scheduling API is rooted at `/api/v1/schedule-items`; notification history
and retry use `/api/v1/notifications`. Character, scene, and memory APIs use
`/api/v1/characters`, `/api/v1/sessions/{id}/scene`, and `/api/v1/memories`.
Canonical private chat opens through `/api/v1/direct-conversations`; disposable
test overlays open through `/api/v1/incognito-conversations`; World
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
MinerU endpoint and optional Bearer token settings use `/api/settings/mineru`;
its connection diagnostic uses `POST /api/v1/diagnostics/mineru/test`.
Character-owned workflow review uses
`/api/v1/characters/{id}/owned-skills/*`. Character-private Agent Skill package
inventory, post-install inspection, enablement, and removal use
`/api/v1/characters/{id}/skill-packages/*`. Legacy short-lived stage routes
remain a host control-plane compatibility surface; the character-facing
autonomous installer does not expose its stage or confirmation boundary.
The one host-side Git identity is managed from **Settings → Repository** through
`/api/settings/git-access`. Repository URLs are supplied in normal character
conversation instead of being pre-registered as Projects or application
whitelists; checkouts stay below `.yourchar/workspace/repos/`.
In test mode, create an isolated run at
`POST /api/_test/v1/runs`, then send normal `/api/v1` requests with
`X-RP-Test-Run-Id`. The run exposes virtual clock, scripted model, scheduler
tick, captured notifications, event stream, and canonical snapshot controls.
Local automation uses the separately authenticated `/api/headless/v1` surface;
it is disabled unless `YOURCHAR_HEADLESS_API_TOKEN` is set and never requires a
browser-cookie bootstrap. The optional `yourchar-acp` binary is a thin stdio
adapter over that SDK for automation hosts such as DeepSeek Harness; its exact
capability and cancellation mapping is documented in
[acp-bridge.md](acp-bridge.md).

## Browser checks

`npm run test:browser` launches CloakBrowser against an isolated in-memory RP
Agent server and covers desktop/mobile viewports, Debug bounds, schedule CRUD,
character/scene/memory workflows, streaming chat, console errors, and element
overflow. CloakBrowser downloads its Chromium binary to `~/.cloakbrowser` on
first use. On minimal Linux systems, set `CLOAKBROWSER_LIB_DIR` to a directory
containing Chromium runtime libraries; this workstation uses
`~/.local/share/cloakbrowser-libs/usr/lib/x86_64-linux-gnu`.

Managed service installation, offline consistent backup, verification, and
staged restore procedures are in
[operations.md](operations.md).

## Implementation history and compatibility

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

Character Skill self-management is a separate Agent permission and defaults
off. When enabled, a role can create and activate its own current-space
workflows, revise them, and install or enable its own private Agent Skill
packages without a per-install approval. Remote installation is exposed only
in normal character conversations: it performs an outbound request to a
model-selected public HTTPS source, so the remote server can observe the host
and path. Secret conversations retain local workflow and package management
but cannot initiate that outbound fetch. Every package still passes the
quarantine, DNS/SSRF, redirect, archive, path, size, digest, and integrity
checks, and becomes available only from the next turn. Skills never add tools
or permissions. Incognito and generic subagents receive no management surface.
See the linked character and module documents for the narrower snapshot and
network-isolation behavior.

The old Python implementation was intentionally removed from the working tree.
It remains available through Git history.
