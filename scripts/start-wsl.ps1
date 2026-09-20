param(
  [Parameter(Mandatory = $true)][string]$ProjectPath,
  [string]$Distribution,
  [switch]$Check
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
# Avoid passing shell source/JSON through Windows native argument quoting.
$backendScript = $ProjectPath.TrimEnd('/') + '/scripts/start-wsl-backend.sh'
$backendArgs = @()
if ($Check) { $backendArgs = @('--check') }
& $wslExecutable @distroArgs --exec /bin/bash $backendScript @backendArgs
exit $LASTEXITCODE
