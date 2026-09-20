import { describe, expect, test } from "vitest";
import pane from "./Pane.svelte?raw";
import dashboardTab from "./DashboardTab.svelte?raw";
import carousel from "./EmptyPaneCarousel.svelte?raw";

// Dashboard tabs are kept ALIVE, exactly like graphs, terminals, and file
// editors (see paneGraphTabKeepAlive): Pane.svelte renders every dashboard
// tab from an all-pane each-block and flips an `active` prop;
// inactive dashboards hide via the visibility:hidden contract (never
// display:none, which would make the Indexing GraphCanvas refit to nothing
// and lose its layout). Mounting only the active tab from an if-chain would
// remount on every switch and rebuild the Indexing carousel's GraphCanvas +
// 3s indexer poll, the visible "reload on tab switch"; these pins guard the
// each-block keep-alive against that.

describe("dashboard tabs survive tab switches (keep-alive)", () => {
  // Where the mounting itself is asserted: paneKeepAliveMount.test.ts mounts two dashboard tabs, switches between
// them and compares the DOM nodes, which is the claim the each-block was
// standing in for.

  test("dashboard tabs never mount from the active-tab if-chain", () => {
    // Mounting the active dashboard from a front-face if-chain arm
    // (`<DashboardTab tab={active} ...>`) would remount it on every switch
    // and reload the Indexing graph. What must not appear is a DashboardTab
    // mounted off `active`.
    expect(pane).not.toMatch(/<DashboardTab\s+tab=\{active\}/);
  });

  test("active prop is gated by pane mode + visible-side active tab", () => {
    expect(pane).toMatch(
      /<DashboardTab\s+tab=\{t\}\s+active=\{isLiveActive\(t\)\}/,
    );
  });

  test("no `focused` prop on DashboardTab (a dashboard owns no keyboard caret)", () => {
    expect(pane).not.toMatch(/<DashboardTab\s+tab=\{t\}[\s\S]{1,300}focused=/);
  });
});

describe("DashboardTab threads active + carries the keep-alive contract", () => {
  test("declares an `active` prop (defaulting true for non-pane hosts)", () => {
    expect(dashboardTab).toMatch(/let \{ tab, active = true \}: Props = \$props\(\);/);
    // The keep-alive prop is named `active`, not `frontActive`.
    expect(dashboardTab).not.toMatch(/frontActive/);
  });

  test("threads active to the carousel so a hidden dashboard pauses + stops polling", () => {
    expect(dashboardTab).toMatch(/<EmptyPaneCarousel[\s\S]{1,200}\{active\}/);
  });

  test("root carries the keep-alive contract: class:active + aria-hidden", () => {
    expect(dashboardTab).toMatch(
      /class="dashboard"\s+class:active\s+aria-label="Dashboard"\s+aria-hidden=\{!active\}/,
    );
  });

  test("hidden dashboards keep layout via visibility, not display:none", () => {
    expect(dashboardTab).toMatch(
      /\.dashboard \{[^}]*position: absolute;[^}]*inset: 0;[^}]*visibility: hidden;[^}]*pointer-events: none;[^}]*\}/,
    );
    expect(dashboardTab).toMatch(
      /\.dashboard\.active \{\s*visibility: visible;\s*pointer-events: auto;\s*\}/,
    );
    // .dashboard is absolutely positioned, not a flex child of the pane
    // body, so it carries no flex:1.
    expect(dashboardTab).not.toMatch(/\.dashboard \{[^}]*flex: 1;[^}]*\}/);
  });
});

describe("EmptyPaneCarousel gates the indexing poll on active", () => {
  test("the indexing refresh effect bails while inactive (no background poll)", () => {
    // A kept-alive but hidden dashboard must not hammer /api/indexing/state.
    expect(carousel).toMatch(
      /if \(slideIndex !== 1 \|\| !active\) return;/,
    );
  });

  test("auto-rotate is paused while inactive", () => {
    expect(carousel).toMatch(/!active \|\| !autoRotate/);
  });

  test("the indexing GraphCanvas is paused while inactive (no background paint)", () => {
    // GraphCanvas runs a continuous rAF render loop; kept alive but hidden it
    // would keep painting an invisible canvas. Mirror GraphPanel's
    // paused={!active} so a backgrounded dashboard does zero paint.
    expect(carousel).toMatch(
      /<GraphCanvas\s+open=\{slideIndex === 1\}\s+paused=\{!active\}/,
    );
  });
});
