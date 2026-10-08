#!/usr/bin/env bash
# Run from the owner's selected chan terminal, in the workspace's root, with
# the document by its workspace-relative path; preserves one export attempt.
# `cs export` writes its PDF through the workspace and takes a
# workspace-relative `--out`, so the export goes to a fresh name beside the
# document and is moved into the evidence directory afterwards.
set -euo pipefail
umask 077

document=${1:?document path required}
output=${2:?fresh absolute evidence directory required}
: "${OWNER_ARRANGEMENT:?describe caller/renderer windows, visibility and machine}"
: "${OWNER_ENGINE:?record native engine or browser and version}"
[[ $output == /* && ! -e $output && ! -L $output ]] || { printf 'output must be a fresh absolute directory\n' >&2; exit 3; }
[[ -f $document ]] || { printf 'document does not exist in this workspace\n' >&2; exit 3; }
[[ $document != /* ]] || { printf 'name the document by its workspace-relative path, from the workspace root\n' >&2; exit 3; }
transfer="${document%/*}/owner-export-$$-$RANDOM.pdf"
[[ $document == */* ]] || transfer="owner-export-$$-$RANDOM.pdf"
[[ ! -e $transfer && ! -L $transfer ]] || { printf 'the export path beside the document is taken\n' >&2; exit 3; }
mkdir -m 700 "$output"
printf '%s\n' "$transfer" > "$output/transfer-path"
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
"$chan_bin" shell export "$document" --out "$transfer" > "$output/export.stdout" 2> "$output/export.stderr" || status=$?
printf '%s\n' "$status" > "$output/export.status"
moved=0
if [[ -f $transfer && ! -L $transfer ]]; then
    mv -- "$transfer" "$output/export.pdf" || moved=3
fi
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
if [[ $status == 0 && ! -f $output/export.pdf ]]; then
    printf 'the export answered 0 and left no PDF at %s; run this from the workspace root\n' "$transfer" >&2
    exit 3
fi
[[ $moved == 0 ]] || { printf 'the PDF could not be moved into the evidence directory\n' >&2; exit 3; }
exit "$status"
