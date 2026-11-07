#!/usr/bin/env bash
# Sourced only by desktop-wireguard-windows.sh after its positive desktop run.
# A CDP freeze is a renderer lifecycle surrogate, not WebView2 IsSuspended.

wake_log() { printf 'desktop-wake-windows: %s\n' "$*" >&2; }
wake_masked() {
    sed -E 's/([?&](t|h|token|access_token)=)[^&#[:space:]"]+/\1<token>/g; s/(#s=)[^&[:space:]"]+/\1<state>/g; s/(CHAN_DEVSERVER_TOKEN=)[^[:space:]]+/\1<token>/g; s/("(devserver_)?token"[[:space:]]*:[[:space:]]*")[^"]*"/\1<token>"/g; s/(PrivateKey[[:space:]]*=[[:space:]]*)[^[:space:]]+/\1<redacted>/g'
}
wake_copy_diagnostics() {
    local name
    for name in wake.err wake.out wake-devserver.out wake-devserver.err; do
        if ! client_ps 45 <<PS | wake_masked > "$WORK/$name"; then
\$ErrorActionPreference = 'Stop'
Get-Content -Raw -LiteralPath "$CLIENT_DIR\\$name"
PS
            wake_log "INCONCLUSIVE diagnostic windows: could not copy $name before client cleanup"
            if [[ $WAKE_RESULT == 0 ]]; then WAKE_RESULT=3; fi
        fi
    done
    if grep -Eq 'os error (10054|10061)' "$WORK/wake.err"; then
        wake_log 'INCONCLUSIVE diagnostic windows: desktop logged a devserver disconnect or refusal during the wake arms'
        if [[ $WAKE_RESULT == 0 ]]; then WAKE_RESULT=3; fi
    fi
}
wake_client_file() {
    client_ps 15 <<PS | grep -qx True
Test-Path -LiteralPath "$CLIENT_DIR\\wake-$1-$2\\$3"
PS
}
wake_wait() {
    local kind=$1 mode=$2 file=$3 seconds=$4 deadline
    deadline=$((SECONDS + seconds))
    until wake_client_file "$kind" "$mode" "$file"; do
        if wake_client_file "$kind" "$mode" error; then return 1; fi
        [ "$SECONDS" -lt "$deadline" ] || return 1
        sleep 0.5
    done
}
wake_signal() {
    client_ps 20 <<PS >/dev/null
Set-Content -LiteralPath "$CLIENT_DIR\\wake-$1-$2\\$3" -Value '$4'
PS
}
wake_error() {
    client_ps 15 <<PS > "$WORK/wake-$1-$2/guest-error.txt" || true
Get-Content -Raw -LiteralPath "$CLIENT_DIR\\wake-$1-$2\\error" -ErrorAction SilentlyContinue
PS
}
wake_copy() {
    local kind=$1 mode=$2 name=$3 destination=$4
    scp -q -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SCP_OPTS[@]}" \
        "$CLIENT_SSH:${CLIENT_DIR//\\//}/wake-$kind-$mode/$name" "$destination" 2>> "$WORK/client-stderr.log"
}
wake_pixel() {
    local dir=$1 label=$2
    python3 -I "$HERE/wake-pixels.py" --baseline "$dir/before.png" --blank "$dir/blank-control.png" \
        --candidate "$dir/$label.png" --output "$dir/$label.json" > "$dir/$label.reader"
}
wake_target() {
    local kind=$1
    node "$HELPERS/wake-cdp.mjs" targets "$LOCAL_CDP" | wake_masked > "$WORK/wake-targets.next.json" || return 1
    mv "$WORK/wake-targets.next.json" "$WORK/wake-targets.json"
    python3 -I - "$WORK/wake-targets-before.json" "$WORK/wake-targets.json" "$WORK/wake-fixture.json" "$kind" "$NONCE" <<'PY'
import json, sys
old, now = (json.load(open(path)) for path in sys.argv[1:3])
fixture = json.load(open(sys.argv[3]))
kind, nonce = sys.argv[4:]
dev_id, dev_port, label = fixture['devWindowId'], fixture['port'], fixture['label']
ids = {row['id'] for row in old}
new = [row for row in now if row['id'] not in ids]
workspace = [row for row in new if '/workspace-' in row['path']]
dev_origin = f':{dev_port}/'
if kind == 'devserver':
    matches = [
        row for row in new
        if row['windowId'] == dev_id or (
            row in workspace and (
                dev_origin in row['path'] or label in row.get('url', row['path']) or label in row['title']
            )
        )
    ]
else:
    matches = [row for row in workspace if 'wake-local-' + nonce in row['title'].lower()]
    if not matches:
        matches = [row for row in workspace if row['windowId'] != dev_id and dev_origin not in row['path'] and label not in row.get('url', row['path'])]
if len(matches) != 1:
    sys.exit(3)
print(matches[0]['id'])
PY
}
wake_wait_target() {
    local kind=$1 target mode dir deadline=$((SECONDS + 60))
    until target=$(wake_target "$kind"); do
        if [ "$SECONDS" -ge "$deadline" ]; then
            for mode in hidden synthetic-freeze; do
                dir="$WORK/wake-$kind-$mode"
                mkdir -p "$dir"
                if [ -s "$WORK/wake-targets.json" ]; then wake_masked < "$WORK/wake-targets.json" > "$dir/targets.json"; fi
            done
            return 3
        fi
        sleep 0.5
    done
    printf '%s\n' "$target"
}
wake_dev_connected() {
    client_ps 40 <<PS | grep -qx True
\$ErrorActionPreference = 'Stop'
\$fixture = Get-Content -Raw -LiteralPath "$CLIENT_DIR\\wake-fixture.json" | ConvertFrom-Json
\$server = Get-Process -Id ([int]\$fixture.devserverPid) -ErrorAction SilentlyContinue
\$cli = \$fixture.cli
\$list = & \$cli devserver ls --json 2>\$null | ConvertFrom-Json
[bool](\$server -and @(\$list.devservers | Where-Object { \$_.label -eq \$fixture.label -and \$_.status -eq 'connected' }).Count -eq 1)
PS
}
wake_page_state() {
    node "$HELPERS/cdp.mjs" eval "$LOCAL_CDP" "$1" \
        'JSON.stringify({url:location.origin+location.pathname,visibility:document.visibilityState,tabs:document.querySelectorAll("[role=tab]").length,tab:document.querySelector("[role=tab][aria-selected=true]")?.textContent})' > "$2" 2> "$2.err"
}
wake_geometry() {
    python3 -I - "$1/window-before.json" "$1/window-after.json" <<'PY'
import json, sys
a, b = (json.load(open(path)) for path in sys.argv[1:])
sys.exit(0 if a['hwnd'] == b['hwnd'] and a['before'] == b['after'] and a['iconic'] and not b['iconic'] else 3)
PY
}
wake_stop_task() {
    client_ps 15 <<PS >/dev/null 2>&1 || true
Stop-ScheduledTask -TaskName '$TAG-wake' -ErrorAction SilentlyContinue
PS
}
wake_arm() {
    local kind=$1 mode=$2 target=$3 needle=$4 dir rc=0 geometry=0 control=0 first=0 later=0 frozen=0 active=0 recovery_read=0 step recovery=none
    dir="$WORK/wake-$kind-$mode"
    mkdir -p "$dir"
    wake_page_state "$target" "$dir/page-before.json" || return 3
    client_ps 60 <<PS > "$dir/task-start.log" || return 3
\$ErrorActionPreference = 'Stop'
\$name = '$TAG-wake'
Stop-ScheduledTask -TaskName \$name -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName \$name -Confirm:\$false -ErrorAction SilentlyContinue
\$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "$CLIENT_DIR\\wake-window.ps1" -DesktopPid $DESKTOP_PID -Needle "$needle" -Directory "$CLIENT_DIR\\wake-$kind-$mode"'
\$principal = New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
Register-ScheduledTask -TaskName \$name -Action \$action -Principal \$principal -Force | Out-Null
Start-ScheduledTask -TaskName \$name
PS
    if ! wake_wait "$kind" "$mode" seeded 30; then
        wake_error "$kind" "$mode"
        wake_stop_task
        wake_log "INCONCLUSIVE precondition windows $kind $mode: interactive window did not seed a tab"
        return 3
    fi
    local deadline=$((SECONDS + 60))
    until node "$HELPERS/cdp.mjs" eval "$LOCAL_CDP" "$target" \
        'document.readyState === "complete" && document.querySelectorAll("[role=tab]").length >= 1' \
        > "$dir/page-ready.probe" 2> "$dir/page-ready.err" && grep -qx true "$dir/page-ready.probe"; do
        if [ "$SECONDS" -ge "$deadline" ]; then
            wake_stop_task
            wake_log "INCONCLUSIVE precondition windows $kind $mode: page did not render a tab before baseline"
            return 3
        fi
        sleep 0.5
    done
    if ! wake_page_state "$target" "$dir/page-ready.json" || ! wake_signal "$kind" "$mode" baseline-ready 1; then
        wake_stop_task
        wake_log "INCONCLUSIVE precondition windows $kind $mode: rendered baseline handshake failed"
        return 3
    fi
    if ! wake_wait "$kind" "$mode" ready 30; then
        wake_error "$kind" "$mode"
        wake_log "INCONCLUSIVE precondition windows $kind $mode: interactive capture did not reach iconic state"
        return 3
    fi
    if [[ $mode == synthetic-freeze ]]; then
        node "$HELPERS/wake-cdp.mjs" freeze "$LOCAL_CDP" "$target" "$dir" > "$dir/cdp.log" 2> "$dir/cdp.err" &
        local cdp_pid=$!
        HOST_PIDS+=("$cdp_pid")
        local deadline=$((SECONDS + 30))
        until [[ -s $dir/frozen.json || -s $dir/cdp-error.txt ]]; do
            if [ "$SECONDS" -ge "$deadline" ]; then break; fi
            sleep 0.2
        done
        [[ -s $dir/frozen.json ]] && frozen=1
    else
        frozen=1
    fi
    if [[ $frozen == 1 ]]; then sleep 120; fi
    if [[ $mode == synthetic-freeze ]]; then
        : > "$dir/cdp-resume"
        local deadline=$((SECONDS + 20))
        until [[ -s $dir/active.json || -s $dir/cdp-error.txt ]]; do
            if [ "$SECONDS" -ge "$deadline" ]; then break; fi
            sleep 0.2
        done
        [[ -s $dir/active.json ]] && active=1
    else
        active=1
    fi
    wake_signal "$kind" "$mode" resume 1 || return 3
    if ! wake_wait "$kind" "$mode" captured 15; then
        wake_error "$kind" "$mode"
        wake_log "INCONCLUSIVE precondition windows $kind $mode: interactive first-frame capture failed"
        return 3
    fi
    for step in before blank-control first-after after-2s; do
        wake_copy "$kind" "$mode" "$step.png" "$dir/$step.png" || { wake_signal "$kind" "$mode" decision finish || true; return 3; }
        wake_copy "$kind" "$mode" "$step.at-ms" "$dir/$step.at-ms" || { wake_signal "$kind" "$mode" decision finish || true; return 3; }
    done
    wake_copy "$kind" "$mode" window-before.json "$dir/window-before.json" || { wake_signal "$kind" "$mode" decision finish || true; return 3; }
    wake_copy "$kind" "$mode" window-after.json "$dir/window-after.json" || { wake_signal "$kind" "$mode" decision finish || true; return 3; }
    wake_geometry "$dir" || geometry=$?
    [[ $geometry == 0 ]] || rc=3
    wake_pixel "$dir" blank-control || control=$?
    [[ $control == 10 ]] || rc=3
    wake_pixel "$dir" first-after || first=$?
    wake_pixel "$dir" after-2s || later=$?
    [[ $first == 0 || $first == 10 ]] || rc=3
    [[ $later == 0 || $later == 10 ]] || rc=3
    [[ $frozen == 1 && $active == 1 ]] || rc=3
    if [[ $control == 10 && $first == 10 && $later == 10 ]]; then recovery_read=1; fi
    if [[ $recovery_read == 0 && ( $rc == 3 || $first == 3 || $later == 3 ) ]]; then
        wake_signal "$kind" "$mode" decision finish || true
        wake_log "INCONCLUSIVE precondition windows $kind $mode: control=$control geometry=$geometry frozen=$frozen active=$active pixels=$first/$later"
        return 3
    fi
    if [[ $first == 0 && $later == 0 ]]; then
        wake_signal "$kind" "$mode" decision finish || return 3
        wake_wait "$kind" "$mode" 'done' 15 || return 3
        wake_page_state "$target" "$dir/page-after.json" || true
        wake_log "PASS presented windows $kind $mode: first and 2s frames match; PNGs $dir"
        return 0
    fi
    if [[ $later == 0 ]]; then
        recovery=automatic-by-2s
        wake_signal "$kind" "$mode" decision finish || return 3
    else
        wake_signal "$kind" "$mode" decision recover || return 3
    fi
    wake_wait "$kind" "$mode" 'done' 30 || return 3
    if [[ $later != 0 ]]; then
        for step in click tab resize hide-show reload; do
            wake_copy "$kind" "$mode" "recovery-$step.png" "$dir/recovery-$step.png" || return 3
            local score=0
            wake_pixel "$dir" "recovery-$step" || score=$?
            if [[ $score == 0 && $recovery == none ]]; then recovery=$step; fi
        done
    fi
    printf '%s\n' "$recovery" > "$dir/first-recovery.txt"
    wake_page_state "$target" "$dir/page-after.json" || true
    if [[ $rc == 3 ]]; then
        wake_log "INCONCLUSIVE precondition windows $kind $mode: control=$control geometry=$geometry frozen=$frozen active=$active pixels=$first/$later recovery=$recovery"
        return 3
    fi
    wake_log "FAIL blank windows $kind $mode: first=$first after-2s=$later recovery=$recovery; PNGs $dir"
    return 1
}

