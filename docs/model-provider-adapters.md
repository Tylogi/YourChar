# Model Provider Adapters

## Scope

P4a introduces one deployment-trusted boundary between YourChar and model
transports. The product no longer constructs or calls an OpenAI-compatible
model directly from `CompanionKernel`, Task Bench, or model-quality evaluation
code.

```text
model profile
  -> ModelProviderRegistry (exact provider ID; no fallback)
     -> ModelProviderAdapter
        -> Pi ModelRuntime / native Provider
        -> provider-specific diagnostics
```

The built-in `openai_compatible` adapter preserves the existing request shape,
base-URL normalization, reasoning controls, model discovery, and connection
test. Additional adapters are executable host code supplied through
`CompanionKernelOptions.modelProviderAdapters`; adapter definitions are never
accepted over HTTP or restored from the model settings file.

## Adapter contract

Every adapter declares a stable lowercase ID and display label and implements:

- configuration readiness without performing network access;
- synchronous model construction for durable assistant-message metadata;
- synchronous or asynchronous registration into Pi's `ModelRuntime`;
- a canonical endpoint identity for cache invalidation;
- optional connection testing and model discovery.

Asynchronous registration lets a native adapter install a Pi `Provider` and
resolve its runtime authentication before returning the selected model. The
host continues to own persisted profiles and credentials; an adapter receives
only the selected profile for the operation.

Background model work uses a fresh in-memory Pi runtime per request. Interactive
sessions reuse their handle-owned runtime. Both paths resolve the exact same
adapter ID.

## Safety invariants

- IDs must match `^[a-z][a-z0-9_-]{0,63}$`; duplicate built-in or additional
  IDs fail Kernel construction.
- An unknown persisted ID remains visible but is unavailable. It never falls
  through to `openai_compatible` or another registered adapter.
- Selecting an unregistered ID through the Kernel/API is rejected before the
  profile is mutated.
- Public descriptors contain only ID, label, and diagnostic capability flags.
  They contain no base URL, model configuration, adapter object, or credential.
- Incognito children inherit only the parent's deployment-trusted adapter
  definitions; their state and Workspace isolation remain unchanged.
- Task Bench and feature-test sandboxes recreate explicitly injected adapters
  while copying the selected provider ID and complete model settings. They do
  not serialize executable adapter code into reports or state.

## Host surface

`GET /api/v1/model-providers` returns safe descriptors for the adapters loaded
by the current process. Existing model settings/profile endpoints now accept a
registered `provider` ID. The Web UI still presents the existing
OpenAI-compatible form in P4a; provider selection and provider-specific fields
belong to P4b.

## P4a boundary and follow-up

P4a proves the seam with Pi's native Provider registration in integration
tests, but ships only the existing OpenAI-compatible adapter as a first-party
production transport. P4b will add first-party native adapters and move the
remaining OpenAI-shaped payload policy behind provider-specific hooks. P4c will
replace inline profile secrets with credential references and rotation.
