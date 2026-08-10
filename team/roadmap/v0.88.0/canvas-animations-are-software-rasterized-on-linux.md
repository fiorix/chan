# The canvas animation family is software-rasterized on Linux

Status: REGISTERED 2026-08-10, after the fact. The work was done unplanned, off the roadmap, and is registered here so v0.88.0 carries it as accepted scope. IMPLEMENTED in `aa8955a1` (sixfold vortex and the rotational blooms) and `c89c8bdc` (the point cloud host).

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

- The sixfold vortex and both blooms hold 60 fps on Linux. Met: measured on AMD Radeon 780M through ANGLE.
- Shaders are valid rather than assumed valid. Met: validated with `glslangValidator`.
- The suite, `svelte-check` and the vite build pass. Met at each step (3655 tests at the first commit, 3658 at the second).
- **Not met**: the point cloud host is unverified against a real GPU. The build host for `c89c8bdc` had no browser, so Lorenz Constellation, Rippled Duet, Striated Current and Twin Veil Dance are correct by construction and by suite, but their frame rate is unmeasured. This is the one open thread, and it is the same measurement the vortex and blooms already passed.

## Rough size

Done, minus that one verification pass. Confirming the point cloud on a real GPU is small: run the four animations it hosts on the same hardware the vortex was measured on and read the frame rate.
