import { afterEach, expect, test, vi } from "vitest";
import { startAnimation, stopAnimations } from "../../workspace-app/src/__tests__/canvas";
import HomeAtmosphere from "./HomeAtmosphere.svelte";
import { buildHomeAtmosphereFrame } from "./homeAtmosphere";

vi.mock("../../workspace-app/src/components/canvasAnimation", async (importOriginal) =>
  (await import("../../workspace-app/src/__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("../../workspace-app/src/components/webglRenderer", () => ({
  pageWebglRenderer: () => ({ kind: "hardware", renderer: "test GPU" }),
}));
vi.mock("../../workspace-app/src/components/roundPoints", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../workspace-app/src/components/roundPoints")>()),
  createRoundPointRenderer: () => ({ draw: vi.fn(), destroy: vi.fn() }),
}));
vi.mock("./homeAtmosphere", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./homeAtmosphere")>();
  return { ...actual, buildHomeAtmosphereFrame: vi.fn(actual.buildHomeAtmosphereFrame) };
});

afterEach(() => {
  stopAnimations();
  document.querySelector("[data-home-morph-target]")?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("the morph follows the section after the tour expands, on reverse scroll and resize", () => {
  vi.stubGlobal("innerHeight", 1000);
  vi.stubGlobal("scrollY", 0);
  const section = document.createElement("section");
  section.setAttribute("data-home-morph-target", "");
  document.body.append(section);
  let sectionTop = 1000;
  vi.spyOn(section, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, sectionTop - window.scrollY, 1000, 400));

  const { callbacks } = startAnimation(HomeAtmosphere, {});
  callbacks.resize(1200, 1000, false, 0);

  function progressAt(scrollY: number): number {
    vi.stubGlobal("scrollY", scrollY);
    window.dispatchEvent(new Event("scroll"));
    callbacks.frame(0);
    return vi.mocked(buildHomeAtmosphereFrame).mock.calls.at(-1)![3];
  }

  expect(progressAt(0)).toBe(0);
  sectionTop = 6000;
  expect(progressAt(900)).toBe(0);
  expect(progressAt(5300)).toBe(0);
  expect(progressAt(5600)).toBe(0.5);
  expect(progressAt(5900)).toBe(1);
  expect(progressAt(900)).toBe(0);

  vi.stubGlobal("innerHeight", 500);
  window.dispatchEvent(new Event("resize"));
  expect(progressAt(5800)).toBe(0.5);
});
