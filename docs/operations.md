# YourChar Operations

## Managed user service

Sandboxed Agent shell and structured document conversion require Bubblewrap at
`/usr/bin/bwrap`. The MarkItDown worker also requires `uv` and Python 3.11 or
newer. On Debian or Ubuntu install Bubblewrap before the service, install `uv`
for the service user, and synchronize the project-local worker environment:

```bash
sudo apt-get install bubblewrap
/usr/bin/bwrap --version
uv --version
npm run setup:markitdown
```

The scheduler is reliable only while the process is running. Install the user
service after dependencies are installed:

```bash
chmod +x scripts/install-user-service.sh
scripts/install-user-service.sh
```

The installer first performs a frozen `uv sync` for
`services/markitdown`, builds the current checkout, writes
`~/.config/systemd/user/rp-agent.service`, enables it, and starts it on
`127.0.0.1:8765`. It preflights the state paths before creating anything. When
only `.rp-agent` exists, the installer stops the old unit, verifies the Vault
writer is inactive, writes a verified timestamped backup under
`backups/yourchar-pre-migration-*` (and prints its path), and performs one
same-parent atomic rename to `.yourchar`.
It rejects symlinks, non-directories, wrong ownership, and old/new conflicts;
it never implements migration by copying. The legacy service filename remains
unchanged for upgrade compatibility. The generated unit always pins
`YOURCHAR_STATE_DIR` and `ReadWritePaths` to this checkout's `.yourchar`; the
installer manages only that project-default state path. Before stopping or
overwriting an existing unit, it requires an exact `WorkingDirectory`, verifies
that `ExecStart` names this checkout's `dist/src/server.js`, and rejects any
custom `YOURCHAR_STATE_DIR` or `RP_AGENT_STATE_DIR` value. A failed backup or
migration leaves the legacy directory in place and attempts to restart a unit
that was active before installation. After restart, the installer allows up to
30 seconds for the loopback readiness endpoint, then verifies that the service
remains active with the same main PID during a short stability window; failure
prints unit status and recent journal entries and exits nonzero. User lingering
must remain enabled for reminders after logout:

```bash
loginctl show-user "$USER" -p Linger
```

Useful commands:

```bash
systemctl --user restart rp-agent.service
systemctl --user status rp-agent.service
journalctl --user -u rp-agent.service -f
```

To run the service with a custom state directory, manage that customization as
a systemd drop-in and override both the runtime path and the filesystem write
allowlist together:

```ini
[Service]
Environment="YOURCHAR_STATE_DIR=/absolute/path/to/custom-state"
ReadWritePaths=
ReadWritePaths=/absolute/path/to/custom-state
```

After editing the drop-in, run `systemctl --user daemon-reload` and restart the
unit. Future installer runs deliberately refuse to replace a unit that reports
this custom path; migrate or remove the drop-in manually before reinstalling.

To run the same state migration separately, stop the service first. The command
uses an exclusive sibling lock, rechecks directory identity and writer state,
and fsyncs the parent after the rename:

