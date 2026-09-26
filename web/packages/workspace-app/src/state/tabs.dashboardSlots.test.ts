// @vitest-environment jsdom
//
// The Dashboard carousel's slot table, read directly. It names the slots in
// display order, Workspace, Search and About, the slot count follows it, and
// the Search slide the indexing pill opens on is the slot labelled Search.

import { describe, expect, test } from "vitest";
import {
  DASHBOARD_SEARCH_SLIDE,
  DASHBOARD_SLOT_COUNT,
  DASHBOARD_SLOT_LABELS,
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
