#!/usr/bin/env python3
"""Check the desktop entries that make chan a file browser and a Markdown editor.

`chan-files.desktop` and `chan-edit.desktop` are what `xdg-open`, a file
manager's Open With and `xdg-mime default` see. Each must run its own name
of the chan binary with a field code, so the launcher hands it the paths, and
declare its MIME types; each must pass `desktop-file-validate`.

  check-desktop-entries.py [DIR]          the entries in DIR (default: the
                                          shared ones under packaging/)
  check-desktop-entries.py --appimage F   the entries inside the AppImage F

Exits 0 when every entry passes, 1 with one line per finding otherwise, and 2
when it cannot run (no desktop-file-validate, no AppImage, one that will not
extract).
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / "packaging/distros/shared"

# Each entry, the binary name its Exec runs and the MIME types it declares.
ENTRIES = {
    "chan-files.desktop": ("chan-files", {"inode/directory"}),
    "chan-edit.desktop": ("chan-edit", {"text/markdown"}),
}
FIELD_CODES = {"%U", "%u", "%F", "%f"}


def desktop_entry(path: Path) -> dict[str, str]:
    """The keys of the `[Desktop Entry]` group."""
    keys: dict[str, str] = {}
    group = None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            group = line[1:-1]
            continue
        if group == "Desktop Entry" and "=" in line:
            key, value = line.split("=", 1)
            keys[key.strip()] = value.strip()
    return keys


def findings(directory: Path, validate: str) -> list[str]:
    found = []
    for name, (binary, mime_types) in ENTRIES.items():
        path = directory / name
        if not path.is_file():
            found.append(f"{name}: missing from {directory}")
            continue
        keys = desktop_entry(path)
        exec_line = keys.get("Exec", "").split()
        if not exec_line or exec_line[0] != binary:
            found.append(f"{name}: Exec must run {binary}, got {keys.get('Exec')!r}")
        if not FIELD_CODES & set(exec_line[1:]):
            found.append(
                f"{name}: Exec has no field code ({' '.join(sorted(FIELD_CODES))}), so the "
                "launcher hands it no path"
            )
        declared = {t for t in keys.get("MimeType", "").split(";") if t}
        missing = mime_types - declared
        if missing:
            found.append(f"{name}: MimeType lacks {', '.join(sorted(missing))}")
        result = subprocess.run(
            [validate, str(path)], capture_output=True, text=True, check=False
        )
        if result.returncode != 0:
            detail = (result.stdout + result.stderr).strip().replace("\n", "; ")
            found.append(f"{name}: desktop-file-validate refused it: {detail}")
    return found


class CannotRun(Exception):
    """The check cannot run: the exit-2 case."""


def appimage_entries(appimage: Path, into: Path) -> Path:
    """Extract the AppImage's `usr/share/applications` into `into`."""
    if not appimage.is_file():
        raise CannotRun(f"no AppImage at {appimage}")
    try:
        subprocess.run(
            [str(appimage.resolve()), "--appimage-extract", "usr/share/applications/*"],
            cwd=into,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        detail = getattr(error, "stderr", b"") or b""
        detail = detail.decode(errors="replace").strip().replace("\n", "; ")
        raise CannotRun(
            f"{appimage} --appimage-extract failed: {error}" + (f": {detail}" if detail else "")
        ) from error
    return into / "squashfs-root/usr/share/applications"


def main(argv: list[str]) -> int:
    validate = shutil.which("desktop-file-validate")
    if validate is None:
        print(
            "error: desktop-file-validate not found; install desktop-file-utils",
            file=sys.stderr,
        )
        return 2
    with tempfile.TemporaryDirectory(prefix="chan-entries-") as scratch:
        if argv[:1] == ["--appimage"] and len(argv) == 2:
            try:
                directory = appimage_entries(Path(argv[1]), Path(scratch))
            except CannotRun as error:
                print(f"error: {error}", file=sys.stderr)
                return 2
            source = argv[1]
        elif len(argv) <= 1 and argv[:1] != ["--appimage"]:
            directory = Path(argv[0]) if argv else SHARED
            source = str(directory)
        else:
            print(__doc__, file=sys.stderr)
            return 2
        found = findings(directory, validate)
    for finding in found:
        print(f"error: {finding}", file=sys.stderr)
    if found:
        return 1
    print(f"desktop entries ok: {', '.join(ENTRIES)} in {source}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
