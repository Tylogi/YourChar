# Agent Modules and User Profile

## 1. Scope

The Management view owns two related controls:

1. MCP servers and Pi Skills available to model calls.
2. One user-editable Markdown profile maintained by the Agent during normal use.

This is single-user, loopback-only application state. Module enablement overrides
are stored in SQLite. The canonical profile document is stored at
`<stateDir>/memory-vault/reality/user-profile.md`. The R1
`<stateDir>/user-profile.md` path remains only as a migration mirror.

The character manager adds a third, narrower surface: versioned workflows and
private Agent Skill packages bound to one character and one conversation space.
It reuses the same trusted local control plane, but private packages do not
become global catalog modules.

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

Shared Agent Skills are disabled by default and discovered from `skills/`,
`.agents/skills/`, `.pi/skills/`, and `<stateDir>/skills/`. Pi's original
`loadSkills` parser supplies metadata. Enabled Skill files are passed to
`DefaultResourceLoader`; the replacement `read` tool resolves symlinks and only
permits the main file and real resources inside enabled, standalone Skill
packages. Loose root Markdown, symlinked packages, and overlapping packages are
ignored.

### Skill vocabulary

YourChar has two deliberately separate Skill concepts:

| Concept | Purpose | Body and resources | Activation boundary |
|---|---|---|---|
| Character-owned workflow | Records how one character performs a kind of work and supports routing, evaluation, and improvement | Immutable, versioned Markdown in the organization store; no package resource directory | The local user may review versions; when Skill autonomy is enabled, the bound character may also create or revise and activate its own version for the next turn |
| Agent Skill package | Supplies Pi-compatible procedural instructions and optional package resources to a model call | One direct `SKILL.md` plus verified files below its package root | Shared packages use global per-space switches; private packages are enabled only for one character and one space |

Both are instructions, not executable authority. A workflow or Agent Skill can
suggest using an existing tool, but cannot add a tool, enable a module, change a
permission, obtain credentials, cross a character/space boundary, or turn a
read-only child into a writer.

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

### Character-private Agent Skill packages

When the separate `characterSkillManageEnabled` permission is on, the current
character receives a character-bound MCP. The permission defaults off. It
allows the character to:

- list and read its own workflows in the current space;
- create and activate a new workflow, or revise and activate a new version;
- search metadata for shared Skills enabled in the current space and every
  installed private package for the current character and space, including its
  enabled and integrity state;
- enable or disable an already installed private package in that exact scope;
- in a normal conversation, choose a public HTTPS source and autonomously
  download, verify, install, and enable its own private package.

The MCP has no global-install, permission-edit, update, arbitrary owner, or
arbitrary space operation. Its schemas contain no owner or space fields:
`characterId` and `conversationSpace` come from trusted session context.
Secret-space actions are written with that character as the secret audit owner.
Audits omit workflow Markdown, resource contents, filesystem paths, and complete
source URLs.

A remote autonomous install remains internally split into a quarantine and
publication transaction, but the enabled permission is the one human
authorization boundary:

```text
model-selected public HTTPS source in a normal character conversation
  -> private quarantine and bounded download/archive validation
  -> exact staged digest is published and enabled for that character/space
  -> matching sessions rebuild capabilities for the next turn
```

“Next turn” refers to automatic workflow injection, the private-package index,
and the package `read` allowlist. The current tool call still returns a bounded
receipt, and a character may read workflow text it just authored through its
management surface; freshly downloaded package descriptions and contents are
not exposed until the rebuilt handle.

The model-facing result contains only safe installed-package metadata and never
returns package Markdown, resource contents, paths, stage IDs, or complete
source URLs. Internal stages are process-local and are cancelled after success
or failure; restart removes orphaned bytes. Each character/space may have at
most twelve installed private packages. A foreground turn may make at most
three remote-install attempts and complete only one source; the reservation is
taken before any fetch, so parallel tool calls cannot bypass it. Publication rechecks the bound owner,
space, stage digest, name collision, and package bytes before an atomic rename.
Shared and private package names cannot collide in either installation order.

This is intentionally an open-world capability. The selected remote host can
observe its hostname and request path, and archive validation cannot undo that
network disclosure. For that reason `install_current_character_skill` is not
registered in secret conversations. Secret conversations may still create or
revise local workflows and manage packages already present in their own secret
scope.

Package checks establish filesystem and transport safety, not publisher trust.
An unsigned downloaded `SKILL.md` becomes model guidance on the next turn and
may persuade the character to use Workspace, Tavily, Web Reader, or any other
capability the user already enabled. It cannot create new authority, but it can
exercise existing authority; enabling autonomy explicitly accepts that risk.

