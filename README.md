# RP Agent

Fresh TypeScript rewrite of the RP companion agent kernel.

The codebase now starts from a Pi-style harness shape:

- provider-neutral agent messages;
- structured lifecycle events;
- model-driven tool calls;
- deterministic tool execution boundary;
- host-owned session state;
- thin HTTP server as an adapter, not the core.

## Commands

```bash
npm install
npm test
npm run build
npm run dev
```

Default dev server:

```text
http://127.0.0.1:8765
```

## Current Scope

This is a clean baseline, not a port of the previous Python implementation.
It includes a minimal in-memory companion kernel with `sms` and `rp` modes,
reminder creation, memory writes, lifecycle events, and a JSON HTTP API.

The old Python implementation was intentionally removed from the working tree.
It remains available through Git history.
