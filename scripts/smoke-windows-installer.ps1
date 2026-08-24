param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$TestBinary,
    [Parameter(Mandatory = $true)][string]$UpgradeBinary,
    [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$Installer = (Resolve-Path -LiteralPath $Installer).Path
$TestBinary = (Resolve-Path -LiteralPath $TestBinary).Path
$UpgradeBinary = (Resolve-Path -LiteralPath $UpgradeBinary).Path
$Root = Join-Path ([System.IO.Path]::GetTempPath()) (
    "chan-windows-installer-smoke-" + [System.Guid]::NewGuid().ToString("N")
)
$ServerRoot = Join-Path $Root "server"
$MetadataRoot = Join-Path (Join-Path $ServerRoot "dl") "cli"
$AssetsRoot = Join-Path $ServerRoot "assets"
$LocalAppData = Join-Path $Root "localappdata"
$Server = $null
$OriginalUserPath = [System.Environment]::GetEnvironmentVariable(
    "Path",
    [System.EnvironmentVariableTarget]::User
)
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Assert-Smoke {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw "windows installer smoke: $Message"
    }
}

function New-ChanZip {
    param(
        [Parameter(Mandatory = $true)][string]$Binary,
        [Parameter(Mandatory = $true)][string]$Archive
    )
    $Stage = Join-Path $Root ("zip-" + [System.Guid]::NewGuid().ToString("N"))
    [System.IO.Directory]::CreateDirectory($Stage) | Out-Null
    try {
        Copy-Item -LiteralPath $Binary -Destination (Join-Path $Stage "chan.exe")
        Compress-Archive -LiteralPath (Join-Path $Stage "chan.exe") -DestinationPath $Archive
    } finally {
        Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Write-Metadata {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Version,
        [Parameter(Mandatory = $true)][string]$AssetUrl,
        [Parameter(Mandatory = $true)][string]$Sha256
    )
    $Document = [ordered]@{
        schema_version = 1
        version = $Version
        tag = "v$Version"
        published_at = "2026-08-24T00:00:00Z"
        targets = @(
            [ordered]@{
                target = "x86_64-pc-windows-msvc"
                asset = "chan-x86_64-pc-windows-msvc.zip"
                url = $AssetUrl
                sha256 = $Sha256
            }
        )
    }
    [System.IO.File]::WriteAllText(
        $Path,
        ($Document | ConvertTo-Json -Depth 5) + "`n",
        $Utf8
    )
}

function Invoke-CapturedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string]$Arguments = ""
    )
    $Id = [System.Guid]::NewGuid().ToString("N")
    $Out = Join-Path $Root "$Id.out"
    $Err = Join-Path $Root "$Id.err"
    $Process = Start-Process `
        -FilePath $FilePath `
        -ArgumentList $Arguments `
        -NoNewWindow `
        -Wait `
        -PassThru `
        -RedirectStandardOutput $Out `
        -RedirectStandardError $Err
    $Output = ""
    if ([System.IO.File]::Exists($Out)) { $Output += [System.IO.File]::ReadAllText($Out) }
    if ([System.IO.File]::Exists($Err)) { $Output += [System.IO.File]::ReadAllText($Err) }
    return [PSCustomObject]@{ ExitCode = $Process.ExitCode; Output = $Output }
}

function Invoke-Installer {
    param([Parameter(Mandatory = $true)][hashtable]$Environment)
    $Controlled = @(
        "PREFIX",
        "VERSION",
        "BASE",
        "METADATA_URL",
        "LOCALAPPDATA",
        "PROCESSOR_ARCHITEW6432"
    )
    $Saved = @{}
    foreach ($Name in $Controlled) {
        $Saved[$Name] = [System.Environment]::GetEnvironmentVariable(
            $Name,
            [System.EnvironmentVariableTarget]::Process
        )
        if ($Environment.ContainsKey($Name)) {
            [System.Environment]::SetEnvironmentVariable(
                $Name,
                [string]$Environment[$Name],
                [System.EnvironmentVariableTarget]::Process
            )
        } else {
            [System.Environment]::SetEnvironmentVariable(
                $Name,
                $null,
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
    try {
        $Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Installer`""
        return Invoke-CapturedProcess -FilePath "powershell.exe" -Arguments $Arguments
    } finally {
        foreach ($Name in $Controlled) {
            [System.Environment]::SetEnvironmentVariable(
                $Name,
                $Saved[$Name],
                [System.EnvironmentVariableTarget]::Process
            )
        }
    }
}

function Wait-ForServer {
    for ($Attempt = 0; $Attempt -lt 100; $Attempt += 1) {
        $Client = New-Object System.Net.Sockets.TcpClient
        try {
            $Client.Connect("127.0.0.1", $Port)
            return
        } catch {
            Start-Sleep -Milliseconds 100
        } finally {
            $Client.Dispose()
        }
    }
    throw "windows installer smoke: local metadata server did not start"
}

