#!/usr/bin/env python3
"""Measure what the terminal grid actually paints in the real Linux webview.

WHY this exists as its own harness: chan's terminal glyphs are drawn by the
engine, not by chan, and the Linux AppImage ships on WebKitGTK with an xterm
renderer selected from its dma-buf capability. Other Linux packages keep the
DOM renderer because they do not run that AppImage policy. Whether a
box-drawing rule joins across a cell boundary, or a solid block tiles without
a seam, is a property of that engine, that renderer and the resolved font face
together. No unit test can see it: jsdom paints nothing and Chrome is a
different rasteriser with a different font stack.

The four default scenarios are explicit DOM and ghostty reference arms over
{os-default, source-code-pro}; --include-renderers adds the xterm WebGL
reference. They cover the AppImage's NVIDIA fallback and accelerated readings
without pretending to execute chan-desktop's driver policy. The font chain is
not restated here; it is read out of terminal/font.ts, the @font-face block
out of the app's own fonts.css and the palette out of TerminalTab.svelte, so
a chain or palette edit moves the measurement with it.

The ghostty pattern arms paint what the grid pattern never reaches: cell
colours and attributes, wide and combined glyphs, each cursor style, history
rows, a view part history and part screen, the selection, small changes the
renderer repaints row by row, the alternate screen, a resize, a theme switch,
a selection moved and dropped, and the overlay scrollbar. Nothing is
measured on them beyond a liveness and a blank region; they are byte-level
references, and --compare holds a run's PNGs to an earlier run's, which is
how a renderer change is accepted. A PNG of the earlier run that names no
scenario this driver has fails too, so a scenario cannot drop out between
the two runs unseen.

Usage:
    python3 scripts/e2e/terminal-pixels.py [--out DIR] [--include-renderers]
                                           [--only SUBSTRING] [--compare DIR]

Exit status: 0 pass, 1 fail, 2 skipped because the GUI stack is unavailable.
A skip is not a pass; report it as a skip.

Needs python-gobject with the WebKit2 4.1 typelib, a display, and an
installed web/node_modules. Under a headless runner, wrap it:
`xvfb-run -a python3 ...`.

It also needs the cairo foreign-struct converter, which is a SEPARATE package
from python-gobject (`python3-gi-cairo` on Debian/Ubuntu). Without it
`get_snapshot_finish` raises TypeError on every scenario. That dependency is
easy to miss because nothing imports cairo by name here: the converter is what
lets the snapshot cross the GI boundary at all.

A caution about the WebGL reference arm under software rendering: on a
llvmpipe/Xvfb stack the WebGL layer is not composited into the snapshot, so
`--include-renderers` reports 0.0% on every measure for those rows. That is
"nothing was captured", not "the renderer paints nothing", and it is why the
webgl arm needs a real GPU to mean anything. The DOM and ghostty arms measure
correctly there, because glyph rasterisation is CPU-side.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import pathlib
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.parse

REPO = pathlib.Path(__file__).resolve().parents[2]
WEB = REPO / "web"
WORKSPACE_APP = WEB / "packages/workspace-app"
FONT_MODULE = WORKSPACE_APP / "src/terminal/font.ts"
FONTS_CSS = WORKSPACE_APP / "src/fonts.css"
TERMINAL_TAB = WORKSPACE_APP / "src/components/TerminalTab.svelte"
GHOSTTY_COMPAT = WORKSPACE_APP / "src/terminal/ghosttyCompat.ts"
PAGE_DIR = pathlib.Path(__file__).resolve().parent / "terminal-pixels"
BUILD_GHOSTTY = PAGE_DIR / "build-ghostty.mjs"

# The host element's size in index.html. The window is opened at exactly this
# size so the whole grid is inside the snapshot.
HOST_W = 800
HOST_H = 560

# TerminalTab's default when preferences carry no font_size.
FONT_SIZE = 14

# A pixel counts as ink when any channel is this far from the terminal
# background. Antialiased glyph edges land well above it and the engine's
# colour management moves the background by a unit or two.
INK_THRESHOLD = 24

# What the shipped renderers have to clear. A rule that breaks at a cell
# boundary and a block rectangle with a seam are the same defect, so the
# rules are held to the same bar as the fill.
MIN_RULE_CONTINUITY = 0.995
MIN_BLOCK_COVERAGE = 0.995

# Nothing is written in the blank region, so anything painted there is either
# stale pixels or an overlay drawing over content.
MAX_BLANK_INK = 0.001

# A pattern arm's written rows hold text, so some of their pixels are ink. A
# page that painted nothing would otherwise match an earlier run that also
# painted nothing.
MIN_PAINTED_INK = 0.01

# The 16 colours a theme names, in the order TerminalTab's theme lists them.
PALETTE_NAMES = (
    "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow",
    "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
)


def linux_font_chain(pref: str) -> str:
    """The chain the terminal hands the renderer on Linux for this preference.

    Read from terminal/font.ts, which owns it. `selectTerminalFont` there puts
    Source Code Pro at the head when the preference asks for it OR the OS is
    Linux, so on Linux the bundled face always leads whatever the preference
    says, and the bare fallback chain this used to return for `os-default` is
    one the product never ships.
    """
    text = FONT_MODULE.read_text(encoding="utf-8")
    match = re.search(r"linux:\s*\n?\s*'([^']*)'", text)
    if not match:
        raise SystemExit(f"{FONT_MODULE}: no linux font chain found")
    del pref  # Linux leads with the bundled face for every preference.
    return f'"Source Code Pro", {match.group(1)}'


def font_face_block() -> str:
    """The app's own @font-face rule, for injection into the page."""
    text = FONTS_CSS.read_text(encoding="utf-8")
    match = re.search(r"@font-face\s*\{.*?\}", text, re.S)
    if not match:
        raise SystemExit(f"{FONTS_CSS}: no @font-face rule found")
    return f"<style>\n{match.group(0)}\n</style>"


