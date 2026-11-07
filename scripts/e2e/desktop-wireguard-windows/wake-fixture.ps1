param(
    [Parameter(Mandatory=$true)][string]$Directory,
    [Parameter(Mandatory=$true)][string]$Nonce,
    [Parameter(Mandatory=$true)][string]$TaskName
)
$ErrorActionPreference = 'Stop'
$candidates = @((Join-Path $env:LOCALAPPDATA 'Chan\chan.exe'), (Join-Path $env:LOCALAPPDATA 'Chan\resources\chan.exe'))
$cli = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $cli) { throw 'installer has no console chan.exe' }
$local = Join-Path $Directory "wake-local-$Nonce"
$dev = Join-Path $Directory "wake-dev-$Nonce"
$devHome = Join-Path $Directory 'wake-devhome'
New-Item -ItemType Directory -Force -Path $local, $dev, $devHome | Out-Null
$localOutput = & $cli serve $local 2>&1
if ($LASTEXITCODE -ne 0) { throw "local serve failed: $localOutput" }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$script = Join-Path $Directory 'wake-devserver.ps1'
$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Cli "{1}" -DevHome "{2}" -Port {3} -Directory "{4}"' -f $script, $cli, $devHome, $port, $Directory
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
$pidPath = Join-Path $Directory 'wake-devserver.pid'
$until = [DateTime]::UtcNow.AddSeconds(60)
while (-not (Test-Path -LiteralPath $pidPath) -and [DateTime]::UtcNow -lt $until) {
    $startError = Join-Path $Directory 'wake-devserver.start-error'
    if (Test-Path -LiteralPath $startError) { throw "devserver task failed: $(Get-Content -Raw -LiteralPath $startError)" }
    Start-Sleep -Milliseconds 250
}
if (-not (Test-Path -LiteralPath $pidPath)) { throw 'devserver task did not write its PID in 60s' }
$serverPid = [int](Get-Content -Raw -LiteralPath $pidPath)
$until = [DateTime]::UtcNow.AddSeconds(60)
$ready = $false
while ([DateTime]::UtcNow -lt $until) {
    if (-not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { throw 'devserver exited before its listener was ready' }
    try {
        $socket = [Net.Sockets.TcpClient]::new('127.0.0.1', $port)
        $socket.Dispose()
        $ready = $true
        break
    } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $ready) { throw 'devserver did not listen in 60s' }
$configPath = Join-Path $devHome 'devserver\config.json'
if (-not (Test-Path -LiteralPath $configPath)) { throw 'devserver token file absent' }
$token = (Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json).devserver_token
$label = "wake-$Nonce"
$url = "http://127.0.0.1:$port"
& $cli devserver register "$url/?t=$token" --name $label > $null 2> $null
if ($LASTEXITCODE -ne 0) { throw 'register failed' }
$connect = & $cli devserver connect $label 2>&1
if ($LASTEXITCODE -ne 0) { throw "connect failed: $connect" }
$until = [DateTime]::UtcNow.AddSeconds(60)
$connected = $false
while ([DateTime]::UtcNow -lt $until) {
    $list = & $cli devserver ls --json 2>$null | ConvertFrom-Json
    if (@($list.devservers | Where-Object { $_.label -eq $label -and $_.status -eq 'connected' }).Count -eq 1) { $connected = $true; break }
    Start-Sleep -Milliseconds 500
}
if (-not $connected) { throw 'devserver did not connect in 60s' }
$serve = & $cli workspace serve $dev --on $label 2>&1
if ($LASTEXITCODE -ne 0) { throw "dev workspace serve failed: $serve" }
$record = Invoke-RestMethod -Method Post -Uri "$url/api/library/windows" -Headers @{ Authorization="Bearer $token" } -ContentType 'application/json' -Body (@{ kind='workspace'; workspace_path=$dev } | ConvertTo-Json -Compress) -TimeoutSec 20
if (-not $record.window_id) { throw 'devserver mint did not return window_id' }
@{ local=$local; devserver=$dev; devWindowId=$record.window_id; devserverPid=$serverPid; label=$label; port=$port; cli=$cli } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $Directory 'wake-fixture.json')
