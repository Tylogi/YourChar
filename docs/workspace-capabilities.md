# Agent Workspace and Privileged Capabilities

## 1. Security boundary

The Agent never receives Pi's unrestricted built-in coding tools. RP Agent
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

## 2. Permission model

| Permission | Default | Effect |
|---|---|---|
| Workspace access | Off | `off`, `read_only`, or `read_write` |
| Sandboxed shell | Off | Registers `bash` using Bubblewrap |
| Shell network | Off | Shares the host network namespace only for sandbox commands |
| User Profile auto-edit | On | Registers `update_user_profile` while User Profile MCP is enabled |
| Character SOUL auto-edit | Off | Registers the character-bound SOUL MCP in RP sessions |

Workspace access and shell execution are intentionally independent. A shell may
run with an empty transient `/workspace`, a read-only workspace bind, or a
read-write workspace bind. Disabling shell automatically disables shell network.
Enabling network while shell is disabled is rejected.

Permission overrides use reserved `permission:*` rows in
`agent_module_settings`. They are separate from MCP and Skill module switches so
module discovery remains stable.

## 3. File tools

The following tools are assembled from the current workspace access level:

| Tool | Off | Read only | Read-write |
|---|---:|---:|---:|
| `read` | No | Yes | Yes |
| `list_workspace` | No | Yes | Yes |
| `write` | No | No | Yes |
| `edit` | No | No | Yes |

`read` also remains available for enabled Skill directories even when workspace
access is off. Skill roots are always read-only.

All paths supplied to workspace tools must be relative. The implementation
resolves real paths, rejects symlink and parent-directory escapes, accepts text
files only, and limits each file to 1 MiB. `write` uses an atomic replacement.
`edit` performs exact replacement and rejects ambiguous matches unless
`replaceAll` is explicit. File mutations emit audit actions without storing file
contents.

## 4. Shell sandbox

Linux shell execution requires `/usr/bin/bwrap`. The sandbox:

- starts with a new process, IPC, PID, UTS, cgroup, and network namespace;
- exposes `/usr` read-only plus minimal `/proc`, `/dev`, and temporary storage;
- mounts only the dedicated workspace at `/workspace` according to its access
  level;
- does not mount `/home`, the application repository, state root, User Profile,
  SOUL.md files, model credentials, or the host environment;
- clears environment variables and supplies only `PATH`, `HOME`, and `LANG`;
- keeps network isolated unless the separate network switch is enabled;
- limits runtime to 120 seconds and captured output to 64 KiB;
- records a command hash and length, exit status, duration, timeout, truncation,
  and network mode in the action audit without retaining command text.

This boundary controls host filesystem and network access. It does not make
untrusted code harmless to files in a read-write workspace. Enable shell and
network only for tasks that need them.

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

Workspace files are included in operational backups. They are not returned by
the JSON export and are not removed by the application-data deletion endpoint,
because they may be user-authored project files.
