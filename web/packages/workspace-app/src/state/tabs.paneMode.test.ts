// @vitest-environment jsdom
//
// Hybrid Nav stages its changes in a draft layout: T / O / G / B add tabs to
// the draft, N / I queue a draft editor for materialization, Enter commits and
// Esc discards. A staged tab renders in its pane marked as staged, and a staged
// terminal renders, so it spawns a real PTY: Esc must kill that shell before
// the draft stops rendering, or it lingers in the registry until idle-prune.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import Pane from "../components/Pane.svelte";
import {
  cancelPaneMode,
  commitPaneMode,
  enterPaneMode,
  layout,
  paneMode,
  paneModeOpenBrowser,
  paneModeOpenTerminal,
  paneModeSplit,
  paneModeStageDiagramEditor,
  paneModeStageDraftEditor,
  paneModeStagedDraftEditorsFor,
  paneModeStagedTabIds,
  registerTerminalCloseSink,
  type LeafNode,
} from "./tabs.svelte";
import { fileTab, resetLayout, terminalTab } from "../__tests__/tabs";

// jsdom has no ResizeObserver, which Pane uses to measure its editor column.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
});

describe("staging a draft editor", () => {
  test("records the pane and side it was pressed in", () => {
    const pane = resetLayout([fileTab()]);
    enterPaneMode();
    paneModeStageDraftEditor();
    paneModeSplit("row");
    const split = paneMode.draft!.activePaneId;
    paneModeStageDiagramEditor();

    expect(split).not.toBe(pane.id);
    expect(paneModeStagedDraftEditorsFor(pane.id, "a")).toEqual([
      expect.objectContaining({ paneId: pane.id, side: "a", kind: "draft" }),
    ]);
    expect(paneModeStagedDraftEditorsFor(split, "a")).toEqual([
      expect.objectContaining({ paneId: split, side: "a", kind: "diagram" }),
    ]);
  });

  test("entering, committing and cancelling each start from none staged", () => {
    resetLayout([fileTab()]);
    enterPaneMode();
    paneModeStageDraftEditor();
    commitPaneMode();
    expect(paneMode.stagedDraftEditors).toEqual([]);

    enterPaneMode();
    expect(paneMode.stagedDraftEditors).toEqual([]);
    paneModeStageDraftEditor();
    cancelPaneMode();
    expect(paneMode.stagedDraftEditors).toEqual([]);
  });
});

describe("staged tabs", () => {
  test("are exactly the tabs the draft adds over the live layout", () => {
    resetLayout([fileTab({ id: "live" })]);
    enterPaneMode();
    paneModeOpenTerminal();
    paneModeOpenBrowser();

    const staged = paneModeStagedTabIds();
    expect(staged.size).toBe(2);
    expect(staged.has("live")).toBe(false);
    commitPaneMode();
    expect(paneModeStagedTabIds().size).toBe(0);
  });

  test("render in their pane marked as staged", async () => {
    const pane = resetLayout([fileTab({ id: "live" })]);
    enterPaneMode();
    paneModeOpenBrowser();
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(
      mount(Pane, {
        target,
        props: { pane: paneMode.draft!.nodes[pane.id] as LeafNode },
      }) as Record<string, unknown>,
    );
    await tick();

    const tabs = [...target.querySelectorAll<HTMLElement>(".tab")];
    expect(tabs).toHaveLength(2);
    expect(tabs.map((tab) => tab.classList.contains("staged"))).toEqual([false, true]);
  });

  test("Esc kills a staged terminal's shell and leaves a live one", () => {
    const live = terminalTab({ id: "term-live" });
    resetLayout([live]);
    const liveSink = vi.fn(async () => true);
    const unregisterLive = registerTerminalCloseSink(live.id, liveSink);
    enterPaneMode();
    paneModeOpenTerminal();
    const [stagedId] = [...paneModeStagedTabIds()];
    const stagedSink = vi.fn(async () => true);
    const unregisterStaged = registerTerminalCloseSink(stagedId!, stagedSink);

    cancelPaneMode();

    expect(stagedSink).toHaveBeenCalledTimes(1);
    expect(liveSink).not.toHaveBeenCalled();
    expect(Object.keys(layout.nodes)).toHaveLength(1);
    unregisterLive();
    unregisterStaged();
  });
});
