# macOS Release

YourChar can be packaged as a self-contained Apple Silicon application. The
release contains a native AppKit/WebKit window, the compiled YourChar server,
production npm dependencies, the bundled Skills, and a verified Node.js arm64
runtime, plus a self-contained CPython/MarkItDown worker. Users do not need to
install Node.js, Python, or uv.

## Install or upgrade

Download the DMG or ZIP from the
[v0.2.1 release](https://github.com/Tylogi/YourChar/releases/tag/v0.2.1).
It requires **Apple Silicon and macOS 13 or newer**; it is not an Intel or
Windows installer. See the [release notes](releases/v0.2.1.md).

1. Quit any running YourChar app with **YourChar → Quit YourChar** (`⌘Q`). Closing
   its window alone does not stop the backend. Quit any separately started
   YourChar backend too, so the new app does not attach to an older service.
2. For an upgrade, back up `~/Library/Application Support/YourChar` after quitting.
3. Open the DMG and drag `YourChar.app` into **Applications**, choosing **Replace**
   if prompted. Alternatively, extract the ZIP and copy the app to Applications.
4. Eject the DMG and open `/Applications/YourChar.app`. Configure a model on a
   fresh installation; an upgrade retains existing settings and conversations.

Only the app bundle is replaced. Do **not** delete Application Support to upgrade;
keeping the old app and the pre-upgrade data backup also makes rollback possible.
This release does not include an automatic updater.

`SHA256SUMS.txt` contains checksums for both installer formats. After downloading
both assets and the checksum file into the same directory, run:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

If downloading only one format, compare `shasum -a 256 <downloaded-file>` with
that file's entry instead. Checksums verify file integrity; they do not replace
Apple notarization or establish the publisher's identity.

The v0.2.1 app and disk image use **Developer ID signing and Apple notarization**.
Both include stapled tickets. Earlier preview assets remain ad-hoc signed and
were not notarized. A damaged-app or malware warning should be investigated;
do not disable Gatekeeper to bypass it.

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
The native gate is verified on Apple Silicon with macOS 26.6.2 and Node 22.19.0.
The deployment minimum is macOS 13; older supported macOS versions have not yet
been tested on a physical machine.
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
- A Developer ID Application certificate with its private key in the build user's Keychain
- A working `notarytool` Keychain profile for the same Apple Developer team

Run from the repository root:

```bash
MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
MACOS_NOTARY_PROFILE="your-notary-profile" npm run package:macos
```

If the profile is stored in a file-based Keychain, set `MACOS_NOTARY_KEYCHAIN`
to its absolute path. The builder passes that path to each `notarytool` call.
For remote builds, run the job in the user's graphical login session when SSH
cannot access the signing key or notarization profile.

The builder exports committed `HEAD` into a clean staging directory, downloads
the Node version pinned by `.nvmrc`, verifies it against Node's published
`SHASUMS256.txt`, installs locked dependencies, runs the macOS packaging gate
and sensitive-information scan, bundles CPython 3.13.5 with hash-locked
MarkItDown wheels, prunes development-only packages, compiles the
native launcher and icon, signs nested native code before the outer bundle,
and performs a packaged-server readiness smoke test. It then notarizes and
staples the app, builds the ZIP and DMG, and notarizes and staples the DMG before
computing checksums. It produces:

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
and portable incognito lifecycle tests. It also opens a temporary app to test
editing shortcuts and WebKit context-menu copy/paste with Unicode text. Keep
the build Mac's desktop unlocked during this check. The test preserves the
clipboard in memory and restores it if no other app has changed it. When
`MACOS_SIGN_IDENTITY` is set, the test app uses that identity and hardened runtime.
Linux `/proc`/tmpfs-specific assertions
remain Linux-only and are not counted as macOS verification. For a bounded-heap validation on a shared Mac, run:

```bash
npm run setup:markitdown # development checkout; release builds bundle Python instead
NODE_OPTIONS=--max-old-space-size=2048 npm run test:macos
```

Keep a single validation checkout, eject old installer volumes, and archive old
build bundles separately. Do not remove Application Support data to clean builds.

## Signing and publication

The builder requires `MACOS_SIGN_IDENTITY` and `MACOS_NOTARY_PROFILE`; it never
silently falls back to ad-hoc signing. It signs each Mach-O file with a secure
timestamp, enables hardened runtime on executables, and grants JIT permissions
only to embedded runtime executables. The app resource envelope is signed last.
Test code stays outside the signed payload. Published ZIPs contain the stapled
app, and the DMG has its own signature and stapled ticket. Both artifacts must
pass Gatekeeper assessment. Notarization acceptance reports remain in the
output directory for the release operator.

The builder records each artifact's SHA256 before submission. If the build
fails, it retains the staging directory and prints its path so the signed app
and any pending notarization request can be recovered. Check an existing
submission's status before submitting the same artifact again.

Store credentials using `xcrun notarytool store-credentials` on the build host.
Never commit the certificate, private key, App Store Connect key, or notarization
credentials. The release workflow needs only a public identity name and the
Keychain profile's label.
