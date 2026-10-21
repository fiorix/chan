#!/usr/bin/env python3
"""Exercise the desktop recipe with Tauri's version grammar and Linux bundle names."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAKEFILE = ROOT / "desktop/Makefile"
STAGER = ROOT / "scripts/stage-candidate-linux-desktop-packages.sh"
VERSION = "0.109.0-rc0"

CARGO = """#!/usr/bin/env bash
set -euo pipefail
[ "${1:-}" = tauri ] || { echo 'expected cargo tauri' >&2; exit 2; }
shift
exec cargo-tauri "$@"
"""

TAURI = r"""#!/usr/bin/env python3
import json
import os
import re
import sys
from pathlib import Path

args = sys.argv[1:]
if not args or args[0] not in ("build", "bundle"):
    sys.exit("expected tauri build or bundle")
config = json.loads(Path("tauri.conf.json").read_text())
if "--config" in args:
    index = args.index("--config")
    try:
        override = json.loads(args[index + 1])
    except (IndexError, ValueError):
        sys.exit("invalid --config JSON")
    config.update(override)
version = config["version"]
if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", version):
    sys.exit("`tauri.conf.json > version` must be a semver string")
if "--bundles" in args:
    index = args.index("--bundles")
    try:
        bundles = args[index + 1].split(",")
    except IndexError:
        sys.exit("missing --bundles value")
    if not bundles or any(bundle not in ("deb", "rpm", "appimage") for bundle in bundles):
        sys.exit("invalid --bundles value")
elif args[0] == "build" and "-" in version and os.environ.get("TEST_UNAME") == "Linux":
    sys.exit(f'invalid version "{version}": contains invalid character')
with Path(os.environ["TAURI_RECORD"]).open("a") as record:
    record.write(json.dumps(args) + "\n")
"""

UNAME = """#!/usr/bin/env bash
[ "${1:-}" = -s ] || { echo 'expected uname -s' >&2; exit 2; }
printf '%s\\n' "${TEST_UNAME:-Linux}"
"""


def executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def fixture(root: Path, makefile: str, version: str) -> tuple[Path, Path]:
    desktop = root / "desktop"
    config = desktop / "src-tauri/tauri.conf.json"
    bin_dir = root / "bin"
    config.parent.mkdir(parents=True)
    bin_dir.mkdir()
    (desktop / "Makefile").write_text(makefile)
    (root / "Makefile").write_text("web:\n\t@:\n")
    config.write_text(json.dumps({"version": version}))
    executable(bin_dir / "cargo", CARGO)
    executable(bin_dir / "cargo-tauri", TAURI)
    executable(bin_dir / "uname", UNAME)
    return desktop, bin_dir


def expected_dashed() -> list[list[str]]:
    return [
        ["build", "--bundles", "deb,appimage"],
        [
            "bundle",
            "--bundles",
            "rpm",
            "--config",
            '{"version":"0.109.0","bundle":{"linux":{"rpm":{"release":"0~rc0"}}}}',
        ],
    ]


def check_recipe(makefile: str, version: str, system: str, expected: list[list[str]]) -> None:
    with tempfile.TemporaryDirectory(prefix="chan-desktop-bundle-") as temporary:
        root = Path(temporary)
        desktop, bin_dir = fixture(root, makefile, version)
        record = root / "calls.jsonl"
        env = os.environ.copy()
        env.update(
            PATH=f"{bin_dir}{os.pathsep}{env['PATH']}",
            TAURI_RECORD=str(record),
            TEST_UNAME=system,
        )
        result = subprocess.run(
            ["make", "-C", str(desktop), "build"],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode:
            raise AssertionError(f"make build failed for {system} {version}: {result.stdout}{result.stderr}")
        calls = [json.loads(line) for line in record.read_text().splitlines()] if record.exists() else []
        if calls != expected:
            raise AssertionError(f"{system} {version}: expected {expected!r}, got {calls!r}")


def check_stager() -> None:
    with tempfile.TemporaryDirectory(prefix="chan-desktop-stage-") as temporary:
        root = Path(temporary)
        bundle = root / "bundle"
        for format_name in ("rpm", "deb"):
            (bundle / format_name).mkdir(parents=True)
        deb = bundle / "deb/Chan_0.109.0-rc0_amd64.deb"
        rpm = bundle / "rpm/Chan-0.109.0-0~rc0.x86_64.rpm"
        deb.write_text("deb")

        def run(name: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [str(STAGER), str(bundle), str(root / name)],
                capture_output=True,
                text=True,
                check=False,
            )

        missing = run("missing")
        if missing.returncode == 0 or "expected exactly one rpm" not in missing.stderr:
            raise AssertionError(f"zero-RPM refusal failed: {missing}")
        print("RED zero RPM: expected exactly one rpm")
        rpm.write_text("rpm")
        duplicate = bundle / "deb/second.deb"
        duplicate.write_text("deb")
        doubled = run("doubled")
        if doubled.returncode == 0 or "expected exactly one deb" not in doubled.stderr:
            raise AssertionError(f"two-deb refusal failed: {doubled}")
        print("RED two debs: expected exactly one deb")
        duplicate.unlink()
        good = run("good")
        if good.returncode:
            raise AssertionError(f"valid package staging failed: {good}")
        staged = {path.name for path in (root / "good").iterdir()}
        if staged != {rpm.name, deb.name}:
            raise AssertionError(f"staged package set differs: {staged}")


def main() -> None:
    if os.name == "nt":
        print("SKIP desktop package version contract: POSIX shell fixture runs in Linux CI")
        return

    makefile = MAKEFILE.read_text()
    check_recipe(makefile, VERSION, "Linux", expected_dashed())
    check_recipe(makefile, "0.109.0", "Linux", [["build"]])
    check_recipe(makefile, VERSION, "Darwin", [["build"]])
    print("PASS Linux candidate, Linux GA and non-Linux candidate")

    mutations = (
        ("dash guard", '[ "$${version#*-}" != "$$version" ]', "[ 1 -eq 1 ]", "0.109.0", "Linux", [["build"]], "expected"),
        ("Linux guard", '[ "$$(uname -s)" = Linux ]', "[ 1 -eq 1 ]", VERSION, "Darwin", [["build"]], "expected"),
        ("RPM release", '"release":"0~%s"', '"irrelevant":"0~%s"', VERSION, "Linux", expected_dashed(), "expected"),
        ("first bundle selector", "$(TAURI) build --bundles deb,appimage", "$(TAURI) build", VERSION, "Linux", expected_dashed(), "invalid version"),
    )
    for name, old, new, version, system, expected, failure in mutations:
        if makefile.count(old) != 1:
            raise AssertionError(f"{name}: mutation site is not unique")
        try:
            check_recipe(makefile.replace(old, new, 1), version, system, expected)
        except AssertionError as error:
            if failure not in str(error):
                raise AssertionError(f"{name}: wrong failure: {error}") from error
            print(f"MUTANT RED {name}: {failure}")
        else:
            raise AssertionError(f"{name}: mutant survived")

    if sys.platform == "linux":
        check_stager()
        print("PASS candidate desktop package contract")
    else:
        print("SKIP candidate package staging: Linux release workflow only")
        print("PASS desktop version recipe")


if __name__ == "__main__":
    main()
