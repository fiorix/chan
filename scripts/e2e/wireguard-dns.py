#!/usr/bin/env python3
"""Exercise endpoint changes inside a private user/mount namespace."""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
import ipaddress
from pathlib import Path
import re
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


def client_file(original: str, path: Path, endpoint_text: str) -> None:
    """The run's client file with its one Endpoint line replaced, owner-only."""
    lines = Path(original).read_text().splitlines()
    if sum(line.startswith("Endpoint = ") for line in lines) != 1:
        raise ValueError("client file must contain exactly one Endpoint")
    with path.open("x") as file:
        path.chmod(0o600)
        file.write("\n".join(f"Endpoint = {endpoint_text}" if line.startswith("Endpoint = ") else line for line in lines) + "\n")


def preflight(binary: str, original: str, target: str, work: Path, destinations: list[tuple[str, int]]) -> None:
    """Prove each forward answers from its own address before the proof
    moves between them. QEMU's user network sends every reply for a guest
    port out of the newest forward to that port, so a second forward to the
    WireGuard port answers the first path from the second's address, and the
    proof's connected relay socket drops those replies. One GET per path
    through an unconnected socket shows where the answers come from."""
    for index, destination in enumerate(destinations):
        number = index + 1
        with contextlib.ExitStack() as stack:
            selector = stack.enter_context(selectors.DefaultSelector())
            front = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
            front.bind(("127.0.0.1", 0))
            front.setblocking(False)
            back = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
            back.bind(("0.0.0.0", 0))
            back.setblocking(False)
            selector.register(front, selectors.EVENT_READ, True)
            selector.register(back, selectors.EVENT_READ, False)
            config = work / f"preflight-{number}.conf"
            client_file(original, config, f"127.0.0.1:{front.getsockname()[1]}")
            log = work / f"preflight-{number}.log"
            output = stack.enter_context(log.open("w"))
            process = subprocess.Popen([binary, str(config), target, "/hello.txt", "--timeout", "15"],
                                       stdout=output, stderr=subprocess.STDOUT)
            client = None
            answered = 0
            strays: set[tuple[str, int]] = set()
            deadline = time.monotonic() + 30
            try:
                while process.poll() is None:
                    if time.monotonic() >= deadline:
                        raise TimeoutError(f"forward {number} ({destination[0]}:{destination[1]}): the preflight GET did not finish")
                    for key, _ in selector.select(0.05):
                        try:
                            packet, source = key.fileobj.recvfrom(65535)
                        except (BlockingIOError, ConnectionRefusedError):
                            continue
                        if key.data:
                            client = source
                            back.sendto(packet, destination)
                        elif source != destination:
                            strays.add(source)
                        elif client is not None:
                            answered += 1
                            front.sendto(packet, client)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
            if strays:
                seen = ", ".join(f"{host}:{port}" for host, port in sorted(strays))
                raise RuntimeError(
                    f"forward {number} ({destination[0]}:{destination[1]}) answered from {seen}: "
                    "with QEMU user networking, forward the second endpoint to its own guest port "
                    "and redirect that port to the WireGuard port on the peer (see wireguard-kernel.sh --help)")
            if process.returncode != 0 or answered == 0:
                raise RuntimeError(
                    f"forward {number} ({destination[0]}:{destination[1]}): GET exited {process.returncode} "
                    f"after {answered} answer(s): {log.read_text()}")
            print(f"dns: preflight: forward {number} answers from {destination[0]}:{destination[1]}", flush=True)


@dataclass
class LateCutover:
    """Keep the new path dark until the copied probe misses and the old rekey completes."""

    started: float
    stage: str = "waiting-first-get"
    live_init: bytes | None = None
    dark_probe: bytes | None = None
    held_response: bytes | None = None
    released_at: float | None = None
    cutover_at: float | None = None
    request_at: float | None = None
    recovery_at: float | None = None
    next_init: bytes | None = None
    next_response: bool = False

    def note(self, now: float, message: str) -> None:
        print(f"dns-late: t={now - self.started:.3f}s stage={self.stage}: {message}", flush=True)

    def moved(self, now: float) -> None:
        self.stage = "waiting-rekey-and-probe"
        self.note(now, "record moved; new path dark, old path still serves")

    def forward(self, index: int, from_client: bool, packet: bytes, now: float) -> bool:
        initiation = len(packet) == 148 and packet[:4] == b"\x01\0\0\0"
        response = len(packet) == 92 and packet[:4] == b"\x02\0\0\0"
        if self.cutover_at is None:
            if index == 1:
                if from_client and initiation and self.dark_probe is None:
                    self.dark_probe = packet
                    self.note(now, "first probe dropped on the dark new path")
                return False
            if from_client and initiation:
                self.live_init = packet
                if self.held_response is not None and self.held_response[8:12] != packet[4:8]:
                    self.held_response = None
            if not from_client and response and self.live_init is not None and packet[8:12] == self.live_init[4:8]:
                self.held_response = packet
                self.note(now, "old-path rekey response held")
                return False
            return True
        if index == 0:
            return False
        if from_client and initiation:
            if self.live_init is not None and packet[4:8] == self.live_init[4:8]:
                raise RuntimeError("the new path received the completed attempt instead of a new initiation")
            self.next_init = packet
            self.note(now, "next attempt reaches the new path")
        if not from_client and response and self.next_init is not None and packet[8:12] == self.next_init[4:8]:
            self.next_response = True
            self.note(now, "new path answers the next attempt")
        return True

    def release(self, now: float) -> bytes | None:
        if self.released_at is not None or self.held_response is None or self.dark_probe is None:
            return None
        if self.dark_probe != self.live_init:
            raise RuntimeError("the dark probe is not a copy of the old path's initiation")
        self.released_at = now
        self.stage = "waiting-old-confirmation"
        self.note(now, "releasing the held response through the old path")
        return self.held_response

    def forwarded(self, index: int, from_client: bool, packet: bytes, now: float) -> None:
        if (self.cutover_at is None and self.released_at is not None and index == 0 and from_client
                and len(packet) >= 32 and packet[:4] == b"\x04\0\0\0"
                and self.held_response is not None and packet[4:8] == self.held_response[4:8]):
            self.cutover_at = now
            self.stage = "waiting-second-request"
            self.note(now, "old rekey confirmation forwarded; new path enabled, old path disabled")

    def progress(self, text: str, now: float) -> None:
        if "request 2: " in text and self.request_at is None:
            if self.cutover_at is None:
                raise RuntimeError("the second request began before the old rekey was confirmed")
            status = re.search(r"^status after hold: handshake ([0-9.]+)s ago,", text, re.M)
            if status is None or not 0 <= float(status[1]) < 30:
                raise RuntimeError("the second request lacks a fresh completed handshake")
            if now - self.cutover_at >= 30:
                raise RuntimeError("the second request did not begin within 30 seconds of cutover")
            self.request_at = now
            self.stage = "waiting-recovery"
            self.note(now, "second request began on the same client")
        if "body 2: " in text and self.recovery_at is None:
            if self.request_at is None or not self.next_response:
                raise RuntimeError("the second response lacks the next attempt's handshake on the new path")
            if now - self.request_at >= 30 or self.cutover_at is None or now - self.cutover_at >= 60:
                raise RuntimeError("recovery missed the next-attempt bound; stale-only recovery is not a pass")
            self.recovery_at = now
            self.stage = "recovered"
            self.note(now, f"second response completed {now - self.request_at:.3f}s after its request")

    def finish(self) -> None:
        if self.recovery_at is None:
            raise RuntimeError("missing the completed late-cutover proof")


