# The launcher has a flat background where a slow particle wave should move

Status: implemented and accepted locally on 2026-10-26 at 0.50 speed, including host focus colour, carousel selection colour and Escape behavior; native Windows/Linux visual checks remain outstanding.

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

## First preview (rejected)

The owner approved an original lightweight Canvas wave on 2026-10-26 instead of waiting for the reference component's source and license. No EaseMize code was copied or vendored and no three.js dependency was added; the original implementation follows this repository's license. This replaces the source-port and three.js comparison steps above. The default is provisionally 0.50 of this implementation's phase rate, not a measured half-speed of the unavailable reference code. Final speed selection remains open.

Run `npm --prefix web run dev -w @chan/launcher -- --host 127.0.0.1` and open `http://127.0.0.1:5174/wave-preview.html`. It uses the existing mock launcher library and exposes a 0–1.5 speed slider and dark/light selector. The ordinary manual embed remains unchanged. The native panel now sends a settled signal after the accepted carousel transition and suspends the wave before hiding; that native timing change is explicitly requested by the owner.

The launcher JavaScript measured 58,134 bytes gzipped before the wave and 59,167 bytes after it (gzip level 9), an increase of 1,033 bytes within the unchanged 60 KiB budget. A local WebKit sample at 1280×850 measured animation callbacks averaging 0.23 ms, p95 1 ms; this is a local smoke measurement, not cross-platform performance certification. Browser checks cover deferred startup, moving frames, pause/resume, both themes, card navigation, reduced motion and Chromium's GPU-less fallback. Native Windows and Linux visual checks remain outstanding.

Validation: `make web-check` passed (8,676 tests), the launcher type check and focused tests passed after extracting the shared speed constant, and native formatting, clippy and all ten launcher-panel tests passed. The macOS debug preview was packaged with ad hoc signing and launched against a temporary library.

## Current shader preview

The owner rejected the dotted wave and supplied a plasma-line shader as the replacement inspiration. The launcher now adapts that shader directly in raw WebGL, with 16 warped strands and travelling highlights tinted by `--brand` over the existing background. No React or rendering-library dependency was added. The accepted 0.50 speed scales the supplied shader's elapsed time, so this preview runs at half that example's rate. The same local preview URL and speed/theme controls apply; the owner accepted this visual and speed.

Rendering is capped at 30 fps, approximately 360,000 pixels and a 960-pixel longest edge. The native settled signal still controls startup and suspension. Reduced motion and GPU absence leave a flat background; compile/link failure also falls back flat, and context restoration rebuilds resources without resuming a hidden panel. The shader fixes the example's reversed `smoothstep` bounds and releases its animation, observers and GL resources on teardown.

The replacement launcher bundle is 60,520 bytes gzipped at level 9 (59.1 KiB), up 2,386 bytes from the pre-background baseline, within the unchanged 60 KiB ceiling. All 672 launcher tests, the launcher type check and production build passed. Real WebKit checks exercised shader draws without GL errors, elapsed-time progression, native pause/resume, context loss/restoration while hidden, both themes, card navigation and reduced motion; Chromium verified the software-GPU fallback. The macOS debug preview was relaunched with the rebuilt frontend. Windows/Linux visual and GPU performance checks remain outstanding.

## Host colour and return shortcut

The owner accepted the shader preview and requested that its tint follow the current host window's pane focus-border colour. The native panel now samples that resolved CSS colour before showing and forwards live root-style changes through a validated, host-scoped command. This preserves remote-library colours instead of reading the desktop's local-library preference. A visible launcher reload resamples the host; ordinary browser launchers retain their theme tint because they have no host pane.

Escape returns from Computers or Gateways to the pane. Forms, dialogs, the command launcher and inline editors consume their own Escape first. Browser checks covered green/pink shader updates, both launcher screens, command-deck dismissal and the Add gateway form's two-step return. All 673 launcher tests and seven transition tests passed, as did the launcher type check/build and native launcher/capability tests. The launcher gzip size before sharing the carousel colour was 60,732 bytes, within the 60 KiB budget.

The carousel focused-card outline and active pagination indicator also follow the host focus colour through the same `--launcher-focus-color` CSS property as the shader. WebKit verified green/pink updates with animation running and reduced motion enabled; focused shader tests, launcher type check/build and the macOS preview build passed.

The owner accepted the final result and requested a commit. The final launcher gzip size is 60,743 bytes, below the unchanged 60 KiB ceiling.
