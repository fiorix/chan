# Terminal bodies turn see-through after an app switch

Status: withdrawn by the owner on 2026-11-02, with no code ("i dont think seethru even exists; we can remove it from the roadmap"); it closes to `done/` at the v0.122.0 GA. Carried into v0.122.0 at the v0.121.0 GA the same day.

Record before the release: raised by the owner on 2026-11-02 from chan-desktop 0.120.1 on macOS 27.0.1; accepted for v0.121.0 by the owner the same day ("lets fix these items"). The trigger is not known.

## What is there now

After working in Chrome and switching back to chan, the terminal bodies of every chan window on screen were see-through: Chrome's page was legible through two stacked chan windows, while glyphs, the tab strips and the title bars still painted. Reloading every window restored them. The owner's `terminal.background_opacity` is 94, so a 6 percent see-through body is by design and this was far more: the body's background fill either stopped painting or took another opacity. The unified log of that minute holds no WebGL or GPU context-loss line.

## Desired contract

1. A terminal body keeps its configured background opacity across app switches, launcher toggles and window hides, with no reload.

## Acceptance

1. A reading that reproduces it, or the bounded attempts that did not, recorded with builds, triggers and answers.
2. Where it reproduced and a fix was built: the owner's reading on the fixed build, and a test where the layer allows one.

## Closing

Not reproduced, and no reproduction was attempted: this item was worked on the Linux host, where chan-desktop is not run beside the owner's live instance, and the order's triggers (an app switch, a launcher toggle, a window hide, a display sleep) are macOS WebKit behavior that needs the owner's session. No code changed. What follows is the reading of the paint path, so the next occurrence can be read in one pass.

In a window chan-desktop built transparent (`?transparent=1`), `App.svelte` marks the root with `data-transparent-window`, sets `--terminal-opacity` to the desktop's value clamped to 80 through 100 percent (`markTerminalOpacityRoot`), and below 100 adds `data-terminal-see-through`, which makes `html`, `body` and `main` transparent and moves the workspace backdrop to `main::before`, an opaque layer masked by an SVG with a hole behind each pane face that shows a terminal (`terminal/seeThroughBackdrop.ts`). Inside a hole, the only fill is `.terminal-tab`'s background, `color-mix(in srgb, var(--terminal-background, var(--bg)) var(--terminal-opacity, 100%), transparent)` in `TerminalTab.svelte`; the pane face, the renderer host and xterm.js's viewport are transparent, and both renderers paint a transparent default background, so glyphs paint on their own canvas above the tint. The screenshot's state, glyphs and chrome painted with the body clear, is therefore the tint not painting, and the clamp rules out a low opacity value reaching it through the desktop's setting. Three causes fit, in the order the evidence favors them:

1. WebKit dropped the tint's painted layer and did not paint it again. Every chan window on screen changed at once, right after Chrome covered them, the unified log holds a memory-pressure relief in the WebContent process at 09:44:42, a few minutes before, and a reload restored them. An occluded window's page may give up its backing stores under memory pressure; the glyph canvas is painted again by its renderer's next frame, while the tint's layer repaints only when WebKit invalidates it.
2. The tint's declaration became invalid at computed-value time, which makes the background transparent: `--terminal-background` holding a value `color-mix()` cannot read (it comes from the tab's custom colors), or `--bg` missing while a theme is applied. This would not explain every window changing at once, unless a theme or settings push reached every window.
3. The masked backdrop's hole grew over the frames, which would also clear the gutters; the screenshot's gutters were not described, so this is the least likely.

For the next occurrence, before any reload, in the Web Inspector console of an affected window, with a terminal tab active:

```js
(() => {
  const root = document.documentElement;
  const tab = document.querySelector(".terminal-tab.active") ?? document.querySelector(".terminal-tab");
  const style = tab && getComputedStyle(tab);
  console.log("[seethru]", {
    markers: { ...root.dataset },
    opacity: root.style.getPropertyValue("--terminal-opacity"),
    tint: style?.backgroundColor,
    terminalBackground: style?.getPropertyValue("--terminal-background"),
    bg: style?.getPropertyValue("--bg"),
    mask: (document.querySelector("main")?.style.getPropertyValue("--see-through-mask") ?? "").length,
    visibility: document.visibilityState,
  });
})();
```

A `tint` with a non-zero alpha (about 0.94) while the body shows through points at cause 1; then `document.documentElement.style.setProperty("--terminal-opacity", "94.1%")` forces the tint to repaint, and whether that restores the body without a reload is the answer, before the order's Settings slider and hide and show questions. A `tint` of `rgba(0, 0, 0, 0)` points at cause 2, and `terminalBackground` and `bg` say which variable. The order's other questions stand: which windows and tabs (editor bodies too, or terminals only), each terminal's engine, and any `WebGL` or `context lost` console line.

Open: acceptance 1 and 2 both wait for a macOS session with the owner, on installed 0.120.1 and on a build that contains the parked hidden launcher (`fa56edc59`).
