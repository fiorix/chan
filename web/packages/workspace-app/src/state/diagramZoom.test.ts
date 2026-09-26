// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import { openDiagramZoom } from "./diagramZoom";
import { pressInPage } from "../__tests__/keys";

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';

function backdrop(): HTMLElement | null {
  return document.querySelector(".md-diagram-zoom");
}
function layer(): HTMLElement | null {
  return document.querySelector(".md-diagram-zoom-layer");
}
function panel(): HTMLElement | null {
  return document.querySelector(".md-diagram-zoom-panel");
}

afterEach(() => {
  document.querySelectorAll(".md-diagram-zoom").forEach((e) => e.remove());
});

describe("openDiagramZoom", () => {
  test("mounts a backdrop with the SVG and three zoom controls", () => {
    openDiagramZoom(SVG);
    const bd = backdrop()!;
    expect(bd).toBeTruthy();
    expect(layer()?.querySelector("svg")).toBeTruthy();
    expect(bd.querySelectorAll(".md-diagram-zoom-btn").length).toBe(3);
  });

  test("backs the SVG with a light panel surface inside the layer", () => {
    openDiagramZoom(SVG);
    const p = panel();
    expect(p).toBeTruthy();
    // The light panel holds the SVG so a light-themed diagram reads against
    // it instead of vanishing on the dark backdrop.
    expect(p?.querySelector("svg")).toBeTruthy();
    expect(layer()?.contains(p!)).toBe(true);
    expect(p?.style.background).toBeTruthy();
  });

  test("gives a percentage-width (mermaid) svg an intrinsic width from its viewBox", () => {
    // mermaid emits width="100%" and no height, so `width:auto` would
    // collapse it to 0x0 in the shrink-to-fit panel (the diagram vanished).
    // The viewBox width becomes an explicit pixel width so it renders.
    openDiagramZoom(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 320 240"><rect width="10" height="10"/></svg>',
    );
    const svg = layer()?.querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.style.width).toBe("320px");
    expect(svg?.style.height).toBe("auto");
  });

  test("leaves a viewBox-less svg on auto sizing", () => {
    // SVG carries pixel width/height of its own; no viewBox to derive from,
    // so fall through to auto rather than forcing a bogus width.
    openDiagramZoom(SVG);
    const svg = layer()?.querySelector("svg");
    expect(svg?.style.width).toBe("auto");
  });

  test("no-ops on an empty svg", () => {
    openDiagramZoom("");
    expect(backdrop()).toBeNull();
  });

  test("Escape dismisses and unhooks the document keydown", () => {
    openDiagramZoom(SVG);
    expect(backdrop()).toBeTruthy();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(backdrop()).toBeNull();
  });

  test("a plain backdrop click dismisses", () => {
    openDiagramZoom(SVG);
    backdrop()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(backdrop()).toBeNull();
  });

  test("+ zooms by resizing the SVG, arrows pan the layer, 0 resets both", () => {
    // Zoom must resize the SVG (so the vector re-rasterizes crisply), NOT
    // fold a scale() into the layer transform (which stretched a cached
    // texture and blurred). Pan stays a layer translate.
    openDiagramZoom(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 320 240"><rect width="10" height="10"/></svg>',
    );
    const svg = layer()!.querySelector("svg")!;
    const restTransform = layer()!.style.transform;
    expect(svg.style.width).toBe("320px"); // base fit width (viewBox fallback)

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "+" }));
    expect(parseFloat(svg.style.width)).toBeCloseTo(320 * 1.2, 5);
    expect(layer()!.style.transform).not.toContain("scale");
    expect(layer()!.style.transform).toBe(restTransform); // zoom does not pan

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(layer()!.style.transform).toContain("-48px"); // pan translates layer
    expect(svg.style.width).toBe("384px"); // pan leaves the zoom size put

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "0" }));
    expect(svg.style.width).toBe("320px"); // reset returns to the base size
    expect(layer()!.style.transform).toBe(restTransform);
  });

  test("four wheel notches equal one button zoom step", () => {
    openDiagramZoom(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 320 240"><rect width="10" height="10"/></svg>',
    );
    const svg = layer()!.querySelector("svg")!;
    // Wheel zoom is deliberately four times gentler than the 1.2x
    // button/key step. With the pointer at the origin there is no pan
    // drift, so four notches read as one full step off the width alone.
    for (let i = 0; i < 4; i++) {
      backdrop()!.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, cancelable: true }),
      );
    }
    expect(parseFloat(svg.style.width)).toBeCloseTo(320 * 1.2, 5);
  });

  test("captures its shortcuts so they do not leak to the editor", () => {
    openDiagramZoom(SVG);
    const ev = new KeyboardEvent("keydown", { key: "0", cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe("keys in the diagram viewer", () => {
  test.each(["Escape", "+", "=", "-", "0", "ArrowLeft", "a", "ArrowRight", "d", "ArrowUp", "w", "ArrowDown", "s"])(
    "%s acts in the viewer and goes no further",
    (key) => {
      openDiagramZoom(SVG);

      const { event, reachedDocument } = pressInPage({ key });

      expect(event.defaultPrevented).toBe(true);
      expect(reachedDocument).toBe(false);
      if (backdrop()) pressInPage({ key: "Escape" });
    },
  );

  test("Escape closes the viewer", () => {
    openDiagramZoom(SVG);

    pressInPage({ key: "Escape" });

    expect(backdrop()).toBeNull();
  });

  test("a key the viewer does not answer travels on", () => {
    openDiagramZoom(SVG);

    const { event, reachedDocument } = pressInPage({ key: "x" });

    expect(backdrop()).not.toBeNull();
    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
    pressInPage({ key: "Escape" });
  });

  test.each([
    ["Ctrl+Alt+S", { key: "s", code: "KeyS", ctrlKey: true, altKey: true }],
    ["Cmd+=", { key: "=", code: "Equal", metaKey: true }],
    ["Alt+ArrowLeft", { key: "ArrowLeft", code: "ArrowLeft", altKey: true }],
    ["Ctrl+0", { key: "0", code: "Digit0", ctrlKey: true }],
  ])("%s, a modified chord on a viewer key, travels on", (_name, init) => {
    openDiagramZoom(SVG);
    const before = layer()?.getAttribute("style");

    const { event, reachedDocument } = pressInPage(init);

    expect(event.defaultPrevented).toBe(false);
    expect(reachedDocument).toBe(true);
    expect(layer()?.getAttribute("style")).toBe(before);
    pressInPage({ key: "Escape" });
  });

  test("Shift+W, the viewer's own Shift, still pans", () => {
    openDiagramZoom(SVG);

    const { event, reachedDocument } = pressInPage({ key: "W", code: "KeyW", shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(reachedDocument).toBe(false);
    pressInPage({ key: "Escape" });
  });
});
