#!/usr/bin/env python3
"""Measure whether WebKitGTK presents an idle WebGL write, or stalls it.

WHY this exists: `shouldUseWebglRenderer` is false for a Linux desktop, and the
whole reason is a comment in TerminalTab.svelte saying WebKitGTK "does not
reliably composite the WebGL render layer while the page is idle". That claim
has never been measured. It costs the Linux desktop the WebGL renderer, and
with it the custom-glyph path, which is why the shipped Linux grid bands rules
and blocks at 96.0% and 95.2% while every WebGL arm measures 100%.

WHY the obvious probe does not work: the fault is that a write is DRAWN into the
GL canvas but not PRESENTED. Every convenient way to observe that is itself an
event that can wake the compositor and produce the frame you were checking for:

  * `WebKitWebView.get_snapshot()` -- what terminal-pixels.py uses -- asks the
    engine to produce an image, which can force the composite it was called to
    detect. A green result from it is not evidence of anything.
  * `run_javascript()` runs a task in the page, which is a wake.
  * `gl.readPixels()` and canvas readback read the DRAWING buffer. That is the
    half of the pipeline nobody doubts; the question is the other half.
  * A synthetic key or click IS the wake event whose absence defines the fault.

So this driver never touches the engine after load. The page runs its own
schedule off timers and reports through `document.title` (a property notify
that renders nothing), and the pixels are read from the X server with
XGetImage, outside WebKit entirely. What it measures is what a camera pointed
at the screen would have seen.

WHY the arms are what they are:

  * `dom` is the control. The DOM renderer paints through DOM mutation and has
    no GL layer to leave unpresented. A stall reported on BOTH arms means the
    harness or the capture is wrong, not the renderer, and the run says so
    instead of reporting a defect.
  * `WEBKIT_DISABLE_DMABUF_RENDERER` is swept because it is an uncontrolled
    variable in every reading taken so far. `linux_gui_stack.rs` sets it to 1,
    but ONLY inside an AppImage launch: a `cargo tauri dev` or a directly-run
    `target/release/chan-desktop` gets the dma-buf path, the shipped AppImage
    does not. dma-buf is precisely the mechanism by which WebKit hands GPU
    buffers to the compositor, so a present stall is exactly the kind of fault
    that would live on one side of that switch and not the other. WebKit reads
    the variable once at webview init, so each setting needs its own process --
    which is why this driver re-executes itself per arm.
  * The idle duration is swept because "while the page is idle" is a claim
    about duration and nobody has established how long idle has to be.

Usage:
    python3 scripts/e2e/webgl-present-stall.py [--trials N] [--idle-ms MS ...]
                                               [--renderer webgl|dom ...]
                                               [--dmabuf on|off ...]
                                               [--settle-ms MS] [--out DIR]

Exit status: 0 no stall observed, 1 a stall was observed, 2 the environment
cannot run the check. A skip is not a pass; report it as a skip.

Needs python-gobject with the WebKit2 4.1 typelib, an installed
`web/node_modules`, and an X11 session with a real GPU. It cannot run headless:
llvmpipe under Xvfb answers a different question than the one asked, and a
"no stall" from it would be non-evidence dressed as evidence. Wayland is
refused rather than approximated -- see `check_display`.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import pathlib
import re
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse

REPO = pathlib.Path(__file__).resolve().parents[2]
WEB = REPO / "web"
WORKSPACE_APP = WEB / "packages/workspace-app"
TERMINAL_TAB = WORKSPACE_APP / "src/components/TerminalTab.svelte"
FONTS_CSS = WORKSPACE_APP / "src/fonts.css"
PAGE_DIR = pathlib.Path(__file__).resolve().parent / "webgl-present-stall"

# The host element's size in index.html, and so the window's.
HOST_W = 800
HOST_H = 560

# TerminalTab's default when preferences carry no font_size.
FONT_SIZE = 14

# A pixel is ink when any channel is this far from the terminal background.
# The probe writes solid U+2588 in the foreground colour, so the real
# separation is ~200 levels; this only has to clear antialiasing and the
# engine's colour management.
INK_THRESHOLD = 24

# What a presented write looks like, and what an unpresented one looks like.
# The band between them is deliberately wide: a row that is neither is a
# result the run refuses to classify rather than rounds to the nearer answer.
INK_PRESENT = 0.60
INK_ABSENT = 0.10

# The window is placed here rather than left to the window manager, so the
# capture rectangle is known before the window exists.
WIN_X = 60
WIN_Y = 60


def linux_font_chain() -> str:
    """The chain TerminalTab hands the renderer on Linux for `os-default`.

    Read out of the component rather than restated, for the same reason
    terminal-pixels.py reads it: a chain edit has to move the harness with it.
    """
    text = TERMINAL_TAB.read_text(encoding="utf-8")
    # The same expression terminal-pixels.py uses, so the two harnesses cannot
    # disagree about what the component says.
    match = re.search(r"linux:\s*\n?\s*'([^']*)'", text)
    if not match:
        # The probe does not measure glyph shape, so an unreadable chain is
        # not fatal here the way it is in the pixels harness. Say so loudly
        # and carry on with the face the product bundles.
        print(
            "warn: could not read the Linux font chain out of TerminalTab.svelte;"
            " falling back to the bundled face",
            file=sys.stderr,
        )
        return '"Source Code Pro", monospace'
    return match.group(1)


def font_face_block() -> str:
    """The app's own @font-face declaration, verbatim."""
    text = FONTS_CSS.read_text(encoding="utf-8")
    match = re.search(r"@font-face\s*\{.*?\}", text, re.S)
    if not match:
        raise SystemExit(f"{FONTS_CSS}: no @font-face block")
    return f"<style>{match.group(0)}</style>"


