#!/usr/bin/env python3
"""Observe a stock desktop gateway sign-in with an abandoned browser hand-off.

The capture command is a private xdg-open shim. Raw authorize URLs stay in
the disposable guest directory; exported readings contain no callback nonce.
"""

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
reader = runpy.run_path(str(HERE / "gateway-signin-reader.py"))
classify = reader["classify"]


class EnvironmentUnavailable(Exception):
    """The native preflight cannot reach the sign-in wait."""


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n")


def append_json(path: Path, value: Any) -> None:
    with path.open("a") as stream:
        stream.write(json.dumps(value) + "\n")


def capture(url: str) -> None:
    work = Path(os.environ["GWCANC_WORK"])
    parsed = urlsplit(url)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
        raise ValueError("opener refused a non-fixture origin")
    fields = parse_qs(parsed.query)
    if parsed.path != "/desktop/authorize" or not {"state", "redirect_uri", "code_challenge"} <= fields.keys():
        raise ValueError("opener refused an unexpected authorize URL")
    stamp = {"monotonic_ns": time.monotonic_ns(), "time_ns": time.time_ns()}
    append_json(work / "authorize-private.jsonl", {**stamp, "url": url})
    masked = urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                        urlencode({key: "<redacted>" for key in fields}), ""))
    append_json(work / "authorize-masked.jsonl", {**stamp, "url": masked})


