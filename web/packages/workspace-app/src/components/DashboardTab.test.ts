// @vitest-environment jsdom
//
// The Dashboard tab. It opens on its pane's visible side and is labelled
// Dashboard; the indexing pill opens one on the Search slide with rotation
// off. A session saves its slide, its switched-off slides and a paused
// rotation, each only when it differs from the default, and a restore moves
// off a switched-off slide. Its right-click menu, also reached from the tab
// title, switches each of Workspace, Search and About on or off (never the
// last one), then offers Flip and Reload. Its carousel shows the workspace,
// the index graph and an About slide with the version, the build, the links,
// the donation QR and the free-software line; its dots and rotation skip a
// switched-off slide, and its index graph draws only while the carousel is
// active. A lone pane with no tabs shows the welcome surface
// instead, and the pane menu's Apps rows, in title order, spawn every tab
// kind, the dashboard included.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { api } from "../api/client";
import { demoData, mountApp, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { boardLoaded } from "../__tests__/excalidraw";
import { fileTab, resetLayout } from "../__tests__/tabs";
import { indexingCache } from "../state/indexingStatus.svelte";
import { openTabMenu } from "../state/tabMenu.svelte";
import {
  DASHBOARD_SLOT_COUNT,
  layout,
  nextEnabledSlot,
  openDashboardInActivePane,
  openIndexingDashboard,
  reconcileLayout,
  serializeLayout,
  splitPane,
  tabLabel,
  toggleDashboardSlot,
  type DashboardTab as Dashboard,
  type LeafNode,
  type SerNode,
} from "../state/tabs.svelte";
import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";

stubAppEnvironment();

function dashboard(partial: Partial<Dashboard> = {}): Dashboard {
  return { kind: "dashboard", id: "dash", title: "Dashboard", ...partial };
}

function pane(): LeafNode {
  return layout.nodes[layout.activePaneId] as LeafNode;
}

describe("a dashboard tab in the layout", () => {
  test("opens on the pane's visible side, active, labelled Dashboard", () => {
    resetLayout([fileTab()], { side: "b" });

    openDashboardInActivePane();

    const opened = pane().bTabs!.at(-1)!;
    expect(opened.kind).toBe("dashboard");
    expect(pane().bActiveTabId).toBe(opened.id);
    expect(pane().side).toBe("b");
    expect(tabLabel(opened)).toBe("Dashboard");
  });

  test("opens from the indexing pill on the Search slide with rotation off", () => {
    resetLayout([]);

    openIndexingDashboard();

    expect(pane().tabs[0]).toMatchObject({ kind: "dashboard", carouselSlide: 1, autoRotate: false });
  });

  test("saves its slide, off slides and paused rotation only when they differ from the defaults", () => {
    resetLayout([dashboard({ id: "plain" }), dashboard({ id: "tuned", carouselSlide: 2, disabledSlots: [0], autoRotate: false })]);

    const saved = serializeLayout() as Extract<SerNode, { k: "l" }>;

    expect(saved.t.map((tab) => ({ ...tab, a: undefined }))).toEqual([
      { k: "d", a: undefined },
      { k: "d", cs: 2, ds: [0], ar: false, a: undefined },
    ]);
  });

  test("restores them, moving off a switched-off slide and ignoring a set that switches every slide off", () => {
    resetLayout([]);

    reconcileLayout({
      k: "l",
      id: "pane-test",
      t: [
        { k: "d", cs: 1, ds: [1], ar: false },
        { k: "d", cs: 2, ds: [0, 1, 2] },
      ],
    } as SerNode);

    const [first, second] = pane().tabs as Dashboard[];
    expect(first).toMatchObject({ carouselSlide: 0, disabledSlots: [1], autoRotate: false });
    expect(second.carouselSlide).toBe(2);
    expect(second.disabledSlots).toBeUndefined();
  });

  test("keeps at least one slide on, forgets the set once all are back on, and steps past an off slide", () => {
    const tab = dashboard();
    expect(DASHBOARD_SLOT_COUNT).toBe(3);

    toggleDashboardSlot(tab, 0);
    toggleDashboardSlot(tab, 1);
    toggleDashboardSlot(tab, 2);
    expect(tab.disabledSlots).toEqual([0, 1]);
    expect(nextEnabledSlot({ ...tab, disabledSlots: [1] }, 0)).toBe(2);

    toggleDashboardSlot(tab, 0);
    toggleDashboardSlot(tab, 1);
    expect(tab.disabledSlots).toBeUndefined();
  });
});

describe("the dashboard's menu", () => {
  beforeEach(async () => {
    vi.spyOn(api, "buildInfo").mockResolvedValue({ version: "1.2.3", build: "abc", features: { embeddings: false } });
    await mountApp();
    resetLayout([dashboard()]);
    await settle();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await unmountApp();
  });

  function rows(): Array<[string, string | null]> {
    return [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")].map((button) => [
      button.querySelector(".menu-row-label")!.textContent!.trim(),
      button.getAttribute("aria-checked"),
    ]);
  }

  async function rightClick(): Promise<void> {
    document
      .querySelector('.dashboard[aria-label="Dashboard"]')!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    await settle();
  }

  test("switches each slide on or off, then offers Flip and Reload", async () => {
    await rightClick();

    expect(rows()).toEqual([
      ["Workspace", "true"],
      ["Search", "true"],
      ["About", "true"],
      ["Flip", null],
      ["Reload", null],
    ]);
  });

  test("switching a slide off drops its dot", async () => {
    await rightClick();
    [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")]
      .find((button) => button.textContent?.includes("Search"))!
      .click();
    await settle();

    expect((pane().tabs[0] as Dashboard).disabledSlots).toEqual([1]);
    expect([...document.querySelectorAll(".dots .dot-btn")].map((dot) => dot.getAttribute("aria-label"))).toEqual([
      "slide 1",
      "slide 3",
    ]);
  });

  test("opens from the tab title's menu request too", async () => {
    openTabMenu("dash", { left: 10, top: 10, right: 10, bottom: 10 });
    await settle();

    expect(rows().map(([label]) => label)).toContain("Reload");
  });
});

describe("the carousel's slides", () => {
  let view: Record<string, unknown> | null = null;
  let target: HTMLElement;

  beforeEach(() => {
    vi.spyOn(api, "buildInfo").mockResolvedValue({ version: "1.2.3", build: "abc", features: { embeddings: false } });
    vi.spyOn(api, "indexingState").mockResolvedValue(null as never);
  });

  afterEach(() => {
    if (view) unmount(view);
    view = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function show(props: Record<string, unknown>): void {
    target = document.createElement("div");
    document.body.append(target);
    view = mount(EmptyPaneCarousel, { target, props });
    flushSync();
  }

  test("About shows the version and build, the links, the donation QR and the free-software line", async () => {
    show({ slide: 2 });
    await vi.waitFor(() => expect(target.querySelector(".about-grid")?.textContent).toContain("1.2.3"));

    const about = target.querySelector<HTMLElement>('.slide-about[aria-label="About"]')!;
    expect([...about.querySelectorAll(".about-grid span")].map((span) => span.textContent)).toEqual([
      "chan version",
      "1.2.3",
      "build",
      "abc",
    ]);
    expect([...about.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://chan.app",
      "https://github.com/fiorix/chan",
    ]);
    expect(about.querySelector(".fund-title")?.textContent).toBe("Fund the work");
    expect(about.querySelector<HTMLImageElement>('img[alt="Donation QR code"]')!.getAttribute("src")).toContain(
      "/qr-donate.png",
    );
    expect(about.textContent!.replace(/\s+/g, " ")).toContain("Chan is free and open-source software.");
  });

  test("Workspace shows the workspace's own details", () => {
    show({ slide: 0 });

    expect(target.querySelector('.slide-workspace[aria-label="Workspace info"]')).not.toBeNull();
  });

  test("offers a dot for each slide that is on, and lands on the first one on for an off slide", () => {
    show({ slide: 1, disabledSlots: [1] });

    expect(
      [...target.querySelectorAll<HTMLButtonElement>(".dots .dot-btn")].map((dot) => [
        dot.getAttribute("aria-label"),
        dot.getAttribute("aria-selected"),
      ]),
    ).toEqual([
      ["slide 1", "true"],
      ["slide 3", "false"],
    ]);
  });

  test("rotates past a slide that is off, and not at all when rotation is paused", () => {
    vi.useFakeTimers();
    const moves: number[] = [];
    show({ slide: 0, disabledSlots: [1], onSlideChange: (i: number) => moves.push(i) });
    vi.advanceTimersByTime(5_000);
    expect(moves).toEqual([2]);

    unmount(view!);
    const paused: number[] = [];
    show({ slide: 0, autoRotate: false, onSlideChange: (i: number) => paused.push(i) });
    vi.advanceTimersByTime(11_000);
    expect(paused).toEqual([]);
  });

  test("draws the index graph while it is active and stops drawing while it is not", async () => {
    const state = {
      root: "",
      nodes: [
        { path: "", state: "indexed" as const, children_count: 1 },
        { path: "docs", state: "indexed" as const, children_count: 0 },
      ],
    };
    vi.mocked(api.indexingState).mockResolvedValue(state);
    // An inactive carousel does not poll; it draws what the last poll left.
    indexingCache.last = state;
    const frames = vi.spyOn(globalThis, "requestAnimationFrame");
    async function framesDrawn(active: boolean): Promise<number> {
      show({ slide: 1, active });
      await vi.waitFor(() => expect(target.querySelector(".indexing-graph-host canvas")).not.toBeNull());
      await new Promise((resolve) => setTimeout(resolve, 20));
      const before = frames.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      unmount(view!);
      view = null;
      return frames.mock.calls.length - before;
    }

    try {
      expect(await framesDrawn(true)).toBeGreaterThan(0);
      expect(await framesDrawn(false)).toBe(0);
    } finally {
      indexingCache.last = null;
    }
  });
});

describe("the empty pane", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await unmountApp();
  });

  test("shows the welcome surface only in a lone pane with no tabs", async () => {
    await mountApp();
    resetLayout([]);
    await settle();
    expect(document.querySelector(".welcome")).not.toBeNull();

    resetLayout([fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
    expect(document.querySelector(".welcome")).toBeNull();

    resetLayout([]);
    splitPane("pane-test", "row");
    await settle();
    expect(document.querySelector(".welcome")).toBeNull();
  });

  test("lists the pane menu's Apps rows in title order, and they spawn a dashboard, a diagram and a slide deck", async () => {
    await mountApp(
      demoData([
        { path: "README.md", kind: "document", size: 5, mtime: 100, content: "hello" },
        { path: "board.excalidraw", kind: "document", size: 2, mtime: 100, content: "{}" },
      ]),
    );
    const createDiagram = vi.spyOn(api, "createDiagram").mockResolvedValue({ path: "board.excalidraw", name: "board" });
    const createDraft = vi.spyOn(api, "createDraft");
    resetLayout([]);
    await settle();

    async function run(title: string): Promise<string[]> {
      document.querySelector<HTMLButtonElement>('.pane [aria-label="Menu"]')!.click();
      await settle();
      const apps = [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")]
        .map((button) => button.querySelector(".menu-row-label")?.textContent?.trim() ?? "")
        .filter((label) => label.startsWith("New "));
      [...document.querySelectorAll<HTMLButtonElement>(".hamburger-menu button")]
        .find((button) => button.querySelector(".menu-row-label")?.textContent?.trim() === title)!
        .click();
      await settle();
      return apps;
    }

    const apps = await run("New dashboard");
    expect(apps).toEqual([...apps].sort((a, b) => a.localeCompare(b)));
    expect(pane().tabs.at(-1)?.kind).toBe("dashboard");

    await run("New slide deck");
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledWith("slides"));

    await run("New diagram");
    await vi.waitFor(() => expect(createDiagram).toHaveBeenCalledTimes(1));
    await boardLoaded();
  });
});
