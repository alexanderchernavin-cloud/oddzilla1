# Build a signed release APK and ship it to the production server.
#
# Run from apps/mobile-android:
#
#   .\scripts\release.ps1 -ReleaseNotes "Bug fixes and performance"
#
# Optional flags:
#   -Mandatory                Force every old build to update before
#                             they can keep using the app.
#   -MinSupportedVersionCode  Bump the floor; any version below it is
#                             treated as mandatory regardless of the
#                             switch above. Use this to retire builds
#                             with critical bugs.
#   -SkipBuild                Reuse an existing APK at the standard
#                             output path (useful for re-uploads).
#   -DryRun                   Build + hash but don't scp / update the
#                             remote manifest.
#
# Prereqs:
#   1. keystore.properties present (gitignored) — see the *.example
#      file for the layout.
#   2. ssh access to team@178.104.174.24 with sudo / write rights to
#      /srv/oddzilla-apk (run infra/hetzner/oddzilla-apk-init.sh once).
#   3. Gradle wrapper synced (open the project in Android Studio once,
#      or run `gradle wrapper` if you have a system gradle).

[CmdletBinding()]
param(
    [string]$ReleaseNotes = "",
    [switch]$Mandatory,
    [int]$MinSupportedVersionCode = 0,
    [switch]$SkipBuild,
    [switch]$DryRun,
    [string]$Server = "team@178.104.174.24",
    [string]$RemoteDir = "/srv/oddzilla-apk"
)

$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path "$PSScriptRoot\..").Path
Push-Location $projectRoot
try {
    # 1. Read version.properties.
    $verFile = Join-Path $projectRoot "version.properties"
    if (-not (Test-Path $verFile)) {
        throw "version.properties not found at $verFile"
    }
    $props = @{}
    Get-Content $verFile | ForEach-Object {
        if ($_ -match "^\s*([A-Za-z0-9_]+)\s*=\s*(.+)\s*$") {
            $props[$matches[1]] = $matches[2]
        }
    }
    $versionCode = [int]$props["versionCode"]
    $versionName = $props["versionName"]
    Write-Host "Releasing v$versionName ($versionCode)"

    # 2. Verify keystore is configured.
    $keystoreFile = Join-Path $projectRoot "keystore.properties"
    if (-not (Test-Path $keystoreFile)) {
        throw "keystore.properties missing — release builds must be signed by the release key, not the debug key. See keystore.properties.example."
    }

    # 3. Build (unless caller asked to skip).
    $apkPath = Join-Path $projectRoot "app\build\outputs\apk\release\app-release.apk"
    if (-not $SkipBuild) {
        $gradlew = Join-Path $projectRoot "gradlew.bat"
        if (-not (Test-Path $gradlew)) {
            throw "gradlew.bat missing. Open the project in Android Studio once or run 'gradle wrapper'."
        }
        Write-Host "Building :app:assembleRelease..."
        & $gradlew ":app:assembleRelease" --no-daemon
        if ($LASTEXITCODE -ne 0) { throw "gradle build failed" }
    }
    if (-not (Test-Path $apkPath)) {
        throw "APK not found at $apkPath"
    }

    # 4. Compute SHA-256.
    $sha256 = (Get-FileHash -Path $apkPath -Algorithm SHA256).Hash.ToLower()
    Write-Host "SHA-256: $sha256"

    # 5. Build the version manifest.
    $apkRemoteName = "oddzilla-$versionName.apk"
    $apkUrl = "https://oddzilla.cc/app/$apkRemoteName"
    $manifest = [ordered]@{
        versionCode             = $versionCode
        versionName             = $versionName
        apkUrl                  = $apkUrl
        sha256                  = $sha256
        releaseNotes            = $ReleaseNotes
        mandatory               = [bool]$Mandatory.IsPresent
        minSupportedVersionCode = $MinSupportedVersionCode
    }
    $manifestJson = $manifest | ConvertTo-Json -Depth 5

    if ($DryRun) {
        Write-Host "DryRun — would upload:"
        Write-Host "  apk: $apkPath -> $Server`:$RemoteDir/$apkRemoteName"
        Write-Host "  version.json:"
        Write-Host $manifestJson
        return
    }

    # 6. SCP the APK + manifest. The remote dir is mode 755 owned by
    #    root, so we land both files in /tmp first and then sudo-mv
    #    them into place atomically. version.json gets `cp -f` after
    #    the apk so the manifest never points at a 404.
    $tmpApk = "/tmp/$apkRemoteName"
    $tmpJson = "/tmp/version.json"
    Write-Host "Uploading APK..."
    scp $apkPath "$Server`:$tmpApk"
    if ($LASTEXITCODE -ne 0) { throw "scp apk failed" }

    $manifestFile = New-TemporaryFile
    Set-Content -Path $manifestFile -Value $manifestJson -Encoding UTF8
    Write-Host "Uploading manifest..."
    scp $manifestFile.FullName "$Server`:$tmpJson"
    if ($LASTEXITCODE -ne 0) { throw "scp manifest failed" }
    Remove-Item $manifestFile.FullName

    Write-Host "Promoting to /srv/oddzilla-apk on the server..."
    ssh $Server @"
sudo install -o root -g root -m 644 $tmpApk $RemoteDir/$apkRemoteName
sudo install -o root -g root -m 644 $tmpJson $RemoteDir/version.json
rm -f $tmpApk $tmpJson
ls -l $RemoteDir
"@
    if ($LASTEXITCODE -ne 0) { throw "remote install failed" }

    Write-Host ""
    Write-Host "Released v$versionName ($versionCode)."
    Write-Host "  $apkUrl"
    Write-Host "  https://oddzilla.cc/app/version.json"
}
finally {
    Pop-Location
}
