# Pull Oddzilla pg dumps from the Hetzner box to this Windows PC.
#
# The server-side cron `/usr/local/bin/oddzilla-pg-backup` writes dumps
# to /var/backups/oddzilla/ daily at 03:00 UTC. After
# infra/hetzner/backup/pg_backup.sh's permission hardening (root:team
# 640) the `team` SSH user can read them directly via scp — no sudo
# round-trip needed.
#
# Usage:
#   .\pull-backup.ps1 -RemoteHost team@178.104.174.24 -DestDir D:\backups\oddzilla
#
# Schedule daily at e.g. 04:00 local via Task Scheduler:
#   Program:    powershell.exe
#   Arguments:  -ExecutionPolicy Bypass -NoProfile -File "D:\path\to\pull-backup.ps1"
#               -RemoteHost team@178.104.174.24 -DestDir D:\backups\oddzilla
#   Trigger:    Daily, 04:00.
#
# Requires: OpenSSH Client (built-in on Windows 10 1809+; check via
# `Get-WindowsCapability -Online -Name OpenSSH.Client*`). The SSH key
# in your %USERPROFILE%\.ssh\ must already be authorised on the server.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RemoteHost,
    [Parameter(Mandatory = $true)]
    [string]$DestDir,
    [string]$RemoteDir = "/var/backups/oddzilla",
    [int]$KeepDays = 90
)

$ErrorActionPreference = "Stop"

function Write-Event {
    param([string]$EventName, [hashtable]$Fields = @{})
    $row = @{
        service = "pull-backup"
        event   = $EventName
        host    = $RemoteHost
        ts      = (Get-Date -AsUTC).ToString("yyyy-MM-ddTHH:mm:ssZ")
    }
    foreach ($k in $Fields.Keys) { $row[$k] = $Fields[$k] }
    Write-Output ($row | ConvertTo-Json -Compress)
}

if (-not (Test-Path -LiteralPath $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir | Out-Null
}

# List dumps on the server. The ls glob is quoted so the remote shell
# expands it; missing files yield "ls: cannot access ..." on stderr,
# which we suppress so an empty dir doesn't error out the script.
$lsCmd = "ls -1 $RemoteDir/oddzilla-*.sql.gz $RemoteDir/oddzilla-*.sql.gz.gpg 2>/dev/null"
$listing = & ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new $RemoteHost $lsCmd
if ($LASTEXITCODE -ne 0 -or -not $listing) {
    Write-Event "no_remote_dumps"
    exit 0
}

$remoteFiles = $listing -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }

$pulled = 0
$skipped = 0
$failed = 0
$totalBytes = 0L

foreach ($remotePath in $remoteFiles) {
    $name = Split-Path -Leaf $remotePath
    $localPath = Join-Path $DestDir $name

    if (Test-Path -LiteralPath $localPath) {
        $skipped++
        continue
    }

    # Stage to a temp file so an interrupted scp doesn't leave a
    # half-written dump that the next run treats as already-downloaded.
    $tempPath = "$localPath.partial"
    & scp -o BatchMode=yes -o StrictHostKeyChecking=accept-new -p "${RemoteHost}:${remotePath}" $tempPath
    if ($LASTEXITCODE -ne 0) {
        Write-Event "scp_failed" @{ remote = $remotePath; exit_code = $LASTEXITCODE }
        $failed++
        if (Test-Path -LiteralPath $tempPath) { Remove-Item -LiteralPath $tempPath -Force }
        continue
    }
    Move-Item -LiteralPath $tempPath -Destination $localPath -Force
    $pulled++
    $totalBytes += (Get-Item -LiteralPath $localPath).Length
}

# Local retention prune. Delete dumps older than KeepDays since their
# write time on this PC. Server retention (14 days) is independent.
$cutoff = (Get-Date).AddDays(-$KeepDays)
$pruned = 0
Get-ChildItem -LiteralPath $DestDir -File `
    | Where-Object { $_.Name -match '^oddzilla-.*\.sql\.gz(\.gpg)?$' -and $_.LastWriteTime -lt $cutoff } `
    | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
        $pruned++
    }

Write-Event "complete" @{
    pulled       = $pulled
    skipped      = $skipped
    failed       = $failed
    pruned_local = $pruned
    bytes        = $totalBytes
    dest         = $DestDir
}

if ($failed -gt 0) { exit 1 }
exit 0
