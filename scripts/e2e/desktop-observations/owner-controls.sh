#!/usr/bin/env bash
# WebKitGTK page readings and a measured pair of real Reload from disk actions.
set -euo pipefail
umask 077
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command=${1:?reading, double-reload or record required}
root=${2:?generated fixture directory required}
output=${3:?fresh absolute output file required}
[[ $output == /* && ! -e $output && ! -L $output ]] || { printf 'output must be a fresh absolute file\n' >&2; exit 3; }
case "$command" in
record)
    : "${OWNER_ENGINE:?record engine and version}"
    : "${OWNER_RESULT:?passed, failed, inconclusive or unavailable}"
    : "${OWNER_OBSERVATION:?state exactly what was seen}"
    python3 - "$root" "$output" <<'PY'
import json, os, sys, time
from pathlib import Path
result = os.environ["OWNER_RESULT"]
if result not in ("passed", "failed", "inconclusive", "unavailable"):
    raise SystemExit("invalid result")
with Path(sys.argv[2]).open("x") as stream:
    stream.write(json.dumps({"at_ns": time.time_ns(), "fixture": str(Path(sys.argv[1]).resolve()), "engine": os.environ["OWNER_ENGINE"], "result": result, "observation": os.environ["OWNER_OBSERVATION"], "candidate": os.environ.get("OWNER_CANDIDATE"), "arrangement": os.environ.get("OWNER_ARRANGEMENT")}) + "\n")
PY
    exit 0
    ;;
reading|double-reload) ;;
*) printf 'invalid command\n' >&2; exit 3 ;;
esac
: "${OWNER_INSPECTOR:?private WebKitGTK inspector host:port required}"
: "${OWNER_PAGE:?unique page title or URL substring required}"
# Verify identity even after the intentionally editable fixture files change.
marker=$(python3 - "$root/fixture.json" "$root" <<'PY'
import json, sys
from pathlib import Path
m = json.loads(Path(sys.argv[1]).read_text())
if m.get("fixture") != "desktop-owner-controls" or m.get("root") != str(Path(sys.argv[2]).resolve()):
    raise SystemExit("not the generated fixture")
print(json.dumps(m["recovery_marker"]))
PY
)
if [[ $command == reading ]]; then
    expression="(() => { const marker = $marker; const keys = Object.keys(localStorage).filter(k => k.startsWith('chan:editor-buffer:') && k.includes('recovery/note.md')); return {marker, origin: location.origin, stored: keys.some(k => (localStorage.getItem(k) ?? '').includes(marker)), editor: [...document.querySelectorAll('.cm-content')].some(e => e.textContent.includes(marker)), page: document.readyState}; })()"
    node "$here/inspect.mjs" "$OWNER_INSPECTOR" eval "$OWNER_PAGE" "$expression" > "$output"
    exit 0
fi
expression=$(cat <<'JS'
(() => {
  if (window.__ownerReload) throw new Error('reload trigger already used in this page');
  if (localStorage.getItem('chan.scenesync') === '0') throw new Error('scene sync disabled');
  const tabs = [...document.querySelectorAll('[role=tab][aria-selected=true]')].filter(t => t.textContent.includes('duplicate-id.excalidraw'));
  if (tabs.length !== 1) throw new Error('select the one duplicate-id drawing tab');
  const state = window.__ownerReload = {clicks: [], status: 'pending', sceneSyncEnabled: true};
  const until = performance.now() + 900;
  const step = () => {
    try {
      const menus = [...document.querySelectorAll('[aria-label="tab menu"] button')].filter(b => b.textContent.trim() === 'Reload from disk');
      if (menus.length === 1 && !menus[0].disabled) {
        state.clicks.push(performance.now());
        menus[0].click();
        if (state.clicks.length === 2) { state.status = 'clicked'; state.gapMs = state.clicks[1] - state.clicks[0]; return; }
      }
      if (performance.now() > until) throw new Error('two reload actions did not become available inside 900ms');
      if (!document.querySelector('[aria-label="tab menu"]')) tabs[0].dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 50, clientY: 50}));
      setTimeout(step, 0);
    } catch (error) { state.status = 'inconclusive'; state.error = String(error); }
  };
  step();
  return {started: true};
})()
JS
)
node "$here/inspect.mjs" "$OWNER_INSPECTOR" eval "$OWNER_PAGE" "$expression" > "$output.started"
for _ in $(seq 1 10); do
    node "$here/inspect.mjs" "$OWNER_INSPECTOR" eval "$OWNER_PAGE" 'window.__ownerReload' > "$output.probe"
    if python3 - "$output.probe" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
sys.exit(0 if value.get("status") != "pending" else 1)
PY
    then break; fi
    sleep 0.1
done
mv "$output.probe" "$output"
python3 - "$output" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
print(json.dumps(value))
sys.exit(0 if value.get("status") == "clicked" and len(value.get("clicks", [])) == 2 and 0 <= value.get("gapMs", 1000) < 1000 else 3)
PY
