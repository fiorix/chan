// @vitest-environment jsdom
//
// The Dashboard carousel's slides, mounted: the Search slide's indexing graph
// survives a flip because the carousel seeds it from a shared cache, and the
// Workspace slide shows the read-only dashboard view of the workspace
// inspector. GraphCanvas is replaced by the graph helpers' stand-in, so the
// test reads the nodes the slide hands it.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);

const poll = vi.hoisted(() => ({
  next: null as Promise<unknown> | null,
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      indexingState: vi.fn(() => poll.next ?? new Promise(() => {})),
      inspector: vi.fn(async () => null),
      reportDir: vi.fn(async () => null),
      graphStream: vi.fn(async () => ({ nodes: [], edges: [] })),
    },
  };
});

import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";
import { canvas, installGraphDom, resetGraphServer } from "../__tests__/graphPanel";
import type { IndexingStateResponse } from "../api/types";
import { trackTimers, type TimerTrack } from "../demo/timers";
import { graphData } from "../state/graphData.svelte";
import { indexingCache } from "../state/indexingStatus.svelte";

installGraphDom();

const mounted: Array<Record<string, unknown>> = [];
let timers: TimerTrack;

beforeEach(() => {
  timers = trackTimers();
  resetGraphServer();
  graphData.view = { nodes: [], edges: [] };
  indexingCache.last = null;
  poll.next = null;
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  indexingCache.last = null;
  timers.release();
});

async function render(slide: number): Promise<HTMLElement> {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(EmptyPaneCarousel, { target, props: { slide, autoRotate: false } }));
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
  return target;
}

const cached: IndexingStateResponse = {
  root: "/ws",
  nodes: [
    { path: "", state: "indexed" },
    { path: "notes", state: "indexing" },
  ],
};

describe("the Search slide", () => {
  test("draws the cached indexing graph at once, before its first poll answers", async () => {
    indexingCache.last = cached;
    const target = await render(1);

    expect(target.querySelector(".slide-indexing .indexing-stub"), "no loading stub").toBeNull();
    expect(canvas.props?.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["", "directory:notes"]));
  });

  test("keeps each poll's answer for the next mount", async () => {
    const fresh: IndexingStateResponse = { root: "/ws", nodes: [{ path: "", state: "indexed" }] };
    poll.next = Promise.resolve(fresh);
    await render(1);

    expect(indexingCache.last).toEqual(fresh);
  });
});

describe("the Workspace slide", () => {
  test("shows the workspace inspector's dashboard view, without its action row", async () => {
    const target = await render(0);
    const slide = target.querySelector(".slide-workspace");
    expect(slide?.querySelector(".kind-chip.workspace")).not.toBeNull();
    expect(slide?.querySelector(".actions-section")).toBeNull();
  });
});
