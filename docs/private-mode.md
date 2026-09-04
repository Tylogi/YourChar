# Per-character private mode

Private mode is an application-level conversation partition for one selected
character. Each character has one canonical normal direct conversation and one
canonical private conversation. Closing the lock removes private content from
normal session lists, transcripts, inboxes, memory queries, diagnostics,
exports, Workspace routes, and Skill reads.

The private partition covers:

- direct-chat history, unread state, queued messages, context logs, model
  traces, and token economics;
- durable and resident memories, extraction jobs, retrieval statistics, FTS,
  and Vault Markdown under `secret/characters/<character>/memories/`;
- a per-character Workspace outside the normal Workspace root, including main
  Agent tools, subagents, attachments, previews, downloads, and Vision caches;
- the character workbench `SKILL.md` version chain; and
- generic Agent Skill availability. A Skill can be off, normal-only,
  private-only, or available in both spaces. Its source body is hidden in a
  space where it is unavailable.

Generic Skill names, descriptions, source paths, enabled-space labels, and
content-free installation audit metadata are global Management configuration
and remain visible while the lock is closed. The package body and readable
resources are the isolated content boundary; audits retain only bounded
provenance such as source host, immutable ref, digest, counts, and status.

Private chat fails closed for shared context that could mix the two spaces.
User Profile, schedules and reminders, worlds, relationship state, scenes,
character collaboration, proactive world messages, meeting presets, and SOUL
writes are not available to the private Agent. Meeting interaction itself is
available as a private, per-character state machine: it accepts only a
human-readable private location, never reads a normal World place, and never
projects the private meeting into normal World or Scene state. Character
identity, SOUL, model selection, system prompts, module permissions, and the
role's responsibility/capability profile remain shared configuration. Shared
responsibility/capability fields are read-only while private mode is open; the
private workbench Skill itself has an independent version history.

Private mode remains durable and isolated. It is distinct from incognito mode:
private transcripts, memories, Workspace files, Skills, interaction state, and
observability survive restart inside the private partition. Incognito mode
instead starts from a frozen normal-space snapshot and discards its temporary
overlay when the user leaves it or YourChar restarts.

A successful conversation-sleep checkpoint also keeps its wake lifecycle
inside the exact private partition. The pending wake-notification identifier,
composition trace, action record, assistant message, hidden idempotency marker,
and unread state are all scoped to that character's `secret` conversation.
Nothing is copied into the character's normal transcript or normal unread
list. A restart resumes the pending private job in the same partition, and a
marker already written to the private transcript prevents a second visible
message or a second unread increment.

This wake message is an in-app conversation-lifecycle delivery. It does not use
the world's proactive-message policy, cooldown, daily limit, quiet hours, or
topic preferences, and it does not require proactive world messages to be
enabled. It is never forwarded through reminders, desktop notifications,
Feishu, WeChat, or another IM channel. If the user sends a private message
before the background wake is delivered, that private turn wakes the character
and cancels the queued message so the user does not receive two wake replies.

Private mode is not disk encryption, a password vault, an operating-system user
boundary, HTTP authentication, or end-to-end encryption. A local process or
user that can read YourChar's state directory can read both spaces. The HTTP
service therefore binds only to loopback. The configured model provider
receives the private turn and the private context needed to answer it.

Sandboxed Shell network follows the user's explicit global permission in both
normal and private conversations. Creating private data, opening private mode,
or loading a private-only Skill does not turn it off. With network enabled, a
private character may use arbitrary network commands and may transmit any
private conversation, memory, Skill guidance, or private Workspace content it
can currently see. The filesystem mount remains scoped to that character's
private Workspace, but private mode is not an outbound confidentiality
guarantee. Tavily, Web Reader, Vision, and the model provider remain separate
host-side clients with their own configuration boundaries.

Skill installation and Shell networking are independent permissions. A
secret-space Agent has no remote-install tool; host-side private installation
through the Management UI remains a separate, reviewed control-plane operation.
Packages already installed for the same character and secret space can still be
inspected, enabled, or disabled, and local owned workflows can be created or
revised when the user has enabled Skill autonomy. If Shell network is also
enabled, those loaded instructions may guide the character's network use under
the authority the user already accepted.

Operational backups include the database, private transcripts, private Vault
documents, `workspace-secret`, and host-installed Agent Skill packages.
YourChar does not encrypt backup payloads.
The JSON export is space- and character-scoped, but the operational backup is a
complete recovery image and must be protected as sensitive data.

“Delete all data” removes application records and Skill enablement settings but
intentionally retains user-authored files in both normal and private Workspaces
and packages under `<stateDir>/skills`. Retained packages are disabled after the
settings reset. The confirmation UI states this explicitly; delete Workspace
files and installed package directories separately when they must also be
erased.
