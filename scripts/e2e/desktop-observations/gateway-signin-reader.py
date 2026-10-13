#!/usr/bin/env python3
"""Classify a native gateway card beside its authoritative launcher row."""

import argparse
import copy
import json
from pathlib import Path
import re
from typing import Any


class NoClickDelivered(ValueError):
    """A pointer command has no page click witness."""


class ContractFault(ValueError):
    """Well-formed evidence violates a gateway control contract."""

    @classmethod
    def require(cls, condition: bool, message: str) -> None:
        if not condition:
            raise cls(message)


class CancelFault(ContractFault):
    """A cancellation violates its row, request or control contract."""


class DoubleDeliveryFault(ContractFault):
    """A witnessed double click violates the one-connect contract."""


class KeyboardDeliveryFault(ContractFault):
    """Two Enter activations do not connect then cancel."""


class PreservedFault(ContractFault):
    """A stale callback changes the successor's pending attempt."""


class PostDoubleFault(ContractFault):
    """A witnessed post-double click violates its count's cancel rule."""


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


def validate_sample(sample: dict[str, Any]) -> None:
    """Validate evidence before applying a product contract to its values."""
    classify(sample)
    row, card = sample["row"], sample["card"]
    require(type(row["enabled"]) is bool, "malformed enabled value")
    require(row["last_error"] is None or isinstance(row["last_error"], str), "malformed row error")
    require(isinstance(card["notices"], list) and all(isinstance(n, dict) for n in card["notices"]),
            "malformed notices")
    for field in ("count", "control_count", "connect_requests", "disconnect_requests"):
        require(type(card[field]) is int and card[field] >= 0, "malformed " + field)
    for field in ("same_element", "focused"):
        require(type(card["control"][field]) is bool, "malformed control " + field)
    require(type(sample["opens"]) is int and sample["opens"] >= 0, "malformed opener count")


def validate_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]]) -> None:
    require(isinstance(events, list) and isinstance(requests, list), "malformed event or request list")
    for event in events:
        require(isinstance(event, dict) and isinstance(event["type"], str), "malformed event")
        require(type(event["trusted"]) is bool, "malformed event trust")
        if event["type"] in {"click", "dblclick"}:
            require(type(event["detail"]) is int and isinstance(event["title"], str), "malformed click")
        elif event["type"] in {"keydown", "keyup"}:
            require(isinstance(event["key"], str), "malformed key")
    for request in requests:
        require(isinstance(request, dict) and isinstance(request["action"], str), "malformed request")


def cancelled(before: dict[str, Any], after: dict[str, Any], *, keyboard: bool = False) -> None:
    """Read a completed cancel, including the request and notice witnesses."""
    validate_sample(before)
    validate_sample(after)
    CancelFault.require(classify(before) == "live-cancel", "cancel needs a live pending control")
    CancelFault.require(classify(after) == "disconnected", "cancel did not restore Connect")
    CancelFault.require(after["row"]["enabled"] is False, "cancel did not disable reconnect")
    CancelFault.require(after["row"]["last_error"] is None, "cancel left a row error")
    CancelFault.require(after["card"]["notices"] == before["card"]["notices"], "cancel changed notices")
    CancelFault.require(after["opens"] == before["opens"], "cancel opened another browser")
    CancelFault.require(after["card"]["connect_requests"] == before["card"]["connect_requests"], "cancel sent Connect")
    CancelFault.require(after["card"]["disconnect_requests"] == before["card"]["disconnect_requests"] + 1,
            "cancel did not send exactly one Disconnect")
    CancelFault.require(after["card"]["control"]["same_element"] is True, "cancel replaced the control")
    if keyboard:
        CancelFault.require(before["card"]["control"]["focused"] is True, "keyboard cancel began unfocused")
        CancelFault.require(after["card"]["control"]["focused"] is True, "keyboard cancel lost focus")


