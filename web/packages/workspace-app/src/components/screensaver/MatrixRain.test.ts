// @vitest-environment jsdom
//
// The Matrix rain screensaver, its falling-column engine, and the config
// panel's preview of it. Both surfaces draw through the one engine in
// matrixRain.ts, so what the engine paints is what either shows.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import MatrixRain from "./MatrixRain.svelte";
import MatrixRainPreview from "./MatrixRainPreview.svelte";
import {
  createRainColumns,
  drawStaticMatrix,
  stepRain,
  type RainColumn,
} from "./matrixRain";
import { recordingContext2d, type CanvasOp } from "../../__tests__/canvas";

const mounted: Array<() => void> = [];
let reducedMotion = false;
let intersect: ((entries: Array<{ isIntersecting: boolean }>) => void) | null = null;
const fontsLoad = vi.fn(async () => []);

beforeEach(() => {
  reducedMotion = false;
  intersect = null;
  fontsLoad.mockClear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reducedMotion && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: typeof intersect) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { load: fontsLoad },
  });
});

afterEach(() => {
  for (const stop of mounted.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/// Mount `component` over a recording context.
function render(
  component: typeof MatrixRain | typeof MatrixRainPreview,
): { ops: CanvasOp[] } {
  const { ctx, ops } = recordingContext2d();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    ctx as unknown as RenderingContext,
  );
  const target = document.createElement("div");
  document.body.append(target);
  const instance = mount(component, { target });
  flushSync();
  mounted.push(() => {
    unmount(instance);
    target.remove();
  });
  return { ops };
}

/// The text of every glyph drawn in `ops`.
function glyphs(ops: CanvasOp[]): string {
  return ops
    .filter(({ op }) => op === "fillText")
    .map(({ args }) => args[0])
    .join("");
}

/// How many rain frames were stepped in `ops`: every step sets the rain face.
function rainSteps(ops: CanvasOp[]): number {
  return ops.filter(({ op, args }) => op === "set font" && args[0] === "20px matrix_code")
    .length;
}

/// One started column whose bright head sits on `position`.
function column(position: number, chars = "abcdefghijklmnopqrstuvwxyz0123456789"): RainColumn {
  return { chars: chars.split(""), delay: 0, speed: 0, position };
}

describe("the rain engine", () => {
  test("paints a falling column on the 11 x 19 px grid in the reference colour tiers", () => {
    const { ctx, ops } = recordingContext2d();
    stepRain(ctx, [column(3), column(3)], 2, 40);

    const painted = ops.flatMap((op, index) =>
      op.op === "fillText" ? [[ops[index - 1]!.args[0], ...op.args]] : [],
    );
    // Second column, rows 0..3: body, mid, lead, then the head at the bottom.
    expect(painted.slice(4)).toEqual([
      ["#2cb231", "a", 11, 19],
      ["#95a297", "b", 11, 38],
      ["#c9cfb9", "c", 11, 57],
      ["#f6f6f4", "d", 11, 76],
    ]);
  });

  test("advances each column one row per step, holding a slow column a step", () => {
    const fast = column(0);
    const slow = { ...column(0), speed: 1 };
    const { ctx } = recordingContext2d();
    stepRain(ctx, [fast, slow], 2, 40);
    stepRain(ctx, [fast, slow], 2, 40);

    expect(fast.position).toBe(2);
    expect(slow.position).toBe(1);
  });

  test("spreads column starts over eight steps per row", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const [late] = createRainColumns(1, 10);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const [early] = createRainColumns(1, 10);

    expect(late!.delay).toBe(79);
    expect(early!.delay).toBe(0);
  });

  test("glitches a trail cell one step in fifteen and dims the tail", () => {
    // Head at row 30 of a 20-row screen: rows 20..26 are live trail, rows
    // 1..19 are tail the step dims.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const always = recordingContext2d();
    stepRain(always.ctx, [column(30)], 1, 20);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const never = recordingContext2d();
    stepRain(never.ctx, [column(30)], 1, 20);

    const tailFills = (ops: CanvasOp[]) =>
      ops.flatMap((op, index) =>
        op.op === "fillRect" ? [ops[index - 1]!.args[0]] : [],
      );
    expect(glyphs(always.ops)).toHaveLength(4 + 7);
    expect(glyphs(never.ops)).toHaveLength(4);
    expect(new Set(tailFills(always.ops))).toEqual(new Set(["rgba(0, 0, 0, 0.30)"]));
    expect(new Set(tailFills(never.ops))).toEqual(new Set(["rgba(0, 0, 0, 0.05)"]));
  });

  test("a still frame is sparse falling columns, not a full grid", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { ctx, ops } = recordingContext2d();
    drawStaticMatrix(ctx, 40, 20);

    expect(ops[0]).toEqual({ op: "clearRect", args: [0, 0, 440, 380] });
    // Every column is started and paints its head and three trail tiers,
    // far short of the 40 x 20 cells a full grid would fill.
    expect(glyphs(ops)).toHaveLength(40 * 4);
  });
});

describe("the screensaver", () => {
  test("types the reference intro, then rains a frame every 40 ms", async () => {
    vi.useFakeTimers();
    // A middle roll types every glyph at the slow 300 ms beat.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { ops } = render(MatrixRain);
    await vi.advanceTimersByTimeAsync(0);

    expect(fontsLoad).toHaveBeenCalledWith("22px matrix_courier");
    expect(fontsLoad).toHaveBeenCalledWith("20px matrix_code");
    expect(ops).toContainEqual({ op: "set font", args: ["22px matrix_courier"] });

    await vi.advanceTimersByTimeAsync(799);
    expect(glyphs(ops)).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(ops.filter(({ op }) => op === "fillText")).toEqual([
      { op: "fillText", args: ["W", 30, 40] },
    ]);

    await vi.advanceTimersByTimeAsync(4200);
    expect(glyphs(ops)).toBe("Wake up, Neo...");
    const second = ops.length;
    // Held for two seconds, cleared, then the second line.
    await vi.advanceTimersByTimeAsync(2000 + 21 * 300);
    expect(glyphs(ops.slice(second))).toBe("The Matrix has you...");

    await vi.advanceTimersByTimeAsync(2000);
    const rain = ops.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(rainSteps(ops.slice(rain))).toBe(10);
  });

  test("under reduced motion skips the intro and holds one still frame", async () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const { ops } = render(MatrixRain);
    await vi.advanceTimersByTimeAsync(0);
    const still = ops.length;
    await vi.advanceTimersByTimeAsync(20_000);

    expect(rainSteps(ops)).toBe(1);
    expect(ops).toHaveLength(still);
    expect(ops).not.toContainEqual({ op: "set font", args: ["22px matrix_courier"] });
  });
});

describe("the preview", () => {
  test("rains through the engine every 40 ms while on screen", async () => {
    vi.useFakeTimers();
    const { ops } = render(MatrixRainPreview);
    await vi.advanceTimersByTimeAsync(0);
    const start = ops.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(rainSteps(ops.slice(start))).toBe(10);

    intersect?.([{ isIntersecting: false }]);
    const hidden = ops.length;
    await vi.advanceTimersByTimeAsync(400);
    expect(ops).toHaveLength(hidden);
  });

  test("under reduced motion paints one still frame", async () => {
    vi.useFakeTimers();
    reducedMotion = true;
    const { ops } = render(MatrixRainPreview);
    await vi.advanceTimersByTimeAsync(0);
    const still = ops.length;
    await vi.advanceTimersByTimeAsync(400);

    expect(rainSteps(ops)).toBe(1);
    expect(ops).toHaveLength(still);
  });
});
