# Agent Modules and User Profile

## 1. Scope

The Management view owns two related controls:

1. MCP servers and Pi Skills available to model calls.
2. One user-editable Markdown profile maintained by the Agent during normal use.

This is single-user, loopback-only application state. Module enablement overrides
are stored in SQLite. The canonical profile document is stored at
`<stateDir>/memory-vault/reality/user-profile.md`. The R1
`<stateDir>/user-profile.md` path remains only as a migration mirror.

## 2. Module catalog

`AgentModuleCatalog` merges discovered modules with persisted enablement
overrides. Built-in MCP modules are:

- `mcp:schedule`, enabled by default;
- `mcp:memory-coordinator`, enabled by default;
- `mcp:tavily-search`, disabled by default and usable only with a configured Key;
- `mcp:user-profile`, enabled by default.

Disabling Schedule MCP removes its model-facing tools but does not stop direct
Schedule UI/API operations, the scheduler, or delivery of existing reminders.

Disabling User Profile MCP removes `get_user_profile` and
`update_user_profile` from new Pi handles and stops profile Markdown injection
into model context. It does not delete the file or prevent the user from viewing
and editing it in Management.

Disabling Memory Coordinator removes `search_memory` and `propose_memory`,
stops post-turn extraction and all memory injection, and leaves every Vault
document intact. Reality and character proposal permissions are independent and
default off; neither grants confirmation, rejection, archive, or deletion.

Tavily Search MCP registers `tavily_search` only when both its module switch and
its separately stored API Key are present. The credential lifecycle and search
contract are specified in [`tavily-search-mcp.md`](tavily-search-mcp.md).

Skills are disabled by default and discovered from `skills/`,
`.agents/skills/`, `.pi/skills/`, and `<stateDir>/skills/`. Pi's original
`loadSkills` parser supplies metadata. Enabled Skill files are passed to
`DefaultResourceLoader`; the replacement `read` tool resolves symlinks and only
permits the main file and real resources inside enabled, standalone Skill
packages. Loose root Markdown, symlinked packages, and overlapping packages are
ignored.

Management can install a public Skill from an HTTPS ZIP URL or a GitHub tree
URL. This is a host-side, user-confirmed control-plane operation rather than an
Agent or shell tool. Preview resolves a GitHub ref to an immutable commit,
downloads into a private quarantine directory, validates the archive and one
direct `SKILL.md`, and shows the normalized source, commit, manifest digest,
metadata, and bounded Markdown body. Confirm publishes the reviewed bytes by an
atomic rename and enables the Skill for normal, private, or both spaces. v1
never overwrites an existing package and executes no Git hooks, install scripts,
submodules, LFS filters, or package code.

The downloader accepts public HTTPS on port 443 only. It rejects credentials,
query strings, local hostnames, private/special addresses, mixed public/private
DNS answers, unsafe redirects, oversized responses, ZIP traversal, links,
special files, collisions, nested archives, ZIP64/encryption, excessive
expansion, and digest mismatches. Every redirect is resolved and checked again,
and the production transport connects only to an already validated DNS answer.
For Clash-style TUN on this deployment, `198.18.0.0/15` Fake-IP answers are
accepted only for the exact GitHub web/API/codeload hosts and only when the same
lookup also contains a genuine public-unicast fallback. Literal Fake-IP input,
generic hosts, private-only answers, or any mixture containing another private
or special address still fail closed.

Changing any module invalidates current Pi handles. Persistent sessions reopen
their JSONL transcript, while in-memory test sessions retain a detached message
copy. The next turn receives the new capability set without losing history.

### Token estimates

Management displays approximate token impact for every module. The estimate is
informational because the configured model's tokenizer remains authoritative.

- MCP values estimate the current provider-facing tool names, descriptions, and
  JSON schemas sent on each model turn while that MCP is available.
- Skill index values estimate Pi's name/description/path entry sent each turn.
- Skill full-content values estimate the complete `SKILL.md` added only when the
  Agent reads that Skill during a turn.
- ASCII text is estimated at four characters per token and non-ASCII text at one
  code point per token. Built-in MCP estimates are rounded to avoid false
  precision and must be reviewed when tool schemas change.

## 3. User profile document

