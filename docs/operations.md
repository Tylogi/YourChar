# YourChar Operations

## Managed user service

Sandboxed Agent shell execution requires Bubblewrap at `/usr/bin/bwrap`. On
Debian or Ubuntu install it before the service:

```bash
sudo apt-get install bubblewrap
/usr/bin/bwrap --version
```

The scheduler is reliable only while the process is running. Install the user
service after dependencies are installed:

```bash
chmod +x scripts/install-user-service.sh
scripts/install-user-service.sh
```

The installer builds the current checkout, writes
`~/.config/systemd/user/rp-agent.service`, enables it, and starts it on
`127.0.0.1:8765`. User lingering must remain enabled for reminders after logout:

```bash
loginctl show-user "$USER" -p Linger
```

Useful commands:

```bash
systemctl --user restart rp-agent.service
systemctl --user status rp-agent.service
journalctl --user -u rp-agent.service -f
```

The production entrypoint treats `SIGTERM` and `SIGINT` as idempotent graceful
shutdown requests. It stops accepting new connections and disposes the
HTTP-server-owned kernel before the close callback completes, releasing the
Vault writer lease for an immediate `systemctl restart`. After 10 seconds it
closes remaining HTTP connections and uses a bounded hard-exit fallback. A
kernel injected into `createHttpServer` remains the caller's lifecycle
responsibility.

## Backup

Stop YourChar before backup so the writer lease is inactive. The backup command
fails rather than capture state while an application writer is live:

```bash
systemctl --user stop rp-agent.service
node --disable-warning=ExperimentalWarning scripts/backup-state.mjs
systemctl --user start rp-agent.service
```

The backup script uses SQLite's online backup API and copies Pi transcripts,
conversation metadata, the complete Memory Vault, its projection/migration
state, the R1 profile/SOUL compatibility mirrors, Pi agent state, and both the
normal Workspace and per-character secret Workspaces, plus packages installed
under `<stateDir>/skills`. Vault Markdown is copied byte-for-byte, preserving
its frontmatter revisions and hashes. Backup schema v3 records every payload file's
SHA-256 and size, SQLite schema and `integrity_check`, Vault hashes, and
Vault-to-SQLite projection consistency. The destination is staged, fully
validated, and only then published by rename.

An explicit source and destination may be supplied:

```bash
node --disable-warning=ExperimentalWarning scripts/backup-state.mjs .rp-agent /secure/path/yourchar-backup
```

Backups have directory mode `0700`. They may include `model-api.json` and
`tavily.json`, both of which can contain API keys, so backup storage must be
treated as secret. The backup manifest records credential-file presence without
copying either Key into the manifest.
`tavily.json` may also contain an authenticated proxy URL and must be protected
even when no Tavily Key is present. Backups are not encrypted by YourChar and
contain private-mode transcripts, memories, Workspace files, and private-only
Skill bodies; store or encrypt the backup accordingly.

## Restore

Verify a backup without changing the target, then inspect a restore dry run:

```bash
node scripts/restore-state.mjs /secure/path/yourchar-backup --verify
node scripts/restore-state.mjs /secure/path/yourchar-backup .rp-agent --dry-run
```

Stop the service before replacing state. Restore validates the source, copies
it to a sibling staging directory, validates it again, and only then switches
the state directory. A failed validation or switch leaves the old target in
place:

```bash
systemctl --user stop rp-agent.service
node scripts/restore-state.mjs /secure/path/yourchar-backup .rp-agent --force
systemctl --user start rp-agent.service
curl -fsS http://127.0.0.1:8765/api/v1/readiness
```

The restore script refuses to overwrite an existing state directory without
`--force`. On startup YourChar replays pending Vault operations, validates the
restored Vault, rebuilds SQLite/FTS, aligns profile/SOUL mirrors, and removes
stale resident-memory versions before provider use. Keep the original backup
until sessions, schedules, characters, and memories have been checked.

## Vault recovery

Read metadata-only health without exposing memory bodies or credentials:

```bash
curl -fsS http://127.0.0.1:8765/api/v1/memory-vault/health
curl -fsS http://127.0.0.1:8765/api/v1/memory-vault/recovery
```

