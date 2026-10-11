import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import AnimationGallery from "./AnimationGallery.svelte";

vi.mock("../../workspace-app/src/components/canvasAnimation", async (importOriginal) =>
  (await import("../../workspace-app/src/__tests__/canvas")).recordedRunners(await importOriginal()),
);
vi.mock("../../workspace-app/src/components/webglRenderer", () => ({
  pageWebglRenderer: vi.fn(() => ({ kind: "hardware", renderer: "test GPU" })),
}));
import { pageWebglRenderer } from "../../workspace-app/src/components/webglRenderer";

let gallery: { preview(id: string): void };
let target: HTMLDivElement;

beforeEach(() => {
  window.history.replaceState(null, "", "/animations/");
  target = document.createElement("div");
  document.body.append(target);
  vi.mocked(pageWebglRenderer).mockReturnValue({ kind: "hardware", renderer: "test GPU" });
});

afterEach(async () => {
  if (gallery) await unmount(gallery);
  target.remove();
  window.sessionStorage.clear();
});

function start(): void {
  gallery = mount(AnimationGallery, { target });
  flushSync();
}

function click(label: string): void {
  const button = [...target.querySelectorAll("button")].find((entry) => entry.textContent === label);
  expect(button, label).toBeDefined();
  button!.click();
  flushSync();
}

test("motion starts on request and stopping removes the active animation", () => {
  start();
  expect(target.querySelector("canvas")).toBeNull();
  click("Play animation");
  const canvas = target.querySelector("canvas")!;
  expect(canvas.parentElement?.className).toContain("radial-ribbons");
  click("Next");
  expect(canvas.isConnected).toBe(false);
  expect(target.querySelectorAll("canvas")).toHaveLength(1);
  expect(target.querySelector("canvas")?.parentElement?.className).toContain("polar-drift");
  click("Stop preview");
  expect(target.querySelector("canvas")).toBeNull();
});

test("a deep link opens the requested animation with its references", () => {
  window.history.replaceState(null, "", "/animations/?a=segmented-torus#preview");
  start();
  expect(target.querySelector("h2")?.textContent).toBe("Segmented Torus");
  expect(target.querySelectorAll(".reference-links a")).toHaveLength(2);
  expect(target.querySelector("canvas")?.parentElement?.className).toContain("segmented-torus");
  expect(window.location.search).toBe("?a=segmented-torus");
});

test("invalid deep links keep the default preview idle", () => {
  window.history.replaceState(null, "", "/animations/?a=missing");
  start();
  expect(target.querySelector("h2")?.textContent).toBe("Radial Ribbons");
  expect(target.querySelector("canvas")).toBeNull();
});

test("selection and the welcome's keys update the caption, credit, and share URL", async () => {
  start();
  gallery.preview("mutual-force-starburst");
  flushSync();
  expect(target.querySelectorAll(".reference-links a")).toHaveLength(2);
  const welcome = target.querySelector<HTMLElement>('[aria-label="welcome"]')!;
  welcome.focus();
  welcome.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await Promise.resolve();
  flushSync();
  expect(target.querySelector("h2")?.textContent).toBe("Recursive Arc Bloom");
  expect(target.querySelector(".reference-links a")?.getAttribute("href")).toBe("https://x.com/Hau_kun/status/1931711978235683306");
  expect(window.location.search).toBe("?a=recursive-arc-bloom");
});

test("unavailable WebGL leaves the credit readable and a canvas animation can still run", () => {
  vi.mocked(pageWebglRenderer).mockReturnValue({ kind: "none", renderer: null });
  start();
  gallery.preview("sixfold-vortex");
  flushSync();
  expect(target.querySelector('[role="status"]')?.textContent).toContain("unavailable");
  expect(target.querySelector("canvas")).toBeNull();
  expect(target.querySelector(".reference-links a")?.getAttribute("href")).toBe("https://x.com/hisadan/status/1974838123864756613");
  gallery.preview("dotted-waves");
  flushSync();
  expect(target.querySelector("canvas")).not.toBeNull();
  expect(target.querySelector('[role="status"]')).toBeNull();
});

test("changing the preview theme keeps the page theme and selected animation", () => {
  document.body.dataset.mode = "light";
  start();
  gallery.preview("radial-ribbons");
  flushSync();
  const select = target.querySelectorAll("select")[1];
  select.value = "light";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flushSync();
  expect(target.querySelector(".gallery-stage")?.getAttribute("data-theme")).toBe("light");
  expect(document.body.dataset.mode).toBe("light");
  expect(target.querySelector("h2")?.textContent).toBe("Radial Ribbons");
  expect(target.querySelectorAll("canvas")).toHaveLength(1);
});
