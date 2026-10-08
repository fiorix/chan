#!/usr/bin/env python3
"""Pin native identity and record the passes consumed by the guest observer.

The driver keeps raw API responses private. This helper writes only window ids,
native X ids, process identity and RESTART_OBS fields to retained summaries.
"""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time


LABEL = re.compile(r"lib-[0-9a-fA-F]+::w-[0-9a-fA-F]+\Z")


def process_start_tick(pid: int) -> str:
    stat = Path(f"/proc/{pid}/stat").read_text()
    return stat.rsplit(") ", 1)[1].split()[19]


def x_windows(path: Path) -> dict[str, str]:
    windows = {}
    for line in path.read_text().splitlines():
        x_id, title = line.split(" ", 1)
        if x_id in windows:
            raise ValueError(f"duplicate X id {x_id}")
        windows[x_id] = title
    return windows


def write_json(path: Path, value: object) -> None:
    with path.open("x") as stream:
        stream.write(json.dumps(value, sort_keys=True) + "\n")


def pin(args: argparse.Namespace) -> None:
    if os.path.lexists(args.label_file):
        raise ValueError("selected label file must be absent before pin")
    records = json.loads(args.records.read_text())
    matches = [
        row
        for row in records
        if row.get("workspace_path") == args.root
        and row.get("kind") == "workspace"
    ]
    if len(matches) != 1:
        raise ValueError("selected root does not name one workspace record")
    row = matches[0]
    label = f'{row["library_id"]}::{row["window_id"]}'
    if not LABEL.fullmatch(label):
        raise ValueError("selected record has an unexpected native label")
    if (
        row.get("origin", "native") != "native"
        or not row.get("persisted")
        or row.get("hidden", False)
        or not row.get("token")
        or not isinstance(row.get("ordinal"), int)
        or row.get("connected") is not True
        or not isinstance(row.get("holders"), list)
        or len(row["holders"]) != 1
    ):
        raise ValueError("selected record lacks a shown, connected single-holder native baseline")
    before = set(args.before_ids.read_text().split())
    windows = x_windows(args.windows)
    new_ids = set(windows) - before
    if len(new_ids) != 1:
        raise ValueError("mint did not create exactly one visible native X id")
    x_id = next(iter(new_ids))
    title = windows[x_id]
    if args.unique_name not in title or f'Window {row["ordinal"]}' not in title:
        raise ValueError("new X title does not identify the selected record")
    if sum(other == title for other in windows.values()) != 1:
        raise ValueError("selected native title is not unique")
    start_tick = process_start_tick(args.desktop_pid)
    summary = {
        "desktop_pid": args.desktop_pid,
        "desktop_start_tick": start_tick,
        "library_id": row["library_id"],
        "window_id": row["window_id"],
        "ordinal": row["ordinal"],
        "label": label,
        "root": args.root,
        "x_id": x_id,
        "x_title": title,
    }
    write_json(args.output, summary)
    temporary = args.label_file.with_name(args.label_file.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(label + "\n")
    try:
        os.rename(temporary, args.label_file)
    finally:
        temporary.unlink(missing_ok=True)


def x_state(x_id: str, visible: set[str]) -> str:
    answer = subprocess.run(["xdotool", "getwindowname", x_id], capture_output=True, timeout=5)
    if answer.returncode != 0:
        return "gone"
    return "shown" if x_id in visible else "hidden"


def checkpoint(args: argparse.Namespace) -> None:
    started_at_ns = time.time_ns()
    target = json.loads(args.pin.read_text())
    try:
        desktop_alive = process_start_tick(target["desktop_pid"]) == target["desktop_start_tick"]
    except FileNotFoundError:
        desktop_alive = False
    search = subprocess.run(
        ["xdotool", "search", "--onlyvisible", "--name", "."], capture_output=True, text=True, timeout=5
    )
    if search.returncode not in (0, 1):
        raise RuntimeError("X visibility probe failed")
    visible = set(search.stdout.split())
    selected_state = x_state(target["x_id"], visible)
    terminal_state = x_state(args.terminal_xid, visible)
    display_state = x_state(args.display_xid, visible)
    event = {
        "started_at_ns": started_at_ns,
        "at_ns": time.time_ns(),
        "stage": args.stage,
        "page_ready": args.page_ready,
        "desktop_alive": desktop_alive,
        "selected_x_state": selected_state,
        "terminal_x_state": terminal_state,
        "display_x_state": display_state,
    }
    with args.output.open("a") as stream:
        stream.write(json.dumps(event, sort_keys=True) + "\n")


def events(args: argparse.Namespace) -> None:
    target = json.loads(args.pin.read_text())
    selected = target["label"]
    with args.output.open("w") as stream:
        for line in args.desktop_log.read_text(errors="replace").splitlines():
            match = re.search(r"RESTART_OBS (\w+) (.*)", line)
            if not match:
                continue
            fields = dict(part.split("=", 1) for part in match.group(2).split())
            if fields.get("label") != selected:
                continue
            fields["at_ns"] = int(fields["at_ns"])
            if fields["at_ns"] <= 0:
                raise ValueError("native event has no comparable epoch time")
            stream.write(json.dumps({"event": match.group(1), **fields}, sort_keys=True) + "\n")


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    pin_command = commands.add_parser("pin")
    pin_command.add_argument("--records", type=Path, required=True)
    pin_command.add_argument("--root", required=True)
    pin_command.add_argument("--unique-name", required=True)
    pin_command.add_argument("--before-ids", type=Path, required=True)
    pin_command.add_argument("--windows", type=Path, required=True)
    pin_command.add_argument("--desktop-pid", type=int, required=True)
    pin_command.add_argument("--label-file", type=Path, required=True)
    pin_command.add_argument("--output", type=Path, required=True)
    pin_command.set_defaults(action=pin)
    checkpoint_command = commands.add_parser("checkpoint")
    checkpoint_command.add_argument("--pin", type=Path, required=True)
    checkpoint_command.add_argument("--stage", required=True)
    checkpoint_command.add_argument("--page-ready", action="store_true")
    checkpoint_command.add_argument("--terminal-xid", required=True)
    checkpoint_command.add_argument("--display-xid", required=True)
    checkpoint_command.add_argument("--output", type=Path, required=True)
    checkpoint_command.set_defaults(action=checkpoint)
    events_command = commands.add_parser("events")
    events_command.add_argument("--pin", type=Path, required=True)
    events_command.add_argument("--desktop-log", type=Path, required=True)
    events_command.add_argument("--output", type=Path, required=True)
    events_command.set_defaults(action=events)
    args = parser.parse_args()
    args.action(args)


if __name__ == "__main__":
    main()
