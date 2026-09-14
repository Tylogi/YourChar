# Agent Workspace and Privileged Capabilities

## 1. Security boundary

The Agent never receives Pi's unrestricted built-in coding tools. YourChar
constructs a capability set for each Pi handle from persisted permission state.
Changing a permission closes current handles and recreates them on the next turn
without discarding conversation history.

Generic file and shell capabilities are restricted to:

```text
<stateDir>/workspace
```

The default location is `.yourchar/workspace`. User Profile and character
SOUL.md files are outside this root and cannot be reached through generic file
tools or the sandboxed shell. They are available only through their dedicated
services and MCP authorization switches.

Custom paths fail at startup if the normal or derived private Workspace
overlaps the protected state directory or any Agent Skill discovery root. The
only supported overlap with the state directory is the dedicated default pair
`<stateDir>/workspace` and `<stateDir>/workspace-secret`. The state directory
itself may not be placed inside a Skill discovery root. These checks use
canonical paths so configuration and symlinks cannot turn an ordinary
Workspace or enabled Skill into a path to private transcripts, Vault files, or
another space's Workspace.

## 2. Permission model

| Permission | Default | Effect |
|---|---|---|
| Workspace access | Off | `off`, `read_only`, or `read_write` |
| Sandboxed shell | Off | Registers blocking `bash` plus durable background execution tools using Bubblewrap |
| Shell network | Off | With explicit user authorization, shares the host network namespace for sandboxed Shell commands |
| User Profile auto-edit | On | Registers `update_user_profile` while User Profile MCP is enabled |
| Character SOUL auto-edit | Off | Registers the character-bound SOUL MCP in RP sessions |

Workspace access and shell execution are intentionally independent. A shell may
run with an empty transient `/workspace`, a read-only workspace bind, or a
read-write workspace bind. Disabling shell automatically disables shell network.
Enabling network while shell is disabled is rejected.

Shell network is an explicit, persistent user choice. Before enabling it, the UI
warns that the Agent can contact arbitrary external services and may transmit
conversation context, memories, Skill-influenced content, or Workspace data
visible in the current turn. Once accepted, private data, private conversations,
incognito overlays, enabled character-private Skills, and autonomous workflows
do not silently rewrite or narrow that choice. Disabling Shell still disables
Shell network. Host-side Tavily, Web Reader, Vision, and model-provider clients
retain their own independent module/configuration boundaries.

Permission overrides use reserved `permission:*` rows in
`agent_module_settings`. They are separate from MCP and Skill module switches so
module discovery remains stable.

## 3. File tools

The following tools are assembled from the current workspace access level:

| Tool | Off | Read only | Read-write |
|---|---:|---:|---:|
| `read` | No | Yes | Yes |
| `read_document` | No | Yes | Yes |
| `list_workspace` | No | Yes | Yes |
| `share_workspace_file` | No | Yes | Yes |
| `write` | No | No | Yes |
| `edit` | No | No | Yes |

`read` also remains available for enabled Skill packages even when workspace
access is off. A package must use `<skill>/SKILL.md`; loose Markdown files at a
configured Skills root and symlinked packages are ignored. The main file is
authorized exactly, and only a real, dedicated package directory grants access
to referenced resources below it. This prevents one normal Skill from reading
an adjacent private-only Skill. Skill packages are always read-only.

`read_document` converts Workspace-relative PDF, DOCX, PPTX, XLS/XLSX, HTML,
CSV, and common text documents to bounded Markdown chunks with Microsoft
MarkItDown. The Python worker runs in its own uv-managed environment inside a
network-isolated Bubblewrap sandbox. It receives only one read-only source file,
the read-only worker environment, temporary storage, and the minimum system
runtime; it does not receive the Workspace directory, state directory, model
credentials, host environment, or network namespace. Converted content is
wrapped as untrusted document data and cached only in bounded process memory.
Normal, per-character secret, and disposable incognito Workspaces use distinct
cache namespaces. Empty-text PDFs fail explicitly as OCR candidates; the first
integration does not pass Vision credentials to Python or silently upload a
scanned document.

