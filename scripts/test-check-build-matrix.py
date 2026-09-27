#!/usr/bin/env python3
"""Contract test for AUR package selection and saved-binary ownership.

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
# check() opens on line 3 and its commands follow cd and three exports.
REPLACED = 8
BESIDE = 9
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
    # A single edit to the otherwise valid recipe, for artifact ownership.
    edit: tuple[str, str] | None = None
    at: str = ""


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
    # makepkg defines pkgname in the recipe, so an expansion of it selects
    # the installed package however it is quoted.
    passes('-p "$pkgname"', '    cargo test --frozen --release -p "$pkgname"'),
    passes("-p ${pkgname}", "    cargo test --frozen --release -p ${pkgname}"),
    passes(
        '--package="$pkgname" in the desktop recipe',
        '    cargo test --frozen --release --package="$pkgname"',
        pkgname="chan-desktop",
    ),
    # Any other expansion could hold any selection, and the refusal names it.
    replaced(
        "a package named by another variable",
        '    cargo test --frozen --release -p "$p"',
        says="'$p' is a shell expansion",
    ),
    beside(
        "a variable beside the pinned selection",
        "    cargo test --frozen --release -p chan $EXTRA",
        says="'$EXTRA' is a shell expansion",
    ),
    beside(
        "a substitution inside a cargo call",
        "    cargo test --frozen --release -p chan `echo --workspace`",
        says="is a shell expansion",
    ),
    # A feature flag is how a test-only feature would reach the relinked
    # binary without widening the selection, so check() selects none.
    replaced(
        "--features",
        "    cargo test --frozen --release -p chan --features chan-workspace/test-hooks",
        says="--features",
    ),
    replaced(
        "--features=",
        "    cargo test --frozen --release -p chan --features=chan-workspace/test-hooks",
        says="--features",
    ),
    replaced("-F", "    cargo test --frozen --release -p chan -F chan-workspace/test-hooks", says="-F"),
    replaced("-FX", "    cargo test --frozen --release -p chan -Fchan-workspace/test-hooks", says="-F"),
    replaced("--all-features", "    cargo test --frozen --release -p chan --all-features", says="--all-features"),
    # cargo reads clustered short flags, so `-rp` is `--release -p`.
    replaced(
        "-p inside a short-flag cluster",
        "    cargo test --frozen -p chan -rp chan-server",
        says="chan-server",
    ),
    replaced(
        "-F inside a short-flag cluster",
        "    cargo test --frozen -p chan -rF chan-workspace/test-hooks",
        says="-F",
    ),
    # The pinned call widened in place.
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
    # contract does not read.
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


def artifact(name: str, before: str, after: str, *, at: str = "", says: str) -> Case:
    return Case(name, (pinned(),), NO_LINE, says=says, edit=(before, after), at=at)


BUILD = "    cargo build --frozen --release -p chan"
COPY = "    install -Dm755 target/release/chan package-bin/chan"
INSTALL = '    install -Dm755 package-bin/chan "$pkgdir/usr/bin/chan"'
ARTIFACT_CASES = (
    artifact("installing the test build", INSTALL, INSTALL.replace("package-bin", "target/release"),
             at="install -Dm755 target/release/chan", says="must install the saved binary"),
    artifact("copy before the build", BUILD + "\n" + COPY, COPY + "\n" + BUILD,
             at=COPY, says="after the last cargo build"),
    artifact("a second build after the copy", COPY, COPY + "\n" + BUILD,
             at=COPY, says="after the last cargo build"),
    artifact("no saved copy", COPY + "\n", "", says="must save its release binary"),
    artifact("no binary install", INSTALL + "\n", "", says="must install the saved binary"),
    artifact("check overwrites the copy", pinned(), pinned() + "\n" + COPY,
             at=COPY, says="cannot prove this command preserves"),
    artifact("package overwrites the copy", INSTALL, COPY + "\n" + INSTALL,
             at=COPY, says="must install the saved binary"),
    artifact("copy to an unreadable variable", COPY, COPY.replace("package-bin/chan", '"$saved"'),
             at='install -Dm755 target/release/chan "$saved"', says="cannot prove this command preserves"),
    artifact("install from an unreadable variable", INSTALL, INSTALL.replace("package-bin/chan", '"$saved"'),
             at='install -Dm755 "$saved"', says="must install the saved binary"),
    artifact("check writes through a redirect", pinned(), pinned() + "\n    echo broken > package-bin/chan",
             at="echo broken", says="without shell control operators or redirections"),
    artifact("package writes through a redirect", INSTALL, INSTALL + "\n    echo broken >> package-bin/chan",
             at="echo broken", says="without shell control operators or redirections"),
    artifact("conditional copy after a failed build", BUILD + "\n" + COPY, BUILD + " || " + COPY.strip(),
             at=BUILD, says="without shell control operators or redirections"),
    artifact("check replaces the target directory", pinned(), "    CARGO_TARGET_DIR=package-bin " + pinned().strip(),
             at="CARGO_TARGET_DIR=package-bin cargo", says="cannot prove this command preserves"),
    artifact("cargo writes in the saved directory", pinned(), pinned() + " --target-dir package-bin",
             at=pinned(), says="cannot prove this command preserves"),
    artifact("cargo vendor writes the saved directory", pinned(), pinned() + "\n    cargo vendor package-bin",
             at="cargo vendor", says="cannot prove this command preserves"),
    artifact("check invokes an unreadable writer", pinned(), pinned() + "\n    python3 overwrite.py",
             at="python3 overwrite.py", says="cannot prove this command preserves"),
    artifact("package escapes its destination", INSTALL,
             INSTALL + '\n    install -Dm644 LICENSE "$pkgdir/../src/chan-$pkgver/package-bin/chan"',
             at="install -Dm644", says="cannot prove this command preserves"),
    artifact("copy without a build", BUILD + "\n", "",
             at=COPY, says="after the last cargo build"),
    artifact("two saved copies", COPY, COPY + "\n" + COPY + " # second copy",
             at=COPY + " # second copy", says="writes the saved binary twice"),
    artifact("two binary installs", INSTALL, INSTALL + "\n" + INSTALL + " # second install",
             at=INSTALL + " # second install", says="installs its binary twice"),
    artifact("build in another source directory", 'build() {\n    cd "chan-$pkgver"',
             'build() {\n    cd elsewhere', says="build() must start in chan-$pkgver"),
    artifact("build without its pinned target", 'build() {\n    cd "chan-$pkgver"\n    export RUSTUP_TOOLCHAIN=stable\n    export CARGO_TARGET_DIR=target',
             'build() {\n    cd "chan-$pkgver"\n    export RUSTUP_TOOLCHAIN=stable',
             says="build() must export"),
    artifact("a second build function", "build() {", "build() {\n}\nbuild() {",
             says="expected one `build() {` line"),
)


def recipe(case: Case) -> str:
    lines = (
        f"pkgname={case.pkgname}",
        "",
        "check() {",
        '    cd "chan-$pkgver"',
        "    export RUSTUP_TOOLCHAIN=stable",
        "    export CARGO_TARGET_DIR=target",
        "    export CHAN_PACKAGED=aur",
        *case.body,
        "}",
        "",
        "package() {",
        '    cd "chan-$pkgver"',
        f'    install -Dm755 package-bin/{case.pkgname} "$pkgdir/usr/bin/{case.pkgname}"',
        "}",
        "",
        "build() {",
        '    cd "chan-$pkgver"',
        "    export RUSTUP_TOOLCHAIN=stable",
        "    export CARGO_TARGET_DIR=target",
        "    export CHAN_PACKAGED=aur",
        f"    cargo build --frozen --release -p {case.pkgname}",
        f"    install -Dm755 target/release/{case.pkgname} package-bin/{case.pkgname}",
        "}",
    )
    text = "\n".join(lines) + "\n"
    if case.edit is not None:
        before, after = case.edit
        assert text.count(before) == 1, (case.name, before)
        text = text.replace(before, after)
    return text


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
    line = case.line
    if case.at:
        line = next(i for i, text in enumerate(recipe(case).splitlines(), 1) if case.at in text)
    where = FIXTURE if line == NO_LINE else f"{FIXTURE}:{line}"
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
        for case in (*CASES, *ARTIFACT_CASES):
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
    total = len(CASES) + len(ARTIFACT_CASES) + 1
    if failures:
        print(f"AUR check() contract test: {failures} of {total} cases failed", file=sys.stderr)
        return 1
    print(f"AUR check() contract test: all {total} cases passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
