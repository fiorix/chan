// @vitest-environment jsdom
//
// Pane sizes survive a reload, including when a pane is empty. The split tree
// serializes its ratio and its empty leaves, and a divider drag schedules the
// hash and session saves itself: the layout-persistence effect tracks leaf
// nodes only, so without that a resize next to an empty pane, which nothing
// else saves, would be lost.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, sessionWindowId } from "../api/client";
import Workspace from "./Workspace.svelte";
import {
  schedulePersistStateToHash,
  scheduleSessionSave,
} from "../state/store.svelte";
import {
  type LeafNode,
  type SplitNode,
  layout,
  restoreLayout,
  serializeLayout,
  splitPane,
} from "../state/tabs.svelte";
import { resetLayout, terminalTab } from "../__tests__/tabs";
import { onWatchEvent } from "../state/store.svelte";
import { setTmuxLayout } from "../state/tmuxWindowSize.svelte";

vi.mock("./Terminals.svelte", () => ({ default: () => {} }));

vi.mock("../state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/store.svelte")>()),
  schedulePersistStateToHash: vi.fn(),
  scheduleSessionSave: vi.fn(),
}));

// jsdom has no ResizeObserver, which each Pane uses to measure itself.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  setTmuxLayout(null);
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function tmuxSplit() {
  const left = resetLayout([terminalTab({ id: "t0", terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } })]);
  const rightId = splitPane(left.id, "row", "after")!;
  const right = layout.nodes[rightId] as LeafNode;
  right.tabs.push(terminalTab({ id: "t1", terminalSessionId: "s1", tmuxPane: { connection: 1, pane: "%1" } }));
  right.activeTabId = "t1";
  const split = layout.nodes[layout.rootId];
  if (split?.kind !== "split") throw new Error("expected split");
  const tree = { kind: "row" as const, w: 120, h: 40, children: [
    { kind: "pane" as const, session: "s0", w: 60, h: 40 },
    { kind: "pane" as const, session: "s1", w: 59, h: 40 },
  ] };
  setTmuxLayout(tree);
  return { split, tree, left };
}

function mountDivider() {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(Workspace, { target }) as Record<string, unknown>);
  flushSync();
  const divider = target.querySelector<HTMLElement>(".split")!.querySelector<HTMLElement>(":scope > .divider")!;
  vi.spyOn(divider.parentElement!, "getBoundingClientRect").mockReturnValue({ width: 1000, height: 600 } as DOMRect);
  return divider;
}

test("a tmux divider drag sends one pane resize, persists no local ratio, and takes tmux's answer", () => {
  const { split, tree } = tmuxSplit();
  const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
  const divider = mountDivider();
  divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 }));
  expect(split.ratio).toBeCloseTo(0.7);
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect(request).toHaveBeenCalledExactlyOnceWith("s0", { request: "resize-pane", pane: "%0", axis: "width", cells: 83 });
  expect(schedulePersistStateToHash).not.toHaveBeenCalled();
  expect(scheduleSessionSave).not.toHaveBeenCalled();
  onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "tmux_layout", layout: {
    ...tree, children: [{ ...tree.children[0], w: 80 }, { ...tree.children[1], w: 39 }],
  } });
  expect((layout.nodes[layout.rootId] as typeof split).ratio).toBeCloseTo(80 / 119);
});

test("a tmux drag past the edge asks beyond the pane bound and shows tmux's one-cell answer", () => {
  const { tree } = tmuxSplit();
  const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
  const divider = mountDivider();
  divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 2500 }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect(request).toHaveBeenCalledWith("s0", { request: "resize-pane", pane: "%0", axis: "width", cells: 119 });
  onWatchEvent({ type: "window_command", window_id: sessionWindowId(), command: "tmux_layout", layout: {
    ...tree, children: [{ ...tree.children[0], w: 118 }, { ...tree.children[1], w: 1 }],
  } });
  const split = layout.nodes[layout.rootId];
  expect(split?.kind).toBe("split");
  if (split?.kind !== "split") return;
  expect(split.ratio).toBeCloseTo(118 / 119, 5);
});

test("a tmux divider with no live pane connection refuses the drag", () => {
  const { split, left } = tmuxSplit();
  const tab = left.tabs[0];
  if (tab?.kind !== "terminal") throw new Error("expected terminal");
  tab.terminalSessionId = undefined;
  const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
  const divider = mountDivider();
  divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect(split.ratio).toBeCloseTo(0.5);
  expect(request).not.toHaveBeenCalled();
  expect(schedulePersistStateToHash).not.toHaveBeenCalled();
});

