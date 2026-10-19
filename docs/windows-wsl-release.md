# Windows / WSL2 release payload

Windows users run the Linux backend inside WSL2. There is no native Windows
document, LSP or RAM-disk provider, so the release ships the whole backend
environment instead of asking the user to build one.

`scripts/build-wsl-release.sh` (`npm run package:windows`) produces:

| Artifact | Purpose |
| --- | --- |
| `YourChar-<version>-wsl-amd64.tar.gz` | complete WSL2 distribution for `wsl --import` |
| `YourChar-<version>-wsl-amd64-app.tar.gz` | application payload only, for updates |
| `SHA256SUMS.txt` | digests of both archives |

Both archives are built from a temporary staging directory. A failed build
leaves the checkout untouched, and no build output is written into the source
tree other than `./release`.

## What the image contains

- Ubuntu base rootfs (pinned release and sha256), with `bubblewrap`,
  `ca-certificates`, `curl`, `git`, `libstdc++6` and `util-linux`
  installed by the builder
- Node.js from the official archive, verified against `SHASUMS256.txt`, at
  `/opt/yourchar/node` and linked into `/usr/local/bin`
- the application payload at `/opt/yourchar`: `dist`, `node_modules` (production
  dependencies only), `assets`, `skills`, and the document service with AnyDoc's
  Linux native npm module; tests and fixtures are excluded
- `/etc/wsl.conf` selecting the non-root `yourchar` user and keeping the Windows
  `PATH` out of the distribution
- `/var/lib/yourchar`, owned by `yourchar`, for user data

Python and uv are not required. Document conversion uses AnyDoc's JS API
inside the existing offline sandbox, with CPU, file-descriptor and output
bounds, a 90-second deadline, a 256 MiB V8 heap limit and a Linux 4 GiB
address-space limit. The heap limit alone does not bound native allocations.
The builder runs the real conversion and isolation tests with production npm
dependencies before assembling the payload.

## Building

```bash
sudo YOURCHAR_WSL_APT_MIRROR=http://mirrors.example.org/ubuntu \
     npm run package:windows
```

Root is required because the rootfs is assembled with `chroot`; the script
re-executes itself through `sudo` when needed. Use `--keep-build` to inspect the
staging directory. Downloads are cached in `~/.cache/yourchar-wsl-release`, and
that cache is reused by later builds.

`YOURCHAR_WSL_OUTPUT_DIR`, `YOURCHAR_WSL_CACHE_DIR`, `YOURCHAR_WSL_APT_MIRROR`,
`YOURCHAR_WSL_UBUNTU_BASE` and `YOURCHAR_WSL_UBUNTU_SHA256` override the
defaults; the base rootfs default is pinned to the Ubuntu release the Linux
acceptance testing runs on.

## Importing and running

```powershell
wsl --import YourChar "$env:LOCALAPPDATA\YourChar\distro" YourChar-<version>-wsl-amd64.tar.gz
wsl -d YourChar --exec /opt/yourchar/bin/yourchar-backend --check
wsl -d YourChar --exec /opt/yourchar/bin/yourchar-backend
```

`wsl --import` needs no administrator rights; only enabling the WSL2 platform on
a machine that has never had it does.

## State and updates

`/var/lib/yourchar` holds user data and is separate from `/opt/yourchar`.
Updating extracts the application payload over `/opt/yourchar` and leaves state
alone; `wsl --unregister YourChar` deletes the distribution and therefore the
state with it, so export data before removing a distribution.

## Running the payload on a user's machine

The payload is not started by hand. `packaging/windows/launcher/` contains
`YourChar.exe`, which imports this archive into a private WSL2 distribution,
starts the backend, waits for readiness, opens the UI and stops the backend again
on exit. See `packaging/windows/launcher/README.md`.

`packaging/windows/installer/` wraps that launcher and this payload into one
per-user setup executable, so an end user installs YourChar from a single file
and never sees the distribution. See `packaging/windows/installer/README.md`.
