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

P4b still uses the existing profile API-key storage behavior. Moving secrets
to opaque host-owned references, including migration and rotation, is the P4c
scope.

## Host surface

`GET /api/v1/model-providers` returns safe adapter descriptors, including
configuration fields and connection-test/model-discovery capability flags.
Existing settings/profile endpoints accept a registered `provider` ID. The Web
UI renders a provider selector and exposes only fields declared by that
provider. Native catalogs can be discovered without a network request;
connection tests make a short real provider request and therefore require a
valid credential source.

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
  dist/test/model-provider-adapters.test.js \
  dist/test/native-model-providers.test.js
```
