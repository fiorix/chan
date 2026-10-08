#!/usr/bin/env python3
"""Private identity checks and narrow restart native observation verdicts.

A delayed restart arm is read in one of two modes. `baseline` asks whether
the restarted devserver's incomplete window set closed the original native
window (status 10) or was survived. `admission` is for a devserver that
withholds its window set while it starts: it asks the baseline's closure
first, then whether a set was published inside the hold all the same
(status 11), then whether the window was retained beside a proved refusal
of the feed and through the desktop's own read of the complete set after
the release (status 0). Status 3 is every narrower or unproved result.
"""

import argparse
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import socket


def read_json(path: Path) -> object:
    return json.loads(path.read_text())


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line]


def write_new(path: Path, value: dict) -> None:
    with path.open("x") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


def windows(path: Path) -> dict[str, str]:
    result = {}
    for line in path.read_text().splitlines():
        x_id, title = line.split(" ", 1)
        if x_id in result:
            raise ValueError("duplicate visible X id")
        result[x_id] = title
    return result


def pin_controls(args: argparse.Namespace) -> int:
    before = windows(args.before_windows)
    launcher = [x_id for x_id, title in before.items() if title == "Chan Desktop"]
    if len(launcher) != 1:
        raise ValueError("no unique Desktop-owned launcher X id")
    after = windows(args.after_windows)
    new_ids = set(after) - set(before)
    if len(new_ids) != 1:
        raise ValueError("connection did not create exactly one terminal X id")
    x_id = next(iter(new_ids))
    rows = read_json(args.records)
    terminal = [
        row for row in rows
        if row.get("kind") == "terminal"
        and row.get("origin", "native") == "native"
        and row.get("persisted") is True
        and row.get("connected") is True
        and not row.get("hidden", False)
        and row.get("token")
        and isinstance(row.get("holders"), list)
        and len(row["holders"]) == 1
    ]
    if len(terminal) != 1:
        raise ValueError("no unique healthy native terminal control record")
    row = terminal[0]
    ordinal = row.get("ordinal")
    if not isinstance(ordinal, int) or f"Terminal Window {ordinal}" not in after[x_id]:
        raise ValueError("terminal X title does not identify its record ordinal")
    if sum(title == after[x_id] for title in after.values()) != 1:
        raise ValueError("terminal X title is not unique")
    write_new(args.output, {
        "terminal_x_id": x_id,
        "terminal_window_id": row["window_id"],
        "terminal_library_id": row["library_id"],
        "launcher_x_id": launcher[0],
    })
    return 0


def pin_row(args: argparse.Namespace) -> int:
    rows = read_json(args.rows)
    selected = [row for row in rows if row.get("path") == args.root]
    if len(selected) != 1:
        raise ValueError("no unique exact-root baseline management row")
    row = selected[0]
    if row.get("status") != "running" or row.get("on") is not True or not row.get("token"):
        raise ValueError("selected management row is not mounted/on")
    write_new(args.output, {"prefix": row["prefix"], "status": "running", "on": True})
    return 0


def check_checkpoint(args: argparse.Namespace) -> int:
    events = read_jsonl(args.checkpoints)
    if not events or events[-1].get("stage") != args.stage:
        raise ValueError("missing named X checkpoint")
    event = events[-1]
    if (not event.get("desktop_alive") or event.get("terminal_x_state") != "shown"
            or event.get("display_x_state") != "shown"):
        raise ValueError("Desktop, terminal or display control did not survive")
    if args.selected != "any" and event.get("selected_x_state") != args.selected:
        raise ValueError(f"selected X state is {event.get('selected_x_state')}, expected {args.selected}")
    if not 0 < event["started_at_ns"] <= event["at_ns"]:
        raise ValueError("X checkpoint lacks a valid time interval")
    return 0


def server_pid(args: argparse.Namespace) -> int:
    expected = args.binary.resolve()
    found = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        pid = int(proc.name)
        try:
            if os.getpgid(pid) != args.group or (proc / "exe").resolve() != expected:
                continue
            command = (proc / "cmdline").read_bytes().split(b"\0")
            if command[1:3] == [b"devserver", b"run"]:
                found.append(pid)
        except (FileNotFoundError, PermissionError, ProcessLookupError):
            continue
    if len(found) != 1:
        raise ValueError("no unique devserver process in owned group")
    print(found[0])
    return 0


