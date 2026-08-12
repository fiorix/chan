# A frame-rate acceptance needs guards that can fire, and a renderer string is not one

Status: REGISTERED 2026-08-10 at the v0.88.0 close, carried forward from `canvas-animations-are-software-rasterized-on-linux`, which closed on host acceptance. This is not that item's residual. Its residual was the point cloud host being unverified, and that was settled by running the family on Linux, Windows and macOS on real hardware. What survives is three findings about **how to write a frame-rate acceptance line**, each of which outlived the ask that produced it.

## Why this is an item rather than a note

The round produced an instrument, `scripts/e2e/animation-fps.py`, to take a measurement that was then satisfied a different way. The measurement is no longer wanted. The three things the instrument's construction exposed are, because each of them would silently corrupt the next frame-rate acceptance somebody writes, and none of them is discoverable by reading the code that contains it.

## 1. A renderer string cannot prove hardware acceleration

The family's original acceptance recorded 60 fps "on AMD Radeon 780M through ANGLE". ANGLE is a translation layer that sits equally on a real GPU or on a software rasterizer. Running the instrument in a container produced:

```
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
```

That satisfies the phrase end to end with no hardware in it. The original claim is not falsified and the hardware half is not doubted; the point is that the recorded evidence cannot distinguish the two cases, so a reader taking "through ANGLE" as proof of acceleration is reading something that is not there.

**Do not reach for a renderer string to prove hardware acceleration.** The string identifies an API path, not a device.

## 2. The engine the Linux desktop ships lies about what it is rasterizing on

WebKitGTK spoofs the WebGL renderer. On a headless machine whose real stack is llvmpipe on a QEMU Cirrus VGA, it reports:

```
UNMASKED_RENDERER_WEBGL   "Apple GPU"
UNMASKED_VENDOR_WEBGL     "Apple Inc."
RENDERER                  "WebKit WebGL"
```

So a software-rasterizer guard that trips correctly in Chrome is **blind in the engine the Linux desktop actually ships**, and would pass a pure-software run through as a hardware measurement. An instrument that refuses in the engine reporting honestly and passes in the engine that lies is worse than no instrument, because it converts an unverified number into a certified one.

The answer is not to see through the spoof but to decline to certify what cannot be identified.

## 3. A dead animation reads as the fastest arm, not the slowest

`runGpuAnimation` returns early when a renderer cannot be created, so a component that failed to start costs nothing per frame. Measured with one dead animation among six live ones, by breaking a single fragment shader:

```
live  baseline (nothing mounted)   37.3 fps
live  Sixfold Vortex               16.0 fps    900x560
live  Fourteenfold Bloom            4.2 fps    900x560
DEAD  Lorenz Constellation         36.8 fps    300x150
DEAD  Rippled Duet                 37.1 fps    300x150
DEAD  Striated Current             36.3 fps    300x150
DEAD  Twin Veil Dance              37.1 fps    300x150
```

The four dead animations are the four fastest arms, at the empty page's own rate, while the three that actually rendered sit far below. A harness without a liveness guard reports the broken animations as the family's best performers. The `300x150` is the HTML canvas default: a drawing buffer no renderer ever claimed, which is why the guard checks the buffer as well as the component's own warning.

## What a frame-rate acceptance should therefore carry

- A baseline arm with nothing mounted, because an observer can only see min(display rate, animation rate) and a 60Hz panel makes a perfect animation and a 200Hz-capable one identical.
- A liveness check per arm, because the most dangerous failure presents as the best result.
- An identification step that refuses rather than assumes, and refuses again when the engine will not say.
- A recorded renderer string that the instrument printed, not one a human wrote down afterwards.

`scripts/e2e/animation-fps.py` implements all four and every branch of it has been exercised, including both terminal verdicts against fault-injected specimens. It is available for the next such acceptance whether or not this item is picked up.

## Rough size

Small, and mostly already done. The instrument exists. What is open is whether these become a written rule for acceptance lines that claim a rate, or stay as one instrument nobody remembers to reach for.
