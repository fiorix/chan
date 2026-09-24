// @vitest-environment jsdom
//
// A PDF is one kind of file wherever it is shown. The server lists it as
// `media`, the file browser reads that kind, and the graph canvas paints it
// with the media bucket; the graph's filter chips count and hide file nodes
// by the same bucket, so a PDF node is a media node there too, not one that
// no chip counts and the media filter cannot hide.

import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

import GraphPanel from "./GraphPanel.svelte";
import type { GraphViewNode } from "../api/types";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { classifyFile, fileBucket } from "../state/kinds";
import { tabMenu } from "../state/tabMenu.svelte";
import type { GraphTab } from "../state/tabs.svelte";

const NODES: GraphViewNode[] = [
  { kind: "file", id: "docs/spec.pdf", label: "spec.pdf", path: "docs/spec.pdf" },
  { kind: "media", id: "docs/photo.png", label: "photo.png", path: "docs/photo.png" },
  { kind: "file", id: "docs/notes.md", label: "notes.md", path: "docs/notes.md" },
  { kind: "file", id: "src/lib.rs", label: "lib.rs", path: "src/lib.rs" },
];

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      fsGraph: vi.fn(async () => ({ nodes: [], edges: [], truncated: false, done: true })),
      graphStream: vi.fn(
        async (_opts: unknown, streamOpts: { onNodes?: (batch: GraphViewNode[]) => void }) => {
          streamOpts.onNodes?.(NODES);
          return { nodes: NODES, edges: [] };
        },
      ),
      graph: vi.fn(async () => ({ nodes: NODES, edges: [] })),
    },
  };
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
// Nothing here asserts on painting, so the canvas frame never has to run.
globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => undefined) as typeof cancelAnimationFrame;
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

function graphTab(): GraphTab {
  const tab = $state({
    kind: "graph",
    id: "graph-pdf",
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
  });
  return tab as GraphTab;
}

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack | null = null;

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  timers?.release();
  timers = null;
  tabMenu.openForTabId = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

async function settle(turns = 16): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await tick();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

/// The count on each filter chip of the open tab menu, by its label.
async function chipCounts(): Promise<Record<string, string>> {
  timers = trackTimers();
  const tab = graphTab();
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(
    mount(GraphPanel, { target, props: { tab, active: true } }) as Record<string, unknown>,
  );
  await settle();
  tabMenu.openForTabId = tab.id;
  flushSync();
  const counts: Record<string, string> = {};
  for (const row of document.body.querySelectorAll(".filter-row")) {
    const label = row.querySelector(".mbtn-label")?.textContent?.trim() ?? "";
    counts[label] = row.querySelector(".filter-count")?.textContent?.trim() ?? "";
  }
  return counts;
}

describe("a PDF node", () => {
  test("is media on the canvas, in the file browser and in the chips", async () => {
    const pdf = "docs/spec.pdf";
    const counts = await chipCounts();

    expect({
      canvas: fileBucket(pdf),
      fileBrowser: classifyFile(pdf, "media"),
      fileBrowserBarePath: classifyFile(pdf),
      chips: { media: counts.media, markdown: counts.markdown, source: counts.source },
    }).toEqual({
      canvas: "img",
      fileBrowser: "media",
      fileBrowserBarePath: "media",
      // The PDF and the png are media, the note markdown, the Rust source.
      chips: { media: "2", markdown: "1", source: "1" },
    });
  });
});
