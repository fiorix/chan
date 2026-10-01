// @vitest-environment jsdom
//
// The media viewers' overlay, opened with a probe surface: what it mounts,
// the key and the clicks that dismiss it and the ones that travel on, and the
// order its dismissal runs in.

import { afterEach, describe, expect, test, vi } from "vitest";

import { openViewerOverlay, type ViewerOverlayOptions } from "./viewerOverlay";
import { pressInPage } from "../__tests__/keys";

function overlay(): HTMLElement | null {
  return document.querySelector(".probe-viewer");
}

function open(options: Partial<ViewerOverlayOptions> = {}): HTMLElement {
  const surface = document.createElement("div");
  surface.className = "probe-surface";
  openViewerOverlay({ className: "probe-viewer", layout: "display:flex;gap:2px;", surface: [surface], ...options });
  return surface;
}

function closeButton(): HTMLButtonElement {
  return overlay()!.querySelector("button")!;
}

// Click `target` and say whether the click bubbled up to the document.
function click(target: HTMLElement): boolean {
  const seen = vi.fn();
  document.addEventListener("click", seen);
  target.click();
  document.removeEventListener("click", seen);
  return seen.mock.calls.length > 0;
}

afterEach(() => {
  if (overlay()) pressInPage({ key: "Escape" });
  document.body.innerHTML = "";
});

describe("the viewer overlay", () => {
  test("mounts on the body: the caller's class and layout, the surface, then Close", () => {
    const first = document.createElement("div");
    const second = document.createElement("p");
    open({ surface: [first, second] });

    const backdrop = overlay()!;
    expect(backdrop.parentElement).toBe(document.body);
    expect(backdrop.style.position).toBe("fixed");
    expect(backdrop.style.display).toBe("flex");
    expect(backdrop.style.gap).toBe("2px");
    expect([...backdrop.children]).toEqual([first, second, closeButton()]);
    expect(closeButton().textContent).toBe("Close");
    expect(closeButton().title).toBe("Close (Esc)");
  });

  test("an unmodified Escape dismisses and goes no further", () => {
    open();

    const { event, reachedDocument } = pressInPage({ key: "Escape" });

    expect(overlay()).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
  });

  test.each([{ ctrlKey: true }, { metaKey: true }, { altKey: true }])(
    "Escape with %j held travels on and leaves the overlay open",
    (modifier) => {
      open();

      const { event, reachedDocument } = pressInPage({ key: "Escape", ...modifier });

      expect(overlay(), "a modified Escape travels on").not.toBeNull();
      expect(event.defaultPrevented).toBe(false);
      expect(reachedDocument).toBe(true);
    },
  );

  test("a key that is not Escape travels on and leaves the overlay open", () => {
    open();

    const { event, reachedDocument } = pressInPage({ key: "ArrowDown" });

    expect(overlay()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
  });

  test("Close dismisses and its click stays in the overlay", () => {
    open();

    const reachedDocument = click(closeButton());

    expect(overlay()).toBeNull();
    expect(reachedDocument).toBe(false);
  });

  test("with the backdrop option, a click on the backdrop dismisses and one on the surface does not", () => {
    const surface = open({ dismissOnBackdropClick: true });

    click(surface);
    expect(overlay()).not.toBeNull();

    click(overlay()!);
    expect(overlay()).toBeNull();
  });

  test("without the backdrop option, no click but Close dismisses", () => {
    const surface = open();

    click(surface);
    click(overlay()!);

    expect(overlay()).not.toBeNull();
  });

  test("the teardown runs once, before the backdrop leaves the page", () => {
    const mountedAtTeardown: boolean[] = [];
    open({ teardown: () => mountedAtTeardown.push(overlay() !== null) });

    pressInPage({ key: "Escape" });

    expect(mountedAtTeardown).toEqual([true]);
    expect(overlay()).toBeNull();
  });

  test("after dismissal an Escape is no longer answered", () => {
    const teardown = vi.fn();
    open({ teardown });
    click(closeButton());
    expect(teardown).toHaveBeenCalledTimes(1);

    const { event, reachedDocument } = pressInPage({ key: "Escape" });

    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
