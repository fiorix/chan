#!/usr/bin/env bash
# Run from the owner's selected chan terminal, preserving one export attempt.
set -euo pipefail
umask 077

document=${1:?document path required}
output=${2:?fresh absolute evidence directory required}
: "${OWNER_ARRANGEMENT:?describe caller/renderer windows, visibility and machine}"
: "${OWNER_ENGINE:?record native engine or browser and version}"
[[ $output == /* && ! -e $output && ! -L $output ]] || { printf 'output must be a fresh absolute directory\n' >&2; exit 3; }
[[ -f $document ]] || { printf 'document does not exist in this workspace\n' >&2; exit 3; }
mkdir -m 700 "$output"
chan_bin=${CHAN_BIN:-chan}
"$chan_bin" --version > "$output/build.txt"
python3 - "$document" "$output/input.json" <<'PY'
import hashlib, json, os, platform, sys
from pathlib import Path
path = Path(sys.argv[1])
Path(sys.argv[2]).write_text(json.dumps({"input": str(path.resolve()), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "arrangement": os.environ["OWNER_ARRANGEMENT"], "engine": os.environ["OWNER_ENGINE"], "os": platform.platform(), "caller_window": os.environ.get("CHAN_WINDOW_ID")}) + "\n")
PY
"$chan_bin" shell window list --json > "$output/windows.before.json" 2> "$output/windows.before.stderr"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$output/started"
status=0
"$chan_bin" shell export "$document" --out "$output/export.pdf" > "$output/export.stdout" 2> "$output/export.stderr" || status=$?
printf '%s\n' "$status" > "$output/export.status"
date -u '+%Y-%m-%dT%H:%M:%SZ' > "$output/finished"
python3 - "$output" "$status" <<'PY'
import hashlib, json, sys
from pathlib import Path
root = Path(sys.argv[1])
pdf = root / "export.pdf"
result = {"exit_status": int(sys.argv[2]), "pdf_exists": pdf.is_file(), "visual_reading": "pending"}
if pdf.is_file():
    result.update(pdf_bytes=pdf.stat().st_size, pdf_sha256=hashlib.sha256(pdf.read_bytes()).hexdigest(), pdf_header=pdf.read_bytes()[:5] == b"%PDF-")
(root / "summary.json").write_text(json.dumps(result) + "\n")
print(json.dumps(result))
PY
exit "$status"
