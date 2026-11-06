#!/usr/bin/env python3
"""Check the Linux package dependencies against the PPA builders' Rust."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections import deque
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
ROOT_PACKAGES = ("chan", "chan-desktop")
TARGET = "x86_64-unknown-linux-gnu"


class ContractError(RuntimeError):
    """The floor or the dependency graph cannot establish the contract."""


def version(value: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", value):
        raise ContractError(f"invalid Rust version {value!r}")
    parts = tuple(map(int, value.split(".")))
    return (parts[0], parts[1], parts[2] if len(parts) == 3 else 0)


def read_floor(root: Path) -> str:
    path = root / "packaging/distros/debian/rust-floor"
    values = [line.strip() for line in path.read_text().splitlines()
              if line.strip() and not line.lstrip().startswith("#")]
    if len(values) != 1:
        raise ContractError(f"{path}: expected one Rust version")
    floor = values[0]
    parsed = version(floor)
    for package in ROOT_PACKAGES:
        relative = f"packaging/distros/debian/{package}/debian/control"
        text = (root / relative).read_text()
        field = re.search(r"^Build-Depends:(.*(?:\n[ \t].*)*)", text, re.MULTILINE)
        alternatives = re.findall(r"\brustc-(\d+\.\d+(?:\.\d+)?)\b", field[1] if field else "")
        if not alternatives:
            raise ContractError(f"{relative}: no versioned rustc Build-Depends")
        lowest = min(alternatives, key=version)
        if version(lowest) != parsed:
            raise ContractError(f"{relative}: lowest rustc alternative {lowest} differs from rust-floor {floor}")
    return floor


def check_metadata(metadata: dict[str, Any], floor: str) -> tuple[list[str], int]:
    """Return every external offender and its path, and the dependency count."""
    limit = version(floor)
    try:
        packages = {package["id"]: package for package in metadata["packages"]}
        nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
        members = set(metadata["workspace_members"])
        roots = []
        for name in ROOT_PACKAGES:
            matches = [key for key in members if packages[key]["name"] == name]
            if len(matches) != 1:
                raise ContractError(f"metadata: expected one workspace member named {name}")
            roots.append(matches[0])
        findings = []
        external = set()
        # One shortest path per root preserves the package that needs each edge.
        for root in roots:
            pending = deque([(root, (root,))])
            seen = set()
            while pending:
                key, path = pending.popleft()
                if key in seen:
                    continue
                seen.add(key)
                package = packages[key]
                required = package.get("rust_version")
                # Debian deliberately ignores the workspace's own toolchain pin.
                if key not in members:
                    external.add(key)
                    if required is not None and version(required) > limit:
                        chain = " -> ".join(f'{packages[p]["name"]}@{packages[p]["version"]}' for p in path)
                        findings.append(f'{package["name"]}@{package["version"]} needs Rust {required} > {floor}: {chain}')
                for dependency in nodes[key]["deps"]:
                    kinds = dependency["dep_kinds"]
                    if not kinds or any(kind["kind"] not in (None, "build", "dev") for kind in kinds):
                        raise ContractError(f"metadata: invalid dependency kinds for {dependency['pkg']}")
                    if any(kind["kind"] in (None, "build") for kind in kinds):
                        child = dependency["pkg"]
                        pending.append((child, (*path, child)))
        return findings, len(external)
    except (KeyError, TypeError, AttributeError) as error:
        raise ContractError(f"invalid Cargo metadata: {error}") from error


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--metadata", type=Path, help="read a saved Linux-filtered cargo metadata document")
    parser.add_argument("-v", "--verbose", action="store_true", help="print the graph source and target on stderr")
    args = parser.parse_args()
    try:
        floor = read_floor(ROOT)
        if args.verbose:
            print(f"rust-floor: floor={floor} target={TARGET} metadata={args.metadata or 'cargo --locked'}", file=sys.stderr)
        if args.metadata:
            metadata = json.loads(args.metadata.read_text())
        else:
            result = subprocess.run(
                ["cargo", "metadata", "--format-version", "1", "--locked", "--filter-platform", TARGET],
                cwd=ROOT, text=True, capture_output=True, check=True,
            )
            metadata = json.loads(result.stdout)
        findings, count = check_metadata(metadata, floor)
    except subprocess.CalledProcessError as error:
        print(f"FAIL: cargo metadata exited {error.returncode}: {error.stderr.strip()}", file=sys.stderr)
        return 1
    except (ContractError, OSError, UnicodeError, json.JSONDecodeError) as error:
        print(f"FAIL: rust-floor: {error}", file=sys.stderr)
        return 1
    if findings:
        for finding in findings:
            print(f"FAIL: {finding}", file=sys.stderr)
        return 1
    print(f"PASS: Rust {floor} floor: {count} external normal/build dependencies from chan and chan-desktop ({TARGET}); workspace members exempt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
