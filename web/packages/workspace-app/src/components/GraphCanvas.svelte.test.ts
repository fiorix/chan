// @vitest-environment jsdom
//
// GraphCanvas, mounted on a recording 2D context. The force simulation lays
// the nodes out for real; a test finds them through nodeScreenCircle, points
// at them with mouse events, and reads what each frame painted.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import GraphCanvas from "./GraphCanvas.svelte";
import {
  canvasHost,
  fireResize,
  installCanvasDom,
  paintedContext,
  runFrames,
  type Frame,
} from "../__tests__/graphPanel";
import type { GraphViewEdge, GraphViewNode } from "../api/types";
import { DEFAULT_FORCE, type GraphForce } from "../graph/force";
import { colorVarForBucket, type FileBucket } from "../state/kinds";
import { GRAPH_PALETTE_DEFAULTS } from "../state/graphPalette.svelte";

type CanvasNode = Extract<GraphViewNode, { kind: "file" | "tag" | "mention" | "language" | "folder" }>;
type CanvasEdge = GraphViewEdge & { kind: "link" | "tag" | "mention" | "contains" | "language" | "group" };
type Circle = { x: number; y: number; r: number };
type CanvasApi = { nodeScreenCircle(id: string): Circle | null };

installCanvasDom();

const n = {
  dir(path: string): CanvasNode {
    return {
      kind: "folder",
      id: path === "" ? "" : `directory:${path}`,
      label: `${path.split("/").pop() || "workspace"}/`,
      path,
      files: 0,
      code: 0,
    };
  },
  file(path: string, extra: { node_kind?: "contact"; missing?: boolean } = {}): CanvasNode {
    return { kind: "file", id: path, label: path.split("/").pop() ?? path, path, ...extra };
  },
  tag(name: string): CanvasNode {
    return { kind: "tag", id: `#${name}`, label: `#${name}` };
  },
  edge(source: string, target: string, kind: CanvasEdge["kind"]): CanvasEdge {
    return { source, target, kind };
  },
};

/// The workspace root with notes/{a,b}.md and src/c.rs, and a tag on a.md.
function tree(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes = [
    n.dir(""),
    n.dir("notes"),
    n.dir("src"),
    n.file("notes/a.md"),
    n.file("notes/b.md"),
    n.file("src/c.rs"),
    n.tag("t"),
  ];
  const edges = [
    n.edge("", "directory:notes", "contains"),
    n.edge("", "directory:src", "contains"),
    n.edge("directory:notes", "notes/a.md", "contains"),
    n.edge("directory:notes", "notes/b.md", "contains"),
    n.edge("directory:src", "src/c.rs", "contains"),
    n.edge("notes/a.md", "#t", "tag"),
  ];
  return { nodes, edges };
}

const mounted: Array<Record<string, unknown>> = [];

type Props = {
  open: boolean;
  paused?: boolean;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  visibleNodeIds: Set<string>;
  visibleEdges: CanvasEdge[];
  focalIds: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onSetAsScope?: () => void;
  expansionFitRequest?: { nonce: number; ids: string[] } | null;
  force?: GraphForce;
};

function props(graph = tree(), over: Partial<Props> = {}): Props {
  const p = $state<Props>({
    open: true,
    nodes: graph.nodes,
    edges: graph.edges,
    visibleNodeIds: new Set(graph.nodes.map((x) => x.id)),
    visibleEdges: graph.edges,
    focalIds: [],
    selectedId: null,
    onSelect: vi.fn(),
    onSetAsScope: vi.fn(),
    ...over,
  });
  return p;
}

function render(p: Props): { api: CanvasApi; target: HTMLElement; canvas: HTMLCanvasElement } {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(GraphCanvas, { target, props: p });
  mounted.push(component as Record<string, unknown>);
  flushSync();
  runFrames(2);
  return {
    api: component as unknown as CanvasApi,
    target,
    canvas: target.querySelector("canvas")!,
  };
}

function circle(api: CanvasApi, id: string): Circle {
  const c = api.nodeScreenCircle(id);
  if (!c) throw new Error(`node ${id} is not laid out`);
  return c;
}

