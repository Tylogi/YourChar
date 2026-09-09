# Reminder delivery

Reminders separate the event time, notification time, and background draft time.
For a 15:00 event with a 15-minute notification lead and 10-minute preparation
lead, drafting starts around 14:35 and delivery is due at 14:45. An explicit
"remind me at 15:00" keeps a zero notification lead and delivers at 15:00.

## Schedule editor and notification center

The calendar view remains available. Timed user events and tasks can enable
"通知我"; new reminders enable it by default. The editor exposes importance,
advance notification, and channels, with a preview of the effective notification
time. All-day items and fictional character calendars do not create real reminders.

New reminders default to `channelMode=follow_settings`: UI plus every currently
bound IM provider whose **Settings → IM Channels → 接收日程提醒** switch is enabled.
WeChat and Feishu each have an independent persistent switch, enabled by default.
Importance does not select channels. The chat schedule tool does not accept
channel preferences, and ignores stale model-supplied channel fields. A user can
select `custom` in the schedule editor for an individual reminder, including
UI-only; custom external channels are still subject to the IM master switches.

Existing policies without `channelMode` retain their stored channels; policies
missing entirely retain legacy UI-only behavior. Editing such a reminder can
explicitly opt it into following IM settings. Migration never backfills delivered
reminders or silently changes prior channel choices. Preparation defaults to 10
minutes; the API also supports 1–30 minutes.

The header bell opens the notification center. It shows each channel separately,
with "知道了" and "稍后 10 分钟" actions. The page polls every five seconds and
briefly shows a toast for newly observed, unacknowledged reminders. Calendar list
entries offer retry for individual failed channels. This is not browser Web Push;
with the page closed, delivery is retained in the UI inbox for the next visit.

## Delivery and acknowledgement

- UI delivery is durable inbox availability, not proof that the user viewed it.
- WeChat/Feishu delivery is recorded only after a platform-send acknowledgement,
  not when an item merely enters the outgoing queue. It is not a read receipt.
- External targets come only from the currently bound owner's verified direct
  messages. Bind the channel, then send one owner DM before using reminders.
  Missing contacts and disconnected bindings remain visible as channel errors.
- Channels are selected when an occurrence first becomes due. Enabling a switch
  or binding a provider later does not backfill an already-triggered occurrence.
  Disabling a provider suppresses only its unsent reminders and revokes their
  outgoing leases immediately; UI, other providers, and ordinary chat replies
  are unaffected. Re-enabling does not replay suppressed reminders. Platform
  sends already in flight cannot be recalled; an acknowledged send is retained.
- Queued messages stay pinned to their original binding generation and direct
  conversation. Rebinding never retargets old reminders to a new recipient.
- The external reminder includes a short routing code. Reply `知道了 CODE` to
  acknowledge, or `稍后提醒 CODE 10` to snooze ten minutes. With exactly one matching
  outstanding reminder, the code can be omitted; otherwise it is required. The
  code is not authorization: owner/binding/direct-chat checks still apply.
- Acknowledgement is shared across channels and stops outstanding deliveries.
  Snoozing creates a new occurrence and retains the actual event time. Repeated
  snooze requests for the old occurrence cannot create extra reminders. A send
  already accepted by the platform cannot be recalled.

Each occurrence/channel has a durable unique outbox entry. Each channel retries
independently; successful channels are not resent when another fails. Failed
attempts are bounded (three automatic notification attempts; IM platform attempts
are separately bounded to three). Manual retry affects only that channel and is
rejected after acknowledgement, cancellation, or suppression. Existing IM leases,
stable message IDs, and persisted send receipts protect against duplicate sends
after restart; external networks do not provide an absolute exactly-once guarantee.

Optional `desktop` delivery uses the **server's** `notify-send`, not the user's
remote browser desktop. It requires `RP_AGENT_DESKTOP_NOTIFICATIONS=1`, a working
desktop session, and `notify-send`; otherwise that channel reports a failure.

## Preparation and privacy

At most two independent model draft requests run at a time. They receive the event
fields and a bounded character style excerpt, without chat history, tools, or a
foreground Pi turn. Drafts do not enter the chat transcript or memory. Only the
selected delivery message may subsequently be mirrored into its normal source
conversation as a system event, without interrupting an active turn.

The one-second scheduler never awaits model drafting. At notification time, an
unfinished or failed draft is replaced by a deterministic title/time/notes
message; a late model result cannot generate a second notification. Edits and
cancellation invalidate drafts and stop stale queued deliveries. Persisted ready
drafts survive restart; interrupted preparation can be retried before the deadline.

Private and incognito sources cannot create real outward reminders. Delivery has
an additional source-space check, and the UI inbox is cleared/disabled when moving
into a private or incognito space. Reminder delivery never guesses a recipient,
sends to a group, or automatically forwards private conversation context.

## Operational limits and migration

Quiet hours still defer delivery, including important reminders; importance does
not silently override an explicit quiet-hours policy. The server must be running:
event-loop load, suspension, process downtime, and platform outages can still
delay delivery. Overdue occurrences are handled on recovery; no extra repeated
"nag" escalation is enabled. External pending delivery does not depend on an
inbound chat model turn completing.

Schema 56 stores policies/revisions, event and acknowledgement timestamps,
background drafts, suppression state, and a separate notification lineage in the
IM outbox. Migration preserves prior inbound-reply rows and delivery receipts.
Take a verified state backup before upgrading a running installation. Do not run
an older application against the upgraded database without restoring a compatible
backup.

Schema 57 adds the two per-provider notification preferences to
`im_runtime_settings`. The existing local-control-plane protected
`PATCH /api/v1/im/settings` accepts partial boolean fields
`wechatRemindersEnabled` and `feishuRemindersEnabled`, independently of
`wechatTypingEnabled`. Database backups preserve them and full user-data reset
restores defaults. No model tool can edit these settings.

Verification covers virtual-clock timing, slow models, isolated real transport
drafting against a local fixture, cancellation, acknowledgement, snooze, migration,
missing contacts, retries, binding changes, DST recurrence, private-space fencing,
and mobile/desktop browser behavior. These tests do not send live IM messages.
