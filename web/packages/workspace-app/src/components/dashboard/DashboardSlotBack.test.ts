// @vitest-environment jsdom
//
// The dashboard's back card configures one slot at a time and is titled after
// it. A navigator in the footer, beside OK, picks the slot the way the front
// carousel does: arrows step through Workspace, Search and About and wrap at
// the ends, a dot per slot picks it and marks the current one, and a toggle
// pauses or resumes the front's auto-rotate. Each choice is stored on the tab,
// so the front lands on the same slot, and the session is saved.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../state/store.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/store.svelte")>()),
  scheduleSessionSave: vi.fn(),
}));

import { api } from "../../api/client";
import { resetLayout } from "../../__tests__/tabs";
import { scheduleSessionSave } from "../../state/store.svelte";
import { layout, type DashboardTab, type LeafNode } from "../../state/tabs.svelte";
import DashboardSlotBack from "./DashboardSlotBack.svelte";

let view: Record<string, unknown> | null = null;
let target: HTMLElement;
let tab: DashboardTab;

beforeEach(() => {
  vi.spyOn(api, "config").mockResolvedValue({ revision: 1, preferences: {}, workspaces: [] } as never);
  resetLayout([{ kind: "dashboard", id: "dash", title: "Dashboard", carouselSlide: 1 }]);
  tab = (layout.nodes["pane-test"] as LeafNode).tabs[0] as DashboardTab;
  target = document.createElement("div");
  document.body.append(target);
  view = mount(DashboardSlotBack, { target, props: { tab } });
  flushSync();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function title(): string {
  return target.querySelector("h2")!.textContent!;
}

function dots(): Array<[string, boolean]> {
  return [...target.querySelectorAll<HTMLButtonElement>(".dot-btn")].map((dot) => [
    dot.getAttribute("aria-label")!,
    dot.getAttribute("aria-selected") === "true",
  ]);
}

function click(selector: string): void {
  target.querySelector<HTMLButtonElement>(selector)!.click();
  flushSync();
}

describe("the dashboard back's navigator", () => {
  test("titles the card after the current slot and marks its dot", () => {
    expect(title()).toBe("Search");
    expect(dots()).toEqual([
      ["Workspace", false],
      ["Search", true],
      ["About", false],
    ]);
  });

  test("steps through the slots with the arrows, wrapping at the ends, and saves each", () => {
    click('[aria-label="next slot"]');
    expect([title(), tab.carouselSlide]).toEqual(["About", 2]);
    click('[aria-label="next slot"]');
    expect([title(), tab.carouselSlide]).toEqual(["Workspace", 0]);
    click('[aria-label="previous slot"]');
    expect([title(), tab.carouselSlide]).toEqual(["About", 2]);

    expect(scheduleSessionSave).toHaveBeenCalledTimes(3);
  });

  test("picks a slot from its dot", () => {
    click('.dot-btn[aria-label="About"]');

    expect(tab.carouselSlide).toBe(2);
    expect(dots().find(([, current]) => current)).toEqual(["About", true]);
  });

  test("pauses and resumes the front's auto-rotate", () => {
    click('[aria-label="pause carousel auto-rotate"]');
    expect(tab.autoRotate).toBe(false);

    click('[aria-label="resume carousel auto-rotate"]');
    expect(tab.autoRotate).toBe(true);
  });

  test("sits in the footer beside OK, with no divider above it", () => {
    const footer = target.querySelector(".config-footer")!;

    expect(footer.querySelector(".carousel-nav")).not.toBeNull();
    expect(footer.querySelector(".config-ok")).not.toBeNull();
    expect(footer.classList.contains("bordered")).toBe(false);
  });
});