def run(argv: list[str]) -> None:
    if len(argv) not in (8, 9):
        raise ValueError("expected binary, config, target, two forwards, directory, hold, namespace and optional mode")
    binary, original, target, first, second, directory, hold_text, parent_namespace = argv[:8]
    mode = argv[8] if len(argv) == 9 else "dns"
    if mode not in ("dns", "dns-late"):
        raise ValueError(f"unknown mode {mode}")
    destinations = [endpoint(first), endpoint(second)]
    if destinations[0] == destinations[1]:
        raise ValueError("the two forwarding endpoints must differ")
    hold = int(hold_text)
    if hold <= 120:
        raise ValueError("hold must exceed the 120-second rekey interval")
    if mode == "dns-late" and not 125 <= hold <= 140:
        raise ValueError("dns-late hold must be between 125 and 140 seconds")
    work = Path(directory)
    work.mkdir(mode=0o700)
    preflight(binary, original, target, work, destinations)
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
        client_file(original, config, f"{name}:{port}")
        log = work / "client.log"
        output = stack.enter_context(log.open("w"))
        process = subprocess.Popen(
            [binary, str(config), target, "/hello.txt", "--retry-for", "30", "--hold", str(hold)],
            stdout=output, stderr=subprocess.STDOUT,
        )
        stage = 0
        late = LateCutover(time.monotonic()) if mode == "dns-late" else None
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
                    print(f"{mode}: initial lookup failed; first endpoint added", flush=True)
                if stage == 1 and "hold: " in text:
                    hosts.write_text(f"127.0.0.1 localhost\n127.0.0.3 {name}\n")
                    stage = 2
                    if late is None:
                        print("dns: first GET completed; endpoint moved and old path disabled", flush=True)
                    else:
                        late.moved(time.monotonic())
                if late is not None:
                    late.progress(text, time.monotonic())
                for key, _ in selector.select(0.05):
                    index, from_client = key.data
                    sock = incoming[index] if from_client else outgoing[index]
                    try:
                        packet, source = sock.recvfrom(65535)
                    except (BlockingIOError, ConnectionRefusedError):
                        continue
                    if stage == 2:
                        if late is None and index == 0:
                            continue
                        if late is not None and not late.forward(index, from_client, packet, time.monotonic()):
                            response = late.release(time.monotonic())
                            if response is not None:
                                incoming[0].sendto(response, clients[0])
                            continue
                    if from_client:
                        clients[index] = source
                        if index == 1 and len(packet) == 148 and packet[:4] == b"\x01\0\0\0":
                            moved_initiations += 1
                        outgoing[index].send(packet)
                    elif index in clients:
                        incoming[index].sendto(packet, clients[index])
                    if stage == 2 and late is not None:
                        late.forwarded(index, from_client, packet, time.monotonic())
            if late is not None:
                late.progress(log.read_text(), time.monotonic())
            if process.returncode != 0:
                raise RuntimeError(f"client exited {process.returncode}: {log.read_text()}")
            if stage != 2 or moved_initiations == 0:
                raise RuntimeError("missing initial failure, recovery, or initiation through the new endpoint")
            if late is not None:
                late.finish()
            print(f"{mode}: PASS: same client recovered; {moved_initiations} initiation(s) on the second forward")
        except (OSError, RuntimeError) as error:
            stopped = late.stage if late is not None else str(stage)
            raise RuntimeError(f"stage={stopped}: {error}") from error
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
        mode = "dns-late" if sys.argv[-1:] == ["dns-late"] else "dns"
        print(f"{mode}: FAIL: {error}", file=sys.stderr)
        sys.exit(1)
