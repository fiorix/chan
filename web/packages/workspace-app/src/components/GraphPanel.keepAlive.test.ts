// @vitest-environment jsdom
//
// Graph tabs stay mounted while hidden. A Pane is mounted with two graph tabs
// over a fixed graph and GraphCanvas replaced by a stand-in; the assertions
// read the panels' DOM, the requests they make and the props each hands its
// canvas.

import { mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import Pane from "./Pane.svelte";
import graphPanelSource from "./GraphPanel.svelte?raw";
import {
  canvas,
  g,
  GRAPH_PANE,
  graphServer,
  graphTab,
  installGraphDom,
  resetGraphServer,
  settle,
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphReloadSignal } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  graphServer.view = {
    nodes: [g.dir(""), g.dir("notes"), g.file("notes/a.md")],
    edges: [g.edge("", "directory:notes", "contains"), g.edge("directory:notes", "notes/a.md", "contains")],
  };
});

afterEach(async () => {
  closeTabMenu();
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  await settle(2);
  timers.release();
});

/// A pane with graph tabs one and two, one active.
async function renderPane(): Promise<{ pane: LeafNode; panels: () => HTMLElement[] }> {
  layout.nodes = {
    [GRAPH_PANE]: {
      kind: "leaf",
      id: GRAPH_PANE,
      tabs: [
        graphTab({ id: "one", scopeId: "workspace" }),
        graphTab({ id: "two", scopeId: "dir:notes" }),
      ],
      activeTabId: "one",
    },
  };
  layout.rootId = GRAPH_PANE;
  layout.activePaneId = GRAPH_PANE;
  const pane = layout.nodes[GRAPH_PANE] as LeafNode;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Pane, { target, props: { pane } }) as Record<string, unknown>);
  await settle();
  return { pane, panels: () => [...target.querySelectorAll<HTMLElement>(".graph-tab")] };
}

describe("graph tabs in a pane", () => {
  test("stay mounted; only the active one is shown", async () => {
    const { pane, panels } = await renderPane();
    const [one, two] = panels();
    expect(panels()).toHaveLength(2);
    expect(one!.classList.contains("active")).toBe(true);
    expect(one!.getAttribute("aria-hidden")).toBe("false");
    expect(two!.classList.contains("active")).toBe(false);
    expect(two!.getAttribute("aria-hidden")).toBe("true");
    expect(two!.getAttribute("role")).toBe("tabpanel");

    pane.activeTabId = "two";
    await settle();
    expect(panels()[0], "the same element, not a remount").toBe(one);
    expect(two!.classList.contains("active")).toBe(true);
    expect(one!.getAttribute("aria-hidden")).toBe("true");
  });

  test("a hidden tab loads when first shown, not before", async () => {
    const { pane } = await renderPane();
    expect(graphServer.graphStreamCalls, "only the shown tab loaded").toBe(1);

    pane.activeTabId = "two";
    await settle();
    expect(graphServer.graphStreamCalls).toBe(2);

    pane.activeTabId = "one";
    await settle();
    expect(graphServer.graphStreamCalls, "coming back needs no reload").toBe(2);
  });

  test("an edit while hidden reloads the tab when it is shown again", async () => {
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    pane.activeTabId = "one";
    await settle();
    const before = graphServer.graphStreamCalls;

    graphReloadSignal.paths = ["notes/new.md"];
    graphReloadSignal.nonce += 1;
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    const whileHidden = graphServer.graphStreamCalls;

    pane.activeTabId = "two";
    await settle();
    expect(whileHidden - before, "the shown tab reloads; the hidden one waits").toBe(1);
    expect(graphServer.graphStreamCalls - whileHidden, "the hidden one reloads on show").toBe(1);
  });

  test("a canvas opens the first time its tab is shown and pauses while hidden", async () => {
    const { pane } = await renderPane();
    const [one, two] = canvas.all;
    expect(one!.open).toBe(true);
    expect(one!.paused).toBe(false);
    expect(two!.open, "never shown yet").toBe(false);
    expect(two!.paused).toBe(true);

    pane.activeTabId = "two";
    await settle();
    pane.activeTabId = "one";
    await settle();
    expect(two!.open, "stays open once shown").toBe(true);
    expect(two!.paused).toBe(true);
  });

  test("Close in a tab's menu closes that tab, not the active one", async () => {
    const { pane } = await renderPane();
    openTabMenu("two", { left: 10, top: 10, right: 10, bottom: 10 });
    await settle(2);

    const close = [...document.body.querySelectorAll<HTMLButtonElement>(".tab-menu-bubble button.mbtn")].find(
      (b) => b.querySelector(".mbtn-label")?.textContent === "Close",
    );
    close!.click();
    await settle();
    expect(pane.tabs.map((t) => t.id)).toEqual(["one"]);
  });

  test("hide a graph without dropping its layout", () => {
    // Build-time contract: a hidden graph keeps its size (visibility, not
    // display: none) so its canvas does not re-fit on every tab switch.
    // vitest drops component CSS, so the stylesheet is read as text.
    const css = graphPanelSource.slice(graphPanelSource.indexOf("<style>"));
    const rule = (selector: string) => css.slice(css.indexOf(`\n  ${selector} {`), css.indexOf("}", css.indexOf(`\n  ${selector} {`)));
    expect(rule(".graph-tab")).toContain("visibility: hidden;");
    expect(rule(".graph-tab")).toContain("position: absolute;");
    expect(rule(".graph-tab")).not.toContain("display: none");
    expect(rule(".graph-tab.active")).toContain("visibility: visible;");
  });
});

