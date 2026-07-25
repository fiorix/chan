#!/usr/bin/env python3
"""Print the newest versioned Xcode application on a GitHub macOS runner."""

from __future__ import annotations

import re
import sys
from pathlib import Path


def version_key(path: Path) -> tuple[tuple[int, ...], str]:
    """Match GNU sort -V ordering closely enough for runner image names."""
    version = path.name.removeprefix("Xcode_").removesuffix(".app")
    numbers = tuple(int(part) for part in re.findall(r"\d+", version))
    return numbers, version


def main() -> int:
    applications = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/Applications")
    candidates = [
        path
        for path in applications.glob("Xcode_*.app")
        if version_key(path)[0]
    ]
    if not candidates:
        print(
            f"error: no versioned Xcode application under {applications}",
            file=sys.stderr,
        )
        return 1
    print(max(candidates, key=version_key))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