def gate_interval(path: Path) -> tuple[int, int]:
    events = re.findall(r"RESTART_GATE (arrived|released|expired) at_ns=(\d+)", path.read_text())
    names = [event[0] for event in events]
    if not names:
        raise ValueError("gate-events-missing")
    if "expired" in names:
        raise ValueError("gate-expired")
    if names != ["arrived", "released"]:
        raise ValueError("gate-event-order-invalid")
    start, end = (int(event[1]) for event in events)
    if not 0 < start < end <= start + 30_000_000_000:
        raise ValueError("gate-interval-invalid")
    return start, end


def omission(event: dict, label: str, window_id: str) -> bool:
    return (event.get("event") == "pass" and event.get("label") == label
            and event.get("branch") == "running" and event.get("snapshot_present") == "false"
            and event.get("suppressed") == "false" and event.get("actual") == "true"
            and window_id not in set(filter(None, event.get("snapshot_ids", "").split(","))))


def exposed(args: argparse.Namespace) -> int:
    pin = read_json(args.pin)
    rows = read_jsonl(args.rows)
    seen = frames(args.feed)
    native = read_jsonl(args.events)
    return 0 if (any(row.get("status") == "starting" and row.get("match_count") == 1
                     and row.get("on") is False for row in rows)
                 and any(pin["window_id"] not in frame["ids"] for frame in seen)
                 and any(omission(event, pin["label"], pin["window_id"]) for event in native)) else 3


def upgrade_answers(path: Path) -> list[dict]:
    """The recorder's upgrade answers: when, the numeric status, and whether
    the upgrade was valid. A recorder that predates the status field leaves
    it as None."""
    result = []
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 3 or parts[1] != "status":
            continue
        fields = dict(field.split("=", 1) for field in parts[2:])
        code = fields.get("http", "")
        result.append({"at_ns": int(Decimal(parts[0]) * 1_000_000_000),
                       "http": int(code) if code.isdigit() else None,
                       "valid": fields.get("valid") == "1"})
    return result


def declined_rounds(native_feed: list[dict]) -> list[dict]:
    return [event for event in native_feed
            if event.get("event") == "feed_round" and event.get("round") == "declined"]


def refused(args: argparse.Namespace) -> int:
    """Whether the hold has shown the refusal the driver releases on: after
    the gate's arrival, a Starting row, a 503 answer to the recorder's own
    upgrade, and a round the native feed loop read as declined."""
    arrived = re.search(r"RESTART_GATE arrived at_ns=(\d+)", args.gate.read_text())
    if not arrived:
        return 3
    start = int(arrived.group(1))
    rows = read_jsonl(args.rows)
    native_feed = read_jsonl(args.native_feed)
    return 0 if (any(row.get("status") == "starting" and row.get("match_count") == 1
                     and row.get("on") is False and row.get("at_ns", 0) >= start for row in rows)
                 and any(answer["http"] == 503 and not answer["valid"] and answer["at_ns"] >= start
                         for answer in upgrade_answers(args.feed))
                 and any(event["at_ns"] >= start for event in declined_rounds(native_feed))) else 3


def first_frame_since(native_feed: list[dict], since_ns: int) -> int | None:
    """When the desktop's own feed read the first frame of a round, at or
    after `since_ns`; None if it has not."""
    return min((event["at_ns"] for event in native_feed
                if event.get("event") == "feed_first_frame" and event["at_ns"] >= since_ns), default=None)


def consumed_passes(native: list[dict], label: str, window_id: str, since_ns: int) -> list[dict]:
    """The selected label's passes, from `since_ns` on and oldest first, in
    which the desktop read a set that holds the window and kept it:
    present, desired, and no close decided. Callers count from the first
    frame the desktop's feed read after the release: the watch loop also
    makes a pass when its view changes or a retry falls due, and such a
    pass ahead of that frame read the set the desktop was sent before the
    restart."""
    return sorted((event for event in native
                   if event.get("event") == "pass" and event.get("label") == label
                   and event.get("branch") == "running" and event.get("snapshot_present") == "true"
                   and event.get("desired") == "true" and event.get("close_decision") == "false"
                   and window_id in set(filter(None, event.get("snapshot_ids", "").split(",")))
                   and event["at_ns"] >= since_ns), key=lambda event: event["at_ns"])


