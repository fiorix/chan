// @vitest-environment jsdom
//
// Where a tag lens lands on the canvas it paints. GraphPanel is mounted on
// the real tab model with the api served from a fixed graph, and GraphCanvas
// paints into a recording context. Once the layout rests, the painted box of
// what the lens shows must sit inside the canvas, centered, and again after
// the canvas changes size.

import { timerFlush } from "d3-timer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) =>
  (await import("../__tests__/graphPanel")).graphApiModule(
    await importOriginal<typeof import("../api/client")>(),
  ),
);

import GraphPanel from "./GraphPanel.svelte";
import {
  canvasHost,
  fireResize,
  g,
  graphServer,
  graphTab,
  installCanvasDom,
  mountGraphPanel,
  paintedContext,
  resetGraphServer,
  runFrames,
  settle,
  unmountGraphPanels,
} from "../__tests__/graphPanel";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { layout } from "../state/tabs.svelte";

installCanvasDom();

/// Three files under #t at different depths, and files the lens leaves out.
function serveGraph(): void {
  const dirs = ["", "notes", "notes/deep", "src", "src/lib", "misc"];
  const tagged = ["notes/a.md", "notes/deep/b.md", "src/lib/c.md"];
  const other = ["notes/x.md", "src/y.md", "misc/z.md", "misc/w.md"];
  const parent = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
  graphServer.view = {
    nodes: [...dirs.map(g.dir), ...[...tagged, ...other].map((p) => g.file(p)), g.tag("t")],
    edges: [
      ...dirs.filter((d) => d !== "").map((d) => g.edge(g.dir(parent(d)).id, g.dir(d).id, "contains")),
      ...[...tagged, ...other].map((p) => g.edge(g.dir(parent(p)).id, p, "contains")),
      ...tagged.map((p) => g.edge(p, "#t", "tag")),
    ],
  };
}

/// GraphCanvas scatters nodes it has no anchor for with Math.random; a seeded
/// sequence makes each layout repeatable.
function seedRandom(seed: number): void {
  let state = seed;
  vi.spyOn(Math, "random").mockImplementation(() => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  });
}

/// Run the panel's loads, which yield animation frames between pages, until
/// the canvas paints the lens's nodes.
async function loaded(target: HTMLElement): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    runFrames(1);
    await settle(1);
    const canvasEl = target.querySelector("canvas");
    if (canvasEl && paintedContext(target).frames.at(-1)?.discs.length) return;
  }
  throw new Error("the canvas never painted the lens");
}

/// Tick the simulation on d3's timer until it rests, painting a frame per
/// tick, as a browser runs it; the tests drive the timer by hand.
function settleLayout(): void {
  for (let i = 0; i < 400; i += 1) {
    timerFlush();
    runFrames(1);
  }
  runFrames(90);
}

/// The room the painted discs leave to each edge of the canvas, in canvas
/// pixels, read from the last frame.
function room(target: HTMLElement): { left: number; right: number; above: number; below: number } {
  const frame = paintedContext(target).frames.at(-1)!;
  const { k, x, y } = frame.transform;
  const box = frame.discs.reduce(
    (b, d) => ({
      left: Math.min(b.left, (d.x - d.r) * k + x),
      right: Math.max(b.right, (d.x + d.r) * k + x),
      top: Math.min(b.top, (d.y - d.r) * k + y),
      bottom: Math.max(b.bottom, (d.y + d.r) * k + y),
    }),
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity },
  );
  return {
    left: box.left,
    right: canvasHost.width - box.right,
    above: box.top,
    below: canvasHost.height - box.bottom,
  };
}

function expectFramed(target: HTMLElement, size: string): void {
  const r = room(target);
  for (const [side, px] of Object.entries(r)) {
    expect(px, `${size}: every node inside the canvas (${side})`).toBeGreaterThan(0);
  }
  expect(Math.abs(r.left - r.right), `${size}: room left and right ${JSON.stringify(r)}`).toBeLessThan(1);
  expect(Math.abs(r.above - r.below), `${size}: room above and below ${JSON.stringify(r)}`).toBeLessThan(1);
}

let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  canvasHost.width = 986;
  canvasHost.height = 726;
  resetGraphServer();
  serveGraph();
  seedRandom(17);
});

afterEach(() => {
  unmountGraphPanels();
  timers.release();
  vi.restoreAllMocks();
});

describe("a tag lens on the canvas", () => {
  test("fits what it shows inside the canvas, centered, once the layout rests", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "tag:#t" }));
    await loaded(target);
    settleLayout();
    expectFramed(target, "986x726");
  });

  test("fits it again when the canvas changes size", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ scopeId: "tag:#t" }));
    await loaded(target);
    settleLayout();
    canvasHost.width = 500;
    canvasHost.height = 900;
    fireResize();
    runFrames(120);
    expectFramed(target, "500x900");
  });
});