The profile is one bounded Markdown summary. Confirmed `reality/global` memory
documents are the durable fact source; the profile is not an unlimited fact
store. A deterministic managed section projects the highest-salience confirmed
reality memories while preserving the user-written section.

Rules:

- Maximum length is 2000 Unicode code points, enforced by the service for HTTP,
  MCP, and direct application calls.
- Writes normalize CRLF to LF, use an atomic replacement, and set mode `0600`.
- The user may view and replace the complete document through Management or the
  HTTP API whether the MCP module is enabled or disabled.
- The Agent may replace only the manual section through User Profile MCP when
  that module and the separate User Profile auto-edit permission are enabled;
  the managed section is preserved automatically and is not returned to the
  model.
- Agent updates must preserve still-valid content and must not store guesses,
  temporary moods, routine dialogue, secrets, or fictional RP facts.
- Only the profile manual section is injected into SMS and RP System context
  while User Profile MCP is enabled. Confirmed reality memory is selected once
  through hidden turn context while Memory Coordinator is enabled; disabling
  it prevents the managed projection from becoming a fallback injection path.
  Character-scoped RP memory remains separate.
- Managed projection runs atomically with reality lifecycle changes only while
  `userProfileWriteEnabled` is true. It removes superseded/forgotten lines,
  never truncates manual text, and leaves an exact 2000-code-point manual
  document byte-for-byte unchanged when no managed line fits.

The default document provides headings for basic information, communication,
current goals, and boundaries. Empty sections are valid. The unused
`user_profiles` table from migration v6 remains in place because migrations are
append-only, but it is not a source of truth.

## 4. MCP contract

User Profile MCP uses the same official linked in-memory transport and generic Pi
adapter as Schedule MCP.

| Tool | Mutation | Contract |
|---|---:|---|
| `get_user_profile` | No | Return manual Markdown and manual length metadata |
| `update_user_profile` | Yes | Replace manual Markdown while preserving the managed block; optional short reason |

`update_user_profile` records an audited action with MCP transport, session ID,
character count, and reason. Proactive reminder generation blocks this and all
other mutating tools.

## 5. HTTP contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/agent-modules` | Rediscover and list MCP/Skill modules |
| PATCH | `/api/v1/agent-modules/{id}` | Set MCP `{ "enabled": boolean }` or Skill `{ "enabledSpaces": [...] }` |
| POST | `/api/v1/agent-skills/install/preview` | Download, quarantine, validate, and return a review stage |
| POST | `/api/v1/agent-skills/install/confirm` | Publish a reviewed `{ stageId, sha256, enabledSpaces }` |
| DELETE | `/api/v1/agent-skills/install/stages/{id}` | Cancel and remove a quarantined review stage |
| GET | `/api/v1/agent-permissions` | Read workspace, shell, profile, and SOUL permissions |
| PATCH | `/api/v1/agent-permissions` | Update one or more permission fields |
| GET | `/api/v1/user-profile` | Read Markdown and length metadata |
| PATCH | `/api/v1/user-profile` | Replace with `{ "markdown": string }` |
| GET/PATCH | `/api/settings/tavily` | Read safe Tavily status or save/clear its Key |
| POST | `/api/v1/diagnostics/tavily/test` | Test the configured Key without exposing it |

An over-limit profile returns HTTP 400 with code `USER_PROFILE_INVALID`. Export
includes the profile document. Complete data deletion removes the Markdown file.

Installer mutations and Skill enabled-space changes require same-origin JSON
from the loopback UI plus a per-process, unguessable HttpOnly cookie. Host and
Origin must match the actual loopback socket, so a hostile web page or
DNS-rebinding hostname cannot trigger a download, persistent install, or
private-to-normal enablement change. The token is never placed in HTML, model
context, Workspace, or shell environment.

Workspace and protected-document capability details are specified in
[`workspace-capabilities.md`](workspace-capabilities.md).

## 6. Adding modules

For a Skill, use the reviewed installer or place a valid
`<package>/SKILL.md` under a discovery root. A manually added package appears
after a rescan and remains disabled until explicitly enabled.

For an MCP module, add its descriptor to the catalog, construct its bridge only
when enabled, and append it to `PiSessionHandle.mcpBridges`. Keep direct domain
services independent from model-facing toggles. Tests must cover enabled and
disabled tools, context visibility, transcript resume, persistence, and UI state.