An installed private package is a resource package, not just a copied prompt.
The installer preserves the reviewed `SKILL.md` and its manifest-bound files,
while rejecting nested Skills, nested archives, links, special files, traversal,
and archive bombs. At load time the complete manifest and digest are verified;
missing, changed, or invalid packages are excluded and cannot be re-enabled.
The model may read text resources only through the existing bounded `read` tool
inside an enabled real package root. Package code, hooks, scripts, and binaries
are never executed by installation or activation.

Turning the management permission off removes the character-management MCP on
the next capability rebuild. It does not disable an already enabled Agent Skill
or deactivate an already active character-owned workflow; those have their own
trusted controls. Shell network is independent: enabling management, loading a
character-private package, or activating an autonomously created workflow does
not turn the user's network choice on or off. When networking is enabled, those
instructions may use it immediately and can transmit information visible in the
current turn; the settings confirmation makes that authority explicit.

### Incognito and subagent boundaries

Incognito children have no Skill installer, private-package service, or
character-management MCP. A normal-only incognito session receives a frozen
tmpfs copy of the selected character's effective normal-space Skills, including
their package resources, so existing guidance remains usable without reading
the persistent package tree. It receives no secret-space packages, cannot
stage, confirm, toggle, or activate Skills, and discards snapshot changes.

An isolated delegated subagent likewise receives no character-management MCP
and no local confirmation path. It may receive the effective enabled Agent
Skills and bounded resource-reading tool for its parent's character and space,
but only as read-only guidance. Character-owned workflow bodies are not
automatically added to the generic subagent prompt. Delegation cannot expand
the parent's tool or permission set.

The current package lifecycle is install once, enable/disable, integrity check,
and trusted removal after disable. There is no supported in-place update or
overwrite; a same-name package with different bytes is rejected. Removal is
bound to the exact owner, space, name, and digest and is intentionally absent
from the model MCP. Complete user-data deletion removes all private package rows
and owned package directories. Operational backups include the complete
`character-agent-skills/` resource tree together with its scoped database rows;
restore verification rejects a manifest that claims otherwise. JSON export is
for inspection and contains verified `SKILL.md`, not a replacement for the
resource-preserving operational backup.

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

### User Profile MCP

User Profile MCP uses the same official linked in-memory transport and generic Pi
adapter as Schedule MCP.

| Tool | Mutation | Contract |
|---|---:|---|
| `get_user_profile` | No | Return manual Markdown and manual length metadata |
| `update_user_profile` | Yes | Replace manual Markdown while preserving the managed block; optional short reason |

`update_user_profile` records an audited action with MCP transport, session ID,
character count, and reason. Proactive reminder generation blocks this and all
other mutating tools.

### Character Skill MCP

This MCP exists only when a persistent private-package service is available, a
session is bound to a character, the session is not incognito, and
`characterSkillManageEnabled` is true.

| Tool | Mutation | Contract |
|---|---:|---|
| `list_current_character_skills` | No | List metadata for owned workflows in the bound character/space |
| `read_current_character_skill` | No | Read one bound owned-workflow version |
| `create_current_character_skill` | Yes | Create with `createdBy=character`, activate it, and rebuild matching sessions for the next turn |
| `revise_current_character_skill` | Yes | Create and activate a `character_created` replacement version for the next turn |
| `search_available_agent_skills` | No | Return metadata only for enabled shared Skills and all installed bound-private packages, including disabled or integrity-failed entries |
| `set_current_character_private_skill_enabled` | Yes | Toggle an installed package in the fixed character/space and rebuild matching session capabilities |
| `install_current_character_skill` | Yes, normal only | Autonomously stage, validate, publish, and enable one model-selected public HTTPS package; at most three attempts and one completed source per foreground turn |

There is intentionally no model-facing global installation, permission
mutation, update, uninstall, arbitrary owner, or arbitrary space operation.
Remote content is untrusted data. The stage service applies the same HTTPS,
DNS/SSRF, redirect, archive, manifest, and size checks as the global installer,
then publishes the exact checked digest. The install tool is omitted entirely
from secret conversations because an arbitrary outbound URL is itself a data
egress channel.

