# The canvas animation family is software-rasterized on Linux

Status: REGISTERED 2026-08-10, after the fact. The work was done unplanned, off the roadmap, and is registered here so v0.88.0 carries it as accepted scope. IMPLEMENTED in `aa8955a1` (sixfold vortex and the rotational blooms) and `c89c8bdc` (the point cloud host). **Closed on host acceptance**: the animation family was run on Linux, Windows and macOS on real hardware and works. That is an observation on real hardware, **not a frame-rate measurement**, and it should not be read or restated as one. It settles the two things nothing in this round could reach: the point cloud host, which was this item's single explicit Not met, and macOS, which was recorded as unmeasured entirely. No number was taken for any animation on any platform, and the original 60 fps figure rests on a renderer string that cannot distinguish hardware from software, which is a weakness in how the claim was written rather than a reason to doubt it. What the instrument's construction exposed about writing such an acceptance is carried forward as `v0.89.0/a-frame-rate-acceptance-needs-guards-that-can-fire.md`.

## What

The animation family painted through 2D canvas paths that the browser GPU-accelerates on macOS and software-rasterizes on Linux. The same code was therefore fine on the platform it was written on and sluggish on the platform chan develops on, which is why it went unnoticed.

The per-frame cost, by host:

- **Sixfold vortex**: 30k 1x1 rects per path fill, every frame.
- **Hexagonal and fourteenfold bloom**, through the shared `YuruyurauRotationalField`: roughly 20k point rects plus 6 to 14 rotated full-canvas `drawImage` calls, every frame.
- **`YuruyurauPointCloud`**, the host behind Lorenz Constellation, Rippled Duet, Striated Current and Twin Veil Dance: Lorenz is the worst case at 30k `ctx.rect()` calls collected into one path and filled every frame. This was the last 2D canvas path left in the family.

The paint path moves to WebGL2 following the existing `StellarOutburst` pattern. CPU-side geometry and motion are unchanged throughout, so the visual identity of each animation is carried by the same simulation it always had.

- Sixfold vortex draws particles as `gl.POINTS` over a ping-pong framebuffer pair that reproduces the alpha-`fillRect` trail fade, 8-bit quantization included.
- The blooms keep base points in a reused `DYNAMIC_DRAW` buffer with one `drawArrays` per rotation and a rotation uniform; the center fade becomes a fragment-shader radial gradient carrying the old `createRadialGradient` stops, softened to 20% strength so the center stays quiet without blanking the pattern.
- The point cloud ships points in source space through a reused `DYNAMIC_DRAW` buffer and draws the cloud in one `drawArrays(POINTS)`, with the vertex shader applying the `fitPointCloudCover` transform. It fits the cover from the drawing buffer rather than the CSS box, so the transform cannot drift from the viewport when the two disagree, and it keeps the off-screen cull the 2D path used so a chaotic attractor's stray points stay out of the upload.

## One deliberate behaviour change

Overlapping points accumulate opacity where a single path fill painted each pixel once. That is the same shift the rotational field already took on when it moved to WebGL2, so the family stays internally consistent rather than splitting into two blending models. It is a visual difference, not a regression, and it is recorded here so a later session does not read it as one.

## Contract

- An animation performs on Linux, not only on the platform whose browser accelerates the path it happens to use.
- The port changes how pixels are produced, not what the simulation computes: timing and motion logic stay put.
- Frames allocate nothing. Buffers are reused rather than rebuilt per frame.

## Acceptance

- The sixfold vortex and both blooms hold 60 fps on Linux. **Not verifiable from what was recorded.** The reading was taken as "AMD Radeon 780M through ANGLE", and ANGLE is a translation layer that sits equally on a real GPU or on a software rasterizer: running this item's own instrument in a container produced `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, which satisfies the phrase end to end and is software throughout. This does not falsify the claim, and the "AMD Radeon 780M" half is a hardware assertion there is no reason to doubt. It makes the claim **unverifiable from the string it rests on**, which is a different and more careful statement. An honest unmeasured beats a met that rests on a non-discriminating string.
- Shaders are valid rather than assumed valid. Met: validated with `glslangValidator`.
- The suite, `svelte-check` and the vite build pass. Met at each step (3655 tests at the first commit, 3658 at the second).
- The point cloud host is verified against real hardware. **Met by observation, not by measurement.** The build host for `c89c8bdc` had no browser, so Lorenz Constellation, Rippled Duet, Striated Current and Twin Veil Dance shipped correct by construction and by suite with their frame rate unread. The family was subsequently run on Linux, Windows and macOS on real hardware and works, which is a direct test of the defect this item exists to fix: a paint path that was smooth on macOS and visibly sluggish on Linux because it was software-rasterized. A person watching it on a real Linux machine tests exactly that. What remains untaken is a **number**, on any platform, which is a smaller thing than the item was carrying and is not load-bearing for the fix.
- **The bar the siblings passed is weaker than it reads.** See below: "through ANGLE" is satisfied by a pure-software stack, so the vortex and bloom row rests on a string that does not distinguish hardware from SwiftShader.

