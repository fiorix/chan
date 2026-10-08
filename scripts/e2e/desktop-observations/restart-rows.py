#!/usr/bin/env python3
"""Record one exact devserver workspace row while a restarted server appears."""

import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request


def main() -> int:
    os.umask(0o077)
    port, token_file, root, seconds, selected_file, raw_file = sys.argv[1:7]
    stop = Path(sys.argv[7]) if len(sys.argv) == 8 else None
    token = Path(token_file).read_text().strip()
    deadline = time.monotonic() + float(seconds)
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/devserver/workspaces",
        headers={"Authorization": f"Bearer {token}"},
    )
    selected_count = 0
    with Path(selected_file).open("x") as selected, Path(raw_file).open("x") as raw:
        while time.monotonic() < deadline and not (stop and stop.exists()):
            try:
                with urllib.request.urlopen(request, timeout=1) as response:
                    body = response.read(1_000_001)
                    if len(body) > 1_000_000:
                        raise ValueError("oversized workspace list")
                    at_ns = time.time_ns()
                    rows = json.loads(body)
                    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                        raise ValueError("workspace list is not an array")
                    matches = [row for row in rows if row.get("path") == root]
                    raw.write(json.dumps({"at_ns": at_ns, "rows": rows}, sort_keys=True) + "\n")
                    raw.flush()
                    if len(matches) == 1:
                        row = matches[0]
                        selected_count += 1
                        event = {
                            "at_ns": at_ns,
                            "status": row.get("status"),
                            "on": row.get("on"),
                            "token_present": bool(row.get("token")),
                            "prefix": row.get("prefix"),
                            "match_count": 1,
                        }
                    else:
                        event = {"at_ns": at_ns, "match_count": len(matches)}
                    selected.write(json.dumps(event, sort_keys=True) + "\n")
                    selected.flush()
            except (OSError, urllib.error.URLError, ValueError, json.JSONDecodeError) as error:
                selected.write(
                    json.dumps({"at_ns": time.time_ns(), "error": type(error).__name__}) + "\n"
                )
                selected.flush()
            time.sleep(0.05)
    return 0 if selected_count else 3


if __name__ == "__main__":
    sys.exit(main())
