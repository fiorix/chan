# chan standalone CLI installer for Windows x64.
#
#   irm https://chan.app/install.ps1 | iex
#
# Downloads complete-release CLI metadata, verifies the exact signed
# x86_64-pc-windows-msvc ZIP and its SHA256, and installs into PREFIX\bin.
# Defaults:
#
#   METADATA_URL=https://chan.app/dl/cli/latest.json
#   PREFIX=%LOCALAPPDATA%\chan-cli

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$DefaultMetadataBase = "https://chan.app/dl/cli"
$Target = "x86_64-pc-windows-msvc"
$ExpectedAsset = "chan-x86_64-pc-windows-msvc.zip"
$MetadataLimit = 1MB
$ArchiveLimit = 256MB
$StandaloneMarker = "chan standalone CLI install"
$StandaloneCmdMarker = ":: chan standalone CLI shim"
$StandalonePosixMarker = "# chan standalone CLI shim"
$DesktopCmdMarker = ":: chan-desktop"
$DesktopPosixMarker = "# chan-desktop"
$TempRoot = $null
$InstalledBinary = $null

function Stop-Install {
    param([Parameter(Mandatory = $true)][string]$Message)
    throw "install: $Message"
}

function Get-ConfiguredMetadataUrl {
    if ($env:VERSION -and $env:VERSION -notmatch '^\d+\.\d+\.\d+$') {
        Stop-Install "VERSION must be a bare X.Y.Z version."
    }
    if ($env:METADATA_URL) {
        return $env:METADATA_URL
    }
    $Base = if ($env:BASE) { $env:BASE.TrimEnd("/") } else { $DefaultMetadataBase }
    if ($env:VERSION) {
        return "$Base/v$($env:VERSION).json"
    }
    return "$Base/latest.json"
}

function Get-AllowedUri {
    param(
        [Parameter(Mandatory = $true)][string]$Value,
        [Parameter(Mandatory = $true)][string]$Label,
        [switch]$AllowLoopback,
        [System.Uri]$RequiredOrigin
    )
    $Parsed = $null
    if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$Parsed)) {
        Stop-Install "$Label is not an absolute URL: $Value"
    }
    if ($Parsed.Scheme -eq "https") {
        return $Parsed
    }
    if ($Parsed.Scheme -ne "http" -or -not $AllowLoopback -or -not $Parsed.IsLoopback) {
        Stop-Install "$Label must use HTTPS: $Value"
    }
    if ($null -ne $RequiredOrigin) {
        $Actual = $Parsed.GetLeftPart([System.UriPartial]::Authority)
        $Expected = $RequiredOrigin.GetLeftPart([System.UriPartial]::Authority)
        if (-not [string]::Equals($Actual, $Expected, [System.StringComparison]::OrdinalIgnoreCase)) {
            Stop-Install "$Label must use the metadata server's loopback origin: $Value"
        }
    }
    return $Parsed
}

function Get-NativeArchitecture {
    if ($env:PROCESSOR_ARCHITEW6432) {
        return $env:PROCESSOR_ARCHITEW6432.ToUpperInvariant()
    }
    if ($env:PROCESSOR_ARCHITECTURE) {
        return $env:PROCESSOR_ARCHITECTURE.ToUpperInvariant()
    }
    return ""
}

function Assert-SupportedArchitecture {
    $Architecture = Get-NativeArchitecture
    if ($Architecture -eq "ARM64") {
        Stop-Install "Windows ARM64 is not published. x64 emulation is intentionally not supported."
    }
    if ($Architecture -ne "AMD64") {
        Stop-Install "Windows on $Architecture is not published. x64 only for now."
    }
}

function Test-FileContains {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Marker
    )
    if (-not [System.IO.File]::Exists($Path)) {
        return $false
    }
    try {
        return [System.IO.File]::ReadAllText($Path).Contains($Marker)
    } catch {
        Stop-Install "cannot inspect existing command shim $Path"
    }
}

function Assert-NoDesktopOwnership {
    $UninstallKeys = @(
        "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chan",
        "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\Chan",
        "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Chan"
    )
    foreach ($Key in $UninstallKeys) {
        if (Test-Path -LiteralPath $Key) {
            Stop-Install "Chan Desktop is installed and owns the chan/cs commands. Use its bundled CLI."
        }
    }
    if (-not $env:LOCALAPPDATA) {
        Stop-Install "LOCALAPPDATA is unavailable."
    }
    $DesktopBin = Join-Path (Join-Path $env:LOCALAPPDATA "chan") "bin"
    $Candidates = @(
        [PSCustomObject]@{ Path = (Join-Path $DesktopBin "chan.cmd"); Marker = $DesktopCmdMarker },
        [PSCustomObject]@{ Path = (Join-Path $DesktopBin "cs.cmd"); Marker = $DesktopCmdMarker },
        [PSCustomObject]@{ Path = (Join-Path $DesktopBin "chan"); Marker = $DesktopPosixMarker },
        [PSCustomObject]@{ Path = (Join-Path $DesktopBin "cs"); Marker = $DesktopPosixMarker }
    )
    foreach ($Candidate in $Candidates) {
        if (Test-FileContains -Path $Candidate.Path -Marker $Candidate.Marker) {
            Stop-Install "Chan Desktop owns command shims under $DesktopBin. Use its bundled CLI."
        }
    }
}

