#!/usr/bin/env python3
"""Fail when a repository-created sdme container can use overlay storage."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(
    os.environ.get("CHAN_SDME_CHECK_ROOT", Path(__file__).resolve().parents[1])
).resolve()
COMMAND = re.compile(
    r'(^|[;{(|&])\s*(?:sudo(?:\s+-\S+)*\s+)?'
    r'(?:sdme|\$SDME|"\$\{SDME_CMD\[@\]\}")\s+(?:new|create)\b'
)
EXPECTED_COMMAND_FILES = {
    "packaging/distros/arch/build-with-sdme.sh",
    "packaging/distros/copr/build-with-sdme.sh",
    "packaging/gateway/scripts/dev/sdme/build-gateway.sh",
    "packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/build-bins.sh",
    "packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/run.sh",
    "packaging/gateway/scripts/dev/sdme/devserver-tunnel-e2e/zone-isolation-probe.sh",
    "packaging/nix/build-with-sdme.sh",
    "packaging/sdme/build-chan-desktop.sh",
    "scripts/e2e/README.md",
    "scripts/windows-cross-check.sh",
}
BUILD_DRIVER_FILES = {
    "packaging/distros/arch/build-with-sdme.sh",
    "packaging/distros/copr/build-with-sdme.sh",
    "packaging/nix/build-with-sdme.sh",
    "packaging/sdme/build-chan-desktop.sh",
    "scripts/windows-cross-check.sh",
}
CAPPED_COMMAND_FILES = BUILD_DRIVER_FILES | {"scripts/e2e/README.md"}
DOCUMENTED_COMMANDS = {
    "packaging/sdme/chan-devserver.sdme": (
        "sudo sdme create --name chan-ds -r chan-devserver",
    ),
    "docs/contributing/linux-and-macos.md": (
        "sudo sdme create --name chan-build -r ubuntu",
        "sudo sdme create --name chan-devserver-dev -r ubuntu",
        "sudo sdme create --name chan-gw-build -r ubuntu",
    ),
    "scripts/e2e/README.md": (
        "sudo sdme create --name chan-one-cpu -r chan-ann-ubuntu",
    ),
}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "--", "packaging", "scripts"],
        check=True,
        capture_output=True,
    )
    return [ROOT / os.fsdecode(path) for path in result.stdout.split(b"\0") if path]


def logical_lines(source: str) -> list[tuple[int, str]]:
    lines: list[tuple[int, str]] = []
    current = ""
    start_line = 1
    for line_number, physical in enumerate(source.splitlines(), start=1):
        if not current:
            start_line = line_number
        stripped = physical.rstrip()
        if stripped.endswith("\\"):
            current += stripped[:-1] + " "
            continue
        lines.append((start_line, current + physical))
        current = ""
    if current:
        lines.append((start_line, current))
    return lines


def main() -> int:
    failures: list[str] = []
    seen: list[tuple[str, int]] = []
    for path in tracked_files():
        try:
            source = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        relative = path.relative_to(ROOT).as_posix()
        for line_number, line in logical_lines(source):
            if line.lstrip().startswith("#") or COMMAND.search(line) is None:
                continue
            seen.append((relative, line_number))
            if "--storage btrfs" not in line:
                failures.append(
                    f"{relative}:{line_number}: sdme container omits --storage btrfs"
                )
            if relative in CAPPED_COMMAND_FILES and "--disk" not in line:
                failures.append(
                    f"{relative}:{line_number}: chan build container omits --disk"
                )

    seen_files = {path for path, _ in seen}
    if seen_files != EXPECTED_COMMAND_FILES or len(seen) != len(EXPECTED_COMMAND_FILES):
        failures.append(
            "container-creating invocation inventory changed: "
            f"expected {sorted(EXPECTED_COMMAND_FILES)}, saw {seen}"
        )

    for relative, commands in DOCUMENTED_COMMANDS.items():
        lines = [
            line
            for _, line in logical_lines((ROOT / relative).read_text(encoding="utf-8"))
        ]
        for command in commands:
            documented_line = next((line for line in lines if command in line), "")
            if "--storage btrfs" not in documented_line:
                failures.append(
                    f"{relative}: documented create omits --storage btrfs: {command}"
                )

    if failures:
        for failure in failures:
            print(f"sdme-storage contract: FAIL: {failure}", file=sys.stderr)
        return 1

    print(
        "sdme-storage contract: PASS "
        f"({len(EXPECTED_COMMAND_FILES)} container-creating sites use btrfs; "
        f"{len(CAPPED_COMMAND_FILES)} build containers are capped; "
        f"{sum(map(len, DOCUMENTED_COMMANDS.values()))} documented examples use btrfs)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