def consumed(args: argparse.Namespace) -> int:
    """Whether the desktop's own feed has read the complete set since the
    gate's release: a first frame of a round, and after that frame a pass
    over a set that holds the selected window. The driver samples X once
    more after it."""
    released = re.search(r"RESTART_GATE released at_ns=(\d+)", args.gate.read_text())
    if not released:
        return 3
    frame = first_frame_since(read_jsonl(args.native_feed), int(released.group(1)))
    if frame is None:
        return 3
    pin = read_json(args.pin)
    return 0 if consumed_passes(read_jsonl(args.events), pin["label"], pin["window_id"], frame) else 3


def release_gate(args: argparse.Namespace) -> int:
    nonce = args.nonce_file.read_bytes().strip()
    if not re.fullmatch(rb"[0-9a-f]{32}", nonce):
        raise ValueError("invalid gate nonce")
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(2)
        client.connect(str(args.socket))
        client.sendall(nonce + b"\n")
    return 0


def frames(path: Path) -> list[dict]:
    result = []
    valid = False
    for line in path.read_text().splitlines():
        parts = line.split()
        if len(parts) < 2:
            raise ValueError("feed-event-malformed")
        if parts[1] in ("accept", "end", "close"):
            valid = False
        elif parts[1] == "status":
            valid = parts[-1] == "valid=1"
        elif parts[1] == "frame":
            if not valid:
                raise ValueError("feed-frame-without-valid-upgrade")
            fields = dict(field.split("=", 1) for field in parts[2:])
            ids = list(filter(None, fields["ids"].split(",")))
            if len(ids) != int(fields["n"]) or len(set(ids)) != len(ids):
                raise ValueError("feed-ids-duplicate-or-inconsistent")
            if not 0 <= int(fields["live"]) <= len(ids):
                raise ValueError("feed-live-count-invalid")
            result.append({"at_ns": int(Decimal(parts[0]) * 1_000_000_000), "ids": set(ids)})
    return result


def matching_chain(events: list[dict], label: str, pass_event: dict) -> tuple[dict, dict, dict] | None:
    pair = (pass_event.get("watcher"), pass_event.get("pass"))
    if any(not str(value).isdigit() or int(value) <= 0 for value in pair):
        return None
    matches = [event for event in events if event.get("label") == label and
               (event.get("watcher"), event.get("pass")) == pair]
    def one(kind: str):
        found = [event for event in matches if event.get("event") == kind]
        return found[0] if len(found) == 1 else None
    close, dispatch, destroy = one("close_decision"), one("native_close_dispatch"), one("native_destroy")
    if not all((close, dispatch, destroy)):
        return None
    if close.get("branch") != "running" or dispatch.get("scheduled") != "true":
        return None
    if destroy.get("found") != "true" or destroy.get("destroy_ok") != "true":
        return None
    if not (pass_event["at_ns"] <= close["at_ns"] <= dispatch["at_ns"] and
            close["at_ns"] <= destroy["at_ns"]):
        return None
    return close, dispatch, destroy


