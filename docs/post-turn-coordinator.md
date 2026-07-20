# Post-turn Coordinator

## Purpose

The Post-turn Coordinator performs bounded asynchronous analysis after one
completed private turn. It replaces relationship-only orchestration without
giving one feature ownership of another feature's state.

One analyzer call can currently produce two independent results:

- `relationship`: a constrained relationship event candidate;
- `interaction`: a co-presence departure decision.

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
- either consumer can run without the other;
- when both are active, they share the same model call.

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
record requested consumers and separate relationship/interaction result
counts. Applied fallback transitions use:

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
