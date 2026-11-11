#!/usr/bin/env python3
"""Show check-desktop-entries.py passes the shared entries and refuses each break.

Each case copies the shared entries into a scratch directory, breaks one the
way a packaging mistake would, and expects the checker's exit status and the
finding it names. Needs desktop-file-validate, as the checker does.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts/check-desktop-entries.py"
SHARED = ROOT / "packaging/distros/shared"


def run(directory: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), str(directory)],
        capture_output=True,
        text=True,
        check=False,
    )


def broken(name: str, old: str, new: str):
    def apply(directory: Path) -> None:
        path = directory / name
        text = path.read_text(encoding="utf-8")
        if old not in text:
            raise SystemExit(f"fixture drift: {old!r} not in {name}")
        path.write_text(text.replace(old, new), encoding="utf-8")

    return apply


def removed(name: str):
    def apply(directory: Path) -> None:
        (directory / name).unlink()

    return apply


CASES = [
    (
        "no field code",
        broken("chan-files.desktop", "Exec=chan-files %U", "Exec=chan-files"),
        "chan-files.desktop: Exec has no field code",
    ),
    (
        "another binary",
        broken("chan-edit.desktop", "Exec=chan-edit %U", "Exec=chan-desktop %U"),
        "chan-edit.desktop: Exec must run chan-edit, got 'chan-desktop %U'",
    ),
    (
        "no directory type",
        broken("chan-files.desktop", "MimeType=inode/directory;", "MimeType=text/plain;"),
        "chan-files.desktop: MimeType lacks inode/directory",
    ),
    (
        "no MimeType key",
        broken("chan-edit.desktop", "MimeType=text/markdown;\n", ""),
        "chan-edit.desktop: MimeType lacks text/markdown",
    ),
    (
        "invalid for desktop-file-validate",
        broken("chan-edit.desktop", "Type=Application", "Type=Program"),
        "chan-edit.desktop: desktop-file-validate refused it",
    ),
    (
        "entry missing",
        removed("chan-files.desktop"),
        "chan-files.desktop: missing from",
    ),
]


def main() -> int:
    if shutil.which("desktop-file-validate") is None:
        print(
            "error: desktop-file-validate not found; install desktop-file-utils",
            file=sys.stderr,
        )
        return 2
    failures = []
    shared = run(SHARED)
    if shared.returncode != 0:
        failures.append(f"the shared entries: exit {shared.returncode}: {shared.stderr.strip()}")
    for label, apply, expected in CASES:
        with tempfile.TemporaryDirectory(prefix="chan-entries-test-") as scratch:
            directory = Path(scratch)
            for name in ("chan-files.desktop", "chan-edit.desktop"):
                shutil.copy(SHARED / name, directory / name)
            apply(directory)
            result = run(directory)
        if result.returncode != 1 or expected not in result.stderr:
            failures.append(
                f"{label}: expected exit 1 naming {expected!r}, got exit "
                f"{result.returncode}: {result.stderr.strip()!r}"
            )
    with tempfile.TemporaryDirectory(prefix="chan-entries-test-") as scratch:
        broken_image = Path(scratch) / "broken.AppImage"
        broken_image.write_text("#!/bin/sh\necho 'not an AppImage' >&2\nexit 1\n", encoding="utf-8")
        broken_image.chmod(0o755)
        for label, image, expected in (
            ("an AppImage that will not extract", broken_image, "--appimage-extract failed"),
            ("no AppImage", Path(scratch) / "absent.AppImage", "no AppImage at"),
        ):
            result = subprocess.run(
                [sys.executable, str(CHECKER), "--appimage", str(image)],
                capture_output=True,
                text=True,
                check=False,
            )
            if (
                result.returncode != 2
                or expected not in result.stderr
                or "Traceback" in result.stderr
            ):
                failures.append(
                    f"{label}: expected exit 2 naming {expected!r}, got exit "
                    f"{result.returncode}: {result.stderr.strip()!r}"
                )
    for failure in failures:
        print(f"FAIL {failure}", file=sys.stderr)
    if failures:
        return 1
    print(
        f"check-desktop-entries: shared entries pass, {len(CASES)} breaks refused, "
        "2 unreadable AppImages refused with exit 2"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
