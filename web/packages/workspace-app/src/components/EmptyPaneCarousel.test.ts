// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

// Static top-level import (not a per-test `await import(...)`).
// Resolving the Svelte component once at module-eval keeps the
// component transform + import latency out of every timed test body,
// which would otherwise contend across workers and time out (30s)
// under the full parallel suite. The carousel's 5000ms auto-rotate
// stays harmless: each nav assertion drives the slide synchronously
// and awaits a microtask `tick`, well under the 5s interval, and a
// default-slide assertion runs immediately after mount.
import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";

const mounted: Array<Record<string, any>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

async function renderCarousel(props: Record<string, any> = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(EmptyPaneCarousel, { target, props });
  mounted.push(component);
  await tick();
  return target;
}

describe("EmptyPaneCarousel", () => {
  test("renders the Workspace slide by default with three dots", async () => {
    // Slide 0 hosts WorkspaceInfoBody. Slide 1 is the indexing
    // (Search) graph; slide 2 is the About widget (version +
    // attributions + donation QR + project links).
    const target = await renderCarousel();

    expect(target.querySelectorAll(".dot-btn").length).toBe(3);
    expect(target.querySelector(".slide-workspace")).not.toBeNull();
    expect(target.querySelector(".slide-about")).toBeNull();
    expect(target.querySelector(".slide-indexing")).toBeNull();
    // Shortcuts / metadata slide bodies are not part of the
    // carousel.
    expect(target.querySelector(".slide-shortcuts")).toBeNull();
    expect(target.querySelector(".slide-metadata")).toBeNull();
    expect(target.querySelector(".shortcuts-table")).toBeNull();
    // Welcome chrome (logo + dashboard stats + spawn buttons) does
    // not render inside the carousel.
    expect(target.querySelector(".placeholder-mark")).toBeNull();
    expect(target.querySelector(".dashboard-stats")).toBeNull();
    expect(target.querySelector(".spawn-row")).toBeNull();
  });

  test("clicking a dot requests that slide via onSlideChange", async () => {
    // The carousel is controlled now: a dot click does not mutate
    // internal state, it asks the parent (DashboardTab ->
    // tab.carouselSlide) to move the shared cursor. The cursor is the
    // single source of truth so the flip-back slot picker stays in
    // sync, so the contract under test is the request, not a
    // self-driven re-render. The `slide` prop stays 0 here (no parent
    // feeding it back), so each request is computed from slide 0.
    const calls: number[] = [];
    const target = await renderCarousel({
      slide: 0,
      onSlideChange: (i: number) => calls.push(i),
    });

    const dots = [...target.querySelectorAll<HTMLButtonElement>(".dot-btn")];
    expect(dots.length).toBe(3);

    dots[1]?.click();
    dots[2]?.click();
    dots[0]?.click();
    expect(calls).toEqual([1, 2, 0]);
  });

  test("lets a right-click fall through to the pane around it", async () => {
    // The carousel is hosted inside DashboardTab and keeps no context menu
    // of its own; the pane's tab strip menu answers the right-click.
    const target = await renderCarousel();
    const outer = vi.fn();
    target.addEventListener("contextmenu", outer);

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.querySelector(".carousel")!.dispatchEvent(event);

    expect(outer).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });

  test("right and left arrow keys request prev/next via onSlideChange", async () => {
    // Mounted on slide 1 (Workspace) with a fixed `slide` prop, so
    // ArrowRight requests 2 and ArrowLeft requests 0, both relative to
    // the controlled cursor the parent owns.
    const calls: number[] = [];
    const target = await renderCarousel({
      slide: 1,
      onSlideChange: (i: number) => calls.push(i),
    });

    const carousel = target.querySelector<HTMLDivElement>(".carousel");
    expect(carousel).not.toBeNull();

    carousel?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    carousel?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(calls).toEqual([2, 0]);
  });
});
