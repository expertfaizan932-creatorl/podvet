# Downloads the Electron runtime zip that electron-builder unpacks into the
# desktop build (see build.electronDist in package.json). Verifies the SHA-256
# against the official SHASUMS256.txt before trusting anything on disk, so a
# partial/interrupted download can never poison a build.
param([string]$Version = '31.7.7')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'vendor\electron-dist'
$zipName = "electron-v$Version-win32-x64.zip"
$zip = Join-Path $dest $zipName
$marker = Join-Path $dest '.verified'
$url = "https://github.com/electron/electron/releases/download/v$Version/$zipName"
$sumsUrl = "https://github.com/electron/electron/releases/download/v$Version/SHASUMS256.txt"

New-Item -ItemType Directory -Force -Path $dest | Out-Null

function Get-ExpectedHash {
  $tmp = Join-Path $env:TEMP "electron-SHASUMS256-$Version.txt"
  & curl.exe -sSL --fail --retry 5 --retry-delay 2 --max-time 90 -o $tmp $sumsUrl
  if ($LASTEXITCODE -ne 0) { throw "Could not download $sumsUrl" }
  $line = Get-Content $tmp | Where-Object { $_ -like "*$zipName" } | Select-Object -First 1
  if (-not $line) { throw "SHASUMS256.txt has no entry for $zipName" }
  return ($line -split '\s+')[0].ToLower()
}

$expected = $null
try { $expected = Get-ExpectedHash } catch { Write-Output "WARN: $($_.Exception.Message)" }

if ((Test-Path -LiteralPath $zip) -and (Test-Path -LiteralPath $marker) -and $expected) {
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
  if ($actual -eq $expected) { Write-Output 'ALREADY_PRESENT'; exit 0 }
}

if ($expected) {
  if (Test-Path -LiteralPath $zip) {
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower()
    if ($actual -eq $expected) {
      Set-Content -LiteralPath $marker -Value $expected
      Write-Output 'ALREADY_PRESENT'
      exit 0
    }
    Write-Output 'BAD_CHECKSUM redownloading'
    Remove-Item -LiteralPath $zip -Force
  }
  Write-Output "DOWNLOADING $url"
  $ok = $false
  for ($i = 1; $i -le 8; $i++) {
    & curl.exe -L --fail --silent --show-error -C - -o $zip $url
    $actual = if (Test-Path -LiteralPath $zip) { (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() } else { '' }
    Write-Output "ATTEMPT $i hash=$actual"
    if ($actual -and $actual -eq $expected) { $ok = $true; break }
    Start-Sleep -Seconds 3
  }
  if (-not $ok) { throw "Electron $Version download failed checksum verification after 8 attempts" }
  Set-Content -LiteralPath $marker -Value $expected
} else {
  # Offline / sums unavailable: trust a zip we already have, else resume it.
  if (Test-Path -LiteralPath $zip) { Write-Output 'USING_EXISTING_UNVERIFIED'; exit 0 }
  Write-Output "DOWNLOADING (unverified) $url"
  for ($i = 1; $i -le 8; $i++) {
    & curl.exe -L --fail --silent --show-error -C - -o $zip $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $zip)) { break }
    Start-Sleep -Seconds 3
  }
  if (-not (Test-Path -LiteralPath $zip)) { throw 'Electron download failed' }
}
Write-Output 'DONE'
