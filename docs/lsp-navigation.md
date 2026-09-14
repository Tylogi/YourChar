# Optional LSP Code Navigation

## Purpose

LSP navigation is an optional, deployment-trusted capability for coding tasks.
It adds one model-facing `lsp` tool with four read-only operations:

- `goToDefinition`
- `findReferences`
- `goToImplementation`
- `hover`

It does not replace `bash`, Workspace search, or file editing. The capability is
intentionally smaller than a general Code Mode SDK so its task benefit can be
measured before a larger code-orchestration surface is added.

## Admission and lifecycle

The tool is present only when all three gates pass:

1. A deployment registers the capability in a package marked `trusted: true`
   and selects that package through an active runtime profile.
2. The user enables the `mcp:lsp-navigation` module. It is disabled by default.
3. The current conversation has at least read-only Workspace access.

Incognito children never receive the capability. Each mounted Agent handle gets
fresh provider instances for exactly its normal or character-secret Workspace.
Handle invalidation, module/profile changes, conversation deletion, and runtime
shutdown close the providers in reverse mount order.

Capabilities must opt in separately before the Task Bench may recreate them.
The LSP capability does so because every provider is constructed from the fresh
benchmark mount scope; arbitrary deployment capabilities are not inherited.

## Provider boundary

`WorkspaceLspService` validates the provider registry before mounting it. IDs
and lowercase extensions are unique. Requests accept only an existing regular
UTF-8 Workspace file and a valid zero-based UTF-16 position. Model-facing
coordinates are converted from one-based values by the tool.

The service currently enforces these default limits:

| Boundary | Default |
| --- | ---: |
| Providers | 16 |
| Extensions per provider | 32 |
| Source path | 500 characters |
| Source snapshot | 2 MiB |
| Locations returned | 100 |
| Hover text returned | 16,000 characters |
| Query time | 15 seconds |
| JSON-RPC message | 4 MiB |

Every returned file URI must resolve below `file:///workspace/` (or the exact
owning host Workspace for an in-process provider). Escaped locations, malformed
ranges, unsupported files, and conflicting providers fail with stable `LSP_*`
error codes. Audits retain the operation, coordinates, provider, bounds, and a
path hash—not source text, hover bodies, or the raw path.

## Sandboxed stdio provider

`createStdioLspProviderDefinition` is a small LSP JSON-RPC client. It starts the
language server lazily with Bubblewrap and gives it:

- no network namespace;
- a read-only `/workspace` mount;
- an empty temporary home and `/tmp`;
- read-only `/usr`; and
- only explicitly reviewed extra files/directories mounted directly below
  `/opt/lsp`.

Commands and arguments are trusted deployment configuration. They never come
from module settings or model input. This example assumes `clangd` was installed
and reviewed by the deployment:

```ts
import {
  CompanionKernel,
  createLspNavigationCapabilityPackage,
  createStdioLspProviderDefinition,
} from "yourchar";

const clangd = createStdioLspProviderDefinition({
  id: "clangd",
  extensions: [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"],
  command: "/usr/bin/clangd",
  args: ["--background-index=false"],
  languageIds: {
    ".c": "c",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".h": "c",
    ".hpp": "cpp",
  },
});

const lspPackage = createLspNavigationCapabilityPackage({
  version: "1",
  // Digest of the deployment-reviewed capability/provider artifact.
  contentDigest: "<64 lowercase hexadecimal characters>",
  source: "internal deployment bundle",
  trusted: true,
  providers: [clangd],
});

const kernel = new CompanionKernel({
  agentCapabilityPackages: [lspPackage],
  agentRuntimeProfiles: [{
    id: "default",
    name: "Standard",
    description: "Built-ins only.",
    packageIds: [],
  }, {
    id: "code-navigation",
    name: "Code navigation",
    description: "Adds the reviewed LSP package.",
    packageIds: [lspPackage.id],
  }],
  activeAgentRuntimeProfileId: "code-navigation",
});
```

A Node-based language server can be exposed without revealing the rest of its
installation tree: bind the reviewed Node executable to `/opt/lsp/node`, bind
the reviewed server package directory to `/opt/lsp/server`, then use those
sandbox paths as `command` and `args`.

## Task Bench decision gate

Run two reports with the same model, fixtures, prompt, Judge, permissions,
timeouts, repetition count, and acceptance checks:

1. Baseline: keep `mcp:lsp-navigation` disabled; use ordinary search and bash.
2. Variant: enable `mcp:lsp-navigation`; change nothing else.

The report records the enabled module, `lsp_navigation` tool actions, latency,
model requests, token usage, pass rate, and Judge score. Use several repository
tasks that require cross-file definition/reference tracing; trivial single-file
edits do not provide a useful signal. Keep the blocking `bash` path regardless
of the result. A broader model-generated Code Mode SDK remains deferred until
this evidence shows a material improvement that the existing workflow DAG does
not already provide.