WAKE_RESULT=0
if ! scp -q -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR "${CLIENT_SCP_OPTS[@]}" \
    "$HELPERS/wake-window.ps1" "$HELPERS/wake-fixture.ps1" "$HELPERS/wake-devserver.ps1" "$CLIENT_SSH:${CLIENT_DIR//\\//}/" 2>> "$WORK/client-stderr.log"; then
    wake_log 'INCONCLUSIVE precondition windows: could not stage interactive capture fixture'
    WAKE_RESULT=3
    return 0
fi
if ! node "$HELPERS/wake-cdp.mjs" targets "$LOCAL_CDP" | wake_masked > "$WORK/wake-targets-before.json"; then
    wake_log 'INCONCLUSIVE precondition windows: CDP target list unavailable'
    WAKE_RESULT=3
    return 0
fi
if ! client_ps 180 <<PS > "$WORK/wake-fixture.log"; then
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$CLIENT_DIR\\wake-fixture.ps1" -Directory "$CLIENT_DIR" -Nonce "$NONCE" -TaskName '$TAG-wake-devserver'
if (\$LASTEXITCODE -ne 0) { exit \$LASTEXITCODE }
PS
    wake_log 'INCONCLUSIVE precondition windows: local or devserver fixture failed'
    WAKE_RESULT=3
    return 0
