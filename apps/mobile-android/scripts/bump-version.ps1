# Bump version.properties for the next release.
#
#   .\scripts\bump-version.ps1 -New 0.2.0
#
# Increments versionCode by 1 and sets versionName to the supplied
# semver string. Commit the result before running release.ps1 so
# git history reflects the version that shipped.

param(
    [Parameter(Mandatory)] [string]$New
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
$verFile = Join-Path $projectRoot "version.properties"
$content = Get-Content $verFile

$updated = @()
$bumped = $false
foreach ($line in $content) {
    if ($line -match "^versionCode=(\d+)") {
        $next = [int]$matches[1] + 1
        $updated += "versionCode=$next"
        $bumped = $true
        Write-Host "versionCode: $($matches[1]) -> $next"
    } elseif ($line -match "^versionName=") {
        $updated += "versionName=$New"
        Write-Host "versionName: $line -> versionName=$New"
    } else {
        $updated += $line
    }
}
if (-not $bumped) {
    throw "versionCode line not found in version.properties"
}
Set-Content -Path $verFile -Value $updated -Encoding UTF8
Write-Host "Done. git diff version.properties"
