# Daily Conversation Memory Capture

## Audit result

The pre-change local database contained 119 post-turn memory jobs:

- 118 were skipped as `no_durable_signal`;
- one reached the extractor and failed with `memory extractor returned invalid JSON`;
- zero jobs produced a memory candidate.

Three independent conditions caused the observed behavior:

1. The local gate recognized only a small phrase list such as `my project` and
   `I like`, so routines, food restrictions, people, and communication
   preferences were skipped.
2. The configured reasoning model spent the complete 800-token output budget on
   hidden reasoning and returned no JSON.
3. Implicit extractor output was always pending, while User Profile projection
   only includes confirmed active reality memory.

A fourth issue appeared after capture was repaired: retrieval was lexical, so a
query such as `routine and dietary restrictions` did not match source quotes
about waking at seven and not eating coriander.

## Capture policy

The Coordinator now separates direct Agent proposals from trusted daily capture:

- `propose_memory` remains pending and can never confirm itself;
- automatic observation runs only in completed SMS/reality turns while Memory
  Coordinator is enabled; disabling Reality Memory Write keeps the observation
  in `write_disabled` state instead of silently losing it;
- every auto-captured item requires confidence of at least 0.88 and an exact
  user-message quote;
- the stored content is the verified quote, not a model paraphrase;
- secrets, credentials, identity numbers, financial, health, contact, and exact
  address data remain pending and are not projected into User Profile;
- low-risk accepted facts first become schema-24 User Insight observations, then
  use trusted-control-plane provenance and project into the managed profile atomically;
- deterministic semantic tags such as routine, dietary restriction, and reply
  preference improve synonym retrieval across sessions;
- a stable model key or deterministic fallback prevents exact repeated facts
  from creating duplicate active records.
- `person` candidates may include schema-validated name, aliases, and the
  user's stated relationship. Names and aliases are accepted as directory
  metadata only when they occur in the user message; the exact quote remains
  the canonical fact. Confirmed records automatically update the editable
  `reality/people/` Markdown directory.

The gate now keeps the specific Chinese/English durable patterns and also sends
substantive first-person self-disclosures to semantic extraction. Short
acknowledgements, transient mood, weather, and one-off activity examples remain
excluded.

## Model compatibility

For the current MLX model, the extractor explicitly disables chat-template
thinking and uses a 1,024-token output ceiling. Providers whose thinking-control
contract is unknown receive no vendor-specific field and retain the conservative
2,400-token fallback ceiling.

The parser accepts one strict JSON object and a bounded sequence of strict JSON
objects, including objects split across or concatenated within code fences.
This handles models that emit one valid candidate object per fact; every merged
candidate still passes the same strict schema, eight-candidate limit, and realm
checks.

Memory extraction requests are recorded as `memory_extraction` Provider Traces.
They remain background jobs during ordinary turns. A turn that is about to create
a context checkpoint drains accepted Memory and Post-turn work before compaction.

## Effectiveness tests

`test/memory-daily-effectiveness.test.ts` verifies:

- seven durable daily expressions pass the gate and four transient examples do
  not;
- low-risk exact-quote facts become confirmed active memory and managed profile;
- sensitive content remains pending and absent from provider context;
- a new session retrieves routines and food restrictions through semantic tags;
- fenced and split-fenced model JSON is parsed safely.

The configured-model evaluation is read-only and uses synthetic text:

```bash
npm run eval:memory-daily
```

The current `gemma-4-26B-A4B-MLX-9bit` profile passed all four corpus groups:
compound routine/preference/project, person, goal, and transient-negative. The
run checks type coverage, exact evidence, confidence, negative precision, stop
reason, and output token usage without mutating the real profile or Vault.