def dark_palette() -> dict[str, str]:
    """The 16 colours TerminalTab's dark theme hands the terminal.

    Read from terminalTheme() in TerminalTab.svelte, whose last return is
    the dark branch; the page paints at the dark-theme fallbacks of its
    other colours too.
    """
    text = TERMINAL_TAB.read_text(encoding="utf-8")
    start = text.find("function terminalTheme()")
    end = text.find("\n  }\n", start)
    returns = re.findall(r"return \{\s*\.\.\.base,(.*?)\};", text[start:end], re.S)
    if start < 0 or end < 0 or not returns:
        raise SystemExit(f"{TERMINAL_TAB}: no terminalTheme() palette found")
    palette = dict(re.findall(r'(\w+): "(#[0-9a-fA-F]{6})"', returns[-1]))
    if sorted(palette) != sorted(PALETTE_NAMES):
        raise SystemExit(
            f"{TERMINAL_TAB}: terminalTheme()'s dark palette names"
            f" {sorted(palette)}, not the 16 theme colours"
        )
    return palette


def build_serve_dir(root: pathlib.Path) -> None:
    """Assemble the served tree: the page, the product modules, the vendors.

    Symlinks rather than copies, and one link per package rather than one for
    node_modules, so a stray path in the page cannot serve the whole
    dependency tree over the loopback socket.
    """
    (root / "vendor").mkdir()
    links = {
        "index.html": PAGE_DIR / "index.html",
        "harness.mjs": PAGE_DIR / "harness.mjs",
        "fonts": WORKSPACE_APP / "src/fonts",
        "vendor/xterm": WEB / "node_modules/@xterm/xterm",
        "vendor/addon-webgl": WEB / "node_modules/@xterm/addon-webgl",
    }
    for name, target in links.items():
        if not target.exists():
            raise SystemExit(f"missing {target}; run `npm install` under web/")
        (root / name).symlink_to(target)

    # index.html is a symlink to the checked-in page, so the font face is
    # injected into a copy. Writing it as a sibling would shadow the link.
    page = (PAGE_DIR / "index.html").read_text(encoding="utf-8")
    (root / "index.html").unlink()
    (root / "index.html").write_text(
        page.replace("<!--CHAN_FONT_FACE-->", font_face_block()),
        encoding="utf-8",
    )

    # The ghostty widget is a workspace package of TypeScript sources, so it is
    # bundled into the served tree rather than linked; build-ghostty.mjs says
    # how.
    node = shutil.which("node")
    if node is None:
        raise SystemExit("missing node; the ghostty widget is bundled with it")
    widget = root / "vendor/ghostty-web-ng"
    result = subprocess.run(
        [node, str(BUILD_GHOSTTY), str(widget)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not (widget / "ghostty-web.js").exists():
        raise SystemExit(
            f"build-ghostty.mjs exited {result.returncode}\n"
            f"{result.stdout}\n{result.stderr}"
        )

    # The ghostty adapters are the product's own TypeScript, compiled rather
    # than reimplemented: this harness exists to measure what TerminalTab
    # paints, and a second copy of the alignment and custom-glyph code would
    # measure the copy.
    tsc = WEB / "node_modules/.bin/tsc"
    if not tsc.exists():
        raise SystemExit(f"missing {tsc}; run `npm install` under web/")
    result = subprocess.run(
        [
            str(tsc),
            str(GHOSTTY_COMPAT),
            "--outDir",
            str(root / "product"),
            "--target",
            "es2022",
            "--module",
            "esnext",
            "--moduleResolution",
            "bundler",
            "--lib",
            "es2022,dom",
            "--skipLibCheck",
        ],
        capture_output=True,
        text=True,
        cwd=WORKSPACE_APP,
    )
    if not (root / "product/ghosttyCompat.js").exists():
        raise SystemExit(
            f"tsc emitted no ghosttyCompat.js\n{result.stdout}\n{result.stderr}"
        )


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Static files for the page, without a request line per asset."""

    # WebAssembly.instantiateStreaming rejects a wasm served as octet-stream,
    # and a module script served as one never executes.
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".wasm": "application/wasm",
        ".woff2": "font/woff2",
    }

    def log_message(self, fmt, *args):
        del fmt, args


def serve(root: pathlib.Path):
    """Serve `root` on loopback and return (port, shutdown)."""
    handler = functools.partial(QuietHandler, directory=str(root))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd.server_address[1], httpd.shutdown


def load_gui():
    """Import the GUI stack, or exit 2 when the host cannot provide it."""
    try:
        import gi

        gi.require_version("Gtk", "3.0")
        gi.require_version("WebKit2", "4.1")
        from gi.repository import GLib, Gtk, WebKit2

        if not Gtk.init_check(None)[0]:
            raise RuntimeError("no display; try xvfb-run")
        return GLib, Gtk, WebKit2
    except (ImportError, ValueError, RuntimeError) as exc:
        print(f"SKIP: WebKitGTK is unavailable ({exc})", file=sys.stderr)
        print("SKIP: a skipped check is not a pass", file=sys.stderr)
        raise SystemExit(2) from exc


def render(gui, url: str, png: pathlib.Path):
    """Paint one scenario in a real webview; return (surface, report)."""
    GLib, Gtk, WebKit2 = gui
    window = Gtk.Window()
    window.set_default_size(HOST_W, HOST_H)
    view = WebKit2.WebView()
    # A page that throws before it reports leaves only a timeout to look at,
    # so its console goes to this run's stdout.
    view.get_settings().set_enable_write_console_messages_to_stdout(True)
    window.add(view)
    window.show_all()

    result = {}

    def finish(view, res):
        # An exception raised inside a GLib callback is printed by PyGObject
        # and then swallowed: the loop keeps running, the watchdog fires, and
        # the caller is told "no snapshot within 30s" -- a timeout that is not
        # what happened. Observed for real when the cairo foreign-struct
        # converter was missing (see the dependency note in the docstring):
        # get_snapshot_finish raised TypeError immediately and the run still
        # spent 30 seconds per scenario before reporting the wrong cause.
        try:
            result["surface"] = view.get_snapshot_finish(res)
        except Exception as exc:  # noqa: BLE001 - reported, not raised here
            result["snapshot_error"] = exc
        Gtk.main_quit()

    def snap():
        view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, finish
        )
        return False

    def on_title(view, _param):
        title = view.get_title() or ""
        if title.startswith("chan-pixels-error "):
            result["error"] = title[len("chan-pixels-error ") :]
            Gtk.main_quit()
        elif title.startswith("chan-pixels "):
            result["report"] = json.loads(title[len("chan-pixels ") :])
            # One settle beat after the page reports ready, so the frame it
            # painted has been composited before the snapshot reads it back.
            GLib.timeout_add(400, snap)

    view.connect("notify::title", on_title)
    view.load_uri(url)

    def watchdog():
        result["timed_out"] = True
        Gtk.main_quit()
        return False

    # Bound the wait: a webview that never reports must fail, not hang. The
    # source is dropped rather than left to expire, because an armed timeout
    # outlives the loop it was meant to bound and would quit a later render's
    # loop before that render had snapshotted anything.
    watchdog_id = GLib.timeout_add(30000, watchdog)
    Gtk.main()
    if not result.get("timed_out"):
        GLib.source_remove(watchdog_id)
    window.destroy()

    if "error" in result:
        raise RuntimeError(f"the page failed: {result['error']}")
    if "snapshot_error" in result:
        raise RuntimeError(
            f"the webview could not be snapshotted: {result['snapshot_error']}"
        )
    surface = result.get("surface")
    if surface is None:
        raise RuntimeError("the webview produced no snapshot within 30s")
    if surface.get_width() < HOST_W or surface.get_height() < HOST_H:
        raise RuntimeError(
            f"the webview is {surface.get_width()}x{surface.get_height()},"
            f" smaller than the {HOST_W}x{HOST_H} host; the window manager"
            " clipped it and the sampled cells would not be the pattern's"
        )
    surface.write_to_png(str(png))
    return surface, result["report"]


class Pixels:
    """Ink lookups over a snapshot, relative to the terminal's own grid."""

    def __init__(self, surface, report):
        surface.flush()
        self.data = surface.get_data()
        self.stride = surface.get_stride()
        self.width = surface.get_width()
        self.height = surface.get_height()
        self.origin_x = report["originX"]
        self.origin_y = report["originY"]
        self.cell_w = report["cellWidth"]
        self.cell_h = report["cellHeight"]
        # The background is read from the snapshot rather than from the theme
        # string: the engine's colour management shifts it, and a hardcoded
        # reference would count that shift as ink over the whole grid.
        self.background = self.rgb(self.width - 2, self.height - 2)

    def rgb(self, x: int, y: int):
        offset = y * self.stride + x * 4
        return (
            self.data[offset + 2],
            self.data[offset + 1],
            self.data[offset],
        )

    def is_ink(self, x: int, y: int) -> bool:
        pixel = self.rgb(x, y)
        return any(
            abs(pixel[i] - self.background[i]) > INK_THRESHOLD for i in range(3)
        )

    def cell_rect(self, first_col: int, first_row: int, cols: int, rows: int):
        """The pixel box of a cell span, clamped to the snapshot."""
        left = int(round(self.origin_x + first_col * self.cell_w))
        top = int(round(self.origin_y + first_row * self.cell_h))
        right = int(round(self.origin_x + (first_col + cols) * self.cell_w))
        bottom = int(round(self.origin_y + (first_row + rows) * self.cell_h))
        return (
            max(0, left),
            max(0, top),
            min(self.width, right),
            min(self.height, bottom),
        )

    def grow(self, rect, dx: float, dy: float):
        """Widen a box, clamped to the snapshot."""
        left, top, right, bottom = rect
        return (
            max(0, int(round(left - dx))),
            max(0, int(round(top - dy))),
            min(self.width, int(round(right + dx))),
            min(self.height, int(round(bottom + dy))),
        )

    def inked_rows(self, rect):
        """Which scanlines of a box carry any ink, top to bottom."""
        left, top, right, bottom = rect
        return [
            any(self.is_ink(x, y) for x in range(left, right))
            for y in range(top, bottom)
        ]

    def inked_cols(self, rect):
        """Which columns of a box carry any ink, left to right."""
        left, top, right, bottom = rect
        return [
            any(self.is_ink(x, y) for y in range(top, bottom))
            for x in range(left, right)
        ]

    def coverage(self, rect) -> float:
        """The fraction of a box that is ink."""
        left, top, right, bottom = rect
        total = (right - left) * (bottom - top)
        if total <= 0:
            return 0.0
        hits = sum(
            self.is_ink(x, y)
            for y in range(top, bottom)
            for x in range(left, right)
        )
        return hits / total


def gap_bands(flags) -> list[tuple[int, int]]:
    """The runs of False in a scanline mask, as (offset, length) pairs."""
    bands = []
    start = None
    for index, flag in enumerate(flags):
        if not flag and start is None:
            start = index
        elif flag and start is not None:
            bands.append((start, index - start))
            start = None
    if start is not None:
        bands.append((start, len(flags) - start))
    return bands


def span_rect(pixels: Pixels, region) -> tuple[int, int, int, int]:
    """The pixel box of a region given as an inclusive cell span."""
    return pixels.cell_rect(
        region["firstCol"],
        region["firstRow"],
        region["lastCol"] - region["firstCol"] + 1,
        region["lastRow"] - region["firstRow"] + 1,
    )


def measure(pixels: Pixels, report) -> dict:
    """Every number the scenario's own regions support.

    A scenario declares what it painted, so the new-tab arm (which paints a
    prompt and nothing else) yields only the blank check rather than reading
    rule continuity off cells that were never drawn in.
    """
    regions = report["regions"]
    numbers = {}

    # Half a cell past each end of the rule spans: that reaches the middle of
    # each corner cell, which is where the corner's stroke begins, so the two
    # corner joins are measured and the corner's background half is not.
    if "rule" in regions:
        rule = regions["rule"]
        rect = pixels.cell_rect(
            rule["col"], rule["firstRow"], 1, rule["lastRow"] - rule["firstRow"] + 1
        )
        rows = pixels.inked_rows(pixels.grow(rect, 0, pixels.cell_h / 2))
        numbers["rule_continuity"] = sum(rows) / max(1, len(rows))
        numbers["rule_gaps"] = gap_bands(rows)

    if "top" in regions:
        top = regions["top"]
        rect = pixels.cell_rect(
            top["firstCol"], top["row"], top["lastCol"] - top["firstCol"] + 1, 1
        )
        cols = pixels.inked_cols(pixels.grow(rect, pixels.cell_w / 2, 0))
        numbers["top_continuity"] = sum(cols) / max(1, len(cols))
        numbers["top_gaps"] = gap_bands(cols)

    if "block" in regions:
        rect = span_rect(pixels, regions["block"])
        numbers["block_coverage"] = pixels.coverage(rect)
        numbers["block_gaps"] = gap_bands(pixels.inked_rows(rect))

    if "blank" in regions:
        numbers["blank_ink"] = pixels.coverage(span_rect(pixels, regions["blank"]))

    if "painted" in regions:
        numbers["painted_ink"] = pixels.coverage(
            span_rect(pixels, regions["painted"])
        )

    return numbers


class Scenario:
    """One cell of the explicit reference matrix."""

    def __init__(
        self,
        backend: str,
        font: str,
        renderer: str = "dom",
        new_tab: bool = False,
        pattern: str = "",
        cursor_style: str = "",
    ):
        self.backend = backend
        self.font = font
        # Only meaningful for the xterm backend; ghostty owns its renderer.
        self.renderer = renderer
        self.new_tab = new_tab
        # One of the page's reference patterns, or "" for the grid pattern.
        self.pattern = pattern
        # The widget's cursorStyle option, for the cursor patterns.
        self.cursor_style = cursor_style

    @property
    def name(self) -> str:
        suffix = "" if self.renderer == "dom" else f" +{self.renderer}"
        suffix += " (second tab)" if self.new_tab else ""
        if self.pattern:
            style = f" {self.cursor_style}" if self.cursor_style else ""
            suffix += f", {self.pattern}{style} pattern"
        return f"{self.font}, {self.backend}{suffix}"

    @property
    def slug(self) -> str:
        pattern = self.pattern
        if self.cursor_style:
            pattern = pattern.replace("cursor-", f"cursor-{self.cursor_style}-")
        return (
            f"{self.backend}-{self.font}"
            f"{'' if self.renderer == 'dom' else '-' + self.renderer}"
            f"{'-newtab' if self.new_tab else ''}"
            f"{'-' + pattern if pattern else ''}"
        )

    def url(self, port: int) -> str:
        config = {
            "backend": self.backend,
            "font": self.font,
            "fontFamily": linux_font_chain(self.font),
            "fontSize": FONT_SIZE,
            "newTab": self.new_tab,
            "renderer": self.renderer,
        }
        # The grid pattern paints default colours under the widget's default
        # cursor style, so only the pattern arms carry these.
        if self.pattern:
            config["pattern"] = self.pattern
            config["palette"] = dark_palette()
        if self.cursor_style:
            config["cursorStyle"] = self.cursor_style
        fragment = urllib.parse.quote(json.dumps(config))
        return f"http://127.0.0.1:{port}/index.html#{fragment}"


# The default reference matrix, in the order the settings present it, then the
# same backends opening a second tab while the first still holds its content.
SCENARIOS = [
    Scenario("xterm", "os-default"),
    Scenario("xterm", "source-code-pro"),
    Scenario("ghostty", "os-default"),
    Scenario("ghostty", "source-code-pro"),
    Scenario("xterm", "os-default", new_tab=True),
    Scenario("ghostty", "os-default", new_tab=True),
]

# The ghostty reference patterns (harness.mjs's PATTERNS), each cursor pattern
# once per cursor style the widget draws. On the os-default arm only: on Linux
# both font preferences resolve to the same chain (TG-06), so a second font
# arm would paint the same PNGs.
PATTERN_SCENARIOS = [
    Scenario("ghostty", "os-default", pattern="attrs"),
    Scenario("ghostty", "os-default", pattern="glyphs"),
    Scenario("ghostty", "os-default", pattern="scrollback"),
    Scenario("ghostty", "os-default", pattern="partial-scroll"),
    Scenario("ghostty", "os-default", pattern="selection"),
    Scenario("ghostty", "os-default", pattern="redraw"),
    Scenario("ghostty", "os-default", pattern="alt-screen"),
    Scenario("ghostty", "os-default", pattern="resize"),
    Scenario("ghostty", "os-default", pattern="theme"),
    Scenario("ghostty", "os-default", pattern="select-move"),
    Scenario("ghostty", "os-default", pattern="scrollbar"),
] + [
    Scenario("ghostty", "os-default", pattern=f"cursor-{where}", cursor_style=style)
    for style in ("block", "underline", "bar")
    for where in ("blank", "glyph")
]

# Explicit accelerated-path reference, run only under --include-renderers.
# The Linux AppImage ships this arm when dma-buf is available and the default
# DOM arm when it is disabled; other Linux packages stay on DOM. WebGL is the
# only alternative xterm renderer available:
# @xterm/addon-canvas has no release for xterm 6, and installing it pulls the
# core back to 5.5.
RENDERER_SCENARIOS = [
    Scenario("xterm", "os-default", renderer="webgl"),
    Scenario("xterm", "source-code-pro", renderer="webgl"),
]


def report_scenario(scenario: Scenario, report, numbers) -> list[str]:
    """Print one scenario's numbers; return the assertions it failed."""
    failures = []
    catalog = [
        (
            "vertical rule joins across cells",
            "rule_continuity",
            MIN_RULE_CONTINUITY,
            "min",
            "rule_gaps",
        ),
        (
            "horizontal rule joins across cells",
            "top_continuity",
            MIN_RULE_CONTINUITY,
            "min",
            "top_gaps",
        ),
        (
            "solid block tiles without a seam",
            "block_coverage",
            MIN_BLOCK_COVERAGE,
            "min",
            "block_gaps",
        ),
        (
            "nothing paints where nothing was written",
            "blank_ink",
            MAX_BLANK_INK,
            "max",
            None,
        ),
        (
            "the pattern painted where it wrote",
            "painted_ink",
            MIN_PAINTED_INK,
            "min",
            None,
        ),
    ]
    checks = [
        (label, numbers[key], bound, direction, numbers.get(gaps_key) or [])
        for label, key, bound, direction, gaps_key in catalog
        if key in numbers
    ]
    for label, value, bound, direction, gaps in checks:
        ok = value >= bound if direction == "min" else value <= bound
        status = "ok" if ok else "FAIL"
        comparator = ">=" if direction == "min" else "<="
        print(f"  {status}  {label}: {value:.1%} (want {comparator} {bound:.1%})")
        if gaps and not ok:
            shown = ", ".join(f"{off}+{length}px" for off, length in gaps[:6])
            more = "" if len(gaps) <= 6 else f", +{len(gaps) - 6} more"
            print(f"        gaps at {shown}{more}")
        if not ok:
            failures.append(f"{scenario.name}: {label}")

    cell = f"{report['cellWidth']:.2f}x{report['cellHeight']:.2f}"
    print(
        f"        renderer {report['renderer']}, cell {cell}px,"
        f" grid {report['cols']}x{report['rows']},"
        f" Source Code Pro {'loaded' if report['faceLoaded'] else 'MISSING'}"
    )
    for warning in report["warnings"]:
        print(f"        warning: {warning}")
    return failures


def compare_png(scenario: Scenario, png: pathlib.Path, reference: pathlib.Path):
    """Hold one PNG to the reference run's; return the assertion it failed.

    Bytes, not pixels: the snapshot is written by one cairo build in both
    runs, so the same pixels encode to the same file, and any difference is a
    difference in what was painted.
    """
    earlier = reference / png.name
    label = f"PNG is byte-identical to {earlier}"
    if not earlier.is_file():
        print(f"  FAIL  {label}: the reference run has no such PNG")
    elif earlier.read_bytes() != png.read_bytes():
        print(f"  FAIL  {label}: the bytes differ")
    else:
        print(f"  ok  {label}")
        return []
    return [f"{scenario.name}: PNG differs from {earlier}"]


def unwritten_references(
    reference: pathlib.Path, written: list[str], skipped: set[str], only: str
):
    """Fail each PNG of the reference run that this run should have written.

    Only the PNGs a run writes are compared, so a scenario dropped or renamed
    since the reference run would otherwise pass unseen. `skipped` names the
    scenarios this run's selection left out, and a name outside `--only`
    is never expected.
    """
    failures = []
    for earlier in sorted(reference.glob("*.png")):
        if earlier.name in written or earlier.name in skipped:
            continue
        if only not in earlier.stem:
            continue
        print(f"  FAIL  {earlier} has no PNG of this run's to match")
        failures.append(f"{earlier.name}: in {reference}, not written by this run")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("target/e2e/terminal-pixels"),
        help="directory for the rendered PNGs",
    )
    parser.add_argument(
        "--include-renderers",
        action="store_true",
        help="also measure the explicit xterm WebGL reference arms",
    )
    parser.add_argument(
        "--only",
        default="",
        help="run only scenarios whose slug contains this substring",
    )
    parser.add_argument(
        "--compare",
        type=pathlib.Path,
        help="an earlier run's --out directory: every PNG this run writes"
        " must be byte-identical to the one of the same name there, and a PNG"
        " there of a scenario this driver no longer has fails, unless --only"
        " leaves its name out",
    )
    args = parser.parse_args()
    out = args.out if args.out.is_absolute() else REPO / args.out
    out.mkdir(parents=True, exist_ok=True)
    reference = None
    if args.compare:
        reference = (
            args.compare if args.compare.is_absolute() else REPO / args.compare
        )
        if not reference.is_dir():
            raise SystemExit(f"--compare {reference}: no such directory")
        if reference.resolve() == out.resolve():
            raise SystemExit("--compare names the directory this run writes")

    scenarios = SCENARIOS + PATTERN_SCENARIOS + (
        RENDERER_SCENARIOS if args.include_renderers else []
    )
    every = SCENARIOS + PATTERN_SCENARIOS + RENDERER_SCENARIOS
    if args.only:
        scenarios = [s for s in scenarios if args.only in s.slug]
    if not scenarios:
        raise SystemExit(f"--only {args.only!r} matched no scenario")

    gui = load_gui()
    root = pathlib.Path(tempfile.mkdtemp(prefix="chan-terminal-pixels-"))
    failures = []
    try:
        build_serve_dir(root)
        port, shutdown = serve(root)
        try:
            for scenario in scenarios:
                png = out / f"{scenario.slug}.png"
                print(f"\n{scenario.name}")
                surface, report = render(gui, scenario.url(port), png)
                numbers = measure(Pixels(surface, report), report)
                failures.extend(report_scenario(scenario, report, numbers))
                if reference is not None:
                    failures.extend(compare_png(scenario, png, reference))
                print(f"        {png}")
        finally:
            shutdown()
    finally:
        # Created by this run and positively identified: a mkdtemp path that
        # is still a directory and still holds the page it was built with.
        if (root / "harness.mjs").is_symlink():
            shutil.rmtree(root)

    if reference is not None:
        print(f"\nreference run {reference}")
        written = [f"{s.slug}.png" for s in scenarios]
        skipped = {f"{s.slug}.png" for s in every} - set(written)
        failures.extend(
            unwritten_references(reference, written, skipped, args.only)
        )

    if failures:
        print(f"\nFAIL: {len(failures)} assertion(s)")
        for failure in failures:
            print(f"  {failure}")
        print(f"PNGs preserved under {out}")
        return 1
    matched = f", every PNG matching {reference}" if reference else ""
    print(f"\nPASS: every scenario's assertions hold{matched} ({out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
