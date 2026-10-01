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
