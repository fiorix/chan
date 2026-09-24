// @vitest-environment jsdom
//
// Both depth probes cleared exactly the state their guards read when
// /api/graph/fs failed: no response, not loading, which is the same shape as
// a probe that has never run. The effect therefore re-armed at once and an
// open graph tab held that request in a tight loop for as long as it was
// visible.
//
// A failed probe is its own state. It is asked for again when something could
// change the answer: a reload, or a move to another scope.
//
// This is the counting stub the item's acceptance asks for. It also carries
// two of the three things a source-text pin in graphDirInspectorHotfix used to
// hold: the dir probe fetches at FS_GRAPH_DEPTH_MAX, and the probe re-runs
// when the dir scope changes. The third, that a result for a scope which has
// moved on is discarded, is NOT asserted here: while a probe is in flight
// `dirDepthProbeLoading` stops a second one starting, so the stale-resolve
// path that guard defends is not reachable from the outside.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import GraphPanel from "./GraphPanel.svelte";
import { trackTimers, type TimerTrack } from "../demo/timers";
import type { GraphTab } from "../state/tabs.svelte";
import { FS_GRAPH_DEPTH_MAX } from "../graph/depth";

/** How many failures the stub serves before it relents. */
const RETRY_CEILING = 5;

/// The panel only answers app.graph.reload for the ACTIVE graph tab, and a tab
/// mounted straight into a target is in no layout, so the command would be
/// filtered out and the reload cases would assert nothing.
const activeTab = vi.hoisted(() => ({ id: null as string | null }));

const probes = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; depth: number }>,
  fail: true,
}));

vi.mock("../state/tabs.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/tabs.svelte")>();
  return { ...actual, activeGraphTab: () => ({ id: activeTab.id }) };
});

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      fsGraph: vi.fn(async (opts: { path: string; depth: number }) => {
        probes.calls.push({ path: opts.path, depth: opts.depth });
        // The failure is bounded. An unlatched probe re-arms on every effect
        // run, and a stub that always fails takes the vitest worker out of
        // memory: the run then dies with an OOM instead of failing an
        // assertion, which proves the bug once and guards nothing after. Past
        // RETRY_CEILING the stub relents, so a missing latch is a count.
        const soFar = probes.calls.filter(
          (c) => c.path === opts.path && c.depth === opts.depth,
        ).length;
        if (probes.fail && soFar <= RETRY_CEILING) {
          throw new Error("graph fs unavailable");
        }
        return { nodes: [], edges: [], truncated: false };
      }),
      graphStream: vi.fn(async () => ({ nodes: [], edges: [] })),
      graph: vi.fn(async () => ({ nodes: [], edges: [] })),
    },
  };
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
// The canvas animation loop reschedules itself from inside its own frame, so
// a stub that invokes the callback synchronously recurses until the stack is
// gone. Nothing here asserts on painting, so the frame never has to run.
globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
// The graph canvas draws on mount, so the stub needs the 2D surface it uses
// rather than an empty object.
const NOOP_2D_METHODS = [
  "setTransform", "clearRect", "fillRect", "strokeRect", "beginPath", "closePath",
  "moveTo", "lineTo", "arc", "arcTo", "bezierCurveTo", "quadraticCurveTo", "rect",
  "fill", "stroke", "save", "restore", "translate", "scale", "rotate", "clip",
  "drawImage", "fillText", "strokeText", "setLineDash", "createLinearGradient",
  "createRadialGradient", "roundRect", "ellipse",
] as const;
HTMLCanvasElement.prototype.getContext = ((): CanvasRenderingContext2D => {
  const ctx: Record<string, unknown> = {
    canvas: null,
    measureText: () => ({ width: 0 }),
    getLineDash: () => [],
  };
  for (const name of NOOP_2D_METHODS) ctx[name] = () => undefined;
  return ctx as unknown as CanvasRenderingContext2D;
}) as unknown as typeof HTMLCanvasElement.prototype.getContext;
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

