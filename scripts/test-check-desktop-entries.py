#!/usr/bin/env python3
"""Show check-desktop-entries.py passes the shared entries and refuses each break.

Each case copies the shared entries into a scratch directory, breaks one the
way a packaging mistake would, and expects the checker's exit status and the
finding it names. The AppImage cases do the same to a tree laid out as the
AppImage extracts, read with `--appdir`. Needs desktop-file-validate, as the
checker does.
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


ENTRY_NAMES = ("chan-files.desktop", "chan-edit.desktop", "chan-term.desktop")
# The entry Tauri writes for the app, which the bundler links at the root.
ROOT_ENTRY = """[Desktop Entry]
Exec=chan-desktop
Icon=chan-desktop
Name=Chan
Terminal=false
Type=Application
"""


def run(*args: str | Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(CHECKER), *map(str, args)],
        capture_output=True,
        text=True,
        check=False,
    )


def appimage_tree(directory: Path) -> Path:
    """The parts of the AppImage the checker reads, laid out as it extracts:
    Chan's entry under usr/share/applications and linked at the root, the
    three entries under usr/share/chan/applications."""
    tree = directory / "squashfs-root"
    applications = tree / "usr/share/applications"
    carried = tree / "usr/share/chan/applications"
    for d in (applications, carried):
        d.mkdir(parents=True)
    (applications / "Chan.desktop").write_text(ROOT_ENTRY, encoding="utf-8")
    (tree / "Chan.desktop").symlink_to("usr/share/applications/Chan.desktop")
    for name in ENTRY_NAMES:
        shutil.copy(SHARED / name, carried / name)
    return tree


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


def desktop_as_a_terminal(directory: Path) -> None:
    """The app's own entry back as a terminal beside chan-term's."""
    text = (SHARED / "chan-desktop.desktop").read_text(encoding="utf-8")
    old = "Categories=Office;TextEditor;System;"
    if old not in text:
        raise SystemExit(f"fixture drift: {old!r} not in chan-desktop.desktop")
    text = text.replace(old, old + "TerminalEmulator;")
    (directory / "chan-desktop.desktop").write_text(text, encoding="utf-8")


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
    (
        "the terminal runs another binary",
        broken("chan-term.desktop", "Exec=chan-term", "Exec=chan-desktop"),
        "chan-term.desktop: Exec must run chan-term, got 'chan-desktop'",
    ),
    (
        "no terminal category",
        broken("chan-term.desktop", "Categories=System;TerminalEmulator;", "Categories=System;"),
        "chan-term.desktop: Categories lacks TerminalEmulator, so xdg-terminal-exec skips it",
    ),
    (
        "an option mapped onto another",
        broken("chan-term.desktop", "X-TerminalArgDir=--dir=", "X-TerminalArgDir=--directory="),
        "chan-term.desktop: X-TerminalArgDir must be '--dir=', got '--directory='",
    ),
    (
        "an option left unmapped",
        broken("chan-term.desktop", "X-TerminalArgHold=--hold\n", ""),
        "chan-term.desktop: X-TerminalArgHold must be '--hold', got None",
    ),
    (
        "another entry as a terminal",
        desktop_as_a_terminal,
        "chan-desktop.desktop: Categories has TerminalEmulator, which only chan-term.desktop "
        "may carry",
    ),
]


def linked_at_root(name: str):
    def apply(tree: Path) -> None:
        (tree / name).symlink_to(f"usr/share/chan/applications/{name}")

    return apply


def moved_to_applications(*names: str):
    def apply(tree: Path) -> None:
        for name in names:
            (tree / "usr/share/chan/applications" / name).rename(
                tree / "usr/share/applications" / name
            )

    return apply


def root_runs(binary: str):
    def apply(tree: Path) -> None:
        path = tree / "usr/share/applications/Chan.desktop"
        path.write_text(ROOT_ENTRY.replace("Exec=chan-desktop", f"Exec={binary}"), encoding="utf-8")

    return apply


def root_unlinked(tree: Path) -> None:
    (tree / "Chan.desktop").unlink()


def root_dangling(tree: Path) -> None:
    (tree / "usr/share/applications/Chan.desktop").unlink()


APPIMAGE_CASES = [
    (
        "a second desktop file in the root",
        linked_at_root("chan-edit.desktop"),
        "the AppImage root holds 2 desktop files (Chan.desktop, chan-edit.desktop)",
    ),
    (
        "no desktop file in the root",
        root_unlinked,
        "the AppImage root holds 0 desktop files (none)",
    ),
    (
        "a root link that leads to no file",
        root_dangling,
        "Chan.desktop in the AppImage root leads to no file",
    ),
    (
        "a root entry that runs another binary",
        root_runs("chan-edit %U"),
        "Chan.desktop in the AppImage root must run chan-desktop, got 'chan-edit %U'",
    ),
    (
        "an entry beside Chan's under usr/share/applications",
        moved_to_applications("chan-files.desktop"),
        "usr/share/applications holds Chan.desktop, chan-files.desktop; linuxdeploy links",
    ),
    (
        "every entry under usr/share/applications",
        moved_to_applications(*ENTRY_NAMES),
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
            for name in ENTRY_NAMES:
                shutil.copy(SHARED / name, directory / name)
            apply(directory)
            result = run(directory)
        if result.returncode != 1 or expected not in result.stderr:
            failures.append(
                f"{label}: expected exit 1 naming {expected!r}, got exit "
                f"{result.returncode}: {result.stderr.strip()!r}"
            )
    with tempfile.TemporaryDirectory(prefix="chan-entries-test-") as scratch:
        laid_out = run("--appdir", appimage_tree(Path(scratch)))
    if laid_out.returncode != 0:
        failures.append(
            f"the AppImage tree: exit {laid_out.returncode}: {laid_out.stderr.strip()}"
        )
    for label, apply, expected in APPIMAGE_CASES:
        with tempfile.TemporaryDirectory(prefix="chan-entries-test-") as scratch:
            tree = appimage_tree(Path(scratch))
            apply(tree)
            result = run("--appdir", tree)
        if result.returncode != 1 or expected not in result.stderr:
            failures.append(
                f"{label}: expected exit 1 naming {expected!r}, got exit "
                f"{result.returncode}: {result.stderr.strip()!r}"
            )
    with tempfile.TemporaryDirectory(prefix="chan-entries-test-") as scratch:
        broken_image = Path(scratch) / "broken.AppImage"
        broken_image.write_text("#!/bin/sh\necho 'not an AppImage' >&2\nexit 1\n", encoding="utf-8")
        broken_image.chmod(0o755)
        for label, mode, image, expected in (
            ("an AppImage that will not extract", "--appimage", broken_image,
             "--appimage-extract failed"),
            ("no AppImage", "--appimage", Path(scratch) / "absent.AppImage", "no AppImage at"),
            ("no extracted tree", "--appdir", Path(scratch) / "absent", "no directory at"),
        ):
            result = run(mode, image)
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
        f"check-desktop-entries: shared entries pass, {len(CASES)} breaks refused; "
        f"the AppImage tree passes, {len(APPIMAGE_CASES)} breaks refused; "
        "2 unreadable AppImages and a missing tree refused with exit 2"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
