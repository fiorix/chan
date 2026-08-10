# The terminal's bundled face never loads and its block glyphs miss the cell

Status: REGISTERED 2026-08-10, after the fact. The work was done unplanned, off the roadmap, and is registered here so v0.88.0 carries it as accepted scope. IMPLEMENTED in `856c36e3` (the face), `eef8739a` (the block glyphs), `81f920a6` and `51fe458f` (the instrument that measures both, on Linux and on Windows). **Partial**: the ghostty backend and everything the Windows desktop ships are clean; the xterm DOM renderer that the Linux desktop ships still bands rules and blocks, and the scenario pack exits 1 on those arms by design.

## What

Two independent defects in what the terminal actually paints, neither of which anything above the pixels could see.

### The face never loaded

`fonts.css` declared an absolute `/static/fonts/SourceCodePro-Regular.otf.woff2` while every tenant mounts under a single-segment slug and the SPA builds with base `./` for exactly that reason. The request resolved against the origin root, where the launcher root fallback answers `index.html`, so the browser got a 200 of the wrong type and the face failed to decode. Nothing surfaced it: `font-display: swap` kept walking the fallback chain and the terminal came up in a system font that looked close enough to pass.

The rust-embed bundle behind that path was gated on an `embed-font` cargo feature no build target sets, so released binaries carried no font at all and a runtime download from Adobe's GitHub release was the only way to populate the path. That download is what surfaced as an intermittent "not found".

The woff2 now rides vite's asset pipeline like every other asset, so the emitted URL is relative and resolves under any prefix, and the bytes ship inside the SPA bundle with nothing to fetch and no feature to remember. `serve_font`, the `/static/fonts/{name}` route, `routes/fonts.rs`, the download endpoint and its SPA client method all go with it. The SIL OFL notice ships beside the face, which is what permits bundling it at all.

With the face reachable, the `os-default` chain becomes per-OS. One chain served all three platforms and named DejaVu Sans Mono ahead of the generic fallbacks, so Linux landed on whatever fontconfig installed first while macOS took SF Mono, and the same session rendered in a noticeably wider, squarer face on the two. macOS and Windows keep leading with their native mono. Linux leads with the bundled face, the one answer that does not vary by distro.

### Block glyphs missed the cell

Bar charts, gauges and sparklines came out banded on the ghostty backend. Block elements were left to the font, and a font draws them at the glyph's own ink height, so chan's 1.2 line height left an unpainted row of pixels at every cell boundary. A block element is defined by the cell rather than by a typeface, so no font can be the right answer: the same character has to reach the cell's edges whatever face resolves.

The whole U+2580..U+259F range is drawn from a table of the fractions of the cell each character fills. Cell edges snap to the device pixel ratio before filling, because two neighbouring cells that each round their shared edge independently both antialias half of it, which is the seam again in a lighter colour. Shades paint at reduced coverage rather than as a dither, which would moire against the cell grid at some sizes and flatten at others.

Measured in a real WebKitGTK view at a 14px face and a 21px cell: a rectangle of U+2588 covered 95.2% of its bounding box before and 100.0% after, with the missing rows landing exactly on the cell pitch.

## Why this needed a new instrument

Glyph geometry is decided by the engine, the renderer and the resolved face together, so nothing below the pixels can cover it. jsdom paints nothing, and Chrome is a different rasteriser with a different font stack, which is why `browser-smoke/` is blind to this whole class. Both defects above shipped through a green suite.

The [terminal grid rendering](../../../scripts/e2e/scenarios/terminal-grid-rendering.md) scenario pack closes that. `terminal-pixels.py` mounts a real terminal in WebKitGTK and `terminal-pixels.mjs` mounts the same page in WebView2; both write one fixed pattern across the shipped backend and font matrix and measure the ink against the same thresholds. The page follows the product rather than a copy of it: the font chain is read out of `TerminalTab.svelte` with the component's own promotion rule, the `@font-face` block out of `fonts.css`, and the ghostty adapters are the real `src/terminal/ghosttyCompat.ts`.

## Contract

- The bundled face resolves under any tenant prefix, from bytes the binary already carries, with no runtime download and no cargo feature to remember.
- The `os-default` chain gives each OS an answer that does not vary by what the host happens to have installed.
- Box drawing and block elements are cell geometry, not typography. A renderer that defers them to the font shows seams under a line height above 1.0, and the engine that ships decides what may be deferred.
- What the grid paints is measured in the engine the desktop app actually runs, not inferred from a different rasteriser.

## Acceptance