function Normalized-PathEntry {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ($Value.Trim() -replace '[\\/]+$', '').ToLowerInvariant()
}

try {
    foreach ($Dir in @($MetadataRoot, $AssetsRoot, $LocalAppData)) {
        [System.IO.Directory]::CreateDirectory($Dir) | Out-Null
    }

    $InitialZip = Join-Path $AssetsRoot "initial.zip"
    $UpgradeZip = Join-Path $AssetsRoot "upgrade.zip"
    New-ChanZip -Binary $TestBinary -Archive $InitialZip
    New-ChanZip -Binary $UpgradeBinary -Archive $UpgradeZip
    $InitialZipSha = (Get-FileHash -LiteralPath $InitialZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $UpgradeZipSha = (Get-FileHash -LiteralPath $UpgradeZip -Algorithm SHA256).Hash.ToLowerInvariant()
    $InitialUrl = "http://127.0.0.1:$Port/assets/initial.zip"
    $UpgradeUrl = "http://127.0.0.1:$Port/assets/upgrade.zip"
    Write-Metadata `
        -Path (Join-Path $MetadataRoot "v0.96.0.json") `
        -Version "0.96.0" `
        -AssetUrl $InitialUrl `
        -Sha256 $InitialZipSha
    Write-Metadata `
        -Path (Join-Path $MetadataRoot "latest.json") `
        -Version "0.96.1" `
        -AssetUrl $UpgradeUrl `
        -Sha256 $UpgradeZipSha
    Write-Metadata `
        -Path (Join-Path $MetadataRoot "bad.json") `
        -Version "0.96.0" `
        -AssetUrl $InitialUrl `
        -Sha256 ("0" * 64)

    $Python = if ($env:PYTHON) { $env:PYTHON } else { "python" }
    $ServerArguments = "-m http.server $Port --bind 127.0.0.1 --directory `"$ServerRoot`""
    $Server = Start-Process `
        -FilePath $Python `
        -ArgumentList $ServerArguments `
        -WindowStyle Hidden `
        -PassThru `
        -RedirectStandardOutput (Join-Path $Root "server.out") `
        -RedirectStandardError (Join-Path $Root "server.err")
    Wait-ForServer

    $InstallEnvironment = @{
        LOCALAPPDATA = $LocalAppData
        METADATA_URL = "http://127.0.0.1:$Port/dl/cli/v0.96.0.json"
    }
    $Install = Invoke-Installer -Environment $InstallEnvironment
    Assert-Smoke ($Install.ExitCode -eq 0) "default-prefix install failed: $($Install.Output)"
    $BinDir = Join-Path (Join-Path $LocalAppData "chan-cli") "bin"
    $Installed = Join-Path $BinDir "chan.exe"
    Assert-Smoke ([System.IO.File]::Exists($Installed)) "chan.exe was not installed"
    Assert-Smoke (
        (Get-FileHash -LiteralPath $Installed -Algorithm SHA256).Hash -ceq
        (Get-FileHash -LiteralPath $TestBinary -Algorithm SHA256).Hash
    ) "installed binary does not match the verified archive payload"
    foreach ($Shim in @("cs.cmd", "cs")) {
        Assert-Smoke ([System.IO.File]::Exists((Join-Path $BinDir $Shim))) "missing $Shim shim"
    }
    $CmdShim = [System.IO.File]::ReadAllText((Join-Path $BinDir "cs.cmd"))
    $PosixShim = [System.IO.File]::ReadAllText((Join-Path $BinDir "cs"))
    Assert-Smoke ($CmdShim.Contains("set `"ARGV0=cs`"")) "cs.cmd does not select cs argv0"
    Assert-Smoke ($PosixShim.Contains("export ARGV0=cs")) "Git Bash cs does not select cs argv0"
    Assert-Smoke (-not $CmdShim.Contains("CHAN_DESKTOP_HANDOFF")) "standalone cs.cmd forces desktop"
    Assert-Smoke (-not $PosixShim.Contains("CHAN_DESKTOP_HANDOFF")) "standalone Git Bash cs forces desktop"
    $Version = Invoke-CapturedProcess -FilePath $Installed -Arguments "--version"
    Assert-Smoke ($Version.ExitCode -eq 0 -and $Version.Output.StartsWith("chan ")) (
        "installed chan.exe did not run: $($Version.Output)"
    )

    $SecondInstall = Invoke-Installer -Environment @{
        LOCALAPPDATA = $LocalAppData
        BASE = "http://127.0.0.1:$Port/dl/cli"
        VERSION = "0.96.0"
    }
    Assert-Smoke ($SecondInstall.ExitCode -eq 0) "idempotent BASE/VERSION install failed"
    $UserPath = [System.Environment]::GetEnvironmentVariable(
        "Path",
        [System.EnvironmentVariableTarget]::User
    )
    $WantedPath = Normalized-PathEntry $BinDir
    $PathMatches = @(
        $UserPath.Split(";") |
            Where-Object { (Normalized-PathEntry $_) -eq $WantedPath }
    )
    Assert-Smoke ($PathMatches.Count -eq 1) "user PATH contains the standalone bin more than once"

    $BadPrefix = Join-Path $Root "bad-prefix"
    $Bad = Invoke-Installer -Environment @{
        LOCALAPPDATA = $LocalAppData
        PREFIX = $BadPrefix
        METADATA_URL = "http://127.0.0.1:$Port/dl/cli/bad.json"
    }
    Assert-Smoke ($Bad.ExitCode -ne 0 -and $Bad.Output.Contains("SHA256 mismatch")) (
        "bad SHA256 was not rejected: $($Bad.Output)"
    )
    Assert-Smoke (
        -not [System.IO.File]::Exists((Join-Path (Join-Path $BadPrefix "bin") "chan.exe"))
    ) "bad SHA256 wrote a binary"

    $ForeignPrefix = Join-Path $Root "foreign-prefix"
    $ForeignBin = Join-Path $ForeignPrefix "bin"
    [System.IO.Directory]::CreateDirectory($ForeignBin) | Out-Null
    $ForeignExe = Join-Path $ForeignBin "chan.exe"
    [System.IO.File]::WriteAllText($ForeignExe, "foreign", $Utf8)
    $Foreign = Invoke-Installer -Environment @{
        LOCALAPPDATA = $LocalAppData
        PREFIX = $ForeignPrefix
        METADATA_URL = "http://127.0.0.1:$Port/dl/cli/v0.96.0.json"
    }
    Assert-Smoke ($Foreign.ExitCode -ne 0 -and $Foreign.Output.Contains("unowned command")) (
        "foreign command was not refused: $($Foreign.Output)"
    )
    Assert-Smoke ([System.IO.File]::ReadAllText($ForeignExe) -ceq "foreign") (
        "foreign command was modified"
    )

    $Arm = Invoke-Installer -Environment @{
        LOCALAPPDATA = $LocalAppData
        PREFIX = (Join-Path $Root "arm-prefix")
        METADATA_URL = "http://127.0.0.1:$Port/dl/cli/v0.96.0.json"
        PROCESSOR_ARCHITEW6432 = "ARM64"
    }
    Assert-Smoke ($Arm.ExitCode -ne 0 -and $Arm.Output.Contains("ARM64")) (
        "ARM64 was not refused: $($Arm.Output)"
    )

    $DesktopBin = Join-Path (Join-Path $LocalAppData "chan") "bin"
    [System.IO.Directory]::CreateDirectory($DesktopBin) | Out-Null
    [System.IO.File]::WriteAllText(
        (Join-Path $DesktopBin "chan.cmd"),
        ":: chan-desktop bin shim`r`n",
        $Utf8
    )
    $Conflict = Invoke-Installer -Environment @{
        LOCALAPPDATA = $LocalAppData
        PREFIX = (Join-Path $Root "conflict-prefix")
        METADATA_URL = "http://127.0.0.1:$Port/dl/cli/v0.96.0.json"
    }
    Assert-Smoke ($Conflict.ExitCode -ne 0 -and $Conflict.Output.Contains("Chan Desktop")) (
        "desktop command ownership was not refused: $($Conflict.Output)"
    )
    Remove-Item -LiteralPath (Join-Path $DesktopBin "chan.cmd") -Force

    $Upgrade = Invoke-CapturedProcess -FilePath $Installed -Arguments "upgrade -y --verbose"
    Assert-Smoke ($Upgrade.ExitCode -eq 0) "chan upgrade failed: $($Upgrade.Output)"
    $ExpectedBinarySha = (Get-FileHash -LiteralPath $UpgradeBinary -Algorithm SHA256).Hash
    $Replaced = $false
    for ($Attempt = 0; $Attempt -lt 100; $Attempt += 1) {
        try {
            if ((Get-FileHash -LiteralPath $Installed -Algorithm SHA256).Hash -ceq $ExpectedBinarySha) {
                $Replaced = $true
                break
            }
        } catch {
            # The self-replace helper may hold the destination between swaps.
        }
        Start-Sleep -Milliseconds 100
    }
    Assert-Smoke $Replaced "self-upgrade did not replace chan.exe with the verified payload"
    $UpgradedVersion = Invoke-CapturedProcess -FilePath $Installed -Arguments "--version"
    Assert-Smoke ($UpgradedVersion.ExitCode -eq 0 -and $UpgradedVersion.Output.StartsWith("chan ")) (
        "upgraded chan.exe did not run: $($UpgradedVersion.Output)"
    )

    Write-Host "windows installer smoke: install, refusal cases, PATH, and self-upgrade PASS"
} finally {
    [System.Environment]::SetEnvironmentVariable(
        "Path",
        $OriginalUserPath,
        [System.EnvironmentVariableTarget]::User
    )
    if ($null -ne $Server -and -not $Server.HasExited) {
        $Server.Kill()
        $Server.WaitForExit()
    }
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
