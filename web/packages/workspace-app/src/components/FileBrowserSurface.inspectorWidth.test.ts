// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import FileBrowserSurface from "./FileBrowserSurface.svelte";
import { installDemoWorkspace, uninstallDemoWorkspace } from "../demo/install";
import { trackTimers } from "../demo/timers";
import {
  type BrowserTab,
  type LeafNode,
  layout,
  restoreLayout,
  serializeLayout,
} from "../state/tabs.svelte";

// The File-Browser inspector width is a per-tab value (BrowserTab.inspectorWidth,
// serialized as `iw`), the same as the Editor inspector's. A resize has to reach
// the per-tab value and the layout save (URL hash and session blob), not only the
// global pane_widths slot, or a reload falls back to a default.

// Spies over the real store functions: the session save is a no-op before
// bootstrap hydration, so its call is the only thing a test can see of it.
vi.mock("../state/store.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/store.svelte")>();
  return {
    ...actual,
    persistPaneWidths: vi.fn(actual.persistPaneWidths),
    scheduleSessionSave: vi.fn(actual.scheduleSessionSave),
  };
});

import { persistPaneWidths, scheduleSessionSave } from "../state/store.svelte";

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
HTMLElement.prototype.setPointerCapture = () => {};
HTMLElement.prototype.releasePointerCapture = () => {};

function paneWith(tab: BrowserTab): LeafNode {
  const pane: LeafNode = {
    kind: "leaf",
    id: "pane-test",
    tabs: [tab],
    activeTabId: tab.id,
  };
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  return pane;
}

describe("File-Browser inspector width persistence (save/restore seam)", () => {
  test("a BrowserTab inspector width round-trips through serialize -> restore", async () => {
    const browser: BrowserTab = {
      kind: "browser",
      id: "browser-1",
      title: "Files",
      inspectorOpen: true,
      inspectorWidth: 333,
    };
    paneWith(browser);

    const serialized = serializeLayout();
    expect(serialized).not.toBeNull();
    expect(JSON.stringify(serialized)).toContain('"iw":333');

    // Re-instantiate from the persisted blob == a reload.
    await restoreLayout(serialized!);

    const pane = layout.nodes[layout.rootId] as LeafNode;
    expect(pane?.kind).toBe("leaf");
    const restored = pane.tabs.find((t) => t.kind === "browser") as
      | BrowserTab
      | undefined;
    expect(restored?.inspectorWidth).toBe(333);
  });
});

const mounted: Array<Record<string, unknown>> = [];

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// Drags the inspector's edge `dx` pixels, as a pointer would.
function drag(handle: Element, dx: number): void {
  const at = (type: string, clientX: number) =>
    handle.dispatchEvent(
      Object.assign(new MouseEvent(type, { bubbles: true, cancelable: true, clientX }), {
        pointerId: 1,
      }),
    );
  at("pointerdown", 500);
  at("pointermove", 500 + dx);
  at("pointerup", 500 + dx);
}

async function renderTabWithInspector(): Promise<HTMLElement> {
  paneWith({ kind: "browser", id: "browser-1", title: "Files", inspectorOpen: true });
  const tab = (layout.nodes["pane-test"] as LeafNode).tabs[0] as BrowserTab;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(FileBrowserSurface, { target, props: { variant: "tab", tab } }));
  await settle();
  return target;
}

describe("a File-Browser inspector resize", () => {
  test("in a tab, sets the tab's width and carries it into the URL hash and the session save", async () => {
    const timers = trackTimers();
    installDemoWorkspace({
      metadata: { workspaceRoot: "demo", label: "demo", generatedAt: 1, fileCount: 0, textCount: 0 },
      files: [],
    });
    try {
      const target = await renderTabWithInspector();
      const aside = target.querySelector<HTMLElement>("aside.inspector")!;
      const before = parseInt(aside.style.width, 10);
      // Let the mount's own debounced hash write land, then clear the hash,
      // so what the hash holds afterwards was written because of the resize.
      await new Promise((r) => setTimeout(r, 400));
      window.history.replaceState(null, "", "#");

      drag(target.querySelector(".handle")!, -60);
      await settle();

      const tab = (layout.nodes["pane-test"] as LeafNode).tabs[0] as BrowserTab;
      expect(tab.inspectorWidth).toBe(before + 60);
      expect(persistPaneWidths).toHaveBeenCalled();
      expect(scheduleSessionSave).toHaveBeenCalled();

      // The hash write is debounced; wait it out and read the layout back.
      await new Promise((r) => setTimeout(r, 400));
      const params = new URLSearchParams(window.location.hash.slice(1));
      const written = [...params.values()].find((v) => v.includes('"iw"'));
      expect(written, "the layout in the hash carries the width").toContain(`"iw":${before + 60}`);
    } finally {
      uninstallDemoWorkspace();
      timers.release();
    }
  });

});
