# Background Thinking Policy

## Scope

Long hidden reasoning is disabled only for bounded classification calls whose
contract is strict JSON:

| Scenario | Current MLX ceiling | Unknown-provider fallback |
|---|---:|---:|
| group participation gate | 256 | 768 |
| daily memory extraction | 1,024 | 2,400 |
| relationship event extraction | 1,024 | 2,400 |

Character replies, private SMS/RP turns, group actor replies, subagents, and
vision analysis are outside this policy. Their output quality may depend on
reasoning or multimodal processing and must be evaluated separately.

## Compatibility

The current MLX model receives:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": false,
    "preserve_thinking": true
  }
}
```

An unknown OpenAI-compatible provider receives neither field. It keeps the
larger fallback budget because silently generated reasoning could otherwise
consume the entire response before the JSON answer appears. Provider Trace uses
the same payload transformer as the actual request, so Debug shows the effective
setting and ceiling.

## Evaluation

The read-only synthetic evaluation is:

```bash
npm run eval:background-classifiers -- --thinking=off
```

Use `--thinking=on --smoke` for a three-case baseline. On the configured
`gemma-4-26B-A4B-MLX-9bit` model, the enabled-thinking baseline used 1,786 output
tokens for compound memory, 1,146 for mutual relationship confirmation, and 159
for a direct group question. With thinking disabled, the corresponding calls
used 145, 72, and 10 tokens. The expanded nine-case no-thinking corpus passed 9/9,
including transient-memory rejection, ordinary relationship rejection,
daily support, a mutual relationship definition without a legacy trigger
keyword, affection without false dating promotion, and silence when another
character is addressed.

This corpus is a regression signal, not proof that every future model should use
the same transport-specific switch. Add explicit provider support and rerun the
corpus before reducing a new provider's fallback budget.
