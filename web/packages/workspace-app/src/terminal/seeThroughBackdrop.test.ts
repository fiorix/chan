import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SEE_THROUGH_MASK_VAR,
  backdropMask,
  installSeeThroughBackdrop,
  terminalHoles,
} from "./seeThroughBackdrop";

/// The SVG inside a mask's data URL.
function svgOf(mask: string): string {
  const match = /^url\("data:image\/svg\+xml,(.*)"\)$/.exec(mask);
  expect(match).not.toBeNull();
  return decodeURIComponent(match![1]);
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/// A backdrop at (10, 20) holding a terminal pane and an editor pane.
function buildBackdrop(): { backdrop: HTMLElement; terminalFace: HTMLElement; editorFace: HTMLElement } {
  const backdrop = document.createElement("main");
  backdrop.getBoundingClientRect = () => rect(10, 20, 800, 600);
  const terminalFace = document.createElement("div");
  terminalFace.className = "pane-card-face";
  terminalFace.style.borderTopLeftRadius = "6px";
  terminalFace.getBoundingClientRect = () => rect(15, 25, 390, 590);
  const tab = document.createElement("div");
  tab.className = "terminal-tab active";
  terminalFace.append(tab);
  const editorFace = document.createElement("div");
  editorFace.className = "pane-card-face";
  editorFace.getBoundingClientRect = () => rect(415, 25, 390, 590);
  const inactive = document.createElement("div");
  inactive.className = "terminal-tab";
  editorFace.append(inactive);
  backdrop.append(terminalFace, editorFace);
  document.body.append(backdrop);
  return { backdrop, terminalFace, editorFace };
}

describe("backdropMask", () => {
  it("is the full rectangle when there is no hole", () => {
    const svg = svgOf(backdropMask(800, 600, []));
    expect(svg).toContain('width="800" height="600"');
    expect(svg).toContain('preserveAspectRatio="none"');
    expect(svg).toContain('fill-rule="evenodd" d="M0 0H800V600H0Z"');
  });

  it("cuts a rounded hole out of the rectangle", () => {
    const svg = svgOf(backdropMask(800, 600, [{ x: 5, y: 5, width: 390, height: 590, radius: 6 }]));
    expect(svg).toContain(
      'd="M0 0H800V600H0Z' +
        "M11 5H389A6 6 0 0 1 395 11V589A6 6 0 0 1 389 595H11A6 6 0 0 1 5 589V11A6 6 0 0 1 11 5Z" +
        '"',
    );
  });

  it("cuts a square hole when the radius is zero", () => {
    const svg = svgOf(backdropMask(100, 100, [{ x: 10, y: 10, width: 20, height: 20, radius: 0 }]));
    expect(svg).toContain('d="M0 0H100V100H0ZM10 10H30V30H10Z"');
  });

  it("caps the radius at half the hole's shorter side", () => {
    const svg = svgOf(backdropMask(100, 100, [{ x: 0, y: 0, width: 20, height: 10, radius: 50 }]));
    expect(svg).toContain("A5 5 0 0 1");
  });

  it("is identical for an identical layout", () => {
    const hole = { x: 1.04, y: 2.96, width: 50.01, height: 60, radius: 6 };
    expect(backdropMask(800.02, 600, [hole])).toBe(backdropMask(800.04, 600, [{ ...hole }]));
  });
});

describe("terminalHoles", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("returns one hole per pane face showing a terminal, relative to the backdrop", () => {
    const { backdrop } = buildBackdrop();
    expect(terminalHoles(backdrop)).toEqual([{ x: 5, y: 5, width: 390, height: 590, radius: 6 }]);
  });

  it("skips a face with no size", () => {
    const { backdrop, terminalFace } = buildBackdrop();
    terminalFace.getBoundingClientRect = () => rect(0, 0, 0, 0);
    expect(terminalHoles(backdrop)).toEqual([]);
  });
});

describe("installSeeThroughBackdrop", () => {
  const observed: Element[] = [];

  beforeEach(() => {
    observed.length = 0;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(target: Element) {
          observed.push(target);
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("masks the backdrop at once and observes it and every pane face", () => {
    const { backdrop, terminalFace, editorFace } = buildBackdrop();
    const cleanup = installSeeThroughBackdrop(backdrop);
    const mask = backdrop.style.getPropertyValue(SEE_THROUGH_MASK_VAR);
    expect(svgOf(mask)).toContain("M11 5H389");
    expect(observed).toEqual([backdrop, terminalFace, editorFace]);
    cleanup();
    expect(backdrop.style.getPropertyValue(SEE_THROUGH_MASK_VAR)).toBe("");
  });

  it("opens a hole when a pane switches to a terminal tab", async () => {
    const { backdrop, editorFace } = buildBackdrop();
    const cleanup = installSeeThroughBackdrop(backdrop);
    expect(svgOf(backdrop.style.getPropertyValue(SEE_THROUGH_MASK_VAR))).not.toContain("M415");
    editorFace.querySelector(".terminal-tab")!.classList.add("active");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(svgOf(backdrop.style.getPropertyValue(SEE_THROUGH_MASK_VAR))).toContain("M405 5H");
    cleanup();
  });

  it("ignores changes inside a terminal's renderer", async () => {
    const { backdrop, terminalFace } = buildBackdrop();
    const host = document.createElement("div");
    host.className = "terminal-host";
    terminalFace.querySelector(".terminal-tab")!.append(host);
    const cleanup = installSeeThroughBackdrop(backdrop);
    const before = backdrop.style.getPropertyValue(SEE_THROUGH_MASK_VAR);
    terminalFace.getBoundingClientRect = () => rect(15, 25, 100, 100);
    host.append(document.createElement("span"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(backdrop.style.getPropertyValue(SEE_THROUGH_MASK_VAR)).toBe(before);
    cleanup();
  });
});
