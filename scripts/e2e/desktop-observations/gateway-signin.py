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
import runpy
import subprocess
import threading
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen

HERE = Path(__file__).resolve().parent
classify = runpy.run_path(str(HERE / "gateway-signin-reader.py"))["classify"]


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
    def __init__(self, endpoint: str, work: Path):
        self.endpoint = endpoint
        self.work = work
        self.origin = ""
        self.token = ""
        self.gateway_id = ""
        self.stub_origin = ""
        self.phase = "preflight"

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
                control: b ? {title: b.title, aria_label: b.getAttribute('aria-label'), disabled: b.disabled} : null,
                prompt: cards[0]?.querySelector('.gateway-prompt')?.textContent.trim() ?? null,
                notices: Array.from(document.querySelectorAll('.notice-bubble')).map(n => ({title: n.querySelector('.nb-title')?.textContent, message: n.querySelector('.nb-message')?.textContent})),
                connect_requests: window.__gatewayObservationRequests.length};
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
            if self.phase == "preflight" and expected == "disabled-wait" and last["row"].get("last_error"):
                raise EnvironmentUnavailable("native connect refused: " + last["row"]["last_error"])
            time.sleep(0.2)
        raise RuntimeError(f"did not observe {expected} in {seconds}s; last state {last['classification'] if last else 'absent'}")

    def connect(self) -> dict[str, Any]:
        before = self.sample()
        if before["classification"] != "disconnected":
            raise ValueError("connect did not start from a live Connect control")
        control = self.click()
        write_json(self.work / f"{self.phase}-clicked.json", control)
        pending = self.wait_for("disabled-wait", 15)
        opener_deadline = time.monotonic() + 5
        while pending["opens"] == before["opens"] and time.monotonic() < opener_deadline:
            time.sleep(0.1)
            pending = self.sample()
        if pending["opens"] != before["opens"] + 1:
            raise EnvironmentUnavailable("the native opener did not reach the private shim exactly once")
        if pending["card"]["connect_requests"] != before["card"]["connect_requests"] + 1:
            raise ValueError("Connect did not make exactly one observed launcher request")
        return pending

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

    def observe(self, control_origin: str, abandonment_origin: str) -> dict[str, Any]:
        self.wait_launcher()
        self.evaluate(r"""(() => {
            window.__gatewayObservationRequests = [];
            const original = window.fetch;
            window.fetch = function(input, init) {
                const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
                if (/^\/api\/library\/gateways\/[^/]+\/connect$/.test(path))
                    window.__gatewayObservationRequests.push({path, method: init?.method ?? 'GET', at: performance.now()});
                return original.apply(this, arguments);
            };
            document.querySelector('[aria-label="Show gateways"]').click();
            return true;
        })()""")
        self.register(control_origin, "Sign-in control")
        write_json(self.work / "ports.json", {"launcher_origin": self.origin, "control_origin": control_origin, "abandonment_origin": abandonment_origin, "inspector": self.endpoint})
        pending = self.connect()
        self.shot("preflight-pending")
        reclick = self.api_reclick()
        preflight = {"keyring": "native connect reached sign-in without a stored PAT", "opener": "native authorize hand-off captured by private xdg-open", "pending": pending, "api_reclick": reclick, "callback": self.callback()}
        write_json(self.work / "native-preflight.json", preflight)

        self.phase = "abandonment"
        self.register(abandonment_origin, "Sign-in abandonment")
        first = self.connect()
        self.shot("abandonment-pending")
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
            if sample["classification"] == "disabled-wait":
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
        abandonment = {"first_pending": first, "last_pending": last_pending, "first_disconnected": recovered, "timeout_notice_sample": notice_sample,
                       "recovery_seconds_from_first_pending": [(last_pending["start_ns"] - first["end_ns"]) / 1e9, (recovered["end_ns"] - first["start_ns"]) / 1e9]}
        write_json(self.work / "abandonment.json", abandonment)

        self.phase = "positive-control"
        self.connect()
        positive = self.callback()
        self.shot("positive-control-settled")
        return {"outcome": "fault-observed", "engine": "Linux WebKitGTK", "abandonment": abandonment,
                "positive_control": positive, "browser_model": "captured authorize hand-off, no browser page rendered and no callback in abandonment"}


def run(endpoint: str, work: Path) -> int:
    fixture = Fixture(endpoint, work)

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
        status = 10
    except EnvironmentUnavailable as error:
        result = {"outcome": "environment-unavailable", "phase": fixture.phase, "reason": str(error)}
        status = 2
    except (ValueError, KeyError, TypeError, RuntimeError, OSError, subprocess.TimeoutExpired, HTTPError, URLError) as error:
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
    print(json.dumps({"outcome": result["outcome"], "reader_status": status}))
    return status


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    opener = commands.add_parser("capture")
    opener.add_argument("url")
    observe = commands.add_parser("run")
    observe.add_argument("endpoint")
    observe.add_argument("work", type=Path)
    args = parser.parse_args()
    if args.command == "capture":
        capture(args.url)
    else:
        raise SystemExit(run(args.endpoint, args.work))
