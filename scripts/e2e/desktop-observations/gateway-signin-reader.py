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


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def cancelled(before: dict[str, Any], after: dict[str, Any], *, keyboard: bool = False) -> None:
    """Read a completed cancel, including the request and notice witnesses."""
    require(classify(before) == "live-cancel", "cancel needs a live pending control")
    require(classify(after) == "disconnected", "cancel did not restore Connect")
    require(after["row"]["enabled"] is False, "cancel did not disable reconnect")
    require(after["row"]["last_error"] is None, "cancel left a row error")
    require(after["card"]["notices"] == before["card"]["notices"], "cancel changed notices")
    require(after["opens"] == before["opens"], "cancel opened another browser")
    require(after["card"]["connect_requests"] == before["card"]["connect_requests"], "cancel sent Connect")
    require(after["card"]["disconnect_requests"] == before["card"]["disconnect_requests"] + 1,
            "cancel did not send exactly one Disconnect")
    require(after["card"]["control"]["same_element"] is True, "cancel replaced the control")
    if keyboard:
        require(before["card"]["control"]["focused"] is True, "keyboard cancel began unfocused")
        require(after["card"]["control"]["focused"] is True, "keyboard cancel lost focus")


def preserved(before: dict[str, Any], after: dict[str, Any]) -> None:
    """A rejected predecessor callback must leave the successor waiting."""
    require(classify(before) == classify(after) == "live-cancel", "stale callback settled the successor")
    require(after["row"] == before["row"], "stale callback changed the successor row")
    for field in ("notices", "connect_requests", "disconnect_requests"):
        require(after["card"][field] == before["card"][field], "stale callback changed " + field)
    require(after["opens"] == before["opens"], "stale callback opened another browser")


def double_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]],
                    before: dict[str, Any], after: dict[str, Any]) -> str:
    """A real second click on Cancel must leave the first click's connect alive."""
    clicks = [event for event in events if event["type"] == "click"]
    require(len(clicks) == 2 and all(event["trusted"] is True for event in clicks),
            "double click needs two trusted click events")
    require([event["detail"] for event in clicks] == [1, 2], "engine did not deliver a double click")
    require([event["title"] for event in clicks] == ["Connect", "Cancel connection"], "double click did not reach Cancel")
    require(any(event["type"] == "dblclick" and event["trusted"] is True for event in events),
            "engine did not deliver dblclick")
    actions = [request["action"] for request in requests]
    require(actions == ["connect"], "double click did not send exactly one Connect")
    require(classify(before) == "disconnected" and classify(after) == "live-cancel", "double click did not leave a live cancel")
    require(after["row"]["enabled"] is True and after["row"]["last_error"] is None, "double click changed intent or left an error")
    require(after["opens"] == before["opens"] + 1, "double click needs one fresh hand-off")
    require(after["card"]["connect_requests"] == before["card"]["connect_requests"] + 1, "double click needs one Connect")
    require(after["card"]["disconnect_requests"] == before["card"]["disconnect_requests"], "double click sent Disconnect")
    require(after["card"]["notices"] == before["card"]["notices"], "double click changed notices")
    require(after["card"]["control"]["same_element"] is True, "double click replaced the control")
    return "one Connect; second click ignored"


def pointer_cancel_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]]) -> None:
    clicks = [event for event in events if event["type"] == "click"]
    require(len(clicks) == 1 and clicks[0]["trusted"] is True and clicks[0]["detail"] == 1,
            "pointer cancel needs one trusted single click")
    require(clicks[0]["title"] == "Cancel connection", "pointer click missed Cancel")
    require([request["action"] for request in requests] == ["disconnect"], "pointer cancel needs one Disconnect")


def keyboard_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]]) -> None:
    presses = [event for event in events if event["type"] == "keydown" and event.get("key") == "Enter"]
    require(len(presses) == 2 and all(event["trusted"] is True for event in presses), "keyboard needs two trusted Enter presses")
    clicks = [event for event in events if event["type"] == "click"]
    require(len(clicks) == 2 and all(event["trusted"] is True and event["detail"] == 0 for event in clicks),
            "keyboard needs two trusted keyboard clicks")
    require([event["title"] for event in clicks] == ["Connect", "Cancel connection"], "keyboard activated the wrong controls")
    require([request["action"] for request in requests] == ["connect", "disconnect"], "keyboard did not connect then cancel")


