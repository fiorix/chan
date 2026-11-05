#!/usr/bin/env bash
# Release runners have the VC redistributable installed; running chan.exe
# there cannot detect a dependency that prevents startup on a clean Windows.
set -euo pipefail

BIN="${1:?usage: check-windows-crt.sh <chan.exe>}"
OBJDUMP="${LLVM_OBJDUMP:-llvm-objdump}"

if ! headers="$("$OBJDUMP" -p "$BIN")"; then
    echo "error: cannot read Windows imports from $BIN with $OBJDUMP" >&2
    exit 1
fi

if ! grep -Eq 'file format coff-' <<<"$headers"; then
    echo "error: $BIN is not a Windows PE binary" >&2
    exit 1
fi
imports="$(awk '$1 == "DLL" && $2 == "Name:" { sub(/\r$/, "", $3); print $3 }' <<<"$headers")"
if [ -z "$imports" ]; then
    echo "error: no DLL imports found in $BIN" >&2
    exit 1
fi
printf 'Windows DLL imports (%s):\n%s\n' "$BIN" "$imports"

if forbidden="$(grep -Ei '^(VCRUNTIME|MSVCP).*\.dll$' <<<"$imports")"; then
    printf 'error: %s requires the Visual C++ Redistributable:\n%s\n' "$BIN" "$forbidden" >&2
    exit 1
fi
echo "Windows CRT check: no VCRUNTIME or MSVCP DLL imports"
