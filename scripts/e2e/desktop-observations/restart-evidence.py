#!/usr/bin/env python3
"""Private identity checks and narrow restart native observation verdicts."""

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
    if len(events) != 2 or [event[0] for event in events] != ["arrived", "released"]:
        raise ValueError("gate did not arrive and release exactly once")
    start, end = (int(event[1]) for event in events)
    if not 0 < start < end <= start + 30_000_000_000:
        raise ValueError("gate interval invalid or expired")
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
            raise ValueError("malformed feed event")
        if parts[1] in ("accept", "end", "close"):
            valid = False
        elif parts[1] == "status":
            valid = parts[-1] == "valid=1"
        elif parts[1] == "frame":
            if not valid:
                raise ValueError("frame without validated upgrade")
            fields = dict(field.split("=", 1) for field in parts[2:])
            ids = list(filter(None, fields["ids"].split(",")))
            if len(ids) != int(fields["n"]) or len(set(ids)) != len(ids):
                raise ValueError("duplicate or inconsistent feed ids")
            if not 0 <= int(fields["live"]) <= len(ids):
                raise ValueError("invalid live count")
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
    result = {"arm": args.arm, "selected_tag": hashlib.sha256(window_id.encode()).hexdigest()[:16]}
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
            gate = gate_interval(args.gate)
            if gate[0] <= after_stop["at_ns"]:
                return finish("inconclusive", 3, "gate-arrival-before-old-server-exit")
            held = by_stage.get("held")
            if not held or not gate[0] <= held["started_at_ns"] <= held["at_ns"] < gate[1]:
                return finish("inconclusive", 3, "x-not-sampled-inside-gate")
        rows = [row for row in read_jsonl(args.rows) if row.get("match_count") == 1]
        seen_frames = frames(args.feed)
        starting = [row for row in rows if row.get("status") == "starting" and row.get("on") is False]
        mounted = [row for row in rows if row.get("status") == "running" and row.get("on") is True and row.get("token_present")]
        missing_frames = [frame for frame in seen_frames if window_id not in frame["ids"]]
        full_frames = [frame for frame in seen_frames if window_id in frame["ids"]]
        if not (starting and mounted and missing_frames and full_frames):
            return finish("no-proved-exposure", 3, "starting-or-validated-feed-interval-missing")
        returned = [row for row in read_json(args.after_records)
                    if row.get("library_id") == pin["library_id"] and row.get("window_id") == window_id]
        if len(returned) != 1 or not returned[0].get("token"):
            return finish("inconclusive", 3, "same-persisted-id-not-restored")
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
            # agreement inside the observed pre-restore interval is required.
            if gate:
                corroborated = (gate[0] <= event["at_ns"] < gate[1]
                    and any(gate[0] <= row["at_ns"] < gate[1] for row in starting)
                    and any(gate[0] <= frame["at_ns"] < gate[1] and frame["ids"] == ids for frame in missing_frames)
                    and any(row["at_ns"] >= gate[1] for row in mounted)
                    and any(frame["at_ns"] >= gate[1] for frame in full_frames))
            else:
                corroborated = any(start["at_ns"] <= event["at_ns"] < mount["at_ns"]
                    and start["at_ns"] <= frame["at_ns"] < mount["at_ns"]
                    and event["at_ns"] < full["at_ns"] and frame["ids"] == ids
                    for start in starting for frame in missing_frames for mount in mounted for full in full_frames)
            if not corroborated:
                continue
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
            result.update(pass_at_ns=event["at_ns"], destroy_at_ns=destroy["at_ns"])
            return finish("startup-incomplete-feed-closure", 10, "consumed-omission-close-destroy-old-x-gone")
        if any(check["selected_x_state"] == "gone" for check in checks):
            return finish("native-loss-cause-unassigned", 3, "old-x-gone-without-complete-startup-join")
        if exposures:
            attempts = [event for event in native if event.get("label") == label
                        and event.get("event") in ("close_decision", "native_close_dispatch", "native_destroy")
                        and after_stop["at_ns"] < event["at_ns"]]
            if attempts or stop_events:
                return finish("inconclusive", 3, "survival-with-native-close-attempt")
            if (not result["old_x_visible_final"] or replacement_ids
                    or not by_stage.get("reconnect", {}).get("page_ready")):
                return finish("inconclusive", 3, "survival-page-or-original-x-not-proved")
            return finish("survived-exposure", 0, "consumed-omission-original-x-and-page-survived")
        return finish("fixture-only", 3, "no-consumed-omission-inside-restore-interval")
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
    feed_after = [frame for frame in frames(args.feed) if frame["at_ns"] > action_at_ns]
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
    release = commands.add_parser("release-gate")
    release.add_argument("--socket", type=Path, required=True)
    release.add_argument("--nonce-file", type=Path, required=True)
    release.set_defaults(handler=release_gate)
    verdict = commands.add_parser("verdict")
    verdict.add_argument("--arm", choices=("graceful-fast", "kill-fast", "graceful-delayed", "kill-delayed", "off-control", "discard-control"), required=True)
    for name in ("pin", "controls", "checkpoints", "events", "output", "after-records", "after-rows", "clock", "final-windows"):
        verdict.add_argument(f"--{name}", type=Path, required=True)
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