function Assert-StandaloneDestination {
    param([Parameter(Mandatory = $true)][string]$BinDir)
    $Owner = Join-Path $BinDir ".chan-standalone-cli"
    $Owned = Test-FileContains -Path $Owner -Marker $StandaloneMarker
    foreach ($Path in @(
        (Join-Path $BinDir "chan.exe"),
        (Join-Path $BinDir "chan.cmd"),
        (Join-Path $BinDir "cs.cmd"),
        (Join-Path $BinDir "cs")
    )) {
        if (-not [System.IO.File]::Exists($Path)) {
            continue
        }
        if (-not $Owned) {
            Stop-Install "refusing to overwrite the existing unowned command $Path"
        }
        if ($Path.EndsWith("cs.cmd") -and
            -not (Test-FileContains -Path $Path -Marker $StandaloneCmdMarker)) {
            Stop-Install "refusing to overwrite the existing unowned command $Path"
        }
        if ($Path.EndsWith("\cs") -and
            -not (Test-FileContains -Path $Path -Marker $StandalonePosixMarker)) {
            Stop-Install "refusing to overwrite the existing unowned command $Path"
        }
        if ($Path.EndsWith("chan.cmd")) {
            Stop-Install "refusing to overwrite the existing command $Path"
        }
    }
}

function Receive-File {
    param(
        [Parameter(Mandatory = $true)][System.Uri]$Uri,
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][long]$Limit
    )
    Add-Type -AssemblyName System.Net.Http
    $Client = New-Object System.Net.Http.HttpClient
    $Client.Timeout = [System.TimeSpan]::FromMinutes(15)
    $Response = $null
    $InputStream = $null
    $OutputStream = $null
    try {
        $Response = $Client.GetAsync(
            $Uri,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        ).GetAwaiter().GetResult()
        if (-not $Response.IsSuccessStatusCode) {
            Stop-Install "GET $Uri returned HTTP $([int]$Response.StatusCode)"
        }
        $Length = $Response.Content.Headers.ContentLength
        if ($null -ne $Length -and $Length -gt $Limit) {
            Stop-Install "download from $Uri exceeds the $Limit byte safety cap"
        }
        $InputStream = $Response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $OutputStream = [System.IO.File]::Create($Path)
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Total += $Read
            if ($Total -gt $Limit) {
                Stop-Install "download from $Uri exceeds the $Limit byte safety cap"
            }
            $OutputStream.Write($Buffer, 0, $Read)
        }
    } finally {
        if ($null -ne $OutputStream) { $OutputStream.Dispose() }
        if ($null -ne $InputStream) { $InputStream.Dispose() }
        if ($null -ne $Response) { $Response.Dispose() }
        $Client.Dispose()
    }
}

function Expand-ChanExecutable {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][string]$Output
    )
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    $InputStream = $null
    $OutputStream = $null
    try {
        $Entries = @($Zip.Entries | Where-Object { $_.FullName -ceq "chan.exe" -and $_.Name })
        if ($Entries.Count -ne 1) {
            Stop-Install "archive must contain exactly one top-level chan.exe"
        }
        $Entry = $Entries[0]
        if ($Entry.Length -gt $ArchiveLimit) {
            Stop-Install "chan.exe exceeds the $ArchiveLimit byte safety cap"
        }
        $InputStream = $Entry.Open()
        $OutputStream = [System.IO.File]::Create($Output)
        $Buffer = New-Object byte[] 65536
        [long]$Total = 0
        while (($Read = $InputStream.Read($Buffer, 0, $Buffer.Length)) -gt 0) {
            $Total += $Read
            if ($Total -gt $ArchiveLimit) {
                Stop-Install "chan.exe exceeds the $ArchiveLimit byte safety cap"
            }
            $OutputStream.Write($Buffer, 0, $Read)
        }
    } finally {
        if ($null -ne $OutputStream) { $OutputStream.Dispose() }
        if ($null -ne $InputStream) { $InputStream.Dispose() }
        $Zip.Dispose()
    }
}

