import { describe, expect, test } from "vitest";
import pane from "./Pane.svelte?raw";
import graphPanel from "./GraphPanel.svelte?raw";
import graphCanvas from "./GraphCanvas.svelte?raw";

// Graph tabs are kept ALIVE, exactly like terminals and file editors
// (see paneTerminalMount / paneFileTabKeepAlive): Pane.svelte renders
// every graph tab from an all-pane each-block and flips an
// `active` prop; inactive graphs hide via the visibility:hidden
// contract (never display:none -- a display:none host reports 0x0,
// GraphCanvas.resize() refits to nothing and pan/zoom is lost). Before
// this, GraphPanel mounted only the active graph from the if-chain, so
// every switch remounted it and GraphCanvas.start() refetched +
// re-laid-out from scratch -- the full redraw on activation. These pins
// catch any regression back to that.

describe("graph tabs survive tab switches (keep-alive)", () => {
  test("graph each-block renders all graph tabs, keyed by tab id", () => {
    expect(pane).toMatch(
      /\{#each everyTab\.filter\(\(t\) => t\.kind === "graph"\) as t \(t\.id\)\}\s+<GraphPanel/,
    );
  });

  test("graph tabs no longer mount from the active-tab if-chain", () => {
    // The pre-fix branch mounted ONLY the active graph
    // (`<GraphPanel tab={active} ...>` under
    // `{:else if active?.kind === "graph"}`), so every switch
    // remounted it. What must not return is a GraphPanel mounted off
    // `active`.
    expect(pane).not.toMatch(/<GraphPanel\s+tab=\{active\}/);
  });

  test("active prop is gated by pane mode + visible-side active tab", () => {
    expect(pane).toMatch(
      /<GraphPanel\s+tab=\{t\}\s+active=\{isLiveActive\(t\)\}/,
    );
  });

  test("onClose / onFlip capture the each-item t, not the outer active", () => {
    // BUG TO AVOID: the old branch closed over `active.id`; an
    // each-block callback that still referenced `active` would close
    // the wrong (or a stale) tab. Both callbacks must use `t`.
    expect(pane).toMatch(
      /<GraphPanel\s+tab=\{t\}[\s\S]{1,200}onClose=\{\(\) => \{\s*void closeTab\(pane\.id, t\.id\);\s*\}\}/,
    );
    // No graph each-item callback references active.id.
    expect(pane).not.toMatch(
      /<GraphPanel\s+tab=\{t\}[\s\S]{1,200}closeTab\(pane\.id, active\.id\)/,
    );
  });

  test("no `focused` prop on GraphPanel (a graph owns no keyboard caret)", () => {
    expect(pane).not.toMatch(/<GraphPanel\s+tab=\{t\}[\s\S]{1,300}focused=/);
  });
});

describe("GraphPanel threads active + gates load on visibility", () => {
  test("declares an `active` prop (defaulting false for non-pane hosts)", () => {
    expect(graphPanel).toMatch(
      /let \{\s*tab,\s*active = false,/,
    );
  });

  test("`visible` is derived from active (was a constant true)", () => {
    expect(graphPanel).toMatch(/const visible = \$derived\(active\);/);
    // The old constant must be gone, or hidden graphs would still load.
    expect(graphPanel).not.toMatch(/const visible: boolean = true;/);
  });

  test("load gating uses lazy-first + keyChanged + dirty, with PLAIN latches", () => {
    // Plain locals (not $state) so the load/watcher effects can write
    // them without tripping state_unsafe_mutation.
    expect(graphPanel).toMatch(/let hasLoadedOnce = false;/);
    expect(graphPanel).toMatch(/let graphDirty = false;/);
    expect(graphPanel).toMatch(/let lastLoadedKey: string \| null = null;/);
    expect(graphPanel).toMatch(
      /if \(!hasLoadedOnce \|\| keyChanged \|\| graphDirty\)/,
    );
  });

  test("a hidden graph marks dirty on an in-scope edit instead of reloading", () => {
    // The watcher effect, after the in-scope filter, must NOT reload a
    // hidden graph -- it sets graphDirty for a one-shot reload on the
    // next activation.
    expect(graphPanel).toMatch(
      /if \(!visible\) \{\s*\/\/[\s\S]{1,400}graphDirty = true;\s*return;\s*\}/,
    );
  });

  test("root carries the keep-alive contract: class:active + tabpanel + aria-hidden", () => {
    expect(graphPanel).toMatch(
      /class="graph-tab"\s+class:active\s+data-theme=\{tab \? surfaceThemeOverride\("graph"\) : undefined\}\s+style=\{paletteStyle \|\| undefined\}[\s\S]{1,120}role="tabpanel"\s+aria-hidden=\{!active\}/,
    );
  });

  test("hidden graphs keep layout via visibility, not display:none", () => {
    expect(graphPanel).toMatch(
      /\.graph-tab \{[^}]*position: absolute;[^}]*inset: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*\}/,
    );
    expect(graphPanel).toMatch(
      /\.graph-tab\.active \{\s*visibility: visible;\s*pointer-events: auto;\s*\}/,
    );
    // flex:1 is dropped (no longer a flex child of the pane body).
    expect(graphPanel).not.toMatch(/\.graph-tab \{[^}]*flex: 1;[^}]*\}/);
  });

  test("GraphCanvas open LATCHES via canvasEverShown + paused tracks !active", () => {
    // open={active} would reset pan/zoom on every switch (start() resets
    // the transform, stop() discards the sim) -- open MUST latch.
    expect(graphPanel).toMatch(/let canvasEverShown = \$state\(false\);/);
    expect(graphPanel).toMatch(
      /\$effect\(\(\) => \{\s*if \(active\) canvasEverShown = true;\s*\}\);/,
    );
    expect(graphPanel).toMatch(
      /<GraphCanvas\s+open=\{canvasEverShown\}\s+paused=\{!active\}/,
    );
    expect(graphPanel).not.toMatch(/<GraphCanvas\s+open=\{visible\}/);
  });
});

describe("GraphCanvas pauses instead of tearing down when hidden", () => {
  test("declares a `paused` prop (default false)", () => {
    expect(graphCanvas).toMatch(/paused\?: boolean;/);
    expect(graphCanvas).toMatch(/paused = false,/);
  });

  test("loop() short-circuits and nulls the handle while paused", () => {
    // This braced form (null the handle, then bail) is unique to
    // loop(); the resume effect uses a bare `if (paused) return;`.
    expect(graphCanvas).toMatch(
      /if \(paused\) \{\s*rafId = null;\s*return;\s*\}/,
    );
  });

  test("resume effect re-arms the loop with resize(), never start()", () => {
    // On un-pause with a live sim and a stopped loop: resize() (the pane
    // may have resized while hidden) then requestAnimationFrame(loop).
    // No start() -- that would reset the transform.
    // markDirty() between the two: the repaint gate would otherwise hold
    // the first post-resume frame back until something else changed.
    expect(graphCanvas).toMatch(
      /if \(paused\) return;\s*if \(!sim \|\| rafId !== null\) return;\s*resize\(\);\s*markDirty\(\);\s*rafId = requestAnimationFrame\(loop\);/,
    );
  });
});
