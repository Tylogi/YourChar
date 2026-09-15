# Contributing to YourChar

[Project overview](README.md) · [中文介绍](README.zh-CN.md) · [Documentation](docs/README.md)

Useful contributions include a reproducible model-compatibility report, a
clearer first-run guide, translations, UI/accessibility fixes, focused regression
tests, and capability or provider integrations. You can help without changing
the runtime.

## Start with a small change

1. Reproduce the problem or describe the use case in an issue on the repository host.
2. Work on a branch in your checkout or fork. Keep the change focused enough to review.
3. Explain the resulting behavior and include the checks you ran in the pull request.

For a larger feature, describe its user-facing behavior, required permissions,
and effect on existing state so reviewers can assess the proposal.
The [completed modernization plan](docs/agent-runtime-modernization-plan.md)
explains the current extension points; it is a record of completed work.

## Development setup

Use Node.js 22.19.0 or newer; `.nvmrc` pins the development baseline.
From the repository root:

```bash
npm ci
npm run build
npm run dev
```

For the optional document worker and Linux sandbox prerequisites, follow
[Operations](docs/operations.md). Use a separate `YOURCHAR_STATE_DIR` for manual
development if your usual YourChar instance contains personal data.

## Find your way around

| Area | Entry points |
| --- | --- |
| Product behavior and durable state | `src/domain/`, `src/storage/` |
| Pi sessions and capability lifecycle | `src/pi/`, `src/modules/` |
| Memory and context | `src/memory-vault/`, `src/memory-coordinator/`, `src/context/` |
| Provider transports and credentials | `src/model/` |
| Jobs, goals, and workflows | `src/execution/`, `src/goals/`, `src/workflows/` |
| Web UI and HTTP routes | `src/http/` |
| Headless clients and interoperability | `src/sdk/`, `src/acp/` |
| Event capture and replay | `src/runtime-events/` |
| Test fixtures and verification | `src/testing/`, `test/`, `eval-fixtures/` |

## Verify the change

For a documentation-only change, check local links, image rendering, and
`git diff --check`. For runtime changes, build and run the affected tests.
For example, to work on capability mounting:

```bash
npm run build
node --disable-warning=ExperimentalWarning --test dist/test/session-capability.test.js
```

`npm test` runs the full unit/integration suite. `npm run test:browser` exercises
the Web UI; CloakBrowser downloads Chromium on first use and may need system
libraries. See [the runtime reference](docs/runtime-reference.md#browser-checks).

Before a release, `npm run release:gate` runs the full local gate, including
browser workflows, sensitive-information scanning, and whitespace checks.
[Release gate](docs/release-gate.md) documents when real-model evaluation is
also needed; it uses separately configured model access.

## Make issues and pull requests easy to review

For a bug report, include the commit/version, operating system, Node version,
steps to reproduce, expected behavior, and observed behavior. For model-related
issues, include the provider/transport, model name, and relevant enabled tools.
Use a minimal, anonymized conversation or fixture where possible.

For a pull request, explain the problem, the resulting behavior, and the
validation performed. Add a screenshot for visible UI changes. Describe state
migrations or permission changes explicitly. Never include API keys, private
transcripts, personal state directories, or credential-bearing backups.