def pointer_offset(window: dict[str, int], page: dict[str, int], moves: list[dict[str, Any]]) -> dict[str, int]:
    """Infer a translation from two trusted pointer positions, never decoration guesses."""
    require(len(moves) == 2 and all(move["trusted"] is True for move in moves), "pointer calibration needs two trusted moves")
    offsets = [{axis: move[axis] - move["client_" + axis] for axis in ("x", "y")} for move in moves]
    require(offsets[0] == offsets[1], "pointer mapping is not a consistent translation")
    require(moves[0]["x"] != moves[1]["x"] and moves[0]["y"] != moves[1]["y"], "pointer calibration points must differ")
    for axis, dimension in (("x", "width"), ("y", "height")):
        require(0 <= offsets[0][axis] <= window[dimension] - page[dimension], "pointer translation does not fit the native client")
    return offsets[0]


def pointer_hit(hit: dict[str, Any], point: dict[str, float]) -> None:
    require(hit.get("target") == "gateway-pointer-probe" and hit.get("trusted") is True,
            "calibrated pointer missed the known target")
    require(all(abs(hit["client_" + axis] - point[axis]) <= 1 for axis in ("x", "y")),
            "calibrated pointer reached the wrong page coordinate")


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
    cancel["row"].update(enabled=True, last_error=None)
    cancel["opens"] = 1
    cancel["card"].update(notices=[], connect_requests=1, disconnect_requests=0)
    cancel["card"]["control"].update(focused=True, same_element=True)
    ended = copy.deepcopy(cancel)
    ended["row"].update(status="disconnected", pending_signin=False, enabled=False)
    ended["card"]["control"].update(title="Connect", aria_label="Connect gateway Fixture")
    ended["card"]["disconnect_requests"] = 1
    def check(name: str, function: Any, expected: str) -> None:
        try:
            function()
            actual = "accepted"
        except (ValueError, KeyError, TypeError):
            actual = "refused"
        results.append({"name": name, "expected": expected, "actual": actual})
    check("cancel-positive", lambda: cancelled(cancel, ended, keyboard=True), "accepted")
    for field, value in (("enabled", True), ("last_error", "error"), ("status", "connecting")):
        bad = copy.deepcopy(ended)
        bad["row"][field] = value
        check("cancel-row-" + field, lambda: cancelled(cancel, bad), "refused")
    for field, value in (("notices", [{"title": "Error"}]), ("connect_requests", 2), ("disconnect_requests", 0)):
        bad = copy.deepcopy(ended)
        bad["card"][field] = value
        check("cancel-" + field, lambda: cancelled(cancel, bad), "refused")
    for field in ("focused", "same_element"):
        bad = copy.deepcopy(ended)
        bad["card"]["control"][field] = False
        check("cancel-" + field, lambda: cancelled(cancel, bad, keyboard=True), "refused")
    bad = copy.deepcopy(ended)
    bad["opens"] = 2
    check("cancel-extra-open", lambda: cancelled(cancel, bad), "refused")
    check("successor-positive", lambda: preserved(cancel, cancel), "accepted")
    check("successor-settled", lambda: preserved(cancel, ended), "refused")
    bad = copy.deepcopy(cancel)
    bad["card"]["notices"] = [{"title": "Error"}]
    check("successor-notice", lambda: preserved(cancel, bad), "refused")
    events = [{"type": kind, "trusted": True, "detail": detail, "title": title}
              for kind, detail, title in (("click", 1, "Connect"), ("click", 2, "Cancel connection"), ("dblclick", 2, "Cancel connection"))]
    requests = [{"action": "connect"}, {"action": "disconnect"}]
    start = copy.deepcopy(ended)
    start["opens"] = 0
    start["card"].update(connect_requests=0, disconnect_requests=0)
    def double(es: list[dict[str, Any]] = events, rs: list[dict[str, Any]] = requests[:1],
               after: dict[str, Any] = cancel) -> str:
        return double_delivery(es, rs, start, after)
    check("double-one-connect", double, "accepted")
    check("double-cancel", lambda: double(rs=requests), "refused")
    check("double-connect", lambda: double(rs=[{"action": "connect"}] * 2), "refused")
    check("single-click", lambda: double(es=events[:1]), "refused")
    check("no-dblclick", lambda: double(es=events[:2]), "refused")
    untrusted = copy.deepcopy(events)
    untrusted[1]["trusted"] = False
    check("untrusted-click", lambda: double(es=untrusted), "refused")
    check("missing-request", lambda: double(rs=[]), "refused")
    for field, value in (("detail", 1), ("title", "Connect")):
        bad_events = copy.deepcopy(events)
        bad_events[1][field] = value
        check("double-wrong-" + field, lambda: double(es=bad_events), "refused")
    for field, value in (("enabled", False), ("last_error", "error"), ("status", "disconnected")):
        bad = copy.deepcopy(cancel)
        bad["row"][field] = value
        check("double-row-" + field, lambda: double(after=bad), "refused")
    for field, value in (("connect_requests", 2), ("disconnect_requests", 1), ("notices", [{"title": "Error"}])):
        bad = copy.deepcopy(cancel)
        bad["card"][field] = value
        check("double-" + field, lambda: double(after=bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["opens"] = 0
    check("double-no-handoff", lambda: double(after=bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["card"]["control"]["same_element"] = False
    check("double-replaced-control", lambda: double(after=bad), "refused")
    pointer = [{"type": "click", "trusted": True, "detail": 1, "title": "Cancel connection"}]
    check("pointer-cancel", lambda: pointer_cancel_delivery(pointer, requests[1:]), "accepted")
    for field, value in (("trusted", False), ("detail", 2), ("title", "Connect")):
        bad_pointer = [{**pointer[0], field: value}]
        check("pointer-cancel-" + field, lambda: pointer_cancel_delivery(bad_pointer, requests[1:]), "refused")
    check("pointer-cancel-missing-click", lambda: pointer_cancel_delivery([], requests[1:]), "refused")
    check("pointer-cancel-wrong-request", lambda: pointer_cancel_delivery(pointer, requests[:1]), "refused")
    keys = [{"type": "keydown", "key": "Enter", "trusted": True}] * 2
    keys += [{"type": "click", "trusted": True, "detail": 0, "title": title} for title in ("Connect", "Cancel connection")]
    check("keyboard-positive", lambda: keyboard_delivery(keys, requests), "accepted")
    check("keyboard-no-key", lambda: keyboard_delivery(keys[2:], requests), "refused")
    bad_keys = copy.deepcopy(keys)
    bad_keys[-1]["title"] = "Connect"
    check("keyboard-wrong-control", lambda: keyboard_delivery(bad_keys, requests), "refused")
    bad_keys = copy.deepcopy(keys)
    bad_keys[-1]["detail"] = 1
    check("keyboard-pointer-click", lambda: keyboard_delivery(bad_keys, requests), "refused")
    window, page = {"width": 420, "height": 720}, {"width": 420, "height": 695}
    moves = [{"x": x, "y": y, "client_x": x, "client_y": y - 25, "trusted": True}
             for x, y in ((140, 360), (280, 480))]
    check("pointer-translation", lambda: pointer_offset(window, page, moves), "accepted")
    wrong_moves = copy.deepcopy(moves)
    wrong_moves[1]["client_y"] += 1
    check("pointer-inconsistent", lambda: pointer_offset(window, page, wrong_moves), "refused")
    hit = {"target": "gateway-pointer-probe", "trusted": True, "client_x": 210, "client_y": 347}
    point = {"x": 210, "y": 347}
    check("pointer-hit", lambda: pointer_hit(hit, point), "accepted")
    wrong_hit = {**hit, "client_y": 322}
    check("pointer-wrong-offset", lambda: pointer_hit(wrong_hit, point), "refused")
    check("pointer-wrong-target", lambda: pointer_hit({**hit, "target": "body"}, point), "refused")
    output.write_text(json.dumps(results, indent=2) + "\n")
    if any(case["actual"] != case["expected"] for case in results):
        raise SystemExit("reader preflight failed")
    print("PASS: disconnected, disabled-connecting, live-cancel, missing-card, malformed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", type=Path, required=True)
    preflight(parser.parse_args().preflight)