```bash
systemctl --user stop rp-agent.service
npm run migrate:state
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
state, the R1 profile/SOUL compatibility mirrors, Pi agent state, the normal
Workspace **except `workspace/repos/`**, and per-character secret Workspaces,
plus packages installed under `<stateDir>/skills` and the bundled Channel
Runtime state under `<stateDir>/im-runtime`. Git state includes
`git/access.json` and YourChar-managed credentials under `git/credentials/`.
Older `git/registry.json`, `git-work-items.json`, `git-worktrees/`,
`git-repository.json`, and `git-runtime/` data is still copied when present as
migration/rollback history; those files are no longer the active Git model.
The active approved-commit ledger at `git/access-approved-commits.json` and
isolated Git runtime data under `git/access-runtime/` are included as part of
the `git/` tree.
Vault Markdown is copied byte-for-byte, preserving its frontmatter revisions
and hashes. Backup schema v3 records every payload file's SHA-256 and size,
SQLite schema and `integrity_check`, Vault hashes, and Vault-to-SQLite
projection consistency. The destination is staged, fully validated, and only
then published by rename.
With no state-directory argument it uses `YOURCHAR_STATE_DIR`, then the legacy
`RP_AGENT_STATE_DIR`, then the sole existing `.yourchar` or `.rp-agent` sibling.
If both sibling directories exist and neither environment variable chooses one,
the script fails closed.

An explicit source and destination may be supplied:

```bash
node --disable-warning=ExperimentalWarning scripts/backup-state.mjs .yourchar /secure/path/yourchar-backup
```

Backups have directory mode `0700`. They may include `model-api.json`,
`tavily.json`, `vision.json`, `mineru.json`, `git/access.json`,
`git/credentials/`, legacy `git-repository.json`, and
`im-runtime/credentials.json`. API configuration, managed Git private keys, and
IM credentials can contain keys, platform tokens, refresh credentials, or App
Secrets, so backup storage must be treated as secret. The backup manifest
records credential-file presence without copying any key or token into the
manifest. IM credentials are indicated by
`containsImCredentials` and `credentials.imRuntimeCredentialsPresent`;
`containsImRuntime` also records the Channel Runtime payload.
MinerU credentials are indicated by `containsMineruCredentials` and
`credentials.mineruConfigPresent`; `mineru.json` may contain a Bearer token for
the configured document-processing endpoint.
`containsGitAccessConfig` reports `git/access.json`, while
`containsGitCredentials` reports the managed credential payload.
`excludesGitWorkspaceRepositories: true` records that `workspace/repos/` was
deliberately omitted. The optional fields preserve compatibility with earlier
schema-v3 manifests: an older valid manifest without the exclusion marker may
still describe repository files and remains verifiable/restorable.
`containsGitRegistry`, `containsGitWorkItems`, and
`containsGitRepositoryConfig` now describe legacy migration artifacts only.
External Git private-key bytes are never copied: `git/access.json`, an older
registry, and legacy configuration record only their absolute host paths, and
the backup filter excludes a declared external key even if it is located below
another selected state tree. Restore external key files separately with
owner-only permissions or Git access remains unavailable.
Managed Ed25519 keys are stored at
`git/credentials/default/id_ed25519` and are copied, so
`containsGitCredentials: true` makes the backup credential-bearing and highly
sensitive.
`tavily.json` may also contain an authenticated proxy URL and must be protected
even when no Tavily Key is present. Backups are not encrypted by YourChar and
contain private-mode transcripts, memories, Workspace files, and private-only
Skill bodies. `im-runtime/spool.json` can additionally contain pending external
message text and delivery receipts; store or encrypt the backup accordingly.

Cloned repositories are working data, not YourChar application state. The
entire `workspace/repos/` tree is excluded before traversal, including tracked
symlinks, `.git`, object databases, and uncommitted changes. Push commits that
must survive to their remote, or back up that repository tree separately with a
Git-aware or filesystem backup procedure. A YourChar state restore does not
restore or automatically reclone those repositories.

## Restore

Verify a backup without changing the target, then inspect a restore dry run:

```bash
node scripts/restore-state.mjs /secure/path/yourchar-backup --verify
node scripts/restore-state.mjs /secure/path/yourchar-backup .yourchar --dry-run
```

Stop the service before replacing state. Restore validates the source, copies
it to a sibling staging directory, validates it again, and only then switches
the state directory. Its default target follows the same
`YOURCHAR_STATE_DIR` → `RP_AGENT_STATE_DIR` → unambiguous sibling resolution. A
failed validation or switch leaves the old target in place:

```bash
systemctl --user stop rp-agent.service
node scripts/restore-state.mjs /secure/path/yourchar-backup .yourchar --force
systemctl --user start rp-agent.service
curl -fsS http://127.0.0.1:8765/api/v1/readiness
```

The restore script refuses to overwrite an existing state directory without
`--force`. On startup YourChar replays pending Vault operations, validates the
restored Vault, rebuilds SQLite/FTS, aligns profile/SOUL mirrors, and removes
stale resident-memory versions before provider use. Keep the original backup
until sessions, schedules, characters, memories, and Git access settings have
been checked. Repositories and uncommitted repository changes are absent by
design; reclone them from their remotes or restore them from their separate
backup.

Legacy backups remain valid: their payload still contains the compatibility
database filename `rp-agent.sqlite`, and `sourceDirectoryName: ".rp-agent"` does
not force the restore target to use the old name. To keep using an existing old
state directory intentionally, pass `.rp-agent` explicitly or set
`YOURCHAR_STATE_DIR=.rp-agent` (the legacy `RP_AGENT_STATE_DIR` remains accepted).
Backup and restore validate/copy backup payloads; they are not state-directory
migration tools. Use the stopped-service `migrate:state` command for renaming.

After restoring a backup that contains `im-runtime`, verify both platform
bindings and their selected character routes in **Settings → IM Channels** before
allowing the service to run unattended. Bindings and credentials are restored and
can reconnect the same platform accounts, but queued messages are deliberately
quarantined: after the staging copy has passed full validation, restore marks all
SQLite IM outbox rows in `pending` or `failed` state as `abandoned`, clears their
delivery leases, and removes the restored `im-runtime/spool.json`. Old inbound or
outbound messages are therefore never replayed automatically. Delivered records
remain as audit history. If the restored host should not contact the old accounts,
start it without network access, open the original installation to unlink those
accounts, or remove the restored IM credentials only as part of an intentional
credential-reset procedure.

## Vault recovery

Read metadata-only health without exposing memory bodies or credentials:

```bash
curl -fsS http://127.0.0.1:8765/api/v1/memory-vault/health
curl -fsS http://127.0.0.1:8765/api/v1/memory-vault/recovery
curl -fsS 'http://127.0.0.1:8765/api/v1/memory-vault/history?limit=10'
```

`writer.mode=writer` is normal for the active instance. A
`MEMORY_VAULT_WRITER_BUSY` startup failure means another unexpired writer owns
the state directory; stop the duplicate process rather than deleting the lease
row. An expired lease is fenced and can be taken over automatically. A pending
journal operation is replayed before any provider request. Do not manually edit
or remove `memory-vault-journal`; retain the state directory and restart the
single intended instance. The Settings Vault Health panel shows the same writer,
journal, recovery, projection, and backup-verification metadata.

The Settings page also lists recent application-managed Vault versions. Restore
from that page so the same-origin control capability, explicit confirmation,
Vault validation, journal transaction, and projection rebuild all run. Do not
use `git checkout` against the live Vault. The bare history repository has no
remote and is intentionally absent from character Agent Git access. A normal
memory forget is an auditable soft delete; **Delete All Data** destroys the old
history object store before starting a new empty history.

## Debug and evaluation surfaces

The Debug page includes bounded diagnostic views and disposable evaluation
surfaces:

- Provider Trace retains the latest 10 final payloads. It can contain user and
  memory text, so treat screenshots and exported diagnostics as user data.
  Embedded image/file data URLs are represented only by MIME and encoded size;
  inspect the original attachment through Chat or Workspace Files.
- Context Economics retains the latest 100 lightweight records. It stores
  hashes, memory IDs, score reasons, section budgets, LCP evidence, and token
  counts without candidate bodies, query text, credentials, or tool arguments.
- Built-in Feature Tests use temporary state and deterministic assertions plus
  an optional independent Judge. See `model-adaptation-evaluation.md`.
- Task Bench runs user-defined repeated trials in a fresh zero-memory runtime,
  then keeps reports only in the current browser page until an explicit JSON or
  Markdown export. See `task-bench.md`.

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
