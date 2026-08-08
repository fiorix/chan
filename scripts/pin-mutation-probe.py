#!/usr/bin/env python3
"""Prove the main.rs source pins fail under a definition reorder.

The pins in desktop/src-tauri/src/main.rs slice the file's own source
between line-start needles. A correct pin must go red when the two
definitions bounding its slice are reordered, because its end bound can
no longer be found after its start; a pin whose own invariant does not
involve the moved item must stay green. This probe applies each reorder
to the real file, runs the pinned tests through cargo, checks every
verdict against that expectation, and restores the file.

Run from anywhere inside the repo:

    scripts/pin-mutation-probe.py

Exits non-zero when any observed verdict differs from the expected one,
or when the tests are not green before mutation.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAIN_RS = ROOT / "desktop" / "src-tauri" / "src" / "main.rs"

PIN_TESTS = [
    "tests::control_script_clean_exit_reaps_and_failed_exit_keeps_terminal",
    "tests::gateway_signin_wait_rides_the_gateway_flow",
    "tests::synthesized_dispatch_runs_before_the_persisted_row_lookup",
]

# Each mutation moves one top-level item block (its contiguous ///+#[
# header lines included) to just above another item's block, and states
# the verdict every pinned test must then produce. A "green" entry is as
# load-bearing as a "red" one: it proves the pin discriminates a broken
# bound from an intact invariant instead of failing on any churn.
MUTATIONS = [
    (
        "inner-before-impl",
        "async fn connect_devserver_impl_inner(",
        "async fn connect_devserver_impl(",
        {
            # The slice [connect_devserver_impl -> inner] loses its end.
            PIN_TESTS[0]: "red",
            # The slice [rostered_conn -> inner] loses its end too: the
            # inner now precedes rostered_conn as well.
            PIN_TESTS[1]: "red",
            # The slice [inner -> list_devserver_workspaces] still binds,
            # and the ordering inside the moved body is untouched.
            PIN_TESTS[2]: "green",
        },
    ),
    (
        "workspaces-before-inner",
        "async fn list_devserver_workspaces(",
        "async fn connect_devserver_impl_inner(",
        {
            PIN_TESTS[0]: "green",
            PIN_TESTS[1]: "green",
            # The slice [inner -> list_devserver_workspaces] loses its end.
            PIN_TESTS[2]: "red",
        },
    ),
]


def block_range(lines: list[str], needle: str) -> tuple[int, int]:
    """The [start, end) line range of the item defined at `needle`,
    including its contiguous column-0 ///+#[ header lines above and its
    body through the column-0 closing brace."""
    defs = [i for i, line in enumerate(lines) if line.startswith(needle)]
    if len(defs) != 1:
        raise SystemExit(f"needle {needle!r} matches {len(defs)} lines, need 1")
    start = defs[0]
    while start > 0 and re.match(r"^(///|#\[)", lines[start - 1]):
        start -= 1
    end = defs[0]
    while end < len(lines) and lines[end] != "}":
        end += 1
    if end == len(lines):
        raise SystemExit(f"item at {needle!r} has no column-0 closing brace")
    return start, end + 1


def apply_mutation(text: str, move: str, before: str) -> str:
    lines = text.split("\n")
    m_start, m_end = block_range(lines, move)
    block = lines[m_start:m_end]
    rest = lines[:m_start] + lines[m_end:]
    t_start, _ = block_range(rest, before)
    return "\n".join(rest[:t_start] + block + [""] + rest[t_start:])


def run_pins() -> dict[str, str]:
    cmd = [
        "cargo",
        "test",
        "-p",
        "chan-desktop",
        "--bin",
        "chan-desktop",
        "--",
        "--exact",
        *PIN_TESTS,
    ]
    proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    verdicts: dict[str, str] = {}
    for test in PIN_TESTS:
        match = re.search(rf"^test {re.escape(test)} \.\.\. (\w+)", proc.stdout, re.M)
        if not match:
            print(proc.stdout[-2000:], file=sys.stderr)
            print(proc.stderr[-2000:], file=sys.stderr)
            raise SystemExit(f"no verdict for {test}; cargo test output above")
        verdicts[test] = "green" if match.group(1) == "ok" else "red"
    return verdicts


def check(label: str, expected: dict[str, str]) -> bool:
    verdicts = run_pins()
    ok = True
    for test, want in expected.items():
        got = verdicts[test]
        state = "ok" if got == want else "MISMATCH"
        if got != want:
            ok = False
        print(f"  [{label}] {test.removeprefix('tests::')}: {got} (want {want}) {state}")
    return ok


def main() -> int:
    original = MAIN_RS.read_text(encoding="utf-8")
    ok = True
    try:
        print("baseline (no mutation):")
        ok &= check("baseline", {t: "green" for t in PIN_TESTS})
        for name, move, before, expected in MUTATIONS:
            print(f"mutation {name}: move {move!r} above {before!r}")
            MAIN_RS.write_text(apply_mutation(original, move, before), encoding="utf-8")
            ok &= check(name, expected)
    finally:
        MAIN_RS.write_text(original, encoding="utf-8")
    if MAIN_RS.read_text(encoding="utf-8") != original:
        print("RESTORE FAILED: main.rs differs from the original", file=sys.stderr)
        return 2
    print("probe verdict:", "OK" if ok else "MISMATCH")
    return 0 if ok else 1


if __name__ == "__main__":
    return_code = main()
    sys.exit(return_code)