/// A point `gap` canvas pixels outside the disc of `id`, on the side facing
/// away from every other node, so it is `gap` from this disc and clear of
/// the rest.
function outside(api: CanvasApi, ids: string[], id: string, gap: number): { x: number; y: number } {
  const c = circle(api, id);
  const others = ids.filter((o) => o !== id).map((o) => circle(api, o));
  let best = { x: c.x + c.r + gap, y: c.y };
  let bestClear = -Infinity;
  for (let i = 0; i < 16; i += 1) {
    const angle = (i / 16) * Math.PI * 2;
    const pt = { x: c.x + Math.cos(angle) * (c.r + gap), y: c.y + Math.sin(angle) * (c.r + gap) };
    const clear = Math.min(...others.map((o) => Math.hypot(pt.x - o.x, pt.y - o.y) - o.r));
    if (clear > bestClear) {
      bestClear = clear;
      best = pt;
    }
  }
  expect(bestClear, `a point ${gap}px outside ${id} clear of other nodes`).toBeGreaterThan(16);
  return best;
}

function mouse(el: Element, type: string, x: number, y: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
}

/// The last painted frame.
function lastFrame(target: HTMLElement): Frame {
  const frames = paintedContext(target).frames;
  expect(frames.length, "the canvas painted").toBeGreaterThan(0);
  return frames[frames.length - 1]!;
}

