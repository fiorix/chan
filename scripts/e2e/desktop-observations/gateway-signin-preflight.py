#!/usr/bin/env python3
"""Exercise gateway verdict statuses and argument handling without a desktop."""

import argparse
import copy
import contextlib
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
from unittest.mock import patch


def preflight(driver: Path, output: Path) -> None:
    namespace = runpy.run_path(str(driver))
    reader = namespace["reader"]
    output.mkdir()
    pending = {
        "row": {"status": "connecting", "pending_signin": True, "enabled": True, "last_error": None},
        "card": {"count": 1, "control_count": 1, "notices": [], "connect_requests": 1,
                 "disconnect_requests": 0, "control": {"title": "Cancel connection",
                 "aria_label": "Cancel connection to Fixture", "disabled": False,
                 "same_element": True, "focused": True}},
        "opens": 1,
    }
    ended = copy.deepcopy(pending)
    ended["row"].update(status="disconnected", pending_signin=False, enabled=False)
    ended["card"]["control"].update(title="Connect", aria_label="Connect gateway Fixture")
    ended["card"]["disconnect_requests"] = 1
    pointer = [{"type": "click", "detail": 1, "trusted": True, "title": "Cancel connection"}]
    double = [{"type": kind, "detail": detail, "trusted": True, "title": title}
              for kind, detail, title in (("click", 1, "Connect"), ("click", 2, "Cancel connection"),
                                          ("dblclick", 2, "Cancel connection"))]
    keys = [{"type": "keydown", "key": "Enter", "trusted": True}] * 2
    keys += [{"type": "click", "detail": 0, "trusted": True, "title": title}
             for title in ("Connect", "Cancel connection")]
    malformed = copy.deepcopy(ended)
    malformed["card"]["control"]["disabled"] = "false"
    bad_row = copy.deepcopy(ended)
    bad_row["row"]["enabled"] = "false"
    bad_events = copy.deepcopy(double)
    bad_events[0]["trusted"] = "true"
    cases = [
        ("cancel-fault", lambda: reader["cancelled"](pending, pending), "CancelFault", 10),
        ("double-fault", lambda: reader["double_delivery"](double, [], ended, pending), "DoubleDeliveryFault", 10),
        ("keyboard-fault", lambda: reader["keyboard_delivery"](keys, []), "KeyboardDeliveryFault", 10),
        ("successor-fault", lambda: reader["preserved"](pending, ended), "PreservedFault", 10),
        ("post-double-fault", lambda: reader["post_double_cancel"](pointer, [], pending, pending), "PostDoubleFault", 10),
        ("missing-evidence", lambda: reader["cancelled"](pending, {}), "KeyError", 3),
        ("malformed-evidence", lambda: reader["cancelled"](pending, malformed), "ValueError", 3),
        ("malformed-row", lambda: reader["cancelled"](pending, bad_row), "ValueError", 3),
        ("malformed-events", lambda: reader["double_delivery"](bad_events, [], ended, pending), "ValueError", 3),
        ("post-double-malformed", lambda: reader["post_double_cancel"](pointer, [], pending, malformed), "ValueError", 3),
        ("no-input", lambda: reader["post_double_cancel"]([], [], pending, pending), "NoClickDelivered", 2),
    ]
    results = []
    for name, trigger, expected_class, expected_status in cases:
        work = output / name
        work.mkdir()
        try:
            trigger()
        except (ValueError, KeyError, TypeError) as error:
            fault = error
        else:
            raise AssertionError(f"{name}: constructed trigger did not raise")
        with patch.object(namespace["Fixture"], "observe", side_effect=fault):
            status = namespace["run"]("unused", work, cancel=True)
        summary = json.loads((work / "summary.json").read_text())
        expected_outcome = {10: "fault-observed", 3: "inconclusive", 2: "environment-unavailable"}[expected_status]
        results.append({"name": name, "expected_class": expected_class, "actual_class": type(fault).__name__,
                        "expected_status": expected_status, "actual_status": status,
                        "expected_outcome": expected_outcome, "actual_outcome": summary["outcome"]})

    for name, outcome, counts in (("completed-cancel", "cancel-double-held", None),
                                  ("recorded-hold", "observation-recorded", {"keydowns": 4, "repeats": 3,
                                   "clicks": 4, "click_counts": [0, 0, 0, 0], "connect_requests": 2,
                                   "disconnect_requests": 2, "handoffs_before_release": 2})):
        work = output / name
        work.mkdir()
        result = {"outcome": outcome, **({"counts": counts} if counts is not None else {})}
        stdout = io.StringIO()
        with patch.object(namespace["Fixture"], "observe", return_value=result), contextlib.redirect_stdout(stdout):
            status = namespace["run"]("unused", work, cancel=True)
        printed = json.loads(stdout.getvalue())
        results.append({"name": name, "expected_status": 0, "actual_status": status,
                        "expected_outcome": outcome, "actual_outcome": printed["outcome"],
                        "expected_counts": counts, "actual_counts": printed.get("counts")})

    # A nonexistent binary makes a misplaced validation fail before any desktop can start.
    env = {**os.environ, "CHAN_BIN": str(output / "absent-chan"),
           "CHAN_DESKTOP_BIN": str(output / "absent-desktop")}
    for name, arguments in (("controls-without-cancel", ["--controls-only"]),
                            ("unknown-option", ["--not-a-gateway-option"]),
                            ("gesture-without-cancel", ["--gesture", "held-enter"]),
                            ("gesture-with-controls", ["--cancel", "--controls-only", "--gesture", "cancel-double"])):
        result = subprocess.run(["bash", str(driver.with_suffix(".sh")), *arguments],
                                env=env, capture_output=True, text=True, timeout=15, check=False)
        (output / (name + ".log")).write_text(result.stdout + result.stderr)
        results.append({"name": name, "expected_status": 3, "actual_status": result.returncode,
                        "expected_usage": True, "actual_usage": "invalid gateway sign-in arguments" in result.stderr,
                        "expected_setup": False, "actual_setup": "work dir /" in result.stderr or "preflight failed" in result.stderr})
    (output / "results.json").write_text(json.dumps(results, indent=2) + "\n")
    failed = [row["name"] for row in results
              if any(value != row["actual_" + key.removeprefix("expected_")]
                     for key, value in row.items() if key.startswith("expected_"))]
    for row in results:
        print(json.dumps(row))
    if failed:
        raise SystemExit("gateway status preflight failed: " + ", ".join(failed))
    print(f"PASS: {len(results)} gateway status and usage cases")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--driver", type=Path, default=Path(__file__).with_name("gateway-signin.py"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    preflight(args.driver.resolve(), args.output.resolve())
