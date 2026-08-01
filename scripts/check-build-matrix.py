#!/usr/bin/env python3
"""Fail when the ordinary build matrix stops proving a shipped surface."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ContractError(RuntimeError):
    """One missing edge in the build graph."""


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(haystack: str, needle: str, where: str) -> None:
    if needle not in haystack:
        raise ContractError(f"{where}: missing {needle!r}")


def make_target(makefile: str, name: str) -> str:
    lines = makefile.splitlines()
    start = next(
        (
            index
            for index, line in enumerate(lines)
            if re.match(rf"^{re.escape(name)}\s*:", line)
        ),
        None,
    )
    if start is None:
        raise ContractError(f"Makefile: missing target {name!r}")

    end = len(lines)
    target_pattern = re.compile(r"^[A-Za-z0-9_.-]+\s*:")
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if target_pattern.match(line):
            end = index
            break
    return "\n".join(lines[start:end])


def require_target(makefile: str, name: str, needles: tuple[str, ...]) -> None:
    body = make_target(makefile, name)
    for needle in needles:
        require(body, needle, f"Makefile target {name}")


def workflow_job(workflow: str, name: str, path: str) -> str:
    lines = workflow.splitlines()
    marker = f"  {name}:"
    start = next(
        (index for index, line in enumerate(lines) if line == marker),
        None,
    )
    if start is None:
        raise ContractError(f"{path}: missing job {name!r}")

    end = len(lines)
    job_pattern = re.compile(r"^  [A-Za-z0-9_-]+:\s*$")
    for index in range(start + 1, len(lines)):
        if job_pattern.match(lines[index]):
            end = index
            break
    return "\n".join(lines[start:end])


def check_make_contract() -> None:
    makefile = read("Makefile")
    require_target(
        makefile,
        "pre-push",
        (
            "$(MAKE) build-matrix-check",
            "$(MAKE) host-build-check WEB_ALREADY_BUILT=1",
        ),
    )
    require_target(
        makefile,
        "ci-linux-build",
        (
            "host-devserver-build-check",
            "$(MAKE) -C desktop ci-linux WEB_ALREADY_BUILT=1",
        ),
    )
    require_target(
        makefile,
        "ci-macos",
        ("$(CARGO) test --all-targets", "$(MAKE) ci-macos-build"),
    )
    require_target(
        makefile,
        "ci-windows",
        ("$(MAKE) -C desktop ci-windows", "chan-desktop.exe"),
    )
    require_target(
        makefile,
        "ci-linux-packages",
        (
            "$(MAKE) web",
            "$(MAKE) linux-deb WEB_ALREADY_BUILT=1",
            "$(MAKE) linux-rpm WEB_ALREADY_BUILT=1",
        ),
    )
    require_target(
        makefile,
        "ci-distro-sources",
        ("$(MAKE) copr-srpm", "$(MAKE) ppa-source"),
    )
    require_target(
        makefile,
        "nix-check",
        (
            "flake check --all-systems --no-build",
            "for package in chan chan-desktop",
            'build --no-link --print-out-paths ".#$$package"',
            'scripts/smoke-nix-package.sh "$$out" "$$package"',
        ),
    )
    require_target(
        makefile,
        "docker-gateway-build",
        ("packaging/docker/build.sh --gateway-only",),
    )


def check_desktop_contract() -> None:
    desktop_makefile = read("desktop/Makefile")
    for target, needles in (
        (
            "ci-linux",
            (
                "ci-linux-prereqs",
                "--bundles appimage",
                "$(BUNDLE_DIR)/appimage",
                "smoke-built-devserver.sh",
            ),
        ),
        (
            "ci-macos",
            (
                "--bundles app",
                "$(CI_MACOS_CONFIG)",
                "codesign --verify",
                "smoke-built-devserver.sh",
            ),
        ),
        (
            "ci-windows",
            (
                "--bundles nsis",
                "$(CI_WINDOWS_CONFIG)",
                "$(BUNDLE_DIR)/nsis",
            ),
        ),
    ):
        require_target(desktop_makefile, target, needles)
    require(
        desktop_makefile,
        "CI_MACOS_CONFIG := tauri.ci.macos.conf.json",
        "desktop/Makefile",
    )
    require(
        desktop_makefile,
        "CI_WINDOWS_CONFIG := tauri.ci.windows.conf.json",
        "desktop/Makefile",
    )
    require(
        desktop_makefile,
        "CI_WEB_PREREQ = $(if $(filter 1,$(WEB_ALREADY_BUILT)),,web)",
        "desktop/Makefile",
    )
    require_target(
        desktop_makefile,
        "ci-linux-prereqs",
        ("xdg-open", "xdg-mime", "xdg-utils"),
    )

    macos = json.loads(read("desktop/src-tauri/tauri.ci.macos.conf.json"))
    identity = macos["bundle"]["macOS"]["signingIdentity"]
    if identity != "-":
        raise ContractError("macOS CI package must use Tauri's ad-hoc identity")

    windows = json.loads(read("desktop/src-tauri/tauri.ci.windows.conf.json"))
    bundle = windows["bundle"]
    if bundle["windows"]["signCommand"] is not None:
        raise ContractError("Windows CI package must not require release secrets")
    require(
        json.dumps(bundle["resources"], sort_keys=True),
        "../../target/release/chan.exe",
        "Windows CI bundle resources",
    )


def check_workflow_contract() -> None:
    core = read(".github/workflows/ci.yml")
    require(core, "pull_request:", ".github/workflows/ci.yml")
    require(core, "branches: [main]", ".github/workflows/ci.yml")
    path = ".github/workflows/ci.yml"
    jobs = {
        "linux": (
            "runs-on: ubuntu-latest",
            "xdg-utils",
            "run: make ci-linux",
        ),
        "macos": (
            "runs-on: macos-latest",
            "python3 chan/scripts/select-newest-xcode.py",
            "run: make ci-macos",
        ),
        "windows": ("runs-on: windows-latest", "run: make ci-windows"),
        "linux-packages": ("run: make ci-linux-packages",),
        "distro-sources": ("run: make ci-distro-sources",),
        "aur": (
            "packaging/distros/arch/build-in-ci.sh",
            "AUR_LOCAL_SOURCE=$archive",
        ),
        "nix": (
            "cachix/install-nix-action@v31",
            "cachix/cachix-action@v17",
            "run: make nix-check",
        ),
        "docker-chan": (
            "docker/setup-buildx-action@v4",
            "run: make docker-chan-build",
        ),
    }
    for name, needles in jobs.items():
        job = workflow_job(core, name, path)
        for needle in needles:
            require(job, needle, f"{path} job {name}")

    for workflow_path in (
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
        ".github/workflows/release-desktop.yml",
    ):
        workflow = read(workflow_path)
        require(
            workflow,
            "python3 chan/scripts/select-newest-xcode.py",
            workflow_path,
        )
        if "Xcode_*.app | sort -V" in workflow:
            raise ContractError(
                f"{workflow_path}: GNU sort -V is not portable to macOS"
            )

    gateway = read(".github/workflows/gateway-ci.yml")
    containers = workflow_job(
        gateway,
        "containers",
        ".github/workflows/gateway-ci.yml",
    )
    require(
        containers,
        "docker/setup-buildx-action@v4",
        ".github/workflows/gateway-ci.yml job containers",
    )
    require(
        containers,
        "run: make docker-gateway-build",
        ".github/workflows/gateway-ci.yml job containers",
    )

    downstream = read(".github/workflows/publish-downstream.yml")
    for workflow_path, workflow in (
        (".github/workflows/ci.yml", core),
        (".github/workflows/publish-downstream.yml", downstream),
    ):
        if "accept-flake-config" in workflow:
            raise ContractError(
                f"{workflow_path}: must not trust cache settings from the checked-out flake"
            )
    for needle in (
        "copr:",
        "launchpad:",
        "aur-validate:",
        "cachix-build:",
        "cachix-substitute:",
        "docker-build:",
        "ubuntu-24.04-arm",
        "cachix/cachix-action@v17",
        "cachix push chan",
    ):
        require(
            downstream,
            needle,
            ".github/workflows/publish-downstream.yml",
        )

    cachix_build = workflow_job(
        downstream,
        "cachix-build",
        ".github/workflows/publish-downstream.yml",
    )
    for needle in (
        "for package in chan chan-desktop",
        'nix build --no-link --print-out-paths ".#$package"',
        'scripts/smoke-nix-package.sh "$out" "$package"',
        'cachix push chan "$CHAN_OUT"',
        'cachix push chan "$CHAN_DESKTOP_OUT"',
        "-chan-${{ matrix.system }}",
        "-chan-desktop-${{ matrix.system }}",
    ):
        require(
            cachix_build,
            needle,
            ".github/workflows/publish-downstream.yml job cachix-build",
        )

    cachix_substitute = workflow_job(
        downstream,
        "cachix-substitute",
        ".github/workflows/publish-downstream.yml",
    )
    for needle in (
        "for package in chan chan-desktop",
        'nix build --no-link --max-jobs 0 --print-out-paths ".#$package"',
        'scripts/smoke-nix-package.sh "$out" "$package"',
    ):
        require(
            cachix_substitute,
            needle,
            ".github/workflows/publish-downstream.yml job cachix-substitute",
        )


def check_docker_contract() -> None:
    script = read("packaging/docker/build.sh")
    require(script, "--chan-only", "packaging/docker/build.sh")
    require(script, "--gateway-only", "packaging/docker/build.sh")
    require(script, "docker buildx version", "packaging/docker/build.sh")
    require(
        script,
        'build "${CHAN_DF}" "" "chan:${TAG}"',
        "packaging/docker/build.sh",
    )
    for target in ("identity", "profile", "devserver-proxy", "devserver-control"):
        require(
            script,
            f'build "${{GW_DF}}" {target} "chan-gateway-{target}:${{TAG}}"',
            "packaging/docker/build.sh",
        )


def check_nix_contract() -> None:
    flake = read("flake.nix")
    for needle in (
        '"x86_64-linux"',
        '"aarch64-linux"',
        "chan = pkgs.callPackage ./packaging/nix/chan.nix",
        "chan-desktop = pkgs.callPackage ./packaging/nix/chan-desktop.nix",
        "inherit chan chan-desktop;",
        "default = chan-desktop;",
    ):
        require(flake, needle, "flake.nix")

    headless = read("packaging/nix/chan.nix")
    for needle in (
        'pname = "chan";',
        "# Harvest the replacement from the first build's hash mismatch.",
        "cargoHash = lib.fakeHash;",
        'src = "${finalAttrs.src}/web";',
        'CHAN_PACKAGED = "nix";',
        'cargoBuildFlags = [\n    "-p"\n    "chan"\n  ];',
        'ln -s chan "$out/bin/cs"',
        'test ! -e "$out/lib/systemd/user/chan-devserver.service"',
    ):
        require(headless, needle, "packaging/nix/chan.nix")
    for forbidden in (
        "webkitgtk_4_1",
        "wrapGAppsHook4",
        "desktop-file-utils",
        "libappindicator-gtk3",
        "glib-networking",
        "chan-desktop.desktop",
        "share/icons",
    ):
        if forbidden in headless:
            raise ContractError(
                f"packaging/nix/chan.nix: headless package contains {forbidden!r}"
            )

    desktop = read("packaging/nix/chan-desktop.nix")
    for needle in (
        'CHAN_PACKAGED = "nix";',
        'cargoBuildFlags = [',
        '"chan-desktop"',
        'ln -s chan-desktop "$out/bin/chan"',
        'ln -s chan-desktop "$out/bin/cs"',
        'test ! -e "$out/lib/systemd/user/chan-devserver.service"',
    ):
        require(desktop, needle, "packaging/nix/chan-desktop.nix")

    npm_hash_pattern = re.compile(
        r'npmDeps = fetchNpmDeps \{.*?hash = "([^"]+)";',
        re.DOTALL,
    )
    headless_npm_hash = npm_hash_pattern.search(headless)
    desktop_npm_hash = npm_hash_pattern.search(desktop)
    if headless_npm_hash is None or desktop_npm_hash is None:
        raise ContractError("Nix derivations must both declare npmDeps.hash")
    if headless_npm_hash.group(1) != desktop_npm_hash.group(1):
        raise ContractError("Nix derivations must share the web npmDeps.hash")
    require(
        desktop,
        'src = "${finalAttrs.src}/web";',
        "packaging/nix/chan-desktop.nix",
    )

    smoke = read("scripts/smoke-nix-package.sh")
    for needle in (
        'case "$PACKAGE" in',
        "chan)",
        "chan-desktop)",
        "headless package contains desktop path",
        '"$BIN/chan" upgrade --check',
        '"self-upgrade is disabled"',
        'scripts/smoke-built-devserver.sh "$BIN/chan"',
    ):
        require(smoke, needle, "scripts/smoke-nix-package.sh")


def main() -> int:
    try:
        check_make_contract()
        check_desktop_contract()
        check_workflow_contract()
        check_docker_contract()
        check_nix_contract()
    except (ContractError, KeyError, json.JSONDecodeError) as error:
        print(f"build-matrix contract: FAIL: {error}", file=sys.stderr)
        return 1

    print("build-matrix contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
