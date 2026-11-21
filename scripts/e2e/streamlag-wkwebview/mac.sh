#!/usr/bin/env bash
# Runs the WKWebView stall measurement on a throwaway chan home. See README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
T="${WKSTALL_DIR:-/private/tmp/chan-wkstall}"
APP_BIN="${WKSTALL_APP_BIN:-$root/target/release/bundle/macos/Chan.app/Contents/MacOS/chan-desktop}"
MIN_FREE_GIB=40

die() { echo "STOP: $*" >&2; exit 1; }
desktop_running() { pgrep -x chan-desktop >/dev/null; }

real_state() {
    if [ -d "$HOME/.chan" ]; then
        find "$HOME/.chan" -maxdepth 2 -type f -exec stat -f '%m %z %N' {} + | sort -k3
    fi
    local link
    for link in chan cs chan-files chan-edit; do
        printf 'link %s -> %s\n' "$link" "$(readlink "$HOME/.local/bin/$link" 2>/dev/null || echo none)"
    done
}

check_real_home() {
    real_state | diff "$T/real.before" - >/dev/null || die "the real chan home changed: quit the build (Cmd+Q) and report this"
    echo "real home untouched"
}

cmd_prepare() {
    [ "$(uname -s)" = Darwin ] || die "this runs on macOS"
    { [ -z "${CHAN:-}" ] && [ -z "${CHAN_HOME:-}" ]; } || die "use Terminal.app, not a terminal inside Chan"
    [ -z "$(git -C "$root" status --porcelain)" ] || die "the checkout has changes"
    [ -x "$APP_BIN" ] || die "no build at $APP_BIN: run make -C desktop build"
    if desktop_running; then die "quit Chan first (Cmd+Q)"; fi
    [ ! -e "$T" ] || die "$T exists: run cleanup first"
    local free_kib real_port port
    free_kib="$(df -k "$(dirname "$T")" | awk 'NR==2 {print $4}')"
    [ "$free_kib" -ge $((MIN_FREE_GIB * 1024 * 1024)) ] || die "less than $MIN_FREE_GIB GiB free"
    real_port="$(grep -o '"embedded_port": *[0-9]*' "$HOME/.chan/desktop/config.json" 2>/dev/null | grep -o '[0-9]*$' || true)"
    port=47611
    [ "$port" != "$real_port" ] || port=47612
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then die "port $port is in use"; fi

    mkdir "$T"
    mkdir -m 700 "$T/home" "$T/run" "$T/out"
    mkdir -p "$T/home/desktop" "$T/notes"
    printf '# Stream measurement\n' > "$T/notes/README.md"
    printf '{"embedded_port": %s}\n' "$port" > "$T/home/desktop/config.json"
    cp "$here/flood.pl" "$T/flood.pl"
    git -C "$root" rev-parse HEAD > "$T/head"
    { sw_vers; uname -m; } > "$T/out/host.txt"
    cat > "$T/env.sh" <<EOF
for v in \$(env | sed -n 's/^\(CHAN_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "\$v"; done
unset CHAN
export CHAN_HOME="$T/home"
export XDG_RUNTIME_DIR="$T/run"
export CHAN_UPDATE_CHECK=0
export CHAN_LOG=chan_desktop=info,warn
export CHAN_TERMINAL_MEASURE_LOG="$T/out/server-events.jsonl"
EOF
    real_state > "$T/real.before"
    echo "prepared: real port ${real_port:-none}, throwaway port $port"
}

cmd_start() {
    [ -f "$T/env.sh" ] || die "run prepare first"
    if desktop_running; then die "a chan-desktop is running: quit it first"; fi
    [ ! -e "$T/out/server-events.jsonl" ] || die "this run already holds a trace: run cleanup and prepare again"
    (
        # shellcheck source=/dev/null
        . "$T/env.sh"
        nohup "$APP_BIN" >> "$T/run.out" 2>> "$T/desktop.log" < /dev/null &
    )
    local tries=0 head
    until grep -q 'chan-desktop starting' "$T/desktop.log" 2>/dev/null; do
        tries=$((tries + 1))
        [ "$tries" -le 30 ] || die "the build did not start: read $T/desktop.log"
        sleep 1
    done
    sleep 5
    head="$(cat "$T/head")"
    grep 'chan-desktop starting' "$T/desktop.log" | grep -q "git-${head:0:12}" || die "the running build is not this commit: quit it (Cmd+Q) and rebuild"
    if grep 'chan-desktop starting' "$T/desktop.log" | grep -q -- '-dirty'; then die "the build is dirty: quit it (Cmd+Q) and rebuild"; fi
    check_real_home
    local open_real
    open_real="$(lsof -p "$(pgrep -x chan-desktop)" 2>/dev/null | grep -c "$HOME/.chan/" || true)"
    [ "$open_real" = 0 ] || die "the build holds files in the real home: quit it (Cmd+Q) and report this"
    if grep -q 'saved embedded port unavailable' "$T/desktop.log"; then die "the throwaway port was not taken: quit the build (Cmd+Q)"; fi
    nohup node "$here/sample.mjs" "$T/out" "$T/flood.pid" > "$T/sampler.log" 2>&1 < /dev/null &
    echo "$!" > "$T/sampler.pid"
    echo "started on the throwaway home; sampler running"
}

cmd_open() {
    [ -f "$T/env.sh" ] || die "run prepare first"
    (
        # shellcheck source=/dev/null
        . "$T/env.sh"
        exec "$CHAN_HOME/.local/bin/chan" serve "$T/notes"
    )
}

cmd_copy() {
    pbcopy < "$here/stall.js"
    echo "the stall script is on the clipboard"
}

cmd_finish() {
    [ -d "$T/out" ] || die "nothing to finish"
    if desktop_running; then die "quit the build first (Cmd+Q)"; fi
    local tries=0
    while [ -f "$T/sampler.pid" ] && kill -0 "$(cat "$T/sampler.pid")" 2>/dev/null; do
        tries=$((tries + 1))
        [ "$tries" -le 15 ] || die "the sampler did not stop: read $T/sampler.log"
        sleep 1
    done
    if [ ! -s "$T/out/stalls.json" ]; then
        pbpaste > "$T/out/stalls.candidate"
        node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (!Array.isArray(s) || !s.length || !s.every((w) => w.startMs && w.endMs)) process.exit(1);' "$T/out/stalls.candidate" 2>/dev/null \
            || die "the clipboard holds no stall list: copy it again (README step 8) and rerun finish"
        mv "$T/out/stalls.candidate" "$T/out/stalls.json"
    fi
    check_real_home
    node "$here/analyze.mjs" "$T/out"
    local keep
    keep="$root/dev/streamlag-wkwebview"
    mkdir -p "$keep"
    cp "$T/out/summary.json" "$keep/summary-$(date -u +%Y%m%dT%H%M%SZ).json"
    echo "summary saved under $keep"
}

cmd_cleanup() {
    if desktop_running; then die "quit the build first (Cmd+Q)"; fi
    [ -d "$T" ] || { echo "nothing to clean"; return; }
    [ ! -f "$T/real.before" ] || check_real_home
    rm -rf -- "$T"
    echo "removed $T"
}

case "${1:-}" in
prepare) cmd_prepare ;;
start) cmd_start ;;
open) cmd_open ;;
copy) cmd_copy ;;
finish) cmd_finish ;;
cleanup) cmd_cleanup ;;
*) die "usage: mac.sh prepare|start|open|copy|finish|cleanup" ;;
esac