def outcome(args: argparse.Namespace) -> int:
    pin = read_json(args.pin)
    control = read_json(args.controls)
    checks = read_jsonl(args.checkpoints)
    native = read_jsonl(args.events)
    window_id, label, x_id = pin["window_id"], pin["label"], pin["x_id"]
    result = {"arm": args.arm, "run_kind": args.run_kind, "selected_tag": hashlib.sha256(window_id.encode()).hexdigest()[:16]}
    if args.mode != "baseline":
        result["mode"] = args.mode
        if not args.arm.endswith("delayed"):
            result.update(outcome="inconclusive", reason="admission-mode-needs-a-delayed-arm", status=3)
            write_new(args.output, result)
            return 3
    final_x = windows(args.final_windows)
    replacement_ids = [candidate for candidate, title in final_x.items()
                       if candidate != x_id and title == pin["x_title"]]
    result["old_x_visible_final"] = x_id in final_x
    result["replacement_title_match_count"] = len(replacement_ids)
    def finish(name: str, code: int, reason: str) -> int:
        result.update(outcome=name, reason=reason, status=code)
        write_new(args.output, result)
        return code
    if not checks or any(not check.get("desktop_alive") or check.get("terminal_x_state") != "shown"
                         or check.get("display_x_state") != "shown" for check in checks):
        return finish("inconclusive", 3, "desktop-or-control-x-lost")
    if any(not 0 < check.get("started_at_ns", 0) <= check.get("at_ns", 0) for check in checks):
        return finish("inconclusive", 3, "x-clock-invalid")
    if control["terminal_x_id"] == x_id or control["launcher_x_id"] == x_id:
        return finish("inconclusive", 3, "x-identities-overlap")
    clock = read_jsonl(args.clock)
    if len(clock) != 2 or clock[0]["stage"] != "before" or clock[1]["stage"] != "after":
        return finish("inconclusive", 3, "clock-bracket-missing")
    wall_delta = clock[1]["wall_ns"] - clock[0]["wall_ns"]
    mono_delta = clock[1]["mono_ns"] - clock[0]["mono_ns"]
    if wall_delta <= 0 or mono_delta <= 0 or abs(wall_delta - mono_delta) > 50_000_000:
        return finish("inconclusive", 3, "guest-clock-discontinuity")
    if any(not isinstance(event.get("at_ns"), int) or not clock[0]["wall_ns"] <= event["at_ns"] <= clock[1]["wall_ns"] for event in native):
        return finish("inconclusive", 3, "native-event-outside-clock-bracket")
    event_keys = [(event.get("event"), event.get("watcher"), event.get("pass"), event.get("label")) for event in native]
    if len(event_keys) != len(set(event_keys)):
        return finish("inconclusive", 3, "duplicate-native-pass-event")
    by_stage = {check["stage"]: check for check in checks}
    if len(by_stage) != len(checks):
        return finish("inconclusive", 3, "duplicate-x-checkpoint-stage")
    if any(check["started_at_ns"] < clock[0]["wall_ns"] or check["at_ns"] > clock[1]["wall_ns"] for check in checks):
        return finish("inconclusive", 3, "x-checkpoint-outside-clock-bracket")
    if any(later["started_at_ns"] < earlier["at_ns"] for earlier, later in zip(checks, checks[1:])):
        return finish("inconclusive", 3, "x-checkpoint-order-invalid")
    before = by_stage.get("pre-stop" if args.arm.endswith(("fast", "delayed")) else "pre-action")
    if not before or before["selected_x_state"] != "shown":
        return finish("inconclusive", 3, "selected-baseline-x-not-shown")
    if args.arm.endswith(("fast", "delayed")):
        after_stop = by_stage.get("after-stop")
        if not after_stop:
            return finish("inconclusive", 3, "after-stop-checkpoint-missing")
        if after_stop["selected_x_state"] != "shown":
            return finish("stop-loss", 3, "selected-x-lost-before-restart")
        gate = None
        if args.arm.endswith("delayed"):
            if args.gate is None:
                return finish("inconclusive", 3, "gate-file-missing")
            try:
                gate = gate_interval(args.gate)
            except ValueError as error:
                return finish("inconclusive", 3, str(error))
            except OSError:
                return finish("inconclusive", 3, "gate-file-unreadable")
            if gate[0] <= after_stop["at_ns"]:
                return finish("inconclusive", 3, "gate-arrival-before-old-server-exit")
            held = by_stage.get("held")
            if not held or not gate[0] <= held["started_at_ns"] <= held["at_ns"] < gate[1]:
                return finish("inconclusive", 3, "x-not-sampled-inside-gate")
        rows = [row for row in read_jsonl(args.rows) if row.get("match_count") == 1]
        try:
            seen_frames = frames(args.feed)
        except (ValueError, KeyError) as error:
            return finish("inconclusive", 3, str(error))
        starting = [row for row in rows if row.get("status") == "starting" and row.get("on") is False]
        mounted = [row for row in rows if row.get("status") == "running" and row.get("on") is True and row.get("token_present")]
        missing_frames = [frame for frame in seen_frames if window_id not in frame["ids"]]
        full_frames = [frame for frame in seen_frames if window_id in frame["ids"]]
        returned = [row for row in read_json(args.after_records)
                    if row.get("library_id") == pin["library_id"] and row.get("window_id") == window_id]
        baseline = baseline_restart(args, pin, result, checks, by_stage, native, after_stop, gate,
                                    starting, mounted, missing_frames, full_frames, returned, replacement_ids)
        if args.mode == "baseline" or baseline[1] == 10:
            # A joined closure is the fault in either mode: the admission
            # mode asks for it first, so an input that holds one reads as
            # that closure whatever else it lacks.
            return finish(*baseline)
        return finish(*admission(args, result, checks, by_stage, native, after_stop, gate, label, window_id,
                                 starting, mounted, missing_frames, full_frames, returned, replacement_ids))
    after = by_stage.get("after-action")
    if not after:
        return finish("inconclusive", 3, "after-action-checkpoint-missing")
    action_at_ns = read_json(args.action)["at_ns"]
    if not before["at_ns"] < action_at_ns < after["started_at_ns"]:
        return finish("inconclusive", 3, "action-time-not-bracketed")
    records = read_json(args.after_records)
    selected = [row for row in records if row.get("window_id") == window_id]
    if args.arm == "off-control":
        rows = [row for row in read_json(args.after_rows) if row.get("path") == pin["root"]]
        if len(rows) != 1 or rows[0].get("on") is not False or rows[0].get("token"):
            return finish("inconclusive", 3, "off-row-not-published")
        restored = [row for row in read_json(args.restored_records) if row.get("window_id") == window_id]
        restored_rows = [row for row in read_json(args.restored_rows) if row.get("path") == pin["root"]]
        if len(restored) != 1 or not restored[0].get("token") or len(restored_rows) != 1 or restored_rows[0].get("on") is not True:
            return finish("inconclusive", 3, "off-window-id-not-restored-on")
    else:
        rows = [row for row in read_json(args.after_rows) if row.get("path") == pin["root"]]
        if len(rows) != 1 or rows[0].get("on") is not True:
            return finish("inconclusive", 3, "discard-row-not-still-on")
    if selected:
        return finish("inconclusive", 3, "control-window-still-in-live-feed")
    try:
        seen_frames = frames(args.feed)
    except (ValueError, KeyError) as error:
        return finish("inconclusive", 3, str(error))
    feed_after = [frame for frame in seen_frames if frame["at_ns"] > action_at_ns]
    if not any(window_id not in frame["ids"] for frame in feed_after):
        return finish("inconclusive", 3, "control-feed-change-not-validated")
    if after["selected_x_state"] != "gone":
        return finish("control-not-closed", 3, "old-x-not-destroyed")
    if not any(event.get("event") == "pass" and event.get("label") == label and
               event.get("branch") == "running" and event.get("snapshot_present") == "false" and
               event.get("suppressed") == "false" and event.get("actual") == "true" and
               event.get("desired") == "false" and window_id not in
               set(filter(None, event.get("snapshot_ids", "").split(","))) and
               action_at_ns < event["at_ns"] < after["started_at_ns"] and
               (chain := matching_chain(native, label, event)) and
               chain[2]["at_ns"] < after["started_at_ns"]
               for event in native):
        return finish("inconclusive", 3, "control-native-close-join-missing")
    return finish("control-closed", 0, "published-removal-and-old-x-destroyed")


