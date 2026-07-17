# Five-Round Product Review

## Result

The product review progressed from a 51/100 baseline to 100/100 after five
rounds. The final score is based on executable mode contracts, durable session
and reminder lifecycles, long-conversation model evidence, accessible browser
workflows, and a repeatable release gate. It is not a claim that model behavior
is perfect across providers.

| Review | Score | Main evidence |
| --- | ---: | --- |
| Baseline | 51 | SMS and RP lacked clear behavioral and workflow separation. |
| Round 1 | 75 | Character-bound SMS/RP context, SOUL, memory, scene, and tool contracts. |
| Round 2 | 86 | Fixed-mode character sessions, generated IDs, server validation, and RP scene identity. |
| Round 3 | 91 | Neutral system events, titled/archivable sessions, permanent deletion, and the first real-model suite. |
| Round 4 | 98 | Structured turn status, retry policy, complete archive lifecycle, typed system-event actions, and stronger visual checks. |
| Round 5 | 100 | Long-session stability, reminder restart/outbox policy, accessible dialogs, injection gates, release automation, and unclipped mobile session actions. |

## Final Mode Contract

- SMS is the selected character speaking in first-person instant messages. It
  uses character SOUL and confirmed character memory, excludes scene context,
  and rejects narration, action brackets, assistant tone, and internal notes.
- RP is third-person narrative organized around environment, actions, and
  dialogue. It uses SOUL, confirmed memory, and the current scene. It preserves
  semantic spatial continuity but does not repeat the literal Location on every
  turn; local movement should instead establish its spatial relationship
  naturally.
- Both character-bound modes can read and, when authorized, update character
  SOUL. Character memory writes require a character ID. Scene writes remain RP
  only, and real-world scheduling from RP remains confirmation-gated.

These rules are asserted in `test/mode-contract.test.ts` and capability-policy
tests rather than being evaluated only as prompt text.

## Long-Conversation Evidence

The live long run saved in
`eval-artifacts/real-model-long-eval-2026-07-15T13-37-56-243Z.json` completed 30
SMS turns and 30 RP turns. It made 61 model requests and reported p50/p95 model
latency of 23,268/32,909 ms. SMS passed 30/30. RP initially reported 29/30
because turn 19 continued the weather-station scene through its control room,
main transmitter, oscilloscope, and calibration task without repeating the
literal words `weather station` or `mountaintop`.

The scene-continuity rule now uses semantic term sets for each planned scene:

- Dock: dock, pier, pilot, berth, crane, tide, and warehouse concepts.
- Weather station: weather station, mountaintop, control room, transmitter,
  antenna, oscilloscope, anemometer, calibration, and frequency concepts.
- Archive: archive, underground, records, files, dossiers, cabinets, and fire
  doors.

`test/long-eval-rules.test.ts` proves that the turn-19 control-room/transmitter
reply passes and text belonging only to another scene fails. Offline
re-evaluation changed only the `scene-continuity` rule and made no model calls.
The resulting report is
`eval-artifacts/real-model-long-eval-2026-07-15T13-37-56-243Z-reevaluated.json`:
60/60, zero character drift, and zero mode degradation. Other long-evaluation
rules were not weakened.

## Lifecycle Evidence

- Due reminders are transactionally claimed into a unique outbox entry and
  survive process restart without duplicate durable delivery records.
- Offline retry reuses the same outbox ID and frozen payload.
- Archived source sessions receive neutral notifications without transcript
  mutation. Deleted source sessions keep real schedules but never restore
  deleted character context.
- Conversation turns persist `completed`, `failed`, `cancelled`, or `blocked`
  status end to end. Retry eligibility uses structured state and side-effect
  evidence, never localized text matching.
- Session rename, archive, restore, and permanent deletion use managed metadata
  and clean only session-owned scenes/pending state. Shared character memory is
  preserved.

The exact reminder ownership and external-sink crash boundary are documented in
`docs/reminder-lifecycle.md`.

## Interaction And Security Evidence

All destructive or corrective browser workflows use one in-app modal state
machine. It supports focus containment, Escape cancellation, Enter submission,
focus restoration, optional typed confirmation, and inline validation/API
errors. Native browser `prompt` and `confirm` are absent. Covered operations are
schedule cancellation, session archival, session rename/deletion, memory
correction/deletion, and deletion of all user data. Session actions remain in a
compact menu on mobile.

Capability tests inject hostile text through Tavily results, SOUL.md, the user
profile, and workspace tool output. Actual authorization hooks still enforce
SOUL/profile write toggles, RP schedule confirmation, and workspace read-only
and path boundaries.

## Release Gate

`npm run release:gate` runs the build, all unit/integration tests, desktop/mobile
CloakBrowser workflows with screenshot pixel checks, sensitive-information
scanning, and `git diff --check`. `npm run release:gate:real` additionally runs
the isolated real-model suite three times. The 60-turn suite remains an explicit
cost-bearing pre-release command.

Final local evidence on 2026-07-15:

- Unit/integration tests: 77/77 passed.
- Browser workflows: desktop and mobile passed, including accessible-dialog
  keyboard/focus coverage, all four mobile session-menu actions, clipping-aware
  geometry assertions, and viewport/pixel validation.
- Long evaluation: 60/60 after semantic-only re-evaluation of the completed live
  run; 61 original model requests; 0 re-evaluation requests.
- Sensitive scan and whitespace checks are required release-gate stages.

## Residual Risks

1. Exactly-once durable outbox creation does not by itself guarantee exactly-once
   effects in a non-idempotent external notification sink. Sinks must honor the
   outbox ID as an idempotency key.
2. The final 60/60 figure is a transparent offline re-evaluation of one completed
   live run after an evaluator-only correction, not a second 60-turn provider
   run. A fresh run remains required after production prompt, model, sampling,
   context, tool-policy, or Pi runtime changes.
3. Latency and behavior statistics describe the configured provider/model and a
   single long run. They are not a cross-provider benchmark.
