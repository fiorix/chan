#!/usr/bin/env python3
"""Contract test for the AUR check() contract in check-build-matrix.py.

Each case writes a throwaway recipe whose check() holds one shape, most of
them beside the pinned `cargo test -p <pkgname>` call, and runs it through the
checker's `aur-recipe` entry point, which applies the rule build-matrix-check
applies to the real recipes. A refusal has to name the line the shape starts
on; a shape that selects nothing beyond the package has to pass. Nothing here
reads or writes the real recipes except the last case, which only reads them.

Python rather than shell like the Nix hash contract test beside it, because
build-matrix-check also runs on the Windows runner, where a native interpreter
would be handed MSYS paths.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path


CHECKER = Path(__file__).resolve().with_name("check-build-matrix.py")
ROOT = CHECKER.parents[1]
REAL_RECIPES = (
    "packaging/distros/arch/aur/chan/PKGBUILD.in",
    "packaging/distros/arch/aur/chan-desktop/PKGBUILD.in",
)
FIXTURE = "PKGBUILD.in"
# check() opens on line 3 and its body starts after two fixed lines, so the
# first body line is 6 and a shape written beside the pinned call is on 7.
REPLACED = 6
BESIDE = 7
# A refusal that names the recipe but no line, such as a check() with no
# cargo call left in it.
NO_LINE = 0


@dataclass(frozen=True)
class Case:
    name: str
    body: tuple[str, ...]
    # The line a refusal must name, NO_LINE for the file alone, or None when
    # the recipe must pass.
    line: int | None
    pkgname: str = "chan"
    # Text the refusal must also contain.
    says: str = ""


def pinned(pkgname: str = "chan") -> str:
    return f"    cargo test --frozen --release -p {pkgname}"


def beside(name: str, *shape: str, says: str = "") -> Case:
    return Case(name, (pinned(), *shape), BESIDE, says=says)


def replaced(name: str, shape: str, pkgname: str = "chan", says: str = "") -> Case:
    return Case(name, (shape,), REPLACED, pkgname, says)


def passes(name: str, *body: str, pkgname: str = "chan") -> Case:
    return Case(name, body, None, pkgname)


CASES = (
    passes("the pinned call alone", pinned()),
    passes("the pinned desktop call alone", pinned("chan-desktop"), pkgname="chan-desktop"),
    # Words after `--` go to the test binaries, not to cargo.
    passes("test-binary arguments after --", pinned() + " -- --workspace"),
    passes("a whole-line comment", pinned(), "    # cargo test --frozen --release --workspace"),
    passes("a trailing comment", pinned() + " # --workspace"),
    passes("a quoted mention of cargo is not a call", pinned(), '    echo "cargo test --workspace"'),
    passes("a subcommand that builds nothing", "    cargo fetch --locked", pinned()),
    # Round one's red copies: the pinned call widened in place.
    replaced("--workspace", "    cargo test --frozen --release --workspace", says="--workspace"),
    replaced(
        "--workspace in the desktop recipe",
        "    cargo test --frozen --release --workspace",
        pkgname="chan-desktop",
        says="--workspace",
    ),
    replaced("--all", "    cargo test --frozen --release --all", says="--all"),
    replaced(
        "a second -p",
        "    cargo test --frozen --release -p chan -p chan-server",
        says="chan-server",
    ),
    replaced(
        "no -p",
        "    cargo test --frozen --release",
        pkgname="chan-desktop",
        says="no `-p`",
    ),
    replaced("--package=", "    cargo test --frozen --release --package=chan-server"),
    replaced("-pX", "    cargo test --frozen --release -pchan-server"),
    replaced("--manifest-path", "    cargo test --manifest-path crates/chan-server/Cargo.toml"),
    replaced("make", "    make test"),
    replaced("a program named by a variable", '    "$CARGO" test --frozen --release -p chan'),
    Case("no cargo call left", ("    true",), NO_LINE, says="runs no cargo"),
    beside("a chained call", "    true && cargo test --frozen --release --workspace"),
    beside("a subshell", "    (cargo test --frozen --release --workspace)"),
    beside("a command substitution", "    x=$(cargo test --frozen --release --workspace)"),
    beside("behind command", "    command cargo test --frozen --release --workspace"),
    # A widened call beside the pinned one, hidden behind a word the
    # contract does not read: each passed the contract as round one wrote it.
    beside("behind timeout", "    timeout 60m cargo test --frozen --release --workspace"),
    beside("behind env with an assignment", "    env RUSTFLAGS=x cargo test --frozen --release --workspace"),
    beside("behind time -p", "    time -p cargo test --frozen --release --workspace"),
    beside("behind nice -n", "    nice -n 10 cargo test --frozen --release --workspace"),
    beside("behind sudo -u", "    sudo -u builder cargo test --frozen --release --workspace"),
    beside("behind !", "    ! cargo test --frozen --release --workspace"),
    beside("in a brace group", "    { cargo test --frozen --release --workspace; }"),
    beside("in a one-line if", "    if true; then cargo test --frozen --release --workspace; fi"),
    beside(
        "in a one-line for",
        '    for p in chan chan-server; do cargo test --frozen --release -p "$p"; done',
    ),
    beside("in backticks", "    : `cargo test --frozen --release --workspace`"),
    # bash starts a comment only at the beginning of a word.
    beside("a # inside a word", "    cargo test --frozen --release -p chan#x --workspace"),
    # An escaped space is part of the word, so the `#` after it is too and
    # the `;` still ends the command.
    beside(
        "an escaped space before #",
        "    cargo test --frozen --release -p chan -- x\\ #; cargo test --frozen --release --workspace",
    ),
    # A backslash inside a comment continues nothing, so the next line is a
    # command of its own.
    Case(
        "a backslash at the end of a comment",
        (pinned() + " # the next line is not this one's \\", "    cargo test --frozen --release --workspace"),
        BESIDE,
    ),
    # bash removes a backslash-newline outright, so a flag split across two
    # lines is one word.
    beside(
        "a flag split by a continuation",
        "    cargo test --frozen --release -p chan --work\\",
        "space",
    ),
)


def recipe(case: Case) -> str:
    lines = (
        f"pkgname={case.pkgname}",
        "",
        "check() {",
        '    cd "chan-$pkgver"',
        "    export CARGO_TARGET_DIR=target",
        *case.body,
        "}",
        "",
        "package() {",
        f'    install -Dm755 target/release/{case.pkgname} "$pkgdir/usr/bin/{case.pkgname}"',
        "}",
    )
    return "\n".join(lines) + "\n"


def run(directory: Path, *recipes: str) -> tuple[int, str]:
    result = subprocess.run(
        [sys.executable, str(CHECKER), "aur-recipe", *recipes],
        cwd=directory,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode, result.stdout + result.stderr


def problem(case: Case, status: int, output: str) -> str | None:
    """Why OUTPUT is not the verdict CASE expects, or None when it is."""
    if case.line is None:
        if status == 0 and "build-matrix contract: PASS" in output:
            return None
        return f"expected a pass, got status {status}"
    where = FIXTURE if case.line == NO_LINE else f"{FIXTURE}:{case.line}"
    refusals = [
        line
        for line in output.splitlines()
        if line.startswith(f"build-matrix contract: FAIL: {where}: ")
    ]
    if status != 1 or not refusals:
        return f"expected a refusal naming {where}, got status {status}"
    if case.says and not any(case.says in line for line in refusals):
        return f"the refusal does not say {case.says!r}"
    return None


def main() -> int:
    failures = 0
    with tempfile.TemporaryDirectory(prefix="chan-aur-contract.") as scratch:
        directory = Path(scratch)
        for case in CASES:
            (directory / FIXTURE).write_text(recipe(case), encoding="utf-8")
            status, output = run(directory, FIXTURE)
            reason = problem(case, status, output)
            if reason is None:
                print(f"ok - {case.name}")
            else:
                failures += 1
                print(f"not ok - {case.name}: {reason}\n{output.rstrip()}", file=sys.stderr)
    status, output = run(ROOT, *REAL_RECIPES)
    if status == 0 and "build-matrix contract: PASS" in output:
        print("ok - the real recipes")
    else:
        failures += 1
        print(f"not ok - the real recipes: status {status}\n{output.rstrip()}", file=sys.stderr)
    total = len(CASES) + 1
    if failures:
        print(f"AUR check() contract test: {failures} of {total} cases failed", file=sys.stderr)
        return 1
    print(f"AUR check() contract test: all {total} cases passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
