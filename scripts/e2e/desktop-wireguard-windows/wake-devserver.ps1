param(
    [Parameter(Mandatory=$true)][string]$Cli,
    [Parameter(Mandatory=$true)][string]$DevHome,
    [Parameter(Mandatory=$true)][int]$Port,
    [Parameter(Mandatory=$true)][string]$Directory
)
$ErrorActionPreference = 'Stop'
$env:CHAN_HOME = $DevHome
try {
    $server = Start-Process -FilePath $Cli -ArgumentList @('devserver', 'run', '--service=none', '--bind', '127.0.0.1', '--port', [string]$Port) -RedirectStandardOutput (Join-Path $Directory 'wake-devserver.out') -RedirectStandardError (Join-Path $Directory 'wake-devserver.err') -WindowStyle Hidden -PassThru
    $server.Id | Set-Content -LiteralPath (Join-Path $Directory 'wake-devserver.pid')
    $server.WaitForExit()
    exit $server.ExitCode
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $Directory 'wake-devserver.start-error')
    exit 3
}
