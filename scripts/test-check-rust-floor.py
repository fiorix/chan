#!/usr/bin/env python3
"""Exercise the dependency-floor graph and its Debian control-file agreement."""

from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("rust_floor", Path(__file__).with_name("check-rust-floor.py"))
assert spec and spec.loader
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def graph(required: str) -> dict:
    def package(name: str, rust: str) -> dict:
        return {"id": name, "name": name, "version": "1.0.0", "rust_version": rust}

    def edge(name: str, kind: str | None = None) -> dict:
        return {"pkg": name, "dep_kinds": [{"kind": kind, "target": None}]}

    return {
        "workspace_members": ["chan", "chan-desktop", "shared"],
        "packages": [package(name, "1.95") for name in ("chan", "chan-desktop", "shared")]
        + [package("builder", required), package("tests-only", "1.99"), package("unused", "1.99")],
        "resolve": {"nodes": [
            {"id": "chan", "deps": [edge("shared"), edge("tests-only", "dev")]},
            {"id": "chan-desktop", "deps": [edge("chan")]},
            {"id": "shared", "deps": [edge("builder", "build")]},
            {"id": "builder", "deps": []},
            {"id": "tests-only", "deps": []},
            {"id": "unused", "deps": []},
        ]},
    }


class RustFloorTests(unittest.TestCase):
    def test_over_floor_names_the_package_and_paths_through_workspace_members(self) -> None:
        findings, count = checker.check_metadata(graph("1.95"), "1.91")
        self.assertEqual(count, 1)
        self.assertEqual(findings, [
            "builder@1.0.0 needs Rust 1.95 > 1.91: chan@1.0.0 -> shared@1.0.0 -> builder@1.0.0",
            "builder@1.0.0 needs Rust 1.95 > 1.91: chan-desktop@1.0.0 -> chan@1.0.0 -> shared@1.0.0 -> builder@1.0.0",
        ])

    def test_at_floor_passes_without_dev_or_unreachable_dependencies(self) -> None:
        self.assertEqual(checker.check_metadata(graph("1.91.0"), "1.91"), ([], 1))

    def test_a_missing_root_or_broken_edge_refuses(self) -> None:
        metadata = graph("1.91")
        metadata["workspace_members"].remove("chan-desktop")
        with self.assertRaises(checker.ContractError):
            checker.check_metadata(metadata, "1.91")
        metadata = graph("1.91")
        metadata["resolve"]["nodes"][-3]["deps"] = [{"pkg": "absent", "dep_kinds": [{"kind": None}]}]
        with self.assertRaises(checker.ContractError):
            checker.check_metadata(metadata, "1.91")

    def test_controls_and_floor_agree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            floor = root / "packaging/distros/debian/rust-floor"
            floor.parent.mkdir(parents=True)
            floor.write_text("# Read by the gate.\n1.91\n")
            for name in ("chan", "chan-desktop"):
                control = floor.parent / name / "debian/control"
                control.parent.mkdir(parents=True)
                control.write_text("Build-Depends: debhelper,\n rustc-1.95 | rustc-1.93 | rustc-1.91 | rustc (>= 1.91),\n")
            self.assertEqual(checker.read_floor(root), "1.91")
            floor.write_text("1.93\n")
            with self.assertRaisesRegex(checker.ContractError, "lowest rustc alternative 1.91 differs from rust-floor 1.93"):
                checker.read_floor(root)


if __name__ == "__main__":
    unittest.main()