test("a tmux divider hidden behind same-axis splits on both sides refuses the drag", () => {
  resetLayout([]);
  const split = (id: string, a: string, b: string, direction: SplitNode["direction"]): SplitNode => ({
    id, kind: "split", a, b, direction, ratio: 0.5,
  });
  const leaf = (id: string, n: number): LeafNode => ({
    id, kind: "leaf", activeTabId: `t${n}`,
    tabs: [terminalTab({ id: `t${n}`, terminalSessionId: `s${n}`, tmuxPane: { connection: 1, pane: `%${n}` } })],
  });
  layout.rootId = "root";
  layout.activePaneId = "a";
  layout.nodes = {
    root: split("root", "left", "right", "row"),
    left: split("left", "topLeft", "bottomLeft", "column"),
    right: split("right", "topRight", "bottomRight", "column"),
    topLeft: split("topLeft", "a", "b", "row"),
    bottomLeft: split("bottomLeft", "c", "d", "row"),
    topRight: split("topRight", "e", "f", "row"),
    bottomRight: split("bottomRight", "g", "h", "row"),
    a: leaf("a", 0), b: leaf("b", 1), c: leaf("c", 2), d: leaf("d", 3),
    e: leaf("e", 4), f: leaf("f", 5), g: leaf("g", 6), h: leaf("h", 7),
  };
  const pane = (n: number, w: number, h: number) => ({ kind: "pane" as const, session: `s${n}`, w, h });
  const row = (a: number, b: number, w: number, h: number) => ({ kind: "row" as const, w, h, children: [pane(a, Math.ceil((w - 1) / 2), h), pane(b, Math.floor((w - 1) / 2), h)] });
  setTmuxLayout({ kind: "row", w: 120, h: 40, children: [
    { kind: "column", w: 60, h: 40, children: [row(0, 1, 60, 20), row(2, 3, 60, 19)] },
    { kind: "column", w: 59, h: 40, children: [row(4, 5, 59, 20), row(6, 7, 59, 19)] },
  ] });
  const request = vi.spyOn(api, "tmuxRequest").mockResolvedValue(undefined);
  const divider = mountDivider();
  divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  window.dispatchEvent(new MouseEvent("mousemove", { clientX: 700 }));
  window.dispatchEvent(new MouseEvent("mouseup"));
  expect((layout.nodes.root as SplitNode).ratio).toBeCloseTo(0.5);
  expect(request).not.toHaveBeenCalled();
  expect(schedulePersistStateToHash).not.toHaveBeenCalled();
});

/// Two empty panes side by side.
function emptySplit() {
  const pane = resetLayout([]);
  splitPane(pane.id, "row", "after");
  const split = layout.nodes[layout.rootId];
  if (split?.kind !== "split") throw new Error("expected a split root");
  return split;
}

describe("pane sizes across a reload", () => {
  test("a resized empty-pane split keeps its ratio across serialize and restore", async () => {
    const split = emptySplit();
    split.ratio = 0.72;

    // What the save persists (URL hash + /api/session blob), then a reload.
    const serialized = serializeLayout();
    expect(serialized).not.toBeNull();
    await restoreLayout(serialized!);

    const restored = layout.nodes[layout.rootId];
    expect(restored?.kind).toBe("split");
    if (restored?.kind !== "split") return;
    expect(restored.ratio).toBeCloseTo(0.72, 3);
    expect((layout.nodes[restored.a] as LeafNode).tabs).toHaveLength(0);
    expect((layout.nodes[restored.b] as LeafNode).tabs).toHaveLength(0);
  });

  test("dragging the divider resizes the split and schedules both saves", () => {
    const split = emptySplit();
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Workspace, { target }) as Record<string, unknown>);
    flushSync();
    const divider = target.querySelector<HTMLElement>(".divider");
    expect(divider).not.toBeNull();
    vi.spyOn(divider!.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 600,
    } as DOMRect);

    divider!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 720 }));
    expect(schedulePersistStateToHash).not.toHaveBeenCalled();
    window.dispatchEvent(new MouseEvent("mouseup"));

    expect((layout.nodes[layout.rootId] as typeof split).ratio).toBeCloseTo(0.72, 3);
    expect(schedulePersistStateToHash).toHaveBeenCalledTimes(1);
    expect(scheduleSessionSave).toHaveBeenCalledTimes(1);
  });

  test("a plain divider keeps its five-percent grab area at the edge", () => {
    const split = emptySplit();
    const divider = mountDivider();
    divider.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 2500 }));
    window.dispatchEvent(new MouseEvent("mouseup"));
    expect(split.ratio).toBeCloseTo(0.95);
    expect(schedulePersistStateToHash).toHaveBeenCalledTimes(1);
    expect(scheduleSessionSave).toHaveBeenCalledTimes(1);
  });
});