def preserved(before: dict[str, Any], after: dict[str, Any]) -> None:
    """A rejected predecessor callback must leave the successor waiting."""
    validate_sample(before)
    validate_sample(after)
    PreservedFault.require(classify(before) == classify(after) == "live-cancel", "stale callback settled the successor")
    PreservedFault.require(after["row"] == before["row"], "stale callback changed the successor row")
    for field in ("notices", "connect_requests", "disconnect_requests"):
        PreservedFault.require(after["card"][field] == before["card"][field], "stale callback changed " + field)
    PreservedFault.require(after["opens"] == before["opens"], "stale callback opened another browser")


def double_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]],
                    before: dict[str, Any], after: dict[str, Any]) -> str:
    """Either second-click delivery must leave exactly one live connect."""
    validate_sample(before)
    validate_sample(after)
    validate_delivery(events, requests)
    clicks = [event for event in events if event["type"] == "click"]
    DoubleDeliveryFault.require(len(clicks) == 2 and all(event["trusted"] is True for event in clicks),
            "double click needs two trusted click events")
    DoubleDeliveryFault.require([event["detail"] for event in clicks] == [1, 2], "engine did not deliver a double click")
    DoubleDeliveryFault.require(clicks[0]["title"] == "Connect" and clicks[1]["title"] in {"Connect", "Cancel connection"},
            "double click reached an unexpected control")
    DoubleDeliveryFault.require(any(event["type"] == "dblclick" and event["trusted"] is True for event in events),
            "engine did not deliver dblclick")
    actions = [request["action"] for request in requests]
    DoubleDeliveryFault.require(actions == ["connect"], "double click did not send exactly one Connect")
    DoubleDeliveryFault.require(classify(before) == "disconnected" and classify(after) == "live-cancel", "double click did not leave a live cancel")
    DoubleDeliveryFault.require(after["row"]["enabled"] is True and after["row"]["last_error"] is None, "double click changed intent or left an error")
    DoubleDeliveryFault.require(after["opens"] == before["opens"] + 1, "double click needs one fresh hand-off")
    DoubleDeliveryFault.require(after["card"]["connect_requests"] == before["card"]["connect_requests"] + 1, "double click needs one Connect")
    DoubleDeliveryFault.require(after["card"]["disconnect_requests"] == before["card"]["disconnect_requests"], "double click sent Disconnect")
    DoubleDeliveryFault.require(after["card"]["notices"] == before["card"]["notices"], "double click changed notices")
    DoubleDeliveryFault.require(after["card"]["control"]["same_element"] is True, "double click replaced the control")
    return f"one Connect; second click on {clicks[1]['title']} ignored"


def pointer_cancel_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]]) -> None:
    clicks = [event for event in events if event["type"] == "click"]
    require(len(clicks) == 1 and clicks[0]["trusted"] is True and clicks[0]["detail"] == 1,
            "pointer cancel needs one trusted single click")
    require(clicks[0]["title"] == "Cancel connection", "pointer click missed Cancel")
    require([request["action"] for request in requests] == ["disconnect"], "pointer cancel needs one Disconnect")


