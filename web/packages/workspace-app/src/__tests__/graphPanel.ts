// Mount helpers for GraphPanel tests.
//
// GraphPanel turns the server's graph into what the canvas draws: which nodes
// and edges are visible, which are focal, which is selected. A test mounts the
// real panel with GraphCanvas replaced by `canvasProbe`, a stand-in that keeps
// the props the panel hands it, and serves the panel's requests from
// `graphServer`. Both mocks are installed by the test file (vi.mock is hoisted
// per file):
//
//   vi.mock("./GraphCanvas.svelte", async () =>
//     (await import("../__tests__/graphPanel")).canvasProbeModule());
//   vi.mock("../api/client", async (importOriginal) =>
//     (await import("../__tests__/graphPanel")).graphApiModule(
//       await importOriginal<typeof import("../api/client")>(),
//     ));
//
// This module imports no component and no api module, so the mock factories
// above can load it without a cycle.

import { mount, tick, unmount, type Component } from "svelte";
import { vi } from "vitest";

import type {
  FsGraphEdge,
  FsGraphNode,
  FsGraphResponse,
  GraphView,
  GraphViewEdge,
  GraphViewNode,
} from "../api/types";
import type { GraphTab, LeafNode } from "../state/tabs.svelte";

/// The props GraphPanel passes to GraphCanvas, as the stand-in receives them.
/// They are read live: each access returns the panel's current value.
export type CanvasProps = {
  open: boolean;
  paused: boolean;
  nodes: Array<{ id: string; kind: string; path?: string; label?: string }>;
  edges: Array<{ source: string; target: string; kind: string }>;
  visibleNodeIds: Set<string>;
  visibleEdges: Array<{ source: string; target: string; kind: string }>;
  focalIds: string[];
  selectedId: string | null;
  expansionFitRequest: { nonce: number; ids: string[] } | null;
  onSelect: (id: string | null) => void;
  onSetAsScope: () => void;
};

export const canvas: { props: CanvasProps | null } = { props: null };

/// The GraphCanvas module the test file mocks in: a component that renders
/// nothing and records the props object it was given.
export function canvasProbeModule(): { default: (anchor: unknown, props: CanvasProps) => void } {
  return {
    default: (_anchor: unknown, props: CanvasProps) => {
      canvas.props = props;
    },
  };
}

/// The graph the api stub serves. `view` answers graphStream (the semantic
/// graph); `fs` answers fsGraph by directory path, trimmed to the requested
/// depth.
export const graphServer = {
  view: { nodes: [], edges: [] } as GraphView,
  fs: { nodes: [], edges: [] } as { nodes: FsGraphNode[]; edges: FsGraphEdge[] },
  /// When set, fsGraph pages a limited request into batches of this many
  /// nodes, with a cursor, the way the server pages a large directory.
  fsPageSize: null as number | null,
  /// When set, graphStream waits on it before it delivers anything.
  streamGate: null as Promise<void> | null,
  /// When set, a paged fsGraph request (the spine seed) waits on it.
  fsGate: null as Promise<void> | null,
  /// What languageGraph answers for a single language's detail.
  languageDetail: null as unknown,
  graphStreamCalls: 0,
  languageGraphCalls: 0,
  fsGraphCalls: [] as Array<{ path: string; depth: number; cursor?: string }>,
};

export function resetGraphServer(): void {
  graphServer.view = { nodes: [], edges: [] };
  graphServer.fs = { nodes: [], edges: [] };
  graphServer.fsPageSize = null;
  graphServer.streamGate = null;
  graphServer.fsGate = null;
  graphServer.languageDetail = null;
  graphServer.graphStreamCalls = 0;
  graphServer.languageGraphCalls = 0;
  graphServer.fsGraphCalls = [];
  canvas.props = null;
}

function depthBelow(root: string, path: string): number {
  if (root === "") return path === "" ? 0 : path.split("/").length;
  if (path === root) return 0;
  if (!path.startsWith(`${root}/`)) return -1;
  return path.slice(root.length + 1).split("/").length;
}

