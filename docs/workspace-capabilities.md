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

The default location is `.rp-agent/workspace`. User Profile and character
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
| Sandboxed shell | Off | Registers `bash` using Bubblewrap |
| Shell network | Off | Shares the host network namespace only when no private state exists |
| User Profile auto-edit | On | Registers `update_user_profile` while User Profile MCP is enabled |
| Character SOUL auto-edit | Off | Registers the character-bound SOUL MCP in RP sessions |

Workspace access and shell execution are intentionally independent. A shell may
run with an empty transient `/workspace`, a read-only workspace bind, or a
read-write workspace bind. Disabling shell automatically disables shell network.
Enabling network while shell is disabled is rejected.

Shell network is globally fail-closed once any private conversation, private
memory, private Workspace, or private-only Agent Skill exists. Opening or
writing the first private item turns this switch off and rebuilds Agent
capabilities; trying to enable it again is rejected. If a normal Agent turn is
still running with network access, creation of the first private item waits for
the turn to finish by rejecting that operation without creating partial private
state. Host-side Tavily, Web Reader, Vision, and model-provider clients do not
use the shell namespace and retain their own independent module/configuration
boundaries.

Permission overrides use reserved `permission:*` rows in
`agent_module_settings`. They are separate from MCP and Skill module switches so
module discovery remains stable.

## 3. File tools

The following tools are assembled from the current workspace access level:

| Tool | Off | Read only | Read-write |
|---|---:|---:|---:|
| `read` | No | Yes | Yes |
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
- keeps network isolated unless the separate network switch is enabled and no
  private state exists;
- limits runtime to 120 seconds and captured output to 64 KiB;
- records a command hash and length, exit status, duration, timeout, truncation,
  and network mode in the action audit without retaining command text.

This boundary controls host filesystem and network access. It does not make
untrusted code harmless to files in a read-write workspace. Enable shell and
network only for tasks that need them; shell network becomes unavailable while
private state is present so an Agent cannot call YourChar's loopback HTTP API.

## 5. Protected Markdown capabilities

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

## 6. HTTP and testing contract

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/agent-permissions` | Read effective permissions and runtime availability |
| PATCH | `/api/v1/agent-permissions` | Replace one or more permission fields |
| GET | `/api/v1/workspace/files/preview` | Return a bounded preview descriptor |
| GET | `/api/v1/workspace/files/content` | Stream an inline-safe asset or attachment download |

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
and SOUL write tools follow independent switches.

Normal and per-character secret Workspace files are included in operational
backups. They are not returned by the JSON export and are not removed by the
application-data deletion endpoint, because they may be user-authored project
files. The secret Workspace root is a sibling of, never a child of, the normal
Workspace root.
