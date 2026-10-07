# Builds the Windows installer and publishes it to the website's auto-update
# feed (https://podvet.biztrack.uk/updates/). Installed copies of PodVet pick
# the new version up on their next check.
#
#   npm run release              build, then upload
#   npm run release -SkipBuild   upload what is already in dist/
#
# The token is read from UPDATES_PUBLISH_TOKEN in the environment, or from
# UPDATES_PUBLISH_TOKEN=... in .env (setup-server.sh generates it once on the
# VPS and keeps it in /opt/podvet/.env).
param(
  [switch]$SkipBuild,
  [string]$Site = 'https://podvet.biztrack.uk',
  [string]$Token = $env:UPDATES_PUBLISH_TOKEN
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $Token) {
  $envFile = Join-Path $root '.env'
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*UPDATES_PUBLISH_TOKEN\s*=\s*(\S+)' } | Select-Object -First 1
    if ($line -match '^\s*UPDATES_PUBLISH_TOKEN\s*=\s*(\S+)') { $Token = $Matches[1] }
  }
}
if (-not $Token) {
  throw "UPDATES_PUBLISH_TOKEN is not set. Copy it out of /opt/podvet/.env on the server (or the GitHub secret of the same name) into this machine's .env."
}

$pkg = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
Write-Output "Building PodVet $($pkg.version)..."
if (-not $SkipBuild) {
  Push-Location $root
  try { npm run dist } finally { Pop-Location }
}

$dist = Join-Path $root 'dist'
$feed = @(
  (Join-Path $dist 'latest.yml'),
  (Get-ChildItem -LiteralPath $dist -Filter '*-Setup.exe' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName,
  (Get-ChildItem -LiteralPath $dist -Filter '*.blockmap' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

if (-not $feed) { throw "Nothing to publish - $dist is empty. Run 'npm run dist' first." }

foreach ($file in $feed) {
  $name = Split-Path -Leaf $file
  $url = "$Site/updates/publish?file=$([uri]::EscapeDataString($name))&t=$([uri]::EscapeDataString($Token))"
  Write-Output "Uploading $name..."
  & curl.exe -sS --fail --retry 3 --retry-delay 2 --max-time 1800 -X POST --data-binary "@$file" -H 'Content-Type: application/octet-stream' $url
  if ($LASTEXITCODE -ne 0) { throw "Upload of $name failed (curl exit $LASTEXITCODE)" }
  Write-Output ''
}

Write-Output "Published PodVet $($pkg.version) to $Site/updates/"
Write-Output 'Installed apps will offer it on their next update check.'
