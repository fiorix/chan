# The browser smokes cannot run in any container the project builds in, and wait on a rate

Status: REGISTERED 2026-08-09, from running the six editor checks against merged `main` at the owner's request, after noticing the CAS change had reached `main` with no editor exercised in a browser at any point in the round.

## What

Two separate defects, found together because the first hides the second.

**The suite cannot run where the project builds.** `scripts/e2e/browser-smoke` needs Chrome. The `chan-ann-ubuntu` rootfs every lane container is built from carries the Rust and Node toolchains and no browser dependencies: a downloaded Chrome fails to start on `libnspr4.so`, `libnss3.so`, `libnssutil3.so`, `libsmime3.so`, and `libasound.so.2`. The host carries no toolchain at all by policy, so there is no machine in the normal workflow where these checks run. `make pre-push` does not invoke them either; the gate ends at `web-check`, `web-marketing-check`, `shortcuts-check`, `host-build-check`.

The result is a suite that exists, is good, and is opt-in by accident. Six of its checks cover the editor's external-edit convergence path, and that path took four consecutive releases of hardening (`editor-external-restore-echo-swallow` v0.76.0, `editor-filesystem-edit-convergence` v0.78.0, `editor-widget-tests-are-nondeterministic` v0.86.0, `mtime-cas-silently-overwrites-external-edits` v0.87.0) with 18 commits touching `flushed_mtime_ns` in one month, and no lane journal in this round mentions `browser-smoke` once.

**The checks wait on a rate.** `56-external-edit-matrix` opens each step's window with:

```js
await p.goto(`${serverUrl}&w=...`, { waitUntil: "networkidle2", timeout: 60_000 });
```

`networkidle2` demands the network go quiet in an application holding live WebSockets. `waitUntil: "networkidle2"` appears in **19** of the suite's checks.

The suite's own README already rules this out: *"A check asserts a property, not a rate. A wall-clock threshold with no slack fails on a loaded host."* The rule is written down and the checks do not follow it.

## Evidence, 2026-08-09

Six checks against `main` at `3ecc6e87`, in the gate container with Chrome dependencies installed by hand:

| check | result |
| --- | --- |
| `50-editor-collab` | PASS 4.5s |
| `55-external-edit-reopen` | PASS 14.2s |
| `56-external-edit-matrix` | FAIL, navigation timeout 60s |
| `57-external-restore-converge` | PASS 5.8s |
| `63-external-shrink-convergence` | PASS 11.1s |
| `64-conflict-banner-reload` | PASS 2.6s |

`56` re-run alone twice on the same binary and workspace: **1 pass, 1 fail**, so 1 pass in 3 overall. The failure moves between steps: once after `D-rapid-edits`, once after `A-atomic-save`. The passing isolated run completed all six steps `A` through `F` with every content assertion correct.

**No content assertion has ever failed.** Only the navigation wait times out.

Ruled out, rather than assumed: a request loop keeping the page busy. The failing run logs exactly the same two 404s as the passing run, `POST /api/library/command-capabilities` and a missing `SourceCodePro-Regular.otf.woff2`, once each. Nothing polls. Host load average was 3.57 across the runs.

## Why this belongs with the timing sweep

This is instance ten of the class [load-sensitive-tests-keep-recurring-after-three-sweeps](load-sensitive-tests-keep-recurring-after-three-sweeps.md) enumerates, and the first outside the Rust suites. It is also the clearest statement of that item's thesis: the sweep's own amendment established that classification finds sites while running under pressure finds tests, and this one was found the same way, by running it under load rather than by reading it.

The two 404s are separately worth a look and are deliberately not made this item's problem. `POST /api/library/command-capabilities` returning 404 on a plain workspace window may be correct or may be a surface that moved; nobody has asked.

## The suite also has a blind spot by construction, 2026-08-09

Found while checking whether `v087-webkit-flip-faces` inherited the environment half of this item. It does, and its harness says why the environment problem is the smaller one.

`scripts/e2e/webview-flip-render.py`, added by that branch, states the case in its own docstring: the desktop webview is WebKitGTK, WebKitGTK ignores `backface-visibility` on every element, and Chrome honours it. So a card whose hidden face is hidden only by that property **renders correctly under `browser-smoke/` and covers the entire window in the shipped app**. Chrome-driven checks cannot see that class of defect at all.

That reframes this item. The environment gap means the Chrome checks do not run; this means running them would not have been sufficient anyway for anything the two engines disagree about. Two different holes, and closing the first does not close the second.

The new harness needs python-gobject with the WebKit2 4.1 typelib and an X or Wayland display. This host has python3 and neither: `gi.require_version("WebKit2", "4.1")` raises, `DISPLAY` and `WAYLAND_DISPLAY` are unset, and there is no `xvfb-run`. So it is unrunnable here for the same reason the Chrome checks are, one stack over.

It handles that better than this item's subject does, and the handling is worth copying: it exits **2** for an unavailable GUI stack, distinct from 0 and 1, and its docstring says plainly that *a skip is not a pass; report it as a skip*. An environment that cannot run a check should say so in a way a caller can act on, rather than being silently absent from the run.

## Contract

- The browser smokes are runnable in the project's own container workflow, without hand-installing browser dependencies.
- A check waits on a property the application asserts, not on the network going quiet.
- Whether the suite is part of the gate is a deliberate decision that is written down, rather than the accident of an environment that cannot run it.

## Acceptance

- A documented, repeatable path runs `scripts/e2e/browser-smoke` from a clean container: either the rootfs carries the browser dependency set, or a target installs it.
- `56-external-edit-matrix` passes 10 consecutive runs on a loaded host. The load condition is stated with the run, since a green on an idle box is what let this sit unnoticed.
- The 19 `networkidle2` waits are replaced by, or justified against, a property the page can assert. A wait that stays is justified in place with what bounds it.
- The gate's relationship to this suite is stated in `.agents/skills/gate/SKILL.md`, whichever way it is decided.
- A check whose environment is unavailable reports a distinguishable skip rather than being absent from the run, following `webview-flip-render.py`'s exit-2 convention and its rule that a skip is not a pass.

## Rough size

Small for the environment half, one rootfs or target change. Medium for the waits: 19 sites, each needing a real readiness signal rather than a blanket substitution, which is the same trap the timing sweep's classification section describes.
