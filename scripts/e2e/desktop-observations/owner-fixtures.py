#!/usr/bin/env python3
"""Create disposable owner controls and inspect their files without a browser."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import subprocess
import sys

HERE = Path(__file__).resolve().parent


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def generate(root: Path) -> None:
    root.mkdir(mode=0o700)
    subprocess.run([sys.executable, str(HERE / "make-seed.py"), str(root)], check=True, timeout=20)
    elements = []
    for i, color in enumerate(("#e03131", "#1971c2")):
        elements.append({
            "id": "repeated-id", "type": "rectangle", "x": 30 + 180 * i, "y": 30,
            "width": 120, "height": 80, "angle": 0, "strokeColor": color,
            "backgroundColor": color, "fillStyle": "solid", "strokeWidth": 2,
            "strokeStyle": "solid", "roughness": 0, "opacity": 100, "groupIds": [],
            "frameId": None, "roundness": None, "seed": 100 + i, "version": 1,
            "versionNonce": 200 + i, "isDeleted": False, "boundElements": None,
            "updated": 1, "link": None, "locked": False,
        })
    scene = {"type": "excalidraw", "version": 2, "source": "chan-observation",
             "elements": elements, "appState": {"viewBackgroundColor": "#ffffff"}, "files": {}}
    (root / "duplicate-id.excalidraw").write_text(json.dumps(scene, indent=2) + "\n")
    (root / "recovery").mkdir(mode=0o700)
    (root / "recovery/note.md").write_text("# Local recovery control\n\nOriginal disk text.\n")
    (root / "connecting.md").write_text("# Connecting-page hide control\n")
    manifest = {
        "schema": 1, "fixture": "desktop-owner-controls", "root": str(root.resolve()),
        "recovery_marker": "owner-recovery-" + secrets.token_hex(12),
        "initial_sha256": {str(path.relative_to(root)): digest(path) for path in sorted(root.rglob("*")) if path.is_file()},
        "duplicate_scene": {"count": 2, "colors": ["#e03131", "#1971c2"], "same_input_id": "repeated-id"},
    }
    (root / "fixture.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"fixture": str(root.resolve()), "marker": manifest["recovery_marker"], "status": "generated-only"}))


def manifest(root: Path) -> dict:
    data = json.loads((root / "fixture.json").read_text())
    if not isinstance(data, dict) or data.get("fixture") != "desktop-owner-controls" or data.get("root") != str(root.resolve()):
        raise ValueError("fixture-identity-invalid")
    for child in (root / "recovery", root / "recovery/note.md"):
        if child.is_symlink() or not child.exists():
            raise ValueError("recovery fixture missing or replaced with a symlink")
    return data


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("generate", "verify", "block-save", "allow-save", "check-scene", "recovery-proof"))
    parser.add_argument("root", type=Path)
    parser.add_argument("--page-reading", type=Path)
    args = parser.parse_args()
    if args.command == "generate":
        generate(args.root)
        return 0
    data = manifest(args.root)
    if args.command == "verify":
        changed = [name for name, expected in data["initial_sha256"].items() if digest(args.root / name) != expected]
        if changed:
            raise ValueError(f"generated input changed: {changed}")
    elif args.command in ("block-save", "allow-save"):
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            raise ValueError("run as the same unprivileged user as the desktop; root bypasses the save barrier")
        (args.root / "recovery").chmod(0o500 if args.command == "block-save" else 0o700)
    elif args.command == "check-scene":
        scene_path = args.root / "duplicate-id.excalidraw"
        scene = json.loads(scene_path.read_text())
        if not isinstance(scene, dict) or not isinstance(scene.get("elements"), list):
            raise ValueError("scene-elements-not-a-list")
        for element in scene["elements"]:
            if not isinstance(element, dict):
                raise ValueError("scene-element-not-an-object")
            if "isDeleted" in element and not isinstance(element["isDeleted"], bool):
                raise ValueError("scene-element-deleted-flag-invalid")
        elements = [e for e in scene["elements"] if not e.get("isDeleted", False)]
        for element in elements:
            if any(not isinstance(element.get(key), str) for key in ("type", "backgroundColor")):
                raise ValueError("scene-element-style-invalid")
            if any(type(element.get(key)) not in (int, float) or not math.isfinite(element[key])
                   for key in ("x", "y", "width", "height")):
                raise ValueError("scene-element-geometry-invalid")
        observed = sorted((e["type"], e["x"], e["y"], e["width"], e["height"], e["backgroundColor"]) for e in elements)
        expected = sorted(("rectangle", 30 + 180 * i, 30, 120, 80, color) for i, color in enumerate(data["duplicate_scene"]["colors"]))
        result = {"count": len(elements), "geometry_and_colors_match": observed == expected,
                  "sha256": digest(scene_path), "claim": "disk-only; requires observed reloads and subsequent save",
                  "status": 0 if observed == expected else 10,
                  "reason": "scene-geometry-and-colors-match" if observed == expected else "scene-geometry-or-colors-mismatch"}
        print(json.dumps(result))
        return result["status"]
    elif args.command == "recovery-proof":
        if args.page_reading is None:
            raise ValueError("--page-reading is required")
        page = json.loads(args.page_reading.read_text())
        if not isinstance(page, dict):
            raise ValueError("recovery-page-not-an-object")
        if (not isinstance(page.get("marker"), str) or not isinstance(page.get("stored"), bool)
                or not isinstance(page.get("origin"), str)):
            raise ValueError("recovery-page-fields-invalid")
        marker = data["recovery_marker"]
        on_disk = marker in (args.root / "recovery/note.md").read_text()
        proved = (page.get("marker") == marker and page.get("stored") is True and not on_disk
                  and isinstance(page.get("origin"), str) and page["origin"].startswith("http://127.0.0.1:"))
        print(json.dumps({"actual_recovery_entry": proved, "marker_on_disk": on_disk, "origin": page.get("origin"),
                          "status": 0 if proved else 3,
                          "reason": "recovery-entry-proved" if proved else "recovery-entry-not-proved"}))
        return 0 if proved else 3
    print(json.dumps({"command": args.command, "status": "ok"}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({"status": 3, "reason": str(error), "outcome": "inconclusive"}))
        print(f"owner fixture: {error}", file=sys.stderr)
        sys.exit(3)
