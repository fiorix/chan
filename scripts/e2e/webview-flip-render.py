#!/usr/bin/env python3
"""Render the flip cards in the real Linux desktop webview and assert what paints.

WHY this exists as its own harness: the desktop app's webview is WebKitGTK,
and WebKitGTK ignores `backface-visibility` on every element, pseudo or not.
Chrome honors it, so `browser-smoke/` cannot see this class of defect at all:
a card whose hidden face is only hidden by that property renders correctly in
the smoke suite and covers the entire window in the shipped app.

The CSS under test is not restated here. Each specimen injects the component's
own `<style>` block verbatim and rebuilds the DOM skeleton around it, so the
check follows the component rather than a copy of it.

Usage:
    python3 scripts/e2e/webview-flip-render.py [--out DIR] [--keep]

Exit status: 0 pass, 1 fail, 2 skipped because the GUI stack is unavailable.
A skip is not a pass; report it as a skip.

Needs python-gobject with the WebKit2 4.1 typelib and an X or Wayland display.
Under a headless runner, wrap it: `xvfb-run -a python3 ...`.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]

# The probe fills the content face. Any pixel of this color at the card's
# center means the content face is what painted there.
PROBE_RGB = (0, 255, 0)

# Frozen points on the 520ms turn, chosen either side of the 14.43% handover
# where the card crosses 90deg. Both are far enough from it to survive
# rounding in the engine's animation clock.
PRE_HANDOVER_MS = 60
POST_HANDOVER_MS = 100


class Specimen:
    """One flip card: its component source, its DOM skeleton, its classes."""

    def __init__(self, name, source, host_markup, active_class, root_class):
        self.name = name
        self.source = REPO / source
        self.host_markup = host_markup
        self.active_class = active_class
        self.root_class = root_class

    def style_block(self) -> str:
        text = self.source.read_text(encoding="utf-8")
        match = re.search(r"<style>(.*)</style>", text, re.S)
        if not match:
            raise SystemExit(f"{self.source}: no <style> block")
        return match.group(1)

    def page(self, frozen_ms: int | None) -> str:
        """One specimen at rest, or frozen at a point in the turn."""
        classes = self.root_class
        freeze = ""
        if frozen_ms is not None:
            classes = f"{self.root_class} {self.active_class}"
            # `!important` rather than a more specific selector: the component
            # sets `animation` as a shorthand, which resets every longhand it
            # does not name, and outranking it by specificity alone is
            # brittle against a selector change in the component.
            freeze = f"""
              .host *, .host *::before {{
                animation-play-state: paused !important;
                animation-fill-mode: both !important;
                animation-delay: -{frozen_ms}ms !important;
              }}
            """
        return f"""<!doctype html>
