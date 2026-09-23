# Schedule tools and context size

The full calendar lives in SQLite. Ordinary conversation does not inject every
stored schedule item into the model context. Schedule tools return bounded
results so that a semester timetable can be managed without repeatedly echoing
all its records.

## Query pages and details

`list_schedule_items` accepts the existing `calendar`, `from`, `to`, `status`,
`kind`, and `query` filters plus `limit` (default 20, maximum 50) and `offset`
(default 0). Pagination runs in SQL. `from` is inclusive and `to` is exclusive;
use ISO timestamps with a timezone. Results are ordered by start time (creation
time for undated items), then ID.

The response contains `items`, `total`, `returned`, `offset`, `limit`, `hasMore`,
and, when another page exists, `nextOffset`. Preserve filters and use the returned
offset to continue. Long summaries can cause a page to contain fewer items than
the requested limit, keeping item JSON within approximately 20,000 characters.
Do not infer that a calendar is complete while `hasMore` is true. Pages describe
the live calendar; restart a traversal if items are inserted, rescheduled, or
removed between pages.

Titles, notes, and recurrence rules are previews; `truncatedFields` identifies
shortened fields. `get_schedule_item` reads one item in the requested calendar.
Its `field` selects `notes` (default), `title`, or `recurrenceRule`; `offset` and
`limit` select a text slice (default 2,000, maximum 4,000 UTF-16 code units).
Follow `nextOffset` to retrieve the rest of a long field. Calendar ownership is
checked for both listing and detail reads.

## Batch creation

`create_schedule_items` accepts one `calendar`, a stable `batchId`, and 1–50
`items`. Each entry uses the single-item creation fields except calendar and
world-place bindings. World activities that bind `placeId` and `capabilityId`
continue to use `create_schedule_item`.

The receipt returns `requested`, `created`, `existing`, `failed`, `conflictCount`,
`conflicts`, and `failures`. It does not return the complete saved items or their
notes. Conflicts and failures reference **1-based input indexes**. Each conflict
includes an item ID, one bounded warning, and the number of additional warnings;
query the relevant time interval to inspect other overlaps. Conflicts are
advisory and do not prevent creation. Failures include bounded title/time previews
and error messages so they remain identifiable after large tool arguments have
been compacted from active context.

Each valid entry commits independently. A semantic error in one entry leaves
earlier successes saved and allows later entries to proceed. Invalid tool input
shapes or an oversized batch are rejected before any writes. Correct failed
entries and submit those entries with a new batch ID. To replay an uncertain
request, reuse the same batch ID and unchanged entries: persisted, scoped
idempotency keys prevent duplicate records and reminders, including after a
restart. Reusing a saved batch/index with different contents is rejected. A
replay checks existing items for current time conflicts as well.

Creation still follows existing reminder-channel settings, audit recording,
calendar ownership, and RP real-world confirmation rules. A batch with saved
entries is a completed side effect even if its final conversational reply fails.

For a finite semester, use dated entries in successive batches. Existing
recurrence support is limited to DAILY/WEEKLY with optional INTERVAL; it does
not implement semester cutoffs or holiday exceptions, and list filters do not
expand recurrence occurrences. Original user uploads and generated tool
arguments still consume context; batching bounds each operation and its receipt,
not the size of an arbitrarily large original message.
