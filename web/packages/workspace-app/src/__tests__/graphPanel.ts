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
  graphStreamCalls: 0,
  fsGraphCalls: [] as Array<{ path: string; depth: number }>,
};

export function resetGraphServer(): void {
  graphServer.view = { nodes: [], edges: [] };
  graphServer.fs = { nodes: [], edges: [] };
  graphServer.graphStreamCalls = 0;
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
          opts.onNodes?.(graphServer.view.nodes);
          opts.onEdges?.(graphServer.view.edges);
          return graphServer.view;
        },
      ),
      graph: vi.fn(async () => graphServer.view),
      fsGraph: vi.fn(async (o: { path: string; depth: number }) => {
        graphServer.fsGraphCalls.push({ path: o.path, depth: o.depth });
        return fsResponse(o.path, o.depth);
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
/// frames that never run (the canvas stand-in paints nothing), and matchMedia.
export function installGraphDom(): void {
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
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

/// Node and edge literals for a semantic graph view.
export const g = {
  file(path: string, extra: Partial<Extract<GraphViewNode, { kind: "file" }>> = {}): GraphViewNode {
    return { kind: "file", id: `f:${path}`, label: path.split("/").pop() ?? path, path, ...extra };
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
