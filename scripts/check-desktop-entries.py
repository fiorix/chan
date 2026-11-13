#!/usr/bin/env python3
"""Check the desktop entries that make chan a file browser, a Markdown editor
and a terminal.

`chan-files.desktop` and `chan-edit.desktop` are what `xdg-open`, a file
manager's Open With and `xdg-mime default` see. Each must run its own name
of the chan binary with a field code, so the launcher hands it the paths, and
declare its MIME types. `chan-term.desktop` is what xdg-terminal-exec runs:
it must run `chan-term`, carry the `TerminalEmulator` category and map each
of xdg-terminal-exec's options onto chan-term's through its `X-TerminalArg*`
keys, and no other entry beside it may carry that category, since
xdg-terminal-exec would run it with chan-term's options. Each must pass
`desktop-file-validate`.

  check-desktop-entries.py [DIR]          the entries in DIR (default: the
                                          shared ones under packaging/)
  check-desktop-entries.py --appimage F   the AppImage F: its root's desktop
                                          file and the entries it carries
  check-desktop-entries.py --appdir D     the same for D, an AppImage's
                                          extracted tree

The AppImage's AppRun runs the Exec of the first desktop file it reads in the
image's root, in directory order, and linuxdeploy links into that root the
first desktop file it lists under `usr/share/applications`. So each of the
two holds Chan's entry alone, whatever order a filesystem lists them in, and
the AppImage carries the three entries under `usr/share/chan/applications`.

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

# Each entry, the binary name its Exec runs and the MIME types it declares;
# an entry with none is the terminal, which takes no path.
ENTRIES = {
    "chan-files.desktop": ("chan-files", {"inode/directory"}),
    "chan-edit.desktop": ("chan-edit", {"text/markdown"}),
    "chan-term.desktop": ("chan-term", set()),
}
FIELD_CODES = {"%U", "%u", "%F", "%f"}
TERMINAL_CATEGORY = "TerminalEmulator"
# xdg-terminal-exec's options and the chan-term option each maps onto; a key
# ending in `=` appends the value to the same argument.
TERMINAL_KEYS = {
    "X-TerminalArgExec": "-e",
    "X-TerminalArgDir": "--dir=",
    "X-TerminalArgAppId": "--app-id=",
    "X-TerminalArgTitle": "--title=",
    "X-TerminalArgHold": "--hold",
}
# The binary the AppImage's root entry runs, and where the image carries the
# three entries: away from `usr/share/applications`, which linuxdeploy reads.
MAIN_BINARY = "chan-desktop"
APPIMAGE_ENTRIES = "usr/share/chan/applications"


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


def categories(keys: dict[str, str]) -> set[str]:
    return {c for c in keys.get("Categories", "").split(";") if c}


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
        if mime_types and not FIELD_CODES & set(exec_line[1:]):
            found.append(
                f"{name}: Exec has no field code ({' '.join(sorted(FIELD_CODES))}), so the "
                "launcher hands it no path"
            )
        declared = {t for t in keys.get("MimeType", "").split(";") if t}
        missing = mime_types - declared
        if missing:
            found.append(f"{name}: MimeType lacks {', '.join(sorted(missing))}")
        if not mime_types:
            if TERMINAL_CATEGORY not in categories(keys):
                found.append(
                    f"{name}: Categories lacks {TERMINAL_CATEGORY}, so xdg-terminal-exec skips it"
                )
            for key, value in TERMINAL_KEYS.items():
                if keys.get(key) != value:
                    found.append(f"{name}: {key} must be {value!r}, got {keys.get(key)!r}")
        result = subprocess.run(
            [validate, str(path)], capture_output=True, text=True, check=False
        )
        if result.returncode != 0:
            detail = (result.stdout + result.stderr).strip().replace("\n", "; ")
            found.append(f"{name}: desktop-file-validate refused it: {detail}")
    return found + other_terminals(directory)


def other_terminals(directory: Path) -> list[str]:
    """Entries beside the terminal's that claim its category: xdg-terminal-exec
    would run one with chan-term's options."""
    terminals = {name for name, (_, mime_types) in ENTRIES.items() if not mime_types}
    return [
        f"{name}: Categories has {TERMINAL_CATEGORY}, which only {', '.join(sorted(terminals))} "
        "may carry: xdg-terminal-exec would run it with chan-term's options"
        for name in desktop_files(directory)
        if name not in terminals
        and (directory / name).is_file()
        and TERMINAL_CATEGORY in categories(desktop_entry(directory / name))
    ]


