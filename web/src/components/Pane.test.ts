// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

import paneSource from "./Pane.svelte?raw";
import {
  cancelPaneMode,
  enterPaneMode,
  enterPaneModeTransaction,
  layout,
  paneMode,
  paneModeSetGrab,
  paneModeSetHover,
  splitPane,
  type LeafNode,
  type TerminalTab,
} from "../state/tabs.svelte";

const mounted: Array<Record<string, any>> = [];

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

globalThis.ResizeObserver = TestResizeObserver as any;
globalThis.matchMedia = ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent: () => false,
})) as any;
HTMLCanvasElement.prototype.getContext = (() => ({})) as any;

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
  cancelPaneMode();
});

function terminalTab(partial: Partial<TerminalTab> = {}): TerminalTab {
  return {
    kind: "terminal",
    id: "term-1",
    title: "Terminal",
    createdAt: 1,
    broadcastEnabled: false,
    broadcastTargetIds: [],
    ...partial,
  };
}

async function renderPane(pane: LeafNode, options: { paneMode?: boolean } = {}) {
  layout.rootId = pane.id;
  layout.activePaneId = pane.id;
  layout.nodes = { [pane.id]: pane };
  layout.focusColor = "blue";
  if (options.paneMode ?? true) enterPaneMode();
  else cancelPaneMode();
  const target = document.createElement("div");
  document.body.append(target);
  const { default: Pane } = await import("./Pane.svelte");
  const component = mount(Pane, { target, props: { pane } });
  mounted.push(component);
  await tick();
  return target;
}

function menuLabels(): string[] {
  return [...document.body.querySelectorAll(".hamburger-menu button")]
    .map((button) =>
      [...button.querySelectorAll(".menu-row-label, span:not(.menu-row-chord)")]
        .map((span) => span.textContent?.trim() ?? "")
        .filter(Boolean)
        .join(" ")
        .trim(),
    )
    .filter(Boolean);
}

describe("Pane terminal tab activity marker", () => {
  test("tabs expose selected state and labelled close buttons", async () => {
    const active = terminalTab({ id: "term-active", title: "Active" });
    const inactive = terminalTab({ id: "term-bg", title: "Background" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-tabs-a11y",
      tabs: [active, inactive],
      activeTabId: active.id,
    };

    const target = await renderPane(pane, { paneMode: false });
    const tabs = target.querySelectorAll<HTMLElement>('[role="tab"]');

    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    expect(
      tabs[0]?.querySelector<HTMLButtonElement>(".close")?.getAttribute("aria-label"),
    ).toBe("close Active");
  });

  test("renders output-since-focus marker for inactive terminal tabs", async () => {
    const active = terminalTab({ id: "term-active", title: "Active" });
    const inactive = terminalTab({
      id: "term-bg",
      title: "Background",
      terminalActivity: true,
    });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-test",
      tabs: [active, inactive],
      activeTabId: active.id,
    };

    const target = await renderPane(pane);

    expect(
      target.querySelector('[aria-label="terminal output since last focus"]'),
    ).not.toBeNull();
  });
});

