import { readFileSync } from "node:fs";
import { Terminal } from "@chan/ghostty-web-ng";
import { GhosttyVt } from "@chan/ghostty-web-ng/vt";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  gateGhosttyScrollbarClicks,
  xtermCellDimensionsFromMeasurement,
} from "./ghosttyCompat";

const VENDORED = "../ghostty-web-ng/vendor/ghostty-vt/ghostty-vt.wasm";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Ghostty xterm-compatible font metrics", () => {
  test("uses xterm's device-pixel rounding and line height", () => {
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8.43, height: 16 },
        1,
        1.2,
      ),
    ).toEqual({ width: 8, height: 19 });
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8.43, height: 16 },
        2,
        1.2,
      ),
    ).toEqual({ width: 8, height: 19 });
  });

  test("rejects unsettled or invalid measurements", () => {
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 0, height: 16 },
        1,
        1.2,
      ),
    ).toBeNull();
    expect(
      xtermCellDimensionsFromMeasurement(
        { width: 8, height: 16 },
        0,
        1.2,
      ),
    ).toBeNull();
  });
});

describe("Ghostty overlay scrollbar clicks", () => {
  function ghosttyMouseSource() {
    const host = document.createElement("div");
    const claimStrip = vi.fn();
    // Mirrors the pinned build: handlePointerDown is an own bound field and
    // open() registers it on the host in the capture phase.
    const terminal = { handlePointerDown: claimStrip, scrollbarOpacity: 0 };
    host.addEventListener("pointerdown", terminal.handlePointerDown, true);
    return { claimStrip, host, terminal };
  }

  test("the pinned build still exposes the state the gate binds to", async () => {
    // The terminal a ghostty tab constructs: the widget over chan's binding
    // on its own instance of the vendored core, as backend.ts's kit hands it.
    const module = await WebAssembly.compile(readFileSync(VENDORED));
    const terminal = new Terminal({
      ghostty: new GhosttyVt(await WebAssembly.instantiate(module, {})),
    }) as unknown as {
      handlePointerDown?: unknown;
    };

    expect(typeof terminal.handlePointerDown).toBe("function");
    expect(
      Object.prototype.hasOwnProperty.call(terminal, "scrollbarOpacity"),
    ).toBe(true);
  });

  test("an invisible overlay does not claim clicks on the content", () => {
    const { claimStrip, host, terminal } = ghosttyMouseSource();

    expect(gateGhosttyScrollbarClicks(terminal, host)).not.toBeNull();
    host.dispatchEvent(new PointerEvent("pointerdown"));

    expect(claimStrip).not.toHaveBeenCalled();
  });

  test("a visible overlay claims them exactly once", () => {
    const { claimStrip, host, terminal } = ghosttyMouseSource();
    const dispose = gateGhosttyScrollbarClicks(terminal, host);

    terminal.scrollbarOpacity = 0.5;
    host.dispatchEvent(new PointerEvent("pointerdown"));
    // Upstream's own listener has to be gone, not merely shadowed: a second
    // live claimant would scroll-jump the clicks this gate exists to release.
    expect(claimStrip).toHaveBeenCalledTimes(1);

    dispose?.();
    host.dispatchEvent(new PointerEvent("pointerdown"));
    expect(claimStrip).toHaveBeenCalledTimes(1);
  });

  test("leaves upstream alone if the pinned build stops exposing its state", () => {
    const { claimStrip, host } = ghosttyMouseSource();
    const terminal = { handlePointerDown: claimStrip };

    expect(gateGhosttyScrollbarClicks(terminal, host)).toBeNull();
    host.dispatchEvent(new PointerEvent("pointerdown"));
    expect(claimStrip).toHaveBeenCalledTimes(1);
  });
});
