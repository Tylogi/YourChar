# Native sandbox migration

Baseline: `2395fe5`; development branch: `feature/dsh-native-sandbox`.

## Accepted policy

- New installations give characters read/write access to their scoped Workspace.
  Existing explicit off/read-only choices remain authoritative. Shell stays off
  until enabled separately.
- Follow DeepSeek Harness's policy/provider separation and fail-closed execution.
  Do not import its complete Cordis runtime or advertise its write-only policy as
  protecting YourChar credentials.
- Host networking is acceptable for Shell. Network isolation is not a portable
  prerequisite. Preserve explicit legacy offline choices where the backend can
  enforce them; never claim an offline policy was enforced when it was not.
- Generic tools must not read private state, model credentials, other conversation
  Workspaces, or inherit the application's secret environment variables.
- Document conversion, LSP, and incognito retain their existing independent
  security boundaries. This Shell migration does not claim those are portable.

## Delivery checklist

- [x] Preserve the committed baseline and create an isolated development worktree.
- [x] Shared execution policy, functional backend probes, cancellation, and cleanup.
- [x] Linux Bubblewrap and macOS Seatbelt implementation with a file-read allowlist.
- [x] Implement an experimental Windows WSL2 transition backend. DSH's native WRITE_RESTRICTED
  token cannot enforce private-file read protection and must not be enabled as
  an equivalent substitute.
- [x] Route both foreground commands and durable background jobs through the
  provider; preserve cancellation, output limits, and auditing.
- [x] Default Workspace read/write, preserve explicit choices, and update UI,
  English translations, API behavior, and documentation.
- [x] Linux integration tests, platform-independent policy tests, permission
  and locale browser tests, full regression suite, and sensitive-information scan.
- [x] macOS native smoke tests on the build Mac; required before publishing a release.
- [ ] Windows/WSL2 end-to-end tests, including path translation and launcher loss.

## Verification and rollout

Validation on Linux (2026-09-19):

- TypeScript build passed.
- Full suite with `YOURCHAR_REQUIRE_NATIVE_SANDBOX=1`: **835 passed, 0 failed,
  0 skipped**. This includes the native release checks on Linux.
- Permission and Chinese/English locale browser checks passed.
- Sensitive-information scan passed (555 source files); `git diff --check` passed.
- The existing Linux service's readiness endpoint still reported `ready`.

Linux checks cover real Workspace read/write, read-only/off modes, private state
and sibling Workspace isolation, symlink escapes, a sealed environment, online
and offline networking, foreground cancellation, background jobs, and the WSL
lifetime supervisor. The latter runs on Linux and is not proof of Windows transport
behavior. A subprocess test verifies that an unsupported platform never falls
back to an unrestricted shell. Browser checks use mocked platform metadata for
the macOS UI branch; they do not establish native Seatbelt containment.

Validation on Apple Silicon, macOS 26.6.2, Node 22.19.0 (2026-09-20):

- `npm run test:macos`: **16 passed, 0 failed, 2 skipped**. The skips are the
  Linux-only Bubblewrap argument test and WSL supervisor test, not Seatbelt tests.
- The native gate covers real Workspace read/write, read-only/off permissions,
  private credential and sibling Workspace protection, symlink escape attempts,
  environment filtering, localhost networking, and process-group interruption.
- Five additional portable integration tests cover the foreground tool and
  durable background service: bounded/audited output, session-scoped pagination,
  timeout, cancellation, and retries with narrowed permissions.
- A separate live HTTPS smoke request to `https://example.com` returned **200**
  through the native provider with normal DNS resolution and certificate checking.
  External internet availability is deliberately not a unit-test dependency.
- An isolated fresh-state server reported `ready` and `shellSandbox: ok`, seeded
  the default Kurisu character, served the expected bundled avatar checksum, and
  exited cleanly on SIGTERM. No real model credentials or user state were loaded.
- The first run exposed a startup `SIGABRT`, then an external DNS failure. The
  fix permits reading the root directory itself and metadata on `/etc`, `/var`,
  and `/tmp` aliases. It does **not** grant recursive root reads, arbitrary home
  access, or additional Mach services. Isolation tests were rerun after both fixes.
- Tests run serially; validation used `NODE_OPTIONS=--max-old-space-size=2048`.
  The build-plus-gate invocation reported a maximum RSS of about **1.38 GiB**.
  No model inference was started.

The macOS gate includes actual native execution and fails if the backend is
unavailable. Running it on Linux exercises Bubblewrap, not Seatbelt. This is a
source-level validation on one macOS version, not a newly packaged, installed,
signed, or published release. Existing installed app and user data were preserved;
old build copies were moved into a recoverable archive before testing.

After the macOS fixes, the Linux full suite was rerun with
`YOURCHAR_REQUIRE_NATIVE_SANDBOX=1`: **840 passed, 0 failed, 0 skipped**.
The sensitive-information scan passed (556 source files), `git diff --check`
passed, and the existing Linux service still reported `ready`.

No Windows test host was available. Windows/WSL2 end-to-end validation is the one
remaining checklist item; the Linux supervisor test does not close that item.

Work is isolated on the development branch. The existing main checkout and
running Linux service remain unchanged. Document conversion, LSP, and incognito
are adapted in the separate [cross-platform workers plan](cross-platform-workers-plan.md).
The evidence above describes the original Shell milestone, not the newer worker gate.

## Upstream references

- [DSH process sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md)
- [DSH platform policies](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/src/profiles.ts)
- [DSH Windows limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md)

This is an adaptation of the architecture, not a wholesale dependency replacement.
Landlock write-only fallbacks and Windows write-only ACL tokens are not sufficient
for the additional read boundary. Unavailable backends fail closed; implementation
does not imply real-machine verification on every platform.
