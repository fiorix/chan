// @vitest-environment jsdom

import { describe, expect, test } from "vitest";
import {
  activePane,
  restoreLayout,
  DASHBOARD_SEARCH_SLIDE,
  DASHBOARD_SLOT_COUNT,
  DASHBOARD_SLOT_LABELS,
  DASHBOARD_SLOT_ORDER,
  dashboardSlotEnabled,
  firstEnabledSlot,
  nextEnabledSlot,
  prevEnabledSlot,
  type DashboardTab,
} from "./tabs.svelte";

describe("the dashboard slot table", () => {
  test("keeps persisted ids stable while displaying Metrics first", () => {
    expect(DASHBOARD_SLOT_LABELS).toEqual(["Workspace", "Search", "About", "Metrics"]);
    expect(DASHBOARD_SLOT_ORDER.map((i) => DASHBOARD_SLOT_LABELS[i])).toEqual(["Metrics", "Workspace", "Search", "About"]);
  });

  test("counts one slot per label", () => {
    expect(DASHBOARD_SLOT_COUNT).toBe(DASHBOARD_SLOT_LABELS.length);
  });

  test("puts the indexing pill's Search slide on the slot labelled Search", () => {
    expect(DASHBOARD_SLOT_LABELS[DASHBOARD_SEARCH_SLIDE]).toBe("Search");
  });
});

describe("the dashboard slot walks", () => {
  test("show a slot unless it is switched off, on a tab or in the set alone", () => {
    const tab: DashboardTab = { kind: "dashboard", id: "dash", title: "Dashboard", disabledSlots: [1] };

    expect([0, 1, 2].map((i) => dashboardSlotEnabled(tab, i))).toEqual([true, false, true]);
    expect([0, 1, 2].map((i) => dashboardSlotEnabled({ disabledSlots: [2] }, i))).toEqual([true, true, false]);
    expect([0, 1, 2].map((i) => dashboardSlotEnabled({}, i))).toEqual([true, true, true]);
  });

  test("land on the first slot still on", () => {
    expect(firstEnabledSlot({})).toBe(3);
    expect(firstEnabledSlot({ disabledSlots: [3, 0] })).toBe(1);
    expect(firstEnabledSlot({ disabledSlots: [3, 0, 1] })).toBe(2);
  });

  test("step forward one slot, past a switched-off one, and wrap at the end", () => {
    expect(nextEnabledSlot({}, 1)).toBe(2);
    expect(nextEnabledSlot({ disabledSlots: [1] }, 0)).toBe(2);
    expect(nextEnabledSlot({ disabledSlots: [1] }, 2)).toBe(3);
    expect(nextEnabledSlot({}, 3)).toBe(0);
  });

  test("step back one slot, past a switched-off one, and wrap at the start", () => {
    expect(prevEnabledSlot({}, 1)).toBe(0);
    expect(prevEnabledSlot({ disabledSlots: [1] }, 2)).toBe(0);
    expect(prevEnabledSlot({ disabledSlots: [1] }, 0)).toBe(3);
    expect(prevEnabledSlot({}, 3)).toBe(2);
  });

  test("stay put when no other slot is on", () => {
    const onlySearch = { disabledSlots: [0, 2, 3] };

    expect(nextEnabledSlot(onlySearch, 1)).toBe(1);
    expect(prevEnabledSlot(onlySearch, 1)).toBe(1);
  });
});


describe("restored dashboard slots", () => {
  test.each([4, 99])("replaces out-of-range slide %i with the first enabled slot", async (slide) => {
    await restoreLayout({ k: "l", t: [{ k: "d", cs: slide, ds: [0] }] });
    const tab = activePane().tabs[0];
    if (tab?.kind !== "dashboard") throw new Error("expected dashboard tab");
    expect(tab.carouselSlide).toBe(3);
  });
});
