#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd -- "$project_root"
case "$project_root" in /mnt/*) echo 'Keep the project on the WSL Linux filesystem, not a Windows drive.' >&2; exit 1;; esac
case "${YOURCHAR_STATE_DIR:-}" in /mnt/*) echo 'Keep YourChar state on the WSL Linux filesystem.' >&2; exit 1;; esac
command -v node >/dev/null || { echo 'Install Linux Node.js 22.19+ inside WSL2.' >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number);if(process.platform!=="linux" || major<22 || (major===22 && minor<19)) throw Error("Linux Node.js 22.19+ is required");'
test -x /usr/bin/bwrap || { echo 'Install bubblewrap inside this WSL2 distribution.' >&2; exit 1; }
test -f dist/src/server.js || { echo 'Run npm ci && npm run setup:markitdown && npm run build inside WSL2.' >&2; exit 1; }
node --input-type=module -e '
import { offlineWorkerAvailable } from "./dist/src/execution/offline-worker.js";
import { assertMemoryBacked } from "./dist/src/execution/memory-directory.js";
import { DocumentConversionService } from "./dist/src/document/service.js";
assertMemoryBacked("/dev/shm");
if(!offlineWorkerAvailable() || !new DocumentConversionService().isAvailable()) throw Error("Worker preflight failed: check Bubblewrap and npm run setup:markitdown");
'
if [[ "${1:-}" == "--check" ]]; then
  echo 'YourChar WSL worker preflight passed.'
  exit 0
fi
export HOST=127.0.0.1
exec node --disable-warning=ExperimentalWarning dist/src/server.js
