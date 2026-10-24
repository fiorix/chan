# The desktop welcome's WebGL animations burn the CPU on a machine without a GPU

Status: shipped in [v0.109.0](../../release/release-v0.109.0.md).

Record before the release: built on 2026-10-22 on the seat's branch; the section GPU-less desktop welcome 2026-10-22 holds the evidence; it closes at the GA as shipped.

Record before the build: carried into v0.109.0 at the v0.108.0 GA on 2026-10-21, still raised for a decision.

Record before the release: carried into v0.108.0 at the v0.107.0 GA on 2026-10-17, still raised for a decision.

Record before the release: carried into v0.107.0 at the v0.106.0 GA on 2026-10-15, still raised for a decision.

Record before the release: raised by the desktop seat's native reading on 2026-10-13 beside the frame-rate item (`reports/report-Desktop106-welcome-native.md` in the round's bus); decided by the owner the same day by survey ("Next round: a runtime guard row; this candidate as is (recommended)"); written down the same day by the lead as a row of its own; owner the frontend seat; not reached in the v0.106.0 round

## What was seen

In the desktop app on Linux WebKitGTK 2.52.6 with no `/dev/dri`, the product's own cached reader returns a masked renderer, so the welcome keeps the whole catalog of thirty-three animations (twenty-two WebGL2 and eleven 2D), as the catalog's rule says for an engine that masks its renderer on every machine. Six of the twenty-two WebGL choices took the whole two-CPU quota while the welcome showed (1.99 to 2.00 CPU seconds per second: Cosmic Bell 2.0009 and Segmented Torus 1.9976, each throttled in all 195 sampled periods, with Tenfold Dahlia, Turbulent Oculus, Amber Recursion and Stellar Outburst), six took 1.15 to 1.74 and ten 0.54 to 0.96; the eleven 2D choices ran from 0.29 (Dotted Waves) to 0.86; the editor with no welcome 0.18 (an animation was still running at the report's first snapshot, by its own qualification). Every WebGL choice took one trusted key within two seconds, so the welcome does not block. In Chrome, which names its software renderer, the rule leaves the WebGL animations out and the 2D one selected costs a quarter of a CPU. Not measured: macOS and Windows; a release build; the frame rate on a machine without a GPU beyond the harness's driven rows (2.7 to 12.8 frames a second).

## Desired contract

On a machine without a GPU the welcome does not burn the CPU: a WebGL animation that cannot hold a frame rate is swapped for a 2D one, whatever the engine says about its renderer.

## What to do

A runtime guard in the welcome: measure the animation's own frame time over its first second or two and swap a slow WebGL animation for a 2D one of the catalog; the thresholds from the harness's rows; design read before code. Not a change to the catalog's rule for a masked renderer, which keeps WebGL on desktops that have a GPU.

## Boundaries

`web/packages/workspace-app/src/` welcome and animation modules (`emptyPaneAnimations.ts`, `emptyPaneAnimationChoices` and the welcome component) and their tests. Not changed: the harness of the frame-rate item.

## Acceptance

1. The decision recorded here (the owner's above).
2. If built: a pin red first that a slow WebGL animation is swapped and a fast one kept, on a constructed frame clock; the native desktop reading repeated on a machine without a GPU, the CPU below a stated bound while the welcome shows.

## The owner's word 2026-10-16

Asked at the cut through one survey that listed the thirteen rows not shipped and the seven findings outside any item, with the lead's recommendation on each, and offered each row's own question with its cost (this row's line: "wglgrd, the welcome's WebGL on a machine without a GPU: carry, as you decided on 2026-10-13"), the owner answered: "Take all fourteen recommendations as listed (Recommended)". The row moves to v0.108.0 at the GA commit with its record as it stands.

## Lead's rulings 2026-10-21

Both rules are built, the rate rule and the probed frame-cost rule, each threshold a named constant (16 a second; 20 ms median cost, derived from the CPU rows and calibrated by the native reading before the item lands). After one swap the welcome keeps to the 2D catalog for the page's life. The guard is the welcome's alone; the screensaver and the animation tuner are untouched. The probe arms at the first drawn frame after it is requested and drops that frame's cost and interval, judging the window after it. The probe runs at the page's first WebGL draw whenever it happens, once per page. The swap's state is a module-level flag reset by a reload; the swap goes through `selectAnimation`, so it is persisted as every switch is. The mounted pin mocks `probeGpuFrames` with constructed probes; the real loop is driven in `canvasAnimation.test.ts` with a rAF stub whose timestamps come from the clock the fake `finish` advances.

The rulings of 2026-10-22: The window's timer starts at the first recorded frame; an undrawn probe ends empty at runner teardown or replacement, releasing the page flag. The rate rule counts the window's rAF callbacks, the quantity the harness rows measured, while the cost rule keeps the drawn frames. Both threshold bounds are pinned; tests restore mocks before real timers; a complete measured probe spends the page's one probe.

The native observation method, ruled 2026-10-22: The host reading's harness seeds the choice in `sessionStorage` per choice and reloads so the welcome's own start picks it unnamed, reads the probe's rate, cost and decision from an observable on the welcome root, samples the unit's `cpu.stat` over a page-stable interval after the probe, and adds a control on an engine with a GPU where every WebGL choice must read keep.

The WebKitGTK cost rule, ruled 2026-10-22: If `finish` does not block on WebKitGTK, the cost rule is void on that engine and the rate rule alone ships there; the row names the CPU groups outside Acceptance 2's bound, and Alex is surveyed on whether that bound stands or the row closes measured, before the row closes.

A probe measures only a window it runs to the end with the loop running. A probe ended before its window, by runner teardown, a lost context or the loop stopping for a hidden page or an off-screen canvas, measures nothing and resolves empty (`{ callbackCount: 0, frames: [] }`) as an undrawn probe does; the welcome probes the shown WebGL choice again at its next draw, not only a changed choice. A waiting probe keeps waiting at a stop. Judging the rate over the span measured is refused: the timer would still end a window whose tail has no callbacks after a hide. Ruled 2026-10-22.

## Built 2026-10-22

`probeGpuFrames` in `canvasAnimation.ts` arms a per-canvas probe, drops the first drawn frame, and counts later rAF callbacks and measures drawn timestamps and frame costs with `gl.finish()` inside the window; the normal GPU loop has no `finish()` call. `judgeGpuProbe` in `emptyPaneAnimations.ts` keeps an empty probe and swaps below `GPU_MIN_CALLBACK_FPS = 16` or above `GPU_MAX_MEDIAN_FRAME_COST_MS = 20`. The callback-rate bound separates the five slow measured rAF rows (2.7 to 12.8 callbacks a second) from the measured GPU-holding rows; the cost bound is derived from the native CPU rows, where typical 2D choices use 0.29 to 0.34 CPU seconds a second and every WebGL choice uses at least 0.54. Those rows are in chan-dev `releases/v0106-team/evidence/Desktop106/gpufps-artifacts/driven/result.json` and `releases/v0106-team/reports/report-Desktop106-welcome-native.md`. In `EmptyPaneWelcome.svelte`, the first unnamed WebGL choice that draws on a page starts a probe whose 1500 ms window begins at its first draw, including a choice reached by an arrow after a 2D start; a slow result selects the next 2D choice through `selectAnimation`, persists it, and keeps that page's choices on the 2D catalog. A probe ended before its window, by teardown, a lost context, or the loop stopping for a hidden page or an off-screen canvas, measures nothing, and the next draw is probed. The renderer catalog's masked rule and caller-named animations stay as they are.

At the parent, the three focused files were red on their own missing probe, judge and mounted-swap assertions; at the working tree they passed 11/11, 13/13 and 12/12, and `npm run check` exited 0 with no Svelte errors or warnings (`dev/v0109-team/evidence/Hygiene109/wglgrd/stage1/final-pins.launch.log`, `final-pins.launch.status`, `static.launch.log`, `static.launch.status`). Eight isolated mutants each compiled and failed its own assertion (rate rule, cost rule, `finish` outside the window, first frame counted, page flag unset, probe limited to the starting choice, caller-named choice probed, and swap not persisted); every source file was hash-checked after restoration (`dev/v0109-team/evidence/Hygiene109/wglgrd/mutants/mutants.launch.log`, `mutants.launch.status`). The committed web gate and three focused files are recorded under `dev/v0109-team/evidence/Hygiene109/wglgrd/commit/`.

The native WebKitGTK reading and calibration of the 20 ms bound are pending in stage 3. macOS and Windows have not been measured.

The window starts at the first drawn frame, with no timeout while the runner is waiting to draw; runner teardown ends a waiting probe empty and releases the page flag for a later WebGL choice, including one reached before the old result settles. The rate rule counts rAF callbacks after that first frame while the cost rule uses drawn frames. The boundary pins cover both thresholds, and the kept-probe pin holds the one-probe-per-page rule.

The undrawn-wait, teardown, 30 Hz cadence, and empty-next-choice pins failed on the repair parent `037403820` at their own assertions; the kept-probe control passed there. With the repair, the three focused files pass 44 tests, the workspace-app type check reports zero errors and warnings, and ten isolated mutants fail their intended assertions with the sources restored by hash. The logs are under `dev/v0109-team/evidence/Hygiene109/wglgrd/repair/`; the committed `VITEST_MAX_WORKERS=1 make web-check` gate at `73ea3ed70` returned rc 0 (218, 624, 7,446 and 20 tests; svelte-check clean) in `repair/gate.log`.

The stage 3 observation driver enumerates the current catalog in order (27 WebGL choices and 13 2D choices), reloads the welcome with each WebGL key in `sessionStorage`, pairs page-stable intervals with host `cpu.stat` samples, and records an editor baseline and the slowest 2D row. Its constructed stand-in page run exercises every choice, the CPU quota and pairing checks, a fault verdict, and a missing-sample verdict (`dev/v0109-team/evidence/Hygiene109/wglgrd/stage3-work/check-reader-v3.host.log` and `.status`). The welcome root now exposes `data-gpu-probe` after a measured probe with its callback rate, median drawn-frame cost, decision, choice, window, and timing; the mounted slow and fast choice pins read that attribute. The native desktop build and GPU-less reading remain pending, so the thresholds and CPU bound remain uncalibrated here.

The cut-short probe pins for runner teardown, a hidden page and context loss each failed at `d359cba69` on their empty-result assertions, as did the same-choice retry and the out-of-window `gl.finish()` pin; the waiting probe and complete slow-window controls passed there. With the cut-short repair, the three focused test files pass in the guest and six isolated mutants fail their intended assertions, with source hashes restored after each mutant (`dev/v0109-team/evidence/Hygiene109/wglgrd/r1/`). The native reading remains pending. The committed `VITEST_MAX_WORKERS=1 make web-check` at `6619f5813` returned rc 0 (218, 624, 7,453 and 20 tests; svelte-check clean in the four packages) in `dev/v0109-team/evidence/Hygiene109/wglgrd/r1/gate-v2.log`; its first run, red on a mock's type before the one amend, is kept as `gate.log`.

## Native reading 2026-10-22

The Linux desktop release build ran in the two-CPU, GPU-less guest on WebKitGTK 2.52.6 (`libwebkit2gtk-4.1-0:amd64 2.52.6-0ubuntu0.24.04.1`), with no `/dev/dri`, `LIBGL_ALWAYS_SOFTWARE=1`, `WEBKIT_DISABLE_DMABUF_RENDERER=1`, and a private 1600 by 1000 Xvfb display. The host sampler paired `cpu.stat` with each page-stable interval under `cpu.max = 200000 100000` and recorded no OOM kill. Collection read all 27 WebGL choices, 13 2D choices, and an editor baseline; the reader returned an observed fault, not an instrument failure. Evidence: `dev/v0109-team/evidence/Hygiene109/wglgrd/stage3/native-reading-28.{status,monitor-status,cgroup.jsonl}` and `dev/v0109-team/evidence/Hygiene109/wglgrd/task26/guest-v3/wglgrd-task26/native-reading-28/{observations.json,summary.json,reader.log}`.

CPU columns are guest CPU seconds per wall-clock second, paired from the host sampler. "Before" covers the probe; "after" covers the stable page after the decision, so a kept row still shows its WebGL choice. The requested probe window was 1500 ms; the observed request-to-resolution windows were 1502 to 2419 ms, including page-start stalls in the wall-clock window.

| WebGL choice | Rate (callbacks/s) | Median cost (ms) | Decision | CPU before | CPU after | Swapped to |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| sixfold-vortex | 62.67 | 8.00 | keep | 1.149 | 0.858 | - |
| polar-drift | 65.33 | 6.00 | keep | 1.330 | 1.066 | - |
| threefold-veil | 65.33 | 3.00 | keep | 0.769 | 0.466 | - |
| striated-current | 65.33 | 2.00 | keep | 0.710 | 0.459 | - |
| lorenz-constellation | 65.33 | 4.00 | keep | 0.812 | 0.544 | - |
| twin-veil-dance | 65.33 | 3.00 | keep | 0.761 | 0.506 | - |
| rippled-duet | 65.33 | 4.00 | keep | 0.807 | 0.479 | - |
| fourteenfold-bloom | 54.00 | 19.00 | keep | 1.918 | 1.661 | - |
| hexagonal-bloom | 63.33 | 11.00 | keep | 1.265 | 1.048 | - |
| turbulent-oculus | 0.67 | 497.00 | swap | 1.993 | 0.345 | swaying-branches |
| stellar-outburst | 2.67 | 242.00 | swap | 2.005 | 0.335 | swaying-branches |
| amber-recursion | 8.00 | 95.50 | swap | 2.059 | 0.336 | swaying-branches |
| tenfold-dahlia | 4.00 | 188.00 | swap | 1.996 | 0.337 | swaying-branches |
| beaded-torus | 65.33 | 1.00 | keep | 0.625 | 0.438 | - |
| spiral-fountain | 65.33 | 2.00 | keep | 0.979 | 0.712 | - |
| twisting-swarm | 66.00 | 2.00 | keep | 0.671 | 0.489 | - |
| branching-wreath | 62.67 | 4.00 | keep | 1.599 | 1.307 | - |
| drifting-galaxy | 61.33 | 14.00 | keep | 1.635 | 1.407 | - |
| ninefold-lotus | 64.67 | 4.00 | keep | 0.919 | 0.739 | - |
| eightfold-coil | 64.67 | 2.00 | keep | 1.285 | 1.212 | - |
| cosmic-bell | 6.67 | 102.50 | swap | 1.997 | 0.339 | swaying-branches |
| segmented-torus | 22.00 | 53.00 | swap | 2.007 | 0.332 | swaying-branches |
| turning-shell | 65.33 | 4.00 | keep | 0.788 | 0.655 | - |
| tangent-shell | 65.33 | 3.00 | keep | 0.808 | 0.656 | - |
| stacked-spire | 65.33 | 2.00 | keep | 0.963 | 0.663 | - |
| torus-lantern | 6.00 | 110.00 | swap | 1.890 | 0.232 | radial-ribbons |
| bitwise-spheres | 66.00 | 4.00 | keep | 1.279 | 0.999 | - |

The slowest 2D choice was `quadratic-bloom` at 0.790 CPU seconds per second; adding the ruled 0.15 margin gives the 0.940 CPU s/s bound. The editor baseline, with only CodeMirror cursor blink running, was 0.096. Seven WebGL choices swapped and then used 0.232 to 0.345, all below the bound. Twenty choices kept, though the design expected every GPU-less WebGL choice to swap; seven kept choices also exceeded the bound: `polar-drift` 1.066, `fourteenfold-bloom` 1.661, `hexagonal-bloom` 1.048, `branching-wreath` 1.307, `drifting-galaxy` 1.407, `eightfold-coil` 1.212, and `bitwise-spheres` 0.999. Acceptance 2 is not met at the ruled bound.

The median probed frame cost including `gl.finish()` was 53 to 497 ms on the seven choices that swapped, so the cost rule is not wholly void as a discriminator on this engine; none of the busy probe rows had a cost below 1 ms. The measured frame cost includes both the animation callback and `gl.finish()`, so this run does not isolate whether `finish()` itself blocks. Costs of 2 to 19 ms and callback rates of 54 to 66 per second let seven above-bound choices keep. The 16 callback/s and 20 ms product thresholds remain as built: this reading does not establish a replacement constant that both enforces the GPU-less CPU bound and keeps hardware-backed WebGL. Alex, 2026-10-22: "A: close now with the limit stated in the row: the guard swaps the seven heaviest choices; seven kept choices stay above the bound, named (recommended)". This reading states those measured misses.

Alex, 2026-10-22, later direction superseding the survey answer: "our animations should use gpu when available but should work just fine without gpu, and if that's not possible we should disable them... the whole point of the animations is to be a moment of movement when the UI is doing nothing; if not possible to leverage that then we don't really need it".

Alex, 2026-10-22, same later direction: "gpu shouldn't be a blocker for my terminal working". The desktop's GPU capability and the no-GPU catalog are the next stage; this stage records the guard and its measured limit.

The observation driver also has a private hardware control mode: `--control` starts Weston with the headless backend, GL renderer, and kiosk shell on a private Wayland socket, removes the three software-display overrides, and samples DRM client engine counters on the compositor and every descendant desktop process that holds a render or card descriptor across a WebGL choice's probe window. Under WebKitGTK the page's renderer string is WebKit's mask, `Apple GPU`, on any machine, so it names neither kind there; the software-string refusal applies to an engine that names its renderer, and on the Linux desktop the DRM reading alone identifies. A moving engine counter in a WebKit web or GPU process's render-node client identifies hardware when the page supplies a non-software renderer string; compositor-only, UI-only, card-only, still and unknown readings refuse. The control prints the DRM driver names, client IDs, holder PIDs, renderer string, mapped Gallium and DRI paths, and the WebKitGTK engine path mapped in the web process as context; it requires every WebGL choice to keep without a swap. It records the AppImage build engine and system WebKitGTK package version without requiring `dpkg` on the host; host CPU pairing is off. The `OBS_CONTROL_DRY_RUN=1` arm drops the render-node requirement, prints the identification, drives three choices and ends inconclusive by design. Its constructed cases cover the moving and still counters, software with a moving counter, no render-node holder, mixed driver names, no web process, a deadline with no web process, the control reader's identification and mode guards, false swaps, and a slow first draw with the other rows continuing. The host control on a machine with a GPU is recorded in the section Hardware control on the host below. macOS and Windows remain unmeasured.

The native reading's product binaries were built at `6619f5813`; the tooling-only commit `e6d6339c0` changes no product source, and its four driver files hash equal to the reading's `instrument-sha256.txt`.

The guest display dry run at `9085f01d6` exits 3 by design after three control choices, with no product build in the host checkout. Weston 13.0.0 starts its headless GL renderer and kiosk shell and names llvmpipe in `weston.log`; the workspace page answers the inspector, reports `visible` with `focused=false`, and reports 6.00 callbacks/s on the first choice. Its `WEBGL_debug_renderer_info` result is `Apple GPU`, not llvmpipe, while no compositor or desktop descendant holds a render or card descriptor, so the identification is unknown and cannot prove hardware. The three choice rows are `sixfold-vortex` (6.00 callbacks/s, swap), `polar-drift` (4.67, swap), and `threefold-veil` (9.33, swap); the partial observation stays incomplete. The web process maps the AppImage-extracted `libwebkit2gtk-4.1.so.0`; the TCP bind test selected free port 38066. The four driver hashes in `dev/v0109-team/evidence/Hygiene109/wglgrd/task29/guest-final/evidence/wglgrd-task29/dry-run-2/control/instrument-sha256.txt` equal those of the committed guest gate, whose constructed reader and both static lints exit 0. The retained first attempt at `e96926d7c` also reached the page but its shell trap misclassified the intentional exit 3; `dev/v0109-team/evidence/Hygiene109/wglgrd/task29/guest-dry-run-1/` preserves its log. The corrected run, its `weston.log`, observations and statuses are under `dev/v0109-team/evidence/Hygiene109/wglgrd/task29/guest-final/`.

The constructed controls and isolated red mutations at `9085f01d6` cover these guards, with full logs under `dev/v0109-team/evidence/Hygiene109/wglgrd/task29/guest-final/evidence/wglgrd-task29/mutants/` and the host's real Gallium and DRI map lines used only as context:

- A moving `drm-engine-gfx` counter and a hardware renderer classify hardware; changing `>` to `>=` accepts a still counter and fails its assertion.
- A card-only holder remains unknown; admitting card nodes as render nodes fails that assertion.
- A software renderer with a moving counter, and a renderer naming both a GPU and Software, refuse; removing the software-string guard fails the software assertion.
- No descendant WebKit web process remains unknown; removing its presence guard fails that assertion.
- The host's Gallium and DRI map lines with a still counter remain unknown and `requireHardware` refuses; removing its refusal fails that assertion.
- The reader independently refuses an unknown identification and a mismatched reading mode; removing either reader guard fails its own assertion.
- The process-discovery deadline ends at 10 seconds with no web process; extending the deadline fails the 10-second assertion.
- The control accepts an unfocused visible welcome; requiring focus makes its probe wait time out.
- The dry run stops after three choices with `completed=false`; allowing a fourth fails the bound assertion.
- An unknown hardware control exits 2; changing that exit code fails the refusal assertion.
- A held inspector port 39421 refuses with exit 2 before a desktop launch; removing the bind guard loses the refusal and the constructed port assertion goes red (the bounded mutant exits 124). The bound and both attempts are under `dev/v0109-team/evidence/Hygiene109/wglgrd/task29/guest-port/`.

## GPU-less desktop welcome 2026-10-22

Alex's later 2026-10-22 direction supplies this stage's contract: "our animations should use gpu when available but should work just fine without gpu, and if that's not possible we should disable them... the whole point of the animations is to be a moment of movement when the UI is doing nothing; if not possible to leverage that then we don't really need it" and "gpu shouldn't be a blocker for my terminal working". The Linux desktop now caches whether it can open a character render node named `renderD` followed by digits under `/dev/dri`; missing, unreadable and unsuitable directories answer no GPU. macOS and Windows answer true by source, so Windows still depends on its existing renderer and runtime probe; this stage has no Windows hardware reading. The desktop appends `chan-gpu=1|0` last to native local and remote workspace URLs, and the server stamps the last recognized value into direct and fallback shells. An ordinary browser has no such meta.

The unnamed welcome reads `chan-gpu=0` before requesting a WebGL context, replaces a saved WebGL key with a persisted 2D key, and keeps random and arrow choices within the 2D catalog. `chan-gpu=1` and no hint leave the page renderer rule in place; caller-named previews, the tuner and the terminal renderer decision remain separate. WebKitGTK 2.52.6 exposes the masked page string `Apple GPU` on a GPU-less machine as well as on a GPU-backed machine, so that string alone never identifies hardware; the Linux control requires a moving DRM engine counter in a render-node client held by a desktop descendant executable `WebKitWebProcess` or `WebKitGPUProcess`, together with a renderer string that does not name software. Compositor counters and a UI process with only mapped WebKit libraries do not qualify. The browser check forces `UNMASKED_RENDERER_WEBGL=Apple GPU` and `RENDERER=WebKit WebGL` to exercise that masked branch.

Check 179 was red at the stage's parent `da73b04aff4181a154e0476a4136b4a08de7cb6a`: its ordinary no-meta control kept the seeded WebGL key and answered WebGL2, while the `chan-gpu=0` arm still had no meta, kept `sixfold-vortex`, and answered WebGL2. At the working tree, checks 128 and 179 passed together, including the ordinary no-meta control and the 2D-only hinted arm. The focused page tests passed 45/45. Six page mutants, eight Linux GPU/wire mutants and fifteen driver mutants failed their intended assertions, including early WebGL creation, arrow and random bypasses, render-node guards, hint-only shell stamping, executable-qualified DRM movement, a null renderer, absent prior engine lines, a new client, immediate software refusal, two-row unknown refusal, and WebGL/2D CPU faults. The constructed driver also passed its GPU-less, hardware, software-refusal and missing-meta cases. Logs and status files are under `dev/v0109-team/evidence/Hygiene109/wglgrd/stage4/guest-final/`.

The committed source gate passed formatting, shell and workflow lint, e2e syntax, clippy with warnings denied, full `chan-desktop` and `chan-server` suites, and `VITEST_MAX_WORKERS=1 make web-check`; the guest lacked the Windows GNU Rust target. `make -C desktop build` and `cargo build --locked -p chan -j 2` passed for the measured product snapshot and exported an AppImage and CLI to `dev/v0109-team/evidence/Hygiene109/wglgrd/stage4/final-artifacts/` with SHA-256 values in `binaries.sha256`. The native GPU-less rehearsal collected all 27 WebGL seeds as 2D replacements, all 13 2D choices and an editor baseline, with matching persisted keys and no WebGL2 request; the host-paired CPU result is recorded below.

The isolated 2026-10-22 GPU-less AppImage run at the committed product code returned monitor and guest status 0 in 502.4 seconds. Its host cgroup record has 1005 samples under a two-CPU limit, no OOM kill, 6.52 GiB peak memory and 221 MiB peak swap. The committed judge found zero faults and zero missing readings: all 27 saved WebGL keys were not offered and resolved to persisted 2D choices, all 13 direct 2D choices held, and the editor baseline was measured. Every observed choice stayed under the fixed 0.940 CPU s/s ceiling. The measured slowest 2D choice plus the prior 0.15 margin yields a 0.952 reference, while the fixed acceptance ceiling remains 0.940; no measured row crosses that ceiling. The first monitor run overlapped another guest job, ended at status 143 and is kept as `native-reading-1.aborted-1.*`, diagnostic only; all CPU values below come from `native-reading-2`.

| Seeded WebGL key | Shown 2D key | CPU s/s |
| --- | --- | ---: |
| sixfold-vortex | quadratic-bloom | 0.828 |
| polar-drift | quadratic-bloom | 0.802 |
| threefold-veil | exponential-thread | 0.221 |
| striated-current | chaotic-halo | 0.454 |
| lorenz-constellation | concentric-pulse | 0.237 |
| twin-veil-dance | chaotic-halo | 0.469 |
| rippled-duet | orbital-rosette | 0.282 |
| fourteenfold-bloom | exponential-echo | 0.266 |
| hexagonal-bloom | chaotic-halo | 0.468 |
| turbulent-oculus | spiral-spokes | 0.244 |
| stellar-outburst | radial-ribbons | 0.261 |
| amber-recursion | recursive-arc-bloom | 0.261 |
| tenfold-dahlia | concentric-pulse | 0.221 |
| beaded-torus | concentric-pulse | 0.237 |
| spiral-fountain | exponential-echo | 0.269 |
| twisting-swarm | concentric-pulse | 0.249 |
| branching-wreath | radial-ribbons | 0.263 |
| drifting-galaxy | concentric-pulse | 0.241 |
| ninefold-lotus | recursive-arc-bloom | 0.279 |
| eightfold-coil | exponential-thread | 0.256 |
| cosmic-bell | quadratic-bloom | 0.787 |
| segmented-torus | spiral-spokes | 0.204 |
| turning-shell | recursive-arc-bloom | 0.247 |
| tangent-shell | spiral-spokes | 0.213 |
| stacked-spire | orbital-rosette | 0.242 |
| torus-lantern | spiral-spokes | 0.213 |
| bitwise-spheres | quadratic-bloom | 0.787 |

| 2D key | CPU s/s |
| --- | ---: |
| radial-ribbons | 0.256 |
| concentric-pulse | 0.231 |
| exponential-thread | 0.289 |
| exponential-echo | 0.309 |
| quadratic-bloom | 0.802 |
| orbital-rosette | 0.319 |
| dotted-waves | 0.300 |
| spiral-spokes | 0.281 |
| mutual-force-starburst | 0.339 |
| recursive-arc-bloom | 0.327 |
| chaotic-halo | 0.506 |
| swaying-branches | 0.424 |
| contracting-spiral | 0.332 |

Slowest 2D: quadratic-bloom at 0.802 CPU s/s.
Recomputed bound: 0.952 CPU s/s; fixed acceptance ceiling: 0.940 CPU s/s.
Editor baseline: 0.145 CPU s/s.
WebGL replacement range: 0.204 to 0.828 CPU s/s.
2D range: 0.231 to 0.802 CPU s/s.

The acceptance bound is the 0.940 CPU s/s stated from the first native reading (its slowest 2D choice, 0.790, plus the 0.15 margin) and kept fixed by the lead's ruling of 2026-10-22, so a slower 2D row in a later reading does not raise it; this reading's 0.952 is reported as a reference, and the committed judge compares every row with 0.940.

At the measured product snapshot, browser check 179 passed three isolated solo runs, each with its ordinary no-meta WebGL2 control green, and passed beside unchanged check 128. It also passed within the first 96-check whole-suite run. That whole run passed 94 checks and failed `drag-focus-colour` when a reloaded window restored blue instead of orange and `rich-prompt-chrome` at its wait for the reopened card's kept draft (`177-rich-prompt-chrome.mjs:112`); these are separate from the welcome hint. Both checks passed together in a fresh focused rerun (2/2), so the first whole-suite failure remains recorded rather than discarded. At the final commit the whole suite passed 95 of 96: checks 176 and 179 passed and `rich-prompt-chrome` failed again at the same wait. Both `rich-prompt-chrome` reds match the Rich Prompt reopen race that `c5c4a2741` repairs on the integration branch, which this branch's base predates; the `drag-focus-colour` red at the measured snapshot did not recur in the final whole run or the focused reruns and stays unexplained. The first run, focused rerun and final gate logs are under `dev/v0109-team/evidence/Hygiene109/wglgrd/stage4/guest-final/`.

The marketing site's animation gallery mounts this welcome, and its test mocks the workspace app's `webglRenderer` module, so the mock answers `welcomeWebglRendererKind` as the kind of the mocked page reading (`web/packages/marketing/src/AnimationGallery.test.ts`). Without that answer `make web-marketing-check` fails at this item's commit on the mock's missing export, one failed of the marketing package's eight tests (`dev/v0109-team/evidence/Lead109/int/gate-wglgrd/02-web-marketing-check.log`), and passes with it, eight of eight, at `5a75c9411` plus the change (`dev/v0109-team/evidence/Frontend109/wglmkt/proof-1.log`). A stand-in answering a fixed `software` survives the gallery's six tests, so no marketing test reads the welcome's set from the kind, a gap of that package's own pins; the workspace app's `EmptyPaneWelcome.choice.test.ts` and `webglRenderer.test.ts` pin the 2D set and the meta's arm.

## Hardware control on the host 2026-10-22

The control ran once on the host (16 CPUs, an AMD GPU on `/dev/dri/renderD128` under the `amdgpu` driver, WebKitGTK 2.52.5 as the system package and 2.52.6 in the AppImage's engine record) against the stage's final-tip artifacts, the AppImage `6b30afde6cebca5ec4018022b5709677fffd22ecde51f4ee33648e721a5e6bca` and the CLI `fe981677f455716bac76ef563b0a8dd986e9bcb9ba2e625f1f877e7833a1d119`, from a private clone pinned at the stage commit with the five instrument files hash-equal to it before and after the run, on a private headless Weston with the GL renderer, with the inspector port read free first and the host's load between 2.9 and 4.0 of 16. The identification read hardware: three `WebKitWebProcess` descendants each held one `amdgpu` render-node client through four descriptors, and the gfx and compute counters of two of them advanced (clients 197 and 200), while the compositor and the desktop's UI process held nodes without qualifying, and the page's renderer string was WebKit's mask, `Apple GPU`. All 27 WebGL choices kept their key without a swap, at 61 to 63 animation callbacks per second with a median drawn-frame cost of 0 to 11 ms in 1.5 s windows; the reader's verdict was `VERDICT PASS: 0 faults, 0 no readings`, the collect and judge steps both rc 0, in 2 minutes 40 seconds. The record is `dev/v0109-team/evidence/Lead109/wglgrd/control-03.*` (the first run, `control-02.*`, read the same verdict from the seat's live worktree and is kept as diagnostic only, since that worktree had moved past the stage commit when it ran).
