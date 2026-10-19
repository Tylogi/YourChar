# Offline workers and disposable storage

Shell's optional network access is independent of document/LSP policy. Neither
worker receives API credentials, ambient environment variables, a writable
Workspace, or a network exception. There is no unconfined fallback.

| Component | Linux / backend inside WSL2 | macOS |
| --- | --- | --- |
| Document conversion (AnyDoc) | Bubblewrap, one read-only input snapshot | Offline Seatbelt, one read-only input snapshot |
| TypeScript LSP | Bubblewrap, read-only `/workspace` | Offline Seatbelt, read-only owning Workspace; URI translation |
| Disposable state | Verified `/dev/shm` tmpfs | Verified, owned case-sensitive RAM volume |
| Runtime | Node.js and npm-locked AnyDoc native module | Node.js and npm-locked AnyDoc native module |

Conversion follows the configurable upload input cap (100 MiB by default), two-conversion concurrency limit,
90-second deadline, output bounds and CPU/core/file-descriptor limits. Linux also
enforces a 4 GiB address-space limit; macOS does **not** claim an equivalent
hard memory limit. LSP retains bounded JSON-RPC messages, request deadlines,
explicit runtime mounts and process-group shutdown. Seatbelt is OS containment,
not a VM or an administrator-proof boundary; deliberately detached descendants
are not guaranteed to be killed by process-group cancellation.

macOS RAM volumes are allocated lazily: 64 MiB per worker scratch/input lease,
384 MiB per incognito manager with one active snapshot. The incognito overlay
still has a 256 MiB quota and preserves 16 MiB of free space. The launcher checks
the newly attached device is an owned `ram://` image before formatting it. It
never formats an arbitrary supplied device or recursively deletes a mountpoint.
Only verified stale owned volumes are reclaimed. See [incognito privacy limits](incognito-mode.md)
for model-provider retention, host swap and administrator access caveats.

## Development and packaging

```bash
npm ci
npm run build
YOURCHAR_REQUIRE_WORKERS=1 node --disable-warning=ExperimentalWarning --test --test-concurrency=1 \
  dist/test/offline-workers.test.js dist/test/document-reader.test.js \
  dist/test/lsp-navigation.test.js dist/test/incognito-mode.test.js
```

Document conversion calls AnyDoc's JS API from the existing TypeScript service
inside the sandbox. There is no separate converter entry program or CLI.
It handles PDF, DOCX, PPTX, XLS/XLSX, and CSV; text files use the existing `read`
tool. Python and uv are not required. Build on the target OS/architecture so npm installs the matching
native AnyDoc module. The macOS builder validates conversion after relocating,
pruning and signing the payload, using test code outside the app bundle.
Production payloads include `dist/src`, without test code or fixtures.

## Windows / WSL2 hand-off

There is currently no native Windows document/LSP/RAM-disk provider. Use the
**whole backend inside WSL2**, with Linux Node.js and Linux-local state.
This avoids mixed executable formats and SQLite over `\\wsl.localhost` shares.
Windows can access the local web UI; WSL localhost forwarding is described in
[Microsoft's networking documentation](https://learn.microsoft.com/en-us/windows/wsl/networking).

Releases ship that environment as a ready-made WSL2 distribution, so the steps
below describe running the backend from a development checkout. For the packaged
flow see [Windows / WSL2 release payload](windows-wsl-release.md).

1. Install/start a WSL2 distribution; `wsl --list --verbose` must show version 2.
2. Inside the distribution, install Node.js 22.19+ and Bubblewrap
   (`sudo apt install bubblewrap` on Ubuntu). Keep the checkout and state in its
   Linux filesystem, not under `/mnt/c` or a Windows network share.
3. Check out the test branch, run `npm ci` and
   `npm run build` inside WSL2.
4. From a Windows checkout, run PowerShell:

   ```powershell
   .\scripts\start-wsl.ps1 -Distribution Ubuntu -ProjectPath /home/your-user/YourChar -Check
   .\scripts\start-wsl.ps1 -Distribution Ubuntu -ProjectPath /home/your-user/YourChar
   ```

   Or run `bash scripts/start-wsl-backend.sh --check` and then the same script
   without `--check` from the Linux checkout. The launcher binds to loopback and
   does not install dependencies, import chats, change firewall rules or weaken
   PowerShell execution policy. Open `http://localhost:8765` in Windows.

### Required Windows acceptance (not yet run)

- [ ] Preflight succeeds in WSL2; missing Bubblewrap/AnyDoc or WSL1 fails explicitly.
- [ ] PDF, DOCX, XLS/XLSX conversion; source edits invalidate the conversion cache.
- [ ] TypeScript definition, references, implementation and hover across files.
- [ ] Worker gate proves denied localhost networking, private-file reads, symlink escapes and Workspace writes.
- [ ] Incognito inherits normal context; close/reopen and backend restart leave normal data unchanged.
- [ ] Cancelling a conversion/query and closing the PowerShell launcher leave no worker processes behind.
- [ ] Unicode/space-containing project paths and Windows browser localhost access.

No Windows host is currently available. The Linux-side preflight and worker tests
are useful evidence, but are **not** Windows transport, shutdown or UI acceptance.
