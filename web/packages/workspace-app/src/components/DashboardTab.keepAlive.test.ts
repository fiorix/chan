// @vitest-environment jsdom
//
// A dashboard tab stays mounted while another tab holds its pane, the way
// graphs, terminals and editors do (the pane keeps the same instance across a
// switch; paneKeepAliveMount.test.ts compares the nodes). Only the live tab
// on the pane's visible side is active, and Hybrid Nav makes none active. A
// dashboard that is not active is hidden from assistive tech and goes quiet:
// its carousel stops rotating and stops polling the index. It is hidden by
// visibility over its full box, never display: none, so it keeps its size.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@xterm/xterm", async () => (await import("../__tests__/xterm")).xtermModule());
vi.mock("@xterm/addon-fit", async () => (await import("../__tests__/xterm")).fitAddonModule());
vi.mock("@xterm/addon-search", async () => (await import("../__tests__/xterm")).searchAddonModule());
vi.mock("@xterm/addon-serialize", async () => (await import("../__tests__/xterm")).serializeAddonModule());
vi.mock("@xterm/addon-web-links", async () => (await import("../__tests__/xterm")).webLinksAddonModule());

import { api } from "../api/client";
import { mountApp, press, settle, stubAppEnvironment, unmountApp } from "../__tests__/app";
import { fileTab, resetLayout } from "../__tests__/tabs";
import { cancelPaneMode, layout, type DashboardTab as Dashboard, type LeafNode } from "../state/tabs.svelte";
import DashboardTab from "./DashboardTab.svelte";
import dashboardSource from "./DashboardTab.svelte?raw";

stubAppEnvironment();

function dashboard(partial: Partial<Dashboard> = {}): Dashboard {
  return { kind: "dashboard", id: "dash", title: "Dashboard", ...partial };
}

describe("a dashboard tab in a pane", () => {
  beforeEach(async () => {
    await mountApp();
    resetLayout([dashboard(), fileTab({ id: "doc", path: "README.md", content: "hello", saved: "hello" })]);
    await settle();
  });

  afterEach(async () => {
    cancelPaneMode();
    await unmountApp();
  });

  function body(): HTMLElement {
    return document.querySelector<HTMLElement>('.dashboard[aria-label="Dashboard"]')!;
  }

  test("is active and readable while it is the pane's tab", () => {
    expect(body().classList.contains("active")).toBe(true);
    expect(body().getAttribute("aria-hidden")).toBe("false");
  });

  test("stays mounted but hidden while another tab holds the pane", async () => {
    const mounted = body();
    (layout.nodes["pane-test"] as LeafNode).activeTabId = "doc";
    await settle();

    expect(body()).toBe(mounted);
    expect(mounted.classList.contains("active")).toBe(false);
    expect(mounted.getAttribute("aria-hidden")).toBe("true");
  });

  test("is hidden while Hybrid Nav is on", async () => {
    press({ key: ".", code: "Period", ctrlKey: true });
    await settle();

    expect(body().getAttribute("aria-hidden")).toBe("true");
  });
});

describe("a dashboard that is not active", () => {
  let view: Record<string, unknown> | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(api, "indexingState").mockResolvedValue(null as never);
    vi.spyOn(api, "buildInfo").mockResolvedValue(null as never);
  });

  afterEach(() => {
    if (view) unmount(view);
    view = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function show(tab: Dashboard, active: boolean): void {
    const target = document.createElement("div");
    document.body.append(target);
    view = mount(DashboardTab, { target, props: { tab, active } });
    flushSync();
  }

  test("polls the index on its Search slide only while active", () => {
    show(dashboard({ carouselSlide: 1 }), false);
    vi.advanceTimersByTime(6_000);
    expect(api.indexingState).not.toHaveBeenCalled();

    unmount(view!);
    show(dashboard({ carouselSlide: 1 }), true);
    vi.advanceTimersByTime(6_000);
    expect(api.indexingState).toHaveBeenCalledTimes(3);
  });

  test("rotates its slides only while active", () => {
    const hidden = dashboard({ carouselSlide: 0 });
    show(hidden, false);
    vi.advanceTimersByTime(11_000);
    expect(hidden.carouselSlide).toBe(0);

    unmount(view!);
    const shown = dashboard({ carouselSlide: 0 });
    show(shown, true);
    vi.advanceTimersByTime(5_000);
    expect(shown.carouselSlide).toBe(1);
  });
});

describe("the dashboard's stylesheet", () => {
  // Source-text contract: a hidden dashboard keeps its box through visibility, never display: none, which would refit its index graph to nothing; jsdom lays out nothing.
  test("hidden dashboards keep layout via visibility, not display:none", () => {
    const hidden = dashboardSource.match(/^ {2}\.dashboard \{\n[\s\S]*?\n {2}\}/m)?.[0] ?? "";
    const shown = dashboardSource.match(/^ {2}\.dashboard\.active \{\n[\s\S]*?\n {2}\}/m)?.[0] ?? "";

    expect(hidden).toMatch(/^\s+position: absolute;$/m);
    expect(hidden).toMatch(/^\s+inset: 0;$/m);
    expect(hidden).toMatch(/^\s+visibility: hidden;$/m);
    expect(hidden).not.toMatch(/display: none/);
    expect(shown).toMatch(/^\s+visibility: visible;$/m);
  });
});
