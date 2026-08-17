import { afterEach, describe, expect, it } from "vitest";

import { GEOMETRY_KEY_PREFIX, windowManagerLeftOffset } from "./hybrid-core.mjs";
import { createWinboxWm } from "./wm-winbox.mjs";

const originalDocument = globalThis.document;

afterEach(() => {
  globalThis.document = originalDocument;
});

function harness({ saved = null } = {}) {
  const root = {
    classList: { contains: () => false },
    querySelector: () => null,
  };
  globalThis.document = {
    documentElement: { clientWidth: 1200, clientHeight: 800 },
    createElement: () => ({
      className: "",
      src: "",
      setAttribute() {},
      addEventListener() {},
      closest: () => root,
    }),
  };

  class FakeWinBox {
    constructor(opts) {
      this.x = opts.x;
      this.y = opts.y;
      this.width = opts.width;
      this.height = opts.height;
      this.top = opts.top;
      this.left = opts.left;
      this.window = root;
    }

    move(x, y) {
      this.x = x;
      this.y = y;
    }

    focus() {}
    hide() {}
    show() {}
    close() {}
    setTitle() {}
    restore() {}
    maximize() {}
  }

  let collapse = "none";
  let dockWidth = 420;
  const normalDockWidth = 420;
  const storage = {
    getItem: (key) =>
      saved && key === `${GEOMETRY_KEY_PREFIX}w-1` ? JSON.stringify(saved) : null,
    setItem() {},
  };
  const wm = createWinboxWm({
    winbox: FakeWinBox,
    storage,
    offsets: () => ({
      top: 0,
      left: windowManagerLeftOffset(collapse, dockWidth, normalDockWidth),
    }),
  });
  const frame = wm.createFrame({
    id: "w-1",
    url: "/workspace/?w=w-1",
    title: "Window 1",
    kind: "workspace",
  });
  return {
    frame,
    wm,
    setCollapse(next, nextDockWidth) {
      collapse = next;
      dockWidth = nextDockWidth;
    },
  };
}

describe("WinBox collapse geometry", () => {
  it("preserves a frame across launcher expand and restore", () => {
    const { frame, wm, setCollapse } = harness();
    const original = { x: frame.wb.x, y: frame.wb.y };

    setCollapse("desktop", 1200);
    wm.applyOffsets();
    expect({ x: frame.wb.x, y: frame.wb.y }).toEqual(original);

    setCollapse("none", 420);
    wm.applyOffsets();
    expect({ x: frame.wb.x, y: frame.wb.y }).toEqual(original);
  });

  it("recovers geometry persisted beyond the viewport", () => {
    const { frame } = harness({
      saved: { x: 1200, y: 600, width: 560, height: 500, max: false },
    });
    expect({ x: frame.wb.x, y: frame.wb.y }).toEqual({ x: 640, y: 300 });
  });
});
