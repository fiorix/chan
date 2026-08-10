# The point cloud animations' frame rate was never measured, and the siblings' cannot be verified

Status: REGISTERED 2026-08-10 at the v0.88.0 close, carried forward from `canvas-animations-are-software-rasterized-on-linux`, which closes on what is known rather than on a met frame-rate line. That item closes **without** partial status and **with** a completed entry, which makes this residual easier to lose than its sibling's: same shape, weaker containment.

## What is unmeasured

Two things, and one run answers both.

**The point cloud host was never measured at all.** `YuruyurauPointCloud` is the host behind Lorenz Constellation, Rippled Duet, Striated Current and Twin Veil Dance. It was ported from a 2D canvas path to WebGL2 in `c89c8bdc` and is correct by construction and by suite, but the build host had no browser, so its frame rate has never been read on any machine.

**The siblings' 60 fps figure is unverifiable from what was recorded.** The sixfold vortex and both blooms were accepted on "measured on AMD Radeon 780M through ANGLE". ANGLE is a translation layer that sits equally on a real GPU or on a software rasterizer: running the instrument in a container produced `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, which satisfies that phrase end to end with no hardware in it.

That does not falsify the claim, and the "AMD Radeon 780M" half is a hardware assertion nobody has reason to doubt. It makes the claim unverifiable from the string it rests on, which is a different and more careful statement.

## What v0.88.0 built, so the next round does not rebuild it

`scripts/e2e/animation-fps.py` measures all seven animations plus an empty-page baseline in one pass, on one clock. The baseline exists because an observer can only ever see min(display rate, animation rate), so on a 60Hz panel a perfect animation and a 200Hz-capable one both read 60; every arm is read as a distance from it. The three already-recorded siblings run in the same pass as controls, which is what makes the point cloud number comparable rather than isolated.

It refuses rather than guesses, and every branch has been exercised:

```
exit 2   node absent                    proven
exit 2   software rasterizer            proven (SwiftShader trip in Chrome)
exit 2   unidentifiable renderer        proven (WebKitGTK reports "Apple GPU")
exit 2   baseline below the bar         proven (35.3 fps empty page)
exit 2   a dead animation               proven (fault-injected shader)
exit 1   an arm below the bar           proven
exit 0   every arm holds                proven
```

Two of those guards are worth carrying forward as findings in their own right.

**WebKitGTK spoofs the renderer string.** On a headless VM whose real stack is llvmpipe on a QEMU Cirrus VGA, it reports `Apple GPU` / `Apple Inc.`. So the software-rasterizer refusal that trips correctly in Chrome is blind in the engine the Linux desktop actually ships, and the harness refuses to certify what it cannot identify rather than passing it through.

**A dead animation reads as the fastest arm.** `runGpuAnimation` returns early when a renderer cannot be created, so a failed component costs nothing per frame. Measured with one dead animation among six live ones: the four dead arms came back at 36-37 fps, at the empty page's own rate, while the three that actually rendered sat at 4-16. Without the guard, the four animations this item exists to verify would have been reported as the best performers in the family.

## What closing it looks like

```
python3 scripts/e2e/animation-fps.py --serve-only
```

Open the printed URL **in Chrome on the machine whose GPU is being recorded**. About a minute. Chrome specifically, and not the desktop webview, for the spoofing reason above: a webview run cannot attach a hardware claim to its numbers.

A good result is a renderer string naming real hardware, the baseline at 55+ fps, and all seven animations at 55+. One run settles the four unmeasured animations and re-establishes the three under-evidenced ones together.

## Why this is not folded into the WebGL present-stall draft

Both residuals came out of the same lane and both want a GPU, so combining them looks natural. Their preconditions are not the same and combining them would import the stricter one.

The present stall needs a **Linux desktop with an Xorg session**, because its probe reads pixels with XGetImage and refuses Wayland rather than approximating it. This measurement needs **Chrome and a GPU**, and does not care about the OS or the display server: a Windows box answers it, and so does a Wayland desktop.

So a single draft would tell a future reader that a measurement satisfiable on hardware they already have requires a session type they may not run. Two drafts, two preconditions, and each maps to the item whose residual it carries.

## Rough size

Small. One command on a machine with a GPU and a browser, and the instrument reports what it ran on so the result does not depend on anyone remembering the hardware afterwards.
