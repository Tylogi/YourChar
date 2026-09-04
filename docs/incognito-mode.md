# Incognito conversation mode

Incognito mode is a disposable test overlay for one selected character. It is
separate from both the normal conversation and the durable per-character
private partition.

On entry, YourChar freezes a snapshot of the character's current normal-space
conversation and supporting state, including the current SOUL, relationship,
confirmed memories, enabled normal Skills, model profile, and meeting state.
The snapshot does not continue following later normal-space changes. All turns,
meeting transitions, context logs, model traces, and other writes made inside
the incognito session target only the disposable overlay.

The overlay runs in a private `tmpfs` directory and is never published into the
normal state directory, private state directory, exports, backups, unread
queues, or IM channels. Leaving incognito mode disposes the child runtime and
removes the overlay. A process restart also invalidates its synthetic session
identifier. If a verified memory-backed filesystem is unavailable, YourChar
fails closed instead of silently placing an incognito snapshot on persistent
storage.

If an incognito conversation itself reaches a successful conversation-sleep
checkpoint, its child runtime may append the separate in-character wake message
to that disposable transcript. The pending identifier, hidden idempotency
marker, child-local unread state, traces, and actions remain inside the tmpfs
overlay; they never update the source normal conversation or its unread list.
An inherited pending wake job from the frozen normal snapshot is not replayed
inside the child. Closing the overlay cancels any unfinished child wake job and
discards both its delivery state and any delivered wake message.

Incognito wake delivery is in-app only. It does not use world proactive-message
policy and cannot send through reminders, desktop notifications, Feishu,
WeChat, or another IM channel. A user turn that reaches the child before its
background wake message cancels that pending outreach and performs the normal
in-turn waking transition instead, preventing duplicate wake replies.

Incognito mode deliberately disables persistent or externally observable Agent
capabilities such as schedules, reminders, world automation, character
collaboration, IM delivery, Skill installation, subagents, shell, Workspace
attachments, web/search/vision tools, profile and SOUL writes, and memory
proposals. Local Workspace read/write/edit and network-isolated MarkItDown
document conversion remain inside the tmpfs overlay. Meeting interaction
remains available because its database and
event history are part of the disposable child runtime. The normal source
conversation is never advanced by an incognito turn. The incognito child has no
Shell of its own, but opening or closing the overlay does not override the
user's Shell-network permission for ordinary Agent conversations.

“Incognito” means **YourChar does not retain the overlay locally after it is
closed**. It is not an end-to-end no-retention guarantee. The configured model
provider receives the prompt and inherited context required to generate a
reply and may retain requests according to its own policy. Operating-system
administrators, process-memory inspection, crash dumps, and host swap are also
outside this application-level boundary. For the strongest practical privacy,
use a local model and an operating system configured without persistent swap or
core dumps.

Private mode should be used when isolated content must survive restart.
Incognito mode should be used to test a hypothetical interaction against the
current normal relationship and memory without committing the result.
