# The WebGL present stall is unmeasured, and it costs the Linux desktop its terminal grid

Status: REGISTERED 2026-08-10 at the v0.88.0 close, carried forward from `terminal-font-and-block-glyph-parity`, which closes **partial**. Its open question is **unresolved rather than answered**: no host with a GPU and an Xorg session was available in v0.88.0, so the question did not get an answer, and an unresolved question sitting implied inside a closed item is how a residual disappears.

MEASURED 2026-08-11 on a host that qualifies. The stall does not reproduce, and the item does not close: the exit-0 branch below assumed "no stall" licenses turning WebGL on, and that assumption is now known to be wrong. See [What the 2026-08-11 reading established](#what-the-2026-08-11-reading-established).

## What is unresolved

`shouldUseWebglRenderer` returns false for a Linux desktop. That one predicate costs the Linux desktop the WebGL renderer, and with it the custom-glyph path, which is why the shipped Linux terminal grid bands rules and blocks at **96.0% rule continuity and 95.2% block coverage** while every WebGL arm measures 100%.

The predicate exists because of a comment: WebKitGTK is said not to reliably composite the WebGL render layer while the page is idle, so a write is drawn into the GL canvas but not presented until a later event wakes the compositor.

**That claim has never been measured.** It is plausible, it is load-bearing for a renderer decision, and it is stated without a measurement behind it.

## What v0.88.0 established, so the next round does not re-derive it

**The defect is confirmed, not one host's reading.** 96.0% / 95.2% reproduced to the digit on a second machine sharing nothing with the first (WebKitGTK 2.52.3 under Xvfb, headless, llvmpipe, QEMU Cirrus VGA against the original's 2.52.5 on real hardware), with the gap positions matching as well as the totals: one unpainted pixel row on the 21px cell pitch. It reproduces without a GPU because glyph rasterisation is CPU-side.

**Every prior reading of the stall has an uncontrolled variable in it.** `linux_gui_stack.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` only inside an AppImage launch, so the shipped AppImage runs with the dma-buf renderer **off** and a directly-run `target/release/chan-desktop` runs with it **on**. The probe that found five idle writes of five presented had it on, because nothing set it. dma-buf is how WebKit hands GPU buffers to the compositor, and the fault under investigation is a buffer-handoff fault, so the shipped configuration and every measured configuration sit on opposite sides of the switch that would decide it.

**The instrument exists and every branch of it has been exercised.** `scripts/e2e/webgl-present-stall.py` sweeps the dma-buf variable as an explicit arm, sweeps the idle duration because "while the page is idle" is a claim about duration nobody has bounded, and runs a DOM control arm so a harness fault reports inconclusive rather than as a defect.

```
exit 2   GUI stack unavailable       proven
exit 2   an arm painted nothing      proven
exit 2   Wayland refused             proven (weston headless)
exit 0   no stall observed           proven
exit 1   stall reproduces            proven (fault-injected specimen)
```

## What the 2026-08-11 reading established

Host: Arch Linux desktop, AMD HawkPoint, **Xorg** session, WebKitGTK 2.52.5, device pixel ratio 1. The first host to satisfy the GPU-and-Xorg precondition this item was blocked on.

`python3 scripts/e2e/webgl-present-stall.py`, default sweep, exits **2 (inconclusive)**. The number that matters is not the exit code:

```
arm                              trials  presented  stalled  never-painted
webgl / dma-buf on / 1s,3s,8s        36         36        0              0
webgl / dma-buf off / 1s,3s,8s       36          0        0             36
dom control / on+off / 1s,3s,8s      72         72        0              0
```

**No stalled trial on any arm.** Where the layer could be observed at all, every idle write reached the X server, at one, three and eight seconds of idle, read with XGetImage outside WebKit entirely. The DOM control is clean on both sides of the switch, so the harness and the capture path are sound. The claim that carries `shouldUseWebglRenderer` has now been tested on the configuration a developer runs, and it did not reproduce.

**The shipped configuration cannot run the WebGL layer at all, which is worse than the stall it was suspected of.** With `WEBKIT_DISABLE_DMABUF_RENDERER=1` the page reports `webglLoaded: true`, `renderer: webgl`, no warnings and a correct 8x21 cell, then puts zero ink on screen in 36 of 36 trials: absent while idle, still absent after a real pointer-warp wake. The DOM renderer in that identical configuration paints 12 of 12.

**Two independent capture paths agree on that.** `WEBKIT_DISABLE_DMABUF_RENDERER=1 python3 scripts/e2e/terminal-pixels.py --include-renderers` puts the xterm+webgl arms at 0.0% on all three ink measures, both fonts, where the same harness on the same host with dma-buf on reports 100% on all three. One reads the X root window, the other asks the engine for a snapshot; the llvmpipe artifact documented in that harness does not apply on a real GPU that measured 100% an hour earlier. The variable is dma-buf, not the hardware and not the capture.