- The face is served and decodes under a prefixed mount, which is where the bug lived. Met: verified end to end against `/myworkspace/`, with the old absolute path confirmed 404 and the OFL notice served alongside.
- Block elements reach the cell edges on the shipping ghostty backend. Met: TG-03 at 100% coverage, up from 95.2%.
- The measurement runs in the real desktop engine on more than one platform. Met on Linux (WebKitGTK 2.52.5) and Windows (WebView2 151.0.4129.72, taken twice, once in Edge and once in the real WebView2 hosted by `chan-desktop.exe`, agreeing to every digit).
- Everything the Windows desktop ships is clean across the matrix. Met.
- **Not met, and deliberately recorded rather than fixed**: the xterm DOM renderer the Linux desktop ships still bands rules and blocks, at 96.0% rule continuity and 95.2% block coverage. `shouldUseWebglRenderer` is false only for a Linux desktop, so Linux is the one platform on the failing row. The Windows DOM reference arms report the same defect worse (92.9% and 90.0%, a fractional device pixel ratio turning a one-CSS-pixel seam into two or three), which places the cause in the renderer rather than in WebKitGTK.
- Also unmeasured: macOS WKWebView entirely, and any device pixel ratio other than each harness host's.
- The rendered glyphs are not visually confirmed in a running desktop app, only the served bytes, the emitted chain, and the measured ink.

## What remains

The residual is a live defect on the platform chan develops on, and it has a named blocker. WebGL is the only alternative xterm renderer available (`@xterm/addon-canvas` peer-depends on xterm 5 and installing it silently pulls the core back to 5.5.0), and WebGL is off on Linux because of a present stall whose current reproducibility is itself unmeasured: a separate probe found five idle writes out of five presented on WebKitGTK 2.52.5 in a bare webview, which is evidence against the stall but not against an intermittent fault in the Tauri shell.

So the next move is to establish whether that stall still reproduces, because if it does not, turning WebGL on for the Linux desktop closes the residual outright. This deserves its own item once someone picks it up; it is recorded here rather than split off because the measurement that would settle it is the instrument this item just built.

### Every reading so far has an uncontrolled variable in it

`desktop/src-tauri/src/linux_gui_stack.rs` sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1`, but `prefer_system_gui_stack()` returns
early when the process is not an AppImage. So the **shipped AppImage runs with
the dma-buf renderer off, and a `cargo tauri dev` or a directly-run
`target/release/chan-desktop` runs with it on.** The bare-webview probe that
found five idle writes of five presented had it on, because nothing set it.

dma-buf is the mechanism by which WebKit hands GPU buffers to the compositor,
and the fault under investigation is precisely "drawn into the GL canvas but
not presented until something wakes the compositor". That is a buffer-handoff
fault, and this switch controls buffer handoff. The comment at
`TerminalTab.svelte:784` asserts the `WEBKIT_DISABLE_DMABUF_RENDERER` fix "is
about webview creation, not this per-layer present stall" — which is plausible,
is stated without a measurement, and sits on the switch that decides the
question.

The claim is not that the comment is wrong. It is that **nobody has tested it**,
and that a stall reading which does not say which side of that switch it was
taken on cannot settle the question. So the shipped configuration and every
configuration anyone has measured are on opposite sides of it.

### The instrument

`scripts/e2e/webgl-present-stall.py` sweeps the dma-buf variable as an explicit
arm, along with the idle duration, because "while the page is idle" is a claim
about duration and nobody has established how long idle has to be.

Its design follows from one observation: **every convenient way to observe this
fault is itself an event that can wake the compositor.** `get_snapshot()` asks
the engine for an image and can force the composite it was called to detect;
`run_javascript()` runs a task in the page; `readPixels()` reads the drawing
buffer, which is the half nobody doubts; and a synthetic key or click *is* the
wake event whose absence defines the fault. So the driver never touches the
engine after load: the page runs its own schedule off timers, reports through
`document.title`, and pixels are read with XGetImage on the X root window.

A DOM arm runs as a control, since it has no GL layer to leave unpresented; a
stall reported on both arms means the harness is wrong and the run says so
rather than reporting a defect. A trial counts as stalled only if the ink is
absent while idle *and* present once woken, and "never painted" is kept as its
own verdict rather than folded in to make a number look decisive.

Wayland is refused rather than approximated, because an approximation of this
particular measurement is worth less than no measurement: the reason the
question is still open is that a previous approximation was read as an answer.

## Rough size

Done for the two defects and the instrument. The residual is small if the WebGL present stall has gone away, and unbounded if it has not.
