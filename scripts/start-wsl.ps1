param(
  [Parameter(Mandatory = $true)][string]$ProjectPath,
  [string]$Distribution
)
$ErrorActionPreference = 'Stop'
# Run all three worker families in the same Linux backend. Never attempt to
# execute Windows node.exe/python.exe inside a Linux filesystem sandbox.
if (-not $ProjectPath.StartsWith('/') -or $ProjectPath.Contains("`n") -or $ProjectPath.Contains("`r")) {
  throw 'ProjectPath must be an absolute Linux project path inside WSL2.'
}
$wslExecutable = Join-Path $env:SystemRoot 'System32\wsl.exe'
$distroArgs = @()
if ($Distribution) { $distroArgs = @('--distribution', $Distribution) }
$kernel = & $wslExecutable @distroArgs --exec /usr/bin/uname -r
if ($LASTEXITCODE -ne 0 -or $kernel -notmatch '(WSL2|microsoft-standard)') {
  throw 'A running WSL2 distribution is required. Install WSL2 and select its distribution first.'
}
$preflight = @'
set -eu
cd -- "$1"
case "$PWD" in /mnt/*) echo 'Keep the project and state on the Linux filesystem, not /mnt Windows drives.' >&2; exit 1;; esac
command -v node >/dev/null || { echo 'Install Linux Node.js 22.19+ inside WSL2.' >&2; exit 1; }
node -e 'if(process.platform!=="linux" || Number(process.versions.node.split(".")[0])<22) process.exit(1)'
test -x /usr/bin/bwrap || { echo 'Install bubblewrap inside this WSL2 distribution.' >&2; exit 1; }
test -f dist/src/server.js || { echo 'Run npm ci && npm run setup:markitdown && npm run build inside WSL2.' >&2; exit 1; }
node --input-type=module -e 'import { offlineWorkerAvailable } from "./dist/src/execution/offline-worker.js"; import { assertMemoryBacked } from "./dist/src/execution/memory-directory.js"; import { DocumentConversionService } from "./dist/src/document/service.js"; assertMemoryBacked("/dev/shm"); if(!offlineWorkerAvailable() || !new DocumentConversionService().isAvailable()) throw Error("Worker preflight failed: check Bubblewrap and npm run setup:markitdown");'
export HOST=127.0.0.1
exec node --disable-warning=ExperimentalWarning dist/src/server.js
'@
& $wslExecutable @distroArgs --exec /bin/bash --noprofile --norc -c $preflight yourchar-wsl $ProjectPath
exit $LASTEXITCODE
