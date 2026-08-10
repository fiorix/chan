# Terminal grid rendering

What the terminal grid must paint in the desktop app's own webview, across
the shipped backend and font matrix. Runs on
[`../terminal-pixels.py`](../terminal-pixels.py) on Linux, which mounts a
real terminal in WebKitGTK, and on
[`../terminal-pixels.mjs`](../terminal-pixels.mjs) on Windows, which mounts
the same page in WebView2. Both write a fixed pattern and measure the ink
against the same thresholds.

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

Which xterm renderer those two xterm rows carry is a per-OS answer, so the
matrix is the same four scenarios on both platforms but not the same four
measurements. `shouldUseWebglRenderer` is false only for a Linux desktop:
Linux ships the DOM renderer and Windows ships WebGL. Each driver therefore
runs its own platform's renderer as the shipped arm, and `--include-renderers`
adds the other one as a reference rather than a scenario -- the WebGL arm on
Linux, the DOM arm on Windows.

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
Source Code Pro actually decoded.

What the two preferences are expected to do differs by OS, because the
`os-default` chain does. On Linux they resolve to the same chain, because
that arm already leads with the bundled face; the two scenarios are then
expected to render identically, and a divergence means the chain changed. On
Windows `os-default` leads with Cascadia Mono, so the two arms resolve to
different faces and must NOT render identically -- measured cell heights of
18.65px and 21.35px at the same 14px size are those two faces separating, and
seeing them converge would mean the preference stopped being honoured.

## Current status

### Linux

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

**Independently reproduced.** The same table came back from a second machine
sharing nothing with the first: WebKitGTK 2.52.3 under Xvfb on a headless VM
with llvmpipe and a QEMU Cirrus VGA, no GPU and no display. 96.0% and 95.2% to
the digit, ghostty clean at 100%, the same 8.00x21.00px cell.

The gap *positions* reproduced too, which is what makes it the same mechanism
rather than two numbers agreeing: vertical rule gaps at 10+1px, 31+1px, 52+1px,
73+1px, 94+1px and block gaps at 0+1px, 21+1px, 42+1px, 63+1px -- one unpainted
pixel row on the 21px cell pitch.

This works without a GPU because what these scenarios measure is glyph
rasterisation, which is CPU-side. A frame rate would not survive the same
treatment.

### Windows

Everything the Windows desktop ships is clean. On WebView2 151.0.4129.72 at
a device pixel ratio of 1.5, 14px face:

| Scenario                      | TG-01 rule | TG-02 rule | TG-03 block |
| ----------------------------- | ---------- | ---------- | ----------- |
| xterm +webgl, os-default      | 100%       | 100%       | 100%        |
| xterm +webgl, source-code-pro | 100%       | 100%       | 100%        |
| ghostty, either font          | 100%       | 100%       | 100%        |
| xterm DOM, os-default         | 92.9%      | 100%       | 90.0%       |
| xterm DOM, source-code-pro    | 93.8%      | 100%       | 94.4%       |

TG-04 and TG-05 hold on every arm.

The two DOM rows are not shipped here; they are the Linux configuration
measured on this rasteriser, and they matter for two reasons. They are the
same defect Linux reports, which places it in the renderer rather than in
WebKitGTK. And they are worse than the Linux numbers at the same settings,
because a device pixel ratio of 1.5 turns a one-CSS-pixel seam into a two- or
three-device-pixel one.

The corollary is that WebGL is what is holding the Windows grid together. The
gap between the two xterm renderers on one engine, one font and one display
is the whole distance between 90% and 100%, so anything that turns WebGL off
on Windows -- a blocklisted GPU, a software-rendering fallback, a repeat of
the present stall that turned it off on Linux -- lands the desktop app on the
92.9%/90.0% row rather than degrading gently.

Both numbers were taken twice, once in Edge and once in the real WebView2
hosted by `chan-desktop.exe` (`--webview2`), and the two agree to every digit
reported, including the failing arms.

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

- macOS WKWebView. Both tables above are one engine on one OS each.
- **The `--include-renderers` WebGL arm needs a real GPU.** On a llvmpipe/Xvfb
  stack the WebGL layer is never composited into the snapshot, so those rows
  report 0.0% on every measure with gaps spanning the whole region. That is
  "nothing was captured", not "the renderer paints nothing", and reading it as
  the latter would file a defect against the one renderer that measures 100%
  everywhere it can actually be observed. The DOM and ghostty arms are
  unaffected, because glyph rasterisation is CPU-side.
- Any device pixel ratio other than each harness host's. The Windows run
  covers a fractional ratio (1.5) and the Linux run covers 1, but neither
  sweeps the ratio, and 1.5 is where the drivers' own rounding starts to show
  -- see the one-device-pixel inset on the block measurement in
  `terminal-pixels.mjs`, which the Python driver does not need at a ratio of
  1 and does not have.
- Whether the WebGL present stall that keeps `shouldUseWebglRenderer` false
  on Linux still reproduces. A separate probe found five idle writes out of
  five presented on WebKitGTK 2.52.5 in a bare webview, which is evidence
  against it but not against an intermittent fault in the Tauri shell.
