#!/usr/bin/env python3
"""Export seeded PDFs in WebKitGTK and read the pixels Chrome cannot speak for.

The Linux desktop uses WebKitGTK, whose SVG document and nested image load
ordering can differ from Chrome's. This drives a live chan window in that
engine, exports through ``chan shell export``, and applies the browser smoke's
PDF pixel inspectors to the files the window writes into its workspace.

Install the browser-smoke harness with ``npm ci --prefix
scripts/e2e/browser-smoke`` so its PDF reader can resolve ``pdf-lib``. Build
the web bundles and ``target/debug/chan`` first. Under a headless runner use
``xvfb-run -a python3 scripts/e2e/webview-deck-export.py``.

Exit status: 0 all readings pass, 1 a reading or run fails, 2 the GUI stack
is unavailable. A skipped run is not a pass.
"""

from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import os
from pathlib import Path
import queue
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

REPO = Path(__file__).resolve().parents[2]
E2E = Path(__file__).resolve().parent
SEED = E2E / "browser-smoke/seed"
READ = E2E / "webview-deck-export-read.mjs"
CASES = ("deck-box.md", "layout-rotate.md", "layout-page-edge.md")
PHOTO_PNG = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
URL_RE = re.compile(r"https?://[^\s]+")
TOKEN_RE = re.compile(r"([?&]t=)[^&\s]+")
DEVSERVER_TOKEN_RE = re.compile(r"(CHAN_DEVSERVER_TOKEN=)[^\s]+")


def masked(value: str) -> str:
    return DEVSERVER_TOKEN_RE.sub(r"\1<token>", TOKEN_RE.sub(r"\1<token>", value))


def load_gui():
    """Import the GUI stack, or exit 2 where it cannot run."""
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import GLib, Gtk, WebKit2

        if not Gtk.init_check(None)[0]:
            raise RuntimeError("no display; try xvfb-run")
        return GLib, Gtk, WebKit2
    except (ImportError, ValueError, RuntimeError) as exc:
        print(f"SKIP: WebKitGTK is unavailable ({masked(str(exc))})", file=sys.stderr)
        print("SKIP: a skipped check is not a pass", file=sys.stderr)
        raise SystemExit(2) from exc


@dataclass(frozen=True)
class RunPaths:
    out: Path
    workspace: Path
    home: Path
    runtime: Path
    pdfs: Path


def make_paths(out: Path, seed: Path) -> RunPaths:
    out.mkdir(parents=True, exist_ok=False)
    # Linux's Unix socket path limit is shorter than an output directory's
    # absolute path, so the server's private runtime lives under /tmp.
    home = Path(tempfile.mkdtemp(prefix="chan-webview-home-"))
    paths = RunPaths(out, out / "workspace", home, home / "runtime", out / "pdfs")
    shutil.copytree(seed, paths.workspace)
    (paths.workspace / "photo.png").write_bytes(base64.b64decode(PHOTO_PNG))
    paths.runtime.mkdir(parents=True, mode=0o700)
    paths.pdfs.mkdir()
    return paths


def child_env(paths: RunPaths) -> dict[str, str]:
    env = os.environ.copy()
    env.pop("CHAN_CONTROL_SOCKET", None)
    env.pop("CHAN_WINDOW_ID", None)
    env.update(
        CHAN_HOME=str(paths.home),
        XDG_RUNTIME_DIR=str(paths.runtime),
        CHAN_NO_DEVSERVER_HANDOFF="1",
    )
    return env


def launch_server(chan: Path, paths: RunPaths) -> tuple[subprocess.Popen[str], str]:
    server = subprocess.Popen(
        [str(chan), "serve", "--here", "--port", "0", str(paths.workspace)],
        cwd=REPO,
        env=child_env(paths),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    lines: queue.Queue[str] = queue.Queue()

    def read_lines() -> None:
        assert server.stdout is not None
        for line in server.stdout:
            print(f"[server] {masked(line.rstrip())}", flush=True)
            lines.put(line)

    threading.Thread(target=read_lines, daemon=True).start()
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            line = lines.get(timeout=0.2)
        except queue.Empty:
            if server.poll() is not None:
                break
            continue
        match = URL_RE.search(line)
        if match:
            return server, match.group(0)
    stop_server(server)
    raise RuntimeError("chan serve did not print a URL within 60s")


def stop_server(server: subprocess.Popen[str]) -> None:
    if server.poll() is not None:
        return
    server.terminate()
    try:
        server.wait(timeout=5)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait(timeout=5)


def window_url(server_url: str, window_id: str) -> str:
    parts = urlsplit(server_url)
    query = parse_qs(parts.query, keep_blank_values=True)
    if "w" not in query:
        query["w"] = [window_id]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query, doseq=True), parts.fragment))