/// The disc painted for node `id` in `frame`.
function discOf(api: CanvasApi, frame: Frame, id: string): Frame["discs"][number] {
  const c = circle(api, id);
  const { k, x, y } = frame.transform;
  const disc = frame.discs.find(
    (d) => Math.abs(d.x * k + x - c.x) < 0.01 && Math.abs(d.y * k + y - c.y) < 0.01,
  );
  if (!disc) throw new Error(`no disc painted for ${id}`);
  return disc;
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

beforeEach(() => {
  canvasHost.width = 400;
  canvasHost.height = 300;
  seedRandom(7);
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("the hierarchy layout", () => {
  test("stacks each file above its directory and each directory above the root", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      vi.restoreAllMocks();
      seedRandom(seed);
      const { api } = render(props());
      const y = (id: string) => circle(api, id).y;

      expect(y("notes/a.md"), `seed ${seed}`).toBeLessThan(y("directory:notes"));
      expect(y("src/c.rs"), `seed ${seed}`).toBeLessThan(y("directory:src"));
      expect(y("directory:notes"), `seed ${seed}`).toBeLessThan(y(""));
      unmount(mounted.pop()!);
    }
  });

  test("pulls files toward their directory's column", () => {
    // The same layout with and without the parent pull, from the same start.
    const spread = (strength: number, seed: number): number => {
      vi.restoreAllMocks();
      seedRandom(seed);
      const { api } = render(props(tree(), { force: { ...DEFAULT_FORCE, parentXStrength: strength } }));
      const pairs: Array<[string, string]> = [
        ["notes/a.md", "directory:notes"],
        ["notes/b.md", "directory:notes"],
        ["src/c.rs", "directory:src"],
      ];
      // In units of the root's radius, so the fit's zoom cancels out.
      const unit = circle(api, "").r;
      const total = pairs.reduce(
        (sum, [f, d]) => sum + Math.abs(circle(api, f).x - circle(api, d).x) / unit,
        0,
      );
      unmount(mounted.pop()!);
      return total;
    };
    for (const seed of [1, 2, 3]) {
      expect(spread(DEFAULT_FORCE.parentXStrength, seed), `seed ${seed}`).toBeLessThan(spread(0, seed));
    }
  });
});

describe("pointing at a node", () => {
  test("a tap that starts on the disc selects even when it lifts a little outside", () => {
    const p = props();
    const { api, canvas } = render(p);
    const ids = p.nodes.map((x) => x.id);
    // Pressed 3px out (inside the tight drag slack), lifted 6px out, under
    // the drag threshold: the lift resolves with the wider click slack.
    const press = outside(api, ids, "notes/a.md", 3);
    const c = circle(api, "notes/a.md");
    const lift = { x: c.x + ((press.x - c.x) * (c.r + 6)) / (c.r + 3), y: c.y + ((press.y - c.y) * (c.r + 6)) / (c.r + 3) };

    mouse(canvas, "mousedown", press.x, press.y);
    mouse(canvas, "mouseup", lift.x, lift.y);
    expect(p.onSelect).toHaveBeenLastCalledWith("notes/a.md");
  });

  test("a tap well clear of every disc clears the selection", () => {
    const p = props();
    const { api, canvas } = render(p);
    const far = outside(api, p.nodes.map((x) => x.id), "notes/a.md", 14);

    mouse(canvas, "mousedown", far.x, far.y);
    mouse(canvas, "mouseup", far.x, far.y);
    expect(p.onSelect).toHaveBeenLastCalledWith(null);
  });

  test("a press just outside the disc pans the view instead of grabbing the node", () => {
    const p = props();
    const { api, canvas } = render(p);
    const a0 = circle(api, "notes/a.md");
    const b0 = circle(api, "notes/b.md");
    const at = outside(api, p.nodes.map((x) => x.id), "notes/a.md", 8);

    mouse(canvas, "mousedown", at.x, at.y);
    mouse(canvas, "mousemove", at.x + 30, at.y);
    mouse(canvas, "mouseup", at.x + 30, at.y);

    const a1 = circle(api, "notes/a.md");
    const b1 = circle(api, "notes/b.md");
    expect(a1.x - a0.x, "the node moved with the view").toBeCloseTo(30, 0);
    expect(b1.x - b0.x, "so did everything else").toBeCloseTo(30, 0);
  });

  test("a press on the disc drags the node alone", async () => {
    const { api, canvas } = render(props());
    const a0 = circle(api, "notes/a.md");
    const b0 = circle(api, "notes/b.md");

    mouse(canvas, "mousedown", a0.x + a0.r - 1, a0.y);
    mouse(canvas, "mousemove", a0.x + a0.r + 39, a0.y);
    // The simulation ticks on its own timer; give it a few.
    await new Promise((r) => setTimeout(r, 150));

    const aMoved = circle(api, "notes/a.md").x - a0.x;
    const bMoved = Math.abs(circle(api, "notes/b.md").x - b0.x);
    expect(aMoved).toBeGreaterThan(25);
    expect(bMoved, "the view did not pan: a sibling moved far less").toBeLessThan(aMoved - 10);
    mouse(canvas, "mouseup", a0.x + a0.r + 39, a0.y);
  });

  test("hovering a little outside the disc shows the pointer", () => {
    const p = props();
    const { api, canvas } = render(p);
    const at = outside(api, p.nodes.map((x) => x.id), "src/c.rs", 8);
    expect(canvas.style.cursor).toBe("grab");

    mouse(canvas, "mousemove", at.x, at.y);
    flushSync();
    expect(canvas.style.cursor).toBe("pointer");
  });

  test("a double-click on a node asks to scope the graph there; on empty canvas it does not", () => {
    const p = props();
    const { api, canvas } = render(p);
    const c = circle(api, "directory:notes");

    mouse(canvas, "dblclick", 1, 1);
    expect(p.onSetAsScope).not.toHaveBeenCalled();
    mouse(canvas, "dblclick", c.x, c.y);
    expect(p.onSetAsScope).toHaveBeenCalledTimes(1);
  });
});

describe("a selection", () => {
  test("dims everything outside its neighbourhood and spine, and labels only that", () => {
    const p = props(tree(), { selectedId: "notes/a.md" });
    const { api, target } = render(p);
    runFrames(1);
    const frame = lastFrame(target);
    const alpha = (id: string) => discOf(api, frame, id).alpha;

    expect(alpha("notes/a.md")).toBe(1);
    expect(alpha("#t"), "a neighbour").toBe(1);
    expect(alpha("directory:notes"), "its directory").toBe(1);
    expect(alpha(""), "the root, on its spine").toBe(1);
    expect(alpha("src/c.rs")).toBeLessThan(0.5);
    expect(alpha("directory:src")).toBeLessThan(0.5);
    expect(frame.labels.sort()).toEqual(["#t", "a.md", "notes/", "workspace/"].sort());
  });

  test("relights the edges it touches over the dimmed rest", () => {
    const p = props(tree(), { selectedId: "notes/a.md" });
    const { api, target } = render(p);
    runFrames(1);
    const frame = lastFrame(target);
    const worldOf = (id: string) => {
      const d = discOf(api, frame, id);
      return [d.x, d.y];
    };
    const alphasOf = (a: string, b: string) => {
      const [ax, ay] = worldOf(a);
      const [bx, by] = worldOf(b);
      return frame.lines
        .filter((l) => Math.abs(l.x1 - ax) < 0.01 && Math.abs(l.y1 - ay) < 0.01 && Math.abs(l.x2 - bx) < 0.01 && Math.abs(l.y2 - by) < 0.01)
        .map((l) => l.alpha);
    };

    expect(Math.max(...alphasOf("notes/a.md", "#t")), "incident edge relit").toBeGreaterThan(0.5);
    expect(Math.max(...alphasOf("directory:src", "src/c.rs")), "a far edge stays dim").toBeLessThan(0.1);
  });
});

describe("fitting the view", () => {
  function inView(api: CanvasApi, id: string): boolean {
    const c = circle(api, id);
    return c.x > 0 && c.x < canvasHost.width && c.y > 0 && c.y < canvasHost.height;
  }

  test("a canvas mounted into a zero-size host fits once the host has a size", () => {
    canvasHost.width = 0;
    canvasHost.height = 0;
    const { api } = render(props());
    canvasHost.width = 400;
    canvasHost.height = 300;

    fireResize();
    runFrames(3);
    for (const id of ["", "notes/a.md", "src/c.rs"]) expect(inView(api, id), id).toBe(true);
  });

  test("a canvas that opened before its data fits the data when it lands", () => {
    const p = props({ nodes: [], edges: [] }, { visibleNodeIds: new Set(), visibleEdges: [] });
    const { api } = render(p);
    const t = tree();

    p.nodes = t.nodes;
    p.edges = t.edges;
    p.visibleNodeIds = new Set(t.nodes.map((x) => x.id));
    p.visibleEdges = t.edges;
    flushSync();
    runFrames(3);
    for (const id of ["", "notes/a.md", "src/c.rs"]) expect(inView(api, id), id).toBe(true);
  });

  test("an expansion request frames the nodes it names without zooming in", () => {
    const p = props();
    const { api, canvas } = render(p);
    // Pan the cluster off to the right, as a user would.
    mouse(canvas, "mousedown", 5, 5);
    mouse(canvas, "mousemove", 5 + 600, 5);
    mouse(canvas, "mouseup", 5 + 600, 5);
    expect(inView(api, "src/c.rs")).toBe(false);
    const before = circle(api, "src/c.rs").r;

    p.expansionFitRequest = { nonce: 1, ids: ["directory:src", "src/c.rs"] };
    flushSync();
    runFrames(60);
    expect(inView(api, "src/c.rs")).toBe(true);
    expect(inView(api, "directory:src")).toBe(true);
    expect(circle(api, "src/c.rs").r, "the zoom did not grow").toBeLessThanOrEqual(before + 1e-6);
  });

  test("a pan cancels an expansion fit still in flight", () => {
    const p = props();
    const { api, canvas } = render(p);
    p.expansionFitRequest = { nonce: 1, ids: ["directory:src", "src/c.rs"] };
    flushSync();
    runFrames(1);

    mouse(canvas, "mousedown", 5, 5);
    mouse(canvas, "mousemove", 5 + 600, 5);
    mouse(canvas, "mouseup", 5 + 600, 5);
    const after = circle(api, "src/c.rs");
    runFrames(30);
    expect(circle(api, "src/c.rs").x, "the view stays where the user put it").toBeCloseTo(after.x, 0);
  });
});

describe("colours and sizes", () => {
  /// The palette the canvas reads from its host's CSS custom properties.
  const PALETTE: Record<string, string> = {
    "--g-doc": "#d01010",
    "--g-source": "#1020d0",
    "--g-img": "#9010c0",
    "--g-binary": "#505050",
    "--g-contact": "#d0c010",
    "--g-folder": "#808080",
    "--g-tag": "#10a020",
    "--g-language": "#e030a0",
    "--fb-drafts-fg": "#e3b300",
    "--accent": "#00ff00",
  };

  function palette(): void {
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      () => ({ getPropertyValue: (name: string) => PALETTE[name] ?? "" }) as CSSStyleDeclaration,
    );
  }

  /// The CSS variable a chip names for a bucket (its first var(), past any
  /// fallback).
  function chipVar(bucket: FileBucket): string {
    return colorVarForBucket(bucket).match(/var\((--[\w-]+)/)![1]!;
  }

  function colourGraph(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
    const nodes = [
      n.dir(""),
      n.dir("notes"),
      n.dir(".Drafts"),
      n.file("notes/a.md"),
      n.file("notes/c.rs"),
      n.file("notes/p.png"),
      n.file("notes/z.zip"),
      n.file("notes/alice.md", { node_kind: "contact" }),
      n.tag("t"),
      { kind: "language", id: "language:rust", label: "rust", language: "rust", files: 1, code: 1 } as CanvasNode,
    ];
    const edges = [
      n.edge("", "directory:notes", "contains"),
      n.edge("", "directory:.Drafts", "contains"),
      n.edge("directory:notes", "notes/a.md", "contains"),
      n.edge("notes/a.md", "notes/p.png", "link"),
      n.edge("notes/c.rs", "notes/z.zip", "link"),
      n.edge("notes/a.md", "#t", "tag"),
      n.edge("notes/c.rs", "language:rust", "language"),
    ];
    return { nodes, edges };
  }

  test("each file node is filled with the colour its kind chip names", () => {
    palette();
    const { api, target } = render(props(colourGraph()));
    runFrames(1);
    const frame = lastFrame(target);
    const cases: Array<[string, FileBucket]> = [
      ["notes/a.md", "doc"],
      ["notes/c.rs", "source"],
      ["notes/p.png", "img"],
      ["notes/z.zip", "binary"],
      ["notes/alice.md", "contact"],
    ];
    for (const [id, bucket] of cases) {
      expect(discOf(api, frame, id).fill, id).toBe(PALETTE[chipVar(bucket)]);
    }
  });

  test("the Drafts directory is tinted with the drafts colour, other directories stay grey", () => {
    palette();
    const { api, target } = render(props(colourGraph()));
    runFrames(1);
    const frame = lastFrame(target);

    expect(discOf(api, frame, "directory:.Drafts").fill).toBe(PALETTE["--fb-drafts-fg"]);
    expect(discOf(api, frame, "directory:notes").fill).toBe(PALETTE["--g-folder"]);
  });

  test("edges take their kind's colour, and a link its source document's", () => {
    palette();
    const { api, target } = render(props(colourGraph()));
    runFrames(1);
    const frame = lastFrame(target);
    const strokeOf = (a: string, b: string) => {
      const da = discOf(api, frame, a);
      const db = discOf(api, frame, b);
      const line = frame.lines.find(
        (l) => Math.abs(l.x1 - da.x) < 0.01 && Math.abs(l.y1 - da.y) < 0.01 && Math.abs(l.x2 - db.x) < 0.01 && Math.abs(l.y2 - db.y) < 0.01,
      );
      if (!line) throw new Error(`no line ${a} -> ${b}`);
      return line.stroke;
    };

    expect(strokeOf("directory:notes", "notes/a.md"), "containment is grey").toBe(PALETTE["--g-folder"]);
    expect(strokeOf("notes/a.md", "notes/p.png"), "a markdown link").toBe(PALETTE["--g-doc"]);
    expect(strokeOf("notes/c.rs", "notes/z.zip"), "a source file's link").toBe(PALETTE["--g-source"]);
    expect(strokeOf("notes/a.md", "#t")).toBe(PALETTE["--g-tag"]);
    expect(strokeOf("notes/c.rs", "language:rust")).toBe(PALETTE["--g-language"]);
  });

  test("a directory's disc sits between a leaf's and a document's, the root's is the largest", () => {
    const { api } = render(props(colourGraph()));
    const r = (id: string) => circle(api, id).r;

    expect(r("#t")).toBeLessThan(r("directory:notes"));
    expect(r("directory:notes")).toBeLessThan(r("notes/a.md"));
    expect(r("notes/a.md")).toBeLessThan(r(""));
  });
});

describe("the palette source", () => {
  function withPalette(vars: Record<string, string>): void {
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      () => ({ getPropertyValue: (name: string) => vars[name] ?? "" }) as CSSStyleDeclaration,
    );
  }

  test("with no palette in CSS, nodes fall back to the shared palette defaults", () => {
    withPalette({});
    const { api, target } = render(props());
    runFrames(1);
    const frame = lastFrame(target);
    expect(discOf(api, frame, "notes/a.md").fill).toBe(GRAPH_PALETTE_DEFAULTS.dark.doc);
    expect(discOf(api, frame, "src/c.rs").fill).toBe(GRAPH_PALETTE_DEFAULTS.dark.source);
    expect(discOf(api, frame, "directory:notes").fill).toBe(GRAPH_PALETTE_DEFAULTS.dark.folder);
  });

  test("a contact takes --g-contact, else --warn-text", () => {
    const graph = tree();
    graph.nodes.push(n.file("notes/alice.md", { node_kind: "contact" }));
    withPalette({ "--warn-text": "#aa7700" });
    const first = render(props(graph));
    runFrames(1);
    expect(discOf(first.api, lastFrame(first.target), "notes/alice.md").fill).toBe("#aa7700");
    unmount(mounted.pop()!);

    vi.restoreAllMocks();
    withPalette({ "--warn-text": "#aa7700", "--g-contact": "#1188ee" });
    const second = render(props(graph));
    runFrames(1);
    expect(discOf(second.api, lastFrame(second.target), "notes/alice.md").fill).toBe("#1188ee");
  });

  test("re-reads the palette when the graph surface's inline style changes", async () => {
    const palette: Record<string, string> = { "--g-doc": "#111111" };
    withPalette(palette);
    const surface = document.createElement("div");
    surface.className = "graph-tab";
    document.body.append(surface);
    const target = document.createElement("div");
    surface.append(target);
    const component = mount(GraphCanvas, { target, props: props() });
    mounted.push(component as Record<string, unknown>);
    flushSync();
    runFrames(2);
    const api = component as unknown as CanvasApi;
    expect(discOf(api, lastFrame(target), "notes/a.md").fill).toBe("#111111");

    palette["--g-doc"] = "#222222";
    surface.setAttribute("style", "--g-doc:#222222;");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    runFrames(1);
    expect(discOf(api, lastFrame(target), "notes/a.md").fill).toBe("#222222");
  });
});

