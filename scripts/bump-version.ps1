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
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [System.IO.File]::WriteAllText($Path, $Content, $utf8NoBom)
}

# tauri.conf.json
$tauriConf = Join-Path $Root "src-tauri\tauri.conf.json"
$obj = Get-Content $tauriConf -Raw | ConvertFrom-Json
$obj.version = $Version
Write-Utf8NoBom $tauriConf ($obj | ConvertTo-Json -Depth 10)

# package.json
$pkgJson = Join-Path $Root "package.json"
$obj = Get-Content $pkgJson -Raw | ConvertFrom-Json
$obj.version = $Version
Write-Utf8NoBom $pkgJson ($obj | ConvertTo-Json -Depth 10)

# src-tauri/Cargo.toml — replace only the [package] version line, no BOM
$cargoToml = Join-Path $Root "src-tauri\Cargo.toml"
$content = [System.IO.File]::ReadAllText($cargoToml).TrimStart([char]0xFEFF)
$content = $content -replace '(?m)^version = ".*"', "version = `"$Version`""
Write-Utf8NoBom $cargoToml $content

Write-Host "Bumped to $Version in:"
Write-Host "  src-tauri/tauri.conf.json"
Write-Host "  package.json"
Write-Host "  src-tauri/Cargo.toml"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml"
Write-Host "  git commit -m `"chore: bump version to $Version`""
Write-Host "  git tag v`$Version"
Write-Host "  git push origin master v`$Version"
