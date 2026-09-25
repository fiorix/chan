// @vitest-environment jsdom
//
// Pane sizes survive a reload, including when a pane is empty. The split tree
// serializes its ratio and its empty leaves, and a divider drag schedules the
// hash and session saves itself: the layout-persistence effect tracks leaf
// nodes only, so without that a resize next to an empty pane, which nothing
// else saves, would be lost.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import Workspace from "./Workspace.svelte";
import {
  schedulePersistStateToHash,
  scheduleSessionSave,
} from "../state/store.svelte";
import {
  type LeafNode,
  layout,
  restoreLayout,
  serializeLayout,
  splitPane,
} from "../state/tabs.svelte";
import { resetLayout } from "../__tests__/tabs";

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
  vi.clearAllMocks();
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
});
