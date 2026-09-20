#!/usr/bin/env python3
"""Syntax-check the JavaScript no cargo or npm target reaches.

`scripts/e2e` is a harness whose only product is a verdict, and `desktop/src`
ships in every desktop release; a syntax error in either surfaces as a broken
run rather than a failed gate. `node --check` is the same check
`web-marketing-check` already runs over the marketing scripts.

A set that matches nothing is an error: a check that silently covers zero
files gates nothing.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

# Each entry is a directory, a glob, and the reason the directory is gated,
# so a failure names what the file is for rather than only where it sits.
SOURCES = (
    ("scripts/e2e", "**/*.mjs", "browser-smoke and e2e harness"),
    ("desktop/src", "*.js", "desktop shell, shipped in every release"),
)


def node() -> str:
    return "node.exe" if sys.platform == "win32" else "node"


def collect() -> list[tuple[Path, str]]:
    found: list[tuple[Path, str]] = []
    for relative, pattern, what in SOURCES:
        directory = ROOT / relative
        if not directory.is_dir():
            raise SystemExit(f"error: {relative} is missing; the tree moved")
        matched = sorted(p for p in directory.glob(pattern) if p.is_file())
        if not matched:
            raise SystemExit(
                f"error: {relative}/{pattern} matched no files; "
                "the tree moved or the pattern is wrong"
            )
        found.extend((path, what) for path in matched)
    return found


def require_node() -> str:
    """Resolve node, or fail. A check that skips when its tool is missing
    gates nothing, which is the rule `scripts/lint-static.sh` already keeps."""
    exe = node()
    try:
        subprocess.run([exe, "--version"], capture_output=True, check=True)
    except (OSError, subprocess.CalledProcessError) as err:
        raise SystemExit(f"error: {exe} is required by e2e-check: {err}")
    return exe


def main() -> int:
    exe = require_node()
    files = collect()
    failures = 0
    for path, what in files:
        result = subprocess.run(
            [exe, "--check", str(path)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            failures += 1
            rel = path.relative_to(ROOT)
            print(f"{rel}: {what}", file=sys.stderr)
            sys.stderr.write(result.stderr)
    if failures:
        print(
            f"error: node --check failed for {failures} of {len(files)} files",
            file=sys.stderr,
        )
        return 1
    print(f"check-e2e-syntax: {len(files)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
