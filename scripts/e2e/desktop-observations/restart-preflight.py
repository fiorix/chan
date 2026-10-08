#!/usr/bin/env python3
"""Exercise restart instruments on constructed inputs, without a desktop arm."""

import argparse
import base64
import copy
from decimal import Decimal
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading

HERE = Path(__file__).resolve().parent
BASE_NS = 1_700_000_000_000_000_000


def tick(n: int) -> int:
    return BASE_NS + n * 1_000_000


def fixture() -> dict:
    def check(stage: str, n: int, state: str) -> dict:
        return {"stage": stage, "started_at_ns": tick(n), "at_ns": tick(n) + 100_000,
                "desktop_alive": True, "terminal_x_state": "shown", "display_x_state": "shown",
                "selected_x_state": state, "page_ready": stage == "reconnect"}
    label = "lib-a::w-a"
    common = {"label": label, "watcher": "1", "pass": "2"}
    return {
        "pin": {"library_id": "lib-a", "window_id": "w-a", "label": label,
                "x_id": "30", "x_title": "fixture Window 2", "root": "/fixture"},
        "controls": {"terminal_x_id": "20", "launcher_x_id": "10"},
        "checkpoints": [check("pre-stop", 1, "shown"), check("after-stop", 2, "shown"),
                        check("held", 9, "gone"), check("mounted", 12, "gone"), check("reconnect", 14, "gone")],
        "events": [dict(common, event="pass", at_ns=tick(5), branch="running", snapshot_ids="w-b",
                        snapshot_present="false", suppressed="false", actual="true", desired="false", close_decision="true"),
                   dict(common, event="close_decision", at_ns=tick(6), branch="running"),
                   dict(common, event="native_close_dispatch", at_ns=tick(7), scheduled="true"),
                   dict(common, event="native_destroy", at_ns=tick(8), found="true", destroy_ok="true")],
        "rows": [{"at_ns": tick(4), "match_count": 1, "status": "starting", "on": False, "token_present": False},
                 {"at_ns": tick(11), "match_count": 1, "status": "running", "on": True, "token_present": True}],
        "after-records": [{"library_id": "lib-a", "window_id": "w-a", "token": "constructed"}],
        "after-rows": [{"path": "/fixture", "on": True, "token": "constructed"}],
        "clock": [{"stage": "before", "wall_ns": tick(0), "mono_ns": tick(0)},
                  {"stage": "after", "wall_ns": tick(20), "mono_ns": tick(20)}],
        "gate": f"RESTART_GATE arrived at_ns={tick(3)}\nRESTART_GATE released at_ns={tick(10)}\n",
        "feed": f"{Decimal(tick(4)) / 10**9} status valid=1\n"
                f"{Decimal(tick(4)) / 10**9} frame n=1 live=1 ids=w-b\n"
                f"{Decimal(tick(13)) / 10**9} frame n=2 live=2 ids=w-a,w-b\n",
        "final-windows": "10 Chan Desktop\n20 Terminal Window 1\n",
    }


def write_inputs(root: Path, data: dict) -> None:
    root.mkdir()
    for name, value in data.items():
        if name in ("checkpoints", "events", "rows", "clock"):
            content = "".join(json.dumps(row) + "\n" for row in value)
        elif isinstance(value, str):
            content = value
        else:
            content = json.dumps(value) + "\n"
        (root / name).write_text(content)


def run(args: list[str], root: Path, name: str, expected: int) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, text=True, timeout=20)
    (root / f"{name}.stdout").write_text(result.stdout)
    (root / f"{name}.stderr").write_text(result.stderr)
    (root / f"{name}.status").write_text(f"{result.returncode}\n")
    if result.returncode != expected:
        raise AssertionError(f"{name}: expected {expected}, got {result.returncode}: {result.stderr}")
    print(f"constructed {name}: expected rc{expected}", flush=True)
    return result


