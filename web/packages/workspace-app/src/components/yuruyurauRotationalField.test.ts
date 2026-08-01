// @vitest-environment jsdom

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";
import FourteenfoldBloom from "./FourteenfoldBloom.svelte";
import { yuruyurauRotationalRasterScale } from "./yuruyurauRotationalField";

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Yuruyurau rotational field", () => {
  test("rasterizes at pane resolution with a bounded memory ceiling", () => {
    expect(yuruyurauRotationalRasterScale(1_400, 900, 1)).toBe(3.5);
    expect(yuruyurauRotationalRasterScale(1_400, 900, 2)).toBe(4);
    expect(yuruyurauRotationalRasterScale(200, 200, 1)).toBe(1);
  });

  test("replays the captured trace and fades it behind the chan mark", async () => {
    const addColorStop = vi.fn();
    const createRadialGradient = vi.fn(() => ({ addColorStop }));
    const drawImage = vi.fn();
    const context = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      createRadialGradient,
      drawImage,
      fill: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: "",
      globalAlpha: 1,
      rect: vi.fn(),
      restore: vi.fn(),
      rotate: vi.fn(),
      save: vi.fn(),
      scale: vi.fn(),
      setTransform: vi.fn(),
      translate: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementationOnce(() => null)
      .mockReturnValue(context);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const target = document.createElement("div");
    document.body.append(target);
    mounted = mount(FourteenfoldBloom, { target });
    await tick();

    expect(drawImage).toHaveBeenCalledTimes(14);
    expect(createRadialGradient).toHaveBeenCalledWith(
      0.5,
      0.5,
      76,
      0.5,
      0.5,
      140,
    );
    expect(addColorStop).toHaveBeenNthCalledWith(
      1,
      0,
      "rgba(28, 28, 30, 0.96)",
    );
    expect(addColorStop).toHaveBeenLastCalledWith(
      1,
      "rgba(28, 28, 30, 0)",
    );
  });
});
