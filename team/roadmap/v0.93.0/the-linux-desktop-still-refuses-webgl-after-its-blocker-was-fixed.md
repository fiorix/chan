# The Linux desktop still refuses WebGL after its blocker was fixed

Status: DEFERRED from v0.92.0 to v0.93.0 during roadmap close on 2026-08-18. No renderer-policy change landed in v0.92.0; `shouldUseWebglRenderer` still refuses the Linux desktop by default. Supersedes `the-webgl-present-stall-is-unmeasured-and-costs-linux-the-grid`, whose question is answered and whose blocker has since shipped a fix.

## What the earlier item settled

The stall it was named for **does not reproduce**. Measured 2026-08-11 on an AMD HawkPoint Xorg host, WebKitGTK 2.52.5: 0 stalled trials out of 144, at one, three and eight seconds of idle, read with XGetImage outside WebKit entirely, with a clean DOM control on both sides. The claim that carried `shouldUseWebglRenderer` was tested on the configuration a developer runs and did not hold.

That measurement also found a second fault, which is why the item did not simply close: with `WEBKIT_DISABLE_DMABUF_RENDERER=1` the WebGL layer put zero ink on screen in 36 of 36 trials while reporting `webglLoaded: true` and a correct cell, confirmed by two independent capture paths.

## What has changed since

`WEBKIT_DISABLE_DMABUF_RENDERER=1` is no longer set for everyone. `desktop/src-tauri/src/linux_gui_stack.rs` now sets it only when it detects the NVIDIA proprietary driver, which is the fault it was ever for ("Failed to create GBM buffer", Error 71; WebKit bug 262607, WONTFIX), with a `CHAN_LINUX_DMABUF` override and the user's own value never clobbered. That shipped in **v0.89.0** (`77342bfb`).

So the blank-WebGL configuration is now NVIDIA-only. On AMD and Intel the shipped AppImage runs the accelerated path.

## What is still true

`shouldUseWebglRenderer` returns `!(isDesktop && os === "linux")` (`web/packages/workspace-app/src/terminal/renderer.ts:47`). Every Linux desktop still gets the DOM renderer, whatever its driver, so the Linux terminal grid ships at **96.0% rule continuity and 95.2% block coverage** while every WebGL arm measures 100%. The predicate now outlives both reasons it was given: the stall it cited does not reproduce, and the packaging fault it was belt-and-braces for is driver-scoped.

## Desired contract

A Linux desktop uses the WebGL renderer where the accelerated path is actually available, and the DOM renderer where it is not. The two decisions -- whether dma-buf is disabled, and which renderer to use -- follow ONE driver signal instead of disagreeing.

## Implementation boundaries

- The desktop already computes the answer in `set_webkit_env_defaults`. The SPA cannot see it, so the shell has to surface it, the way the serving tenant already declares its file capability in the shell it serves.
- `shouldUseWebglRenderer` takes that signal instead of keying on the OS. Its existing third-argument override hatch stays, since it is how a Linux host is asked for a reading.
- Not in scope: changing when dma-buf itself is disabled. That decision is settled and driver-scoped.

## Acceptance

- On a non-NVIDIA Linux desktop, `scripts/e2e/terminal-pixels.py` reports 100% on all three ink measures for the xterm+webgl arms, matching the other platforms, rather than today's 96.0 / 95.2.
- On a host with the NVIDIA proprietary driver, the terminal keeps the DOM renderer and paints ink. A blank grid is the failure this must not ship.
- `CHAN_LINUX_DMABUF=on` on an NVIDIA host reaches the WebGL renderer, so the knob still means what it says.

## Why the acceptance is worded around ink

The earlier round's lesson: WebGL context creation succeeded, `webglLoaded` was true, the renderer string said `webgl`, there were no warnings, and nothing painted. Every signal above the pixels agreed and every one of them was wrong. Only a pixel measurement can close this.

## Round evidence, v0.93.0

`shouldUseWebglRenderer` no longer keys on the operating system. It takes the desktop's own renderer capability, and its override argument is unchanged. The desktop carries that capability to the serving tenant on the window URL rather than through the server's environment, because a remote devserver serves its own shell and cannot observe the desktop client's WebKit environment; the served shell then stamps it as `<meta name="chan-webgl-renderer">` beside the existing file-surface declaration.

The capability is tri-state, and that correction is the round's most important finding on this item. `linux::prefer_system_gui_stack` returns before `set_webkit_env_defaults` when the process is not an AppImage, so outside an AppImage no dma-buf decision is ever made. A two-state signal read the absent environment variable as "accelerated path available" and would have selected WebGL on `.deb`, `.rpm`, Nix and source builds, including on the NVIDIA proprietary driver, which is the blank-grid configuration this item exists to prevent. The signal now distinguishes a decision that ran from one that never did: a non-AppImage emits no signal at all, strips any renderer value already present on the URL, and reaches the SPA's existing null-to-DOM fallback.

Delivery is therefore deliberately AppImage-only on Linux. `.deb`, `.rpm`, Nix, source and developer builds keep the DOM renderer on every driver, including where their accelerated path is available. Extending driver detection beyond the AppImage bootstrap is deferred and is recorded as a candidate for a later version.

Acceptance:

1. Not measured. No non-NVIDIA reading was taken, because the round's machine has no display, no GPU and no WebKit2 typelib, where `--include-renderers` reports a confident 0.0% that means nothing was captured. The exact host command, the expected numbers for every measure, and the conditions that would make a reading meaningless are prepared and handed to the host.
2. Not measured, and unmeasurable this round: no NVIDIA proprietary-driver machine was available. The decision half is proven by `the_driver_decision_selects_the_matching_terminal_renderer`, which covers NVIDIA auto to DOM and `CHAN_LINUX_DMABUF=on` to WebGL at the decision boundary, and an NVIDIA AppImage lands on the DOM renderer it lands on today.
3. Not measured, for the same reason.

`a_non_appimage_has_no_renderer_signal` proves a non-AppImage returns unknown regardless of the dma-buf environment, and `renderer_signal_is_appended_for_the_serving_tenant` proves unknown removes a carried renderer query. `served_shell_carries_the_desktop_renderer_signal` proves the value reaches the SPA through the real handler rather than through a unit test of the injector.

Named evidence gap: no test drives `chan-renderer` through a registered tunnel into `serve_static` and asserts the returned meta tag. The gateway preserves generic path and query, and the desktop URL append and the served-shell response are each proven separately. The gap is safe because the signal is absent-means-DOM at every link, so a tunneled desktop that loses it keeps today's renderer rather than risking a blank grid.