def baseline_restart(args, pin, result, checks, by_stage, native, after_stop, gate,
                     starting, mounted, missing_frames, full_frames, returned, replacement_ids) -> tuple[str, int, str]:
    """The restart classification by the incomplete feed: a joined closure,
    a survived exposure, or why neither is shown. Answers the outcome, its
    status and its reason, and puts a closure's or a survival's fields in
    `result`."""
    window_id, label = pin["window_id"], pin["label"]
    if not (starting and mounted and missing_frames and full_frames):
        return "no-proved-exposure", 3, "starting-or-validated-feed-interval-missing"
    if len(returned) != 1 or not returned[0].get("token"):
        return "inconclusive", 3, "same-persisted-id-not-restored"
    stop_events = [event for event in native if event.get("label") == label and
                   event.get("branch") in ("CloseWindows", "stop_close") and
                   event["at_ns"] >= after_stop["at_ns"]]
    exposures = []
    candidates = []
    for event in native:
        if not omission(event, label, window_id) or not after_stop["at_ns"] < event["at_ns"]:
            continue
        ids = set(filter(None, event.get("snapshot_ids", "").split(",")))
        # These are independent subscribers. Either may receive first;
        # Both must omit the selected id inside the pre-restore interval;
        # other ids can differ while unrelated windows are changing.
        if gate:
            corroborated = (gate[0] <= event["at_ns"] < gate[1]
                and any(gate[0] <= row["at_ns"] < gate[1] for row in starting)
                and any(gate[0] <= frame["at_ns"] < gate[1] for frame in missing_frames)
                and any(row["at_ns"] >= gate[1] for row in mounted)
                and any(frame["at_ns"] >= gate[1] for frame in full_frames))
        else:
            corroborated = any(start["at_ns"] <= event["at_ns"] < mount["at_ns"]
                and start["at_ns"] <= frame["at_ns"] < mount["at_ns"]
                and event["at_ns"] < full["at_ns"]
                for start in starting for frame in missing_frames for mount in mounted for full in full_frames)
        if not corroborated:
            continue
        matching_frames = [frame for frame in missing_frames if frame["ids"] == ids
                           and (not gate or gate[0] <= frame["at_ns"] < gate[1])]
        event = {**event, "parallel_id_set_match": bool(matching_frames)}
        exposures.append(event)
        chain = matching_chain(native, label, event)
        if chain is None or event.get("desired") != "false" or event.get("close_decision") != "true":
            continue
        _, _, destroy = chain
        if any(stop["at_ns"] <= destroy["at_ns"] for stop in stop_events):
            continue
        if gate and destroy["at_ns"] >= gate[1]:
            continue
        if not any(check["selected_x_state"] == "gone" and check["started_at_ns"] > destroy["at_ns"]
                   for check in checks):
            continue
        candidates.append((event, destroy))
    if candidates and not result["old_x_visible_final"]:
        event, destroy = candidates[0]
        result.update(pass_at_ns=event["at_ns"], destroy_at_ns=destroy["at_ns"], parallel_id_set_match=event["parallel_id_set_match"])
        return "startup-incomplete-feed-closure", 10, "consumed-omission-close-destroy-old-x-gone"
    if any(check["selected_x_state"] == "gone" for check in checks):
        return "native-loss-cause-unassigned", 3, "old-x-gone-without-complete-startup-join"
    if exposures:
        attempts = [event for event in native if event.get("label") == label
                    and event.get("event") in ("close_decision", "native_close_dispatch", "native_destroy")
                    and after_stop["at_ns"] < event["at_ns"]]
        if attempts or stop_events:
            return "inconclusive", 3, "survival-with-native-close-attempt"
        if (not result["old_x_visible_final"] or replacement_ids
                or not by_stage.get("reconnect", {}).get("page_ready")):
            return "inconclusive", 3, "survival-page-or-original-x-not-proved"
        result["parallel_id_set_match"] = exposures[0]["parallel_id_set_match"]
        return "survived-exposure", 0, "consumed-omission-original-x-and-page-survived"
    return "fixture-only", 3, "no-consumed-omission-inside-restore-interval"


