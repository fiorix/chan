# Terminal grid rendering

What the terminal grid must paint in the desktop app's own webview, across
the shipped backend and font matrix. Runs on
[`../terminal-pixels.py`](../terminal-pixels.py), which mounts a real
terminal in WebKitGTK, writes a fixed pattern, and measures the ink.

Glyph geometry is decided by the engine, the renderer and the resolved font
face together, so nothing below can be covered by a unit test: jsdom paints
nothing, and Chrome is a different rasteriser with a different font stack.
`browser-smoke/` is blind to this class of defect for the same reason.

## The matrix

Four scenarios, the cross of the two terminal backends with the two font
preferences, plus a second-tab arm per backend:

| Scenario                  | Backend    | `terminal.font`   |
| ------------------------- | ---------- | ----------------- |
| `xterm-os-default`        | xterm.js   | `os-default`      |
| `xterm-source-code-pro`   | xterm.js   | `source-code-pro` |
| `ghostty-os-default`      | ghostty    | `os-default`      |
| `ghostty-source-code-pro` | ghostty    | `source-code-pro` |

`--include-renderers` adds the WebGL arm, which the Linux desktop turns off
(see `shouldUseWebglRenderer`). It is a reference, not a shipped scenario.

## Scenarios

### TG-01 A vertical rule joins across every cell boundary

A column of `│` between two corners paints an unbroken line. The measure is
the fraction of scanlines carrying ink over the rule's span, corner joins
included; it must be at least 99.5%.

A break here is one unpainted row of pixels per cell, which reads as a dotted
border down every panel a TUI draws.

### TG-02 A horizontal rule joins across every cell boundary

The same for a run of `─`, measured across columns.

### TG-03 A solid block tiles without a seam

A rectangle of `█` is ink in every pixel: at least 99.5% coverage of its
bounding box. This is the strictest form of TG-01 and TG-02, because any
unpainted strip inside a solid rectangle is a gap by definition.

Block elements are defined by the cell rather than by a typeface, so a
renderer that defers them to the font inherits that font's ink height and
bands every bar chart, gauge and sparkline drawn with them.

### TG-04 Nothing paints where nothing was written

Cells the pattern never touched stay at the background colour. Ink there is
either stale pixels the renderer failed to clear or an overlay drawing over
content.

### TG-05 A second tab paints only its own content

With one terminal already holding a full screen, a second terminal built
from the same process-wide backend comes up showing its prompt and nothing
else. The backends share one Ghostty WASM instance, so this is where a leak
between terminals would surface.

### TG-06 The font preference resolves to what the chain says

The harness reads the chain out of `TerminalTab.svelte` and reports whether
Source Code Pro actually decoded. On Linux the two preferences resolve to
the same chain, because the `os-default` arm already leads with the bundled
face; the two scenarios are then expected to render identically, and a
divergence means the chain changed.

## Current status

A clean run is not the current state. On WebKitGTK 2.52.5 with a 14px face
and a 21px cell:

| Scenario                | TG-01 rule | TG-02 rule | TG-03 block |
| ----------------------- | ---------- | ---------- | ----------- |
| xterm, either font      | 96.0%      | 100%       | 95.2%       |
| ghostty, either font    | 100%       | 100%       | 100%        |
| xterm +webgl (not ship) | 100%       | 100%       | 100%        |

The xterm rows are the open defect, not a harness fault: one unpainted row of
pixels at every cell boundary, because the DOM renderer defers box drawing
and block elements to the font and has no custom-glyph path to switch on.
The two font preferences produce byte-identical renders on Linux, which is
TG-06 holding rather than a duplicate scenario.

## Standing decisions

Recorded so a later session does not relitigate them from scratch.

- The engine that ships decides what the renderer may defer to the font. Box
  drawing and block elements are cell geometry, not typography, and any
  renderer that cannot draw them itself will show seams under a line height
  above 1.0.
- Cell edges snap to device pixels before filling. Two neighbouring cells
  that each round their shared edge independently both antialias half of it,
  and the seam that produces is the defect, not a rounding detail.
- `@xterm/addon-canvas` is not an option while chan is on xterm 6: its
  published releases peer-depend on xterm 5, and installing it silently
  pulls the core back to 5.5.0. WebGL is the only alternative xterm renderer
  available.

## Unmeasured

- macOS WKWebView and Windows WebView2. Every number here is WebKitGTK on
  Linux.
- Any device pixel ratio other than the harness host's. The block fill snaps
  to the renderer's own ratio and is unit-tested at 1 and 2, but no scenario
  here runs at a fractional ratio.
- Whether the WebGL present stall that keeps `shouldUseWebglRenderer` false
  on Linux still reproduces. A separate probe found five idle writes out of
  five presented on WebKitGTK 2.52.5 in a bare webview, which is evidence
  against it but not against an intermittent fault in the Tauri shell.