describe("Pane right-click menus", () => {
  test("hamburger follows roadmap spawn, navigation, and focus colour order", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-menu",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    expect(document.body.querySelector(".menu-label span")?.textContent?.trim()).toBe(
      "Focus border colour",
    );
    expect(menuLabels()).toEqual([
      "New Draft",
      "Terminal",
      "File Browser",
      "Rich Prompt",
      "Graph",
      "Enter Hybrid Nav",
      "Split right",
      "Split bottom",
      "Next pane",
      "Previous pane",
      "Close all tabs",
      "Kill pane",
      "blue",
      "orange",
      "green",
      "pink",
    ]);

    const orange = [...document.body.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")]
      .find((button) => button.textContent?.includes("orange"));
    orange?.click();
    await tick();

    expect(target.querySelector(".pane")?.getAttribute("data-focus-color")).toBe("orange");
  });

  test("pane hamburger keeps roadmap actions without the old close-pane row", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-trim",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector<HTMLButtonElement>(".hamburger-trigger")?.click();
    await tick();

    const labels = menuLabels();
    expect(labels).toContain("Next pane");
    expect(labels).toContain("Previous pane");
    expect(labels).toContain("Split right");
    expect(labels).toContain("Split bottom");
    expect(labels).toContain("Close all tabs");
    expect(labels).toContain("Kill pane");
    expect(labels).not.toContain("Flip Hybrid");
    expect(labels).not.toContain("Close pane");
  });

  test("pane hamburger pins roadmap chord labels to existing helpers", () => {
    expect(paneSource).toMatch(
      /label: "Split right"[\s\S]*?chord: paneModeChordLabel\("\/"\)/,
    );
    expect(paneSource).toMatch(
      /label: "Split bottom"[\s\S]*?chord: paneModeChordLabel\("\\\\"\)/,
    );
    expect(paneSource).toMatch(
      /label: "Next pane"[\s\S]*?command: "app\.pane\.next"[\s\S]*?chord: formatChord\("Mod\+]"/,
    );
    expect(paneSource).toMatch(
      /label: "Previous pane"[\s\S]*?command: "app\.pane\.prev"[\s\S]*?chord: formatChord\("Mod\+\["/,
    );
    expect(paneSource).toMatch(
      /label: "Close all tabs"[\s\S]*?command: "app\.pane\.closeTabs"[\s\S]*?chord: chordLabel\("app\.pane\.closeTabs"\)/,
    );
    expect(paneSource).toMatch(
      /label: "Kill pane"[\s\S]*?command: "app\.pane\.kill"[\s\S]*?chord: chordLabel\("app\.pane\.kill"\)/,
    );
  });

  test("empty pane right-click shows the welcome menu", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-empty",
      tabs: [],
      activeTabId: null,
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector(".placeholder")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
    await tick();

    // `fullstack-a-32` + `fullstack-a-67` slice 2 +
    // `fullstack-a-75`: spawn set unified across 5 entries (New
    // Draft / Terminal / File Browser / Rich Prompt / Graph),
    // separator, then extras (Search + Infographics), then
    // Settings. Same set + ordering as the pane hamburger and
    // the carousel slide 1. Infographics added by -a-75 (read-
    // only shortcut sheet + future info panels).
    expect(menuLabels()).toEqual([
      "New Draft",
      "Terminal",
      "File Browser",
      "Rich Prompt",
      "Graph",
      "Search",
      "Infographics",
      "Settings",
    ]);
  });

  test("empty pane left-click leaves the welcome menu closed", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-empty-leftclick",
      tabs: [],
      activeTabId: null,
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector(".placeholder")?.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
        button: 0,
      }),
    );
    await tick();

    // No menu should be open after a plain left-click on the
    // empty-pane background — the welcome menu is right-click only.
    // The hamburger trigger (in the tabs strip) renders its own
    // button without opening a popover, so any `.hamburger-menu`
    // node in the DOM means the welcome popover actually opened.
    expect(document.body.querySelector(".hamburger-menu")).toBeNull();
  });

  test("loaded pane right-click keeps reload and inspector menu", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-loaded",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    target.querySelector(".tabs")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 20,
        clientY: 20,
      }),
    );
    await tick();

    expect(menuLabels()).toEqual(["Reload", "Open Inspector"]);
  });

  // `fullstack-a-43` removed the `.back-attention` indicator. The
  // two phase-C pins that asserted its presence + absence don't
  // apply under the new back-side configuration-view model — the
  // back has no "unread" or "activity" surface to flag.
});

