#!/usr/bin/env python3
"""Read the gateway row or navigation document asserted by desktop WireGuard suites."""

import json
import re
import sys
from pathlib import Path


def fail(message: str) -> None:
    raise SystemExit(f"wgwrongkey-oracle: {message}")


def row_error(path: str, gateway_id: str) -> str:
    payload = json.loads(Path(path).read_text())
    if isinstance(payload, dict):
        if payload.get("http_status") != 200:
            fail("the gateway list did not answer HTTP 200")
        payload = payload.get("rows")
    if not isinstance(payload, list):
        fail("the gateway list is not an array")
    rows = [row for row in payload if isinstance(row, dict) and row.get("id") == gateway_id]
    if len(rows) != 1 or not isinstance(rows[0].get("last_error"), str):
        fail("the gateway row has no last_error")
    return rows[0]["last_error"]


def reason_pattern(endpoint: str, file: str) -> str:
    return (
        r"gateway discovery failed: no WireGuard handshake with the peer at "
        + re.escape(endpoint)
        + r" since the tunnel started (?:\d+ s|\d+ min|\d+ h(?: \d+ min)?) ago; check PublicKey in "
        + re.escape(file)
        + r" and that the peer lists this client's key"
    )


def wrong_key(path: str, gateway_id: str, endpoint: str, file: str) -> str:
    error = row_error(path, gateway_id)
    if re.fullmatch(reason_pattern(endpoint, file), error) is None:
        fail("the row does not name the never-handshaken peer, endpoint and file")
    return error


def startup(path: str, endpoint: str, file: str) -> str:
    lines = [line for line in Path(path).read_text().splitlines() if "startup gateway connect failed" in line]
    if not lines or "error sending request" in lines[-1] or re.search(reason_pattern(endpoint, file), lines[-1]) is None:
        fail("the start-up line does not name the never-handshaken peer, endpoint and file")
    return "named"


def clean_log(path: str) -> str:
    values = sys.stdin.read().splitlines()
    if not values or any(not value for value in values):
        fail("the key scan has no complete key set")
    text = Path(path).read_text()
    if any(value in text for value in values):
        fail("a key value appears in the desktop log")
    return "clean"


def tenant(path: str, gateway_id: str) -> str:
    error = row_error(path, gateway_id)
    if "gateway discovery returned HTTP 404" not in error:
        fail("the row does not name the discovery 404")
    return error


def document(path: str) -> str:
    record = json.loads(Path(path).read_text())
    url = record.get("url")
    documents = record.get("documents")
    if not isinstance(url, str) or not isinstance(documents, list):
        fail("the navigation record has no URL or documents")
    matches = [item for item in documents if isinstance(item, dict) and item.get("url") == url]
    if not matches:
        fail("the navigation URL has no document response")
    return repr((matches[-1].get("status"), record.get("errorText")))


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 5 and args[0] == "wrong-key":
        print(wrong_key(*args[1:]))
    elif len(args) == 4 and args[0] == "startup":
        print(startup(*args[1:]))
    elif len(args) == 2 and args[0] == "clean-log":
        print(clean_log(args[1]))
    elif len(args) == 3 and args[0] == "tenant":
        print(tenant(*args[1:]))
    elif len(args) == 2 and args[0] == "document":
        print(document(args[1]))
    else:
        fail("usage: wgwrongkey-oracle.py wrong-key LIST ID ENDPOINT CONFIG | startup LOG ENDPOINT CONFIG | clean-log LOG | tenant LIST ID | document RECORD")


if __name__ == "__main__":
    main()
