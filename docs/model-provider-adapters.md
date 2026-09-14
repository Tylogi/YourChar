# Model Provider Adapters

## Scope

P4a introduced one deployment-trusted model transport boundary. P4b extends
that boundary with first-party native providers, declarative settings, and
provider-owned request policy. Product code selects an exact adapter ID and
does not assume that every provider speaks OpenAI Chat Completions.

```text
model profile
  -> ModelProviderRegistry (exact provider ID; no fallback)
     -> configuration validation and request policy
     -> ModelProviderAdapter
        -> Pi ModelRuntime / native Provider
        -> provider payload transform
        -> optional meeting-preset message view
        -> provider payload finalization
        -> provider transport
```

The built-in providers are:

| Adapter ID | Transport | Intended use |
| --- | --- | --- |
| `openai_compatible` | OpenAI Chat Completions | Local models and compatible services such as MLX, vLLM, SGLang, llama.cpp, and gateways |
| `anthropic` | Anthropic Messages | Anthropic models from Pi's bundled native catalog |
| `google` | Google Generative AI | Gemini models from Pi's bundled native catalog |
| `openai` | OpenAI Responses | OpenAI models from Pi's bundled native catalog |

Native adapters intentionally use their official Pi transports and pinned
catalog metadata. `openai_compatible` remains the configurable escape hatch for
custom base URLs and model IDs.

## Adapter contract

Every adapter declares a stable lowercase ID, display label, description, and
configuration schema. The schema is host-validated and contains only known
field keys and safe presentation metadata. It drives the provider selector,
field visibility, custom-model behavior, and diagnostic controls in the Web UI.

An adapter owns:

- configuration validation and readiness without network access;
- synchronous model construction for durable assistant-message metadata;
- synchronous or asynchronous registration into Pi's `ModelRuntime`;
- endpoint identity for cache invalidation;
- interactive thinking policy and provider-specific payload controls;
- timeout and retry defaults;
- optional connection testing and model discovery;
- final conversion from the temporary preset view back to the native wire
  payload.

Profiles may be saved while incomplete so a user can select a provider before
choosing a model. Invalid supplied values are rejected atomically. Execution
requires a complete, enabled configuration. Native model IDs, image support,
maximum output, and context-window overrides are checked against the bundled
Pi catalog.

## Request behavior

Interactive sessions reuse their handle-owned runtime. Background calls use a
fresh in-memory runtime. Both resolve the same adapter and follow the same
provider pipeline. First-party defaults are a 300-second request timeout, two
retries, and a 60-second maximum retry delay; explicit request options take
precedence. Subagents retain their existing unbounded HTTP-idle design while
using the selected provider's retry limits.

The native Pi implementations own streaming, tool-call conversion, prompt or
reasoning continuity, and usage accounting. Adapter hooks apply only controls
valid for each wire protocol—for example Anthropic `thinking`, Gemini
`thinkingConfig`, OpenAI Responses `reasoning` and `max_output_tokens`, or Chat
Completions `reasoning_effort` and `max_tokens`.

## Meeting-preset normalization

Meeting presets operate on a bounded, temporary `messages` view. Anthropic
already exposes messages, while the Google adapter maps `contents` and the
OpenAI adapter maps Responses `input` into that view. Original function calls
and results carry process-local opaque references through orchestration. The
adapter then restores the native shape and removes the temporary metadata
before the HTTP request is serialized.

This keeps preset orchestration provider-neutral without rewriting native tool
items or leaking internal symbols onto the wire. Injected system material is
restored as Anthropic system blocks, Gemini `systemInstruction`, or Responses
message input as appropriate.

## Safety invariants

- IDs must match `^[a-z][a-z0-9_-]{0,63}$`; duplicate built-in or additional
  IDs fail Kernel construction.
- An unknown persisted ID remains visible but unavailable. It never falls
  through to another adapter.
- Selecting an unregistered ID or supplying an invalid provider value is
  rejected before the profile is mutated.
- Public descriptors contain only presentation schema and capability flags;
  they contain no adapter object, endpoint value, selected model, or
  credential.
- Adapter definitions are executable, deployment-trusted host code. They are
  never accepted over HTTP or restored from model settings.
- Incognito children, Task Bench, and feature-test kernels inherit explicitly
  injected definitions without serializing them into state or reports.

P4c separates model settings from model secrets. `model-api.json` now stores
only an opaque `credentialRef`; the mode-`0600` host-owned
`model-credentials.json` stores the current and one rollback version. Startup
migrates legacy inline keys by durably writing the credential first and then
atomically rewriting the profile document. A missing, revoked, malformed, or
wrong-profile reference fails closed and never falls through to a native
provider's environment credential.

Credential creation and rotation use a revision compare-and-swap guard. The
dedicated write endpoint verifies a candidate against the selected provider
before committing, so a failed check leaves the last-known-good key active.
Rotation retains one rollback version; revoke removes the active secret from
resolution while retaining a rollback version. Public settings expose only the
opaque reference, status, masked active value, revision, and rollback
availability.

## Host surface

`GET /api/v1/model-providers` returns safe adapter descriptors, including
configuration fields and connection-test/model-discovery capability flags.
Existing settings/profile endpoints accept a registered `provider` ID. The Web
UI renders a provider selector and exposes only fields declared by that
provider. Native catalogs can be discovered without a network request;
connection tests make a short real provider request and therefore require a
valid credential source.

The credential lifecycle surface is:

```text
PUT  /api/v1/model-profiles/{id}/credential
POST /api/v1/model-profiles/{id}/credential/revoke
POST /api/v1/model-profiles/{id}/credential/rollback
```

Writes require `expectedRevision` (`0` for first creation). `PUT` accepts a
write-only `apiKey`, an optional structural `profilePatch`, and `verify`
(default true). These browser control-plane mutations require the same-origin
HttpOnly capability cookie; responses never echo the key. Legacy profile PATCH
calls remain compatible, but the Web UI uses the verified lifecycle endpoint.

Normal, secret, and background calls resolve the selected profile at request
time. Incognito snapshots copy only `model-api.json` and receive a
profile-owner-scoped resolver from the parent; `model-credentials.json` is not
copied into tmpfs. Task Bench and feature-test kernels install only the selected
safe profile and receive a resolver restricted to that same profile ID.

## Compatibility evidence

The P4b integration suite sends the same deterministic `gpt-4o` task through
the native OpenAI Responses adapter and `openai_compatible` Chat Completions
adapter. Mocked streaming responses verify identical completion text and usage
outcomes while asserting each transport's distinct serialized payload. This is
a protocol compatibility check, not a quality or performance benchmark and not
a live-provider claim.

Run the focused coverage with:

```bash
npm run build
node --disable-warning=ExperimentalWarning --test \
  dist/test/http-ui.test.js \
  dist/test/model-credentials.test.js \
  dist/test/model-provider-adapters.test.js \
  dist/test/native-model-providers.test.js
```
