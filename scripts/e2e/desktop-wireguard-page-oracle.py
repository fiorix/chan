#!/usr/bin/env python3
"""Select the tenant connecting page from inspect.mjs all output."""

import json
import sys
from urllib.parse import urlparse


def main() -> int:
    mode, path = sys.argv[1:]
    with open(path, encoding="utf-8") as source:
        values = [json.loads(line).get("value") for line in source if line.strip()]
    pages = [
        value
        for value in values
        if isinstance(value, dict)
        and urlparse(value.get("href", "")).path.endswith("/connecting.html")
        and value.get("workspace") is True
    ]
    if len(pages) != 1:
        print(f"expected one ws2 connecting page, found {len(pages)}", file=sys.stderr)
        return 1
    page = pages[0]
    if mode == "lost":
        reason = page.get("reason", "")
        if not (
            "no WireGuard handshake with the peer at 127.0.0.1:" in reason
            and "the tunnel had a session and lost it" in reason
            and int(page.get("attempt", 0)) >= 2
            and page.get("actionsHidden") is True
        ):
            print(f"lost-session page did not name the loss: {page}", file=sys.stderr)
            return 1
    elif mode != "initial":
        print(f"unknown mode: {mode}", file=sys.stderr)
        return 2
    print(json.dumps(page, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
