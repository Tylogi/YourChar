<#
.SYNOPSIS
  Builds YourChar-Setup-<version>.exe, the single Windows installer file.

.DESCRIPTION
  Stages the launcher (packaging/windows/launcher) and the WSL payload
  (scripts/build-wsl-release.sh) into installer/stage, generates the installer
  script from YourChar.iss and compiles it with ISCC:

    out/YourChar-Setup-<version>.exe

  The result is a per-user installer: no administrator rights, install into
  %LOCALAPPDATA%\Programs\YourChar, Start Menu and desktop shortcuts, and an
  entry in Apps & Features with an uninstaller that asks whether to keep the
  user's data.

.PARAMETER PayloadDir
  Directory holding the WSL payload built by scripts/build-wsl-release.sh
  (the repository's release/ directory by default).

.PARAMETER LauncherDir
  Directory holding YourChar.exe from packaging/windows/launcher/build.ps1.
  The launcher is built automatically when the executable is missing.

.PARAMETER OutDir
  Directory that receives the setup executable (installer/out by default).

.PARAMETER IsccPath
  Path to ISCC.exe. Defaults to $env:YOURCHAR_ISCC and then the usual install
  locations. See README.md for obtaining Inno Setup without installing it.

.PARAMETER Version
  Version stamped into the installer and its file name. Defaults to the version
  in the payload file name.
#>
[CmdletBinding()]
param(
  [string]$PayloadDir,
  [string]$LauncherDir,
  [string]$OutDir,
  [string]$IsccPath,
  [string]$Version
)

$ErrorActionPreference = 'Stop'

# $PSScriptRoot is empty when this file is invoked through a UNC path, so resolve
# the script directory defensively before deriving the default paths from it.
$scriptDirectory = $PSScriptRoot
if (-not $scriptDirectory) { $scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path }
# packaging/windows/installer -> three levels up is the repository root, where
# scripts/build-wsl-release.sh writes release/ by default.
if (-not $PayloadDir) { $PayloadDir = Join-Path $scriptDirectory '..\..\..\release' }
if (-not $LauncherDir) { $LauncherDir = Join-Path $scriptDirectory '..\launcher\out' }
if (-not $OutDir) { $OutDir = Join-Path $scriptDirectory 'out' }
$stageDirectory = Join-Path $scriptDirectory 'stage'

function Find-Iscc {
  if ($IsccPath) {
    if (-not (Test-Path -LiteralPath $IsccPath)) { throw "ISCC.exe not found at $IsccPath." }
    return $IsccPath
  }
  if ($env:YOURCHAR_ISCC -and (Test-Path -LiteralPath $env:YOURCHAR_ISCC)) { return $env:YOURCHAR_ISCC }
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  throw 'ISCC.exe was not found. Set $env:YOURCHAR_ISCC, or see packaging/windows/installer/README.md for the portable Inno Setup download.'
}

function Stage-File([string]$source, [string]$destination) {
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
  try {
    # Hard links keep the 300 MB payload from being copied twice when the
    # payload and the staging directory share a volume.
    New-Item -ItemType HardLink -Path $destination -Target $source -ErrorAction Stop | Out-Null
    return
  } catch { }
  Copy-Item -LiteralPath $source -Destination $destination
}

# 1. The launcher that the shortcuts point at. Always recompile: an existing
#    YourChar.exe says nothing about whether it still matches YourChar.cs, so a build
#    that reuses it would ship a stale launcher inside a fresh installer.
$launcher = Join-Path $LauncherDir 'YourChar.exe'
Write-Host 'compiling the launcher'
& (Join-Path $scriptDirectory '..\launcher\build.ps1') -SkipPayload -OutDir $LauncherDir

# 2. The WSL payload that YourChar.exe imports on first run.
. (Join-Path $scriptDirectory '..\payload-selection.ps1')
$payload = Select-LatestPayload -PayloadDir $PayloadDir
if (-not $payload) {
  throw "No WSL payload found in $PayloadDir. Run 'bash scripts/build-wsl-release.sh' first."
}
if (-not $Version) {
  $payloadVersion = Get-YourCharPayloadVersion -Name $payload.Name
  if ($null -eq $payloadVersion) { throw "Cannot read a version out of $($payload.Name); pass -Version." }
  $Version = $payloadVersion.ToString()
}

# 3. Stage what the installer ships, with the digest manifest the launcher
#    checks before it imports anything.
if (Test-Path -LiteralPath $stageDirectory) { Remove-Item -LiteralPath $stageDirectory -Recurse -Force }
$runtimeDir = Join-Path $stageDirectory 'runtime'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
Stage-File $launcher (Join-Path $stageDirectory 'YourChar.exe')
Stage-File $payload.FullName (Join-Path $runtimeDir $payload.Name)
$sums = Join-Path $PayloadDir 'SHA256SUMS.txt'
if (Test-Path -LiteralPath $sums) { Stage-File $sums (Join-Path $runtimeDir 'SHA256SUMS.txt') }

$digest = (Get-FileHash -LiteralPath $payload.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$listed = ''
if (Test-Path -LiteralPath $sums) {
  $line = Select-String -LiteralPath $sums -Pattern ([regex]::Escape($payload.Name)) | Select-Object -First 1
  if ($line) { $listed = $line.Line }
}
if (-not $listed) { throw "SHA256SUMS.txt does not list $($payload.Name)." }
if ($listed -notmatch [regex]::Escape($digest)) {
  throw "SHA256SUMS.txt does not match the payload digest ($digest)."
}

# 4. Compile.
$iscc = Find-Iscc
$template = Get-Content -LiteralPath (Join-Path $scriptDirectory 'YourChar.iss') -Raw
$generated = $template.Replace('@@VERSION@@', $Version).Replace('@@STAGE@@', $stageDirectory).Replace('@@OUTPUTDIR@@', $OutDir)
$iss = Join-Path $stageDirectory 'YourChar.iss'
[System.IO.File]::WriteAllText($iss, $generated, (New-Object System.Text.UTF8Encoding($false)))

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
& $iscc '/Q' $iss
if ($LASTEXITCODE -ne 0) { throw 'Compiling the installer failed.' }

$setup = Join-Path $OutDir ("YourChar-Setup-{0}.exe" -f $Version)
if (-not (Test-Path -LiteralPath $setup)) { throw "The installer was not produced at $setup." }
$setupDigest = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
'{0}  {1}' -f $setupDigest, (Split-Path -Leaf $setup) |
  Set-Content -LiteralPath (Join-Path $OutDir 'SHA256SUMS.txt') -Encoding ascii

Write-Host ("installer: {0} ({1:N0} bytes)" -f $setup, (Get-Item -LiteralPath $setup).Length)
Write-Host ("sha256:    {0}" -f $setupDigest)
Write-Host ("payload:   {0} ({1:N0} bytes)" -f $payload.Name, $payload.Length)
Write-Host ("launcher:  {0} ({1:N0} bytes)" -f 'YourChar.exe', (Get-Item -LiteralPath $launcher).Length)
Write-Host ''
Write-Host 'Give this single file to a user:'
Write-Host ("  {0}" -f (Split-Path -Leaf $setup))
