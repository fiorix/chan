# The WebGL present stall is unmeasured, and it costs the Linux desktop its terminal grid

Status: REGISTERED 2026-08-10 at the v0.88.0 close, carried forward from `terminal-font-and-block-glyph-parity`, which closes **partial**. Its open question is **unresolved rather than answered**: no host with a GPU and an Xorg session was available in v0.88.0, so the question did not get an answer, and an unresolved question sitting implied inside a closed item is how a residual disappears.

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

## Why it did not close in v0.88.0

No host. The round ran on a headless KVM VPS with a QEMU Cirrus VGA: no GPU, no display, no WebKitGTK. The measurement needs a Linux desktop with a real GPU **and an Xorg session**, because the probe reads pixels with XGetImage and refuses Wayland rather than approximating it.

That refusal is deliberate and should survive into whoever picks this up: an approximation of this particular measurement is worth less than no measurement, because the reason the question is still open is that a previous approximation was read as an answer.

## What closing it looks like

```
python3 scripts/e2e/webgl-present-stall.py
```

Roughly fifteen minutes for the default sweep. Three outcomes, and all three are progress:

- **exit 0** turns WebGL on for the Linux desktop and closes the grid residual outright. Expect this to touch `web/packages/workspace-app/src/terminal/renderer.ts`, and possibly `desktop/src-tauri/src/linux_gui_stack.rs` if the answer turns out to be dma-buf dependent.
- **exit 1** keeps the renderer off, and the comment that currently carries the decision gets replaced by a measurement.
- **exit 2** says the environment could not answer it, which is not the same as no problem found.

A renderer flip changes what the browser smoke suite observes, so it is a cross-lane landing rather than a local one.

## Rough size

Small to answer and unbounded to act on, and those are different numbers that used to be one. Answering is a fifteen-minute command on a box that exists somewhere. Acting on a reproducing stall is open-ended. The measurement getting cheap should not be read as the repair getting cheap.
