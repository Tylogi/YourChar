<#
.SYNOPSIS
  Builds YourChar.exe, the double-click entry point for ordinary Windows users.

.DESCRIPTION
  Compiles packaging/windows/launcher/YourChar.cs with the C# compiler that ships
  with Windows and stages the WSL payload next to it:

    out/YourChar.exe
    out/runtime/YourChar-<version>-wsl-amd64.tar.gz
    out/runtime/SHA256SUMS.txt

  No SDK, NuGet package or network access is required, and end users install
  nothing: .NET Framework 4.8 is part of Windows 10 1903+ and Windows 11.

.PARAMETER PayloadDir
  Directory holding the WSL payload built by scripts/build-wsl-release.sh
  (the repository's release/ directory by default).

.PARAMETER OutDir
  Directory that receives the launcher and a staged copy of the WSL payload.

.PARAMETER SkipPayload
  Compile the launcher only; do not stage or verify the WSL payload.
#>
[CmdletBinding()]
param(
  [string]$PayloadDir,
  [string]$OutDir,
  [switch]$SkipPayload
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is empty when this file is invoked through a UNC path, so resolve
# the script directory defensively before deriving the default paths from it.
$scriptDirectory = $PSScriptRoot
if (-not $scriptDirectory) { $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $PayloadDir) { $PayloadDir = Join-Path $scriptDirectory '..\..\release' }
if (-not $OutDir) { $OutDir = Join-Path $scriptDirectory 'out' }

$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "The in-box C# compiler was not found at $compiler."
}

function Stage-File([string]$source, [string]$destination) {
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
  try {
    # Hard links keep the 300 MB payload from being duplicated when the payload
    # and the output directory share a volume.
    New-Item -ItemType HardLink -Path $destination -Target $source -ErrorAction Stop | Out-Null
    return
  } catch { }
  Copy-Item -LiteralPath $source -Destination $destination
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$exe = Join-Path $OutDir 'YourChar.exe'

& $compiler /nologo /target:winexe /optimize+ /out:$exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll (Join-Path $scriptDirectory 'YourChar.cs')
if ($LASTEXITCODE -ne 0) { throw 'Compiling the launcher failed.' }

Write-Host ("launcher: {0} ({1:N0} bytes)" -f $exe, (Get-Item -LiteralPath $exe).Length)

if ($SkipPayload) { return }

$payload = Get-ChildItem -LiteralPath $PayloadDir -Filter 'YourChar-*-wsl-amd64.tar.gz' -ErrorAction SilentlyContinue |
  Sort-Object Name | Select-Object -Last 1
if (-not $payload) {
  throw "No WSL payload found in $PayloadDir. Run 'bash scripts/build-wsl-release.sh' first."
}
$sums = Join-Path $PayloadDir 'SHA256SUMS.txt'

$runtimeDir = Join-Path $OutDir 'runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Stage-File $payload.FullName (Join-Path $runtimeDir $payload.Name)
if (Test-Path -LiteralPath $sums) { Stage-File $sums (Join-Path $runtimeDir 'SHA256SUMS.txt') }

$digest = (Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$listed = ''
if (Test-Path -LiteralPath $sums) {
  $line = Select-String -LiteralPath $sums -Pattern ([regex]::Escape($payload.Name)) | Select-Object -First 1
  if ($line) { $listed = $line.Line }
}
if ($listed -and ($listed -notmatch [regex]::Escape($digest))) {
  Write-Warning 'SHA256SUMS.txt does not match the payload digest; YourChar.exe will refuse to import it.'
}

Write-Host ("payload:  {0} ({1:N0} bytes)" -f $payload.Name, $payload.Length)
Write-Host ("sha256:   {0}" -f $digest)
Write-Host ''
Write-Host 'Ship this folder as a whole:'
Write-Host '  YourChar.exe'
Write-Host ("  runtime\{0}" -f $payload.Name)
Write-Host '  runtime\SHA256SUMS.txt'
