#!/usr/bin/env python3
"""Measure the canvas animation family's frame rate on a real GPU.

WHY this exists: `canvas-animations-are-software-rasterized-on-linux` closed
its vortex and bloom arms on "60 fps on AMD Radeon 780M through ANGLE" and left
the point cloud host -- Lorenz Constellation, Rippled Duet, Striated Current,
Twin Veil Dance -- unmeasured, because the build host had no browser. Neither
recorded reading has an instrument behind it. This is that instrument, and it
runs the already-measured siblings in the same pass so the new number is read
against a control rather than against a memory.

WHY the page is the instrument and this driver is only a convenience: the
sibling reading was taken "through ANGLE", which is a Chromium-family stack,
and the machine that can answer this may not be the machine that can run
python-gobject. `--serve-only` prints a URL that any browser on any OS can
open; the page runs the whole matrix itself and prints its own table. This
driver adds automation and an exit status for the WebKitGTK case, nothing else.

WHAT IT WILL NOT DO: produce a number under software rasterization and call it
a frame rate. llvmpipe measures llvmpipe. The animation family was ported to
WebGL2 precisely because a 2D canvas path was being software-rasterized on
Linux, so a software-rasterized WebGL reading would restate the defect as if
it were the fix. Run this on the GPU whose number you intend to record.

Usage:
    python3 scripts/e2e/animation-fps.py [--serve-only] [--no-build] [--out DIR]

Exit status: 0 every arm holds the bar, 1 an arm is below it, 2 the
environment cannot run the check (including "the baseline arm proves this
display cannot present 60 fps"). A skip is not a pass.

Needs an installed `web/node_modules` and node for the build. The driven mode
additionally needs python-gobject with the WebKit2 4.1 typelib and a display.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import pathlib
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading

REPO = pathlib.Path(__file__).resolve().parents[2]
WEB = REPO / "web"
WORKSPACE_APP = WEB / "packages/workspace-app"
PAGE_DIR = pathlib.Path(__file__).resolve().parent / "animation-fps"
DIST = REPO / "target/e2e/animation-fps/dist"


def build() -> None:
    """Build the harness with the app's own svelte toolchain.

    Staged into a temp directory rather than built in place: this page lives
    under scripts/e2e/, outside the npm workspace, so node walks up from it and
    never finds a node_modules -- `vite` itself does not resolve there. The
    staged directory holds copies of the three harness files plus a
    node_modules symlink into web/, which is the same staging terminal-pixels.py
    does for the same reason. Copies rather than symlinks because node resolves
    a module's imports from its realpath, which would land back outside the
    workspace.
    """
    npx = shutil.which("npx")
    if npx is None:
        print(
            "SKIP: node is not installed, so the harness cannot be built.",
            file=sys.stderr,
        )
        print("SKIP: a skipped check is not a pass", file=sys.stderr)
        raise SystemExit(2)
    if not (WEB / "node_modules").exists():
        print(
            "SKIP: web/node_modules is missing; run `npm install` under web/",
            file=sys.stderr,
        )
        raise SystemExit(2)

    stage = pathlib.Path(tempfile.mkdtemp(prefix="chan-fps-"))
    for name in ("index.html", "main.ts", "vite.config.mjs"):
        shutil.copy2(PAGE_DIR / name, stage / name)
    (stage / "node_modules").symlink_to(WEB / "node_modules")

    env = dict(os.environ)
    env["CHAN_FPS_WORKSPACE_APP"] = str(WORKSPACE_APP)
    env["CHAN_FPS_OUT"] = str(DIST)
    result = subprocess.run(
        [npx, "vite", "build", "--config", str(stage / "vite.config.mjs")],
        cwd=stage,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not (DIST / "index.html").exists():
        # A build failure is a real failure, not a skip: the toolchain is
        # present and it said no.
        print(result.stdout, file=sys.stderr)
        print(result.stderr, file=sys.stderr)
        raise SystemExit("the harness failed to build")


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".woff2": "font/woff2",
    }

    def log_message(self, fmt, *args):
        del fmt, args


def serve(root: pathlib.Path, port: int = 0):
    handler = functools.partial(QuietHandler, directory=str(root))
    httpd = socketserver.ThreadingTCPServer(("0.0.0.0", port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1], httpd.shutdown


def load_gui():
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import GLib, Gtk, WebKit2

        if not Gtk.init_check(None)[0]:
            raise RuntimeError("no display")
        return GLib, Gtk, WebKit2
    except (ImportError, ValueError, RuntimeError) as exc:
        print(f"SKIP: WebKitGTK is unavailable ({exc})", file=sys.stderr)
        print("SKIP: a skipped check is not a pass", file=sys.stderr)
        raise SystemExit(2) from exc


def drive(url: str) -> dict:
    """Open the harness in a real WebKitGTK window and read its verdict."""
    GLib, Gtk, WebKit2 = load_gui()
    window = Gtk.Window()
    window.set_default_size(920, 900)
    view = WebKit2.WebView()
    view.get_settings().set_enable_webgl(True)
    window.add(view)
    window.show_all()

    state = {"payload": None, "error": None}

    def collect(_view, result):
        """Pull the payload off `window` once the page says it is done.

        WHY a JavaScript evaluation rather than the title: WebKitGTK truncates
        document.title near a kilobyte, and eight arms of results are several.
        Reading the title gave a string cut mid-token. Unlike the present-stall
        probe -- where touching the engine would destroy the measurement --
        this harness has already finished measuring by the time this runs, so
        evaluating in the page costs nothing.
        """
        try:
            js = view.evaluate_javascript_finish(result)
            state["payload"] = json.loads(js.to_string())
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            state["error"] = f"could not read the result payload: {exc}"
        Gtk.main_quit()

    def on_title(_view, _param):
        title = view.get_title() or ""
        if title.startswith("animation-fps-error"):
            state["error"] = title
            Gtk.main_quit()
        elif title == "animation-fps done":
            view.evaluate_javascript(
                "JSON.stringify(window.__animationFps)",
                -1,
                None,
                None,
                None,
                collect,
            )

    view.connect("notify::title", on_title)
    view.load_uri(url)

    def watchdog():
        state["error"] = state["error"] or "timed out"
        state["timed_out"] = True
        Gtk.main_quit()
        return False

    # Eight arms at warmup + measure, plus room for the shader compiles.
    watchdog_id = GLib.timeout_add(8 * 9000 + 60000, watchdog)
    Gtk.main()
    # Removing an already-fired source raises, and it would raise on the
    # timeout path -- the one that runs when the harness is already in
    # trouble, which is where a clear error matters most.
    if not state.get("timed_out"):
        GLib.source_remove(watchdog_id)
    window.destroy()
    if state["error"]:
        raise SystemExit(f"the harness failed: {state['error']}")
    return state["payload"]


def report(payload: dict) -> int:
    print()
    print(f"{'arm':<28}{'fps':>8}{'median':>9}{'p95':>8}{'worst':>8}  buffer")
    for row in payload["results"]:
        print(
            f"{row['name']:<28}{row['fps']:>8.1f}{row['medianMs']:>9.1f}"
            f"{row['p95Ms']:>8.1f}{row['worstMs']:>8.1f}  "
            f"{row['drawingBuffer'] or '—'}"
        )
        for warning in row["warnings"]:
            print(f"      warn: {warning}")
    print()
    print(f"GPU: {payload.get('renderer') or 'no WebGL2 context'}")
    print(payload["userAgent"])
    print(f"devicePixelRatio {payload['devicePixelRatio']}")
    print()
    print(payload["line"])
    return payload["code"]


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--serve-only", action="store_true",
                        help="build, serve, print the URL and wait, so any"
                             " browser on any machine can run the matrix")
    parser.add_argument("--port", type=int, default=0,
                        help="port for --serve-only (default: ephemeral)")
    parser.add_argument("--no-build", action="store_true",
                        help="reuse the last build")
    parser.add_argument("--out", type=pathlib.Path,
                        default=pathlib.Path("target/e2e/animation-fps"),
                        help="directory for the JSON result")
    args = parser.parse_args()

    if not args.no_build:
        build()
    if not (DIST / "index.html").exists():
        raise SystemExit(f"no build at {DIST}; drop --no-build")

    port, shutdown = serve(DIST, args.port)
    url = f"http://127.0.0.1:{port}/index.html"

    if args.serve_only:
        print(f"open this in the browser whose GPU you want measured:\n\n  {url}\n")
        print("the page runs all eight arms itself and prints its own table;")
        print("it takes about a minute. Ctrl-C here when you have the numbers.")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            shutdown()
        return 0

    payload = drive(url)
    shutdown()

    out = args.out if args.out.is_absolute() else REPO / args.out
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    code = report(payload)
    print(f"\n{out / 'result.json'}")
    return code


if __name__ == "__main__":
    sys.exit(main())