`writer.mode=writer` is normal for the active instance. A
`MEMORY_VAULT_WRITER_BUSY` startup failure means another unexpired writer owns
the state directory; stop the duplicate process rather than deleting the lease
row. An expired lease is fenced and can be taken over automatically. A pending
journal operation is replayed before any provider request. Do not manually edit
or remove `memory-vault-journal`; retain the state directory and restart the
single intended instance. The Settings Vault Health panel shows the same writer,
journal, recovery, projection, and backup-verification metadata.

## Context Economics

The Debug page has two bounded views:

- Provider Trace retains the latest 10 final payloads. It can contain user and
  memory text, so treat screenshots and exported diagnostics as user data.
  Embedded image/file data URLs are represented only by MIME and encoded size;
  inspect the original attachment through Chat or Workspace Files.
- Context Economics retains the latest 100 lightweight records. It stores
  hashes, memory IDs, score reasons, section budgets, LCP evidence, and token
  counts without candidate bodies, query text, credentials, or tool arguments.

Settings > Data also has an opt-in Provider Trace file archive. It is disabled
by default. When enabled, every sanitized trace is appended as one JSON object
per line under:

```text
<stateDir>/trace-archive/model-traces-YYYY-MM-DD.jsonl
```

The config is stored in `<stateDir>/trace-archive.json`. Directories use mode
`0700` and files use `0600`. Files rotate by UTC date and are not automatically
expired, so operators must monitor disk usage. The normal Debug view and SQLite
table remain capped at 10. Backups include the archive; deleting all user data
removes archived files while retaining the on/off setting.

Credential-shaped JSON fields such as `authorization`, `apiKey`, tokens,
passwords, and secrets are redacted before both bounded and file persistence.
Text conversation content and tool results are intentionally complete; binary
data URLs are omitted. A secret typed
inside ordinary message text is therefore not automatically redacted. Treat the
JSONL as sensitive user data. It is useful as a debugging or dataset source, but
must be reviewed, consented, filtered, and transformed before model training.

`estimated*` token fields are deterministic local estimates. The `actual`
provider fields are independent: `null` and the UI label `unknown` mean that
the provider supplied no usable usage group, while numeric zero means the
provider explicitly reported zero cache reads or writes. Do not use estimates
as evidence of a billable cache hit.

Read recent records without opening the UI:

```bash
curl -fsS 'http://127.0.0.1:8765/api/debug/context-economics?limit=20'
```

Use the read-only preview endpoints before tuning retrieval or budgets. Preview
does not touch memory, increment hit counts, or consume session bootstrap:

```bash
curl -fsS --get 'http://127.0.0.1:8765/api/v1/context-plan/preview' \
  --data-urlencode mode=sms \
  --data-urlencode sessionId=operations-preview \
  --data-urlencode 'query=还记得我们的约定吗？' \
  --data-urlencode memoryTokens=360 \
  --data-urlencode timezone=Asia/Shanghai
```

The default total dynamic budget is 900 estimated tokens and the all-memory
budget is 360. Reality and current-character RP each default to 220 tokens and
three items. Change defaults only with the no-match-zero, realm/status,
whole-item budget, LCP, stale snapshot, and 40-turn regressions enabled.

Session deletion removes that session's economics and resident/bootstrap
checkpoints. Confirmed delete-all clears every economics, retrieval-stat, and
checkpoint row along with the Vault and other user data. `/api/v1/export`
includes checkpoint state for audit; the normal backup includes the SQLite
economics tables as operational state.

For a suspected stale or duplicate memory injection:

1. Inspect the latest Context Economics retrieval plan and memory versions.
2. Run a read-only preview with the same mode, character, and query.
3. Check Vault status and run the safe Sync action if an Obsidian edit is
   pending.
4. Verify the latest provider request contains no old-version turn context.
5. If the issue follows compaction/restart, confirm resident state was rebuilt
   from the v2 turn-context messages that actually remain in Pi history.

For an `output_guard_exhausted` system event, inspect the turn actions. A
recovered reminder must have one completed `create_schedule_item` action with
`transport=mcp` and one `recover_output_guard_intent` action. A recovered
remember/forget instruction must reference a completed Coordinator job. Failed
or ambiguous recovery must not be treated as a model reply or as a completed
mutation; ambiguous forget requires selection in Memory Management.
