<#
.SYNOPSIS
  Bumps the version across all VPS manifest files and creates a git commit + tag.

.EXAMPLE
  .\scripts\bump-version.ps1 0.2.0
#>

param(
  [Parameter(Mandatory)][string]$Version
)

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
  Write-Error "Version must be MAJOR.MINOR.PATCH (e.g. 0.2.0)"
  exit 1
}

$Root = Split-Path $PSScriptRoot -Parent

# tauri.conf.json
$tauriConf = Join-Path $Root "src-tauri\tauri.conf.json"
(Get-Content $tauriConf -Raw | ConvertFrom-Json) | ForEach-Object {
  $_.version = $Version
  $_ | ConvertTo-Json -Depth 10
} | Set-Content $tauriConf -Encoding utf8

# package.json
$pkgJson = Join-Path $Root "package.json"
(Get-Content $pkgJson -Raw | ConvertFrom-Json) | ForEach-Object {
  $_.version = $Version
  $_ | ConvertTo-Json -Depth 10
} | Set-Content $pkgJson -Encoding utf8

# src-tauri/Cargo.toml  — only the [package] version line
$cargoToml = Join-Path $Root "src-tauri\Cargo.toml"
(Get-Content $cargoToml) -replace '^version = ".*"', "version = `"$Version`"" |
  Set-Content $cargoToml -Encoding utf8

Write-Host "Bumped to $Version in:"
Write-Host "  src-tauri/tauri.conf.json"
Write-Host "  package.json"
Write-Host "  src-tauri/Cargo.toml"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml"
Write-Host "  git commit -m `"chore: bump version to $Version`""
Write-Host "  git tag v$Version"
Write-Host "  git push origin master v$Version"