def desktop_files(directory: Path) -> list[str]:
    """The names in `directory` AppRun's filter takes: those ending `.desktop`."""
    if not directory.is_dir():
        return []
    return sorted(path.name for path in directory.iterdir() if path.name.endswith(".desktop"))


def appdir_findings(tree: Path, validate: str) -> list[str]:
    found = []
    root = desktop_files(tree)
    if len(root) != 1:
        found.append(
            f"the AppImage root holds {len(root)} desktop files ({', '.join(root) or 'none'}); "
            f"AppRun runs the Exec of the first it reads, so the root holds one, running {MAIN_BINARY}"
        )
    elif not (tree / root[0]).is_file():
        found.append(f"{root[0]} in the AppImage root leads to no file")
    else:
        exec_line = desktop_entry(tree / root[0]).get("Exec", "")
        if exec_line.split()[:1] != [MAIN_BINARY]:
            found.append(
                f"{root[0]} in the AppImage root must run {MAIN_BINARY}, got {exec_line!r}"
            )
    listed = desktop_files(tree / "usr/share/applications")
    if len(listed) > 1:
        found.append(
            f"usr/share/applications holds {', '.join(listed)}; linuxdeploy links the first it "
            "lists into the AppImage root, so it holds the root's entry alone"
        )
    return found + findings(tree / APPIMAGE_ENTRIES, validate)


class CannotRun(Exception):
    """The check cannot run: the exit-2 case."""


def appimage_tree(appimage: Path, into: Path) -> Path:
    """Extract the parts of the AppImage the check reads into `into`: the
    root's desktop files, `usr/share/applications` and the carried entries."""
    if not appimage.is_file():
        raise CannotRun(f"no AppImage at {appimage}")
    for pattern in ("*.desktop", "usr/share/applications/*", f"{APPIMAGE_ENTRIES}/*"):
        try:
            subprocess.run(
                [str(appimage.resolve()), "--appimage-extract", pattern],
                cwd=into,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            detail = getattr(error, "stderr", b"") or b""
            detail = detail.decode(errors="replace").strip().replace("\n", "; ")
            raise CannotRun(
                f"{appimage} --appimage-extract failed: {error}"
                + (f": {detail}" if detail else "")
            ) from error
    return into / "squashfs-root"


def main(argv: list[str]) -> int:
    validate = shutil.which("desktop-file-validate")
    if validate is None:
        print(
            "error: desktop-file-validate not found; install desktop-file-utils",
            file=sys.stderr,
        )
        return 2
    modes = (["--appimage"], ["--appdir"])
    with tempfile.TemporaryDirectory(prefix="chan-entries-") as scratch:
        if argv[:1] in modes and len(argv) == 2:
            try:
                if argv[0] == "--appimage":
                    tree = appimage_tree(Path(argv[1]), Path(scratch))
                elif Path(argv[1]).is_dir():
                    tree = Path(argv[1])
                else:
                    raise CannotRun(f"no directory at {argv[1]}")
            except CannotRun as error:
                print(f"error: {error}", file=sys.stderr)
                return 2
            found = appdir_findings(tree, validate)
            passed = (
                f"{', '.join(ENTRIES)} under {APPIMAGE_ENTRIES} and one desktop file in the root "
                f"of {argv[1]}"
            )
        elif len(argv) <= 1 and argv[:1] not in modes:
            directory = Path(argv[0]) if argv else SHARED
            found = findings(directory, validate)
            passed = f"{', '.join(ENTRIES)} in {directory}"
        else:
            print(__doc__, file=sys.stderr)
            return 2
    for finding in found:
        print(f"error: {finding}", file=sys.stderr)
    if found:
        return 1
    print(f"desktop entries ok: {passed}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
