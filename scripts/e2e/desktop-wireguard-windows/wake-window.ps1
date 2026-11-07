param(
    [Parameter(Mandatory=$true)][int]$DesktopPid,
    [Parameter(Mandatory=$true)][string]$Needle,
    [Parameter(Mandatory=$true)][string]$Directory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WakeNative {
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr arg);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr arg);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    public static IntPtr[] Windows(int pid, string needle) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, arg) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner != pid || !IsWindowVisible(hwnd)) return true;
            var title = new StringBuilder(1024);
            GetWindowText(hwnd, title, title.Capacity);
            if (title.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    public static IntPtr[] OtherWindows(int pid, IntPtr selected) {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, arg) => {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if (owner == pid && hwnd != selected && IsWindowVisible(hwnd)) found.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
}
'@
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
function stamp([string]$name) { [IO.File]::WriteAllText((Join-Path $Directory $name), [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()) }
function client-box([IntPtr]$hwnd) {
    $rect = New-Object WakeNative+RECT
    $point = New-Object WakeNative+POINT
    if (-not [WakeNative]::GetClientRect($hwnd, [ref]$rect) -or -not [WakeNative]::ClientToScreen($hwnd, [ref]$point)) { throw 'client rectangle unavailable' }
    return @{ x=$point.X; y=$point.Y; w=$rect.Right - $rect.Left; h=$rect.Bottom - $rect.Top }
}
function capture([hashtable]$box, [string]$name) {
    if ($box.w -lt 600 -or $box.h -lt 300) { throw "client rectangle too small: $($box.w)x$($box.h)" }
    $bitmap = New-Object System.Drawing.Bitmap(420, 70)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($box.x + 40, $box.y + 60, 0, 0, $bitmap.Size)
        $bitmap.Save((Join-Path $Directory "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
        stamp "$name.at-ms"
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    return $box
}
function wait-file([string]$name, [int]$seconds, [IntPtr]$hwnd, [bool]$mustBeIconic) {
    $path = Join-Path $Directory $name
    $until = [DateTime]::UtcNow.AddSeconds($seconds)
    while (-not (Test-Path -LiteralPath $path)) {
        if ([DateTime]::UtcNow -ge $until) { throw "timed out waiting for $name" }
        if ($mustBeIconic -and -not [WakeNative]::IsIconic($hwnd)) { throw 'window left iconic state during dwell' }
        Start-Sleep -Milliseconds 250
    }
    return (Get-Content -Raw -LiteralPath $path).Trim()
}
try {
    $windows = @([WakeNative]::Windows($DesktopPid, $Needle))
    if ($windows.Count -ne 1) { throw "expected one HWND for $Needle, found $($windows.Count)" }
    $hwnd = $windows[0]
    foreach ($other in [WakeNative]::OtherWindows($DesktopPid, $hwnd)) { [void][WakeNative]::ShowWindow($other, 6) }
    [void][WakeNative]::ShowWindow($hwnd, 9)
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    [void][WakeNative]::SetWindowPos($hwnd, [IntPtr]::Zero, 40, 40, [Math]::Min(900, $screen.Width - 80), [Math]::Min(650, $screen.Height - 80), 4)
    [void][WakeNative]::SetForegroundWindow($hwnd)
    if ([WakeNative]::GetForegroundWindow() -ne $hwnd) { throw 'target could not become the foreground HWND' }
    [System.Windows.Forms.SendKeys]::SendWait('^+t')
    stamp 'seeded'
    [void](wait-file 'baseline-ready' 90 $hwnd $false)
    Start-Sleep -Milliseconds 500
    $before = client-box $hwnd
    [void](capture $before 'before')
    [void][WakeNative]::ShowWindow($hwnd, 6)
    if (-not [WakeNative]::IsIconic($hwnd)) { throw 'target did not become iconic' }
    $baselineHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Directory 'before.png')).Hash
    $controlUntil = [DateTime]::UtcNow.AddSeconds(5)
    $previousHash = $null
    do {
        [void](capture $before 'blank-control')
        $controlHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Directory 'blank-control.png')).Hash
        if (($controlHash -ne $baselineHash -and $controlHash -eq $previousHash) -or [DateTime]::UtcNow -ge $controlUntil) { break }
        $previousHash = $controlHash
        Start-Sleep -Milliseconds 100
    } while ($true)
    @{ hwnd=$hwnd.ToInt64(); before=$before; pid=$DesktopPid; needle=$Needle; iconic=$true } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Directory 'window-before.json')
    stamp 'ready'
    [void](wait-file 'resume' 175 $hwnd $true)
    if (-not [WakeNative]::IsIconic($hwnd)) { throw 'target was no longer iconic before restore' }
    [void][WakeNative]::ShowWindow($hwnd, 9)
    [void][WakeNative]::SetForegroundWindow($hwnd)
    [void](capture $before 'first-after')
    Start-Sleep -Seconds 2
    [void](capture $before 'after-2s')
    $after = client-box $hwnd
    @{ hwnd=$hwnd.ToInt64(); after=$after; iconic=[WakeNative]::IsIconic($hwnd) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Directory 'window-after.json')
    stamp 'captured'
    $decision = wait-file 'decision' 90 $hwnd $false
    if ($decision -eq 'recover') {
        $box = client-box $hwnd
        [void][WakeNative]::SetCursorPos($box.x + 100, $box.y + 220)
        [WakeNative]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
        [WakeNative]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 500
        [void](capture $before 'recovery-click')
        [System.Windows.Forms.SendKeys]::SendWait('^+]')
        Start-Sleep -Milliseconds 500
        [void](capture $before 'recovery-tab')
        $outer = New-Object WakeNative+RECT
        if (-not [WakeNative]::GetWindowRect($hwnd, [ref]$outer)) { throw 'window rectangle unavailable' }
        $w = $outer.Right - $outer.Left; $h = $outer.Bottom - $outer.Top
        [void][WakeNative]::SetWindowPos($hwnd, [IntPtr]::Zero, $outer.Left, $outer.Top, $w + 1, $h, 4)
        [void][WakeNative]::SetWindowPos($hwnd, [IntPtr]::Zero, $outer.Left, $outer.Top, $w, $h, 4)
        Start-Sleep -Milliseconds 500
        [void](capture $before 'recovery-resize')
        [void][WakeNative]::ShowWindow($hwnd, 6)
        [void][WakeNative]::ShowWindow($hwnd, 9)
        Start-Sleep -Milliseconds 500
        [void](capture $before 'recovery-hide-show')
        [System.Windows.Forms.SendKeys]::SendWait('^+r')
        Start-Sleep -Seconds 2
        [void](capture $before 'recovery-reload')
    } elseif ($decision -ne 'finish') { throw "unknown decision $decision" }
    stamp 'done'
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $Directory 'error')
    stamp 'done'
    exit 3
}