def verdict(root: Path, name: str, data: dict, expected: int, reason: str,
            arm: str = "graceful-delayed", **fields: object) -> None:
    case = root / name
    write_inputs(case, data)
    command = [sys.executable, str(HERE / "restart-evidence.py"), "verdict", "--arm", arm]
    for key in data:
        command += [f"--{key}", str(case / key)]
    command += ["--output", str(case / "summary.json")]
    run(command, case, "reader", expected)
    summary = json.loads((case / "summary.json").read_text())
    for key, value in dict(status=expected, reason=reason, arm=arm, run_kind="constructed", **fields).items():
        if summary.get(key) != value:
            raise AssertionError(f"{name}: expected {key}={value!r}, got {summary.get(key)!r}")


def readers(root: Path) -> None:
    positive = fixture()
    closure_reason = "consumed-omission-close-destroy-old-x-gone"
    unjoined_reason = "old-x-gone-without-complete-startup-join"
    verdict(root, "closure", positive, 10, closure_reason, parallel_id_set_match=True)
    for name, reason, mutate in (
        ("missing-gate", "gate-events-missing", lambda d: d.update(gate="")),
        ("arrival-before-stop", "gate-arrival-before-old-server-exit", lambda d: d.update(gate=d["gate"].replace(str(tick(3)), str(tick(1))))),
        ("held-after-release", "x-not-sampled-inside-gate", lambda d: d.update(gate=d["gate"].replace(str(tick(10)), str(tick(4))))),
        ("expired-gate", "gate-expired", lambda d: d.update(gate=d["gate"].replace("released", "expired"))),
        ("event-outside-run", "native-event-outside-clock-bracket", lambda d: d["events"][-2].update(at_ns=tick(1000))),
        ("duplicate-pass", "duplicate-native-pass-event", lambda d: d["events"].append(d["events"][0])),
        ("wrong-pass", unjoined_reason, lambda d: d["events"][-1].update({"pass": "9"})),
        ("failed-destroy", unjoined_reason, lambda d: d["events"][-1].update(destroy_ok="false")),
        ("stop-loss", "selected-x-lost-before-restart", lambda d: d["checkpoints"][1].update(selected_x_state="gone")),
        ("dead-display", "desktop-or-control-x-lost", lambda d: d["checkpoints"][-1].update(display_x_state="gone")),
        ("suppressed-label", unjoined_reason, lambda d: d["events"][0].update(suppressed="true")),
        ("contradictory-ids", unjoined_reason, lambda d: d["events"][0].update(snapshot_ids="w-a,w-b")),
        ("missing-frame", "starting-or-validated-feed-interval-missing", lambda d: d.update(feed=d["feed"].replace("ids=w-b", "ids=w-a"))),
        ("invalid-upgrade", "feed-frame-without-valid-upgrade", lambda d: d.update(feed=d["feed"].replace("valid=1", "valid=0"))),
        ("duplicate-frame-id", "feed-ids-duplicate-or-inconsistent", lambda d: d.update(feed=d["feed"].replace("n=2 live=2 ids=w-a,w-b", "n=2 live=2 ids=w-a,w-a"))),
        ("clock-jump", "guest-clock-discontinuity", lambda d: d["clock"][-1].update(wall_ns=tick(100))),
        ("lost-persisted-record", "same-persisted-id-not-restored", lambda d: d.update({"after-records": []})),
        ("native-loss-cause-unassigned", unjoined_reason, lambda d: d.update(events=[])),
        ("missing-gate-checkpoint", "x-not-sampled-inside-gate", lambda d: d["checkpoints"].pop(2)),
    ):
        data = copy.deepcopy(positive)
        mutate(data)
        verdict(root, name, data, 3, reason)
    data = copy.deepcopy(positive)
    data["checkpoints"][-1]["page_ready"] = False
    verdict(root, "closure-no-page", data, 10, closure_reason)
    data = copy.deepcopy(positive)
    data["feed"] = data["feed"].replace("ids=w-b", "ids=w-c")
    verdict(root, "different-parallel-id-set", data, 10, closure_reason, parallel_id_set_match=False)
    data = copy.deepcopy(positive)
    for n, event in enumerate(data["events"], 11):
        event["at_ns"] = tick(n)
    data["checkpoints"][2]["selected_x_state"] = "shown"
    for check, n in zip(data["checkpoints"][3:], (18, 19)):
        check.update(started_at_ns=tick(n), at_ns=tick(n) + 100_000)
    data["rows"][-1]["at_ns"] = tick(16)
    data["feed"] = data["feed"].replace(str(Decimal(tick(13)) / 10**9), str(Decimal(tick(17)) / 10**9))
    verdict(root, "pass-after-release", data, 3, unjoined_reason)
    # Exercise the exact CLI predicate used before either delayed release.
    for arm in ("graceful-delayed", "kill-delayed"):
        verdict(root, arm + "-closure", positive, 10, closure_reason, arm)
        for case_name, expected in (("closure", 0), ("native-loss-cause-unassigned", 3)):
            case = root / case_name
            command = [sys.executable, str(HERE / "restart-evidence.py"), "exposed"]
            for key in ("pin", "events", "rows", "feed"):
                command += [f"--{key}", str(case / key)]
            run(command, root, arm + "-exposed-" + case_name, expected)
    data = copy.deepcopy(positive)
    data["events"] = data["events"][:1]
    data["events"][0].update(desired="true", close_decision="false")
    for check in data["checkpoints"]:
        check["selected_x_state"] = "shown"
    data["final-windows"] += "30 fixture Window 2\n"
    verdict(root, "survived-exposure", data, 0, "consumed-omission-original-x-and-page-survived")
    unexposed = copy.deepcopy(data)
    unexposed["events"] = []
    verdict(root, "fixture-only", unexposed, 3, "no-consumed-omission-inside-restore-interval")
    data["checkpoints"][-1]["page_ready"] = False
    verdict(root, "survival-no-page", data, 3, "survival-page-or-original-x-not-proved")
    for arm in ("graceful-fast", "kill-fast"):
        data = copy.deepcopy(positive)
        data.pop("gate")
        verdict(root, arm + "-closure", data, 10, closure_reason, arm)
        data = copy.deepcopy(unexposed)
        data.pop("gate")
        verdict(root, arm + "-fixture-only", data, 3, "no-consumed-omission-inside-restore-interval", arm)
    for arm in ("off-control", "discard-control"):
        data = copy.deepcopy(positive)
        data.pop("gate")
        data.pop("rows")
        data["action"] = {"at_ns": tick(3)}
        data["checkpoints"] = [data["checkpoints"][0], data["checkpoints"][2]]
        data["checkpoints"][0]["stage"] = "pre-action"
        data["checkpoints"][1]["stage"] = "after-action"
        data["after-records"] = []
        if arm == "off-control":
            data["after-rows"][0].update(on=False, token=None)
            data["restored-records"] = positive["after-records"]
            data["restored-rows"] = positive["after-rows"]
        verdict(root, arm, data, 0, "published-removal-and-old-x-destroyed", arm)
        data["events"][-1]["watcher"] = "99"
        verdict(root, arm + "-wrong-watcher", data, 3, "control-native-close-join-missing", arm)
    run(["bash", str(HERE / "restart-startup.sh"), "invalid-arm"], root, "driver-rejects-invalid-arm", 3)


