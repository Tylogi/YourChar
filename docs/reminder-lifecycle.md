# Reminder Lifecycle Policy

## Ownership

A real schedule item is user-owned durable state. `sourceSessionId` records where
the request originated, but deleting or archiving that conversation does not
delete the schedule item or its occurrences.

## Claiming and delivery

1. A due occurrence is claimed in the same SQLite transaction that creates its
   outbox row and changes the occurrence to `processing`.
2. `(occurrence_id, channel)` is unique, so repeated ticks and process restarts
   reuse one outbox entry.
3. The composed title and body are frozen in the outbox before sink delivery.
   Retries reuse that payload and the same `outboxId`.
4. A successful delivery marks the outbox and occurrence delivered in one
   transaction. Recurring reminders create their next occurrence there.
5. A rejected delivery remains pending with bounded backoff. After three failed
   attempts it becomes failed and can be manually retried without a second
   outbox entry.

Notification sinks must treat `outboxId` as their idempotency key. SQLite can
guarantee one durable outbox record, but a non-idempotent external sink still has
an unavoidable crash window after accepting a notification and before the local
delivered transaction commits.

## Source-session policy

- **Active source:** when its model is configured, the scheduler resumes the Pi
  context and stores the model-authored reminder as a role assistant message.
- **Archived source:** the scheduler does not open the Pi session, call the
  model, or append transcript messages. It emits the neutral system notification
  `提醒时间到了：<title>` (or the schedule notes) with `agentGenerated=false`.
- **Deleted or missing source:** the real schedule remains. Delivery uses the
  same neutral fallback and never recreates conversation metadata or transcript.
- **No source:** delivery is neutral by definition.

This separates user-owned real-world schedules from role-owned conversation
state and prevents an archived or deleted persona from speaking unexpectedly.