So the exit-0 branch is dead as written. "No stall" does not license the renderer flip, because the flip would trade a banded grid for a blank one in the AppImage, and the AppImage is what users install. The two configurations have to be reconciled before the flip is available at all, and `linux_gui_stack.rs:62` says why the switch is set: the dma-buf path "aborts with EGL_BAD_PARAMETER on the affected GPUs". The renderer decision is therefore coupled to a GPU-abort workaround, not free-standing.

**The grid residual itself is not dma-buf dependent.** The xterm DOM arms read 96.0% / 100% / 95.2% and the ghostty arms 100% / 100% / 100% on both sides of the switch, with the two font preferences byte-identical (same SHA256 per backend). That is this item's third independent reproduction of the residual and TG-06 holding again.

Two footnotes for whoever reads the logs. `GL: Apple GPU` is WebKit's masked `WEBGL_debug_renderer_info` string, not a hardware detection, and it appears on every arm including the ones that paint. And a directly-run `chan-desktop` is on the dma-buf **on** side, so day-to-day development sits on the side where WebGL works and the shipped artifact sits on the side where it does not.

### A smaller finding, recorded rather than chased

TG-05 on the ghostty second-tab arm fails at 0.2% against a 0.1% threshold with dma-buf off, and passes at 0.0% with it on. Deterministic: twice out of twice off, once out of once on. The pixel diff between the two renders is exactly 420 pixels forming a one-pixel-wide unpainted column at x=0 spanning rows 0 to 419, which is 420 of the region's 201600 pixels and therefore the 0.2% exactly. The canvas's leftmost pixel column is left unpainted under dma-buf off. Cosmetic next to the WebGL result, cause not established, and it is the same switch again.

## Why it did not close in v0.88.0

No host. The round ran on a headless KVM VPS with a QEMU Cirrus VGA: no GPU, no display, no WebKitGTK. The measurement needs a Linux desktop with a real GPU **and an Xorg session**, because the probe reads pixels with XGetImage and refuses Wayland rather than approximating it.

That refusal is deliberate and should survive into whoever picks this up: an approximation of this particular measurement is worth less than no measurement, because the reason the question is still open is that a previous approximation was read as an answer.

## What closing it looks like

```
python3 scripts/e2e/webgl-present-stall.py
```

Roughly fifteen minutes for the default sweep. Three outcomes were expected, and all three were called progress:

- **exit 0** turns WebGL on for the Linux desktop and closes the grid residual outright. Expect this to touch `web/packages/workspace-app/src/terminal/renderer.ts`, and possibly `desktop/src-tauri/src/linux_gui_stack.rs` if the answer turns out to be dma-buf dependent.
- **exit 1** keeps the renderer off, and the comment that currently carries the decision gets replaced by a measurement.
- **exit 2** says the environment could not answer it, which is not the same as no problem found.

A renderer flip changes what the browser smoke suite observes, so it is a cross-lane landing rather than a local one.

The parenthetical in the first branch turned out to be the whole question. The answer **is** dma-buf dependent, so the flip is gated on `linux_gui_stack.rs` rather than merely touching it.

## What closing it looks like now

The question is no longer whether the stall reproduces. It is **why the WebGL layer never composites with `WEBKIT_DISABLE_DMABUF_RENDERER=1`, and whether the AppImage can stop needing that switch.** Three ways that could go, in rising cost:

1. The switch is no longer needed. It is a workaround for a dma-buf EGL abort on affected GPUs; if that abort is gone from current WebKitGTK, dropping the switch puts the AppImage on the side where WebGL both presents and paints, and the flip is available. This wants the same measurement on the GPUs the abort was seen on, which are not identified anywhere in the tree.
2. The switch stays and the flip is made conditional on it, which means the shipped AppImage keeps the banded grid and only non-AppImage Linux installs get the clean one. Two Linux grids is a worse contract than one, and it should be argued for rather than fallen into.
3. Neither, and the residual stands with a measurement behind it instead of a comment, which is still strictly better than where this item started.

Whichever way it goes, the comment inside `enableWebglRenderer()` is now wrong as written: it names an idle present stall, and no stall was observed on any arm that painted. It should say what the measurement says.

## Rough size

Small to answer and unbounded to act on, and those are different numbers that used to be one. Answering is a fifteen-minute command on a box that exists somewhere. Acting on a reproducing stall is open-ended. The measurement getting cheap should not be read as the repair getting cheap.

That still holds, with the answer in hand and the target moved. Answering cost fifteen minutes as predicted. What it bought is a better-posed question rather than a repair: the grid residual is now blocked on a GPU-abort workaround in the desktop shell, which is a different lane from the renderer predicate this item names.

CLOSED in [v0.91.0](../../release/release-v0.91.0.md): the stall does not reproduce (0 of 144 trials), and the blank-WebGL configuration that kept this open stopped being everyone's in v0.89.0 when the dma-buf override became driver-scoped. The surviving half is `the-linux-desktop-still-refuses-webgl-after-its-blocker-was-fixed` for v0.92.0.
