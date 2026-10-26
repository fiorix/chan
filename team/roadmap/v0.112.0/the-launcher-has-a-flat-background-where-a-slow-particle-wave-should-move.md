# The launcher has a flat background where a slow particle wave should move

Status: raised on 2026-10-26 by the owner after the v0.111.0 close; awaiting acceptance for v0.112.0.

## What was seen

The owner's words of 2026-10-26: "the background of the launcher window to be this animation https://21st.dev/@jahed/components/particle-wave but in a slower time, part of the roadmap work is to run a local test server where I can evaluate the speed of the animation (start from 2x the one in the code)". The owner pasted the component's demo wrapper, which renders `<ParticleWave />` full-screen under a caption "Move your mouse to interact"; the component's own source was not in the paste.

Read at `d42bf50d2`. Paths under `web/packages/launcher/src/` unless named.

- The launcher's background is flat: `styles.css` sets `body { background: var(--bg) }` and nothing draws behind the content. Since v0.111.0 the launcher is a panel inside every chan-desktop window (`desktop/src-tauri/src/launcher_panel.rs`), and the same SPA is served at every devserver and gateway root and as the live widget on the chan.app manual (`@chan/launcher/demo`, `LauncherDemo.svelte`).
- The 21st.dev page (read 2026-10-26) says the component is part of the EaseMize UI library, renders with three.js, is installed through the 21st registry with an API key, and lists its license as unknown; its source, timing constants and mouse handling are not shown on the page. The source must come from the owner's paste or the registry, and its license must be read before any of it is vendored.
- The launcher's toggle transition already honours `prefers-reduced-motion: reduce` (`launcher_transition.js`), and v0.109.0 added a welcome for GPU-less desktops, so the launcher has precedents for motion that steps aside.
- The launcher runs standalone from its package with `npm --prefix web run dev -w @chan/launcher` (`package.json`'s `vite` script), which is where a speed can be judged without a desktop build.

## Desired contract

Behind the launcher's content a particle wave moves slowly, in the colours of the current theme, under every card and control and never catching their pointer events. Its speed is a single constant the owner has chosen by eye: the work first stands up a local test server that shows the launcher with the wave and a speed control, starting at half the component's speed (its time step halved, "2x slower"), and the value the owner settles on is then the committed default. The wave is absent, not merely slower, where `prefers-reduced-motion: reduce` holds or no GPU is available, where the launcher is the chan.app manual's embedded widget unless the manual wants it, and it costs the embedded SPA no more than the owner accepts once the bundle size with and without three.js is measured; a port of the effect to a plain canvas is preferred over adding three.js if the effect survives it. Mouse interaction, if kept, must not move cards or steal the deck's drag.

## What to do

1. Obtain the component's source and license (the owner's paste or the registry); record the license in the row. Measure the launcher bundle with three.js added and with a canvas port of the same effect; choose with the owner.
2. The test server: the launcher's vite dev server with the wave mounted behind `LauncherDemo`, a speed control (a query parameter or a dev-only slider) whose initial value is half the component's speed, and a note in the row of the value chosen.
3. The wave behind the content in `App.svelte`, theme-aware through the existing `--bg` and brand variables, `pointer-events: none`, disabled under reduced motion and without a GPU; the chosen speed as its constant. Tests: the wave mounts in the desktop launcher and not under reduced motion; the manual's demo embed stays unchanged unless chosen otherwise.
4. The launcher design document says what draws behind the content and when it is off.

## Boundaries

`web/packages/launcher/src/App.svelte`, `styles.css`, a new component under `components/`, `LauncherDemo.svelte` for the speed control, `web/packages/launcher/design.md`, and `web/package.json` plus its lock if three.js is adopted. Not changed: the desktop's launcher panel (`launcher_panel.rs`), the workspace app, the marketing site beyond its embed decision.

## Acceptance

1. In chan-desktop, every launcher panel shows the wave behind its cards at the chosen speed, in both themes, and cards and the deck drag work as before.
2. With `prefers-reduced-motion: reduce` the background is the flat `--bg`; on a GPU-less desktop likewise.
3. The owner evaluated the speed on the local test server and the committed constant is the value chosen there, recorded in the row.
4. `make web-check` green; the launcher bundle size before and after is recorded in the row.
