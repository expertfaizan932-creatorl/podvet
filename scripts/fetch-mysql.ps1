# Downloads and extracts the portable MySQL server bundled into the PodVet
# desktop installer. Output: vendor/mysql/bin/mysqld.exe
param(
  [string]$Version = '8.0.43',
  [string]$Url = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $root 'vendor'
$target = Join-Path $dest 'mysql'
if (-not $Url) { $Url = "https://cdn.mysql.com/archives/mysql-8.0/mysql-$Version-winx64.zip" }
$zip = Join-Path $dest "mysql-$Version-winx64.zip"

if (Test-Path (Join-Path $target 'bin\mysqld.exe')) {
  Write-Output 'ALREADY_PRESENT'
  exit 0
}

New-Item -ItemType Directory -Force -Path $dest | Out-Null

# Size from HEAD so we can verify the finished download.
$expected = 0
try {
  $head = & curl.exe -sSI --max-time 30 $Url
  $len = $head | Where-Object { $_ -match '^Content-Length:\s*(\d+)' } | Select-Object -First 1
  if ($len -match '^Content-Length:\s*(\d+)') { $expected = [int64]$Matches[1] }
} catch {}

function Get-ZipSize([string]$p) {
  if (Test-Path -LiteralPath $p) { return [int64](Get-Item -LiteralPath $p).Length }
  return [int64]0
}

if ((Get-ZipSize $zip) -lt $expected -or $expected -eq 0) {
  # Resume an interrupted download instead of starting over.
  $partial = "$zip.partial"
  if (-not (Test-Path -LiteralPath $zip) -and (Test-Path -LiteralPath $partial)) {
    Move-Item -LiteralPath $partial -Destination $zip
  }
  Write-Output "DOWNLOADING $Url"
  $ok = $false
  for ($i = 1; $i -le 8; $i++) {
    & curl.exe -L --fail --silent --show-error -C - -o $zip $Url
    $size = Get-ZipSize $zip
    Write-Output "ATTEMPT $i size=$size expected=$expected"
    if (($expected -gt 0 -and $size -ge $expected) -or ($expected -eq 0 -and $LASTEXITCODE -eq 0 -and $size -gt 0)) { $ok = $true; break }
    Start-Sleep -Seconds 3
  }
  if (-not $ok) { throw 'MySQL download failed after 8 attempts' }
}

$extractDir = Join-Path $dest '_extract'
if (Test-Path $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
Write-Output 'EXTRACTING'
& tar -xf $zip -C $extractDir
if ($LASTEXITCODE -ne 0) {
  Expand-Archive -Path $zip -DestinationPath $extractDir -Force
}

$inner = Get-ChildItem -LiteralPath $extractDir -Directory | Select-Object -First 1
if (-not $inner) { throw 'Extraction produced no directory' }
if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
Move-Item -LiteralPath $inner.FullName -Destination $target
Remove-Item -LiteralPath $extractDir -Recurse -Force

# mysqld.exe links against the Visual C++ runtime, which target machines may
# not have installed. Ship the redistributable DLLs next to the binaries.
$dlls = @(
  'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_2.dll', 'msvcp140_atomic140.dll',
  'msvcp140_codecvt_ids.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'concrt140.dll'
)
foreach ($dll in $dlls) {
  $src = Join-Path $env:WINDIR "System32\$dll"
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination (Join-Path $target 'bin') -Force
  }
}

# Slim the distribution: debug symbols, link libraries, Japanese full-text
# dictionaries and CLI tools the app never runs. Keeps the installer small
# (~135 MB extracted instead of ~930 MB) without touching anything mysqld.exe
# loads at runtime.
Get-ChildItem $target -Recurse -Include *.pdb, *.lib -File -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $target 'lib\mecab') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $target 'lib\plugin\debug') -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $target 'docs'), (Join-Path $target 'include') -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem (Join-Path $target 'lib') -Filter '*-debug.dll' -File -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
$keepExes = @('mysqld.exe', 'mysql.exe', 'mysqladmin.exe')
Get-ChildItem (Join-Path $target 'bin') -Filter '*.exe' |
  Where-Object { $keepExes -notcontains $_.Name } |
  Remove-Item -Force -ErrorAction SilentlyContinue

if (-not (Test-Path (Join-Path $target 'bin\mysqld.exe'))) { throw 'mysqld.exe missing after extract' }
Write-Output 'DONE'
