#!/usr/bin/env python3
"""Record validated window snapshots without retaining bearer tokens.

Usage: restart-feed.py HOST PORT TOKEN_FILE SECONDS [STOP_FILE]
The optional stop file ends capture after the next bounded socket operation.
"""

import base64
import hashlib
import json
import os
from pathlib import Path
import socket
import struct
import sys
import time


def stamp() -> str:
    seconds, nanos = divmod(time.time_ns(), 1_000_000_000)
    return f"{seconds}.{nanos:09d}"


def read_exact(sock: socket.socket, count: int) -> bytes:
    data = bytearray()
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise EOFError
        data.extend(chunk)
    return bytes(data)


def upgrade(sock: socket.socket, host: str, port: int, token: str) -> bool:
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET /api/library/windows/watch?t={token} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(request.encode())
    head = bytearray()
    while not head.endswith(b"\r\n\r\n"):
        if len(head) > 16_384:
            raise ValueError("oversized upgrade response")
        head.extend(read_exact(sock, 1))
    lines = bytes(head).split(b"\r\n")
    fields = {}
    for line in lines[1:]:
        if b":" in line:
            name, value = line.split(b":", 1)
            name = name.strip().lower()
            if name in fields:
                raise ValueError("duplicate upgrade header")
            fields[name] = value.strip().lower() if name in (b"upgrade", b"connection") else value.strip()
    expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest())
    valid = (lines[0].startswith(b"HTTP/1.1 101 ")
             and fields.get(b"sec-websocket-accept") == expected
             and fields.get(b"upgrade") == b"websocket"
             and b"upgrade" in fields.get(b"connection", b"").split(b", "))
    # Do not echo untrusted response text, which could contain a URL/token.
    print(stamp(), "status", f"valid={int(valid)}", flush=True)
    return valid


def snapshot(sock: socket.socket) -> tuple[int, bytes]:
    first, second = read_exact(sock, 2)
    length = second & 0x7F
    if length == 126:
        length = struct.unpack(">H", read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", read_exact(sock, 8))[0]
    opcode = first & 0x0F
    if not first & 0x80 or first & 0x70 or second & 0x80 or length > 1_000_000:
        raise ValueError("unsupported fragmented or invalid server frame")
    if opcode not in (1, 8, 9, 10) or (opcode >= 8 and length > 125):
        raise ValueError("invalid server opcode or control length")
    return opcode, read_exact(sock, length)


def record(payload: bytes) -> None:
    message = json.loads(payload)
    windows = message["windows"]
    if not isinstance(windows, list):
        raise ValueError("window snapshot is not an array")
    ids = [window["window_id"] for window in windows]
    if (any(not isinstance(value, str) or not value.startswith("w-")
            or not value[2:] or any(c not in "0123456789abcdef" for c in value[2:]) for value in ids)
            or len(set(ids)) != len(ids)):
        raise ValueError("window snapshot has invalid or duplicate ids")
    live = sum(bool(window.get("token")) for window in windows)
    print(stamp(), "frame", f"n={len(windows)}", f"live={live}", f"ids={','.join(sorted(ids))}", flush=True)


def main() -> int:
    os.umask(0o077)
    host, port, token_path, seconds = sys.argv[1:5]
    stop = Path(sys.argv[5]) if len(sys.argv) == 6 else None
    token = Path(token_path).read_text().strip()
    if any(c in token for c in "\r\n "):
        raise ValueError("invalid bearer shape")
    deadline = time.monotonic() + float(seconds)
    upgrades = frames = 0
    while time.monotonic() < deadline and not (stop and stop.exists()):
        try:
            with socket.create_connection((host, int(port)), timeout=0.2) as sock:
                sock.settimeout(min(1.0, max(0.05, deadline - time.monotonic())))
                print(stamp(), "accept", flush=True)
                if not upgrade(sock, host, int(port), token):
                    time.sleep(0.05)
                    continue
                upgrades += 1
                while time.monotonic() < deadline and not (stop and stop.exists()):
                    opcode, payload = snapshot(sock)
                    if opcode == 1:
                        record(payload)
                        frames += 1
                    elif opcode == 8:
                        print(stamp(), "close", flush=True)
                        break
                    elif opcode == 9:
                        mask = os.urandom(4)
                        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
                        sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + masked)
        except (EOFError, OSError):
            print(stamp(), "end", flush=True)
            time.sleep(0.05)
        except (ValueError, KeyError, TypeError):
            print(stamp(), "invalid-frame", flush=True)
            return 3
    print(stamp(), "summary", f"upgrades={upgrades}", f"frames={frames}", flush=True)
    return 0 if upgrades and frames else 3


if __name__ == "__main__":
    sys.exit(main())
