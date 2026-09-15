# macOS Release

YourChar can be packaged as a self-contained Apple Silicon application. The
release contains a native AppKit/WebKit window, the compiled YourChar server,
production npm dependencies, the bundled Skills, and a verified Node.js arm64
runtime. Users do not need to install Node.js.

## Runtime behavior

- Double-clicking `YourChar.app` starts the server on `127.0.0.1:8765` and
  loads it in the native window.
- App data lives in `~/Library/Application Support/YourChar` rather than in the
  signed application bundle.
- Logs live in `~/Library/Logs/YourChar/YourChar.log`.
- The application menu can open YourChar in the default browser, reveal the
  data directory, reveal the log, or quit cleanly.
- If a compatible YourChar instance is already ready on the default port, the
  application attaches to it and does not stop that external process on quit.

The packaged app supports the core conversation, memory, character, world,
schedule, reminder, model-provider, Workspace file, and network-integration
features. Sandboxed Shell, the local MarkItDown worker, and the sandboxed
TypeScript LSP require Linux Bubblewrap and remain unavailable on macOS.

## Build on Apple Silicon

Requirements:

- Apple Silicon Mac running macOS 11 or newer
- Xcode Command Line Tools with Swift, `codesign`, `iconutil`, and `hdiutil`
- Network access to the npm registry and `nodejs.org`
- A clean Git working tree

Run from the repository root:

```bash
npm run package:macos
```

The builder exports committed `HEAD` into a clean staging directory, downloads
the Node version pinned by `.nvmrc`, verifies it against Node's published
`SHASUMS256.txt`, installs locked dependencies, runs the macOS packaging gate
and sensitive-information scan, prunes development-only packages, compiles the
native launcher and icon, performs a packaged-server readiness smoke test, and
then produces:

```text
release/YourChar-<version>-macos-arm64.zip
release/YourChar-<version>-macos-arm64.dmg
release/SHA256SUMS.txt
```

Use `MACOS_OUTPUT_DIR` to choose another artifact directory. Set
`MACOS_RUN_FULL_TESTS=1` to additionally run the complete Linux-oriented test
suite on a suitably provisioned host. The normal macOS build uses its portable
packaging test because Bubblewrap-specific integration tests cannot run on
macOS. A one-off local iteration can use `MACOS_SKIP_TESTS=1`; do not use that
option for a published release. The source commit should still pass the full
suite in Linux CI before publication.

## Signing and publication

The current builder ad-hoc signs the complete bundle and verifies its nested
code. This is suitable for internal testing but is not a public macOS release:
there is no signing identity on the build host and the result is not notarized.
Before publishing broadly, add a secure CI or release-host workflow using an
Apple **Developer ID Application** certificate, hardened-runtime-compatible
entitlements for the embedded Node runtime, `notarytool`, and stapling. Never
commit the certificate, private key, App Store Connect key, or notarization
credentials.