describe("Pane back-side configuration view (fullstack-a-43)", () => {
  test("passes the flip callback into every back-side config OK button", () => {
    expect(paneSource).toMatch(
      /<HybridTerminalConfig onDone=\{\(\) => flipHybrid\(pane\.id\)\} \/>/,
    );
    expect(paneSource).toMatch(
      /<HybridEditorConfig onDone=\{\(\) => flipHybrid\(pane\.id\)\} \/>/,
    );
    expect(paneSource).toMatch(
      /<HybridGraphConfig onDone=\{\(\) => flipHybrid\(pane\.id\)\} \/>/,
    );
    expect(paneSource).toMatch(
      /<HybridFileBrowserConfig onDone=\{\(\) => flipHybrid\(pane\.id\)\} \/>/,
    );
  });

  test("renders HybridTerminalConfig when active front tab is terminal", async () => {
    const front = terminalTab({ id: "front-term", title: "front" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-back-term",
      tabs: [front],
      activeTabId: front.id,
      back: {},
      showingBack: true,
    };
    const target = await renderPane(pane, { paneMode: false });

    expect(
      target.querySelector('[aria-label="Hybrid Terminal configuration"]'),
    ).not.toBeNull();
    // `fullstack-a-54`: tab strip stays visible on the back side
    // (mirrored via the .flipped class).
    // `fullstack-a-55`: the family-name title was removed from
    // the tab strip — the back-side config component owns its
    // own title at the top of its content area.
    const tabs = target.querySelector(".tabs");
    expect(tabs).not.toBeNull();
    expect(tabs!.classList.contains("flipped")).toBe(true);
    expect(target.querySelector(".hybrid-title")).toBeNull();
  });

  test("renders HybridEditorConfig when active front tab is a file", async () => {
    const front = {
      kind: "file" as const,
      fileKind: "document" as const,
      id: "front-file",
      path: "notes/a.md",
      content: "",
      saved: "",
      savedMtime: null,
      mode: "wysiwyg" as const,
      loading: false,
      error: null,
      fileMissing: null,
      inspectorOpen: false,
      outlineOpen: false,
      repoRoot: null,
      readMode: false,
      fsWritable: true,
      styleToolbarOpen: false,
      syntaxHighlight: true,
      highlightTrailingWhitespace: false,
      codeBlocksCollapsed: false,
    };
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-back-editor",
      tabs: [front],
      activeTabId: front.id,
      back: {},
      showingBack: true,
    };
    const target = await renderPane(pane, { paneMode: false });

    expect(
      target.querySelector('[aria-label="Hybrid Editor configuration"]'),
    ).not.toBeNull();
  });

  test("renders Hybrid placeholder when no front tab is active", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-back-empty",
      tabs: [],
      activeTabId: null,
      back: {},
      showingBack: true,
    };
    const target = await renderPane(pane, { paneMode: false });

    // No specific config surface — the empty-state placeholder
    // renders instead, asking the user to open a front tab first.
    expect(target.querySelector(".back-empty")).not.toBeNull();
    expect(
      target.querySelector('[aria-label="hybrid back side"]'),
    ).not.toBeNull();
  });

  test("front-tab content does not render while showingBack=true (fullstack-a-43 + -a-54)", async () => {
    const front = terminalTab({ id: "front-term" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-back-content-hidden",
      tabs: [front],
      activeTabId: front.id,
      back: {},
      showingBack: true,
    };
    const target = await renderPane(pane, { paneMode: false });

    // `fullstack-a-54`: tab strip stays visible on the back side
    // (was hidden under -a-43). The back-side wrapper still
    // renders BELOW the tab strip.
    const tabs = target.querySelector(".tabs");
    expect(tabs).not.toBeNull();
    expect(tabs!.classList.contains("flipped")).toBe(true);
    expect(target.querySelector(".back-side")).not.toBeNull();
  });
});

