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
- [ ] macOS native smoke tests on the build Mac; required before publishing a release.
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

The macOS gate includes the actual native sandbox tests and fails if the backend
is unavailable. Running this command on Linux exercises Bubblewrap, not Seatbelt.
Mac SSH connection attempts timed out at the proxy during this implementation;
no remote files, service, or release were changed. No Windows test host was
available. Both real-machine checks above remain open, and no Mac release should
be published from this change until the native gate passes there.

Work is isolated on the development branch. The existing main checkout and
running Linux service remain unchanged. Document conversion, LSP, and incognito
still have Linux-only prerequisites; they are separate follow-up migrations.

## Upstream references

- [DSH process sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/sandbox.md)
- [DSH platform policies](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-local/src/profiles.ts)
- [DSH Windows limitations](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md)

This is an adaptation of the architecture, not a wholesale dependency replacement.
Landlock write-only fallbacks and Windows write-only ACL tokens are not sufficient
for the additional read boundary. Unavailable backends fail closed; implementation
does not imply real-machine verification on every platform.
