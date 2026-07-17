# Vision MCP

## Purpose

RP Agent supports image understanding even when the primary conversation model
is text-only. Image handling is an optional built-in module with an independent
OpenAI-compatible vision endpoint and an explicit primary-model capability flag.

## Modes

| Mode | Behavior |
| --- | --- |
| `auto` | Send images directly when the primary model is marked vision-capable; otherwise run independent pre-analysis. |
| `direct` | Send image blocks only to a primary model marked vision-capable. |
| `mcp` | Always pre-analyze with the configured Vision endpoint. |
| `off` | Do not inspect pixels or expose the Vision tool. |

The `mcp:vision` module switch is the outer capability boundary. Disabling it
turns off direct and independent image processing while retaining configuration
and cached analyses.

## Turn flow

1. Chat uploads files into `workspace/uploads` and sends structured attachment
   metadata with the message request.
2. The trusted workspace service resolves the relative path, rejects symlinks
   and paths outside `uploads/`, and verifies the raster file signature.
3. Direct mode creates Pi `ImageContent` blocks on the user prompt.
4. MCP mode calls the independent vision endpoint before the primary model.
5. Structured `summary`, `observations`, `ocr`, and `uncertainties` are inserted
   into the current hidden turn context as untrusted data. Stable system context
   is unchanged, preserving the reusable provider prefix.
6. Automatic analysis emits ordinary tool start/end events, so the chat UI shows
   `分析图片` inside the collapsed execution progress.
7. When a recent upload was recorded only as a Workspace path (for example,
   vision capability was enabled after that turn), an immediate image-reference
   follow-up may recover and resend it once. Existing historical image blocks are
   never duplicated.

The model-facing `analyze_image` MCP tool remains available for focused follow-up
questions. It accepts only workspace-relative image paths under `uploads/`.

## Configuration and APIs

- `GET/PATCH /api/settings/vision`
- `GET /api/v1/diagnostics/vision/models`
- `POST /api/v1/diagnostics/vision/test`
- Primary model flag: `visionInputEnabled` in `GET/PATCH /api/settings/model-api`

Vision configuration is stored in private `vision.json`. HTTP responses expose
only the masked Key. Operational backup includes this file and marks the backup
manifest as containing Vision credentials.

## Cache and limits

Analysis cache keys include prompt version, image SHA-256, model, question,
detail, and requested features. The cache is bounded to 200 entries. A turn may
process at most the configured `maxImages` value, constrained to `1..8`; each
upload is constrained by the workspace 20 MiB limit.

Supported formats are PNG, JPEG, GIF, and WebP. SVG is deliberately excluded
from model image input because it is executable text rather than trusted raster
content.

## Security contract

- Image paths never grant general host or workspace file access.
- File extensions are insufficient; a supported binary signature is required.
- Image text, OCR, and vision-model output are untrusted data.
- The vision endpoint Key is never placed in Agent context, tool results, or
  audit payloads.
- Independent analysis failures degrade to an explicit unavailable result; they
  do not create application mutations.
- Analysis actions are read-only, so failed primary-model turns remain eligible
  for retry and message revision.

## Verification

`test/vision-mcp.test.ts` covers path boundaries, signature validation,
credential masking, model discovery, cache hits, SSE tool events, MCP exposure,
hidden-context injection, direct image input, and recent-upload recovery.
`test/model-settings.test.ts` verifies direct Pi image input reaches an
OpenAI-compatible request. The browser suite verifies the desktop, compact, and
mobile settings layouts.