All paths supplied to workspace tools must be relative. The implementation
resolves real paths and rejects symlink, directory, and parent-directory
escapes. The text-oriented `read`, `write`, and `edit` tools limit each file to
1 MiB. `write` uses an atomic replacement. `edit` performs exact replacement
and rejects ambiguous matches unless `replaceAll` is explicit. File mutations
emit audit actions without storing file contents.

`share_workspace_file` is an explicit publication step for an existing regular
file. A successful call queues at most eight canonical Workspace paths for the
current turn. After the final assistant output, the server validates every file
again, binds structured attachment metadata to that exact assistant transcript
entry, and persists a hidden marker that is excluded from provider history and
public message APIs. Reload and restart reconstruct the attachment only while
the file still exists. The chat renders image cards, text/PDF previews, and
download actions. HTML preview is size-bounded and opens in a safe static mode
that strips scripts, navigation, forms, and external resources. Pages containing
scripts expose an explicit interactive-preview control: it reloads the document
with scripts and HTTPS resources inside an opaque-origin sandbox, without
same-origin access, forms, popups, downloads, or top-level navigation. The
original HTML remains available as a download.

## 4. Shell sandbox

Linux shell execution requires `/usr/bin/bwrap`. The sandbox:

- starts with a new process, IPC, PID, UTS, cgroup, and network namespace;
- exposes `/usr` read-only plus minimal `/proc`, `/dev`, and temporary storage;
- mounts only the dedicated workspace at `/workspace` according to its access
  level;
- does not mount `/home`, the application repository, state root, User Profile,
  SOUL.md files, model credentials, or the host environment;
- clears environment variables and supplies only `PATH`, `HOME`, and `LANG`;
- keeps network isolated unless the separate network switch is explicitly
  enabled by the user;
- limits blocking `bash` runtime to 120 seconds and captured output to 64 KiB;
- records a command hash and length, exit status, duration, timeout, truncation,
  and network mode in the action audit without retaining command text.

When Shell is enabled outside incognito, the same handle also receives
`start_shell_job`, `list_execution_jobs`, `get_execution_job`, and
`interrupt_execution_job`. A background job is owned by its parent conversation
but not by that conversation's in-memory Pi handle, so handle rebuilds do not
stop it. Admission freezes its Workspace and network grant. At most four jobs
may run per conversation and eight process-wide; each attempt is limited to one
hour, each job to three explicit attempts, and each attempt retains at most 8
MiB of combined stdout/stderr.

Command bodies, Workspace host paths, and output bodies are private SQLite
execution artifacts. Ordinary list/detail responses and action audits contain
only command hash/length and lifecycle metadata. Output enters model context
only through `get_execution_job`, one cursor page at a time (16 KiB by default,
64 KiB maximum). Process shutdown never silently replays a command: the durable
job becomes `idle`, its interrupted run becomes `abandoned`, and only the
trusted local control plane may retry it. A retry intersects the original grant
with current permissions, so access can narrow but never widen.

This boundary controls host filesystem mounts but does not make untrusted code
harmless to files in a read-write Workspace. When Shell network is enabled,
Bubblewrap shares the host network namespace: commands may access public and
local services and may send any current-context or Workspace information the
Agent can express. Private mode and Skill loading preserve the user's choice;
they do not provide an outbound confidentiality guarantee.

## 5. Durable goals, plans, and todos

Every persistent non-incognito conversation receives the compact
`manage_goal`, `list_goals`, and `get_goal` tool surface. `manage_goal` uses an
explicit operation for goal edits, lifecycle transitions, dependency updates,
and todo creation/edit/transition. Goal state belongs to the exact parent conversation;
normal and per-character secret conversations cannot read or reference one
another's goals. Incognito handles receive none of these tools and cannot write
goal rows through the local control plane.

A goal has a bounded title (240 characters), explicit success criteria (2,000),
plan (4,000), notes (1,000), priority, lifecycle status, and at most 16 acyclic
same-session dependencies. It may contain at most 50 ordered todos. Goal and
todo mutations require current optimistic revisions, so parallel or stale
writes fail instead of silently overwriting newer progress. A goal cannot be
completed until every dependency is completed and every todo is completed or
cancelled. Completed and cancelled goals/todos are immutable.

