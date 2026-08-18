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
User Profile, schedules and reminders, worlds, relationship state,
interaction/meeting state, scenes, character collaboration, proactive world
messages, and SOUL writes are not available to the private Agent. Character
identity, SOUL, model selection, system prompts, module permissions, and the
role's responsibility/capability profile remain shared configuration. Shared
responsibility/capability fields are read-only while private mode is open; the
private workbench Skill itself has an independent version history.

Private mode is not disk encryption, a password vault, an operating-system user
boundary, HTTP authentication, or end-to-end encryption. A local process or
user that can read YourChar's state directory can read both spaces. The HTTP
service therefore binds only to loopback. The configured model provider
receives the private turn and the private context needed to answer it.

Sandboxed shell network is globally disabled as soon as private data or a
private-only Agent Skill exists, including for normal conversations, so model
code cannot use the loopback API as a cross-space path. It cannot be re-enabled
while that state remains. Tavily, Web Reader, Vision, and the model provider are
host-side clients with separate configuration and request boundaries; private
turns may still send necessary content to an enabled external service.

Installing a Skill does not re-enable sandbox network. The Management UI uses a
separate host-side installer with a narrowly bounded HTTPS downloader, archive
validation, a visible `SKILL.md` review, and an explicit second confirmation.
The Agent cannot silently invoke it or choose an arbitrary URL through a model
tool. A private-only package is published only after active Agent turns finish;
that confirmation also applies the global shell-network fail-close before the
package becomes discoverable.

Operational backups include the database, private transcripts, private Vault
documents, `workspace-secret`, and host-installed Agent Skill packages. RP
Agent does not encrypt backup payloads.
The JSON export is space- and character-scoped, but the operational backup is a
complete recovery image and must be protected as sensitive data.

“Delete all data” removes application records and Skill enablement settings but
intentionally retains user-authored files in both normal and private Workspaces
and packages under `<stateDir>/skills`. Retained packages are disabled after the
settings reset. The confirmation UI states this explicitly; delete Workspace
files and installed package directories separately when they must also be
erased.
