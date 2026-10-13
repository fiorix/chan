#!/usr/bin/env python3
"""Draw a PTY-sized alternate-screen frame and record each redraw."""

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time


def write_all(fd: int, data: bytes) -> None:
    while data:
        data = data[os.write(fd, data):]


def frame(cols: int, rows: int, redraw_count: int) -> bytes:
    border = "+" + "-" * max(0, cols - 2) + ("+" if cols > 1 else "")
    label = f"full-screen {cols}x{rows} redraw {redraw_count}"
    output = ["\x1b[H\x1b[2J"]
    for row in range(1, rows + 1):
        if row in (1, rows):
            line = border
        elif cols > 1:
            content = label[:cols - 2] if row == 2 else ""
            line = "|" + content.ljust(cols - 2) + "|"
        else:
            line = "|"
        output.append(f"\x1b[{row};1H{line}")
    return "".join(output).encode("ascii")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.error("a real PTY is required")
    if not args.output.is_absolute():
        parser.error("output must be absolute")

    log_fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    sequence = 0
    redraw_count = 0
    screen_entered = False

    def emit(kind: str, size: os.terminal_size, **extra: object) -> None:
        nonlocal sequence
        sequence += 1
        record = {"sequence": sequence, "kind": kind, "pid": os.getpid(),
                  "monoMs": time.monotonic_ns() / 1_000_000,
                  "cols": size.columns, "rows": size.lines, **extra}
        write_all(log_fd, (json.dumps(record, separators=(",", ":")) + "\n").encode())

    def redraw(trigger: str, size: os.terminal_size) -> None:
        nonlocal redraw_count
        redraw_count += 1
        write_all(sys.stdout.fileno(), frame(size.columns, size.lines, redraw_count))
        emit("redraw", size, redrawCount=redraw_count, trigger=trigger)

    watched = {signal.SIGWINCH, signal.SIGUSR1, signal.SIGTERM, signal.SIGINT, signal.SIGHUP}
    old_mask = signal.pthread_sigmask(signal.SIG_BLOCK, watched)
    try:
        write_all(sys.stdout.fileno(), b"\x1b[?1049h\x1b[?25l")
        screen_entered = True
        size = os.get_terminal_size(sys.stdout.fileno())
        emit("start", size)
        redraw("start", size)
        while True:
            number = signal.sigwait(watched)
            size = os.get_terminal_size(sys.stdout.fileno())
            if number == signal.SIGWINCH:
                emit("SIGWINCH", size)
                redraw("SIGWINCH", size)
            elif number == signal.SIGUSR1:
                emit("checkpoint", size)
            else:
                break
    finally:
        if screen_entered:
            write_all(sys.stdout.fileno(), b"\x1b[?25h\x1b[?1049l")
        signal.pthread_sigmask(signal.SIG_SETMASK, old_mask)
        os.close(log_fd)


if __name__ == "__main__":
    main()
