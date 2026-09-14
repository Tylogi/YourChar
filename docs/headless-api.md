# Headless API and TypeScript SDK

YourChar exposes a process-authenticated automation surface at
`/api/headless/v1`. It is disabled unless the host configures a token, accepts
only loopback socket peers, and does not require the browser UI, an Origin
header, or the UI's HttpOnly control-plane cookie.

The browser surface remains at `/api/v1`. Headless requests pass through the
same router and Kernel methods, so session ownership, normal/secret/incognito
isolation, permission checks, lifecycle fencing, and error codes do not have a
second implementation.

## Enable it

Generate a random token of at least 32 characters and provide it only to the
YourChar process and its local automation client. One example for an ephemeral
development shell is:

```bash
export YOURCHAR_HEADLESS_API_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
npm run dev
```

`RP_AGENT_HEADLESS_API_TOKEN` remains a lower-precedence compatibility alias.
An explicitly supplied `headlessApiToken: false` in `createHttpServer` ignores
both environment variables. Invalid or ambiguous token configuration fails at
server construction. Token rotation is a host operation: replace the process
environment value and restart YourChar. There is no endpoint that returns or
changes the token.

The listener must still use a literal loopback address. Bearer authentication
does not make the browser UI safe to expose on a remote interface, and the
server rejects non-loopback peers before comparing credentials.

## Raw HTTP contract

Send one exact `Authorization` header. For example:

```bash
curl \
  -H "Authorization: Bearer ${YOURCHAR_HEADLESS_API_TOKEN}" \
  http://127.0.0.1:8765/api/headless/v1/sessions
```

Every response from this namespace includes `X-YourChar-Api-Version: 1` and is
non-cacheable. `/api/headless/v1/<resource>` maps only to the corresponding
`/api/v1/<resource>` contract. It cannot reach `/api/debug`, `/api/settings`,
or `/api/_test` by path rewriting.

The existing v1 resources include:

| Capability | Headless v1 paths |
| --- | --- |
| Sessions and lifecycle | `/sessions`, `/sessions/{id}/messages`, `/archive`, `/restore`, and session metadata/delete routes |
| Streaming turns | `/sessions/{id}/messages/stream`, `/messages/cancel`, and `/messages/retry` |
| Durable jobs | `/sessions/{id}/execution-jobs/*` and `/subagent-jobs/*` |
| Goals and todos | `/sessions/{id}/goals/*` |
| Workflow DAGs | `/sessions/{id}/workflows/*` |
| Files | `/workspace/files/*` and `/sessions/{id}/workspace/files/*` |
| Host lifecycle policy | `/agent-permissions`, module/profile routes, and other existing v1 control-plane resources |

Sensitive JSON mutations still require `Content-Type: application/json`. The
authenticated headless boundary substitutes only for the browser-specific
Origin, Fetch Metadata, and HttpOnly-cookie checks; it does not bypass domain
permissions.

### Stable boundary errors

Authentication and replay failures use the normal JSON error envelope:

```json
{
  "code": "HEADLESS_API_AUTH_REQUIRED",
  "error": "a valid Bearer token is required"
}
```

Boundary codes are stable within v1:

- `HEADLESS_API_DISABLED` (`503`)
- `HEADLESS_API_REMOTE_PEER_REJECTED` (`403`)
- `HEADLESS_API_AUTH_REQUIRED` (`401`)
- `HEADLESS_IDEMPOTENCY_KEY_INVALID` (`400`)
- `HEADLESS_IDEMPOTENCY_CONFLICT` (`409`)
- `HEADLESS_IDEMPOTENCY_UNSUPPORTED` (`422`)
- `HEADLESS_IDEMPOTENCY_BODY_TOO_LARGE` (`413`)

Domain error codes are identical to those returned by `/api/v1`.

### Idempotent mutations

An `Idempotency-Key` protects an authenticated JSON mutation from duplicate
execution. Concurrent or later identical requests receive the original status
and JSON body with `Idempotency-Replayed: true`. Reusing a key with a different
method, path, query, or request body fails with `409`.

The replay cache is deliberately process-local and bounded to a ten-minute
window, 512 entries, 16 MiB total, and 2 MiB per response. Durable jobs, goals,
and workflows retain their own persisted lifecycle across restarts; the HTTP
cache covers transport retries, not durable resource identity. Streaming turns
and binary uploads reject an idempotency key. For a stream, use an
`AbortSignal`, the explicit cancel endpoint, and the resulting durable session
state.

## TypeScript SDK

The hand-maintained SDK is exported as `yourchar/sdk` (and from the root package
entry point). Its compiled declaration entry is `dist/src/sdk/index.d.ts`.

```ts
import {
  createIdempotencyKey,
  YourCharClient,
} from "yourchar/sdk";

const client = new YourCharClient({
  baseUrl: "http://127.0.0.1:8765",
  token: process.env.YOURCHAR_HEADLESS_API_TOKEN!,
});

const goals = await client.listGoals("session-id");
const goal = await client.createGoal(
  "session-id",
  {
    title: "Ship the change",
    successCriteria: "Release gate passes",
  },
  { idempotencyKey: createIdempotencyKey("goal") },
);
```

The client rejects non-loopback base URLs and redirects so a token is not sent
to another origin. All responses are checked for the v1 header before payloads
are exposed.

### Streaming and cancellation

`streamMessage` returns a validated async iterable. Its discriminated event
schema includes `delta`, `reasoning_status`, `tool_start`, `tool_end`,
`auto_retry_start`, `auto_retry_end`, `lifecycle`, `done`, and `error`.

```ts
const controller = new AbortController();

for await (const event of client.streamMessage(
  "session-id",
  { text: "Inspect the project" },
  { signal: controller.signal },
)) {
  if (event.type === "delta") process.stdout.write(event.delta);
  if (event.type === "done") console.log(event.response.status);
}
```

Aborting the signal closes the transport; the HTTP adapter propagates that
closure to the Kernel's model/tool cancellation signal. `cancelMessage`,
`interruptExecutionJob`, `interruptSubagentJob`, and `cancelWorkflow` expose
the corresponding explicit lifecycle controls.

### Pagination

`getMessageHistory` and `iterateMessageHistory` use stable message anchors,
while `getExecutionOutput` and `iterateExecutionOutput` use monotonic output
cursors. Iterators fail with `YourCharProtocolError` rather than looping if a
server returns a non-advancing cursor.

### Error classes

The SDK maps the JSON envelope into stable classes:

- `YourCharAuthenticationError`
- `YourCharValidationError`
- `YourCharConflictError`
- `YourCharNotFoundError`
- `YourCharApiError`
- `YourCharAbortError`
- `YourCharTransportError`
- `YourCharProtocolError`

API errors retain the HTTP `status`, server `apiCode`, and bounded structured
`details`. Transport/protocol errors never include the Bearer token.

## Contract verification

`test/headless-contract.test.ts` runs one goal/todo/workflow lifecycle through
the Kernel, raw authenticated HTTP, and the SDK. It compares their canonical
projections and verifies the same cross-session ownership denial, Shell
permission denial, and archived-session lifecycle fence on all three surfaces.
Authentication, replay, streaming, pagination, file, and error-schema coverage
lives in `test/headless-api.test.ts` and `test/sdk-client.test.ts`.
