// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import EmptyPaneWelcome from "./EmptyPaneWelcome.svelte";

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("EmptyPaneWelcome animation names", () => {
  test("handles animation keys only on its focused empty-pane surface", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(EmptyPaneWelcome, {
      target,
      props: { animation: "sixfold-vortex" },
    });
    await tick();

    const welcome = target.querySelector<HTMLElement>(".welcome");
    expect(welcome).not.toBeNull();
    expect(document.activeElement).toBe(welcome);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        cancelable: true,
      }),
    );
    await tick();
    expect(target.querySelector(".animation-name-flash")).toBeNull();
    expect(window.sessionStorage.getItem("chan.empty-pane-animation")).toBeNull();

    welcome?.focus();
    const appShortcut = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    welcome?.dispatchEvent(appShortcut);
    expect(appShortcut.defaultPrevented).toBe(false);

    const markBeforeSwitch = target.querySelector(".welcome-mark");
    expect(markBeforeSwitch).not.toBeNull();
    welcome?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    const flash = target.querySelector<HTMLElement>(
      ".animation-name-flash",
    );
    expect(flash?.textContent?.trim()).toBe("Radial Ribbons");
    expect(window.sessionStorage.getItem("chan.empty-pane-animation")).toBe(
      "radial-ribbons",
    );
    const markAfterSwitch = target.querySelector(".welcome-mark");
    expect(markAfterSwitch).not.toBeNull();
    expect(markAfterSwitch).not.toBe(markBeforeSwitch);

    welcome?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();
    expect(
      target
        .querySelector<HTMLElement>(".animation-name-flash")
        ?.textContent?.trim(),
    ).toBe("Speed 1.4x");
    expect(welcome?.getAttribute("style")).toContain(
      "--canvas-animation-speed: 1.4",
    );
    expect(window.sessionStorage.getItem("chan.empty-pane-animation")).toBe(
      "radial-ribbons",
    );

    const end = new Event("animationend") as AnimationEvent;
    Object.defineProperty(end, "animationName", {
      configurable: true,
      value: "svelte-test-empty-pane-animation-name-flash",
    });
    flash?.dispatchEvent(end);
    await tick();

    expect(target.querySelector(".animation-name-flash")).toBeNull();
  });
});