fi
if ! client_ps 30 <<PS > "$WORK/wake-fixture.json"; then
Get-Content -Raw -LiteralPath "$CLIENT_DIR\\wake-fixture.json"
PS
    wake_log 'INCONCLUSIVE precondition windows: fixture receipt unavailable'
    WAKE_RESULT=3
    return 0
fi
if ! wake_dev_connected; then
    wake_log 'INCONCLUSIVE precondition windows: fixture devserver did not survive the fixture SSH session as connected'
    WAKE_RESULT=3
    return 0
fi
wake_log 'fixture devserver remained connected after the fixture SSH session'
for kind in local devserver; do
    if [[ $kind == local ]]; then needle="wake-local-$NONCE"; else needle="wake-dev-$NONCE"; fi
    target=$(wake_wait_target "$kind") || target=''
    for mode in hidden synthetic-freeze; do
        if [[ -z $target ]]; then
            wake_log "INCONCLUSIVE precondition windows $kind $mode: no unique CDP target for $needle"
            arm=3
        else
            arm=0
            wake_arm "$kind" "$mode" "$target" "$needle" || arm=$?
        fi
        if [[ $arm == 3 && -n $target ]]; then wake_log "INCONCLUSIVE precondition windows $kind $mode: arm could not finish; work dir $WORK/wake-$kind-$mode"; fi
        if [[ $arm == 1 ]]; then WAKE_RESULT=1; elif [[ $arm != 0 && $WAKE_RESULT == 0 ]]; then WAKE_RESULT=3; fi
    done
done
if ! wake_dev_connected; then
    wake_log 'INCONCLUSIVE precondition windows: fixture devserver disconnected before the wake arms ended'
    if [[ $WAKE_RESULT == 0 ]]; then WAKE_RESULT=3; fi
else
    wake_log 'fixture devserver remained connected through the wake arms'
fi
wake_log 'The Windows guest did not cycle a verified display-off/DPMS state; CDP frozen is not WebView2 IsSuspended.'