/// A reactive tab. The panel takes the tab as a prop and its effects track
/// `scopeId`, so a plain object would let a scope change go unnoticed and the
/// re-probe case would silently assert nothing.
function graphTab(over: Partial<GraphTab> = {}): GraphTab {
  const tab = $state({
    kind: "graph",
    id: "graph-probe",
    title: "graph",
    mode: "filesystem",
    scopeId: "dir:docs",
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
  });
  return tab as GraphTab;
}

/// The Reload graph command, as the command launcher dispatches it.
function reloadGraph(): void {
  window.dispatchEvent(
    new CustomEvent("chan:command", { detail: { name: "app.graph.reload" } }),
  );
}

const mounted: Array<Record<string, unknown>> = [];

function render(tab: GraphTab): HTMLElement {
  activeTab.id = tab.id;
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(GraphPanel, { target, props: { tab, active: true } }) as Record<string, unknown>,
  );
  return target;
}

/// An unlatched probe re-arms on every effect run, so the count grows across
/// these turns. A latched one does not.
async function settle(turns = 16): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// Only the DEPTH probes, not the scope load. Both go through api.fsGraph for
/// the same path; the probe is the one that asks at the full depth, because
/// the slider cap must reflect the deepest reachable layer rather than the
/// loaded one. Counting both made even a successful mount look like two.
function dirProbes(path: string): Array<{ path: string; depth: number }> {
  return probes.calls.filter((c) => c.path === path && c.depth === FS_GRAPH_DEPTH_MAX);
}

let timers: TimerTrack;

beforeEach(() => {
  probes.calls = [];
  probes.fail = true;
  timers = trackTimers();
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  // The panel's layout effects arm the store's hash and session debounces,
  // which unmounting does not cancel; one left pending fires after the file's
  // environment is gone and reads a `window` that no longer exists.
  timers.release();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("a depth probe whose request fails", () => {
  test("is asked for once, not in a loop", async () => {
    render(graphTab());
    await settle();

    const asked = dirProbes("docs");
    expect(asked.length, `one probe, got ${asked.length}`).toBe(1);
  });

  test("is asked at the full fs-graph depth", async () => {
    render(graphTab());
    await settle();

    const asked = dirProbes("docs");
    expect(asked.length).toBe(1);
    expect(asked[0]!.depth, "probed at the max, not the tab's depth").toBe(FS_GRAPH_DEPTH_MAX);
    // And the scope load is a different request, at the tab's own depth.
    expect(
      probes.calls.some((c) => c.path === "docs" && c.depth !== FS_GRAPH_DEPTH_MAX),
      "the scope load is separate from the probe",
    ).toBe(true);
  });

  test("a move to another directory probes that one, once", async () => {
    const tab = graphTab();
    render(tab);
    await settle();
    expect(dirProbes("docs").length).toBe(1);

    tab.scopeId = "dir:src";
    await settle();

    expect(dirProbes("src").length, "the new scope is probed once").toBe(1);
    expect(dirProbes("docs").length, "and the failed one is not re-asked").toBe(1);
  });

  test("a reload retries the failed directory probe, once", async () => {
    render(graphTab());
    await settle();
    expect(dirProbes("docs").length, "the failing probe asked once").toBe(1);

    reloadGraph();
    await settle();

    // One more, not zero (the latch never releasing) and not a stream (it
    // releasing on every effect run).
    expect(dirProbes("docs").length, "a reload asks exactly once more").toBe(2);
  });

  test("a probe that succeeds is not re-asked either", async () => {
    probes.fail = false;
    render(graphTab());
    await settle();

    expect(dirProbes("docs").length, "one probe on the happy path too").toBe(1);
  });
});

describe("the workspace-scope probe", () => {
  test("a failure is asked for once, not in a loop", async () => {
    render(graphTab({ mode: "semantic", scopeId: "workspace" }));
    await settle();

    const asked = dirProbes("");
    expect(asked.length, `one workspace probe, got ${asked.length}`).toBe(1);
  });

  test("a reload retries it, once", async () => {
    render(graphTab({ mode: "semantic", scopeId: "workspace" }));
    await settle();
    expect(dirProbes("").length).toBe(1);

    reloadGraph();
    await settle();

    expect(dirProbes("").length, "a reload asks exactly once more").toBe(2);
  });
});

