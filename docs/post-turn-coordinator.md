# Post-turn Coordinator

## Purpose

The Post-turn Coordinator performs bounded asynchronous analysis after one
completed private turn. It replaces relationship-only orchestration without
giving one feature ownership of another feature's state.

This durable fallback currently runs only for normal-space conversations.
Private-space meetings keep their own scoped interaction state, but rely on the
foreground Interaction tool or the trusted UI controls to end a meeting; they
never enqueue relationship/post-turn analysis into the shared normal pipeline.

One analyzer call can currently produce three independent results:

- `relationship`: a constrained relationship event candidate;
- `interaction`: a co-presence departure decision;
- `world_attributes`: direction-only matches against owner-authored World
  attribute rules.

Memory extraction remains on its existing coordinator because its permission,
candidate lifecycle, and durable write policy are materially different.

## Turn flow

```text
main Agent reply
  -> commit pending main-Agent end_meeting transition
  -> persist completed context log
  -> enqueue Post-turn job
  -> one structured analyzer call
  -> RelationshipService validates/applies relationship result
  -> InteractionService validates/applies departure fallback
  -> WorldService validates evidence/rule snapshot and applies the fixed per-hit magnitude
```

The main Agent's `end_meeting` tool remains the fast path. Post-turn departure
is only a fallback for an omitted tool call. Entry into co-presence is never
handled post-turn because the current reply needs the correct narrative lens
before generation.

## Consumer isolation

Jobs persist their requested analysis consumers. The module switches are
evaluated both before and after the model call:

- disabling Relationship State suppresses only relationship application;
- disabling Interaction State suppresses only departure application;
- disabling World State suppresses only attribute-rule analysis;
- either consumer can run without the other;
- when several are active, they share the same model call.

World-attribute analysis is eligible only for completed normal SMS turns. The
analyzer returns an exact character/key, `increase|decrease`, exact visible
evidence, and confidence; it never returns a score or delta. The service
requires confidence `>= 0.70`, verifies the evidence against the completed
turn and any already-committed `perform_place_action` World event from that
turn, rejects changed definitions or memberships, applies the owner-configured
direction magnitude, and clamps the declared range. The configured increase
and decrease numbers are fixed steps, not maxima; the ledger distinguishes the
requested step from the smaller applied delta when a boundary is reached.
Character-specific definitions write at most one event per
character/key/source turn. World-shared definitions write at most one event per
world/key/source turn, so a multi-character World scene cannot apply the same
global change repeatedly. Secret and incognito conversations do not enqueue
this consumer. World narrative turns use the same trusted settlement service
after their visible character actions have been generated.

The compatibility table and endpoints retain their historical
`relationship_extraction_jobs` and `/relationship-coordinator` names. New code
uses `PostTurnCoordinator`, `/api/v1/post-turn-coordinator/status`, and
`/api/v1/post-turn-coordinator/jobs/{id}/retry`. The compatibility endpoints
return the same jobs during migration.

## Departure safety

Interaction fallback is eligible only when all of these are true:

- the conversation is canonical SMS;
- the turn started and finished in `co_present`;
- no main-Agent interaction transition changed the revision;
- Interaction State MCP remains enabled;
- the analyzer returns `decision=end` with confidence at least `0.90`;
- the reason is an explicit departure, mutual farewell, or character departure;
- exact evidence exists in the corresponding user and/or assistant text.

The job stores the expected interaction revision. Before applying the result,
`InteractionService` checks session, character, continuity, presence, pending
transition, and revision again. A delayed or retried result therefore cannot
end a later meeting.

Temporary movement, intent to return, future departure, negation, questions,
hypotheticals, and ambiguous farewells resolve to `keep` or `uncertain` and do
not mutate state.

## Durability and observability

Post-turn jobs reuse the existing durable queue, lease heartbeat, stale-owner
recovery, bounded retry, token estimate, and context-log idempotency key. Jobs
record requested consumers, separate relationship/interaction result counts,
and an aggregate result count that also includes accepted world-attribute
events. Applied fallback transitions use:

- source: `post_turn_coordinator`;
- evidence kind: `post_turn_analysis`;
- idempotency key: `post-turn:end-meeting:{contextLogId}`.

Model payloads appear in Debug Trace as `post_turn_analysis`.

## Calendar ownership while meeting

`co_present` changes only narrative presentation. It does not turn canonical
SMS into an RP sandbox and does not change schedule ownership:

- user reminders always use `calendar=user`;
- character plans use `calendar=character` and `kind=event|task`;
- character calendars never create real reminder notifications.

As a bounded repair for an incorrect model argument, canonical SMS converts
`calendar=character + kind=reminder` to the user calendar only when the latest
user text explicitly says `提醒我`, `叫我`, `通知我`, or `remind me`. Other
ambiguous ownership mistakes fail without creating a real notification.
