// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
import {
  fsg,
  g,
  graphServer,
  graphTab,
  installGraphDom,
  mountGraphPanel,
  resetGraphServer,
  settle,
  unmountGraphPanels,
} from "../__tests__/graphPanel";
import { invalidateGraph } from "../state/graphData.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { closeTabMenu, openTabMenu, tabMenu } from "../state/tabMenu.svelte";
import { layout } from "../state/tabs.svelte";

installGraphDom();

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  invalidateGraph();
  graphServer.view = {
    nodes: [g.dir(""), g.dir("notes"), g.file("notes/a.md")],
    edges: [g.edge("", "directory:notes", "contains"), g.edge("directory:notes", "notes/a.md", "contains")],
  };
  graphServer.fs = {
    nodes: [fsg.dir(""), fsg.dir("notes"), fsg.file("notes/a.md")],
    edges: [fsg.contains("", "notes"), fsg.contains("notes", "notes/a.md")],
  };
});

afterEach(() => {
  closeTabMenu();
  unmountGraphPanels();
  timers.release();
});

async function openMenu(): Promise<HTMLElement> {
  const { tab } = await mountGraphPanel(GraphPanel, layout, graphTab());
  openTabMenu(tab.id, { left: 10, top: 10, right: 10, bottom: 10 });
  await settle(2);
  const bubble = document.body.querySelector<HTMLElement>(".tab-menu-bubble");
  if (!bubble) throw new Error("graph tab menu did not open");
  return bubble;
}

function pressEscape(target: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

describe("graph tab menu Escape", () => {
  test("takes Escape before the focused surface can stop it", async () => {
    await openMenu();
    const under = document.createElement("button");
    document.body.append(under);
    const seen = vi.fn((event: KeyboardEvent) => event.stopPropagation());
    under.addEventListener("keydown", seen);
    under.focus();

    const event = pressEscape(under);
    await settle(2);

    expect(document.body.querySelector(".tab-menu-bubble")).toBeNull();
    expect(tabMenu.openForTabId).toBeNull();
    expect(seen).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(under);
    expect(event.defaultPrevented).toBe(true);
  });

  test("lets the depth slider see Escape before closing", async () => {
    const bubble = await openMenu();
    const slider = bubble.querySelector<HTMLInputElement>("input[aria-label='depth']")!;
    expect(slider.disabled).toBe(false);
    const seen = vi.fn();
    slider.addEventListener("keydown", seen);

    pressEscape(slider);
    await settle(2);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".tab-menu-bubble")).toBeNull();
    expect(tabMenu.openForTabId).toBeNull();
  });

  test("passes Escape to the focused surface with no menu open", async () => {
    await mountGraphPanel(GraphPanel, layout, graphTab());
    const under = document.createElement("button");
    document.body.append(under);
    const seen = vi.fn();
    under.addEventListener("keydown", seen);
    under.focus();

    const event = pressEscape(under);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(under);
    expect(event.defaultPrevented).toBe(false);
  });
});