def admission(args, result, checks, by_stage, native, after_stop, gate, label, window_id,
              starting, mounted, missing_frames, full_frames, returned, replacement_ids) -> tuple[str, int, str]:
    """The delayed restart read for a devserver that withholds its window
    set while it starts: the original native window is retained because
    the feed was refused, not because an incomplete set was survived.

    Asked only once the baseline classification has found no joined
    closure. A validated set inside the hold is the server publishing
    while its restore is held, status 11, whatever the desktop then did
    with it. Retention passes only beside a proved refusal: inside the
    hold, a Starting row, a 503 answer to the recorder's own upgrade, and
    a round the native feed loop read as declined; so a desktop that never
    asked cannot pass by keeping its window. It also needs the desktop to
    have read the complete set after the release and kept the window: a
    first frame of its own feed, after that frame a pass over a set that
    holds the window with no close decided, and X sampled after that pass.
    A window still there before the desktop has read any set proves
    nothing. The original X id is shown at every checkpoint: one that
    finds it hidden is not retention."""
    def inside(at_ns: int) -> bool:
        return gate[0] <= at_ns < gate[1]
    if any(inside(frame["at_ns"]) for frame in missing_frames):
        return "incomplete-set-published", 11, "validated-set-inside-hold-lacks-selected-window"
    if any(inside(frame["at_ns"]) for frame in full_frames):
        return "inconclusive", 3, "selected-window-published-inside-hold"
    answers = upgrade_answers(args.feed)
    if any(answer["valid"] and inside(answer["at_ns"]) for answer in answers):
        return "inconclusive", 3, "feed-upgrade-admitted-inside-hold"
    if args.native_feed is None:
        return "inconclusive", 3, "native-feed-events-missing"
    native_feed = read_jsonl(args.native_feed)
    clock = read_jsonl(args.clock)
    if any(not isinstance(event.get("at_ns"), int) or not clock[0]["wall_ns"] <= event["at_ns"] <= clock[1]["wall_ns"]
           for event in native_feed):
        return "inconclusive", 3, "native-feed-event-outside-clock-bracket"
    refusals = [answer for answer in answers
                if answer["http"] == 503 and not answer["valid"] and inside(answer["at_ns"])]
    declined = [event for event in declined_rounds(native_feed) if inside(event["at_ns"])]
    if not any(inside(row["at_ns"]) for row in starting):
        return "no-proved-refusal", 3, "starting-row-inside-hold-missing"
    if not refusals:
        return "no-proved-refusal", 3, "parallel-503-inside-hold-missing"
    if not declined:
        return "no-proved-refusal", 3, "native-declined-round-inside-hold-missing"
    if not (any(row["at_ns"] >= gate[1] for row in mounted)
            and any(frame["at_ns"] >= gate[1] for frame in full_frames)):
        return "no-proved-refusal", 3, "post-release-mount-or-full-feed-missing"
    if len(returned) != 1 or not returned[0].get("token"):
        return "inconclusive", 3, "same-persisted-id-not-restored"
    if any(check["selected_x_state"] == "gone" for check in checks):
        return "native-loss-cause-unassigned", 3, "old-x-gone-without-complete-startup-join"
    attempts = [event for event in native if event.get("label") == label
                and event.get("event") in ("close_decision", "native_close_dispatch", "native_destroy")
                and after_stop["at_ns"] < event["at_ns"]]
    if attempts:
        return "inconclusive", 3, "retention-with-native-close-attempt"
    if (any(check["selected_x_state"] != "shown" for check in checks) or not result["old_x_visible_final"]
            or replacement_ids or not by_stage.get("reconnect", {}).get("page_ready")):
        return "inconclusive", 3, "retention-page-or-original-x-not-proved"
    frame = first_frame_since(native_feed, gate[1])
    if frame is None:
        return "no-proved-retention", 3, "native-first-frame-after-release-missing"
    kept = consumed_passes(native, label, window_id, frame)
    if not kept:
        return "no-proved-retention", 3, "native-pass-over-the-full-set-missing"
    sampled = by_stage.get("consumed")
    if not sampled or sampled["started_at_ns"] <= kept[0]["at_ns"] or sampled["selected_x_state"] != "shown":
        return "no-proved-retention", 3, "x-not-sampled-after-the-consumed-set"
    # What the feed loop did to the devserver's unreachable mark, for the
    # record: the flips it announced after the old server's exit, and which
    # of them fell inside the hold.
    flips = [event for event in native_feed if event.get("event") == "feed_round"
             and event.get("flipped", "none") != "none" and event["at_ns"] > after_stop["at_ns"]]
    result.update(
        hold_ns=gate[1] - gate[0],
        native_passes_over_the_full_set=len(kept),
        parallel_refusals_inside_hold=len(refusals),
        native_declined_rounds_inside_hold=len(declined),
        unreachable_marks=sum(event["flipped"] == "devserver-control-attention" for event in flips),
        unreachable_marks_inside_hold=sum(event["flipped"] == "devserver-control-attention" and inside(event["at_ns"]) for event in flips),
        restored_announcements=sum(event["flipped"] == "devserver-control-restored" for event in flips),
        restored_announcements_inside_hold=sum(event["flipped"] == "devserver-control-restored" and inside(event["at_ns"]) for event in flips),
        first_frame_clears_after_release=sum(event.get("event") == "feed_first_frame" and event.get("cleared") == "true"
                                             and event["at_ns"] >= gate[1] for event in native_feed),
    )
    return "startup-refusal-retained", 0, "refused-feed-original-x-and-page-retained"


