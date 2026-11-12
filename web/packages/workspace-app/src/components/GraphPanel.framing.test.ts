// @vitest-environment jsdom
//
// Where the graph lands on the canvas it paints. GraphPanel is mounted on
// the real tab model with the api served from a fixed graph, a tag selected,
// and GraphCanvas paints into a recording context. Once the layout rests,
// everything painted must sit inside the canvas with the workspace's node at
// the bottom, centered across, and nothing below it; and again after the
// canvas changes size.

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

/// Three files under #t at different depths, and files the selection leaves
/// in closed directories.
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
/// the canvas paints the graph's nodes.
async function loaded(target: HTMLElement): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    runFrames(1);
    await settle(1);
    const canvasEl = target.querySelector("canvas");
    if (canvasEl && paintedContext(target).frames.at(-1)?.discs.length) return;
  }
  throw new Error("the canvas never painted the graph");
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

/// The workspace's node as the last frame painted it, in canvas pixels: the
/// lowest disc, since the tree grows up from it.
function lowest(target: HTMLElement): { x: number; y: number; r: number } {
  const frame = paintedContext(target).frames.at(-1)!;
  const { k, x, y } = frame.transform;
  const disc = frame.discs.reduce((low, d) => (d.y > low.y ? d : low));
  return { x: disc.x * k + x, y: disc.y * k + y, r: disc.r * k };
}

function expectFramed(target: HTMLElement, size: string): void {
  const r = room(target);
  for (const [side, px] of Object.entries(r)) {
    expect(px, `${size}: every node inside the canvas (${side})`).toBeGreaterThan(0);
  }
  const root = lowest(target);
  expect(root.x, `${size}: the root centered across`).toBeCloseTo(canvasHost.width / 2, 0);
  expect(root.y, `${size}: the root 56 px above the bottom edge`).toBeCloseTo(canvasHost.height - 56, 0);
  // The tagged files sit three levels up with the tag above them, so the
  // tree fills the canvas's height: the root's seat is not an empty frame's.
  expect(r.above, `${size}: the tree reaches the top`).toBeLessThan(canvasHost.height / 3);
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

describe("the graph on the canvas, a tag selected", () => {
  test("fits inside the canvas with the root at the bottom, once the layout rests", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "#t" }));
    await loaded(target);
    settleLayout();
    expectFramed(target, "986x726");
  });

  test("fits again when the canvas changes size", async () => {
    const { target } = await mountGraphPanel(GraphPanel, layout, graphTab({ pendingSelectId: "#t" }));
    await loaded(target);
    settleLayout();
    canvasHost.width = 500;
    canvasHost.height = 900;
    fireResize();
    runFrames(120);
    expectFramed(target, "500x900");
  });
});
