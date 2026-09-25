#!/usr/bin/env python3
"""Check that the frontend's path classifier mirrors chan-workspace's.

chan-workspace classifies a path by extension (`classify_ext`) and then by
basename (`classify_basename`) in crates/chan-workspace/src/fs_ops.rs; the
server projects that class as the wire `kind`. The workspace app classifies a
bare path (a graph ghost, a link target) with the sets in
web/packages/workspace-app/src/state/fileTypes.ts, and every file-kind surface
(the graph canvas, its filter chips, the file browser) reads that one module.
Neither side can see the other, so a set widened on one side alone makes the
same file two kinds depending on where it is shown. This compiles the
frontend module, reads its SERVER_CLASSIFIER_MIRROR, and diffs each set
against the Rust match arms for the same function and FileClass.

Exits 0 when they match, 1 naming every difference when they do not.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FS_OPS = ROOT / "crates" / "chan-workspace" / "src" / "fs_ops.rs"
GENERATOR = ROOT / "web" / "packages" / "workspace-app" / "scripts" / "file-classes.mjs"

# Entries one side carries on purpose. Each names the side that lacks it; an
# entry that stops being a difference fails the check, so it is removed with
# the change that settles it rather than lingering.
FRONTEND_ONLY: dict[tuple[str, str, str], str] = {}

FN = re.compile(r"\bfn (classify_ext|classify_basename)\([^)]*\)[^{]*\{(?P<body>.*?)\n\}", re.DOTALL)
ARM = re.compile(r'(?P<pats>"[^"]*"(?:\s*\|\s*"[^"]*")*)\s*=>\s*(?:\{\s*)?FileClass::(?P<class>\w+)')


def rust_arms() -> dict[str, dict[str, set[str]]]:
    source = FS_OPS.read_text()
    found: dict[str, dict[str, set[str]]] = {}
    for fn in FN.finditer(source):
        classes: dict[str, set[str]] = {}
        for arm in ARM.finditer(fn.group("body")):
            names = set(re.findall(r'"([^"]*)"', arm.group("pats")))
            classes.setdefault(arm.group("class"), set()).update(names)
        found[fn.group(1)] = classes
    for name in ("classify_ext", "classify_basename"):
        if not found.get(name):
            sys.exit(f"could not read the match arms of {name} in {FS_OPS}")
    return found


def frontend_sets() -> dict[str, dict[str, set[str]]]:
    out = subprocess.run(["node", str(GENERATOR)], capture_output=True, text=True, cwd=ROOT)
    if out.returncode != 0:
        sys.exit(f"file-classes.mjs failed:\n{out.stderr}")
    return {
        fn: {cls: set(names) for cls, names in classes.items()}
        for fn, classes in json.loads(out.stdout).items()
    }


def main() -> int:
    rust = rust_arms()
    web = frontend_sets()
    problems: list[str] = []
    for fn in sorted(set(rust) | set(web)):
        for cls in sorted(set(rust.get(fn, {})) | set(web.get(fn, {}))):
            have = rust.get(fn, {}).get(cls)
            mirror = web.get(fn, {}).get(cls)
            if have is None:
                problems.append(f"{fn} FileClass::{cls}: the frontend mirrors a class Rust does not return")
                continue
            if mirror is None:
                problems.append(f"{fn} FileClass::{cls}: no frontend set mirrors it in SERVER_CLASSIFIER_MIRROR")
                continue
            for name in sorted(mirror - have):
                if (fn, cls, name) not in FRONTEND_ONLY:
                    problems.append(f"{fn} FileClass::{cls}: {name!r} is in the frontend set only")
            for name in sorted(have - mirror):
                problems.append(f"{fn} FileClass::{cls}: {name!r} is in fs_ops.rs only")
    for (fn, cls, name), why in sorted(FRONTEND_ONLY.items()):
        mirror = web.get(fn, {}).get(cls, set())
        have = rust.get(fn, {}).get(cls, set())
        if name not in mirror or name in have:
            problems.append(
                f"{fn} FileClass::{cls}: {name!r} is no longer frontend-only; "
                f"remove its FRONTEND_ONLY entry ({why})"
            )
    if not problems:
        return 0
    for problem in problems:
        print(problem)
    print()
    print("The frontend path classifier and chan-workspace's disagree. Widen both together:")
    print("  crates/chan-workspace/src/fs_ops.rs (classify_ext, classify_basename)")
    print("  web/packages/workspace-app/src/state/fileTypes.ts (SERVER_CLASSIFIER_MIRROR)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