def main() -> int:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    control = commands.add_parser("pin-controls")
    for name in ("before-windows", "after-windows", "records", "output"):
        control.add_argument(f"--{name}", type=Path, required=True)
    control.set_defaults(handler=pin_controls)
    row = commands.add_parser("pin-row")
    row.add_argument("--rows", type=Path, required=True)
    row.add_argument("--root", required=True)
    row.add_argument("--output", type=Path, required=True)
    row.set_defaults(handler=pin_row)
    checkpoint = commands.add_parser("check-checkpoint")
    checkpoint.add_argument("--checkpoints", type=Path, required=True)
    checkpoint.add_argument("--stage", required=True)
    checkpoint.add_argument("--selected", choices=("shown", "gone", "any"), required=True)
    checkpoint.set_defaults(handler=check_checkpoint)
    server = commands.add_parser("server-pid")
    server.add_argument("--group", type=int, required=True)
    server.add_argument("--binary", type=Path, required=True)
    server.set_defaults(handler=server_pid)
    exposure = commands.add_parser("exposed")
    for name in ("pin", "rows", "feed", "events"):
        exposure.add_argument(f"--{name}", type=Path, required=True)
    exposure.set_defaults(handler=exposed)
    refusal = commands.add_parser("refused")
    for name in ("rows", "feed", "native-feed", "gate"):
        refusal.add_argument(f"--{name}", type=Path, required=True)
    refusal.set_defaults(handler=refused)
    consumption = commands.add_parser("consumed")
    for name in ("pin", "events", "native-feed", "gate"):
        consumption.add_argument(f"--{name}", type=Path, required=True)
    consumption.set_defaults(handler=consumed)
    release = commands.add_parser("release-gate")
    release.add_argument("--socket", type=Path, required=True)
    release.add_argument("--nonce-file", type=Path, required=True)
    release.set_defaults(handler=release_gate)
    verdict = commands.add_parser("verdict")
    verdict.add_argument("--arm", choices=("graceful-fast", "kill-fast", "graceful-delayed", "kill-delayed", "off-control", "discard-control"), required=True)
    for name in ("pin", "controls", "checkpoints", "events", "output", "after-records", "after-rows", "clock", "final-windows"):
        verdict.add_argument(f"--{name}", type=Path, required=True)
    verdict.add_argument("--run-kind", choices=("constructed", "rehearsal", "counted"), default="constructed")
    verdict.add_argument("--mode", choices=("baseline", "admission"), default="baseline")
    verdict.add_argument("--native-feed", type=Path)
    verdict.add_argument("--gate", type=Path)
    verdict.add_argument("--rows", type=Path)
    verdict.add_argument("--feed", type=Path, required=True)
    verdict.add_argument("--action", type=Path)
    verdict.add_argument("--restored-records", type=Path)
    verdict.add_argument("--restored-rows", type=Path)
    verdict.set_defaults(handler=outcome)
    args = parser.parse_args()
    try:
        return args.handler(args)
    except (KeyError, ValueError, OSError, TypeError, AttributeError, json.JSONDecodeError) as error:
        print(f"restart instrument: {type(error).__name__}: {error}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())
