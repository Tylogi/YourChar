# ACP bridge

Status: optional P4e adapter implemented against ACP 1.4.0

## Decision

ACP passes the milestone's conditional value test. DeepSeek Harness has an
out-of-process ACP subagent provider that starts a child process, negotiates the
protocol, creates one session, streams its prompt result, and sends
`session/cancel`. Its current package pins `@agentclientprotocol/sdk` 1.4.0.
That makes an ACP process a directly consumable YourChar host adapter rather
than another internal abstraction.

Primary references:

- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [DeepSeek Harness ACP subagent](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-acp)
- [DeepSeek Harness ACP design note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-07-23-acp-automation-only-protocol.md)

The bridge is intentionally not a new runtime or source of truth:

```text
ACP client / DeepSeek Harness
  -> newline-delimited JSON-RPC over child stdio
  -> YourChar ACP bridge
  -> typed YourCharClient
  -> authenticated loopback /api/headless/v1
  -> existing router and Kernel policy
```

It imports the public SDK, not the Kernel, stores no database state, and cannot
change permissions, model credentials, runtime profiles, or Workspace roots.

## Run it

Start YourChar with the headless API enabled, then launch one bridge process for
one ACP session:

```bash
export YOURCHAR_HEADLESS_API_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
export YOURCHAR_ACP_CHARACTER_ID="character-id"
export YOURCHAR_ACP_CWD="/absolute/admitted/workspace"
export YOURCHAR_BASE_URL="http://127.0.0.1:8765"

npm run dev
# In a second shell with the same deployment-owned variables:
npm run build
npm run --silent acp
```

`yourchar-acp` is also installed as a package binary. Standard output is
reserved for ACP JSON-RPC; diagnostics use standard error. Use npm's `--silent`
flag when invoking the package script so npm's own banner does not corrupt the
stdio protocol.

The bridge accepts these settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `YOURCHAR_HEADLESS_API_TOKEN` | none | Required headless API Bearer token |
| `YOURCHAR_ACP_CHARACTER_ID` | none | Required character whose canonical direct conversation owns the turn |
| `YOURCHAR_BASE_URL` | `http://127.0.0.1:8765` | Loopback-only YourChar origin |
| `YOURCHAR_ACP_CWD` | bridge process cwd | Exact cwd admitted in `session/new` |
| `YOURCHAR_ACP_CONVERSATION_SPACE` | `normal` | Frozen `normal` or `secret` conversation space |
| `YOURCHAR_ACP_TIMEZONE` | omitted | Optional timezone forwarded with each turn |

The legacy `RP_AGENT_HEADLESS_API_TOKEN` alias remains accepted at lower
precedence. A DeepSeek Harness deployment supplies the compiled binary as its
ACP child command, uses the admitted directory as both process cwd and ACP cwd,
and explicitly forwards the variables above through the provider's scrubbed
`env` configuration.

## Capability mapping

| ACP operation or value | YourChar mapping |
| --- | --- |
| `initialize` | Authenticated SDK health check; advertises only baseline text/resource-link prompts |
| `session/new` | Opens or restores the configured character's canonical SMS conversation |
| `session/prompt` text | One bounded SDK streaming turn in the frozen character and privacy scope |
| Resource link | Bounded literal name and URI in user text; never fetched by the adapter |
| Assistant chunk | `agent_message_chunk` with one stable message ID per turn |
| Tool start/end | ACP tool lifecycle metadata; raw arguments and results are omitted |
| `session/cancel` | Aborts the streaming transport and calls the explicit SDK cancel endpoint |
| ACP cwd | Exact admission check only; it does not replace the server-owned Workspace |

ACP-provided MCP servers and additional directories are rejected. Image,
audio, and embedded-resource prompts are rejected because those capabilities
are not advertised. Permissions stay in the existing YourChar host policy; the
bridge never asks the ACP client to approve or execute a tool. Prompts are
limited to 32,000 Unicode characters and 32 resource links.

One process accepts one ACP session and one in-flight prompt. This matches the
fresh-process lifecycle used by the DeepSeek Harness subagent provider and
prevents two nominal ACP sessions from silently sharing the same canonical
YourChar conversation. The conversation itself remains durable by product
design; closing the child transport does not delete or archive it.

## Interoperability verification

`test/acp-bridge.test.ts` spawns the compiled stdio binary and drives it with
the official ACP 1.4.0 client using the same request sequence as DeepSeek
Harness. It verifies initialization, rejected capability widening, streamed
assistant output, one-session fencing, unsupported media rejection, and a
prompt that settles as `cancelled` after `session/cancel`.