def control_socket(paths: RunPaths, pid: int) -> Path | None:
    try:
        for path in paths.runtime.iterdir():
            if path.name.startswith(f"chan-control-{pid}-") and path.name.endswith(".sock"):
                if stat.S_ISSOCK(path.stat().st_mode):
                    return path
    except FileNotFoundError:
        pass
    return None


def cli(chan: Path, args: list[str], paths: RunPaths, window_id: str, socket: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    env = child_env(paths)
    env.update(CHAN_CONTROL_SOCKET=str(socket), CHAN_WINDOW_ID=window_id)
    return subprocess.run(
        [str(chan), "shell", *args],
        cwd=paths.workspace,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def wait_window(chan: Path, paths: RunPaths, pid: int, window_id: str) -> Path:
    deadline = time.monotonic() + 60
    last_error = "no control socket"
    while time.monotonic() < deadline:
        socket = control_socket(paths, pid)
        if socket is not None:
            result = cli(chan, ["pane", "list", "--window", window_id, "--json"], paths, window_id, socket, 15)
            if result.returncode == 0:
                return socket
            last_error = masked(result.stderr.strip() or result.stdout.strip())
        time.sleep(0.2)
    raise RuntimeError(f"window {window_id} was not addressable within 60s: {last_error}")


def wait_pdf(path: Path) -> None:
    deadline = time.monotonic() + 90
    last_size = -1
    while time.monotonic() < deadline:
        if path.exists():
            size = path.stat().st_size
            if size > 0 and size == last_size:
                return
            last_size = size
        time.sleep(0.3)
    raise RuntimeError(f"PDF did not settle within 90s: {path.name}")


def read_pdf(pdf: Path, seed: str) -> tuple[int, str, str]:
    result = subprocess.run(
        ["node", str(READ), str(pdf), seed],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    return result.returncode, masked(result.stdout.strip()), masked(result.stderr.strip())


def export_seeds(chan: Path, paths: RunPaths, pid: int, window_id: str, seeds: tuple[str, ...]) -> list[str]:
    faults = []
    socket = wait_window(chan, paths, pid, window_id)
    for seed in seeds:
        output = paths.workspace / seed.replace(".md", ".pdf")
        if output.exists():
            output.unlink()
        try:
            result = cli(chan, ["export", seed], paths, window_id, socket, 180)
            if result.returncode != 0:
                raise RuntimeError(f"chan shell export exited {result.returncode}: {masked(result.stderr.strip() or result.stdout.strip())}")
            wait_pdf(output)
            saved = paths.pdfs / output.name
            shutil.copy2(output, saved)
            rc, details, errors = read_pdf(saved, seed)
            print(f"{'ok' if rc == 0 else 'FAIL'}  {seed}: {details}", flush=True)
            if errors:
                print(errors, file=sys.stderr, flush=True)
            print(f"      {saved}", flush=True)
            if rc != 0:
                faults.append(seed)
        except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
            faults.append(seed)
            print(f"FAIL  {seed}: {masked(str(exc))}", file=sys.stderr, flush=True)
            if output.exists():
                saved = paths.pdfs / output.name
                shutil.copy2(output, saved)
                print(f"      {saved}", flush=True)
    return faults


def render(gui, url: str, task) -> list[str]:
    GLib, Gtk, WebKit2 = gui
    window = Gtk.Window()
    window.set_default_size(1600, 1000)
    view = WebKit2.WebView()
    window.add(view)
    window.show_all()
    result: dict[str, object] = {}

    def finish(faults: list[str] | None = None, error: Exception | None = None) -> bool:
        result["faults"] = faults
        result["error"] = error
        Gtk.main_quit()
        return False

    def worker() -> None:
        try:
            faults = task()
            GLib.idle_add(finish, faults, None)
        except Exception as exc:  # A thread must report its error to the main loop.
            GLib.idle_add(finish, None, exc)

    started = False

    def on_load(_view, event) -> None:
        nonlocal started
        if event == WebKit2.LoadEvent.FINISHED and not started and not result.get("error"):
            started = True
            threading.Thread(target=worker, daemon=True).start()

    def on_load_failed(_view, _event, _uri, error) -> bool:
        result["error"] = RuntimeError(f"webview load failed: {masked(str(error))}")
        Gtk.main_quit()
        return False

    view.connect("load-changed", on_load)
    view.connect("load-failed", on_load_failed)
    view.load_uri(url)

    def watchdog() -> bool:
        result["timed_out"] = True
        result["error"] = RuntimeError("webview or export did not finish within 1200s")
        Gtk.main_quit()
        return False

    watchdog_id = GLib.timeout_add(1_200_000, watchdog)
    Gtk.main()
    if not result.get("timed_out"):
        GLib.source_remove(watchdog_id)
    window.destroy()
    if result.get("error"):
        raise result["error"]
    return result.get("faults") or []


def remove_created(path: Path, out: Path) -> None:
    if path.parent == out and path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)


def finish_home(paths: RunPaths, failed: bool) -> None:
    if (paths.home.parent != Path(tempfile.gettempdir()) or
            not paths.home.name.startswith("chan-webview-home-") or
            not paths.home.is_dir() or paths.home.is_symlink()):
        return
    if failed:
        shutil.move(str(paths.home), str(paths.out / "chan-home"))
    else:
        shutil.rmtree(paths.home)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chan", type=Path, default=Path("target/debug/chan"))
    parser.add_argument("--out", type=Path)
    parser.add_argument("--seed", type=Path, default=SEED)
    parser.add_argument("--only", choices=CASES)
    args = parser.parse_args()
    chan = args.chan if args.chan.is_absolute() else REPO / args.chan
    default_out = Path("target/e2e") / f"webview-deck-export-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}"
    chosen_out = args.out or default_out
    out = chosen_out if chosen_out.is_absolute() else REPO / chosen_out
    if out.exists():
        print(f"FAIL: output directory already exists: {out}", file=sys.stderr)
        return 1
    seed = args.seed if args.seed.is_absolute() else REPO / args.seed
    gui = load_gui()
    try:
        paths = make_paths(out, seed)
    except OSError as exc:
        print(f"FAIL: cannot prepare output directory: {masked(str(exc))}", file=sys.stderr)
        return 1
    server = None
    failed = True
    try:
        server, url = launch_server(chan, paths)
        window_id = uuid.uuid4().hex
        page_url = window_url(url, window_id)
        window_id = parse_qs(urlsplit(page_url).query)["w"][0]
        print(f"[webview] pid={server.pid} url={masked(page_url)}", flush=True)
        seeds = (args.only,) if args.only else CASES
        faults = render(gui, page_url, lambda: export_seeds(chan, paths, server.pid, window_id, seeds))
        failed = bool(faults)
        if failed:
            print(f"FAIL: {len(faults)} seed(s): {', '.join(faults)}", file=sys.stderr)
        else:
            print(f"PASS: {len(seeds)} WebKitGTK PDF pixel readings ({paths.pdfs})")
        return 1 if failed else 0
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        print(f"FAIL: {masked(str(exc))}", file=sys.stderr)
        return 1
    finally:
        if server is not None:
            stop_server(server)
            try:
                subprocess.run(
                    [str(chan), "workspace", "forget", str(paths.workspace)],
                    env=child_env(paths),
                    cwd=REPO,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired):
                pass
        if not failed:
            remove_created(paths.workspace, paths.out)
        else:
            print(f"Artifacts preserved under {paths.out}", file=sys.stderr)
        finish_home(paths, failed)


if __name__ == "__main__":
    sys.exit(main())