## The instrument, and what "through ANGLE" does not mean

`scripts/e2e/animation-fps.py` measures all seven animations plus an empty-page baseline in one pass. It was written because neither reading this item records has an instrument behind it: the sibling number cannot be re-run by anyone, and measuring the point cloud the same way would have produced a second anecdote beside the first rather than a verification.

The acceptance above records the siblings as met "on AMD Radeon 780M through ANGLE". **ANGLE is a translation layer, and it sits equally happily on a real GPU or on a software rasterizer.** Running the instrument in headless Chrome in a container produced:

```
ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)
```

That string satisfies the phrase "through ANGLE" and is software end to end. This is not a claim that the sibling reading was software-rasterized -- "AMD Radeon 780M" is a hardware claim and there is no reason to doubt it. It is a claim that **the recorded evidence cannot distinguish the two**, and that a reader taking "through ANGLE" as evidence of acceleration is reading something that is not there.

So the instrument prints the full renderer string, and refuses (exit 2) when it matches a software rasterizer, rather than leaving the distinction to whoever writes the acceptance line afterwards. That refusal is verified rather than designed: it was tripped on the SwiftShader string above. A second, independent guard would also have caught it, because the empty-page baseline measured 35.3 fps against a 55 fps bar.

Two further guards matter because their failure modes are silent. `runGpuAnimation` returns early when the renderer cannot be created, so a **dead animation costs nothing per frame and reads as a perfect frame rate** -- the single most important failure mode would otherwise present itself as the best possible result. The harness catches the component's own `[chan] ... WebGL renderer unavailable` warning and checks the drawing buffer. In the same run that guard correctly stayed silent: all seven components mounted and drew.

That last claim was an argument until it was measured. Breaking the point cloud's fragment shader -- one dead animation among six live ones, which is the case an all-or-nothing environment failure cannot produce -- gives this:

```
  live  baseline (nothing mounted)   37.3 fps
  live  Sixfold Vortex               16.0 fps    900x560
  live  Hexagonal Bloom              12.4 fps    900x560
  live  Fourteenfold Bloom            4.2 fps    900x560
  DEAD  Lorenz Constellation         36.8 fps    300x150
  DEAD  Rippled Duet                 37.1 fps    300x150
  DEAD  Striated Current             36.3 fps    300x150
  DEAD  Twin Veil Dance              37.1 fps    300x150
```

**The four dead animations are the four fastest in the run**, at the empty page's own rate, while the three that actually rendered sit far below them. A harness without this guard would have reported the point cloud family -- the exact four this item exists to verify -- as the best performers in the family.

The `300x150` is the HTML canvas default: a drawing buffer never sized because no renderer ever claimed it. So the buffer check catches this independently of the console warning, which is why both are there.

Verified as exit 2 naming all four, not as a number.

**The consequence is larger than the residual.** Because the run measures all seven arms against one baseline on one clock, executing it on real hardware does not only close the point cloud's thread -- it converts the vortex and both blooms from a recorded phrase into a measurement taken by an instrument that reports what it ran on. One run settles four unverified animations and re-establishes three under-evidenced ones together.

## How to take the outstanding reading

```
python3 scripts/e2e/animation-fps.py --serve-only
```

Then open the printed URL **in Chrome on the machine whose GPU is being recorded**. The page runs all eight arms itself and prints its own table; about a minute.

Chrome specifically, and this is not a preference. WebKitGTK spoofs the WebGL renderer string -- it reports `Apple GPU` / `Apple Inc.` on a Linux VM with no GPU at all -- so a run in `chan-desktop`'s webview cannot be certified and the harness refuses it. Chrome reports truthfully, which is what lets the run attach a hardware claim to its numbers.

What a good result looks like: a renderer string naming real hardware, the baseline arm at 55+ fps, and all seven animations at 55+.

What the failure modes look like, all of which exit 2 rather than producing a number:

- a software rasterizer (`SwiftShader`, `llvmpipe`) -- run it on the GPU;
- an unidentifiable renderer -- you are in a webview, use Chrome;
- a baseline below 55 fps -- the display cannot present 60, so nothing below it can be read as an animation's cost;
- any `[chan] ... WebGL renderer unavailable` warning, or a zero-sized drawing buffer -- an animation that never started reads as a *perfect* frame rate, so the run refuses rather than reporting one.

A genuine slow arm exits 1 and names the animation and its fps.

## Rough size

Done, minus that one verification pass, and the pass is now a single command on a machine with a GPU.

This paragraph used to read "run the four animations it hosts on the same hardware the vortex was measured on and read the frame rate". That is left here in corrected form rather than silently rewritten, because it contained the error the rest of this item is about: **"the same hardware the vortex was measured on" is not a thing the record identifies.** The vortex's hardware is recorded as a phrase that a pure-software stack also satisfies, so an instruction to reproduce its conditions could not be followed.

What replaces it is not four animations on remembered hardware but seven plus a baseline, on a machine the instrument names in its own output.
