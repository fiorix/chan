import { flushSync, mount, unmount } from "svelte";
import { afterEach, expect, test, vi } from "vitest";
import { reportingWebgl2 } from "../__tests__/canvas";
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
  vi.useRealTimers();
});

test("the stage starts in the first render, with no start delay", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  window.history.replaceState(null, "", "?a=radial-ribbons");
  const target = document.createElement("div");
  document.body.append(target);
  mounted = mount(AnimationTuner, { target });
  flushSync();

  expect(
    target.querySelector(".stage canvas"),
    "stage canvas in the first render",
  ).not.toBeNull();
  expect(vi.getTimerCount(), "timers set by the tuner's stage").toBe(0);
});

test.each([
  [
    "a hardware renderer",
    "ANGLE (AMD, AMD Radeon 780M Graphics (radeonsi, phoenix, LLVM 20.1.8, DRM 3.64), OpenGL ES 3.2)",
    "every animation",
  ],
  [
    "a software renderer",
    "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
    "2D-canvas animations only",
  ],
])("the readouts say what the welcome draws on %s", async (_name, renderer, draws) => {
  // The page's renderer is read once and kept, so each reading gets a new
  // page: the modules are loaded again, Svelte with them.
  vi.resetModules();
  const svelte = await import("svelte");
  const Tuner = (await import("./AnimationTuner.svelte")).default;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
    kind: string,
  ) => (kind === "webgl2" ? reportingWebgl2(renderer) : null)) as never);
  window.history.replaceState(null, "", "?a=radial-ribbons");
  const target = document.createElement("div");
  document.body.append(target);
  const tuner = svelte.mount(Tuner, { target });
  svelte.flushSync();

  const label = [...target.querySelectorAll("dt")].find(
    (term) => term.textContent === "Welcome draws",
  );
  expect(label?.nextElementSibling?.textContent, "Welcome draws").toBe(draws);
  svelte.unmount(tuner);
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
