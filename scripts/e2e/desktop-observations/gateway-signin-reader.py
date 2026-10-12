#!/usr/bin/env python3
"""Classify a native gateway card beside its authoritative launcher row."""

import argparse
import copy
import json
from pathlib import Path
from typing import Any


def classify(sample: dict[str, Any]) -> str:
    """Reject missing evidence; identify the pending wait's actual control."""
    row, card = sample["row"], sample["card"]
    if not isinstance(row, dict) or not isinstance(card, dict):
        raise ValueError("missing row or card")
    if card.get("count") != 1 or card.get("control_count") != 1:
        raise ValueError("expected exactly one card and one connection control")
    status, pending = row.get("status"), row.get("pending_signin")
    control = card.get("control")
    if status not in {"disconnected", "connecting", "connected", "unreachable"}:
        raise ValueError("unknown gateway status")
    if type(pending) is not bool or not isinstance(control, dict):
        raise ValueError("malformed pending state or control")
    if type(control.get("disabled")) is not bool:
        raise ValueError("malformed disabled value")
    if not all(isinstance(control.get(field), str) for field in ("title", "aria_label")):
        raise ValueError("missing control names")
    if status == "connecting" and pending:
        if control["disabled"] and control["title"].startswith("Working"):
            return "disabled-wait"
        if not control["disabled"] and "cancel" in control["aria_label"].lower():
            return "live-cancel"
    if status == "disconnected" and not pending:
        if control["title"] == "Connect" and not control["disabled"]:
            return "disconnected"
    return "other-or-transition"


def preflight(output: Path) -> None:
    """Keep the named constructed cases and their independently expected results."""
    base = {
        "row": {"status": "disconnected", "pending_signin": False},
        "card": {"count": 1, "control_count": 1, "control": {
            "title": "Connect", "aria_label": "Connect gateway Fixture", "disabled": False,
        }},
    }
    cases = [("disconnected", copy.deepcopy(base), "disconnected")]
    waiting = copy.deepcopy(base)
    waiting["row"] = {"status": "connecting", "pending_signin": True}
    waiting["card"]["control"] = {
        "title": "Working\u2026", "aria_label": "Working on Fixture", "disabled": True,
    }
    cases.append(("disabled-connecting", waiting, "disabled-wait"))
    cancel = copy.deepcopy(waiting)
    cancel["card"]["control"] = {
        "title": "Cancel", "aria_label": "Cancel connection to Fixture", "disabled": False,
    }
    cases.append(("live-cancel", cancel, "live-cancel"))
    missing = copy.deepcopy(base)
    missing["card"] = None
    cases.append(("missing-card", missing, "refused"))
    malformed = copy.deepcopy(base)
    malformed["card"]["control"]["disabled"] = "false"
    cases.append(("malformed", malformed, "refused"))
    results = []
    for name, sample, expected in cases:
        try:
            actual = classify(sample)
        except (ValueError, KeyError, TypeError):
            actual = "refused"
        results.append({"name": name, "sample": sample, "expected": expected, "actual": actual})
    output.write_text(json.dumps(results, indent=2) + "\n")
    if any(case["actual"] != case["expected"] for case in results):
        raise SystemExit("reader preflight failed")
    print("PASS: disconnected, disabled-connecting, live-cancel, missing-card, malformed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", type=Path, required=True)
    preflight(parser.parse_args().preflight)