describe("a graph body's theme", () => {
  test("a flip of the graph surface's data-theme re-reads the palette", async () => {
    const palette: Record<string, string> = { "--g-doc": "#333333" };
    vi.spyOn(globalThis, "getComputedStyle").mockImplementation(
      () => ({ getPropertyValue: (name: string) => palette[name] ?? "" }) as CSSStyleDeclaration,
    );
    const surface = document.createElement("div");
    surface.className = "graph-tab";
    document.body.append(surface);
    const target = document.createElement("div");
    surface.append(target);
    const component = mount(GraphCanvas, { target, props: props() });
    mounted.push(component as Record<string, unknown>);
    flushSync();
    runFrames(2);
    const api = component as unknown as CanvasApi;
    expect(discOf(api, lastFrame(target), "notes/a.md").fill).toBe("#333333");

    palette["--g-doc"] = "#444444";
    surface.setAttribute("data-theme", "light");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    runFrames(1);
    expect(discOf(api, lastFrame(target), "notes/a.md").fill).toBe("#444444");
  });
});

describe("pausing", () => {
  test("a paused canvas stops painting and resumes with its layout and view untouched", () => {
    const p = props();
    const { api, target } = render(p);
    const ctx = paintedContext(target);
    const before = circle(api, "notes/a.md");

    p.paused = true;
    flushSync();
    runFrames(1);
    const painted = ctx.frames.length;
    runFrames(5);
    expect(ctx.frames.length, "nothing painted while paused").toBe(painted);
    expect(canvasHost.frames.filter(Boolean), "no frame left queued").toHaveLength(0);

    p.paused = false;
    flushSync();
    runFrames(2);
    expect(ctx.frames.length).toBeGreaterThan(painted);
    expect(circle(api, "notes/a.md"), "no restart, no re-fit").toEqual(before);
  });
});
