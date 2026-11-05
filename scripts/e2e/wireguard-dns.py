#!/usr/bin/env python3
"""Exercise endpoint changes inside a private user/mount namespace."""

from __future__ import annotations

import contextlib
import ipaddress
from pathlib import Path
import selectors
import socket
import subprocess
import sys
import time


def endpoint(text: str) -> tuple[str, int]:
    host, port = text.rsplit(":", 1)
    address = ipaddress.IPv4Address(host)
    number = int(port)
    if not 0 < number < 65536:
        raise ValueError("endpoint port must be between 1 and 65535")
    return str(address), number


def run(argv: list[str]) -> None:
    binary, original, target, first, second, directory, hold_text, parent_namespace = argv
    destinations = [endpoint(first), endpoint(second)]
    if destinations[0] == destinations[1]:
        raise ValueError("the two forwarding endpoints must differ")
    hold = int(hold_text)
    if hold <= 120:
        raise ValueError("hold must exceed the 120-second rekey interval")
    work = Path(directory)
    work.mkdir(mode=0o700)
    hosts = work / "hosts"
    hosts.write_text("127.0.0.1 localhost\n")
    nsswitch = work / "nsswitch.conf"
    nsswitch.write_text("hosts: files\n")
    # The caller enters a new user/mount namespace first. Refuse a direct
    # invocation rather than mounting over the operator's resolver files.
    if not parent_namespace.startswith("mnt:[") or str(Path("/proc/self/ns/mnt").readlink()) == parent_namespace:
        raise RuntimeError("a private mount namespace is required")
    subprocess.run(["mount", "--make-rprivate", "/"], check=True)
    for source, target_file in [(hosts, "/etc/hosts"), (nsswitch, "/etc/nsswitch.conf")]:
        subprocess.run(["mount", "--bind", str(source), target_file], check=True)

    with contextlib.ExitStack() as stack:
        selector = stack.enter_context(selectors.DefaultSelector())
        incoming: list[socket.socket] = []
        outgoing: list[socket.socket] = []
        clients: dict[int, tuple[str, int]] = {}
        port = 0
        for index, host in enumerate(["127.0.0.2", "127.0.0.3"]):
            front = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
            front.bind((host, port))
            port = front.getsockname()[1]
            front.setblocking(False)
            back = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
            back.connect(destinations[index])
            back.setblocking(False)
            selector.register(front, selectors.EVENT_READ, (index, True))
            selector.register(back, selectors.EVENT_READ, (index, False))
            incoming.append(front)
            outgoing.append(back)

        name = "chan-wireguard-endpoint.invalid"
        config = work / "client.conf"
        lines = Path(original).read_text().splitlines()
        if sum(line.startswith("Endpoint = ") for line in lines) != 1:
            raise ValueError("client file must contain exactly one Endpoint")
        with config.open("x") as file:
            config.chmod(0o600)
            file.write("\n".join(f"Endpoint = {name}:{port}" if line.startswith("Endpoint = ") else line for line in lines) + "\n")
        log = work / "client.log"
        output = stack.enter_context(log.open("w"))
        process = subprocess.Popen(
            [binary, str(config), target, "/hello.txt", "--retry-for", "30", "--hold", str(hold)],
            stdout=output, stderr=subprocess.STDOUT,
        )
        stage = 0
        moved_initiations = 0
        deadline = time.monotonic() + hold + 90
        try:
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError("client did not finish the DNS recovery proof")
                text = log.read_text()
                if stage == 0 and "retry: " in text and "endpoint did not resolve" in text:
                    # Write in place: a bind mount follows this inode.
                    hosts.write_text(f"127.0.0.1 localhost\n127.0.0.2 {name}\n")
                    stage = 1
                    print("dns: initial lookup failed; first endpoint added", flush=True)
                if stage == 1 and "hold: " in text:
                    hosts.write_text(f"127.0.0.1 localhost\n127.0.0.3 {name}\n")
                    stage = 2
                    print("dns: first GET completed; endpoint moved and old path disabled", flush=True)
                for key, _ in selector.select(0.05):
                    index, from_client = key.data
                    sock = incoming[index] if from_client else outgoing[index]
                    try:
                        packet, source = sock.recvfrom(65535)
                    except (BlockingIOError, ConnectionRefusedError):
                        continue
                    if stage == 2 and index == 0:
                        continue
                    if from_client:
                        clients[index] = source
                        if index == 1 and len(packet) == 148 and packet[:4] == b"\x01\0\0\0":
                            moved_initiations += 1
                        outgoing[index].send(packet)
                    elif index in clients:
                        incoming[index].sendto(packet, clients[index])
            if process.returncode != 0:
                raise RuntimeError(f"client exited {process.returncode}: {log.read_text()}")
            if stage != 2 or moved_initiations == 0:
                raise RuntimeError("missing initial failure, recovery, or initiation through the new endpoint")
            print(f"dns: PASS: same client recovered; {moved_initiations} initiation(s) on the second forward")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    try:
        run(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"dns: FAIL: {error}", file=sys.stderr)
        sys.exit(1)