class Fixture:
    def __init__(self, endpoint: str, work: Path, cancel: bool = False, controls_only: bool = False,
                 gesture: str | None = None):
        self.endpoint = endpoint
        self.work = work
        self.origin = ""
        self.token = ""
        self.gateway_id = ""
        self.stub_origin = ""
        self.phase = "preflight"
        self.cancel = cancel
        self.controls_only = controls_only
        self.gesture = gesture
        self.wait_class = "live-cancel" if cancel else "disabled-wait"
        self.pointer: dict[str, Any] | None = None

    def evaluate(self, expression: str) -> Any:
        result = subprocess.run(
            ["node", str(HERE / "inspect.mjs"), self.endpoint, "eval", "", expression],
            capture_output=True, text=True, timeout=15, check=False,
        )
        if result.returncode != 0:
            # The inspector's page listing can include the launcher's token.
            raise RuntimeError(f"native inspector failed with status {result.returncode}")
        return json.loads(result.stdout)

    def api(self, method: str, path: str, body: Any = None) -> Any:
        headers = {"Authorization": "Bearer " + self.token}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode()
        request = Request(self.origin + path, data=data, headers=headers, method=method)
        with urlopen(request, timeout=10) as response:
            append_json(self.work / "api-requests.jsonl", {"monotonic_ns": time.monotonic_ns(), "method": method, "path": path, "status": response.status})
            data = response.read()
            return json.loads(data) if data else None

    def wait_launcher(self) -> None:
        end = time.monotonic() + 30
        while time.monotonic() < end:
            try:
                context = self.evaluate("({origin: location.origin, token: new URLSearchParams(location.search).get('t'), ready: !!document.querySelector('[aria-label=\"Show gateways\"]')})")
                if context["ready"]:
                    parsed = urlsplit(context["origin"])
                    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1":
                        raise EnvironmentUnavailable("launcher is not guest-loopback HTTP")
                    self.origin, self.token = context["origin"], context["token"] or ""
                    return
            except (RuntimeError, json.JSONDecodeError):
                pass
            time.sleep(0.2)
        raise EnvironmentUnavailable("native launcher did not expose its gateway screen in 30 seconds")

    def card_expression(self) -> str:
        return "Array.from(document.querySelectorAll('.gateway-card')).filter(c => c.querySelector('.gw-url')?.textContent === " + json.dumps(self.stub_origin) + ")"

    def sample(self) -> dict[str, Any]:
        start = time.monotonic_ns()
        rows = self.api("GET", "/api/library/gateways")
        rows = [row for row in rows if row["id"] == self.gateway_id]
        if len(rows) != 1:
            raise ValueError("launcher API lost the fixture row")
        row = {key: rows[0][key] for key in ("id", "status", "pending_signin", "last_error", "enabled")}
        card = self.evaluate("""(() => {
            const cards = """ + self.card_expression() + """;
            const controls = cards[0] ? Array.from(cards[0].querySelectorAll('.gateway-actions button')).filter(b => b.title !== 'Rename') : [];
            const b = controls[0];
            return {count: cards.length, control_count: controls.length,
                control: b ? {title: b.title, aria_label: b.getAttribute('aria-label'), disabled: b.disabled,
                    focused: document.activeElement === b, same_element: window.__gatewayControl === b} : null,
                prompt: cards[0]?.querySelector('.gateway-prompt')?.textContent.trim() ?? null,
                notices: Array.from(document.querySelectorAll('.notice-bubble')).map(n => ({title: n.querySelector('.nb-title')?.textContent, message: n.querySelector('.nb-message')?.textContent})),
                connect_requests: window.__gatewayObservationRequests.filter(r => r.action === 'connect').length,
                disconnect_requests: window.__gatewayObservationRequests.filter(r => r.action === 'disconnect').length};
        })()""")
        sample = {"phase": self.phase, "start_ns": start, "end_ns": time.monotonic_ns(),
                  "time_ns": time.time_ns(), "row": row, "card": card,
                  "opens": len(self.captures())}
        sample["classification"] = classify(sample)
        append_json(self.work / "samples.jsonl", sample)
        return sample

    def captures(self) -> list[dict[str, Any]]:
        path = self.work / "authorize-private.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def click(self) -> dict[str, Any]:
        return self.evaluate("""(() => {
            const cards = """ + self.card_expression() + """;
            if (cards.length !== 1) throw Error('missing or duplicate gateway card');
            const buttons = Array.from(cards[0].querySelectorAll('.gateway-actions button')).filter(b => b.title !== 'Rename');
            if (buttons.length !== 1) throw Error('ambiguous connection control');
            const b = buttons[0];
            const before = {title: b.title, aria_label: b.getAttribute('aria-label'), disabled: b.disabled};
            b.click();
            return before;
        })()""")

    def wait_for(self, expected: str, seconds: float) -> dict[str, Any]:
        end = time.monotonic() + seconds
        last = None
        while time.monotonic() < end:
            last = self.sample()
            if last["classification"] == expected:
                return last
            if self.phase == "preflight" and expected == self.wait_class and last["row"].get("last_error"):
                raise EnvironmentUnavailable("native connect refused: " + last["row"]["last_error"])
            time.sleep(0.2)
        raise RuntimeError(f"did not observe {expected} in {seconds}s; last state {last['classification'] if last else 'absent'}")

    def connect(self) -> dict[str, Any]:
        before = self.sample()
        if before["classification"] != "disconnected":
            raise ValueError("connect did not start from a live Connect control")
        control = self.click()
        write_json(self.work / f"{self.phase}-clicked.json", control)
        pending = self.wait_for(self.wait_class, 15)
        opener_deadline = time.monotonic() + 5
        while pending["opens"] == before["opens"] and time.monotonic() < opener_deadline:
            time.sleep(0.1)
            pending = self.sample()
        if pending["opens"] != before["opens"] + 1:
            raise EnvironmentUnavailable("the native opener did not reach the private shim exactly once")
        if pending["card"]["connect_requests"] != before["card"]["connect_requests"] + 1:
            raise ValueError("Connect did not make exactly one observed launcher request")
        return pending

    def native_window(self) -> str:
        command = ["xdotool", "search", "--onlyvisible", "--name", "^Chan Desktop$"]
        started = time.monotonic_ns()
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
        except subprocess.TimeoutExpired as error:
            append_json(self.work / "native-window.jsonl", {"command": command, "phase": self.phase,
                        "start_ns": started, "end_ns": time.monotonic_ns(), "status": None,
                        "count": None, "timed_out": True})
            raise RuntimeError("native launcher window search timed out after 15 seconds") from error
        windows = result.stdout.split()
        valid_ids = all(window.isdigit() for window in windows)
        append_json(self.work / "native-window.jsonl", {"command": command, "phase": self.phase,
                    "start_ns": started, "end_ns": time.monotonic_ns(), "status": result.returncode,
                    "count": len(windows), "valid_ids": valid_ids, "timed_out": False})
        if result.returncode or len(windows) != 1 or not valid_ids:
            raise RuntimeError("native input needs exactly one visible launcher window: "
                               f"search status={result.returncode}, count={len(windows)}, valid_ids={valid_ids}")
        return windows[0]

    def native_action(self, kind: str) -> dict[str, Any]:
        """Deliver through X, retaining the page's actual trusted events."""
        window = self.native_window()
        for argv in (["windowactivate", "--sync", window], ["windowraise", window]):
            subprocess.run(["xdotool", *argv], capture_output=True, timeout=15, check=True)
        target = self.evaluate("""(() => {
            const cards = """ + self.card_expression() + """;
            const b = cards[0]?.querySelector('.gateway-actions button:not([title="Rename"])');
            if (cards.length !== 1 || !b || b.disabled) throw Error('no live native control');
            b.scrollIntoView({block: 'center'});
            window.__gatewayControl = b;
            const r = b.getBoundingClientRect();
            return {x: r.x + r.width/2, y: r.y + r.height/2, width: innerWidth, height: innerHeight,
                title: b.title, focused: document.activeElement === b};
        })()""")
        start = time.monotonic_ns()
        if kind == "tab":
            # Tab reaches the target from the engine's current focus; no DOM focus call.
            count = 0
            while count == 0 or not self.evaluate("document.activeElement === window.__gatewayControl"):
                if count == 40:
                    raise RuntimeError("Tab did not reach the gateway control in 40 keys")
                subprocess.run(["xdotool", "key", "--clearmodifiers", "Tab"], capture_output=True, timeout=15, check=True)
                count += 1
            target["tab_count"] = count
        elif kind == "enter":
            if not target["focused"]:
                raise ValueError("native Enter requires the gateway control focused")
            subprocess.run(["xdotool", "key", "--clearmodifiers", "Return"], capture_output=True, timeout=15, check=True)
        elif kind in {"click", "double"}:
            geometry = subprocess.run(["xdotool", "getwindowgeometry", "--shell", window],
                                      capture_output=True, text=True, timeout=15, check=True)
            values = dict(line.split("=", 1) for line in geometry.stdout.splitlines())
            if self.pointer is None or self.pointer["page"] != {"width": target["width"], "height": target["height"]} or self.pointer["window"] != {"width": int(values["WIDTH"]), "height": int(values["HEIGHT"])}:
                raise EnvironmentUnavailable("native pointer mapping is absent or its geometry changed")
            offset = self.pointer["offset"]
            argv = ["xdotool", "mousemove", "--window", window,
                    str(round(target["x"] + offset["x"])), str(round(target["y"] + offset["y"])), "click", "--clearmodifiers"]
            if kind == "double":
                argv += ["--repeat", "2", "--delay", "100"]
            subprocess.run([*argv, "1"], capture_output=True, timeout=15, check=True)
        else:
            raise ValueError("unknown native action")
        action = {"kind": kind, "window_id": int(window), "target": target,
                  "start_ns": start, "end_ns": time.monotonic_ns(), "phase": self.phase}
        append_json(self.work / "actions.jsonl", action)
        return action

    def calibrate_pointer(self) -> None:
        window_id = self.native_window()
        subprocess.run(["xdotool", "windowactivate", "--sync", window_id], capture_output=True, timeout=15, check=True)
        geometry = subprocess.run(["xdotool", "getwindowgeometry", "--shell", window_id],
                                  capture_output=True, text=True, timeout=15, check=True)
        values = dict(line.split("=", 1) for line in geometry.stdout.splitlines())
        window = {"width": int(values["WIDTH"]), "height": int(values["HEIGHT"])}
        page = self.evaluate("""(() => {
            if (devicePixelRatio !== 1) throw Error('pointer calibration requires unit pixel scale');
            window.__gatewayPointerMoves = [];
            window.__gatewayPointerListener = e => window.__gatewayPointerMoves.push({client_x: e.clientX, client_y: e.clientY, trusted: e.isTrusted});
            document.addEventListener('mousemove', window.__gatewayPointerListener, true);
            return {width: innerWidth, height: innerHeight};
        })()""")
        start = time.monotonic_ns()
        moves = []
        try:
            for x, y in ((window["width"] // 3, window["height"] // 2), (window["width"] * 2 // 3, window["height"] * 2 // 3)):
                count = self.evaluate("window.__gatewayPointerMoves.length")
                subprocess.run(["xdotool", "mousemove", "--sync", "--window", window_id, str(x), str(y)],
                               capture_output=True, timeout=15, check=True)
                end = time.monotonic() + 10
                while self.evaluate("window.__gatewayPointerMoves.length") <= count:
                    if time.monotonic() >= end:
                        raise EnvironmentUnavailable("native pointer move did not reach the page")
                moves.append({"x": x, "y": y, **self.evaluate("window.__gatewayPointerMoves.at(-1)")})
            offset = reader["pointer_offset"](window, page, moves)
            point = self.evaluate("""(() => {
                const b = document.createElement('button'); b.id = 'gateway-pointer-probe';
                b.textContent = 'Pointer preflight';
                b.style.cssText = 'position:fixed;left:40%;top:50%;width:80px;height:32px;z-index:2147483647;transition:none;transform:none';
                document.body.append(b); window.__gatewayPointerHit = null;
                window.__gatewayPointerClick = e => {window.__gatewayPointerHit = {target:e.target.id, trusted:e.isTrusted, client_x:e.clientX, client_y:e.clientY}; e.preventDefault(); e.stopImmediatePropagation();};
                document.addEventListener('click', window.__gatewayPointerClick, true);
                const r = b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
            })()""")
            subprocess.run(["xdotool", "mousemove", "--sync", "--window", window_id,
                            str(round(point["x"] + offset["x"])), str(round(point["y"] + offset["y"])),
                            "click", "--clearmodifiers", "1"], capture_output=True, timeout=15, check=True)
            end = time.monotonic() + 10
            hit = self.evaluate("window.__gatewayPointerHit")
            while hit is None and time.monotonic() < end:
                hit = self.evaluate("window.__gatewayPointerHit")
            self.pointer = {"window": window, "page": page, "moves": moves, "offset": offset, "point": point,
                            "hit": hit, "start_ns": start, "end_ns": time.monotonic_ns(), "window_id": int(window_id)}
            write_json(self.work / "pointer-preflight.json", self.pointer)
            reader["pointer_hit"](hit or {}, point)
        finally:
            self.evaluate("document.removeEventListener('mousemove', window.__gatewayPointerListener, true); document.removeEventListener('click', window.__gatewayPointerClick, true); document.getElementById('gateway-pointer-probe')?.remove(); true")

    def native_connect(self, kind: str = "click") -> dict[str, Any]:
        before = self.sample()
        reader["require"](classify(before) == "disconnected", "native Connect needs a disconnected row")
        action = self.native_action(kind)
        after = self.wait_for("live-cancel", 15)
        deadline = time.monotonic() + 5
        while after["opens"] == before["opens"] and time.monotonic() < deadline:
            after = self.sample()
        reader["require"](after["opens"] == before["opens"] + 1, "native Connect needs one fresh hand-off")
        reader["require"](after["card"]["connect_requests"] == before["card"]["connect_requests"] + 1,
                          "native Connect needs one request")
        reader["require"](after["card"]["control"]["same_element"], "native Connect replaced the control")
        if kind == "enter":
            reader["require"](after["card"]["control"]["focused"], "native Connect lost keyboard focus")
        write_json(self.work / f"{self.phase}-connect.json", {"before": before, "action": action, "after": after})
        return after

    def native_cancel(self, kind: str = "click", *, following_double: bool = False) -> dict[str, Any]:
        offsets = self.evaluate("({events: window.__gatewayObservationEvents.length, requests: window.__gatewayObservationRequests.length})")
        before = self.sample()
        action = self.native_action(kind)
        result = {"before": before, "action": action, "after": None}
        try:
            result["after"] = self.wait_for("disconnected", 15)
        except RuntimeError as error:
            result["settlement_error"] = str(error)
            result["after"] = self.sample()
        finally:
            trace = self.evaluate("({events: window.__gatewayObservationEvents.slice(" + str(offsets["events"]) + "), requests: window.__gatewayObservationRequests.slice(" + str(offsets["requests"]) + ")})")
            result.update(trace)
            write_json(self.work / f"{self.phase}-cancel.json", result)
        after = result["after"]
        if following_double:
            result["delivery"] = reader["post_double_cancel"](trace["events"], trace["requests"], before, after)
        else:
            reader["cancelled"](before, after, keyboard=kind == "enter")
            if kind == "click":
                reader["pointer_cancel_delivery"](trace["events"], trace["requests"])
        if classify(after) == "disconnected":
            if "settlement_error" in result:
                raise RuntimeError(result["settlement_error"])
            result["recovery_upper_seconds"] = (after["end_ns"] - action["start_ns"]) / 1e9
        write_json(self.work / f"{self.phase}-cancel.json", result)
        return result

    def multiclick_setting(self) -> None:
        """Read GTK's setting on this display without assuming an engine default."""
        command = shutil.which("gtk-query-settings")
        reading: dict[str, Any] = {"source": "gtk-query-settings gtk-double-click-time", "milliseconds": None}
        if command is None:
            reading["reason"] = "none readable: gtk-query-settings is unavailable"
        else:
            try:
                query = subprocess.run([command, "gtk-double-click-time"], capture_output=True, text=True,
                                       timeout=15, check=False)
                reading.update(status=query.returncode, stdout=query.stdout, stderr=query.stderr)
                values = re.findall(r"^\s*gtk-double-click-time:\s*(\d+)\s*$", query.stdout, re.MULTILINE)
                if query.returncode == 0 and len(values) == 1:
                    reading["milliseconds"] = int(values[0])
                else:
                    reading["reason"] = "none readable: GTK query failed or did not expose one integer setting"
            except (OSError, subprocess.TimeoutExpired) as error:
                reading["reason"] = "none readable: " + type(error).__name__
        write_json(self.work / "multiclick-setting.json", reading)

    def separate_pointer_click(self) -> dict[str, Any]:
        command = ["xdotool", "getmouselocation", "--shell"]
        before = subprocess.run(command, capture_output=True, text=True, timeout=15, check=True).stdout
        start = time.monotonic_ns()
        time.sleep(1.5)
        end = time.monotonic_ns()
        after = subprocess.run(command, capture_output=True, text=True, timeout=15, check=True).stdout
        pause = {"start_ns": start, "end_ns": end, "requested_seconds": 1.5,
                 "pointer_before": before, "pointer_after": after}
        write_json(self.work / "post-double-pause.json", pause)
        reader["require"](before == after, "pointer moved during the separated-click pause")
        return pause

    def stale_callback(self, old: dict[str, Any], current: dict[str, Any], *, successor_port: bool) -> dict[str, Any]:
        old_fields = parse_qs(urlsplit(old["url"]).query, strict_parsing=True)
        target = current if successor_port else old
        fields = parse_qs(urlsplit(target["url"]).query, strict_parsing=True)
        redirect = urlsplit(fields["redirect_uri"][0])
        if redirect.scheme != "http" or redirect.hostname != "127.0.0.1" or redirect.query or redirect.fragment:
            raise ValueError("refused a non-loopback stale callback")
        before = self.sample()
        start = time.monotonic_ns()
        query = urlencode({"state": old_fields["state"][0], "error": "user_cancelled"})
        try:
            with urlopen(urlunsplit((*redirect[:3], query, "")), timeout=10) as response:
                status: int | str = response.status
                response.read()
        except URLError as error:
            if successor_port or not isinstance(error.reason, ConnectionRefusedError):
                raise
            status = "connection-refused"
        after = self.sample()
        if successor_port:
            reader["require"](status == 200, "successor listener did not answer the stale callback")
        reader["preserved"](before, after)
        result = {"target": "successor-listener" if successor_port else "cancelled-listener",
                  "status": status, "start_ns": start, "end_ns": time.monotonic_ns(), "before": before, "after": after}
        append_json(self.work / "stale-callbacks.jsonl", result)
        return result

    def callback(self) -> dict[str, Any]:
        fields = parse_qs(urlsplit(self.captures()[-1]["url"]).query, strict_parsing=True)
        redirect = urlsplit(fields["redirect_uri"][0])
        if redirect.scheme != "http" or redirect.hostname != "127.0.0.1" or redirect.query or redirect.fragment:
            raise ValueError("refused a callback outside the private loopback listener")
        query = urlencode({"state": fields["state"][0], "error": "user_cancelled"})
        start = time.monotonic_ns()
        with urlopen(urlunsplit((*redirect[:3], query, "")), timeout=10) as response:
            status = response.status
            response.read()
        settled = self.wait_for("disconnected", 15)
        result = {"http_status": status, "start_ns": start, "settled": settled}
        write_json(self.work / f"{self.phase}-callback.json", result)
        return result

    def shot(self, name: str) -> None:
        # The desktop also opens a terminal, which can obscure the launcher.
        result = subprocess.run(["xdotool", "search", "--onlyvisible", "--name", "^Chan Desktop$"],
                                capture_output=True, text=True, timeout=15, check=False)
        windows = result.stdout.split()
        if result.returncode or len(windows) != 1 or not windows[0].isdigit():
            raise RuntimeError("native screenshot needs exactly one visible launcher window")
        window = windows[0]
        for command in (["xdotool", "windowactivate", "--sync", window],
                        ["xdotool", "windowraise", window]):
            result = subprocess.run(command, capture_output=True, timeout=15, check=False)
            if result.returncode:
                raise RuntimeError("native screenshot could not raise the launcher")
        result = subprocess.run(["import", "-window", window, str(self.work / "shots" / f"{name}.png")],
                                capture_output=True, timeout=15, check=False)
        if result.returncode:
            raise RuntimeError("native screenshot failed")
        append_json(self.work / "screenshots.jsonl", {"name": name, "window_id": int(window),
                    "title": "Chan Desktop", "monotonic_ns": time.monotonic_ns()})

    def register(self, origin: str, label: str) -> None:
        self.stub_origin = origin
        row = self.api("POST", "/api/library/gateways", {"url": origin, "label": label})
        self.gateway_id = row["id"]
        # An external registry write is read through the launcher's focus resync.
        self.evaluate("window.dispatchEvent(new Event('focus')); true")
        end = time.monotonic() + 15
        while not self.evaluate(self.card_expression() + ".length === 1"):
            if time.monotonic() >= end:
                raise RuntimeError("new gateway card did not appear")
            time.sleep(0.2)
        clean = self.wait_for("disconnected", 15)
        if clean["row"]["last_error"] is not None:
            raise ValueError("new gateway row already carries an error")

    def api_reclick(self) -> dict[str, Any]:
        before = self.sample()
        previous = self.captures()[-1]
        self.api("POST", f"/api/library/gateways/{self.gateway_id}/connect")
        deadline = time.monotonic() + 10
        after = self.sample()
        while after["opens"] == before["opens"] and time.monotonic() < deadline:
            time.sleep(0.1)
            after = self.sample()
        captures = self.captures()
        additional = len(captures) - before["opens"]
        if additional not in (0, 1):
            raise ValueError("API re-click produced an ambiguous number of hand-offs")
        old_state = parse_qs(urlsplit(previous["url"]).query)["state"]
        new_state = parse_qs(urlsplit(captures[-1]["url"]).query)["state"]
        result = {"before": before, "after": after, "additional_handoffs": additional,
                  "fresh_state": old_state != new_state if additional else None}
        write_json(self.work / "api-reclick.json", result)
        return result

    def cancellation_arms(self) -> dict[str, Any]:
        self.phase = "pointer"
        first = self.native_connect()
        old = self.captures()[-1]
        self.shot("pointer-pending")
        cancelled = self.native_cancel()
        self.shot("pointer-cancelled")
        result = {"first_pending": first, "cancel": cancelled}
        if not self.controls_only:
            self.phase = "reconnect"
            successor = self.native_connect()
            current = self.captures()[-1]
            old_state = parse_qs(urlsplit(old["url"]).query)["state"]
            current_state = parse_qs(urlsplit(current["url"]).query)["state"]
            reader["require"](old_state != current_state, "reconnect reused the cancelled flow's state")
            stale = [self.stale_callback(old, current, successor_port=value) for value in (False, True)]
            self.shot("successor-after-stale-callback")
            positive = self.callback()
            reader["require"](positive["http_status"] == 200, "matching successor callback did not answer")
            self.shot("successor-matching-callback")
            result.update(successor=successor, fresh_state=True, stale_callbacks=stale, matching_callback=positive)

        self.phase = "keyboard"
        keyboard_offsets = self.evaluate("({events: window.__gatewayObservationEvents.length, requests: window.__gatewayObservationRequests.length})")
        tab = self.native_action("tab")
        keyboard_pending = self.native_connect("enter")
        self.shot("keyboard-pending")
        keyboard_cancelled = self.native_cancel("enter")
        keyboard_trace = self.evaluate("({events: window.__gatewayObservationEvents.slice(" + str(keyboard_offsets["events"]) + "), requests: window.__gatewayObservationRequests.slice(" + str(keyboard_offsets["requests"]) + ")})")
        reader["keyboard_delivery"](keyboard_trace["events"], keyboard_trace["requests"])
        self.shot("keyboard-cancelled")

        self.phase = "double-click"
        offsets = self.evaluate("({events: window.__gatewayObservationEvents.length, requests: window.__gatewayObservationRequests.length})")
        before = self.sample()
        action = self.native_action("double")
        deadline = time.monotonic() + 15
        while True:
            trace = self.evaluate("({events: window.__gatewayObservationEvents.slice(" + str(offsets["events"]) + "), requests: window.__gatewayObservationRequests.slice(" + str(offsets["requests"]) + ")})")
            if any(event["type"] == "dblclick" for event in trace["events"]):
                break
            if time.monotonic() >= deadline:
                write_json(self.work / "double-click-partial.json", {"before": before, "action": action, **trace})
                raise RuntimeError("double-click delivery did not complete in 15 seconds")
        write_json(self.work / "double-click-delivery.json", {"before": before, "action": action, **trace})
        after = self.wait_for("live-cancel", 15)
        deadline = time.monotonic() + 5
        while after["opens"] == before["opens"] and time.monotonic() < deadline:
            after = self.sample()
        double = {"before": before, "action": action, "after": after, **trace}
        write_json(self.work / "double-click.json", double)
        delivery = reader["double_delivery"](trace["events"], trace["requests"], before, after)
        clicks = [event for event in trace["events"] if event["type"] == "click"]
        double.update(delivery=delivery, click_interval_ms=clicks[1]["page_ms"] - clicks[0]["page_ms"])
        write_json(self.work / "double-click.json", double)
        self.shot("double-click-settled")
        single_cancel = self.native_cancel(following_double=True)
        first_click = next(event for event in single_cancel["events"] if event["type"] == "click")
        single_cancel["gap_from_double_ms"] = first_click["page_ms"] - clicks[-1]["page_ms"]
        single_cancel["input_gap_from_double_seconds"] = (single_cancel["action"]["start_ns"] - action["end_ns"]) / 1e9
        write_json(self.work / "double-click-cancel.json", single_cancel)
        separated_cancel = None
        if single_cancel["delivery"]["outcome"] == "ignored":
            pause = self.separate_pointer_click()
            self.phase = "separated-click"
            separated_cancel = self.native_cancel()
            last_click = next(event for event in separated_cancel["events"] if event["type"] == "click")
            separated_cancel.update(pause=pause, gap_from_previous_ms=last_click["page_ms"] - first_click["page_ms"],
                                    input_gap_from_previous_seconds=(separated_cancel["action"]["start_ns"] - single_cancel["action"]["end_ns"]) / 1e9)
            write_json(self.work / "separated-click-cancel.json", separated_cancel)
        self.shot("double-click-cancelled")
        result.update(keyboard={"tab": tab, "pending": keyboard_pending, "cancel": keyboard_cancelled, **keyboard_trace},
                      double_click=double, single_cancel=single_cancel, separated_cancel=separated_cancel)
        write_json(self.work / "cancellation.json", result)
        return result

    def start_gesture_trace(self) -> dict[str, int]:
        return self.evaluate("""(() => {
            window.__gatewayGestureId = """ + json.dumps(self.gateway_id) + """;
            window.__gatewayGestureStates = [];
            window.__gatewayGestureRows = [];
            const card = """ + self.card_expression() + """[0];
            window.__gatewayGestureSnapshot = () => {
                const b = card.querySelector('.gateway-actions button:not([title="Rename"])');
                const state = {title: b?.title, disabled: b?.disabled,
                    prompt: card.querySelector('.gateway-prompt')?.textContent.trim(),
                    focused: document.activeElement === b};
                const signature = JSON.stringify(state);
                if (signature !== window.__gatewayGestureSignature) {
                    window.__gatewayGestureSignature = signature;
                    window.__gatewayGestureStates.push({...state, page_ms: performance.now()});
                }
            };
            window.__gatewayGestureSnapshot();
            window.__gatewayGestureObserver = new MutationObserver(window.__gatewayGestureSnapshot);
            window.__gatewayGestureObserver.observe(card, {subtree: true, attributes: true, childList: true, characterData: true});
            return {events: window.__gatewayObservationEvents.length, requests: window.__gatewayObservationRequests.length};
        })()""")

    def gesture_trace(self, offsets: dict[str, int]) -> dict[str, Any]:
        return self.evaluate("""({events: window.__gatewayObservationEvents.slice(""" + str(offsets["events"]) + """),
            requests: window.__gatewayObservationRequests.slice(""" + str(offsets["requests"]) + """),
            responses: window.__gatewayObservationResponses.filter(r => r.sequence >= """ + str(offsets["requests"]) + """),
            states: window.__gatewayGestureStates, rows: window.__gatewayGestureRows,
            observer_errors: window.__gatewayObservationErrors})""")

    def wait_gesture_delivery(self, offsets: dict[str, int], event_type: str) -> None:
        deadline = time.monotonic() + 10
        while True:
            trace = self.gesture_trace(offsets)
            if (any(event["type"] == event_type for event in trace["events"])
                    and len(trace["responses"]) == len(trace["requests"])):
                reader["require"](not trace["observer_errors"], "gesture observer failed")
                return
            if time.monotonic() >= deadline:
                raise RuntimeError("gesture input and request receipts did not complete within 10 seconds")
            time.sleep(0.1)

    def gesture_arm(self) -> dict[str, Any]:
        self.phase = self.gesture or "gesture"
        if self.gesture == "cancel-double":
            self.native_connect()
            self.shot("cancel-double-before")
            before = self.sample()
            offsets = self.start_gesture_trace()
            action = self.native_action("double")
            result: dict[str, Any] = {"before": before, "action": action}
            try:
                self.wait_gesture_delivery(offsets, "dblclick")
                result["after"] = self.wait_for("disconnected", 15)
            except RuntimeError as error:
                result["settlement_error"] = str(error)
                result["after"] = self.sample()
            finally:
                result.update(self.gesture_trace(offsets))
                write_json(self.work / "cancel-double.json", result)
            delivery = reader["cancel_double_delivery"](result["events"], result["requests"], before, result["after"])
            if "settlement_error" in result:
                raise RuntimeError(result["settlement_error"])
            # Keep observing after settlement so a late second request cannot hide behind the first row update.
            self.shot("cancel-double-after")
            result["final"] = self.sample()
            result.update(self.gesture_trace(offsets))
            write_json(self.work / "cancel-double.json", result)
            delivery = reader["cancel_double_delivery"](result["events"], result["requests"], before, result["final"])
            result["delivery"] = delivery
            write_json(self.work / "cancel-double.json", result)
            return {"outcome": "cancel-double-held", "engine": "Linux WebKitGTK", "delivery": delivery,
                    "click_counts": [event["detail"] for event in result["events"] if event["type"] == "click"],
                    "requests": [request["action"] for request in result["requests"]],
                    "additional_handoffs": result["final"]["opens"] - before["opens"], "observation": result}

        tab = self.native_action("tab")
        before = self.sample()
        reader["require"](classify(before) == "disconnected" and before["card"]["control"]["focused"],
                          "held Enter needs a focused disconnected control")
        query = subprocess.run(["xset", "q"], capture_output=True, text=True, timeout=15, check=True)
        setting = reader["repeat_setting"](query.stdout)
        write_json(self.work / "repeat-setting.json", {"command": ["xset", "q"], "stdout": query.stdout, **setting})
        with (self.work / "provenance.txt").open("a") as stream:
            stream.write(f"x_repeat_delay_ms={setting['delay_ms']}\nx_repeat_rate_hz={setting['rate_hz']}\n")
        self.shot("held-enter-before")
        offsets = self.start_gesture_trace()
        action = {"kind": "held-enter", "requested_seconds": 2, "start_ns": time.monotonic_ns()}
        release = {"start_ns": 0, "end_ns": 0}
        result = {"before": before, "tab": tab, "action": action, "release": release, "repeat_setting": setting}
        try:
            try:
                subprocess.run(["xdotool", "keydown", "--clearmodifiers", "Return"], capture_output=True, timeout=15, check=True)
                action["keydown_end_ns"] = time.monotonic_ns()
                time.sleep(2)
            finally:
                release["start_ns"] = time.monotonic_ns()
                subprocess.run(["xdotool", "keyup", "Return"], capture_output=True, timeout=15, check=True)
                release["end_ns"] = time.monotonic_ns()
            self.wait_gesture_delivery(offsets, "keyup")
            result["after"] = self.sample()
        finally:
            result.update(self.gesture_trace(offsets))
            result["captures_ns"] = [capture["monotonic_ns"] for capture in self.captures()[before["opens"]:]]
            write_json(self.work / "held-enter.json", result)
        reader["require"](not result["observer_errors"], "held Enter observer failed")
        # The boundary samples also witness state when the product makes no refresh request.
        result["rows"] = [{"source": "before", "row": before["row"]}, *result["rows"],
                          {"source": "after", "row": result["after"]["row"]}]
        counts = reader["held_enter"](result, release, result["captures_ns"])
        result["counts"] = counts
        write_json(self.work / "held-enter.json", result)
        self.shot("held-enter-after")
        return {"outcome": "observation-recorded", "engine": "Linux WebKitGTK", "counts": counts,
                "observation": result, "limit": "The opener is a capture shim, so the reading is of what happens while focus stays on the control; a real browser taking the focus at the first hand-off is not observed."}

    def observe(self, control_origin: str, abandonment_origin: str) -> dict[str, Any]:
        self.wait_launcher()
        self.evaluate(r"""(() => {
            window.__gatewayObservationRequests = [];
            window.__gatewayObservationEvents = [];
            window.__gatewayObservationResponses = [];
            window.__gatewayObservationErrors = [];
            const original = window.fetch;
            window.fetch = function(input, init) {
                const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
                const match = /^\/api\/library\/gateways\/[^/]+\/(connect|disconnect)$/.exec(path);
                const sequence = window.__gatewayObservationRequests.length;
                if (match) window.__gatewayObservationRequests.push({sequence, path, action: match[1], method: init?.method ?? 'GET', page_ms: performance.now()});
                const response = original.apply(this, arguments);
                if (window.__gatewayGestureId) response.then(async r => {
                    if (match) window.__gatewayObservationResponses.push({sequence, status: r.status, page_ms: performance.now()});
                    if (path === '/api/library/gateways') {
                        const rows = await r.clone().json();
                        for (const row of rows.filter(row => row.id === window.__gatewayGestureId)) {
                            const {id, status, pending_signin, last_error, enabled} = row;
                            window.__gatewayGestureRows.push({page_ms: performance.now(), status: r.status,
                                row: {id, status, pending_signin, last_error, enabled}});
                        }
                    }
                }).catch(() => window.__gatewayObservationErrors.push({path, page_ms: performance.now()}));
                return response;
            };
            for (const type of ['click', 'dblclick', 'keydown', 'keyup']) document.addEventListener(type, event => {
                const b = event.target.closest?.('.gateway-actions button');
                if ((!b || b.title === 'Rename') && !(window.__gatewayGestureId && event.key === 'Enter')) return;
                window.__gatewayObservationEvents.push({type, detail: event.detail, trusted: event.isTrusted,
                    key: event.key ?? null, repeat: event.repeat ?? null, title: b?.title ?? null, aria_label: b?.getAttribute('aria-label') ?? null,
                    disabled: b?.disabled ?? null, focused: !!b && document.activeElement === b, page_ms: performance.now()});
                window.__gatewayGestureSnapshot?.();
            }, true);
            document.querySelector('[aria-label="Show gateways"]').click();
            return true;
        })()""")
        self.register(control_origin, "Sign-in control")
        write_json(self.work / "ports.json", {"launcher_origin": self.origin, "control_origin": control_origin, "abandonment_origin": abandonment_origin, "inspector": self.endpoint})
        if self.gesture:
            self.multiclick_setting()
            if self.gesture == "cancel-double":
                self.calibrate_pointer()
            return self.gesture_arm()
        if self.cancel:
            self.multiclick_setting()
            self.calibrate_pointer()
            preflight = self.cancellation_arms()
        else:
            pending = self.connect()
            self.shot("preflight-pending")
            reclick = self.api_reclick()
            preflight = {"keyring": "native connect reached sign-in without a stored PAT", "opener": "native authorize hand-off captured by private xdg-open", "pending": pending, "api_reclick": reclick, "callback": self.callback()}
        write_json(self.work / "native-preflight.json", preflight)
        if self.controls_only:
            write_json(self.work / "native-events.json", self.evaluate("({events: window.__gatewayObservationEvents, requests: window.__gatewayObservationRequests})"))
            return {"outcome": "controls-held", "engine": "Linux WebKitGTK", "cancellation": preflight,
                    "not_run": ["stale-callbacks", "matching-callbacks", "five-minute-abandonment"],
                    "browser_model": "captured authorize hand-off, no browser page rendered"}

        self.phase = "abandonment"
        self.register(abandonment_origin, "Sign-in abandonment")
        first = self.native_connect() if self.cancel else self.connect()
        self.shot("abandonment-pending")
        if not self.cancel:
            clicked = self.click()
            after_click = self.sample()
            if not clicked["disabled"] or after_click["opens"] != first["opens"] or after_click["card"]["connect_requests"] != first["card"]["connect_requests"]:
                raise ValueError("disabled-click attempt was not inert")
            write_json(self.work / "disabled-click.json", {"before": first, "clicked": clicked, "after": after_click})
        deadline = time.monotonic() + 330
        last_pending = first
        while True:
            sample = self.sample()
            if sample["classification"] == "disconnected":
                recovered = sample
                break
            if sample["classification"] == self.wait_class:
                last_pending = sample
            elif sample["classification"] != "other-or-transition":
                raise ValueError("the abandonment control changed unexpectedly")
            if sample["opens"] != first["opens"] or sample["card"]["connect_requests"] != first["card"]["connect_requests"]:
                raise ValueError("another sign-in started during abandonment")
            if time.monotonic() >= deadline:
                raise RuntimeError("no recovery within 330 seconds after first pending")
            time.sleep(2)
        notice_sample = recovered
        notice_deadline = time.monotonic() + 5
        while not any(notice["title"] == "Sign-in timed out" for notice in notice_sample["card"]["notices"]):
            if time.monotonic() >= notice_deadline:
                raise ValueError("the recovered row has no timeout notice")
            time.sleep(0.2)
            notice_sample = self.sample()
        self.shot("abandonment-recovered")
        if self.cancel:
            reader["require"](recovered["row"]["enabled"] is True, "timeout changed enabled intent")
            reader["require"](bool(recovered["row"]["last_error"]), "timeout omitted its row error")
        abandonment = {"first_pending": first, "last_pending": last_pending, "first_disconnected": recovered, "timeout_notice_sample": notice_sample,
                       "recovery_seconds_from_first_pending": [(last_pending["start_ns"] - first["end_ns"]) / 1e9, (recovered["end_ns"] - first["start_ns"]) / 1e9]}
        write_json(self.work / "abandonment.json", abandonment)

        self.phase = "positive-control"
        self.native_connect() if self.cancel else self.connect()
        positive = self.callback()
        self.shot("positive-control-settled")
        write_json(self.work / "native-events.json", self.evaluate("({events: window.__gatewayObservationEvents, requests: window.__gatewayObservationRequests})"))
        return {"outcome": "contract-held" if self.cancel else "fault-observed", "engine": "Linux WebKitGTK", "abandonment": abandonment,
                "cancellation": preflight if self.cancel else None,
                "positive_control": positive, "browser_model": "captured authorize hand-off, no browser page rendered and no callback in abandonment"}


def run(endpoint: str, work: Path, cancel: bool = False, controls_only: bool = False,
        gesture: str | None = None) -> int:
    fixture = Fixture(endpoint, work, cancel, controls_only, gesture)

    class Discovery(BaseHTTPRequestHandler):
        def log_message(self, *_args: Any) -> None:
            pass

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            append_json(work / "discovery.jsonl", {"monotonic_ns": time.monotonic_ns(), "path": path})
            if path != "/.well-known/chan-gateway":
                self.send_error(404)
                return
            origin = f"http://127.0.0.1:{self.server.server_port}"
            data = json.dumps({"kind": "chan-gateway", "api_version": 1, "identity_origin": origin,
                               "desktop_authorize_url": origin + "/desktop/authorize",
                               "desktop_entry_url": origin + "/desktop/v1/devserver/entry",
                               "devserver_proxy_origin": origin, "devserver_proxy_host_depth": 2,
                               "roster_url": origin + "/desktop/v1/devservers"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    servers = [ThreadingHTTPServer(("127.0.0.1", 0), Discovery) for _ in range(2)]
    threads = [threading.Thread(target=server.serve_forever) for server in servers]
    for thread in threads:
        thread.start()
    try:
        result = fixture.observe(*(f"http://127.0.0.1:{server.server_port}" for server in servers))
        status = 0 if cancel else 10
    except (EnvironmentUnavailable, reader["NoClickDelivered"]) as error:
        result = {"outcome": "environment-unavailable", "phase": fixture.phase, "reason": str(error)}
        status = 2
    except reader["ContractFault"] as error:
        result = {"outcome": "fault-observed", "phase": fixture.phase, "reason": str(error)}
        status = 10
    except (ValueError, KeyError, TypeError, RuntimeError, OSError, subprocess.SubprocessError, HTTPError, URLError) as error:
        # Exception arguments from HTTP requests can carry query parameters.
        reason = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
        result = {"outcome": "inconclusive", "phase": fixture.phase, "reason": reason}
        status = 3
    finally:
        for server, thread in zip(servers, threads):
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
    write_json(work / "summary.json", result)
    print(json.dumps({"outcome": result["outcome"], "reader_status": status,
                      **{field: result[field] for field in ("counts", "delivery", "click_counts", "requests", "additional_handoffs") if field in result}}))
    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    opener = commands.add_parser("capture")
    opener.add_argument("url")
    observe = commands.add_parser("run")
    observe.add_argument("endpoint")
    observe.add_argument("work", type=Path)
    validate = commands.add_parser("validate", help="validate observation arguments without starting a desktop")
    for command in (observe, validate):
        command.add_argument("--cancel", action="store_true", help="observe the repaired cancel, native gestures and timeout control")
        command.add_argument("--controls-only", action="store_true", help="with --cancel, observe pointer, keyboard and double-click controls without callback or timeout arms")
        command.add_argument("--gesture", choices=("cancel-double", "held-enter"),
                             help="with --cancel, observe one native gesture in a fresh fixture")
    args = parser.parse_args()
    if args.command == "capture":
        capture(args.url)
    else:
        if args.controls_only and not args.cancel:
            parser.error("--controls-only requires --cancel")
        if args.gesture and (not args.cancel or args.controls_only):
            parser.error("--gesture requires --cancel and excludes --controls-only")
        if args.command == "run":
            raise SystemExit(run(args.endpoint, args.work, args.cancel, args.controls_only, args.gesture))
