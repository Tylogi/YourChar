# Choosing which payload archive to package is shared by the launcher and installer
# builds so both agree on what "newest" means. The version only exists in the file
# name, so it has to be compared as a version: a plain name sort orders 0.9.0 after
# 0.10.0 and would package the older runtime.

function Get-YourCharPayloadVersion {
  param([Parameter(Mandatory)][string]$Name)
  $match = [regex]::Match($Name, '^YourChar-(?<version>[0-9][^-]*)-wsl-amd64\.tar\.gz$')
  if (-not $match.Success) { return $null }
  $parsed = [Version]'0.0.0'
  if (-not [Version]::TryParse($match.Groups['version'].Value, [ref]$parsed)) { return $null }
  return $parsed
}

function Select-LatestPayload {
  param([Parameter(Mandatory)][string]$PayloadDir)
  $best = $null
  $bestVersion = $null
  foreach ($candidate in @(Get-ChildItem -LiteralPath $PayloadDir -Filter 'YourChar-*-wsl-amd64.tar.gz' -File -ErrorAction SilentlyContinue)) {
    $version = Get-YourCharPayloadVersion -Name $candidate.Name
    if ($null -eq $version) { continue }
    if (($null -eq $best) -or ($version -gt $bestVersion)) {
      $best = $candidate
      $bestVersion = $version
    }
  }
  return $best
}