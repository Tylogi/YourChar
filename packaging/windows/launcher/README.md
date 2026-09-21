# YourChar Windows launcher

`YourChar.exe` is the double-click entry point for ordinary Windows users. It owns
the whole startup chain and keeps the Linux runtime out of sight:

1. checks that WSL2 is available (no administrator rights required to look),
2. finds YourChar's own WSL distribution, and imports the bundled payload on first
   run (`wsl --import`, which a normal user can do),
3. starts the Linux backend inside that distribution,
4. polls `http://127.0.0.1:8765/api/v1/health` until YourChar reports ready,
5. opens the YourChar UI in the default browser,
6. watches the backend for the rest of the session and restarts it after a crash,
7. stops the backend gracefully when the user quits.

The user never opens Ubuntu, PowerShell, WSL, npm, Node, Python, uv or Bubblewrap.
The launcher runs with ordinary user rights; only the optional first-time
`wsl --install` for a machine that has no WSL2 at all asks for elevation.

## Build

```powershell
powershell -ExecutionPolicy Bypass -File packaging\windows\launcher\build.ps1
```

The payload must exist first (`bash scripts/build-wsl-release.sh`). Override the
source directory with `-PayloadDir <path>`; the default is the repository's
`release/`. `-SkipPayload` compiles the launcher alone.

The build needs nothing but Windows: it uses the in-box .NET Framework compiler,
so there is no SDK, no NuGet package and no network access. End users need
nothing either, because .NET Framework 4.8 ships with Windows 10 1903+ and
Windows 11.

## Shipped layout

```
YourChar.exe                                  launcher, ~35 KB
runtime/YourChar-0.1.0-wsl-amd64.tar.gz       Linux runtime + application payload (~300 MB)
runtime/SHA256SUMS.txt                        integrity manifest, verified before import
```

Both files stay next to the executable. The payload is verified against
`SHA256SUMS.txt` before every import, and a mismatch aborts with a "download
YourChar again" message instead of importing anything.

## Command line

| Command | Effect |
| --- | --- |
| `YourChar.exe` | the normal path: start YourChar and open it |
| `YourChar.exe --no-browser` | start without opening the browser |
| `YourChar.exe --status` | report WSL2, runtime and backend state |
| `YourChar.exe --stop` | stop a running YourChar gracefully |
| `YourChar.exe --repair` | refresh YourChar's application files inside the runtime (your data is kept) |

`--status`, `--stop` and `--repair` also mirror their report to
`%LOCALAPPDATA%\YourChar\cli.txt`, because a GUI executable has no console of its own.

## Where things live

| What | Where |
| --- | --- |
| Launcher and payload | next to `YourChar.exe` |
| WSL distribution disk | `%LOCALAPPDATA%\YourChar\distro\ext4.vhdx` |
| Logs | `%LOCALAPPDATA%\YourChar\launcher.log`, `backend.log` |
| Machine-readable state | `%LOCALAPPDATA%\YourChar\status.json` |
| User data (conversations, characters, memory, usage) | `/var/lib/yourchar` **inside** the distribution |

User data is deliberately kept inside the distribution, separate from both the
read-only application payload (`/opt/yourchar`) and the Windows-side runtime
files. `YOURCHAR_STATE_DIR` pins it, and the application refuses to start if that
directory is owned by another user.

## Lifecycle and failure handling

| Situation | What the user sees | What the launcher does |
| --- | --- | --- |
| First run | "Preparing YourChar runtime... This happens once..." | imports the payload, then starts normally |
| Later runs | "Starting YourChar..." | reuses the existing distribution |
| Ready | "YourChar is ready and running in your browser." | opens the UI |
| Backend crashed | "YourChar is recovering... Please wait." | waits 25 s, then restarts and polls readiness again |
| Crash repeats | "YourChar stopped unexpectedly." | stops after 3 consecutive failures and offers "Try again" |
| Readiness never arrives | "YourChar did not become ready in time..." | reports a plain-language error and cleans up the backend |
| No WSL2 on the machine | "WSL2 is required." with "Install WSL2" | runs `wsl --install --no-distribution` through UAC |
| Runtime damaged | "YourChar runtime needs repair." with "Repair" | re-extracts `./opt/yourchar` after a confirmation prompt; the distribution and your data are kept |
| Another launcher is running | the UI opens | exits immediately, no second backend |
| User quits | "Stopping YourChar..." | `SIGTERM`s the backend, waits up to 20 s, then exits |

The 25 s recovery delay is not arbitrary: a backend that is killed hard leaves the
memory-vault writer lease held for roughly 20 s, and restarting inside that window
fails with `MEMORY_VAULT_WRITER_BUSY`. Waiting out the window turns a hard crash
into an uneventful restart.

## Distribution naming

The launcher uses the distribution name `YourChar`. If an unrelated distribution
already owns that name, it falls back to `YourCharRuntime` instead of touching the
user's distribution. YourChar-owned distributions are recognised by
`/opt/yourchar/BUILD-INFO.txt`; if both names are taken by foreign distributions the
launcher stops with an actionable message. The only thing that unregisters a
distribution is `--remove-data`, which the uninstaller runs after the user has
asked for it; repair never does.

## Limits of this MVP

- No code signing and no auto-update yet; `packaging/windows/installer/` builds the
  per-user setup executable that adds shortcuts, an Apps & Features entry and an
  uninstaller for this launcher.
- Repair refreshes `/opt/yourchar` inside the existing distribution and never
  unregisters it, so conversations, characters and memory survive. The refresh is
  an overlay: files that a newer payload drops are left behind, and it covers
  `/opt/yourchar` only, so a payload that changes `/usr` or `/etc` needs a fresh
  import rather than a repair.
- The window stays open while YourChar runs (closing it stops YourChar); there is
  no tray icon yet.
- The UI is the existing browser UI. A desktop shell (WebView2) is a later option,
  not a requirement.
