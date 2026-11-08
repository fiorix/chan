// @vitest-environment jsdom
import { mount, tick, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
vi.mock("../state/windowCaps", async (original) => ({
  ...await original<typeof import("../state/windowCaps")>(),
  windowCaps: { workspace: false, files: true, drafts: true, terminal: true },
}));
vi.mock("../api/client", async (original) => {
  const actual = await original<typeof import("../api/client")>();
  return { ...actual, api: { ...actual.api,
    buildInfo: vi.fn(async () => ({ version: "1", build: "abc", features: { embeddings: false } })),
    indexingState: vi.fn(), setEmptyPaneCarouselCycling: vi.fn(async () => {}),
    metrics: vi.fn(() => new Promise(() => {})),
  } };
});
import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";
import { api } from "../api/client";
import { nextEnabledSlot, toggleDashboardSlot, type DashboardTab } from "../state/tabs.svelte";
import { __testSetStandalonePreferences, currentPreferences } from "../state/store.svelte";
import { settingsPreferences } from "../__tests__/settings";
let mounted: ReturnType<typeof mount> | undefined;
afterEach(() => { if (mounted) unmount(mounted); mounted = undefined; document.body.innerHTML = ""; __testSetStandalonePreferences(null); vi.clearAllMocks(); });
test("standalone carousel offers only Metrics and About and never polls the index", async () => {
  const target = document.createElement("div"); document.body.append(target);
  mounted = mount(EmptyPaneCarousel, { target, props: { slide: 0 } });
  await tick();
  expect([...target.querySelectorAll(".dot-btn")].map((dot) => dot.getAttribute("aria-label"))).toEqual(["Metrics", "About"]);
  expect(target.querySelector(".metrics-slide")).not.toBeNull();
  expect(api.indexingState).not.toHaveBeenCalled();
  expect(nextEnabledSlot({}, 3)).toBe(2);
  expect(nextEnabledSlot({}, 2)).toBe(3);
});
test("cannot disable the last available standalone slide", () => {
  const tab: DashboardTab = { kind: "dashboard", id: "test", title: "Dashboard" };
  toggleDashboardSlot(tab, 3);
  toggleDashboardSlot(tab, 2);
  toggleDashboardSlot(tab, 0);
  expect(tab.disabledSlots).toEqual([3]);
});
test("play/pause updates the same preference in a standalone window", async () => {
  __testSetStandalonePreferences(settingsPreferences());
  const target = document.createElement("div"); document.body.append(target);
  mounted = mount(EmptyPaneCarousel, { target, props: { slide: 2 } });
  await tick();
  target.querySelector<HTMLButtonElement>(".cycle-toggle")!.click();
  await tick(); await Promise.resolve(); await tick();
  expect(api.setEmptyPaneCarouselCycling).toHaveBeenCalledWith(false);
  expect(currentPreferences()?.empty_pane_carousel_cycling).toBe(false);
});
