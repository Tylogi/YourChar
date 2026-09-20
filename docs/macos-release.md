# macOS Release

YourChar can be packaged as a self-contained Apple Silicon application. The
release contains a native AppKit/WebKit window, the compiled YourChar server,
production npm dependencies, the bundled Skills, and a verified Node.js arm64
runtime, plus a self-contained CPython/MarkItDown worker. Users do not need to
install Node.js, Python, or uv.

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
features. Sandboxed Shell now has a native Seatbelt provider; its read/write
Workspace boundary and private-file protection must pass the native release
tests on the build Mac. Shell is opt-in and uses host networking on macOS.
The native gate passed on Apple Silicon with macOS 26.6.2 and Node 22.19.0;
this does not mean an updated installer has already been published.
Document conversion and TypeScript LSP have a separate **offline** Seatbelt
provider. Incognito and worker scratch use verified private RAM volumes, with no
disk fallback. See [worker adaptation](cross-platform-workers.md) for the exact
boundaries, verification status, and remaining Windows checks.

## Build on Apple Silicon

Requirements:

- Apple Silicon Mac running macOS 13 or newer (the bundled document libraries require macOS 13)
- Xcode Command Line Tools with Swift, `codesign`, `iconutil`, and `hdiutil`
- uv (build-time only; `YOURCHAR_BUILD_UV` may name its executable)
- Network access to npm, `nodejs.org`, Python package downloads and Astral's Python releases
- A clean Git working tree

Run from the repository root:

```bash
npm run package:macos
```

The builder exports committed `HEAD` into a clean staging directory, downloads
the Node version pinned by `.nvmrc`, verifies it against Node's published
`SHASUMS256.txt`, installs locked dependencies, runs the macOS packaging gate
and sensitive-information scan, bundles CPython 3.13.5 with hash-locked
MarkItDown wheels, prunes development-only packages, compiles the
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
packaging tests plus required native sandbox and permission tests because
Bubblewrap-specific integration tests cannot run on macOS. The sandbox gate
must execute real commands, not merely generate a Seatbelt profile; an unavailable
native backend fails the release gate. A one-off local iteration can use
`MACOS_SKIP_TESTS=1`; do not use that
option for a published release. The source commit should still pass the full
suite in Linux CI before publication.

The native test gate runs serially, including foreground/background lifecycle
tests, actual PDF conversion, TypeScript cross-file navigation, worker isolation,
and portable incognito lifecycle tests. Linux `/proc`/tmpfs-specific assertions
remain Linux-only and are not counted as macOS verification. For a bounded-heap validation on a shared Mac, run:

```bash
npm run setup:markitdown # development checkout; release builds bundle Python instead
NODE_OPTIONS=--max-old-space-size=2048 npm run test:macos
```

Keep a single validation checkout, eject old installer volumes, and archive old
build bundles separately. Do not remove Application Support data to clean builds.

## Signing and publication

The current builder ad-hoc signs the complete bundle and verifies its nested
code. This is suitable for internal testing but is not a public macOS release:
there is no signing identity on the build host and the result is not notarized.
Before publishing broadly, add a secure CI or release-host workflow using an
Apple **Developer ID Application** certificate, hardened-runtime-compatible
entitlements for the embedded Node runtime, `notarytool`, and stapling. Never
commit the certificate, private key, App Store Connect key, or notarization
credentials.
