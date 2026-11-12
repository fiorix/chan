# Terminal grid rendering

What the terminal grid must paint in the desktop app's own webview, across
the backend, font and renderer reference matrix. Runs on
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

The Linux driver also paints the ghostty reference patterns (TG-07) on the `os-default` arm.

Which xterm renderer a desktop carries is a runtime capability answer, not a
property of these four scenario names. The Linux driver keeps DOM as its
default explicit reference and `--include-renderers` adds WebGL. The Linux
AppImage ships the WebGL arm when dma-buf is available and the DOM arm when it
is disabled, including the proprietary NVIDIA default; other Linux packages
keep DOM because they do not run that policy. The harness does not execute the
driver policy. The Windows driver defaults to the shipped WebGL arm and
`--include-renderers` adds DOM as its reference.

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

With one terminal already holding a full screen, a second terminal built from the same process-wide backend comes up showing its prompt and nothing else. Every ghostty terminal instantiates the one compiled libghostty-vt module into a memory of its own and shares the page with the others, so this is where a leak between terminals would surface.

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

### TG-07 A reference pattern paints what the run it is compared with painted

The grid pattern reaches default colours, box and block glyphs and ASCII text only, so a change to the widget's renderer can keep it intact while it repaints everything else. The ghostty pattern arms cover the rest, each on a fresh terminal at TerminalTab's dark palette (read out of `TerminalTab.svelte`):

| Scenario                                | What it paints                  |
| --------------------------------------- | ------------------------------- |
| `ghostty-os-default-attrs`              | colours and attributes          |
| `ghostty-os-default-glyphs`             | wide and combined glyphs, wraps |
| `ghostty-os-default-scrollback`         | history rows in a scrolled view |
| `ghostty-os-default-selection`          | a selection over four rows      |
| `ghostty-os-default-cursor-STYLE-glyph` | a cursor on a glyph             |
| `ghostty-os-default-cursor-STYLE-blank` | a cursor on a blank cell        |

- `attrs`: explicit backgrounds and foregrounds from the 16-colour palette, the 256-colour table and RGB; bold, faint, italic, the underline styles, blink, inverse, invisible, strikethrough and overline, alone and combined; block and box glyphs under attributes; cells that have a background and no character, from an erase in a colour (EL, ECH). Its first row puts explicit black backgrounds (the palette's, the 256-colour table's, RGB) beside default ones.
- `glyphs`: CJK with and without attributes, emoji with a skin tone, ZWJ sequences and variation selectors, combining marks and clusters, a wide character that does not fit in the last column and wraps, and a soft-wrapped row.
- `scrollback`: 41 rows of output viewed 12 rows back, so history rows (with the attributes above, and one row that soft-wrapped) fill the top of the view and screen rows the bottom. The arm waits for the overlay scrollbar to fade out before it reports, since a frame taken mid-fade does not reproduce, so the scrollbar itself is not in the PNG.
- `selection`: a selection from inside row 2 to inside row 5 over coloured, inverse, wide, combined and box-glyph cells; the first, middle and last rows of a selection are painted by separate branches.
- `cursor-STYLE-glyph` and `cursor-STYLE-blank`: a visible cursor in each style the widget draws (`block`, `underline`, `bar`), on a glyph and on a blank cell.

They are references, not measures: each asserts only that it painted where it wrote (at least 1% ink) and nothing where nothing was written (TG-04), so that a page that drew nothing cannot pass for a match. The PNG is the oracle. `--compare DIR` fails every PNG that is not byte-identical to the one of the same name an earlier run wrote in `DIR`, and every PNG in `DIR` of a scenario the driver no longer has (within `--only`), so a renderer change is accepted by a run at its base with `--out DIR` and one at its tip with `--compare DIR`. Both runs belong in one environment: the PNGs depend on the WebKitGTK build and on the installed fonts, and a rig guest has DejaVu only, so CJK and most emoji paint as missing-glyph boxes there. They still exercise the renderer's two-cell backgrounds, decorations and grapheme lookup.

They run on the `os-default` arm only, because on Linux both preferences resolve to the same chain (TG-06) and a second font arm would paint the same PNGs, and under the Linux driver only; the Windows driver keeps the grid pattern.

## Current status

### Linux

The explicit reference arms on WebKitGTK 2.52.5 with a 14px face and a 21px
cell measure:

| Scenario                  | TG-01 rule | TG-02 rule | TG-03 block |
| ------------------------- | ---------- | ---------- | ----------- |
| xterm DOM, either font    | 96.0%      | 100%       | 95.2%       |
| ghostty, either font      | 100%       | 100%       | 100%        |
| xterm WebGL, either font  | 100%       | 100%       | 100%        |

The xterm DOM rows expose one unpainted row at every cell boundary because
that renderer defers box drawing and block elements to the font and has no
custom-glyph path to switch on. They are the proprietary NVIDIA AppImage
default, the forced dma-buf-off reference, and the default for other Linux
packages. The WebGL rows are the non-NVIDIA AppImage default and forced
dma-buf-on reference. The two font preferences produce
byte-identical renders on Linux, which is TG-06 holding rather than a
duplicate scenario.

**Independently reproduced.** The same DOM and ghostty rows came back from a
second machine sharing nothing with the first: WebKitGTK 2.52.3 under Xvfb on
a headless VM with llvmpipe and a QEMU Cirrus VGA, no GPU and no display.
96.0% and 95.2% to the digit, ghostty clean at 100%, the same 8.00x21.00px
cell.

The gap *positions* reproduced too, which is what makes it the same mechanism
rather than two numbers agreeing: vertical rule gaps at 10+1px, 31+1px, 52+1px,
73+1px, 94+1px and block gaps at 0+1px, 21+1px, 42+1px, 63+1px -- one unpainted
pixel row on the 21px cell pitch.

This works without a GPU because what these scenarios measure is glyph
rasterisation, which is CPU-side. A frame rate would not survive the same
treatment.

The reference patterns (TG-07) reproduce byte for byte across three runs under Xvfb in a rig guest (WebKitGTK 2.52.6, DejaVu fonts). What the patterns record today, so that a difference at a renderer change is read against what was there and not against what ought to be:

- An explicit background of RGB (0,0,0) is left unpainted: the renderer takes a zero background for the default and keeps the theme's, so `\e[48;2;0;0;0m` and `\e[48;5;16m` cells show the theme background, while `\e[40m` paints the palette's black (`#0c0c0d` in the dark theme) and RGB (1,1,1) paints.
- In a scrolled-back view, a history row's grapheme cluster is looked up in the screen row at the same viewport row, so the row `history 12` paints a blank where its cluster of `e` and U+0301 is.
- Selected text is painted in the renderer's default selection foreground, `#1e1e1e`, since chan's theme names none.
- Every underline style paints one straight underline; overline adds nothing to a cell and blinking text stays lit.

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
- The shipped AppImage selector on the three required real-driver states:
  WebGL on a non-NVIDIA desktop, DOM on a proprietary NVIDIA desktop, and
  WebGL on that same NVIDIA desktop with `CHAN_LINUX_DMABUF=on`. Unit and
  served-shell tests prove the signal chain, but only those pixel readings can
  accept it.
- Any device pixel ratio other than each harness host's. The Windows run
  covers a fractional ratio (1.5) and the Linux run covers 1, but neither
  sweeps the ratio, and 1.5 is where the drivers' own rounding starts to show
 -- see the one-device-pixel inset on the block measurement in
  `terminal-pixels.mjs`, which the Python driver does not need at a ratio of
  1 and does not have.
