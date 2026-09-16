# MinerU Document MCP

MinerU support is an optional, explicitly enabled document-processing capability. It complements the local `officeparser` reader: `officeparser` performs lightweight conversion inside YourChar's network-isolated sandbox, while MinerU can preserve richer PDF layout, formulas, tables, and OCR through a separately operated API.

## Setup

1. Start a self-hosted MinerU FastAPI service that exposes `GET /health` and synchronous `POST /file_parse`.
2. Open **Settings → Document** and enter the service Base URL. A Bearer token is optional for deployments protected by a reverse proxy.
3. Choose the MinerU backend, parse method, language, formula/table policy, and timeout, then test the connection. The default timeout is 600 seconds for CPU-hosted services; the MCP transport adds a 30-second outer grace period instead of using the SDK's 60-second default.
4. Open **Management → Agent** and enable **MinerU Document MCP**.
5. Give the Agent at least read-only Workspace access. The tool is absent when Workspace access is off.

The current integration targets MinerU's self-hosted synchronous multipart API. It uploads one document in the `files` form field and requests Markdown output from `/file_parse`. Supported Workspace inputs are PDF, PNG, JPEG, DOCX, PPTX, and XLSX, with a 20 MiB limit.

## Trust and privacy boundary

- Saving an endpoint does not enable the MCP. The module switch and Workspace permission are independent gates.
- The model can select only a Workspace-relative file and a bounded Markdown line range. It cannot provide a URL, credential, backend, language, or parse policy.
- A tool call sends the entire selected document to the configured endpoint. The endpoint can be local, LAN, or remote, so operators must treat it as a document-data processor.
- Normal and secret conversations use their own scoped Workspace. Incognito sessions never receive the MinerU tool.
- Returned Markdown is bounded and wrapped as untrusted data. The complete normalized Markdown and validated extracted images are atomically published as `tmp/mineru/<managed-document>/document.md` plus `images/`, so relative Markdown image links remain usable without another API call.
- Image responses are bounded to 512 files, 10 MiB per image, and 48 MiB decoded total. Only PNG, JPEG, GIF, and WebP data URLs whose filename, MIME type, and file signature agree are accepted. Unsafe names, collisions, missing referenced images, or partial packages fail closed.
- Managed MinerU document packages have hash-based names and a 24-hour TTL. Cleanup runs on startup/first access, after use, and hourly for registered Workspaces. It deletes only packages owned by this integration and never clears unrelated `tmp/mineru/` content.
- When Vision MCP is enabled, the Agent can pass an extracted image from a managed MinerU package to `analyze_image`; the existing normal/secret Workspace scope remains enforced.
- Audits retain hashes, byte counts, backend, cache status, and returned character counts; they do not retain the path, document body, endpoint token, or returned Markdown.

The settings file is `mineru.json` under the active YourChar state directory. It is mode `0600` and may contain a Bearer token. Verified backups include it and mark its presence without copying the credential into the manifest.

## API

- `GET /api/settings/mineru`
- `PATCH /api/settings/mineru`
- `POST /api/v1/diagnostics/mineru/test`

Both mutation endpoints require YourChar's same-origin local control capability and JSON requests. The diagnostic tests `/health`; it does not upload a document.
