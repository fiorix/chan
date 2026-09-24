#!/usr/bin/env python3
"""Fail when the ordinary build matrix stops proving a shipped surface."""

from __future__ import annotations

import glob
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ContractError(RuntimeError):
    """One missing edge in the build graph."""


def read(relative: str) -> str:
    """The text of RELATIVE, or a contract failure that names the file."""
    try:
        return (ROOT / relative).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        reason = error.strerror if isinstance(error, OSError) else str(error)
        raise ContractError(f"{relative}: cannot read: {reason}") from error


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


def require_unconditional_step(makefile: str, name: str, step: str) -> None:
    """STEP is a live recipe line of target NAME that runs on every host.

    A substring match would accept the line commented out, moved inside a
    conditional block, or folded into the line above it, and the gate would
    still read as wired. The line has to be exactly a tab and the step (no
    leading `#`, `@` or `-`), outside every `ifeq`/`ifneq`/`ifdef`/`ifndef`
    ... `endif` span of the target, and not continued from the line above
    it. make honours a directive behind leading spaces, but reads a tab-led
    `ifeq` or `endif` as a recipe line, so a directive is one whose first
    character is not a tab. A make-level comment or recipe line ending in a
    backslash swallows the line after it.
    """
    where = f"Makefile target {name}"
    depth = 0
    seen = False
    continued = False
    for line in make_target(makefile, name).splitlines():
        if re.match(r"^(?!\t)\s*(ifeq|ifneq|ifdef|ifndef)\b", line):
            depth += 1
        elif re.match(r"^(?!\t)\s*endif\b", line):
            depth -= 1
        elif line == f"\t{step}":
            if continued:
                raise ContractError(f"{where}: {step!r} is a continuation of the line above it")
            if depth > 0:
                raise ContractError(f"{where}: {step!r} runs inside a conditional block")
            seen = True
        continued = line.endswith("\\")
    if not seen:
        raise ContractError(f"{where}: missing the live unconditional recipe line {step!r}")


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
    # The Nix cargoHash steps read files only, so they run on every host;
    # the sdme contract beside them is Linux-only, and a step that slid into
    # that block would still match as a substring.
    for step in ("$(MAKE) nix-hash-contract-check", "$(MAKE) nix-hash-check"):
        require_unconditional_step(makefile, "pre-push", step)
    require_target(
        makefile,
        "nix-hash-check",
        ("scripts/check-nix-cargo-hash.sh",),
    )
    require_target(
        makefile,
        "nix-hash-contract-check",
        ("scripts/test-check-nix-cargo-hash.sh",),
    )
    require_target(
        makefile,
        "nix-hash-pin",
        ('scripts/check-nix-cargo-hash.sh pin "$(CARGO_HASH)"',),
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
        "freebsd-chan-tarball",
        (
            "$(MAKE) -C packaging/freebsd",
            'FREEBSD_TARGET="$(FREEBSD_TARGET)"',
            'FREEBSD_SYSROOT="$(FREEBSD_SYSROOT)"',
            'FREEBSD_CARGO_FLAGS="$(FREEBSD_CARGO_FLAGS)"',
        ),
    )
    require(
        makefile,
        "FREEBSD_ARM64_TOOLCHAIN ?= nightly-2026-08-23",
        "Makefile",
    )
    require_target(
        makefile,
        "freebsd-arm64-chan-tarball",
        (
            "$(MAKE) freebsd-chan-tarball",
            "FREEBSD_TARGET=aarch64-unknown-freebsd",
            'CARGO="$(CARGO) +$(FREEBSD_ARM64_TOOLCHAIN)"',
            'FREEBSD_CARGO_FLAGS="-Z build-std=std,panic_abort"',
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
            'flake check --all-systems --no-build "$(NIX_FLAKE)"',
            "for package in chan chan-desktop",
            'build --no-link --print-out-paths "$(NIX_FLAKE)#$$package"',
            'scripts/smoke-nix-package.sh "$$out" "$$package"',
        ),
    )
    require_target(
        makefile,
        "docker-gateway-build",
        ("packaging/docker/build.sh --gateway-only",),
    )
    # release.yml builds the gateway through this recipe alone, so a stale
    # gateway/Cargo.lock re-resolves inside a release build unless the recipe
    # itself refuses it. pre-push runs the clippy, rustdoc and test recipes
    # before gateway-build, and an unlocked one rewrites the stale lock on
    # disk, which the locked build then accepts, so every cargo line that
    # resolves the gateway workspace carries the flag.
    require_target(makefile, "gateway-build", ("$(CARGO) build --locked",))
    require_target(makefile, "gateway-lint", ("$(CARGO) clippy --locked",))
    require_target(makefile, "gateway-doc", ("$(CARGO) doc --locked",))
    require_target(
        makefile,
        "gateway-test",
        (
            "$(CARGO) test --locked --workspace --lib",
            "$(CARGO) test --locked -p devserver-proxy",
            "$(CARGO) test --locked --workspace --bins",
        ),
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

    release = read(".github/workflows/release.yml")
    linux_cli = workflow_job(
        release,
        "linux-cli-artifacts",
        ".github/workflows/release.yml",
    )
    for needle in (
        "name: linux CLI tarball (${{ matrix.musl_target }})",
        "target: ${{ matrix.musl_target }}",
        "make linux-chan-tarball LINUX_TARGET=${{ matrix.musl_target }}",
        "name: release-linux-cli-${{ matrix.musl_target }}",
    ):
        require(
            linux_cli,
            needle,
            ".github/workflows/release.yml job linux-cli-artifacts",
        )
    if "matrix.target" in linux_cli or "unknown-linux-gnu" in linux_cli:
        raise ContractError(
            ".github/workflows/release.yml job linux-cli-artifacts: "
            "musl build carries a gnu or generic target field"
        )

    freebsd_cli = workflow_job(
        release,
        "freebsd-cli-artifacts",
        ".github/workflows/release.yml",
    )
    for needle in (
        "name: FreeBSD CLI tarball (x86_64-unknown-freebsd)",
        "needs: context",
        "runs-on: ubuntu-latest",
        "target: x86_64-unknown-freebsd",
        "key: freebsd-x86_64-unknown-freebsd",
        "save-if: false",
        "rustup target add x86_64-unknown-freebsd",
        "sudo apt-get install -y clang lld llvm",
        "llvm-ar --version",
        "llvm-ranlib --version",
        "15.0-RELEASE/base.txz",
        "ac0c933cc02ee8af4da793f551e4a9a15cdcf0e67851290b1e8c19dd6d30bba8",
        "make freebsd-chan-tarball FREEBSD_TARGET=x86_64-unknown-freebsd",
        "*ELF\\ 64-bit*FreeBSD*statically\\ linked*",
        "name: release-freebsd-cli",
        "chan-x86_64-unknown-freebsd.tar.gz",
    ):
        require(
            freebsd_cli,
            needle,
            ".github/workflows/release.yml job freebsd-cli-artifacts",
        )
    if "aarch64-unknown-freebsd" in freebsd_cli:
        raise ContractError(
            ".github/workflows/release.yml job freebsd-cli-artifacts: "
            "amd64 job must remain on the pinned stable target"
        )

    freebsd_cli_arm64 = workflow_job(
        release,
        "freebsd-cli-arm64-artifacts",
        ".github/workflows/release.yml",
    )
    for needle in (
        "name: FreeBSD CLI tarball (aarch64-unknown-freebsd)",
        "needs: context",
        "runs-on: ubuntu-latest",
        "FREEBSD_TARGET: aarch64-unknown-freebsd",
        "toolchain: nightly-2026-08-23",
        "components: rust-src",
        "cache: false",
        "key: freebsd-aarch64-unknown-freebsd",
        "save-if: false",
        "sudo apt-get install -y clang lld llvm",
        "llvm-ar --version",
        "llvm-ranlib --version",
        "releases/arm64/aarch64/15.0-RELEASE/base.txz",
        "d63d5c5bd01a1e2d8b990102abd5077a26e8232bb1d02234deaed420e71f1343",
        "make freebsd-arm64-chan-tarball",
        "*ELF\\ 64-bit*ARM\\ aarch64*FreeBSD*statically\\ linked*",
        "name: release-freebsd-cli-arm64",
        "chan-aarch64-unknown-freebsd.tar.gz",
    ):
        require(
            freebsd_cli_arm64,
            needle,
            ".github/workflows/release.yml job freebsd-cli-arm64-artifacts",
        )
    if "cp chan/rust-toolchain.toml" in freebsd_cli_arm64:
        raise ContractError(
            ".github/workflows/release.yml job freebsd-cli-arm64-artifacts: "
            "tier-3 arm64 job must not select the repository's stable toolchain"
        )
    if "rustup target add aarch64-unknown-freebsd" in freebsd_cli_arm64:
        raise ContractError(
            ".github/workflows/release.yml job freebsd-cli-arm64-artifacts: "
            "tier-3 arm64 target must build std from rust-src"
        )

    publish_release = workflow_job(
        release,
        "publish-release",
        ".github/workflows/release.yml",
    )
    for needle in (
        "- freebsd-cli-artifacts",
        "- freebsd-cli-arm64-artifacts",
    ):
        require(
            publish_release,
            needle,
            ".github/workflows/release.yml job publish-release",
        )

    freebsd_packaging = read("packaging/freebsd/Makefile")
    for needle in (
        "FREEBSD_TARGET ?= x86_64-unknown-freebsd",
        "FREEBSD_ABI_TARGET ?= $(FREEBSD_TARGET)15.0",
        "FREEBSD_CARGO_FLAGS ?=",
        "x86_64-unknown-freebsd|aarch64-unknown-freebsd",
        "FREEBSD_TARGET_ENV := aarch64_unknown_freebsd",
        "FREEBSD_TARGET_ENV_UPPER := AARCH64_UNKNOWN_FREEBSD",
        "-C target-feature=+crt-static",
        "-C link-arg=--target=$(FREEBSD_ABI_TARGET)",
        "-C link-arg=--sysroot=$(FREEBSD_SYSROOT_ABS)",
        "CARGO_TARGET_$(FREEBSD_TARGET_ENV_UPPER)_LINKER",
        "CC_$(FREEBSD_TARGET_ENV)",
        '$(CARGO) build $(FREEBSD_CARGO_FLAGS) --release --target "$(FREEBSD_TARGET)" -p chan',
        '$(TARBALL_STAGE)/chan',
        '$(TARBALL_STAGE)/LICENSE',
        '$(TARBALL_STAGE)/README.md',
    ):
        require(
            freebsd_packaging,
            needle,
            "packaging/freebsd/Makefile",
        )

    for package, trigger_name, verify_name in (
        ("chan", "copr-chan-trigger", "copr-chan-verify"),
        ("chan-desktop", "copr-desktop-trigger", "copr-desktop-verify"),
    ):
        trigger = workflow_job(
            downstream,
            trigger_name,
            ".github/workflows/publish-downstream.yml",
        )
        for needle in (
            f"\n          PACKAGE: {package}\n",
            "posted_at: ${{ steps.trigger.outputs.posted_at }}",
            "webhook_present: ${{ steps.trigger.outputs.webhook_present }}",
            "id: trigger",
            'curl -sf -X POST "${WEBHOOK}${PACKAGE}/"',
            "frozen from the tag push until the probe confirms both packages",
        ):
            require(
                trigger,
                needle,
                f".github/workflows/publish-downstream.yml job {trigger_name}",
            )

        verify = workflow_job(
            downstream,
            verify_name,
            ".github/workflows/publish-downstream.yml",
        )
        for needle in (
            f"needs: {trigger_name}",
            f"\n          PACKAGE: {package}\n",
            f"POSTED_AT: ${{{{ needs.{trigger_name}.outputs.posted_at }}}}",
            f"WEBHOOK_PRESENT: ${{{{ needs.{trigger_name}.outputs.webhook_present }}}}",
            "CANONICAL: ${{ github.repository == 'fiorix/chan' }}",
            "run: packaging/distros/copr/verify-copr-publication.sh",
        ):
            require(
                verify,
                needle,
                f".github/workflows/publish-downstream.yml job {verify_name}",
            )

    for needle in (
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

    docker_build = workflow_job(
        downstream,
        "docker-build",
        ".github/workflows/publish-downstream.yml",
    )
    for needle in (
        "needs.context.result == 'success' &&",
        "github.event_name == 'workflow_dispatch'",
        "(inputs.targets == 'all' || inputs.targets == 'docker')) ||",
        "github.event_name == 'workflow_run'",
    ):
        require(
            docker_build,
            needle,
            ".github/workflows/publish-downstream.yml job docker-build",
        )
    if "inputs.targets == 'cachix'" in docker_build:
        raise ContractError(
            ".github/workflows/publish-downstream.yml job docker-build: "
            "Cachix dispatches must not schedule Docker builds"
        )


def workflow_triggers(workflow: str, path: str) -> dict[str, dict[str, list[str]]]:
    """The `paths` and `paths-ignore` pattern lists under each `on:` event.

    Line-based like workflow_job, since the checker has no YAML parser: the
    block is the lines after a bare `on:` up to the next unindented key, an
    event is a two-space key in it, a filter is a four-space `paths:` or
    `paths-ignore:` under that event, and its patterns are the six-space
    `- ` items after it, quoted or bare. A filter with no pattern is an
    error rather than an empty list, because GitHub reads an empty `paths`
    as selecting nothing, which never runs the workflow.
    """
    lines = workflow.splitlines()
    start = next((index for index, line in enumerate(lines) if line == "on:"), None)
    if start is None:
        raise ContractError(f"{path}: missing the on: block")

    triggers: dict[str, dict[str, list[str]]] = {}
    event = None
    filter_name = None
    for line in lines[start + 1 :]:
        if line.strip() == "" or line.lstrip().startswith("#"):
            continue
        if not line.startswith(" "):
            break
        event_match = re.match(r"^  ([A-Za-z_]+):", line)
        if event_match:
            event = event_match.group(1)
            triggers.setdefault(event, {})
            filter_name = None
            continue
        filter_match = re.match(r"^    (paths|paths-ignore):\s*$", line)
        if filter_match and event is not None:
            filter_name = filter_match.group(1)
            triggers[event][filter_name] = []
            continue
        item = re.match(r"""^      - (?:'([^']*)'|"([^"]*)"|(\S+))\s*$""", line)
        if item and filter_name is not None:
            pattern = next(group for group in item.groups() if group is not None)
            triggers[event][filter_name].append(pattern)
            continue
        filter_name = None

    for event_name, filters in triggers.items():
        for name, patterns in filters.items():
            if not patterns:
                raise ContractError(f"{path}: on.{event_name}.{name} lists no pattern")
    return triggers


def filter_pattern(pattern: str) -> re.Pattern[str]:
    """The regex GitHub's filter pattern cheat sheet describes for PATTERN.

    `**` matches anything, `*` anything but a slash, `?` and `+` quantify
    the character before them, `[...]` is a character class, every other
    character is literal, and a pattern is anchored at the repository root.
    A `**` standing alone between separators matches zero or more whole
    directories, which is how `docs/**/*.md` reaches `docs/hello.md`.
    """
    regex = []
    index = 0
    while index < len(pattern):
        char = pattern[index]
        if pattern.startswith("**", index):
            before = index == 0 or pattern[index - 1] == "/"
            after = pattern[index + 2 : index + 3] == "/"
            if before and after:
                regex.append("(?:.*/)?")
                index += 3
            else:
                regex.append(".*")
                index += 2
            continue
        if char == "*":
            regex.append("[^/]*")
        elif char in "?+":
            regex.append(char)
        elif char == "[":
            end = pattern.find("]", index)
            if end == -1:
                raise ContractError(f"filter pattern {pattern!r}: unclosed [")
            regex.append(pattern[index : end + 1])
            index = end + 1
            continue
        else:
            regex.append(re.escape(char))
        index += 1
    return re.compile("^" + "".join(regex) + "$")


def filter_selects(patterns: list[str], path: str) -> bool:
    """Whether the ordered filter PATTERNS select PATH.

    Patterns apply in order: a matching `!` pattern after a positive match
    drops the path, a matching positive pattern after that picks it up
    again, and a path no pattern mentions is not selected.
    """
    selected = False
    for pattern in patterns:
        negate = pattern.startswith("!")
        if filter_pattern(pattern[1:] if negate else pattern).match(path):
            selected = not negate
    return selected


def toml_module():
    """The tomllib module, or a contract failure that names the floor.

    Only the gateway trigger contract parses TOML, so the import happens
    here rather than at the top of the file: on an interpreter older than
    3.11 every other contract still runs, and this one fails with its
    reason instead of the whole checker dying at import.
    """
    try:
        import tomllib
    except ImportError as error:
        version = ".".join(str(part) for part in sys.version_info[:3])
        raise ContractError(
            "the gateway trigger contract needs Python 3.11 or newer for "
            f"tomllib; {sys.executable} is Python {version}"
        ) from error
    return tomllib


def manifest(relative: str) -> dict:
    """RELATIVE parsed as TOML, or a contract failure that names the file."""
    tomllib = toml_module()
    try:
        return tomllib.loads(read(relative))
    except tomllib.TOMLDecodeError as error:
        raise ContractError(f"{relative}: not valid TOML: {error}") from error


def dependency_tables(data: dict, dev: bool) -> list[dict]:
    """The dependency tables of one manifest that reach a build.

    Plain, build and per-target tables, plus the dev ones when DEV. A path
    dependency's own dev-dependencies never enter its consumer's build, so
    the walk past the gateway's manifests reads the build tables only.
    """
    kinds = ["dependencies", "build-dependencies"]
    if dev:
        kinds.append("dev-dependencies")
    tables = [data.get(kind, {}) for kind in kinds]
    for target in data.get("target", {}).values():
        tables.extend(target.get(kind, {}) for kind in kinds)
    return tables


def path_dependency(spec: object, base: Path) -> Path | None:
    if isinstance(spec, dict) and "path" in spec:
        return (base / spec["path"]).resolve()
    return None


def gateway_member_dirs(gateway_dir: Path, workspace: dict) -> list[Path]:
    """The directories gateway/Cargo.toml's `members` list names.

    Cargo expands a glob member against the workspace manifest's directory
    and keeps the matches that hold a Cargo.toml and that `exclude` does not
    name; a literal member is taken as written, so a missing manifest fails
    when the walk reads it.
    """
    excluded = {(gateway_dir / path).resolve() for path in workspace.get("exclude", [])}
    dirs: list[Path] = []
    for member in workspace["members"]:
        if any(char in member for char in "*?["):
            matches = sorted(glob.glob(member, root_dir=gateway_dir))
            dirs.extend(
                gateway_dir / match
                for match in matches
                if (gateway_dir / match / "Cargo.toml").is_file()
                and (gateway_dir / match).resolve() not in excluded
            )
        else:
            dirs.append(gateway_dir / member)
    return [path.resolve() for path in dirs]


def gateway_root_crates() -> dict[str, str]:
    """Every root workspace crate the gateway workspace compiles.

    Repo-relative crate directory to the edge that reaches it. The walk
    starts inside gateway/: gateway/Cargo.toml, every directory its
    `members` list names or matches, and every crate under gateway/ one of
    those reaches by path, since cargo makes such a crate an implicit
    member and compiles it whether `members` lists it or not. Each of
    those manifests is read with its dev-dependencies, since Gateway CI
    compiles the members' tests, and resolves `workspace = true` through
    gateway/Cargo.toml's [workspace.dependencies]. The seeds are the path
    targets leaving gateway/ in those manifests, and in gateway/Cargo.toml's
    [workspace.dependencies], [patch.<registry>] and [replace] tables,
    since cargo builds a patched or replaced crate from that path in place
    of the registry one. From each seed the walk follows the build tables:
    a `workspace = true` edge resolves through the root Cargo.toml's
    [workspace.dependencies], a direct `path` resolves beside the manifest,
    and either lands on a root crate when it points inside the repository.
    Breadth first, so a crate the gateway names directly reports that edge
    rather than one further down the chain.
    """
    gateway_dir = (ROOT / "gateway").resolve()
    workspace = manifest("gateway/Cargo.toml")
    gateway_workspace = workspace.get("workspace", {}).get("dependencies", {})
    internal = [gateway_dir] + gateway_member_dirs(gateway_dir, workspace["workspace"])
    visited: set[Path] = set()
    pending: list[tuple[Path, str]] = []
    while internal:
        crate_dir = internal.pop(0)
        if crate_dir in visited:
            continue
        visited.add(crate_dir)
        relative = f"{crate_dir.relative_to(ROOT).as_posix()}/Cargo.toml"
        data = workspace if crate_dir == gateway_dir else manifest(relative)
        tables = [("dependency", table) for table in dependency_tables(data, dev=True)]
        if crate_dir == gateway_dir:
            tables.append(("dependency", gateway_workspace))
            for registry, table in data.get("patch", {}).items():
                tables.append((f"patch.{registry}", table))
            tables.append(("replace", data.get("replace", {})))
        for kind, table in tables:
            for name, spec in table.items():
                if isinstance(spec, dict) and spec.get("workspace") is True:
                    target = path_dependency(gateway_workspace.get(name), gateway_dir)
                else:
                    target = path_dependency(spec, crate_dir)
                if target is None:
                    continue
                if target.is_relative_to(gateway_dir):
                    internal.append(target)
                else:
                    pending.append((target, f"{relative} {kind} {name}"))

    root_workspace = manifest("Cargo.toml")["workspace"]["dependencies"]
    reached: dict[Path, str] = {}
    while pending:
        crate_dir, edge = pending.pop(0)
        if crate_dir in reached:
            continue
        if not crate_dir.is_relative_to(ROOT):
            raise ContractError(
                f"{edge}: path dependency {crate_dir} leaves the repository"
            )
        reached[crate_dir] = edge
        relative = crate_dir.relative_to(ROOT).as_posix()
        for table in dependency_tables(manifest(f"{relative}/Cargo.toml"), dev=False):
            for name, spec in table.items():
                if isinstance(spec, dict) and spec.get("workspace") is True:
                    target = path_dependency(root_workspace.get(name), ROOT)
                else:
                    target = path_dependency(spec, crate_dir)
                if target is not None:
                    pending.append((target, f"{relative}/Cargo.toml dependency {name}"))
    return {path.relative_to(ROOT).as_posix(): edge for path, edge in reached.items()}


def check_gateway_trigger_contract() -> None:
    """Gateway CI runs on every root workspace crate the gateway compiles.

    The gateway builds the root's tunnel crates by path, those crates read
    the root Cargo.toml through `workspace = true`, and only Gateway CI runs
    the gateway's Postgres-backed integration tests and container builds,
    so a change to any of them that its filter does not select reaches
    neither. Both event filters must select every file of every crate in
    that closure and the root Cargo.toml; a few file paths stand in for a
    directory, since a filter is a pattern list, and build.rs is one of
    them so a list that selects only a crate's manifest and src/ fails.
    The two filters are one list on purpose, and everything ci.yml ignores
    must be selected here, so that no change escapes both gates.
    """
    path = ".github/workflows/gateway-ci.yml"
    triggers = workflow_triggers(read(path), path)
    lists: dict[str, list[str]] = {}
    for event in ("push", "pull_request"):
        if "paths" not in triggers.get(event, {}):
            raise ContractError(f"{path}: missing on.{event}.paths")
        lists[event] = triggers[event]["paths"]
    if lists["push"] != lists["pull_request"]:
        raise ContractError(f"{path}: on.push.paths and on.pull_request.paths differ")

    crates = gateway_root_crates()
    if not crates:
        raise ContractError(
            "gateway/Cargo.toml: no path dependency reaches the root workspace; "
            "retire this contract if the gateway stopped consuming root crates"
        )
    samples = {
        "Cargo.toml": (
            "the root Cargo.toml, whose [workspace.dependencies] decide what the "
            "root crates the gateway compiles are built against"
        )
    }
    for crate_dir, edge in sorted(crates.items()):
        for sample in ("Cargo.toml", "build.rs", "src/lib.rs", "src/deep/nested.rs"):
            samples[f"{crate_dir}/{sample}"] = f"{crate_dir} is reached from {edge}"
    for event, patterns in lists.items():
        for sample, reason in samples.items():
            if not filter_selects(patterns, sample):
                raise ContractError(
                    f"{path}: on.{event}.paths does not select {sample} ({reason})"
                )

    core_path = ".github/workflows/ci.yml"
    core = workflow_triggers(read(core_path), core_path)
    for event in ("push", "pull_request"):
        ignored = core.get(event, {}).get("paths-ignore")
        if not ignored:
            raise ContractError(f"{core_path}: missing on.{event}.paths-ignore")
        for pattern in ignored:
            if pattern not in lists[event]:
                raise ContractError(
                    f"{core_path}: on.{event}.paths-ignore {pattern!r} is not in "
                    f"{path} on.{event}.paths, so a change there runs neither gate"
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
        'src = "${finalAttrs.src}/web";',
        'CHAN_PACKAGED = "nix";',
        'cargoBuildFlags = [\n    "-p"\n    "chan"\n  ];',
        'ln -s chan "$out/bin/cs"',
        'test ! -e "$out/lib/systemd/user/chan-devserver.service"',
    ):
        require(headless, needle, "packaging/nix/chan.nix")
    if not re.search(r'cargoHash = "sha256-[A-Za-z0-9+/=]{44}";', headless):
        raise ContractError(
            "packaging/nix/chan.nix: cargoHash must be a pinned sha256. "
            "A placeholder builds nowhere, and the install page advertises "
            "this output."
        )
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


NODE_MAJOR_FILE = ".nvmrc"


def declared_node_major() -> str:
    """The node major every bundle builds on, as `.nvmrc` states it.

    One bare major such as `22` and nothing else: a Docker `FROM` tag and a
    nixpkgs attribute name can carry only a major, so a minor, a `v` prefix
    or an nvm alias in the file would leave the sites that cannot read it
    with nothing to agree with.
    """
    text = read(NODE_MAJOR_FILE)
    major = text.strip()
    if not re.fullmatch(r"[1-9][0-9]*", major):
        raise ContractError(
            f"{NODE_MAJOR_FILE}: expected one bare node major such as 22, "
            f"found {text!r}"
        )
    return major


def workflow_steps(workflow: str, action: str) -> list[tuple[int, int, dict[str, tuple[str, int]]]]:
    """Each step of WORKFLOW that uses ACTION, with its job and its inputs.

    Line-based like workflow_job: a step is its `- uses:` line (or the
    `uses:` line under a `- name:`), the action quoted or bare, plus every
    line indented past that dash, its job is the nearest two-space key
    above it, and its inputs are the scalar `key: value` lines in that
    span, quoted or bare, each with the 1-based line it sits on. Every such
    key in the step counts, wherever it sits, so a version input a typo
    moved out of `with:` is still seen rather than accepted. The tuple is
    the job's line, the step's line, and the inputs. A job key that carries
    a trailing comment is not seen as a job, as in workflow_job, so its
    steps count toward the job above it.
    """
    lines = workflow.splitlines()
    job_pattern = re.compile(r"^  [A-Za-z0-9_-]+:\s*$")
    steps: list[tuple[int, int, dict[str, tuple[str, int]]]] = []
    job_line = 0
    for index, line in enumerate(lines):
        if job_pattern.match(line):
            job_line = index + 1
        match = re.match(rf"""^(\s*)(- )?uses:\s*['"]?{re.escape(action)}@""", line)
        if not match:
            continue
        dash = len(match.group(1)) - (0 if match.group(2) else 2)
        inputs: dict[str, tuple[str, int]] = {}
        for number, later in enumerate(lines[index + 1 :], start=index + 2):
            stripped = later.strip()
            if stripped == "" or stripped.startswith("#"):
                continue
            if len(later) - len(later.lstrip()) <= dash:
                break
            key = re.match(
                r"""^\s*([A-Za-z0-9_-]+):\s*"""
                r"""(?:'([^']*)'|"([^"]*)"|([^\s#'"][^#]*?))?\s*(?:#.*)?$""",
                later,
            )
            if key:
                value = next((group for group in key.groups()[1:] if group is not None), "")
                inputs[key.group(1)] = (value.strip(), number)
        steps.append((job_line, index + 1, inputs))
    return steps


def workflow_run_lines(workflow: str) -> list[tuple[int, int, str]]:
    """Each command line of every `run:` step in WORKFLOW, with its job.

    Line-based like workflow_steps: a `run:` body is the value on the key's
    own line plus every later line indented past the key (a `|` or `>`
    block), and a line whose first non-blank character is `#` is a shell
    comment and not returned. The tuple is the job's line, the 1-based line
    the command sits on, and the command text.
    """
    lines = workflow.splitlines()
    job_pattern = re.compile(r"^  [A-Za-z0-9_-]+:\s*$")
    commands: list[tuple[int, int, str]] = []
    job_line = 0
    for index, line in enumerate(lines):
        if job_pattern.match(line):
            job_line = index + 1
        match = re.match(r"^(\s*)(- )?run:(.*)$", line)
        if not match:
            continue
        column = len(match.group(1)) + (2 if match.group(2) else 0)
        body = [(index + 1, match.group(3))]
        for number, later in enumerate(lines[index + 1 :], start=index + 2):
            if later.strip() and len(later) - len(later.lstrip()) <= column:
                break
            body.append((number, later))
        for number, text in body:
            stripped = text.strip()
            if stripped and not stripped.startswith("#"):
                commands.append((job_line, number, stripped))
    return commands


# A command that installs the web workspace or builds a bundle from it, so
# the node that runs it is the node the bundle is built on.
BUNDLE_BUILD = re.compile(
    r"\bnpm(?:\s|$)|\bmkdist\b|\bmake\b[^;&|]*?\s(?:web[A-Za-z0-9_-]*|distros-tarball)(?=[\s;&|)]|$)"
)


def check_node_major_contract() -> None:
    """One node major, stated in `.nvmrc`, builds the bundles this can see.

    That is every bundle a GitHub workflow builds, the container images and
    the Nix packages; the COPR SRPM stage builds its bundles on the mock
    chroot's own `nodejs` (`.copr/Makefile`), which this cannot reach and
    which is 22 or 24 on Fedora 43 and 44 today.

    The workflows read the file: every setup-node step names it through
    `node-version-file`, at the path where its job's actions/checkout put
    the repository (`chan/.nvmrc` under `path: chan`, `.nvmrc` for a root
    checkout), since setup-node resolves that input from the runner's
    workspace, and none carries a `node-version` literal, the right major
    included, since a literal is a second place to edit. A checkout that
    names a `repository` is some other repository's and offers no
    `.nvmrc` of ours, so it does not count. The checkout has to come before
    the setup-node step, and a checkout that pins a `ref` counts only when
    it is the job's one checkout of this repository, since beside another
    it is some other revision than the tree the job builds. A job whose
    `run:` steps install or build the web workspace (`npm`, `mkdist`, a
    `make web*` or `make distros-tarball` target) needs such a step before
    them, since without one the bundle builds on whatever node the runner
    image carries and no setup-node step exists to check. The Docker images and
    the Nix packages cannot read the file (a `FROM` tag and a nixpkgs
    attribute are fixed before anything runs), so they name the major and
    this holds them to it.
    """
    major = declared_node_major()
    workflows_dir = ROOT / ".github" / "workflows"
    workflows = sorted(workflows_dir.glob("*.yml")) + sorted(workflows_dir.glob("*.yaml"))
    steps = 0
    for workflow_path in workflows:
        path = workflow_path.relative_to(ROOT).as_posix()
        workflow = read(path)
        # Per job, each checkout of this repository: its line, the path its
        # .nvmrc lands at, and the `ref` it pins, if any.
        checkouts: dict[int, list[tuple[int, str, str | None]]] = {}
        for job_line, line, inputs in workflow_steps(workflow, "actions/checkout"):
            if "repository" in inputs:
                continue
            prefix = inputs.get("path", ("", 0))[0].strip("/")
            expected = f"{prefix}/{NODE_MAJOR_FILE}" if prefix else NODE_MAJOR_FILE
            ref = inputs["ref"][0] if "ref" in inputs else None
            checkouts.setdefault(job_line, []).append((line, expected, ref))
        node_steps: dict[int, int] = {}
        for job_line, line, inputs in workflow_steps(workflow, "actions/setup-node"):
            steps += 1
            node_steps.setdefault(job_line, line)
            if "node-version" in inputs:
                value, at = inputs["node-version"]
                raise ContractError(
                    f"{path}:{at}: setup-node carries node-version {value!r} "
                    f"instead of reading {NODE_MAJOR_FILE}"
                )
            if "node-version-file" not in inputs:
                raise ContractError(
                    f"{path}:{line}: setup-node does not read {NODE_MAJOR_FILE} "
                    "(no node-version-file input)"
                )
            value, at = inputs["node-version-file"]
            job_checkouts = checkouts.get(job_line, [])
            if not job_checkouts:
                raise ContractError(
                    f"{path}:{line}: setup-node in a job with no actions/checkout "
                    f"of this repository, so no {NODE_MAJOR_FILE} to read"
                )
            expected = {checkout_path for _, checkout_path, _ in job_checkouts}
            if value not in expected:
                raise ContractError(
                    f"{path}:{at}: node-version-file is {value!r}, expected "
                    f"{' or '.join(repr(item) for item in sorted(expected))} "
                    "(where the job checks the repository out)"
                )
            sources = [checkout for checkout in job_checkouts if checkout[1] == value]
            earlier = [checkout for checkout in sources if checkout[0] < line]
            if not earlier:
                raise ContractError(
                    f"{path}:{line}: setup-node runs before the actions/checkout "
                    f"at line {sources[0][0]} that puts {value!r} in place"
                )
            # A job with one checkout of this repository builds that tree,
            # whatever ref it pins, so its .nvmrc is the one that tree
            # declares. Beside another checkout, a pinned ref is some other
            # revision (an older tag, say), not the tree the job builds.
            own = [
                checkout
                for checkout in earlier
                if checkout[2] is None or len(job_checkouts) == 1
            ]
            if not own:
                raise ContractError(
                    f"{path}:{at}: setup-node reads {value!r} from the "
                    f"actions/checkout at line {earlier[0][0]}, which pins ref "
                    f"{earlier[0][2]!r} beside another checkout of this "
                    "repository, so it is not the tree the job builds"
                )
        lines = workflow.splitlines()
        for job_line, number, command in workflow_run_lines(workflow):
            build = BUNDLE_BUILD.search(command)
            if not build:
                continue
            node_line = node_steps.get(job_line)
            if node_line is None or node_line > number:
                job = lines[job_line - 1].strip().rstrip(":") if job_line else "(no job)"
                raise ContractError(
                    f"{path}:{number}: job {job!r} runs {build.group(0).strip()!r} "
                    f"with no actions/setup-node step before it reading "
                    f"{NODE_MAJOR_FILE}, so the bundle builds on the runner's "
                    "default node"
                )
    if steps == 0:
        raise ContractError(
            ".github/workflows: no actions/setup-node step; retire this "
            "contract if the workflows stopped building the bundles"
        )

    docker_dir = ROOT / "packaging" / "docker"
    dockerfiles = sorted(
        candidate
        for candidate in docker_dir.rglob("*")
        if candidate.is_file()
        and (candidate.name == "Dockerfile" or candidate.name.endswith(".Dockerfile"))
    )
    if not dockerfiles:
        raise ContractError("packaging/docker: no Dockerfile found")
    for dockerfile in dockerfiles:
        path = dockerfile.relative_to(ROOT).as_posix()
        for number, line in enumerate(read(path).splitlines(), start=1):
            match = re.match(r"^\s*FROM\s+(?:--\S+\s+)*(\S+)", line, re.IGNORECASE)
            if not match:
                continue
            # The image is the last path component, so a registry prefix
            # (`docker.io/library/node`) is still node; a digest after `@`
            # pins bytes but names no major, so the tag has to.
            image = match.group(1).split("@", 1)[0]
            name, _, tag = image.rpartition("/")[2].partition(":")
            if name.lower() != "node":
                continue
            if not tag:
                raise ContractError(
                    f"{path}:{number}: FROM {match.group(1)} names no node "
                    f"tag, so not the major {major} {NODE_MAJOR_FILE} declares"
                )
            if not re.match(rf"^{major}(?:[.-]|$)", tag):
                raise ContractError(
                    f"{path}:{number}: FROM {match.group(1)} does not name "
                    f"node {major}, the major {NODE_MAJOR_FILE} declares"
                )

    for path in ("packaging/nix/chan.nix", "packaging/nix/chan-desktop.nix"):
        found = False
        for number, line in enumerate(read(path).splitlines(), start=1):
            for token in re.findall(r"\bnodejs_(\d+)\b", line):
                found = True
                if token != major:
                    raise ContractError(
                        f"{path}:{number}: nodejs_{token} does not name node "
                        f"{major}, the major {NODE_MAJOR_FILE} declares"
                    )
        if not found:
            raise ContractError(f"{path}: no nodejs_{major} attribute")


def main() -> int:
    # Each contract runs even when an earlier one fails, so one broken
    # contract, or an interpreter too old for the gateway one, does not hide
    # the verdict of the rest.
    failed = False
    for check in (
        check_make_contract,
        check_desktop_contract,
        check_workflow_contract,
        check_gateway_trigger_contract,
        check_docker_contract,
        check_nix_contract,
        check_node_major_contract,
    ):
        try:
            check()
        except (ContractError, KeyError, OSError, json.JSONDecodeError) as error:
            print(f"build-matrix contract: FAIL: {error}", file=sys.stderr)
            failed = True
    if failed:
        return 1

    print("build-matrix contract: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
