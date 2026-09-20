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

- [ ] Shared offline worker launcher: Linux Bubblewrap and macOS Seatbelt, bounded process lifetime and explicit mounts.
- [ ] Verified Linux tmpfs / macOS RAM-volume storage, private permissions, disposal and stale-owner recovery.
- [ ] MarkItDown integration, portable development setup and self-contained release Python.
- [ ] TypeScript LSP integration, virtual/host URI translation and read-only/offline regression tests.
- [ ] Incognito integration, portable owner identity, quota and lifecycle regressions.
- [ ] Windows WSL2 preflight/start workflow with actionable errors; native-host worker use fails closed.
- [ ] Linux regression gate, real macOS worker/packaging gate, documentation of tested vs untested paths.

Windows host acceptance remains separate until a Windows/WSL2 test machine is available. Native Windows restricted-token workers and ordinary disk-backed “incognito” are not substitutes.