/// The fs graph under `path`, down to `depth` levels, as one final batch.
export function fsResponse(path: string, depth: number): FsGraphResponse {
  const nodes = graphServer.fs.nodes.filter((n) => {
    const d = depthBelow(path, n.path);
    return d >= 0 && d <= depth;
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graphServer.fs.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return {
    root: "/ws",
    scope: "directory",
    path,
    depth,
    nodes,
    edges,
    truncated: false,
    cursor: null,
    done: true,
  };
}

/// The api client module with the graph endpoints served from `graphServer`.
export function graphApiModule<T extends { api: object }>(actual: T): T {
  return {
    ...actual,
    api: {
      ...actual.api,
      graphStream: vi.fn(
        async (
          _scope: unknown,
          opts: { onNodes?: (n: GraphViewNode[]) => void; onEdges?: (e: GraphViewEdge[]) => void } = {},
        ) => {
          graphServer.graphStreamCalls += 1;
          await Promise.resolve();
          if (graphServer.streamGate) await graphServer.streamGate;
          opts.onNodes?.(graphServer.view.nodes);
          opts.onEdges?.(graphServer.view.edges);
          return graphServer.view;
        },
      ),
      graph: vi.fn(async () => graphServer.view),
      languageGraph: vi.fn(async (o: { language?: string } = {}) => {
        graphServer.languageGraphCalls += 1;
        if (o.language) {
          return { nodes: [], edges: [], max_depth: 1, detail: graphServer.languageDetail };
        }
        return { nodes: [], edges: [], max_depth: 1 };
      }),
      fsGraph: vi.fn(async (o: { path: string; depth: number; limit?: number; cursor?: string }) => {
        graphServer.fsGraphCalls.push({ path: o.path, depth: o.depth, cursor: o.cursor });
        if (o.limit !== undefined && graphServer.fsGate) await graphServer.fsGate;
        const whole = fsResponse(o.path, o.depth);
        const size = graphServer.fsPageSize;
        if (size === null || o.limit === undefined) return whole;
        const start = Number(o.cursor ?? 0);
        const nodes = whole.nodes.slice(start, start + size);
        const ids = new Set(nodes.map((n) => n.id));
        const done = start + size >= whole.nodes.length;
        return {
          ...whole,
          nodes,
          edges: whole.edges.filter((e) => ids.has(e.target)),
          cursor: done ? null : String(start + size),
          done,
        };
      }),
      health: vi.fn(async () => ({})),
      inspector: vi.fn(async () => null),
      reportDir: vi.fn(async () => null),
      reportPrefix: vi.fn(async () => null),
      reportFileStream: vi.fn(async () => null),
      backlinksStream: vi.fn(async () => {}),
    },
  };
}

/// The jsdom pieces a mounted graph reaches for: layout observers, animation
/// frames (the panel yields one between paged loads; the canvas stand-in
/// paints nothing), and matchMedia.
export function installGraphDom(): void {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as typeof cancelAnimationFrame;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
}

export const GRAPH_PANE = "graph-test-pane";

export function graphTab(over: Partial<GraphTab> = {}): GraphTab {
  return {
    kind: "graph",
    id: "graph-1",
    title: "graph",
    mode: "semantic",
    scopeId: "workspace",
    depth: 1,
    expanded: {},
    filters: {
      link: true,
      tag: true,
      mention: true,
      language: true,
      img: true,
      folder: true,
      markdown: true,
      source: true,
    },
    inspectorOpen: false,
    pendingSelectId: null,
    ...over,
  };
}

const mounted: Array<Record<string, unknown>> = [];

/// Mounts `panel` (GraphPanel, which the test file imports statically: a
/// per-test dynamic import of the component can outlast a test's timeout under
/// a loaded full suite) on `tab`, seated as the active tab of the active pane
/// of `layout` so the panel's launcher commands and its reactivity see a live
/// tab. Returns the live tab and the host element.
export async function mountGraphPanel(
  panel: Component<{ tab: GraphTab; active?: boolean; onClose?: () => void }>,
  layout: {
    rootId: string;
    activePaneId: string;
    nodes: Record<string, unknown>;
  },
  tab: GraphTab,
  opts: { active?: boolean } = {},
): Promise<{ tab: GraphTab; target: HTMLElement }> {
  layout.nodes = {
    [GRAPH_PANE]: { kind: "leaf", id: GRAPH_PANE, tabs: [tab], activeTabId: tab.id },
  };
  layout.rootId = GRAPH_PANE;
  layout.activePaneId = GRAPH_PANE;
  const live = (layout.nodes[GRAPH_PANE] as LeafNode).tabs[0] as GraphTab;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(panel, { target, props: { tab: live, active: opts.active ?? true } }) as Record<
      string,
      unknown
    >,
  );
  await settle();
  return { tab: live, target };
}

export function unmountGraphPanels(): void {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
}

export async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// The ids the canvas is told to draw, sorted.
export function visibleIds(): string[] {
  return [...(canvas.props?.visibleNodeIds ?? [])].sort();
}

/// Node and edge literals for a semantic graph view, with the server's id
/// schemes: a file's id is its path, a directory's is `directory:<path>` (the
/// root's is ""), a tag's `#name` and a mention's `@@name`.
export const g = {
  file(path: string, extra: Partial<Extract<GraphViewNode, { kind: "file" }>> = {}): GraphViewNode {
    return { kind: "file", id: path, label: path.split("/").pop() ?? path, path, ...extra };
  },
  dir(path: string): GraphViewNode {
    return {
      kind: "directory",
      id: path === "" ? "" : `directory:${path}`,
      label: path.split("/").pop() ?? "",
      path,
      files: 0,
      code: 0,
    };
  },
  tag(name: string): GraphViewNode {
    return { kind: "tag", id: `#${name}`, label: `#${name}` };
  },
  mention(name: string): GraphViewNode {
    return { kind: "mention", id: `@@${name}`, label: `@@${name}` };
  },
  language(name: string): GraphViewNode {
    return { kind: "language", id: `language:${name}`, label: name, language: name, files: 1, code: 1 };
  },
  edge(source: string, target: string, kind: GraphViewEdge["kind"]): GraphViewEdge {
    return { source, target, kind };
  },
};

/// Node and edge literals for the filesystem graph. Ids are paths; the root
/// directory's id is "".
export const fsg = {
  dir(path: string): FsGraphNode {
    return { id: path, kind: "directory", name: path.split("/").pop() ?? "", path, size: 0 };
  },
  file(path: string): FsGraphNode {
    return { id: path, kind: "file", name: path.split("/").pop() ?? path, path, size: 1 };
  },
  contains(parent: string, child: string): FsGraphEdge {
    return { source: parent, target: child, kind: "contains" };
  },
};

// ---- GraphCanvas ---------------------------------------------------------
//
// GraphCanvas itself draws on a 2D context from a force simulation. A test
// mounts it with `installCanvasDom()`: the context records every frame it
// paints, animation frames run only when the test calls `runFrames`, and the
// host's size and resize notifications are the test's to set. Nodes are
// located with the component's `nodeScreenCircle` export.

/// One painted frame: the view transform, every filled disc, every stroked
/// line segment and every label, each with the style it was drawn in. Disc
/// and line coordinates are in world space, as the paint pass issues them.
export type Frame = {
  transform: { k: number; x: number; y: number };
  discs: Array<{ x: number; y: number; r: number; fill: string; alpha: number }>;
  lines: Array<{ x1: number; y1: number; x2: number; y2: number; stroke: string; alpha: number }>;
  labels: string[];
};

type Style = { fillStyle: string; strokeStyle: string; globalAlpha: number };

/// A 2D context that records what is painted, one Frame per paint pass (a
/// pass opens with setTransform).
export class RecordingContext {
  frames: Frame[] = [];
  fillStyle = "#000";
  strokeStyle = "#000";
  globalAlpha = 1;
  lineWidth = 1;
  font = "";
  textAlign = "start";
  textBaseline = "alphabetic";
  #arc: [number, number, number] | null = null;
  #segments: Array<[number, number, number, number]> = [];
  #at: [number, number] | null = null;
  #saved: Style[] = [];

  get frame(): Frame {
    if (this.frames.length === 0) this.setTransform(1, 0, 0, 1, 0, 0);
    return this.frames[this.frames.length - 1]!;
  }

  setTransform(a: number, _b: number, _c: number, _d: number, e: number, f: number): void {
    this.frames.push({ transform: { k: a, x: e, y: f }, discs: [], lines: [], labels: [] });
  }
  beginPath(): void {
    this.#arc = null;
    this.#segments = [];
    this.#at = null;
  }
  moveTo(x: number, y: number): void {
    this.#at = [x, y];
  }
  lineTo(x: number, y: number): void {
    if (this.#at) this.#segments.push([this.#at[0], this.#at[1], x, y]);
    this.#at = [x, y];
  }
  arc(x: number, y: number, r: number): void {
    this.#arc = [x, y, r];
  }
  fill(): void {
    if (!this.#arc) return;
    const [x, y, r] = this.#arc;
    this.frame.discs.push({ x, y, r, fill: this.fillStyle, alpha: this.globalAlpha });
  }
  stroke(): void {
    for (const [x1, y1, x2, y2] of this.#segments) {
      this.frame.lines.push({ x1, y1, x2, y2, stroke: this.strokeStyle, alpha: this.globalAlpha });
    }
  }
  fillText(text: string): void {
    this.frame.labels.push(text);
  }
  save(): void {
    this.#saved.push({ fillStyle: this.fillStyle, strokeStyle: this.strokeStyle, globalAlpha: this.globalAlpha });
  }
  restore(): void {
    const s = this.#saved.pop();
    if (s) Object.assign(this, s);
  }
  measureText(): { width: number } {
    return { width: 0 };
  }
  getLineDash(): number[] {
    return [];
  }
  clearRect(): void {}
  setLineDash(): void {}
  drawImage(): void {}
  strokeText(): void {}
  closePath(): void {}
  rect(): void {}
  clip(): void {}
  translate(): void {}
  scale(): void {}
  rotate(): void {}
}

/// The host's size, the pending animation frames, and the resize callbacks
/// the canvas registered.
export const canvasHost = {
  width: 400,
  height: 300,
  frames: [] as Array<FrameRequestCallback | null>,
  resizeCallbacks: [] as Array<() => void>,
};

export function installCanvasDom(): void {
  installGraphDom();
  canvasHost.frames = [];
  canvasHost.resizeCallbacks = [];
  class TestResizeObserver {
    constructor(cb: ResizeObserverCallback) {
      canvasHost.resizeCallbacks.push(() => cb([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    canvasHost.frames.push(cb);
    return canvasHost.frames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    canvasHost.frames[id - 1] = null;
  }) as typeof cancelAnimationFrame;
  const contexts = new WeakMap<HTMLCanvasElement, RecordingContext>();
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = new RecordingContext();
      contexts.set(this, ctx);
    }
    return ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLElement.prototype.getBoundingClientRect = function () {
    return new DOMRect(0, 0, canvasHost.width, canvasHost.height);
  };
  for (const prop of ["clientWidth", "clientHeight"] as const) {
    Object.defineProperty(HTMLCanvasElement.prototype, prop, {
      configurable: true,
      get: () => (prop === "clientWidth" ? canvasHost.width : canvasHost.height),
    });
  }
}

/// Runs the animation frames queued so far, `n` rounds.
export function runFrames(n = 1): void {
  for (let i = 0; i < n; i += 1) {
    const due = canvasHost.frames;
    canvasHost.frames = [];
    for (const cb of due) cb?.(performance.now());
  }
}

/// Delivers a resize notification to every observer the canvas registered.
export function fireResize(): void {
  for (const cb of canvasHost.resizeCallbacks) cb();
}

export function paintedContext(target: HTMLElement): RecordingContext {
  const canvasEl = target.querySelector("canvas");
  if (!canvasEl) throw new Error("no canvas");
  return canvasEl.getContext("2d") as unknown as RecordingContext;
}
