#!/usr/bin/env python3
"""Read native screen crops against a visible frame and an empty-screen control.

Exit 0 for presented, 10 for blank, 3 for an unusable instrument. ImageMagick
does the PNG decoding; this process receives only raw RGB bytes, never a
WebKit snapshot or a CDP screenshot.
"""

import argparse
import json
from pathlib import Path
import subprocess
import sys


def rgb(path: Path) -> tuple[int, int, bytes]:
    dims = subprocess.run(
        ["convert", str(path), "-format", "%w %h", "info:"],
        capture_output=True, text=True, check=True, timeout=20,
    )
    width, height = (int(part) for part in dims.stdout.split())
    if width < 40 or height < 20 or width * height > 2_000_000:
        raise ValueError(f"invalid crop size: {width}x{height}")
    raw = subprocess.run(
        ["convert", str(path), "-alpha", "off", "-colorspace", "sRGB", "-depth", "8", "rgb:-"],
        capture_output=True, check=True, timeout=20,
    ).stdout
    if len(raw) != width * height * 3:
        raise ValueError(f"invalid RGB length: {len(raw)} for {width}x{height}")
    return width, height, raw


def read(baseline: Path, blank: Path, candidate: Path) -> dict:
    b = rgb(baseline)
    e = rgb(blank)
    c = rgb(candidate)
    if b[:2] != e[:2] or b[:2] != c[:2]:
        raise ValueError("crop dimensions differ")
    distinct = matched = total_distance = 0
    for offset in range(0, len(b[2]), 3):
        difference = sum(abs(b[2][offset + channel] - e[2][offset + channel]) for channel in range(3))
        if difference < 90:
            continue
        distinct += 1
        current = sum(abs(b[2][offset + channel] - c[2][offset + channel]) for channel in range(3))
        total_distance += current
        if current <= min(45, difference // 3):
            matched += 1
    pixels = b[0] * b[1]
    enough = distinct >= max(500, pixels // 20)
    fraction = matched / distinct if distinct else 0.0
    status = 3 if not enough else (0 if fraction >= 0.70 else 10)
    return {
        "width": b[0], "height": b[1], "pixels": pixels,
        "distinct_from_blank": distinct, "matched_content": matched,
        "matched_fraction": round(fraction, 4),
        "mean_distance": round(total_distance / distinct, 2) if distinct else None,
        "minimum_distinct": max(500, pixels // 20), "minimum_match_fraction": 0.70,
        "status": status, "outcome": {0: "presented", 10: "blank", 3: "inconclusive"}[status],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--blank", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = read(args.baseline, args.blank, args.candidate)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        result = {"status": 3, "outcome": "inconclusive", "reason": str(error)}
    args.output.write_text(json.dumps(result, sort_keys=True) + "\n")
    print(json.dumps(result, sort_keys=True))
    return result["status"]


if __name__ == "__main__":
    sys.exit(main())