Each accepted mutation changes the current projection and appends exactly one
typed transition in the same SQLite transaction. The transition ledger records
its source, sequence, subject, status edge, bounded note, and a bounded private
payload. A restarted turn can use `list_goals` and `get_goal` to recover the
remaining todos and recent transitions without rerunning completed work.
Ordinary action audits retain only IDs, revisions, lifecycle status, and counts;
goal, plan, note, and todo text stays in the conversation-owned durable rows.
Deleting the conversation cascades through all goal artifacts.

The local control plane mirrors the same ownership and revision checks under
`/api/v1/sessions/{id}/goals`, with nested `transition`, `dependencies`, and
`todos` routes. All mutations require the trusted local mutation boundary.

## 6. Protected Markdown capabilities

User Profile MCP is still the context switch for profile visibility. When the
module is enabled, `get_user_profile` is available and only the manual profile
section is injected. The Coordinator-owned managed reality section remains
visible through HTTP and Management but never enters provider context through
Profile MCP or System. The separate auto-edit permission controls only manual
`update_user_profile` writes; direct full-document editing through HTTP and
Management remains available.

Character SOUL auto-edit is narrower. When enabled, an RP handle with a selected
character receives `get_current_character_soul` and
`update_current_character_soul`. The MCP server binds the character ID when the
handle is created, so the model cannot select another character. No SOUL tools
are registered in SMS or an unbound RP session.

## 7. HTTP and testing contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/agent-permissions` | Read effective permissions and runtime availability |
| PATCH | `/api/v1/agent-permissions` | Replace one or more permission fields |
| GET | `/api/v1/workspace/files/preview` | Return a bounded preview descriptor |
| GET | `/api/v1/workspace/files/content` | Stream an inline-safe asset or attachment download |
| GET/POST | `/api/v1/sessions/{id}/execution-jobs` | List or start conversation-owned background shell jobs |
| GET | `/api/v1/sessions/{id}/execution-jobs/{jobId}` | Read redacted job/run metadata |
| GET | `/api/v1/sessions/{id}/execution-jobs/{jobId}/output` | Read a bounded output page |
| POST | `/api/v1/sessions/{id}/execution-jobs/{jobId}/interrupt` | Interrupt a non-terminal job |
| POST | `/api/v1/sessions/{id}/execution-jobs/{jobId}/retry` | Explicitly retry with no wider grant |
| GET/POST | `/api/v1/sessions/{id}/goals` | List or create conversation-owned durable goals |
| GET/PATCH | `/api/v1/sessions/{id}/goals/{goalId}` | Read or revise goal details using a revision |
| POST | `/api/v1/sessions/{id}/goals/{goalId}/transition` | Change goal lifecycle status |
| PATCH | `/api/v1/sessions/{id}/goals/{goalId}/dependencies` | Replace the bounded dependency set |
| POST | `/api/v1/sessions/{id}/goals/{goalId}/todos` | Append a pending todo |
| PATCH | `/api/v1/sessions/{id}/goals/{goalId}/todos/{todoId}` | Revise a non-terminal todo |
| POST | `/api/v1/sessions/{id}/goals/{goalId}/todos/{todoId}/transition` | Change todo lifecycle status |

Example:

```json
{
  "workspaceAccess": "read_write",
  "shellEnabled": true,
  "networkEnabled": false,
  "userProfileWriteEnabled": true,
  "characterSoulWriteEnabled": false
}
```

Tests must verify both tool registration and actual isolation behavior. The
integration suite executes Bubblewrap, checks read-only/read-write mounts,
rejects path escape, confirms host paths are absent, and verifies that profile
and SOUL write tools follow independent switches. Document tests additionally
verify format signatures, bounded chunks, cache separation, untrusted-data
wrapping, cancellation, and a real no-network MarkItDown worker conversion.

Normal and per-character secret Workspace files are included in operational
backups. They are not returned by the JSON export and are not removed by the
application-data deletion endpoint, because they may be user-authored project
files. The secret Workspace root is a sibling of, never a child of, the normal
Workspace root.
