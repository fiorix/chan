#!/usr/bin/env bash
# Exercise the import detector without a Windows linker or runtime.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRT_TEST_DIR="$(mktemp -d)"
trap 'rm -rf -- "$CRT_TEST_DIR"' EXIT
export LLVM_OBJDUMP="$CRT_TEST_DIR/llvm-objdump stand-in"
export CRT_TEST_OUTPUT="$CRT_TEST_DIR/imports"
export CRT_TEST_STATUS=0
cat > "$LLVM_OBJDUMP" <<'EOF'
#!/usr/bin/env bash
cat "$CRT_TEST_OUTPUT"
exit "$CRT_TEST_STATUS"
EOF
chmod +x "$LLVM_OBJDUMP"

expect() {
    local want=$1 message=$2 got=0
    bash "$REPO/scripts/check-windows-crt.sh" "$CRT_TEST_DIR/chan cli.exe" > "$CRT_TEST_DIR/result" 2>&1 || got=$?
    if [ "$got" -ne "$want" ] || ! grep -Fq "$message" "$CRT_TEST_DIR/result"; then
        cat "$CRT_TEST_DIR/result" >&2
        echo "FAIL: wanted exit $want and '$message', got exit $got" >&2
        exit 1
    fi
}

# In-box UCRT and ordinary Windows DLLs are allowed, including CRLF output.
printf 'chan.exe: file format coff-x86-64\r\n  DLL Name: KERNEL32.dll\r\n  DLL Name: api-ms-win-crt-runtime-l1-1-0.dll\r\n  DLL Name: ucrtbase.dll\r\n' > "$CRT_TEST_OUTPUT"
expect 0 'Windows CRT check: no VCRUNTIME or MSVCP DLL imports'

for dll in VCRUNTIME140.dll vcruntime140_1.dll VCRUNTIME140D.DLL MSVCP140.dll msvcp140_2.dll MsVcP140_ATOMIC_WAIT.DlL; do
    printf 'chan.exe: file format coff-x86-64\n  DLL Name: KERNEL32.dll\n  DLL Name: %s\n' "$dll" > "$CRT_TEST_OUTPUT"
    expect 1 'requires the Visual C++ Redistributable:'
    grep -Fq "$dll" "$CRT_TEST_DIR/result"
done

# No imports, unrecognized output, and tool errors must never pass silently.
printf 'chan.exe: file format coff-x86-64\n' > "$CRT_TEST_OUTPUT"
expect 1 'no DLL imports found'
printf 'chan: file format elf64-x86-64\n  DLL Name: KERNEL32.dll\n' > "$CRT_TEST_OUTPUT"
expect 1 'is not a Windows PE binary'
: > "$CRT_TEST_OUTPUT"
expect 1 'is not a Windows PE binary'
printf 'chan.exe: file format coff-x86-64\n  DLL Name: KERNEL32.dll\n' > "$CRT_TEST_OUTPUT"
export CRT_TEST_STATUS=1
expect 1 'cannot read Windows imports'
export LLVM_OBJDUMP="$CRT_TEST_DIR/missing-objdump"
expect 1 'cannot read Windows imports'

echo 'Windows CRT detector tests passed'
