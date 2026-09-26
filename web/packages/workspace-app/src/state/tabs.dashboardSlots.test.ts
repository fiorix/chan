// @vitest-environment jsdom
//
// The Dashboard carousel's slot table and walks, read and called directly.
// The table names the slots in display order, Workspace, Search and About,
// the slot count follows it, and the Search slide the indexing pill opens on
// is the slot labelled Search. The walks answer from a tab or from the
// switched-off set alone, as the carousel holds it: a slot is shown unless
// switched off, the first shown slot is where a cursor lands, and a step
// forward or back skips a switched-off slot, wraps at the ends and stays put
// when no other slot is on.

import { describe, expect, test } from "vitest";
import {
  DASHBOARD_SEARCH_SLIDE,
  DASHBOARD_SLOT_COUNT,
  DASHBOARD_SLOT_LABELS,
  dashboardSlotEnabled,
  firstEnabledSlot,
  nextEnabledSlot,
  prevEnabledSlot,
  type DashboardTab,
} from "./tabs.svelte";

describe("the dashboard slot table", () => {
  test("names Workspace, Search and About in display order", () => {
    expect(DASHBOARD_SLOT_LABELS).toEqual(["Workspace", "Search", "About"]);
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
    expect(firstEnabledSlot({})).toBe(0);
    expect(firstEnabledSlot({ disabledSlots: [0] })).toBe(1);
    expect(firstEnabledSlot({ disabledSlots: [0, 1] })).toBe(2);
  });

  test("step forward one slot, past a switched-off one, and wrap at the end", () => {
    expect(nextEnabledSlot({}, 1)).toBe(2);
    expect(nextEnabledSlot({ disabledSlots: [1] }, 0)).toBe(2);
    expect(nextEnabledSlot({ disabledSlots: [1] }, 2)).toBe(0);
  });

  test("step back one slot, past a switched-off one, and wrap at the start", () => {
    expect(prevEnabledSlot({}, 1)).toBe(0);
    expect(prevEnabledSlot({ disabledSlots: [1] }, 2)).toBe(0);
    expect(prevEnabledSlot({ disabledSlots: [1] }, 0)).toBe(2);
  });

  test("stay put when no other slot is on", () => {
    const onlySearch = { disabledSlots: [0, 2] };

    expect(nextEnabledSlot(onlySearch, 1)).toBe(1);
    expect(prevEnabledSlot(onlySearch, 1)).toBe(1);
  });
});
