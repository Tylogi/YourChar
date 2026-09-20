# Cross-platform worker adaptation

Branch: `feature/cross-platform-workers`, based on `dev` (`9884642`).

## Boundaries

- Keep MarkItDown and the frozen Python dependency lock. Release users must not need system Python.
- Document conversion and LSP stay offline; Shell's online policy does not apply to workers.
- Document workers see one immutable input snapshot. LSP sees only its owning Workspace, read-only.
- Incognito state and worker scratch must use verified memory-backed storage. No disk-temp fallback.
- Windows follows WSL2: run the backend and its Linux runtimes together in the guest. A Windows Python/Node executable is not a Linux worker runtime.
- Do not alter the installed app, live service, chats, or `main` during validation.

## Delivery checklist

- [x] Shared offline worker launcher: Linux Bubblewrap and macOS Seatbelt, request deadlines/process-group cleanup and explicit mounts.
- [x] Verified Linux tmpfs / macOS RAM-volume storage, private permissions, disposal and stale-owner recovery.
- [x] MarkItDown integration, portable development setup and self-contained release Python.
- [x] TypeScript LSP integration, virtual/host URI translation and read-only/offline regression tests.
- [x] Incognito integration, portable owner identity, quota and lifecycle regressions.
- [x] Windows WSL2 preflight/start workflow with actionable errors; native-host worker use fails closed.
- [x] Linux regression gate, real macOS worker/packaging gate, documentation of tested vs untested paths.

Windows host acceptance remains separate until a Windows/WSL2 test machine is available. Native Windows restricted-token workers and ordinary disk-backed “incognito” are not substitutes.

## Validation — 2026-09-20

- Linux full regression with required native sandbox/worker flags: **844 passed,
  0 failed, 1 skipped**. The skip is the macOS RAM-volume crash-recovery test.
- Final native macOS gate on Apple Silicon, macOS 26.6.2 / Node 22.19.0: **44 passed,
  0 failed, 4 skipped**. Those four
  checks are Linux Bubblewrap/WSL-supervisor and Linux tmpfs/`/proc` specifics.
- macOS native checks exercise actual localhost-network denial, private-file and
  symlink-read denial, Workspace write denial, scratch writes, environment
  filtering, LSP cross-file semantics, incognito inheritance/quota/cleanup, and
  recovery after an owner is killed without cleanup.
- The packaged CPython runtime converts real PDF, DOCX and CSV fixtures. Locked
  dependencies are retained; MarkItDown was not replaced with another parser.
- Full macOS packaging at `bbaf520`: ZIP/DMG/checksums produced, ad-hoc signature
  verified, relocated/pruned/signed payload passed real document and TypeScript
  LSP tests (**2 passed, no skips**), isolated server readiness and default-avatar
  smoke passed. This is a validation artifact, not a published release.
- Python downloads blocked on the build Mac were transferred from official
  sources through the existing SSH connection; wheels were SHA-256 checked
  against `uv.lock` and installed by uv with `--require-hashes --no-index`.
- Sensitive-information scan passed; the existing Linux service remained ready.
  No installed Mac app, chat history, API settings or live service was replaced.

Final Linux follow-up tests cover timezone-stable owner identity, real document
conversion and packaging assertions: **9 passed, 0 failed, 1 macOS-only skip**.
Windows host acceptance is intentionally **not** marked complete:
the user will arrange Windows testing after a later push. See the
[handoff checklist](cross-platform-workers.md#windows--wsl2-hand-off).
