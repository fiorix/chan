// @vitest-environment jsdom
//
// How hard GraphCanvas re-warms its force simulation when the graph it is
// handed is published again. The simulation is d3's own, wrapped so that each
// alpha it is given is recorded.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import GraphCanvas from "./GraphCanvas.svelte";
import { installCanvasDom, runFrames } from "../__tests__/graphPanel";
import type { GraphViewEdge, GraphViewNode } from "../api/types";

const alphas = vi.hoisted((): number[] => []);

vi.mock("d3-force", async (importOriginal) => {
  const d3 = await importOriginal<typeof import("d3-force")>();
  return {
    ...d3,
    forceSimulation: (...args: Parameters<typeof d3.forceSimulation>) => {
      const sim = d3.forceSimulation(...args);
      const alpha = sim.alpha.bind(sim);
      sim.alpha = ((value?: number) => {
        if (value === undefined) return alpha();
        alphas.push(value);
        return alpha(value);
      }) as typeof sim.alpha;
      return sim;
    },
  };
});

type CanvasNode = Extract<GraphViewNode, { kind: "file" | "tag" | "folder" }>;
type CanvasEdge = GraphViewEdge & { kind: "tag" | "contains" };

installCanvasDom();

const dir = (path: string): CanvasNode => ({
  kind: "folder",
  id: path === "" ? "" : `directory:${path}`,
  label: `${path.split("/").pop() || "workspace"}/`,
  path,
  files: 0,
  code: 0,
});
const file = (path: string): CanvasNode => ({ kind: "file", id: path, label: path, path });
const edge = (source: string, target: string, kind: CanvasEdge["kind"]): CanvasEdge => ({ source, target, kind });

/// notes/{a,b}.md under the root, and a tag on a.md.
function graph(): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  return {
    nodes: [dir(""), dir("notes"), file("notes/a.md"), file("notes/b.md"), { kind: "tag", id: "#t", label: "#t" }],
    edges: [
      edge("", "directory:notes", "contains"),
      edge("directory:notes", "notes/a.md", "contains"),
      edge("directory:notes", "notes/b.md", "contains"),
      edge("notes/a.md", "#t", "tag"),
    ],
  };
}

const mounted: Array<Record<string, unknown>> = [];

beforeEach(() => {
  alphas.length = 0;
});

afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  document.body.innerHTML = "";
});

describe("a graph published again", () => {
  test("with a node hidden, the same nodes re-warm the layout as a content refresh", () => {
    const g = graph();
    const visibleEdges = g.edges.filter((e) => e.kind !== "tag");
    const p = $state({
      open: true,
      nodes: g.nodes,
      edges: g.edges,
      visibleNodeIds: new Set(g.nodes.filter((x) => x.kind !== "tag").map((x) => x.id)),
      visibleEdges,
      focalIds: [] as string[],
      selectedId: null as string | null,
      onSelect: vi.fn(),
    });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(GraphCanvas, { target, props: p }) as Record<string, unknown>);
    flushSync();
    runFrames(2);
    alphas.length = 0;

    // The Graph tab publishes the same nodes again at the end of a load and
    // on every stream batch, as a new array.
    p.nodes = [...g.nodes];
    flushSync();

    expect(alphas.at(-1)).toBe(0.05);
  });
});

