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
  test("flashes and persists the selected catalog name", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(EmptyPaneWelcome, {
      target,
      props: { animation: "sixfold-vortex" },
    });
    await tick();

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: ">",
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
