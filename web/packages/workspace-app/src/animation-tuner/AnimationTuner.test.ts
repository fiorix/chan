import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import AnimationTuner from "./AnimationTuner.svelte";

vi.mock("../components/canvasAnimation", async (importOriginal) =>
  (await import("../__tests__/canvas")).recordedRunners(await importOriginal()),
);

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-theme");
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

test("a token slider overrides the token on the element the shown animation reads it from", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.history.replaceState(null, "", "?a=amber-recursion&theme=light");
  const target = document.createElement("div");
  document.body.append(target);
  mounted = mount(AnimationTuner, { target });
  flushSync();

  const shownHost = (): HTMLElement =>
    target.querySelector<HTMLCanvasElement>(".stage canvas")!.parentElement!;
  const control = <E extends HTMLElement>(name: string): E =>
    target.querySelector<E>(`[name="${name}"]`)!;
  const show = (id: string): void => {
    const select = control<HTMLSelectElement>("animation");
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
  };

  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  const host = shownHost();
  expect(host.className).toContain("amber-recursion");

  const slider = control<HTMLInputElement>("--amber-recursion-tone");
  slider.value = "0.5";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
  expect(host.style.getPropertyValue("--amber-recursion-tone")).toBe("0.5");

  // The override belongs to the theme it was dialled in.
  control<HTMLButtonElement>("theme").click();
  flushSync();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(host.style.getPropertyValue("--amber-recursion-tone")).toBe("");
  control<HTMLButtonElement>("theme").click();
  flushSync();
  expect(host.style.getPropertyValue("--amber-recursion-tone")).toBe("0.5");

  // A switch away and back mounts the animation on a new element.
  show("turbulent-oculus");
  expect(shownHost().className).toContain("turbulent-oculus");
  show("amber-recursion");
  expect(shownHost()).not.toBe(host);
  expect(shownHost().style.getPropertyValue("--amber-recursion-tone")).toBe("0.5");
});
