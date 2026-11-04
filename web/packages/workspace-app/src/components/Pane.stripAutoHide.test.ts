// @vitest-environment jsdom
//
// The pane strip under the auto-hide preference: drawn only while the
// visible side holds two or more tabs, judged per side, left alone for a
// tmux pane (which hides its strip for its own reason), and read from the
// machine preferences in a standalone terminal window, which has no
// workspace. Off, the strip stays whatever the side holds.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import Pane from "./Pane.svelte";
import paneSource from "./Pane.svelte?raw";
import {
  cancelPaneMode,
  enterPaneMode,
  flipHybrid,
  layout,
  paneMode,
  paneModeOpenBrowser,
  paneModeStageDraftEditor,
  type LeafNode,
} from "../state/tabs.svelte";
import { __testSetStandalonePreferences, persistStateToHash } from "../state/store.svelte";
import { workspace } from "../state/workspace.svelte";
import { demoWorkspaceInfo } from "../demo/data";
import { preferences } from "../__tests__/standalone";
import { terminalTab } from "../__tests__/tabs";

const mounted: Array<Record<string, unknown>> = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia;
globalThis.requestAnimationFrame ??= ((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame ??= ((handle: number) =>
  window.clearTimeout(handle)) as typeof cancelAnimationFrame;
HTMLCanvasElement.prototype.getContext = (() => ({})) as unknown as HTMLCanvasElement["getContext"];

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
  workspace.info = null;
  __testSetStandalonePreferences(null);
  persistStateToHash();
});

/// A workspace window whose preferences carry the auto-hide choice.
function setWorkspacePreference(on: boolean): void {
  workspace.info = demoWorkspaceInfo(
    { metadata: { workspaceRoot: "/ws", label: "ws", generatedAt: 1, fileCount: 0, textCount: 0 }, files: [] },
    preferences({ pane_strip_auto_hide: on }),
  );
}

async function renderPane(pane: LeafNode): Promise<HTMLElement> {
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const livePane = layout.nodes[pane.id];
  if (livePane?.kind !== "leaf") throw new Error("expected leaf");
  mounted.push(mount(Pane, { target, props: { pane: livePane } }) as Record<string, unknown>);
  await tick();
  return target;
}

/// The pane as the layout holds it, so a write here is a layout write.
function live(id: string): LeafNode {
  const node = layout.nodes[id];
  if (node?.kind !== "leaf") throw new Error(`pane ${id} is not a leaf`);
  return node;
}

function strip(target: HTMLElement): HTMLElement {
  const element = target.querySelector<HTMLElement>(".tabs");
  if (!element) throw new Error("the pane renders no .tabs element");
  return element;
}

function autoHidden(target: HTMLElement): boolean {
  return strip(target).classList.contains("auto-hidden");
}

describe("the pane strip with auto-hide off", () => {
  test("an empty pane and a lone tab keep their strip", async () => {
    setWorkspacePreference(false);
    const target = await renderPane({ kind: "leaf", id: "p-off", tabs: [], activeTabId: null });
    expect(autoHidden(target), "an empty pane keeps its strip").toBe(false);

    const pane = live("p-off");
    pane.tabs.push(terminalTab({ id: "off-1" }));
    pane.activeTabId = "off-1";
    await tick();
    expect(autoHidden(target), "a lone tab keeps its strip").toBe(false);
  });

  test("a window with no preference payload keeps its strip", async () => {
    const target = await renderPane({ kind: "leaf", id: "p-none", tabs: [terminalTab({ id: "none-1" })], activeTabId: "none-1" });
    expect(autoHidden(target)).toBe(false);
  });
});