def instruments(root: Path) -> None:
    token = root / "token"
    token.write_text("constructed-token")

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def log_message(self, *_args: object) -> None:
            pass

        def do_GET(self) -> None:
            self.close_connection = True
            if self.path.startswith("/api/library/windows/watch"):
                accept = base64.b64encode(hashlib.sha1((self.headers["Sec-WebSocket-Key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
                self.send_response_only(101)
                self.send_header("Upgrade", "websocket")
                self.send_header("Connection", "Upgrade")
                self.send_header("Sec-WebSocket-Accept", accept)
                self.end_headers()
                body = json.dumps({"windows": [{"window_id": "w-a", "token": "private"}]}).encode()
                self.wfile.write(bytes([0x81, len(body)]) + body)
            else:
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps([{"path": "/fixture", "status": "starting", "on": False, "prefix": "/workspace-a"}]).encode())

    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        server.timeout = 1
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = str(server.server_port)
            feed = run([sys.executable, str(HERE / "restart-feed.py"), "127.0.0.1", port, str(token), "0.2"], root, "feed-protocol", 0)
            if "frame n=1 live=1 ids=w-a" not in feed.stdout or "private" in feed.stdout or "constructed-token" in feed.stdout:
                raise AssertionError("feed did not record a token-free positive control")
            run([sys.executable, str(HERE / "restart-rows.py"), port, str(token), "/fixture", "0.2",
                 str(root / "selected.rows"), str(root / "raw.rows")], root, "row-protocol", 0)
            selected = [json.loads(line) for line in (root / "selected.rows").read_text().splitlines()]
            if not selected or any(row.get("status") != "starting" for row in selected):
                raise AssertionError("row recorder did not identify the exact constructed root")
        finally:
            server.shutdown()
            thread.join(timeout=2)
    for invalid in (b'{"other":[]}', b'{"windows":[{"window_id":"w-a"},{"window_id":"w-a"}]}'):
        # Use the recorder's parser, in addition to the process-level protocol
        # control above, to exercise malformed shape without opening a server.
        import importlib.util
        spec = importlib.util.spec_from_file_location("restart_feed", HERE / "restart-feed.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            module.record(invalid)
        except (ValueError, KeyError):
            pass
        else:
            raise AssertionError("malformed snapshot accepted")
    identity = root / "observer"
    identity.mkdir()
    record = {"library_id": "lib-a", "window_id": "w-a", "workspace_path": "/fixture", "kind": "workspace",
              "persisted": True, "connected": True, "hidden": False, "token": "private", "ordinal": 2, "holders": ["private"]}
    (identity / "records").write_text(json.dumps([record]))
    (identity / "before").write_text("10\n20\n")
    (identity / "windows").write_text("10 Chan Desktop\n20 Terminal Window 1\n30 fixture Window 2\n")
    run([sys.executable, str(HERE / "restart-observer.py"), "pin", "--records", str(identity / "records"),
         "--root", "/fixture", "--unique-name", "fixture", "--before-ids", str(identity / "before"),
         "--windows", str(identity / "windows"), "--desktop-pid", str(os.getpid()),
         "--label-file", str(identity / "label"), "--output", str(identity / "pin")], root, "observer-pin", 0)
    (identity / "native.log").write_text(f"RESTART_OBS pass at_ns={tick(5)} watcher=1 pass=2 branch=running label=lib-a::w-a snapshot_ids=w-b snapshot_present=false suppressed=false actual=true desired=false close_decision=true\n")
    run([sys.executable, str(HERE / "restart-observer.py"), "events", "--pin", str(identity / "pin"),
         "--desktop-log", str(identity / "native.log"), "--output", str(identity / "events")], root, "observer-events", 0)
    if len((identity / "events").read_text().splitlines()) != 1 or (identity / "label").read_text() != "lib-a::w-a\n":
        raise AssertionError("observer did not preserve exact identity")
    socket_path = root / "gate.sock"
    nonce_path = root / "nonce"
    nonce_path.write_text("0123456789abcdef" * 2)
    with socket.socket(socket.AF_UNIX) as listener:
        listener.bind(str(socket_path))
        listener.listen()
        listener.settimeout(2)
        run([sys.executable, str(HERE / "restart-evidence.py"), "release-gate", "--socket", str(socket_path),
             "--nonce-file", str(nonce_path)], root, "gate-client", 0)
        with listener.accept()[0] as client:
            if client.recv(100) != nonce_path.read_bytes() + b"\n":
                raise AssertionError("nonce client sent a different release")


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="new private evidence directory")
    args = parser.parse_args()
    args.output.mkdir()
    readers(args.output)
    instruments(args.output)
    print("constructed preflights passed; no native behavior observed")


if __name__ == "__main__":
    main()
