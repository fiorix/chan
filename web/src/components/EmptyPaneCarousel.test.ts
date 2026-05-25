// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test } from "vitest";

const mounted: Array<Record<string, any>> = [];

afterEach(() => {
  for (const component of mounted.splice(0)) unmount(component);
  document.body.innerHTML = "";
});

async function renderCarousel(props: { oncontextmenu?: (e: MouseEvent) => void } = {}) {
  const target = document.createElement("div");
  document.body.append(target);
  const { default: EmptyPaneCarousel } = await import("./EmptyPaneCarousel.svelte");
  const component = mount(EmptyPaneCarousel, { target, props });
  mounted.push(component);
  await tick();
  return target;
}

describe("EmptyPaneCarousel", () => {
  test("renders the Shortcuts slide by default with three dots", async () => {
    // `fullstack-a-75b`: slide 1 is now Shortcuts (the ASCII
    // table). The welcome slide moved to
    // EmptyPaneWelcome.svelte as the new placeholder surface.
    const target = await renderCarousel();

    expect(target.querySelectorAll(".dot-btn").length).toBe(3);
    expect(target.querySelector(".slide-shortcuts")).not.toBeNull();
    expect(target.querySelector(".shortcuts-table")).not.toBeNull();
    expect(target.querySelector(".slide-metadata")).toBeNull();
    expect(target.querySelector(".slide-indexing")).toBeNull();
    // Welcome chrome (logo + dashboard stats + spawn buttons)
    // no longer renders inside the carousel.
    expect(target.querySelector(".placeholder-mark")).toBeNull();
    expect(target.querySelector(".dashboard-stats")).toBeNull();
    expect(target.querySelector(".spawn-row")).toBeNull();
  });

  test("clicking a dot navigates to that slide", async () => {
    const target = await renderCarousel();

    const dots = [...target.querySelectorAll<HTMLButtonElement>(".dot-btn")];
    expect(dots.length).toBe(3);

    dots[1]?.click();
    await tick();
    expect(target.querySelector(".slide-metadata")).not.toBeNull();
    expect(target.querySelector(".slide-shortcuts")).toBeNull();

    dots[2]?.click();
    await tick();
    expect(target.querySelector(".slide-indexing")).not.toBeNull();

    dots[0]?.click();
    await tick();
    expect(target.querySelector(".slide-shortcuts")).not.toBeNull();
  });

  test("forwards right-click to the parent contextmenu handler", async () => {
    let received: MouseEvent | null = null;
    const target = await renderCarousel({
      oncontextmenu: (e) => {
        received = e;
        e.preventDefault();
      },
    });

    target.querySelector(".carousel")?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 30,
        clientY: 30,
      }),
    );
    await tick();

    expect(received).not.toBeNull();
  });

  test("right and left arrow keys nudge the active slide", async () => {
    const target = await renderCarousel();

    const carousel = target.querySelector<HTMLDivElement>(".carousel");
    expect(carousel).not.toBeNull();

    carousel?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();
    expect(target.querySelector(".slide-metadata")).not.toBeNull();

    carousel?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    await tick();
    expect(target.querySelector(".slide-shortcuts")).not.toBeNull();
  });

  // `fullstack-85`: the carousel's own `:focus-visible` inset ring
  // was painting on top of `.pane.focused`'s inset ring, making the
  // empty-pane body look like it had a thicker border than the top
  // bar. Source-grep sentinel: the rule must be gone.
  test("does not paint its own inset focus ring (fullstack-85)", async () => {
    const raw = (await import("./EmptyPaneCarousel.svelte?raw"))
      .default as string;
    expect(raw).not.toMatch(
      /\.carousel:focus-visible\s*\{[\s\S]*?inset 0 0 0 2px/,
    );
  });
});
