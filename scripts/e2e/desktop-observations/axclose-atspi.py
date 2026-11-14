#!/usr/bin/env python3
"""Observe or invoke one real AT-SPI default action on a private session bus."""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from typing import Any


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", required=True)
    parser.add_argument("--role", choices=("tab", "button"), required=True)
    parser.add_argument("--exact", action="store_true")
    parser.add_argument("--dialog-name", help="Require an ancestor dialog with this exact accessible name")
    parser.add_argument("--observe", action="store_true", help="Read the target without invoking its action")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.WARNING)
    if os.environ.get("AXCLOSE_PRIVATE_BUS") != "1":
        print(json.dumps({"status": "unavailable", "reason": "private guest session bus not certified"}))
        return 2
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi, GLib
    except (ImportError, ValueError) as error:
        print(json.dumps({"status": "unavailable", "reason": str(error)}))
        return 2

    Atspi.set_timeout(800, 3000)
    wanted = Atspi.Role.PAGE_TAB if args.role == "tab" else Atspi.Role.PUSH_BUTTON
    deadline = time.monotonic() + 12
    seen: list[dict[str, Any]] = []
    try:
        root = Atspi.get_desktop(0)
        if root is None:
            raise RuntimeError("AT-SPI returned no desktop")
        pending = [(root, [])]
        matches = []
        count = 0
        while pending:
            if count >= 5000 or time.monotonic() >= deadline:
                raise RuntimeError("bounded accessibility traversal did not finish")
            node, dialogs = pending.pop()
            count += 1
            node.clear_cache_single()
            role = node.get_role()
            if role in (Atspi.Role.DIALOG, Atspi.Role.ALERT):
                dialogs = [*dialogs, node.get_name()]
            if role == wanted:
                name = node.get_name() or ""
                matched = name == args.name if args.exact else args.name in name
                if matched:
                    states = node.get_state_set()
                    detail = {"name": name, "role": node.get_role_name(),
                              "selected": states.contains(Atspi.StateType.SELECTED),
                              "showing": states.contains(Atspi.StateType.SHOWING),
                              "dialogs": dialogs}
                    seen.append(detail)
                    if detail["showing"] and (not args.dialog_name or args.dialog_name in dialogs):
                        matches.append((node, detail))
            children = [node.get_child_at_index(i) for i in range(node.get_child_count())]
            if any(child is None for child in children):
                raise RuntimeError("accessible child disappeared during traversal")
            pending.extend((child, dialogs) for child in children)
        logging.debug("Traversed %d accessible nodes; %d matching showing targets", count, len(matches))
        if len(matches) != 1:
            print(json.dumps({"status": "unavailable", "reason": "wanted exactly one showing accessible target", "matches": seen}))
            return 2
        target, detail = matches[0]
        action = target.get_action_iface()
        if action is None or action.get_n_actions() == 0:
            print(json.dumps({"status": "unavailable", "reason": "target has no AT-SPI action", "target": detail}))
            return 2
        names = [action.get_action_name(i) for i in range(action.get_n_actions())]
        if args.observe:
            print(json.dumps({"status": "observed", "target": detail, "actions": names}))
            return 0
        # Index zero is the exported default; no DOM or X click substitutes.
        invoked = action.do_action(0)
        print(json.dumps({"status": "invoked" if invoked else "action-refused", "target": detail,
                          "actions": names, "index": 0, "invoked": invoked, "productVerdict": "not-evaluated"}))
        return 0 if invoked else 3
    except (GLib.Error, RuntimeError, TypeError) as error:
        print(json.dumps({"status": "incomplete", "reason": str(error), "matches": seen}))
        return 3


if __name__ == "__main__":
    sys.exit(main())