<meta charset="utf-8">
<style>
  /* The theme variables the flip rules read, at their dark-theme values. */
  :root {{
    --bg: #1b1b1d;
    --bg-card: #202024;
    --text: #e6e6e6;
    --border: #333;
    --pane-active-focus: #3b82f6;
    --pane-shadow: none;
  }}
  html, body {{ margin: 0; height: 100%; background: #000; }}
  .host {{
    position: absolute;
    left: 0;
    top: 0;
    width: 400px;
    height: 300px;
    display: flex;
  }}
  .host > * {{ flex: 1; }}
  .probe {{ flex: 1; background: rgb({PROBE_RGB[0]}, {PROBE_RGB[1]}, {PROBE_RGB[2]}); }}
  {freeze}
</style>
<style>
{self.style_block()}
</style>
<div class="host">{self.host_markup.format(classes=classes)}</div>
"""


SPECIMENS = [
    Specimen(
        name="launcher ScreenFlip",
        source="web/packages/launcher/src/components/ScreenFlip.svelte",
        root_class="screen-flip",
        active_class="flipActive",
        host_markup=(
            '<div class="{classes}" style="--screen-flip-start: rotateY(-180deg);'
            ' --screen-flip-back: rotateY(-180deg)">'
            '<div class="screen-flip-inner" data-flip-label="Computers">'
            '<div class="screen-flip-face"><div class="probe"></div></div>'
            "</div></div>"
        ),
    ),
    Specimen(
        name="workspace-app Pane",
        source="web/packages/workspace-app/src/components/Pane.svelte",
        root_class="pane",
        active_class="sideFlipActive",
        host_markup=(
            '<div class="{classes}" style="--pane-side-flip-start: rotateY(-180deg);'
            ' --pane-side-flip-back: rotateY(-180deg)">'
            '<div class="pane-card"><div class="pane-card-inner" data-side-label="A">'
            '<div class="pane-card-face"><div class="probe"></div></div>'
            "</div></div></div>"
        ),
    ),
]


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


def render(gui, html: str, png: pathlib.Path):
    """Paint one page in a real webview and return its cairo surface."""
    GLib, Gtk, WebKit2 = gui
    window = Gtk.Window()
    window.set_default_size(400, 300)
    view = WebKit2.WebView()
    window.add(view)
    window.show_all()
    view.load_html(html, "file:///")

    result = {}

    def finish(view, res):
        result["surface"] = view.get_snapshot_finish(res)
        Gtk.main_quit()

    def snap():
        view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, finish
        )
        return False

    def on_load(view, event):
        # One settle beat after load so the frozen animation has been applied
        # and composited before the snapshot reads it back.
        if event == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(700, snap)

    view.connect("load-changed", on_load)
    # Bound the wait: a webview that never finishes must fail, not hang.
    GLib.timeout_add(20000, lambda: (Gtk.main_quit(), False)[1])
    Gtk.main()
    window.destroy()

    surface = result.get("surface")
    if surface is None:
        raise RuntimeError("the webview produced no snapshot within 20s")
    surface.write_to_png(str(png))
    return surface


def is_probe(rgb) -> bool:
    # Exact-match is too strict against subpixel and color-management drift;
    # the probe is saturated green and every other surface here is dark.
    red, green, blue = rgb
    return green > 180 and red < 90 and blue < 90


def probe_share(surface, x: int, y: int, half: int = 10):
    """The fraction of a patch around (x, y) that the content face painted.

    A patch rather than one pixel: the back face centers a glyph on exactly
    the point a single-pixel read would sample, and subpixel antialiasing
    gives those glyph edges saturated fringes.
    """
    surface.flush()
    data = surface.get_data()
    stride = surface.get_stride()
    hits = 0
    total = 0
    for row in range(y - half, y + half + 1):
        for col in range(x - half, x + half + 1):
            offset = row * stride + col * 4
            blue, green, red = data[offset], data[offset + 1], data[offset + 2]
            hits += is_probe((red, green, blue))
            total += 1
    return hits / total


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=pathlib.Path,
        default=pathlib.Path("target/e2e/webview-flip"),
        help="directory for the rendered PNGs (default: target/e2e/webview-flip)",
    )
    args = parser.parse_args()
    out = args.out if args.out.is_absolute() else REPO / args.out
    out.mkdir(parents=True, exist_ok=True)

    gui = load_gui()
    failures = []

    for specimen in SPECIMENS:
        slug = specimen.root_class
        cases = [
            ("rest", None, True, "the content face paints when no turn is running"),
            (
                f"pre-handover-{PRE_HANDOVER_MS}ms",
                PRE_HANDOVER_MS,
                False,
                "the back face paints while the card is still turned away",
            ),
            (
                f"post-handover-{POST_HANDOVER_MS}ms",
                POST_HANDOVER_MS,
                True,
                "the content face paints once the card is past 90deg",
            ),
        ]
        for case, frozen_ms, want_probe, why in cases:
            png = out / f"{slug}-{case}.png"
            surface = render(gui, specimen.page(frozen_ms), png)
            share = probe_share(surface, 200, 150)
            # A face either owns the card's center or it does not. The wide
            # dead band between the thresholds keeps a partly painted card
            # from reading as either answer.
            got_probe = share > 0.8 if want_probe else share >= 0.2
            ok = got_probe == want_probe
            status = "ok" if ok else "FAIL"
            print(f"{status}  {specimen.name} [{case}]: {why}")
            print(
                f"      content face covers {share:.0%} of the center patch,"
                f" want {'>80%' if want_probe else '<20%'}"
            )
            print(f"      {png}")
            if not ok:
                failures.append(f"{specimen.name} [{case}]")

    if failures:
        print(f"\nFAIL: {len(failures)} case(s): {', '.join(failures)}")
        print(f"PNGs preserved under {out}")
        return 1
    print(f"\nPASS: every flip card paints its content face at rest ({out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
