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
  `ca-certificates`, `curl`, `git`, `libgomp1`, `libstdc++6` and `util-linux`
  installed by the builder
- Node.js from the official archive, verified against `SHASUMS256.txt`, at
  `/opt/yourchar/node` and linked into `/usr/local/bin`
- the application payload at `/opt/yourchar`: `dist`, `node_modules` (production
  dependencies only), `assets`, `skills`, the document service and its
  self-contained CPython runtime
- `/etc/wsl.conf` selecting the non-root `yourchar` user and keeping the Windows
  `PATH` out of the distribution
- `/var/lib/yourchar`, owned by `yourchar`, for user data

`uv` is a build-time tool. It bundles CPython and the hash-locked wheels into
`services/markitdown/runtime` through `scripts/bundle-markitdown.mjs`; it is not
installed in the image.

The document worker runs with a 4 GiB address-space limit. MarkItDown pulls in
Magika and ONNX Runtime, which reserve several GiB of virtual address space
(measured peak 2.1 GiB with 2 CPUs and 3.0 GiB with 24 CPUs) while resident
memory stays near 140 MiB, so a tighter bound makes worker startup fail
nondeterministically. The builder refuses to package a `worker.py` that does not
carry the verified bound.

## Building

```bash
sudo YOURCHAR_WSL_APT_MIRROR=http://mirrors.example.org/ubuntu \
     YOURCHAR_BUILD_UV="$HOME/.local/bin/uv" \
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
wsl --import YourChar "$env:LOCALAPPDATA\YourChar\wsl" YourChar-<version>-wsl-amd64.tar.gz
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