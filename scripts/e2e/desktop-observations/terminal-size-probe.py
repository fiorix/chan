#!/usr/bin/env python3
"""Keep a real PTY alive and record each delivered SIGWINCH on Linux's monotonic clock."""

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        parser.error("a real PTY is required")
    if not args.output.is_absolute():
        parser.error("output must be absolute")
    with args.output.open("x", encoding="utf-8") as log:
        os.chmod(args.output, 0o600)
        sequence = 0

        def emit(kind: str) -> None:
            nonlocal sequence
            sequence += 1
            size = os.get_terminal_size(sys.stdout.fileno())
            record = {"sequence": sequence, "kind": kind, "pid": os.getpid(),
                      "monoMs": time.monotonic_ns() / 1_000_000,
                      "cols": size.columns, "rows": size.lines}
            line = (json.dumps(record, separators=(",", ":")) + "\n").encode()
            os.write(log.fileno(), line)
            os.write(sys.stdout.fileno(), line)

        # A signal handler can re-enter Python while a prior record is being
        # built. Consume blocked signals synchronously so records stay ordered.
        watched = {signal.SIGWINCH, signal.SIGUSR1}
        signal.pthread_sigmask(signal.SIG_BLOCK, watched)
        emit("start")
        while True:
            number = signal.sigwait(watched)
            emit("SIGWINCH" if number == signal.SIGWINCH else "checkpoint")


if __name__ == "__main__":
    main()
