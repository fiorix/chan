// @vitest-environment jsdom
//
// Graph tabs stay mounted while hidden, and draw one graph between them: the
// window's shared one. A Pane is mounted with two graph tabs over a fixed
// graph and GraphCanvas replaced by a stand-in; the assertions read the
// panels' DOM, the requests made and the props each panel hands its canvas.

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
// Build-time contract: a hidden graph tab keeps its size (visibility, not display: none); vitest drops component CSS.
import graphPanelSource from "./GraphPanel.svelte?raw";
import {
  canvas,
  fsg,
  g,
  GRAPH_PANE,
  graphServer,
  graphTab,
  installGraphDom,
  resetGraphServer,
  settle,
} from "../__tests__/graphPanel";
import { invalidateGraph, noteGraphChanged } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphReloadSignal } from "../state/store.svelte";
import { closeTabMenu, openTabMenu } from "../state/tabMenu.svelte";
import { layout, reorderTab, type LeafNode } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;
const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
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
        graphTab({ id: "one" }),
        graphTab({ id: "two", pendingSelectId: "notes" }),
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

  test("reordering after a switch moves each graph panel with its tab", async () => {
    const { pane, panels } = await renderPane();
    const [one, two] = panels();
    expect(panels()).toHaveLength(2);

    pane.activeTabId = "two";
    await settle();
    expect(panels()[0], "the first panel survives the switch").toBe(one);

    reorderTab(GRAPH_PANE, "one", 1);
    await settle();
    expect(pane.tabs.map((tab) => tab.id)).toEqual(["two", "one"]);
    expect(panels()[0], "the second tab brings its panel forward").toBe(two);
    expect(panels()[1], "the first tab keeps its panel after moving").toBe(one);
  });

  test("a hidden tab asks for its spine when first shown, not before, and for no second graph", async () => {
    const { pane } = await renderPane();
    const spines = () => graphServer.fsGraphCalls.length;
    expect(graphServer.graphStreamCalls, "the window's graph, asked for once").toBe(1);
    expect(spines(), "only the shown tab's spine").toBe(1);
    expect(canvas.all[1]!.nodes, "the hidden tab draws nothing yet").toHaveLength(0);

    pane.activeTabId = "two";
    await settle();
    expect(graphServer.graphStreamCalls, "the second tab draws the graph the window has").toBe(1);
    expect(spines()).toBe(2);

    pane.activeTabId = "one";
    await settle();
    expect(graphServer.graphStreamCalls).toBe(1);
    expect(spines(), "coming back needs no reload").toBe(2);
  });

  test("two tabs draw one copy of the graph", async () => {
    // A spine that holds nothing the graph lacks adds nothing of its own.
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes")],
      edges: [fsg.contains("", "notes")],
    };
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    const [one, two] = canvas.all;

    expect(one!.nodes.map((n) => n.id)).toEqual(["", "directory:notes", "notes/a.md"]);
    expect(two!.nodes, "the same array of the same nodes").toBe(one!.nodes);
    expect(two!.edges).toBe(one!.edges);
  });

  test("a tab whose spine holds more draws it over the same shared nodes", async () => {
    // docs/ is on disk and not in the graph the index answered.
    graphServer.fs = {
      nodes: [fsg.dir(""), fsg.dir("notes"), fsg.dir("docs")],
      edges: [fsg.contains("", "notes"), fsg.contains("", "docs")],
    };
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    const [one, two] = canvas.all;

    expect(two!.nodes.map((n) => n.id)).toEqual(["", "directory:notes", "notes/a.md", "directory:docs"]);
    for (const id of ["", "directory:notes", "notes/a.md"]) {
      const find = (c: typeof one) => c!.nodes.find((n) => n.id === id);
      expect(find(two), `${id || "the root"} is one object in both tabs`).toBe(find(one));
    }
  });

  test("an edit reloads the graph once for the window; a hidden tab takes it when shown", async () => {
    const { pane } = await renderPane();
    pane.activeTabId = "two";
    await settle();
    pane.activeTabId = "one";
    await settle();
    const [one, two] = canvas.all;
    const streams = graphServer.graphStreamCalls;
    const spines = graphServer.fsGraphCalls.length;
    const ids = (c: typeof one) => c!.nodes.map((n) => n.id);

    graphServer.view = {
      nodes: [...graphServer.view.nodes, g.file("notes/new.md")],
      edges: [...graphServer.view.edges, g.edge("directory:notes", "notes/new.md", "contains")],
    };
    // The store's two cues for a change: the shared graph's quiet window,
    // and the signal the graph tabs take.
    noteGraphChanged(() => true);
    graphReloadSignal.paths = ["notes/new.md"];
    graphReloadSignal.nonce += 1;
    await settle();
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(graphServer.graphStreamCalls - streams, "one stream, whatever the tabs").toBe(1);
    expect(graphServer.fsGraphCalls.length - spines, "the shown tab's spine; the hidden one waits").toBe(1);
    expect(ids(one)).toContain("notes/new.md");
    expect(ids(two), "the hidden tab keeps what it drew").not.toContain("notes/new.md");

    pane.activeTabId = "two";
    await settle();
    expect(graphServer.graphStreamCalls - streams, "showing it asks for no graph").toBe(1);
    expect(graphServer.fsGraphCalls.length - spines, "and for its own spine").toBe(2);
    expect(ids(two)).toContain("notes/new.md");
    expect(two!.nodes, "the window's one copy again").toBe(one!.nodes);
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