describe("a visibility change without a new graph payload", () => {
  function renderWithVisible(ids: Set<string>): { graph: ReturnType<typeof graph>; props: {
    visibleNodeIds: Set<string>;
    visibleEdges: CanvasEdge[];
  } } {
    const g = graph();
    const p = $state({
      open: true,
      nodes: g.nodes,
      edges: g.edges,
      visibleNodeIds: ids,
      visibleEdges: g.edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
      focalIds: [] as string[],
      selectedId: null as string | null,
      onSelect: vi.fn(),
    });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(GraphCanvas, { target, props: p }) as Record<string, unknown>);
    flushSync();
    runFrames(2);
    alphas.length = 0;
    return { graph: g, props: p };
  }

  test("revealing a filtered tag uses the incremental add strength", () => {
    const ids = new Set(["", "directory:notes", "notes/a.md", "notes/b.md"]);
    const { graph: g, props: p } = renderWithVisible(ids);
    p.visibleNodeIds = new Set(g.nodes.map((node) => node.id));
    p.visibleEdges = g.edges;
    flushSync();
    expect(alphas).toEqual([0.35]);
  });

  test("hiding three of five nodes uses the incremental remove strength", () => {
    const { graph: g, props: p } = renderWithVisible(new Set(graph().nodes.map((node) => node.id)));
    p.visibleNodeIds = new Set(["", "notes/a.md"]);
    p.visibleEdges = g.edges.filter((edge) => p.visibleNodeIds.has(edge.source) && p.visibleNodeIds.has(edge.target));
    flushSync();
    expect(alphas).toEqual([0.2]);
  });
});

describe("a change of the focal ids alone", () => {
  function renderWithFocal(focalIds: string[]): { focalIds: string[] } {
    const g = graph();
    const p = $state({
      open: true,
      nodes: g.nodes,
      edges: g.edges,
      visibleNodeIds: new Set(g.nodes.map((node) => node.id)),
      visibleEdges: g.edges,
      focalIds,
      selectedId: null as string | null,
      onSelect: vi.fn(),
    });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(GraphCanvas, { target, props: p }) as Record<string, unknown>);
    flushSync();
    runFrames(2);
    alphas.length = 0;
    return p;
  }

  test("warms the layout gently, so the pin it moves is applied", () => {
    const p = renderWithFocal(["notes/a.md"]);
    p.focalIds = ["notes/b.md"];
    flushSync();
    expect(alphas).toEqual([0.05]);
  });

  test("the same focal ids handed over as a new array leave the layout still", () => {
    const p = renderWithFocal(["notes/a.md"]);
    p.focalIds = ["notes/a.md"];
    flushSync();
    expect(alphas).toEqual([]);
  });
});

describe("a change of the focal ids that arrives with a new graph payload", () => {
  type Shown = { nodes: CanvasNode[]; edges: CanvasEdge[] };

  function renderShowing(shown: Shown, focalIds: string[]) {
    const p = $state({
      open: true,
      nodes: shown.nodes,
      edges: shown.edges,
      visibleNodeIds: new Set(shown.nodes.map((node) => node.id)),
      visibleEdges: shown.edges,
      focalIds,
      selectedId: null as string | null,
      onSelect: vi.fn(),
    });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(GraphCanvas, { target, props: p }) as Record<string, unknown>);
    flushSync();
    runFrames(2);
    alphas.length = 0;
    return p;
  }

  /// Publish `next` and its focal ids in one flush, as a scope whose focal
  /// ids are derived from its nodes does. Answers the strength the payload
  /// gave the layout and the strength the flush left it with.
  function publish(p: ReturnType<typeof renderShowing>, next: Shown, focalIds: string[]) {
    p.nodes = next.nodes;
    p.edges = next.edges;
    p.visibleNodeIds = new Set(next.nodes.map((node) => node.id));
    p.visibleEdges = next.edges;
    p.focalIds = focalIds;
    flushSync();
    return { payload: alphas[0], left: alphas.at(-1) };
  }

  test("nodes arriving into an open, empty canvas keep the strength of a first load", () => {
    const p = renderShowing({ nodes: [], edges: [] }, []);
    expect(publish(p, graph(), ["notes/a.md"])).toEqual({ payload: 1, left: 1 });
  });

  test("a node added to a shown graph keeps the incremental strength", () => {
    const g = graph();
    const p = renderShowing(g, ["notes/a.md"]);
    const grown = {
      nodes: [...g.nodes, file("notes/c.md")],
      edges: [...g.edges, edge("directory:notes", "notes/c.md", "contains")],
    };
    expect(publish(p, grown, ["notes/c.md"])).toEqual({ payload: 0.2, left: 0.2 });
  });
});