def post_double_cancel(events: list[dict[str, Any]], requests: list[dict[str, Any]],
                       before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Judge the immediate click by its delivered count, not the input command."""
    validate_sample(before)
    validate_sample(after)
    validate_delivery(events, requests)
    clicks = [event for event in events if event["type"] == "click"]
    if not clicks:
        raise NoClickDelivered("post-double click refused: no click event delivered")
    require(len(clicks) == 1 and clicks[0]["trusted"] is True, "post-double reading needs one trusted click")
    click = clicks[0]
    require(click["title"] == "Cancel connection", "post-double click missed Cancel")
    detail = click["detail"]
    require(type(detail) is int and detail >= 1, "post-double pointer click has no positive integer count")
    try:
        if detail == 1:
            cancelled(before, after)
            pointer_cancel_delivery(events, requests)
        else:
            require(classify(before) == classify(after) == "live-cancel", "multi-click settled the pending row")
            require(after["row"] == before["row"], "multi-click changed the pending row")
            require(not requests, "multi-click sent a request")
            for field in ("notices", "connect_requests", "disconnect_requests"):
                require(after["card"][field] == before["card"][field], "multi-click changed " + field)
            require(after["opens"] == before["opens"], "multi-click opened another browser")
            require(after["card"]["control"]["same_element"] is True, "multi-click replaced the control")
    except ValueError as error:
        raise PostDoubleFault(f"post-double detail {detail}: {error}") from error
    return {"detail": detail, "outcome": "cancelled" if detail == 1 else "ignored"}


def keyboard_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]]) -> None:
    validate_delivery(events, requests)
    presses = [event for event in events if event["type"] == "keydown" and event.get("key") == "Enter"]
    KeyboardDeliveryFault.require(len(presses) == 2 and all(event["trusted"] is True for event in presses), "keyboard needs two trusted Enter presses")
    clicks = [event for event in events if event["type"] == "click"]
    KeyboardDeliveryFault.require(len(clicks) == 2 and all(event["trusted"] is True and event["detail"] == 0 for event in clicks),
            "keyboard needs two trusted keyboard clicks")
    KeyboardDeliveryFault.require([event["title"] for event in clicks] == ["Connect", "Cancel connection"], "keyboard activated the wrong controls")
    KeyboardDeliveryFault.require([request["action"] for request in requests] == ["connect", "disconnect"], "keyboard did not connect then cancel")


def cancel_double_delivery(events: list[dict[str, Any]], requests: list[dict[str, Any]],
                           before: dict[str, Any], after: dict[str, Any]) -> str:
    """Read a double click beginning on Cancel across either row delivery."""
    validate_delivery(events, requests)
    clicks = [event for event in events if event["type"] == "click"]
    require(len(clicks) == 2 and all(event["trusted"] is True for event in clicks),
            "cancel double needs two trusted clicks")
    require([event["detail"] for event in clicks] == [1, 2], "cancel double needs counts 1 and 2")
    require(clicks[0]["title"] == "Cancel connection" and clicks[1]["title"] in {"Cancel connection", "Connect"},
            "cancel double reached an unexpected control")
    require(any(event["type"] == "dblclick" and event["trusted"] is True for event in events),
            "cancel double needs a trusted dblclick")
    cancelled(before, after)
    CancelFault.require([request["action"] for request in requests] == ["disconnect"],
                        "cancel double did not send exactly one Disconnect")
    return "second click on " + clicks[1]["title"]


def repeat_setting(text: str) -> dict[str, int]:
    """Read the X server's current repeat configuration without changing it."""
    enabled = re.findall(r"auto repeat:\s*(\w+)", text)
    values = re.findall(r"auto repeat delay:\s*(\d+)\s+repeat rate:\s*(\d+)", text)
    require(enabled == ["on"] and len(values) == 1, "X repeat setting is absent or disabled")
    delay, rate = map(int, values[0])
    require(0 < delay < 2000 and rate > 0, "X repeat setting cannot support the two-second hold")
    return {"delay_ms": delay, "rate_hz": rate}


def held_enter(trace: dict[str, Any], release: dict[str, int], captures: list[int]) -> dict[str, Any]:
    """Summarize a complete held-key observation without an action-count rule."""
    events, requests = trace["events"], trace["requests"]
    validate_delivery(events, requests)
    keys = [event for event in events if event["type"] in {"keydown", "keyup"} and event["key"] == "Enter"]
    downs = [event for event in keys if event["type"] == "keydown"]
    ups = [event for event in keys if event["type"] == "keyup"]
    require(len(downs) >= 2 and len(ups) == 1 and keys[-1]["type"] == "keyup",
            "held Enter needs repeated keydowns and one final keyup")
    require(all(event["trusted"] is True and event["focused"] is True for event in keys),
            "held Enter lost trusted focused key delivery")
    require(downs[0]["repeat"] is False and all(event["repeat"] is True for event in downs[1:]),
            "held Enter has no proved repeat sequence")
    clicks = [event for event in events if event["type"] == "click"]
    require(all(event["trusted"] is True and event["focused"] is True for event in clicks),
            "held Enter click delivery is not trusted and focused")
    require(all(type(event["page_ms"]) in (int, float) for event in events)
            and all(a["page_ms"] <= b["page_ms"] for a, b in zip(events, events[1:])),
            "held Enter event clock is malformed or unordered")
    require(len(trace["responses"]) == len(requests)
            and sorted(response["sequence"] for response in trace["responses"]) == sorted(request["sequence"] for request in requests)
            and all(type(response["status"]) is int and 100 <= response["status"] < 600 for response in trace["responses"]),
            "held Enter request receipt is incomplete")
    require(bool(trace["states"]) and bool(trace["rows"]), "held Enter has no state observations")
    require(type(release["start_ns"]) is int and type(release["end_ns"]) is int
            and release["start_ns"] <= release["end_ns"] and all(type(stamp) is int for stamp in captures),
            "held Enter release or opener clock is malformed")
    return {"keydowns": len(downs), "repeats": len(downs) - 1, "clicks": len(clicks),
            "click_counts": [event["detail"] for event in clicks],
            "connect_requests": sum(request["action"] == "connect" for request in requests),
            "disconnect_requests": sum(request["action"] == "disconnect" for request in requests),
            "handoffs_before_release": sum(stamp < release["start_ns"] for stamp in captures),
            "handoffs_by_release_end": sum(stamp <= release["end_ns"] for stamp in captures),
            "handoffs_in_release_bracket": sum(release["start_ns"] <= stamp <= release["end_ns"] for stamp in captures),
            "handoffs_total": len(captures)}


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
    def check(name: str, function: Any, expected: str, *, fault: type[Exception] | None = None) -> None:
        try:
            function()
            actual = "accepted"
        except (ValueError, KeyError, TypeError, IndexError) as error:
            actual = "refused" if fault is None or type(error) is fault else "unexpected-" + type(error).__name__
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
    bad["row"]["last_error"] = "error"
    check("successor-row-error", lambda: preserved(cancel, bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["card"]["control"].update(title="Connect", aria_label="Connect gateway Fixture")
    check("successor-control-changed", lambda: preserved(cancel, bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["opens"] = 2
    check("successor-extra-open", lambda: preserved(cancel, bad), "refused")
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
    before_update = copy.deepcopy(events)
    for event in before_update[1:]:
        event["title"] = "Connect"
    check("double-before-row-update", lambda: double(es=before_update), "accepted")
    check("double-before-row-update-two-requests", lambda: double(es=before_update, rs=[{"action": "connect"}] * 2), "refused")
    check("double-cancel", lambda: double(rs=requests), "refused")
    check("double-connect", lambda: double(rs=[{"action": "connect"}] * 2), "refused")
    check("single-click", lambda: double(es=events[:1]), "refused")
    check("no-dblclick", lambda: double(es=events[:2]), "refused")
    untrusted = copy.deepcopy(events)
    untrusted[1]["trusted"] = False
    check("untrusted-click", lambda: double(es=untrusted), "refused")
    check("missing-request", lambda: double(rs=[]), "refused")
    for field, value in (("detail", 1), ("title", "Disconnect")):
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
    triple = [{**pointer[0], "detail": 3}]
    for name, es, rs, after, expected in (
        ("post-double-single-cancels", pointer, requests[1:], ended, "accepted"),
        ("post-double-single-stays", pointer, [], cancel, "fault-observed"),
        ("post-double-triple-ignored", triple, [], cancel, "accepted"),
        ("post-double-triple-cancels", triple, requests[1:], ended, "fault-observed"),
        ("post-double-no-event", [], [], cancel, "refused"),
    ):
        try:
            reading = post_double_cancel(es, rs, cancel, after)
            if reading["outcome"] == "ignored":
                # The separated click must deliver detail 1 and complete cancellation.
                pointer_cancel_delivery(pointer, requests[1:])
                cancelled(after, ended)
            actual = "accepted"
        except PostDoubleFault:
            actual = "fault-observed"
        except NoClickDelivered:
            actual = "refused"
        results.append({"name": name, "expected": expected, "actual": actual})
    check("post-double-untrusted", lambda: post_double_cancel([{**pointer[0], "trusted": False}], [], cancel, cancel), "refused")
    check("post-double-wrong-control", lambda: post_double_cancel([{**pointer[0], "title": "Connect"}], [], cancel, cancel), "refused")
    check("post-double-no-count", lambda: post_double_cancel([{**pointer[0], "detail": 0}], [], cancel, cancel), "refused")
    check("post-double-extra-click", lambda: post_double_cancel(pointer * 2, [], cancel, cancel), "refused")
    check("post-double-triple-untrusted", lambda: post_double_cancel([{**triple[0], "trusted": False}], [], cancel, cancel), "refused")
    check("post-double-triple-extra-click", lambda: post_double_cancel(triple * 2, [], cancel, cancel), "refused")
    check("post-double-triple-wrong-control", lambda: post_double_cancel([{**triple[0], "title": "Connect"}], [], cancel, cancel), "refused")
    bad = copy.deepcopy(cancel)
    bad["card"]["control"].update(title="Connect", aria_label="Connect gateway Fixture")
    check("post-double-ignored-control-changed", lambda: post_double_cancel(triple, [], cancel, bad), "refused")
    check("post-double-ignored-request", lambda: post_double_cancel(triple, requests[1:], cancel, cancel), "refused")
    for field, value in (("notices", [{"title": "Error"}]), ("connect_requests", 2), ("disconnect_requests", 1)):
        bad = copy.deepcopy(cancel)
        bad["card"][field] = value
        check("post-double-ignored-" + field, lambda: post_double_cancel(triple, [], cancel, bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["row"]["enabled"] = False
    check("post-double-ignored-intent", lambda: post_double_cancel(triple, [], cancel, bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["opens"] = 2
    check("post-double-ignored-open", lambda: post_double_cancel(triple, [], cancel, bad), "refused")
    bad = copy.deepcopy(cancel)
    bad["card"]["control"]["same_element"] = False
    check("post-double-ignored-control", lambda: post_double_cancel(triple, [], cancel, bad), "refused")
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
    cancel_double = [{"type": kind, "trusted": True, "detail": detail, "title": title}
                     for kind, detail, title in (("click", 1, "Cancel connection"),
                                                 ("click", 2, "Connect"), ("dblclick", 2, "Connect"))]
    def cancel_twice(es: list[dict[str, Any]] = cancel_double,
                     rs: list[dict[str, Any]] = requests[1:], after: dict[str, Any] = ended) -> str:
        return cancel_double_delivery(es, rs, cancel, after)
    check("cancel-double-updated", cancel_twice, "accepted")
    same_control = [{**event, "title": "Cancel connection"} for event in cancel_double]
    check("cancel-double-pending", lambda: cancel_twice(es=same_control), "accepted")
    check("cancel-double-one-event", lambda: cancel_twice(es=cancel_double[:1]), "refused")
    for field, value in (("trusted", False), ("detail", 3), ("title", "Disconnect")):
        wrong = copy.deepcopy(cancel_double)
        wrong[1][field] = value
        check("cancel-double-" + field, lambda: cancel_twice(es=wrong), "refused")
    check("cancel-double-no-dblclick", lambda: cancel_twice(es=cancel_double[:2]), "refused")
    check("cancel-double-extra-request", lambda: cancel_twice(rs=requests), "refused")
    check("cancel-double-stays", lambda: cancel_twice(after=cancel), "refused")
    repeat_text = "auto repeat: on\nauto repeat delay: 660 repeat rate: 25\n"
    check("repeat-setting", lambda: repeat_setting(repeat_text), "accepted")
    check("repeat-disabled", lambda: repeat_setting(repeat_text.replace("on", "off")), "refused")
    check("repeat-missing", lambda: repeat_setting(""), "refused")
    check("repeat-too-slow", lambda: repeat_setting(repeat_text.replace("660", "2500")), "refused")
    held = {
        "events": [
            {"type": "keydown", "key": "Enter", "repeat": False, "trusted": True, "focused": True, "page_ms": 0},
            {"type": "click", "detail": 0, "title": "Connect", "trusted": True, "focused": True, "page_ms": 1},
            {"type": "keydown", "key": "Enter", "repeat": True, "trusted": True, "focused": True, "page_ms": 660},
            {"type": "click", "detail": 0, "title": "Cancel connection", "trusted": True, "focused": True, "page_ms": 661},
            {"type": "keyup", "key": "Enter", "repeat": False, "trusted": True, "focused": True, "page_ms": 2000},
        ],
        "requests": [{"sequence": i, "action": action} for i, action in enumerate(("connect", "disconnect"))],
        "responses": [{"sequence": i, "status": 204} for i in range(2)],
        "states": [{"title": "Connect"}], "rows": [{"row": start["row"]}],
    }
    release = {"start_ns": 2000, "end_ns": 2100}
    captures = [100, 2050, 2200]
    expected = {"keydowns": 2, "repeats": 1, "clicks": 2, "click_counts": [0, 0],
                "connect_requests": 1, "disconnect_requests": 1, "handoffs_before_release": 1,
                "handoffs_by_release_end": 2, "handoffs_in_release_bracket": 1, "handoffs_total": 3}
    check("held-positive", lambda: require(held_enter(held, release, captures) == expected, "held counts differ"), "accepted")
    for name, index, field, value in (("held-not-repeat", 2, "repeat", False),
                                     ("held-untrusted-key", 0, "trusted", False),
                                     ("held-unfocused-key", 0, "focused", False),
                                     ("held-untrusted-click", 1, "trusted", False),
                                     ("held-unordered", 2, "page_ms", -1)):
        wrong = copy.deepcopy(held)
        wrong["events"][index][field] = value
        check(name, lambda: held_enter(wrong, release, captures), "refused")
    for field, value, name in (("events", held["events"][:-1], "held-no-keyup"),
                               ("responses", [], "held-missing-receipt"),
                               ("responses", [{"sequence": 0, "status": 204}] * 2, "held-wrong-receipt"),
                               ("states", [], "held-no-states"), ("rows", [], "held-no-rows")):
        wrong = {**held, field: value}
        check(name, lambda: held_enter(wrong, release, captures), "refused")
    check("held-bad-release", lambda: held_enter(held, {"start_ns": 2101, "end_ns": 2100}, captures), "refused")
    # No action count is a product expectation for this observation.
    no_actions = {**held, "events": [event for event in held["events"] if event["type"] != "click"],
                  "requests": [], "responses": []}
    check("held-no-actions", lambda: held_enter(no_actions, release, []), "accepted")
    check("sample-shape-positive", lambda: validate_sample(cancel), "accepted")
    for path, value in ((("row", "enabled"), "true"), (("row", "last_error"), []),
                        (("card", "notices"), [None]), (("card", "count"), True),
                        (("card", "control_count"), True), (("card", "connect_requests"), -1),
                        (("card", "disconnect_requests"), "0"),
                        (("card", "control", "focused"), "true"),
                        (("card", "control", "same_element"), 1), (("opens",), "1")):
        wrong = copy.deepcopy(cancel)
        parent = wrong
        for part in path[:-1]:
            parent = parent[part]
        parent[path[-1]] = value
        check("sample-shape-" + "-".join(path), lambda: validate_sample(wrong), "refused", fault=ValueError)
    check("delivery-shape-positive", lambda: validate_delivery(keys, requests), "accepted")
    for name, es, rs in (
        ("list", None, requests), ("event", ["click"], requests),
        ("trust", [{**pointer[0], "trusted": "true"}], requests),
        ("click", [{**pointer[0], "detail": "1"}], requests),
        ("key", [{"type": "keydown", "trusted": True, "key": None}], requests),
        ("request", pointer, [{"action": None}]),
    ):
        check("delivery-shape-" + name, lambda: validate_delivery(es, rs), "refused", fault=ValueError)
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
    print(f"PASS: {len(results)} constructed reader cases")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--preflight", type=Path, required=True)
    preflight(parser.parse_args().preflight)
