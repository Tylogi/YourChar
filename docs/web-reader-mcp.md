# Web Reader MCP

## Purpose

Web Reader fills the gap between search snippets and a full interactive browser.
When `mcp:web-reader` is enabled, private Pi sessions and read-only subagents get
one tool:

- `read_web_page(url, maxCharacters?)`

The tool fetches one public HTTP(S) resource and returns its readable text,
title, final URL, content type, and truncation status. It does not execute
JavaScript, click, submit forms, authenticate, retain cookies, or download
files. Group-chat actors do not receive it.

Tavily Search and Web Reader have separate roles. Search discovers and ranks
URLs. Web Reader opens one selected URL when its snippet is insufficient.
Neither capability is a visual browser; CloakBrowser remains the development
and UI-testing surface for screenshots and interactive pages.

## Security contract

Every initial URL and redirect is validated independently:

- only `http:` and `https:` are accepted;
- URL credentials and ports other than 80 and 443 are rejected;
- localhost, private, loopback, link-local, multicast, reserved, and special-use
  addresses are blocked;
- DNS results are validated and pinned into the TLS connection;
- a hostname must have at least one public address;
- Clash-style TUN synthetic addresses in `198.18.0.0/15` are accepted only when
  the same hostname also has a public answer; literal and private-only targets
  remain blocked;
- redirects are manual and limited to five hops;
- each request is limited to 15 seconds and 2 MiB;
- only HTML, XHTML, plain text, and JSON are accepted;
- extracted output defaults to 12,000 and is capped at 40,000 characters.

HTML is parsed with a DOM and Mozilla Readability. Scripts are never executed.
Tool output is wrapped in `[untrusted_web_page]`; page text cannot modify system
policy, permissions, realm boundaries, or tool behavior. Audit actions retain
the hostname and SHA-256 of the URL, not the URL itself.

The module is disabled by default. It is managed through the existing
Management page and `PATCH /api/v1/agent-modules/mcp%3Aweb-reader`.

## Test contract

`test/web-reader-mcp.test.ts` covers readable extraction, script exclusion,
private-address rejection, redirect pivots, credentials, nonstandard ports,
MIME and size limits, TUN DNS compatibility, Pi tool registration, untrusted
tool-result framing, and credential-safe audit payloads.

A production smoke test may call `WebReaderService.read()` for a known public
page. Unit tests never require the public internet.

