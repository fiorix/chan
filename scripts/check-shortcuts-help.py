#!/usr/bin/env python3
"""Check that `chan serve --help` still matches the chord table in shortcuts.ts.

KEYBINDINGS_TABLE in crates/chan/src/lib.rs is generated from
web/packages/workspace-app/src/state/shortcuts.ts and pasted into the Rust
const by hand. Nothing else notices when a chord changes on the TS side, so
`chan serve --help` (and the skill that renders it) can go on advertising a
keybinding the app no longer has. This regenerates the table and diffs it
against the const.

Exits 0 when they match, 1 with a unified diff when they do not.
"""

import difflib
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LIB = ROOT / "crates" / "chan" / "src" / "lib.rs"
GENERATOR = ROOT / "web" / "packages" / "workspace-app" / "scripts" / "shortcuts-table.mjs"

# The const is a plain multi-line string literal whose body starts right after
# the opening quote, so it runs from there to the first unescaped closing quote.
CONST = re.compile(
    r'const KEYBINDINGS_TABLE: &str = "(?P<body>.*?)\n?";',
    re.DOTALL,
)


def embedded() -> str:
    match = CONST.search(LIB.read_text())
    if not match:
        sys.exit(f"could not find KEYBINDINGS_TABLE in {LIB}")
    # Undo the escaping a Rust string literal needs. The table itself is
    # plain ASCII, so these are the only sequences that appear.
    return match.group("body").replace('\\"', '"').replace("\\\\", "\\")


def rendered() -> str:
    out = subprocess.run(
        ["node", str(GENERATOR), "--serve-long-about"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    if out.returncode != 0:
        sys.exit(f"shortcuts-table.mjs failed:\n{out.stderr}")
    return out.stdout


def main() -> int:
    want = rendered().rstrip("\n")
    have = embedded().rstrip("\n")
    if want == have:
        return 0
    diff = difflib.unified_diff(
        have.splitlines(),
        want.splitlines(),
        fromfile="KEYBINDINGS_TABLE (crates/chan/src/lib.rs)",
        tofile="shortcuts-table.mjs --serve-long-about",
        lineterm="",
    )
    print("\n".join(diff))
    print()
    print("chan serve --help advertises stale keybindings. Refresh with:")
    print("  node web/packages/workspace-app/scripts/shortcuts-table.mjs \\")
    print("    --serve-long-about")
    print("and paste the output into KEYBINDINGS_TABLE in crates/chan/src/lib.rs.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