function Install-Replacement {
    param(
        [Parameter(Mandatory = $true)][string]$Staged,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    if (-not [System.IO.File]::Exists($Destination)) {
        [System.IO.File]::Move($Staged, $Destination)
        return
    }
    $Backup = Join-Path ([System.IO.Path]::GetDirectoryName($Destination)) (
        ".chan.exe.backup." + [System.Guid]::NewGuid().ToString("N")
    )
    try {
        [System.IO.File]::Replace($Staged, $Destination, $Backup, $true)
    } catch {
        if ([System.IO.File]::Exists($Backup) -and -not [System.IO.File]::Exists($Destination)) {
            [System.IO.File]::Move($Backup, $Destination)
        }
        Stop-Install "could not replace $Destination. It may be running; the previous binary was kept. $($_.Exception.Message)"
    } finally {
        if ([System.IO.File]::Exists($Backup)) {
            [System.IO.File]::Delete($Backup)
        }
        if ([System.IO.File]::Exists($Staged)) {
            [System.IO.File]::Delete($Staged)
        }
    }
}

function Write-StandaloneFiles {
    param(
        [Parameter(Mandatory = $true)][string]$BinDir,
        [Parameter(Mandatory = $true)][string]$Version
    )
    $Utf8 = New-Object System.Text.UTF8Encoding($false)
    $Owner = "$StandaloneMarker`r`nversion=$Version`r`ntarget=$Target`r`n"
    [System.IO.File]::WriteAllText((Join-Path $BinDir ".chan-standalone-cli"), $Owner, $Utf8)

    $Cmd = @(
        "@echo off",
        $StandaloneCmdMarker,
        "setlocal",
        'set "ARGV0=cs"',
        '"%~dp0chan.exe" %*',
        "exit /b %errorlevel%"
    ) -join "`r`n"
    [System.IO.File]::WriteAllText((Join-Path $BinDir "cs.cmd"), "$Cmd`r`n", $Utf8)

    $Posix = @'
#!/bin/sh
# chan standalone CLI shim
export ARGV0=cs
exec "$(dirname "$0")/chan.exe" "$@"
'@
    [System.IO.File]::WriteAllText((Join-Path $BinDir "cs"), "$Posix`n", $Utf8)
}

function Test-PathEntry {
    param(
        [Parameter(Mandatory = $true)][string]$PathValue,
        [Parameter(Mandatory = $true)][string]$Wanted
    )
    $NormalizedWanted = $Wanted.Trim() -replace '[\\/]+$', ''
    foreach ($Entry in $PathValue.Split(";")) {
        $NormalizedEntry = $Entry.Trim() -replace '[\\/]+$', ''
        if ([string]::Equals(
            $NormalizedEntry,
            $NormalizedWanted,
            [System.StringComparison]::OrdinalIgnoreCase
        )) {
            return $true
        }
    }
    return $false
}

function Publish-PathChange {
    try {
        if (-not ("ChanEnvironmentBroadcast" -as [type])) {
            Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ChanEnvironmentBroadcast {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
        uint flags, uint timeout, out UIntPtr result);
}
"@
        }
        $Result = [UIntPtr]::Zero
        [void][ChanEnvironmentBroadcast]::SendMessageTimeout(
            [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, "Environment",
            0x0002, 5000, [ref]$Result
        )
    } catch {
        Write-Warning "install: PATH was saved, but the environment-change broadcast failed."
    }
}

function Ensure-UserPath {
    param([Parameter(Mandatory = $true)][string]$BinDir)
    $UserPath = [System.Environment]::GetEnvironmentVariable(
        "Path",
        [System.EnvironmentVariableTarget]::User
    )
    if ($null -eq $UserPath) { $UserPath = "" }
    if (-not (Test-PathEntry -PathValue $UserPath -Wanted $BinDir)) {
        $Next = if ($UserPath.Trim()) { "$($UserPath.TrimEnd(';'));$BinDir" } else { $BinDir }
        [System.Environment]::SetEnvironmentVariable(
            "Path",
            $Next,
            [System.EnvironmentVariableTarget]::User
        )
        Publish-PathChange
    }
    if (-not (Test-PathEntry -PathValue $env:Path -Wanted $BinDir)) {
        $env:Path = "$BinDir;$env:Path"
    }
}

try {
    Assert-SupportedArchitecture
    Assert-NoDesktopOwnership

    if (-not $env:LOCALAPPDATA -and -not $env:PREFIX) {
        Stop-Install "LOCALAPPDATA is unavailable and PREFIX was not set."
    }
    $Prefix = if ($env:PREFIX) {
        [System.Environment]::ExpandEnvironmentVariables($env:PREFIX)
    } else {
        Join-Path $env:LOCALAPPDATA "chan-cli"
    }
    $Prefix = [System.IO.Path]::GetFullPath($Prefix)
    $BinDir = Join-Path $Prefix "bin"
    Assert-StandaloneDestination -BinDir $BinDir

    $MetadataUrl = Get-ConfiguredMetadataUrl
    $MetadataUri = Get-AllowedUri -Value $MetadataUrl -Label "metadata URL" -AllowLoopback
    $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) (
        "chan-install-" + [System.Guid]::NewGuid().ToString("N")
    )
    [System.IO.Directory]::CreateDirectory($TempRoot) | Out-Null
    $MetadataPath = Join-Path $TempRoot "cli-release.json"
    Write-Host "install: reading $MetadataUri"
    Receive-File -Uri $MetadataUri -Path $MetadataPath -Limit $MetadataLimit

    try {
        $Metadata = [System.IO.File]::ReadAllText($MetadataPath) | ConvertFrom-Json
    } catch {
        Stop-Install "release metadata is not valid JSON"
    }
    $Version = [string]$Metadata.version
    if ($Version -notmatch '^\d+\.\d+\.\d+$') {
        Stop-Install "metadata has an invalid version."
    }
    if ([string]$Metadata.tag -cne "v$Version") {
        Stop-Install "metadata tag does not match version $Version."
    }
    $PublishedAt = [System.DateTimeOffset]::MinValue
    if (-not $Metadata.published_at -or -not [System.DateTimeOffset]::TryParse(
        [string]$Metadata.published_at,
        [ref]$PublishedAt
    )) {
        Stop-Install "metadata has an invalid published_at timestamp."
    }
    if ($env:VERSION -and $Version -cne $env:VERSION) {
        Stop-Install "metadata describes $Version instead of requested version $($env:VERSION)."
    }
    $Matches = @($Metadata.targets | Where-Object { [string]$_.target -ceq $Target })
    if ($Matches.Count -ne 1) {
        Stop-Install "metadata has no unique asset for $Target."
    }
    $Asset = $Matches[0]
    if ([string]$Asset.asset -cne $ExpectedAsset) {
        Stop-Install "metadata asset mismatch for $($Target): $($Asset.asset)"
    }
    $ExpectedSha = ([string]$Asset.sha256).ToLowerInvariant()
    if ($ExpectedSha -notmatch '^[a-f0-9]{64}$') {
        Stop-Install "metadata has invalid SHA256 for $ExpectedAsset."
    }
    $AllowLocalAsset = $MetadataUri.Scheme -eq "http" -and $MetadataUri.IsLoopback
    $AssetUri = Get-AllowedUri `
        -Value ([string]$Asset.url) `
        -Label "asset URL" `
        -AllowLoopback:$AllowLocalAsset `
        -RequiredOrigin $(if ($AllowLocalAsset) { $MetadataUri } else { $null })

    $ArchivePath = Join-Path $TempRoot $ExpectedAsset
    Write-Host "install: downloading $AssetUri"
    Receive-File -Uri $AssetUri -Path $ArchivePath -Limit $ArchiveLimit
    $ActualSha = (Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualSha -cne $ExpectedSha) {
        Stop-Install "SHA256 mismatch for $ExpectedAsset."
    }

    $Extracted = Join-Path $TempRoot "chan.exe"
    Expand-ChanExecutable -Archive $ArchivePath -Output $Extracted
    [System.IO.Directory]::CreateDirectory($BinDir) | Out-Null
    $Staged = Join-Path $BinDir (".chan.exe.stage." + [System.Guid]::NewGuid().ToString("N"))
    [System.IO.File]::Copy($Extracted, $Staged, $true)
    $InstalledBinary = Join-Path $BinDir "chan.exe"
    Install-Replacement -Staged $Staged -Destination $InstalledBinary
    Write-StandaloneFiles -BinDir $BinDir -Version $Version
    Ensure-UserPath -BinDir $BinDir

    Write-Host "install: installed chan $Version to $InstalledBinary"
    Write-Host "install: installed cs.cmd and Git Bash cs shim in $BinDir"
    Write-Host "install: open a new terminal to use chan and cs from PATH."
} catch {
    $Message = $_.Exception.Message
    if (-not $Message.StartsWith("install:")) {
        $Message = "install: $Message"
    }
    [Console]::Error.WriteLine($Message)
    if ($InstalledBinary -and [System.IO.File]::Exists($InstalledBinary)) {
        [Console]::Error.WriteLine(
            "install: the CLI is present at $InstalledBinary, but installation did not complete."
        )
    }
    exit 1
} finally {
    if ($TempRoot -and [System.IO.Directory]::Exists($TempRoot)) {
        try {
            [System.IO.Directory]::Delete($TempRoot, $true)
        } catch {
            Write-Warning "install: could not remove temporary directory $TempRoot"
        }
    }
}