describe("Pane flip UX redesign (fullstack-a-54 + fullstack-a-55)", () => {
  test("family-name title is NOT rendered in the tab strip (-a-55)", async () => {
    const front = {
      kind: "file" as const,
      fileKind: "document" as const,
      id: "front-file",
      path: "notes/a.md",
      content: "",
      saved: "",
      savedMtime: null,
      mode: "wysiwyg" as const,
      loading: false,
      error: null,
      fileMissing: null,
      inspectorOpen: false,
      outlineOpen: false,
      repoRoot: null,
      readMode: false,
      fsWritable: true,
      styleToolbarOpen: false,
      syntaxHighlight: true,
      highlightTrailingWhitespace: false,
      codeBlocksCollapsed: false,
    };
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-fly-editor",
      tabs: [front],
      activeTabId: front.id,
      back: {},
      showingBack: true,
    };
    const target = await renderPane(pane, { paneMode: false });
    // `-a-55` regression guard: the back-side config component
    // owns its own title; the tab-strip slot is empty.
    expect(target.querySelector(".hybrid-title")).toBeNull();
    // The back-side config view IS still rendered.
    expect(
      target.querySelector('[aria-label="Hybrid Editor configuration"]'),
    ).not.toBeNull();
  });

  test("front-state pane does not carry the .flipped class", async () => {
    const front = terminalTab({ id: "front-term" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-front-no-flip",
      tabs: [front],
      activeTabId: front.id,
    };
    const target = await renderPane(pane, { paneMode: false });
    const tabs = target.querySelector(".tabs");
    expect(tabs).not.toBeNull();
    expect(tabs!.classList.contains("flipped")).toBe(false);
    expect(target.querySelector(".hybrid-title")).toBeNull();
  });

  test("Pane source carries the -a-55 flip CSS (per-child scaleX + row-reverse)", () => {
    // `-a-54` applied the transform to the whole `.tab`, which
    // broke click routing (webtest-a-5 check #6 PARTIAL). `-a-55`
    // moves the transform to per-child selectors so the `.tab`
    // element's click target stays in natural coordinates.
    expect(paneSource).toMatch(
      /\.tabs\.flipped \.tab \.tab-icon[\s\S]*?\.tabs\.flipped \.tab \.path[\s\S]*?transform: scaleX\(-1\)/,
    );
    // Old whole-tab transform regression guard.
    expect(paneSource).not.toMatch(
      /\.tabs\.flipped \.tab \{ transform: scaleX\(-1\); \}/,
    );
    // `-a-55` right-alignment: row-reverse on flipped + order: 1
    // on actions puts hamburger leftmost + tabs flowing from the
    // right edge per @@Alex's "tabs aligned to the right" framing.
    expect(paneSource).toMatch(
      /\.tabs\.flipped \{[\s\S]*?flex-direction: row-reverse/,
    );
    expect(paneSource).toMatch(/\.tabs\.flipped \.actions \{[\s\S]*?order: 1/);
    // Old order: -1 swap regression guard (was -a-54's shape).
    expect(paneSource).not.toMatch(/\.tabs\.flipped \.actions \{[\s\S]*?order: -1/);
  });

  test("clicking a tab from the flipped state still swaps active (-a-55)", async () => {
    const t1 = terminalTab({ id: "front-t1", title: "T1" });
    const t2 = terminalTab({ id: "front-t2", title: "T2" });
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-flip-click",
      tabs: [t1, t2],
      activeTabId: t1.id,
      back: {},
      showingBack: true,
    };
    const target = await renderPane(pane, { paneMode: false });

    // The second tab is inactive at start.
    const tabs = target.querySelectorAll<HTMLElement>(".tabs .tab");
    expect(tabs.length).toBe(2);
    const t2El = tabs[1]!;
    expect(t2El.classList.contains("active")).toBe(false);

    // Fire mousedown — the active-tab swap path lives there
    // (the click handler is bookkeeping; the actual write to
    // `pane.activeTabId` is in onmousedown).
    t2El.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await tick();

    // Active-tab swap visible via the live pane state.
    expect(pane.activeTabId).toBe(t2.id);
  });
});

describe("Pane Hybrid NAV transaction mode (fullstack-a-44)", () => {
  test("renders dead-zone hit area between last tab and actions", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-dz",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });

    const tabs = target.querySelector(".tabs");
    const deadZone = target.querySelector(".dead-zone");
    const actions = target.querySelector(".actions");
    expect(deadZone).not.toBeNull();
    // Dead zone must sit inside the tab strip, between the last tab
    // and the .actions block, so it absorbs mouse interactions in
    // the empty stretch the user perceives as "the pane top bar".
    expect(tabs?.contains(deadZone!)).toBe(true);
    expect(tabs?.contains(actions!)).toBe(true);
  });

  test("double-click on the dead zone enters transaction mode with no grab (Entry B)", async () => {
    const pane: LeafNode = {
      kind: "leaf",
      id: "pane-dz-dblclick",
      tabs: [terminalTab()],
      activeTabId: "term-1",
    };
    const target = await renderPane(pane, { paneMode: false });
    const deadZone = target.querySelector<HTMLElement>(".dead-zone");
    expect(deadZone).not.toBeNull();

    deadZone!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await tick();

    expect(paneMode.active).toBe(true);
    expect(paneMode.transactionMode).toBe(true);
    expect(paneMode.grabPaneId).toBeNull();
  });

  test("pane root flips transaction-grab / transaction-drop-target classes from paneMode state", async () => {
    const leftTab = terminalTab({ id: "term-left", title: "Left" });
    const leftPane: LeafNode = {
      kind: "leaf",
      id: "pane-left",
      tabs: [leftTab],
      activeTabId: leftTab.id,
    };
    layout.rootId = leftPane.id;
    layout.activePaneId = leftPane.id;
    layout.nodes = { [leftPane.id]: leftPane };
    layout.focusColor = "blue";
    splitPane(leftPane.id, "row", "after");
    const root = layout.nodes[layout.rootId];
    if (root?.kind !== "split") throw new Error("expected split");
    const rightPane = layout.nodes[root.b];
    if (rightPane?.kind !== "leaf") throw new Error("expected leaf");

    // Render the left pane explicitly so we can assert class flips
    // against the known pane id without relying on multi-pane mount.
    cancelPaneMode();
    const target = document.createElement("div");
    document.body.append(target);
    const { default: Pane } = await import("./Pane.svelte");
    const component = mount(Pane, { target, props: { pane: leftPane } });
    mounted.push(component);
    await tick();

    const paneEl = target.querySelector<HTMLElement>(".pane");
    expect(paneEl).not.toBeNull();
    expect(paneEl!.classList.contains("transaction-active")).toBe(false);

    enterPaneModeTransaction(leftPane.id);
    await tick();
    expect(paneEl!.classList.contains("transaction-active")).toBe(true);
    expect(paneEl!.classList.contains("transaction-grab")).toBe(true);

    // Switching grab to the OTHER pane while hovering THIS pane
    // flips the drop-target class on instead.
    paneModeSetGrab(rightPane.id);
    paneModeSetHover(leftPane.id);
    await tick();
    expect(paneEl!.classList.contains("transaction-grab")).toBe(false);
    expect(paneEl!.classList.contains("transaction-drop-target")).toBe(true);
  });

  test("dead-zone uses manual mousedown + threshold tracking, not HTML5 dragstart", () => {
    // The per-tab DnD on each `.tab` already owns HTML5 drag for
    // inter-pane tab moves. The dead-zone interaction has to use
    // manual mousedown + a window-level mousemove threshold so the
    // tab-DnD pipeline stays untouched. Pin the wiring shape.
    expect(paneSource).toContain('class="dead-zone"');
    expect(paneSource).toContain("onmousedown={onDeadZoneMouseDown}");
    expect(paneSource).toContain("ondblclick={onDeadZoneDblClick}");
    expect(paneSource).toMatch(/DEAD_ZONE_DRAG_THRESHOLD_PX\s*=\s*5/);
    // The dead-zone element itself must NOT be draggable=true (that
    // would route through HTML5 drag and collide with per-tab DnD).
    expect(paneSource).not.toMatch(/class="dead-zone"[\s\S]{0,200}draggable="true"/);
  });
});