describe("the pane strip with auto-hide on", () => {
  test("the strip arrives with the second tab and leaves with it", async () => {
    setWorkspacePreference(true);
    const target = await renderPane({ kind: "leaf", id: "p-on", tabs: [], activeTabId: null });
    expect(autoHidden(target), "an empty pane draws no strip").toBe(true);
    expect(target.querySelector('[aria-label="no tab open"]'), "the empty pane keeps its welcome").not.toBeNull();

    const pane = live("p-on");
    pane.tabs.push(terminalTab({ id: "on-1" }));
    pane.activeTabId = "on-1";
    await tick();
    expect(autoHidden(target), "a lone tab draws no strip").toBe(true);

    pane.tabs.push(terminalTab({ id: "on-2" }));
    await tick();
    expect(autoHidden(target), "two tabs draw the strip").toBe(false);
    expect(target.querySelectorAll('[role="tab"]')).toHaveLength(2);

    pane.tabs.splice(1, 1);
    await tick();
    expect(autoHidden(target), "back to one tab hides the strip again").toBe(true);
  });

  test("each side is judged on its own", async () => {
    setWorkspacePreference(true);
    const a1 = terminalTab({ id: "side-a1", title: "A tab" });
    const b1 = terminalTab({ id: "side-b1", title: "B one" });
    const b2 = terminalTab({ id: "side-b2", title: "B two" });
    const target = await renderPane({
      kind: "leaf",
      id: "p-sides",
      tabs: [a1],
      activeTabId: a1.id,
      bTabs: [b1, b2],
      bActiveTabId: b1.id,
    });
    expect(autoHidden(target), "side A holds one tab: no strip").toBe(true);

    flipHybrid("p-sides");
    await tick();
    expect(live("p-sides").side).toBe("b");
    expect(autoHidden(target), "side B holds two tabs: the strip shows").toBe(false);

    flipHybrid("p-sides");
    await tick();
    expect(autoHidden(target), "back on side A the strip hides again").toBe(true);
  });

  test("a tmux pane hides its strip for its own reason either way", async () => {
    for (const on of [false, true]) {
      setWorkspacePreference(on);
      const tab = terminalTab({ id: `tmux-${on}`, terminalSessionId: "s0", tmuxPane: { connection: 1, pane: "%0" } });
      const target = await renderPane({ kind: "leaf", id: `p-tmux-${on}`, tabs: [tab], activeTabId: tab.id });
      expect(strip(target).classList.contains("control-hidden"), `preference ${on}: a tmux pane shows no strip`).toBe(true);
      for (const component of mounted.splice(0)) await unmount(component);
      document.body.innerHTML = "";
    }
  });

  test("a live preference change reaches a mounted pane", async () => {
    setWorkspacePreference(false);
    const target = await renderPane({ kind: "leaf", id: "p-live", tabs: [terminalTab({ id: "live-1" })], activeTabId: "live-1" });
    expect(autoHidden(target)).toBe(false);

    setWorkspacePreference(true);
    await tick();
    expect(autoHidden(target), "switching the preference on hides the lone tab's strip").toBe(true);

    setWorkspacePreference(false);
    await tick();
    expect(autoHidden(target), "switching it off brings the strip back").toBe(false);
  });

  test("a standalone terminal window reads the machine preference", async () => {
    workspace.info = null;
    __testSetStandalonePreferences(preferences({ pane_strip_auto_hide: true }));
    const target = await renderPane({ kind: "leaf", id: "p-mini", tabs: [terminalTab({ id: "mini-1" })], activeTabId: "mini-1" });
    expect(autoHidden(target), "a lone terminal draws no strip").toBe(true);

    live("p-mini").tabs.push(terminalTab({ id: "mini-2" }));
    await tick();
    expect(autoHidden(target), "a second terminal draws the strip").toBe(false);
  });

  test("the hidden strip is a display rule in the pane's own stylesheet", () => {
    expect(paneSource).toMatch(/\.tabs\.auto-hidden\s*\{\s*display:\s*none/);
  });
});

describe("Hybrid Nav rows keep the strip under auto-hide", () => {
  test("a staged draft editor row shows the strip beside a lone tab, and leaving the mode hides it", async () => {
    setWorkspacePreference(true);
    const target = await renderPane({ kind: "leaf", id: "p-staged-editor", tabs: [terminalTab({ id: "se-1" })], activeTabId: "se-1" });
    expect(autoHidden(target), "a lone tab draws no strip").toBe(true);

    enterPaneMode();
    await tick();
    expect(autoHidden(target), "entering the mode alone stages nothing and changes nothing").toBe(true);

    paneModeStageDraftEditor();
    await tick();
    expect(target.querySelector(".tabs .tab.staged-editor"), "the New draft row is in the strip").not.toBeNull();
    expect(autoHidden(target), "a staged row keeps the strip in view").toBe(false);

    cancelPaneMode();
    await tick();
    expect(paneMode.active).toBe(false);
    expect(autoHidden(target), "back out of the mode the lone tab hides the strip again").toBe(true);
  });

  test("a ghost tab staged on an empty pane shows the strip", async () => {
    setWorkspacePreference(true);
    const pane: LeafNode = { kind: "leaf", id: "p-ghost", tabs: [], activeTabId: null };
    layout.rootId = pane.id;
    layout.activePaneId = pane.id;
    layout.nodes = { [pane.id]: pane };
    layout.focusColor = "blue";
    enterPaneMode();
    paneModeOpenBrowser();
    // In the mode the window renders the draft layout's pane, which holds
    // the ghost tab the chord added.
    const draftPane = paneMode.draft?.nodes[pane.id];
    if (!draftPane || draftPane.kind !== "leaf") throw new Error("expected a draft leaf");
    expect(draftPane.tabs, "the chord staged one ghost tab").toHaveLength(1);
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(Pane, { target, props: { pane: draftPane } }) as Record<string, unknown>);
    await tick();
    expect(target.querySelector(".tabs .tab.staged"), "the ghost tab is drawn staged").not.toBeNull();
    expect(autoHidden(target), "a lone ghost tab keeps the strip in view").toBe(false);
  });
});