## 5. HTTP contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/agent-modules` | Rediscover and list MCP/Skill modules |
| PATCH | `/api/v1/agent-modules/{id}` | Set MCP `{ "enabled": boolean }` or Skill `{ "enabledSpaces": [...] }` |
| POST | `/api/v1/agent-skills/install/preview` | Download, quarantine, validate, and return a review stage |
| POST | `/api/v1/agent-skills/install/confirm` | Publish a reviewed `{ stageId, sha256, enabledSpaces }` |
| DELETE | `/api/v1/agent-skills/install/stages/{id}` | Cancel and remove a quarantined review stage |
| GET | `/api/v1/characters/{id}/skill-packages` | List safe summaries for private packages in the requested, bound space |
| GET | `/api/v1/characters/{id}/skill-packages/{name}` | Read one safe package summary without source URL, manifest, path, or Markdown |
| POST | `/api/v1/characters/{id}/skill-packages/{name}/review` | Locally authenticate and read full provenance, manifest, and verified `SKILL.md` |
| PATCH | `/api/v1/characters/{id}/skill-packages/{name}` | Locally enable or disable one bound private package |
| DELETE | `/api/v1/characters/{id}/skill-packages/{name}` | Locally remove one disabled package using exact owner/space/name/digest matching |
| GET | `/api/v1/characters/{id}/skill-package-stages` | List redacted pending-review summaries |
| GET | `/api/v1/characters/{id}/skill-package-stages/{reviewId}` | Read one redacted pending-review summary |
| POST | `/api/v1/characters/{id}/skill-package-stages/{reviewId}/review` | Locally authenticate and read full stage provenance, manifest, and `SKILL.md` |
| POST | `/api/v1/characters/{id}/skill-package-stages/{reviewId}/confirm` | Confirm the exact bound stage and digest, then atomically publish it |
| POST | `/api/v1/characters/{id}/skill-package-stages/{reviewId}/cancel` | Cancel the exact bound stage and digest |
| GET | `/api/v1/agent-permissions` | Read workspace, shell, profile, SOUL, character Skill, and memory permissions |
| PATCH | `/api/v1/agent-permissions` | Update one or more permission fields, including default-off character Skill management |
| GET | `/api/v1/user-profile` | Read Markdown and length metadata |
| PATCH | `/api/v1/user-profile` | Replace with `{ "markdown": string }` |
| GET/PATCH | `/api/settings/tavily` | Read safe Tavily status or save/clear its Key |
| POST | `/api/v1/diagnostics/tavily/test` | Test the configured Key without exposing it |

An over-limit profile returns HTTP 400 with code `USER_PROFILE_INVALID`. Export
includes the profile document. Complete data deletion removes the Markdown file.

Installer mutations, Skill enabled-space changes, character-package mutations,
and full character-package/stage review reads require same-origin JSON from the
loopback UI plus a per-process, unguessable HttpOnly cookie. Their request body,
path, character, conversation space, stage/name, and digest are checked against
one another. Safe inventory GETs omit source URLs, manifests, paths, and
Markdown. All trusted Skill controls and full export are also rejected while
any Agent turn is active. This closes the loopback-shell path: a networked
character process cannot bootstrap browser credentials and review, confirm,
enable, or export Skill material during its own turn. Direct requests must
match the actual loopback socket. The
authenticated Lazycat ingress is also supported when it rewrites Host to that
socket and supplies its fixed HTTPS, ingress, and signed-in-user headers; this
is not a generic reverse proxy trust mode. Keep the app behind Lazycat login and
do not expose `/api/*` through an unauthenticated proxy. The token is never
placed in HTML, model context, Workspace, or shell environment.

Workspace and protected-document capability details are specified in
[`workspace-capabilities.md`](workspace-capabilities.md).

## 6. Adding modules

For a Skill, use the reviewed installer or place a valid
`<package>/SKILL.md` under a discovery root. A manually added package appears
after a rescan and remains disabled until explicitly enabled.

For a character-private Agent Skill, enable the default-off autonomy permission
and ask the bound character in a normal conversation to install a known public
HTTPS source (or one found through a separately enabled web-search tool). The
character selects the URL and the service performs the
quarantine and validation transaction without a second confirmation. The
source host can observe the request host/path, so remote installation is not
available in secret conversations. Copying files into
`character-agent-skills/` does not create the required scoped database row,
provenance, or manifest and is unsupported. Existing packages can be inspected,
enabled, disabled, and—after disabling—removed from the trusted local UI;
in-place update is not implemented.

For an MCP module, add its descriptor to the catalog, construct its bridge only
when enabled, and append it to `PiSessionHandle.mcpBridges`. Keep direct domain
services independent from model-facing toggles. Tests must cover enabled and
disabled tools, context visibility, transcript resume, persistence, and UI state.