def build_serve_dir(root: pathlib.Path) -> None:
    """Assemble the served tree: the page, the font, the two vendors.

    Deliberately leaner than terminal-pixels.py's: this probe drives xterm and
    the WebGL addon only, so it does not stage ghostty and does not shell out
    to `tsc`. A probe that failed because a TypeScript compile failed would be
    reporting on something it does not measure.
    """
    (root / "vendor").mkdir()
    links = {
        "index.html": PAGE_DIR / "index.html",
        "probe.mjs": PAGE_DIR / "probe.mjs",
        "fonts": WORKSPACE_APP / "src/fonts",
        "vendor/xterm": WEB / "node_modules/@xterm/xterm",
        "vendor/addon-webgl": WEB / "node_modules/@xterm/addon-webgl",
    }
    for name, target in links.items():
        if not target.exists():
            raise SystemExit(f"missing {target}; run `npm install` under web/")
        (root / name).symlink_to(target)

    page = (PAGE_DIR / "index.html").read_text(encoding="utf-8")
    (root / "index.html").unlink()
    (root / "index.html").write_text(
        page.replace("<!--CHAN_FONT_FACE-->", font_face_block()),
        encoding="utf-8",
    )


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Static files for the page, without a request line per asset."""

    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".woff2": "font/woff2",
    }

    def log_message(self, fmt, *args):
        del fmt, args


def serve(root: pathlib.Path):
    """Serve `root` on loopback and return (port, shutdown)."""
    handler = functools.partial(QuietHandler, directory=str(root))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd.server_address[1], httpd.shutdown


def load_gui():
    """Import the GUI stack, or exit 2 when the host cannot provide it."""
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("Gdk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import Gdk, GdkPixbuf, GLib, Gtk, WebKit2

        if not Gtk.init_check(None)[0]:
            raise RuntimeError("no display")
        return Gdk, GdkPixbuf, GLib, Gtk, WebKit2
    except (ImportError, ValueError, RuntimeError) as exc:
        print(f"SKIP: WebKitGTK is unavailable ({exc})", file=sys.stderr)
        print("SKIP: a skipped check is not a pass", file=sys.stderr)
        raise SystemExit(2) from exc


def check_display(gui) -> None:
    """Refuse the environments where a result would not mean what it says.

    Wayland is refused rather than approximated. The capture here is XGetImage
    on the root window; under a Wayland compositor there is no such root to
    read, and forcing the app onto XWayland with GDK_BACKEND=x11 changes the
    presentation path that IS the thing under test. An approximation of this
    particular measurement is worth less than no measurement, because the
    reason the question is still open is that a previous approximation was
    read as an answer.
    """
    Gdk = gui[0]
    display = Gdk.Display.get_default()
    if display is None:
        print("SKIP: no display", file=sys.stderr)
        raise SystemExit(2)
    name = type(display).__name__
    if "Wayland" in name:
        print(
            "SKIP: this is a Wayland session, and this probe reads pixels with"
            " XGetImage on the X root window.",
            file=sys.stderr,
        )
        print(
            "SKIP: run it from an Xorg session. Do NOT reach for"
            " GDK_BACKEND=x11: XWayland changes the very presentation path"
            " under test, so a result from it would not answer the question.",
            file=sys.stderr,
        )
        raise SystemExit(2)


class Capture:
    """A rectangle of the screen, read outside WebKit.

    Indexed in application-space coordinates. The scale factor is derived from
    what the pixbuf actually came back as rather than assumed, because GDK's
    handling of scaled displays differs by version and a wrong assumption here
    silently samples the wrong rows.
    """

    def __init__(self, pixbuf, req_w: int, req_h: int):
        self.pixbuf = pixbuf
        self.data = pixbuf.get_pixels()
        self.stride = pixbuf.get_rowstride()
        self.channels = pixbuf.get_n_channels()
        self.scale_x = pixbuf.get_width() / req_w if req_w else 1.0
        self.scale_y = pixbuf.get_height() / req_h if req_h else 1.0
        self.width = pixbuf.get_width()
        self.height = pixbuf.get_height()

    def rgb(self, x: float, y: float):
        px = min(max(int(x * self.scale_x), 0), self.width - 1)
        py = min(max(int(y * self.scale_y), 0), self.height - 1)
        off = py * self.stride + px * self.channels
        return self.data[off], self.data[off + 1], self.data[off + 2]

    def ink_share(self, rect, background) -> float:
        """The fraction of a rectangle that is not the terminal background."""
        x0, y0, x1, y1 = rect
        # Sample on a grid rather than every pixel: at 40 cells wide this is
        # thousands of reads per capture and the answer is a ratio, not a
        # count. The step stays well under a cell so a one-row seam cannot
        # hide between samples.
        step = 2.0
        hits = total = 0
        y = y0
        while y < y1:
            x = x0
            while x < x1:
                red, green, blue = self.rgb(x, y)
                delta = max(
                    abs(red - background[0]),
                    abs(green - background[1]),
                    abs(blue - background[2]),
                )
                hits += delta >= INK_THRESHOLD
                total += 1
                x += step
            y += step
        return hits / total if total else 0.0


def screen_capture(gui, x: int, y: int, w: int, h: int) -> Capture:
    """XGetImage on the root window, through GDK. Never touches the webview."""
    Gdk = gui[0]
    root = Gdk.get_default_root_window()
    pixbuf = Gdk.pixbuf_get_from_window(root, x, y, w, h)
    if pixbuf is None:
        raise RuntimeError(
            "the root window returned no pixels; this driver needs X11"
        )
    return Capture(pixbuf, w, h)


class Arm:
    """One (renderer, dma-buf, idle duration) combination."""

    def __init__(self, renderer: str, dmabuf: str, idle_ms: int):
        self.renderer = renderer
        self.dmabuf = dmabuf
        self.idle_ms = idle_ms

    @property
    def name(self) -> str:
        return f"{self.renderer}/dmabuf-{self.dmabuf}/idle-{self.idle_ms}ms"

    @property
    def slug(self) -> str:
        return f"{self.renderer}-dmabuf-{self.dmabuf}-idle-{self.idle_ms}"


def run_arm(args, arm: Arm) -> dict:
    """Run one arm to completion in this process and return its trials.

    In-process because WebKit reads WEBKIT_DISABLE_DMABUF_RENDERER once at
    webview init: the parent sets the variable and re-executes this file, so by
    the time we get here the environment is already the one being measured.
    """
    gui = load_gui()
    check_display(gui)
    Gdk, GdkPixbuf, GLib, Gtk, WebKit2 = gui

    root = pathlib.Path(tempfile.mkdtemp(prefix="chan-stall-"))
    build_serve_dir(root)
    port, shutdown = serve(root)

    config = {
        "renderer": arm.renderer,
        "fontFamily": linux_font_chain(),
        "fontSize": FONT_SIZE,
        "trials": args.trials,
        "idleMs": arm.idle_ms,
        "tailMs": args.settle_ms * 2 + 1200,
        "leadInMs": 900,
    }
    url = (
        f"http://127.0.0.1:{port}/index.html#"
        + urllib.parse.quote(json.dumps(config))
    )

    window = Gtk.Window()
    # Undecorated and kept above: the capture rectangle is computed from the
    # window's origin, so a title bar would offset every sample, and another
    # window stacked over ours would be captured instead of ours. The marker
    # check below is what proves neither happened.
    window.set_decorated(False)
    window.set_keep_above(True)
    window.set_default_size(HOST_W, HOST_H)
    window.move(WIN_X, WIN_Y)
    view = WebKit2.WebView()
    settings = view.get_settings()
    settings.set_enable_webgl(True)
    settings.set_enable_write_console_messages_to_stdout(True)
    window.add(view)
    window.show_all()

    state = {
        "geometry": None,
        "background": (28, 28, 30),
        "trials": [],
        "error": None,
        "pending_row": None,
        "pending_trial": None,
        "p0": None,
    }

    def origin():
        gdk_window = window.get_window()
        if gdk_window is None:
            raise RuntimeError("the window was never realised")
        _, ox, oy = gdk_window.get_origin()
        return ox, oy

    def cell_rect(first_col, last_col, row):
        """A run of cells, in application-space screen coordinates."""
        geo = state["geometry"]
        ox, oy = origin()
        x0 = ox + geo["originX"] + first_col * geo["cellWidth"]
        x1 = ox + geo["originX"] + (last_col + 1) * geo["cellWidth"]
        # Inset by a fifth of a cell vertically. The measurement is "did this
        # row gain ink", not "is the row perfectly filled": the DOM arm leaves
        # a seam at the cell boundary by construction (that is the defect this
        # renderer choice costs us), and sampling the seam would drag its ink
        # share toward the dead band on a row that plainly presented.
        inset = geo["cellHeight"] * 0.2
        y0 = oy + geo["originY"] + row * geo["cellHeight"] + inset
        y1 = oy + geo["originY"] + (row + 1) * geo["cellHeight"] - inset
        return x0, y0, x1, y1

    def grab(rect):
        x0, y0, x1, y1 = rect
        x, y = int(x0), int(y0)
        w, h = max(1, int(x1) - x), max(1, int(y1) - y)
        cap = screen_capture(gui, x, y, w, h)
        return cap, (0, 0, w, h)

    def background_rgb():
        # Read the background off the screen rather than hardcoding #1c1c1e:
        # the engine's colour management can move it, and the ink test is a
        # distance from whatever the window is actually painting.
        geo = state["geometry"]
        cap, rect = grab(cell_rect(geo["probe"]["lastCol"] + 4,
                                   geo["probe"]["lastCol"] + 8,
                                   geo["rows"] - 1))
        return cap.rgb(rect[0] + 2, rect[1] + 2)

    def marker_ok():
        geo = state["geometry"]
        cap, rect = grab(cell_rect(geo["marker"]["firstCol"],
                                   geo["marker"]["lastCol"],
                                   geo["marker"]["row"]))
        return cap.ink_share(rect, state["background"]) > INK_PRESENT

    def probe_share(row):
        geo = state["geometry"]
        cap, rect = grab(cell_rect(geo["probe"]["firstCol"],
                                   geo["probe"]["lastCol"], row))
        return cap.ink_share(rect, state["background"])

    def wake():
        """A real input event, delivered by the X server, not by the engine.

        Warping the pointer over the window is the least invasive wake
        available: it is what the user's hand does, it goes through the same
        path a real motion event does, and unlike a key or a click it cannot
        be mistaken for input the terminal should act on. The target moves a
        few pixels each trial because a warp to the pointer's current position
        generates no motion event at all.
        """
        display = Gdk.Display.get_default()
        seat = display.get_default_seat()
        pointer = seat.get_pointer()
        screen = display.get_default_screen()
        nudge = len(state["trials"]) % 7
        pointer.warp(screen, WIN_X + 40 + nudge, WIN_Y + HOST_H - 20)

    def finish_trial(trial, row, p1, p2):
        # The classification. `stalled` is the only verdict that indicts the
        # renderer, and it requires BOTH halves: absent while idle AND present
        # once woken. Absent in both is a different fault and is reported as
        # its own thing rather than folded in to make a number look decisive.
        if p1 >= INK_PRESENT:
            verdict = "presented"
        elif p1 <= INK_ABSENT and p2 >= INK_PRESENT:
            verdict = "stalled"
        elif p1 <= INK_ABSENT and p2 <= INK_ABSENT:
            verdict = "never-painted"
        else:
            verdict = "inconclusive"
        state["trials"].append(
            {
                "trial": trial,
                "row": row,
                "idle_ms": arm.idle_ms,
                "idle_share": round(p1, 4),
                "woken_share": round(p2, 4),
                "p0_share": round(state["p0"], 4)
                if state["p0"] is not None
                else None,
                "verdict": verdict,
            }
        )

    def on_title(_view, _param):
        title = view.get_title() or ""
        if title.startswith("stall-probe-error"):
            state["error"] = title
            Gtk.main_quit()
            return
        if not title.startswith("stall-probe "):
            return
        body = title[len("stall-probe ") :]

        if body.startswith("ready "):
            state["geometry"] = json.loads(body[len("ready ") :])
            state["background"] = background_rgb()
            if not marker_ok():
                state["error"] = (
                    "the marker row is not on screen: the window is obscured,"
                    " off-screen, or the geometry is wrong. Refusing to report"
                    " a stall from a capture that may not be this window."
                )
                Gtk.main_quit()
            return

        if body.startswith("armed "):
            _, trial, row = body.split()
            state["pending_trial"], state["pending_row"] = int(trial), int(row)

            def capture_p0():
                # Early in the idle window: confirms this trial's own clear
                # reached the screen, so "no ink later" means the write did
                # not present rather than that the row was never cleared.
                try:
                    state["p0"] = probe_share(state["pending_row"])
                except Exception as exc:  # noqa: BLE001 - reported, not raised
                    state["error"] = f"capture failed: {exc}"
                    Gtk.main_quit()
                return False

            GLib.timeout_add(120, capture_p0)
            return

        if body.startswith("wrote "):
            _, trial, row = body.split()
            trial, row = int(trial), int(row)

            def after_idle_write():
                try:
                    p1 = probe_share(row)
                    wake()
                except Exception as exc:  # noqa: BLE001
                    state["error"] = f"capture failed: {exc}"
                    Gtk.main_quit()
                    return False

                def after_wake():
                    try:
                        p2 = probe_share(row)
                    except Exception as exc:  # noqa: BLE001
                        state["error"] = f"capture failed: {exc}"
                        Gtk.main_quit()
                        return False
                    finish_trial(trial, row, p1, p2)
                    return False

                GLib.timeout_add(args.settle_ms, after_wake)
                return False

            GLib.timeout_add(args.settle_ms, after_idle_write)
            return

        if body == "done":
            Gtk.main_quit()

    view.connect("notify::title", on_title)
    view.load_uri(url)

    # Bound the whole arm. Every trial costs idle + tail, so the budget is
    # derived from the schedule rather than guessed, with a floor for load.
    budget_ms = 20000 + args.trials * (arm.idle_ms + args.settle_ms * 2 + 4000)

    def watchdog():
        state["error"] = state["error"] or "timed out"
        Gtk.main_quit()
        return False

    watchdog_id = GLib.timeout_add(budget_ms, watchdog)
    Gtk.main()
    GLib.source_remove(watchdog_id)
    window.destroy()
    shutdown()

    return {
        "arm": arm.name,
        "renderer": arm.renderer,
        "dmabuf": arm.dmabuf,
        "idle_ms": arm.idle_ms,
        "webkit": f"{WebKit2.get_major_version()}.{WebKit2.get_minor_version()}"
        f".{WebKit2.get_micro_version()}",
        "geometry": state["geometry"],
        "trials": state["trials"],
        "error": state["error"],
    }


def summarise(result: dict) -> dict:
    counts = {}
    for trial in result["trials"]:
        counts[trial["verdict"]] = counts.get(trial["verdict"], 0) + 1
    return counts


def report(results: list[dict]) -> int:
    print()
    print("arm                                     trials  presented stalled other")
    stalls = 0
    errors = 0
    webgl_arms = 0
    for result in results:
        counts = summarise(result)
        total = len(result["trials"])
        presented = counts.get("presented", 0)
        stalled = counts.get("stalled", 0)
        other = total - presented - stalled
        stalls += stalled
        if result["renderer"] == "webgl":
            webgl_arms += 1
        print(
            f"{result['arm']:<40}{total:>6}{presented:>11}{stalled:>8}{other:>6}"
        )
        if result["error"]:
            errors += 1
            print(f"      ERROR: {result['error']}")
        geo = result.get("geometry") or {}
        if result["renderer"] == "webgl" and geo and not geo.get("webglLoaded"):
            errors += 1
            print(
                "      ERROR: the WebGL addon did not load, so this arm did not"
                " measure WebGL at all"
            )
        for warning in geo.get("warnings", []) if geo else []:
            print(f"      warn: {warning}")
        for trial in result["trials"]:
            if trial["verdict"] == "presented":
                continue
            armed = (
                f", armed {trial['p0_share']:.0%}"
                if trial["p0_share"] is not None
                else ""
            )
            print(
                f"      trial {trial['trial']:>3} row {trial['row']:>2}"
                f" {trial['verdict']}: idle {trial['idle_share']:.0%},"
                f" woken {trial['woken_share']:.0%}{armed}"
            )

    print()
    if errors:
        print(f"INCONCLUSIVE: {errors} arm(s) could not be measured")
        return 2
    if not webgl_arms:
        print("INCONCLUSIVE: no WebGL arm ran")
        return 2

    control_stalls = sum(
        1
        for result in results
        if result["renderer"] == "dom"
        for trial in result["trials"]
        if trial["verdict"] == "stalled"
    )
    if control_stalls:
        print(
            f"INCONCLUSIVE: the DOM control arm stalled {control_stalls} time(s)."
            " The DOM renderer has no GL layer to leave unpresented, so this is"
            " the harness or the capture, not the renderer."
        )
        return 2

    if stalls:
        print(
            f"FAIL: the WebGL present stall reproduces ({stalls} stalled"
            " trial(s)). shouldUseWebglRenderer should stay false on the Linux"
            " desktop."
        )
        return 1
    print(
        "PASS: no WebGL present stall observed. Every idle write was on screen"
        " before anything woke the compositor."
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--trials", type=int, default=12,
                        help="trials per arm (default: 12)")
    parser.add_argument("--idle-ms", type=int, action="append", default=None,
                        help="idle window before the write; repeatable"
                             " (default: 1000, 3000, 8000)")
    parser.add_argument("--renderer", action="append", default=None,
                        choices=["webgl", "dom"],
                        help="repeatable (default: both; dom is the control)")
    parser.add_argument("--dmabuf", action="append", default=None,
                        choices=["on", "off"],
                        help="WebKit dma-buf renderer; repeatable"
                             " (default: both). off == the AppImage's"
                             " WEBKIT_DISABLE_DMABUF_RENDERER=1")
    parser.add_argument("--settle-ms", type=int, default=400,
                        help="wait after a write, and after the wake, before"
                             " capturing (default: 400)")
    parser.add_argument("--out", type=pathlib.Path,
                        default=pathlib.Path("target/e2e/webgl-present-stall"),
                        help="directory for the JSON result")
    parser.add_argument("--_arm", default=None,
                        help=argparse.SUPPRESS)
    args = parser.parse_args()

    if args._arm:
        renderer, dmabuf, idle_ms = args._arm.split(",")
        result = run_arm(args, Arm(renderer, dmabuf, int(idle_ms)))
        print("CHAN_ARM_JSON " + json.dumps(result))
        return 0

    idles = args.idle_ms or [1000, 3000, 8000]
    renderers = args.renderer or ["webgl", "dom"]
    dmabufs = args.dmabuf or ["on", "off"]
    arms = [
        Arm(renderer, dmabuf, idle)
        for renderer in renderers
        for dmabuf in dmabufs
        for idle in idles
    ]

    out = args.out if args.out.is_absolute() else REPO / args.out
    out.mkdir(parents=True, exist_ok=True)

    results = []
    for arm in arms:
        print(f"running {arm.name} ...", flush=True)
        env = dict(os.environ)
        # The whole reason each arm is its own process: WebKit reads this once,
        # at webview init.
        if arm.dmabuf == "off":
            env["WEBKIT_DISABLE_DMABUF_RENDERER"] = "1"
        else:
            env.pop("WEBKIT_DISABLE_DMABUF_RENDERER", None)
        proc = subprocess.run(
            [
                sys.executable,
                str(pathlib.Path(__file__).resolve()),
                "--_arm",
                f"{arm.renderer},{arm.dmabuf},{arm.idle_ms}",
                "--trials",
                str(args.trials),
                "--settle-ms",
                str(args.settle_ms),
            ],
            env=env,
            capture_output=True,
            text=True,
        )
        if proc.returncode == 2:
            sys.stderr.write(proc.stderr)
            return 2
        payload = None
        for line in proc.stdout.splitlines():
            if line.startswith("CHAN_ARM_JSON "):
                payload = json.loads(line[len("CHAN_ARM_JSON ") :])
        if payload is None:
            print(f"ERROR: {arm.name} produced no result", file=sys.stderr)
            sys.stderr.write(proc.stdout)
            sys.stderr.write(proc.stderr)
            return 2
        results.append(payload)

    (out / "result.json").write_text(
        json.dumps(results, indent=2), encoding="utf-8"
    )
    code = report(results)
    print(f"\n{out / 'result.json'}")
    return code


if __name__ == "__main__":
    sys.exit(main())
