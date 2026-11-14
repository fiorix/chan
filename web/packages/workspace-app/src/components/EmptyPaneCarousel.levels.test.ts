// @vitest-environment jsdom
//
// The Search slide draws the workspace's directories by level: the root's,
// and the level of each directory opened on the slide. It asks the server for
// those levels and no others, a double-click on a directory opens or closes
// it, and a poll whose answer equals the one held hands the canvas nothing
// new. Answers are taken in the order of their requests, a directory gone
// from the workspace leaves the opened list, and Details opened by a click
// lets a double-click's second click through before it takes its room.
// GraphCanvas is replaced by the graph helpers' stand-in, so the test reads
// what the slide hands it and makes the canvas's calls itself; the inspector
// is a stand-in too, which renders nothing and keeps the props it is handed.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./GraphCanvas.svelte", async () =>
  (await import("../__tests__/graphPanel")).canvasProbeModule(),
);
type InspectorProps = { title: string; reserveSpace: boolean };
const inspector = vi.hoisted(() => ({ props: null as InspectorProps | null }));
vi.mock("./Inspector.svelte", () => ({
  default: (_anchor: unknown, props: InspectorProps) => {
    inspector.props = props;
  },
}));

type Answer = (open: readonly string[]) => Promise<unknown>;
const server = vi.hoisted(() => ({ answer: null as Answer | null }));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      indexingState: vi.fn((open: readonly string[] = []) => server.answer?.(open) ?? new Promise(() => {})),
      buildInfo: vi.fn(async () => null),
    },
  };
});

import EmptyPaneCarousel from "./EmptyPaneCarousel.svelte";
import { canvas, installGraphDom, resetGraphServer } from "../__tests__/graphPanel";
import { api } from "../api/client";
import type { IndexingStateNode, IndexingStateResponse } from "../api/types";
import { indexingCache } from "../state/indexingStatus.svelte";

installGraphDom();

const mounted: Array<Record<string, unknown>> = [];
let target: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  resetGraphServer();
  indexingCache.last = null;
  server.answer = null;
  inspector.props = null;
  vi.mocked(api.indexingState).mockClear();
});

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  indexingCache.last = null;
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await tick();
    await vi.advanceTimersByTimeAsync(0);
  }
}

/// Mounts the carousel on its Search slide. `props` keeps its accessors, so a
/// test can stand in for a host that binds a prop and see what is written.
async function render(props: Record<string, unknown> = {}): Promise<void> {
  target = document.createElement("div");
  document.body.append(target);
  const all = Object.defineProperties({ slide: 1, autoRotate: false }, Object.getOwnPropertyDescriptors(props));
  mounted.push(mount(EmptyPaneCarousel, { target, props: all }));
  await settle();
}

function node(path: string, children_count = 0, state: IndexingStateNode["state"] = "indexed"): IndexingStateNode {
  return { path, state, children_count };
}

function answer(...nodes: IndexingStateNode[]): IndexingStateResponse {
  return { root: "/ws", nodes };
}

/// The workspace the tests serve: docs holds docs/api, notes holds nothing.
/// It answers a request the way the route does, with the root's level and
/// the level of each directory the request names.
const ROOT_LEVEL = [node("", 2), node("docs", 1), node("notes")];
function serveLevels(open: readonly string[]): Promise<IndexingStateResponse> {
  const nodes = [...ROOT_LEVEL];
  if (open.includes("docs")) nodes.splice(2, 0, node("docs/api", 0, "pending"));
  return Promise.resolve(answer(...nodes));
}

function drawn(): string[] {
  return canvas.props!.nodes.map((n) => n.id);
}

function asked(): Array<readonly string[]> {
  return vi.mocked(api.indexingState).mock.calls.map(([open]) => open ?? []);
}

/// What the canvas does for a double-click on a node: the taps select it,
/// then the gesture is signalled.
async function doubleClick(id: string): Promise<void> {
  canvas.props!.onSelect(id);
  await settle();
  canvas.props!.onSetAsScope();
  await settle();
}

describe("the Search slide's levels", () => {
  test("draws the root's level and leaves the rest of an answer that lists more", async () => {
    // What another Dashboard tab, with docs opened, left in the cache.
    indexingCache.last = answer(node("", 2), node("docs", 1), node("docs/api"), node("notes"));
    await render();

    expect(drawn()).toEqual(["", "directory:docs", "directory:notes"]);
    expect(canvas.props!.edges.map((e) => e.target)).toEqual(["directory:docs", "directory:notes"]);
  });

  test("draws the level of a directory its host holds opened", async () => {
    indexingCache.last = answer(node("", 2), node("docs", 1), node("docs/api"), node("notes"));
    await render({ expandedIndexDirs: ["docs"] });

    expect(drawn()).toEqual(["", "directory:docs", "directory:docs/api", "directory:notes"]);
  });

  test("asks for the levels it draws, and not for one opened under a closed directory", async () => {
    await render({ expandedIndexDirs: ["docs/api", "docs", "notes/deep/far"] });

    expect(asked()).toEqual([["docs", "docs/api"]]);
  });

  test("asks for the root's level alone with nothing opened", async () => {
    await render();

    expect(asked()).toEqual([[]]);
  });
});

describe("a double-click on a directory of the Search slide", () => {
  beforeEach(() => {
    server.answer = serveLevels;
  });

  test("opens it: the slide asks at once and draws the level the answer lists", async () => {
    await render();
    expect(drawn()).toEqual(["", "directory:docs", "directory:notes"]);

    await doubleClick("directory:docs");

    expect(asked()).toEqual([[], ["docs"]]);
    expect(drawn()).toEqual(["", "directory:docs", "directory:docs/api", "directory:notes"]);
  });

  test("asks the canvas to bring the directory, its parent and its level into view", async () => {
    await render();
    expect(canvas.props!.expansionFitRequest).toBeNull();

    await doubleClick("directory:docs");

    expect(canvas.props!.expansionFitRequest?.ids).toEqual(["directory:docs", "", "directory:docs/api"]);
  });

  test("closes it again: its level leaves the canvas before any answer, and the slide asks for the root's", async () => {
    await render();
    await doubleClick("directory:docs");
    server.answer = () => new Promise(() => {});

    await doubleClick("directory:docs");

    expect(drawn()).toEqual(["", "directory:docs", "directory:notes"]);
    expect(asked().at(-1)).toEqual([]);
  });

  test("closing a directory cancels its pending fit before its opening answer lands", async () => {
    await render();
    const sent: Array<(value: IndexingStateResponse) => void> = [];
    server.answer = () => new Promise((land) => sent.push(land));
    await doubleClick("directory:docs");
    await doubleClick("directory:docs");
    expect(sent).toHaveLength(2);

    sent[0](await serveLevels(["docs"]));
    await settle();

    expect(drawn()).toEqual(["", "directory:docs", "directory:notes"]);
    expect(canvas.props!.expansionFitRequest).toBeNull();
  });

  test("a pending opening waits for an answer that lists its level before fitting", async () => {
    indexingCache.last = answer(...ROOT_LEVEL);
    const sent: Array<(value: IndexingStateResponse) => void> = [];
    server.answer = () => new Promise((land) => sent.push(land));
    await render();
    await doubleClick("directory:docs");
    expect(sent).toHaveLength(2);

    sent[0](await serveLevels([]));
    await settle();
    expect(canvas.props!.expansionFitRequest).toBeNull();

    sent[1](await serveLevels(["docs"]));
    await settle();
    expect(canvas.props!.expansionFitRequest?.ids).toEqual(["directory:docs", "", "directory:docs/api"]);
  });

  test("leaves a directory that holds no directory, and the root, as they are", async () => {
    const written: string[][] = [];
    await render({
      get expandedIndexDirs() {
        return [];
      },
      set expandedIndexDirs(dirs: string[]) {
        written.push(dirs);
      },
    });

    await doubleClick("directory:notes");
    await doubleClick("");

    expect(written, "the opened directories its host holds").toEqual([]);
    expect(asked()).toEqual([[]]);
    expect(drawn()).toEqual(["", "directory:docs", "directory:notes"]);
  });

  test("hands its host the opened directories, with the one opened and without the one closed", async () => {
    const written: string[][] = [];
    let held: string[] = ["notes"];
    await render({
      get expandedIndexDirs() {
        return held;
      },
      set expandedIndexDirs(dirs: string[]) {
        written.push(dirs);
        held = dirs;
      },
    });

    await doubleClick("directory:docs");
    await doubleClick("directory:docs");

    expect(written).toEqual([["notes", "docs"], ["notes"]]);
  });

  test("drops the answer to a request sent before it was opened", async () => {
    // The first request, for the root's level, stays unanswered while the
    // cache draws the spine.
    indexingCache.last = answer(...ROOT_LEVEL);
    const sent: Array<{ open: readonly string[]; land: (value: IndexingStateResponse) => void }> = [];
    server.answer = (open) => new Promise((land) => sent.push({ open, land }));
    await render();
    await doubleClick("directory:docs");
    expect(sent.map((request) => request.open)).toEqual([[], ["docs"]]);

    sent[1].land(await serveLevels(["docs"]));
    await settle();
    sent[0].land(await serveLevels([]));
    await settle();

    expect(drawn()).toEqual(["", "directory:docs", "directory:docs/api", "directory:notes"]);
  });
});

describe("a poll of the Search slide", () => {
  test("an older request finishing leaves the loading note until the latest request finishes", async () => {
    const sent: Array<(value: IndexingStateResponse | null) => void> = [];
    server.answer = () => new Promise((land) => sent.push(land));
    await render();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toHaveLength(2);

    sent[0](null);
    await settle();
    expect(target.querySelector(".indexing-stub")?.textContent).toContain("Loading indexing state...");

    sent[1](null);
    await settle();
    expect(target.querySelector(".indexing-stub")?.textContent).toContain("Indexing state unavailable.");
  });

  test("hands the canvas the arrays it holds when its answer equals the one held", async () => {
    server.answer = serveLevels;
    await render();
    const { nodes, edges, visibleNodeIds } = canvas.props!;

    await vi.advanceTimersByTimeAsync(9_000);
    await settle();

    expect(asked()).toEqual([[], [], [], []]);
    expect(canvas.props!.nodes).toBe(nodes);
    expect(canvas.props!.edges).toBe(edges);
    expect(canvas.props!.visibleNodeIds).toBe(visibleNodeIds);
  });

  test("hands it the new spine when a directory's state moved", async () => {
    server.answer = serveLevels;
    await render();
    const { nodes } = canvas.props!;

    server.answer = () => Promise.resolve(answer(node("", 2), node("docs", 1, "indexing"), node("notes")));
    await vi.advanceTimersByTimeAsync(3_000);
    await settle();

    expect(canvas.props!.nodes).not.toBe(nodes);
    expect(canvas.props!.nodes.find((n) => n.id === "directory:docs")).toMatchObject({ indexState: "indexing" });
  });
});

describe("answers of the Search slide that land out of order", () => {
  type Sent = { land: (value: IndexingStateResponse) => void; fail: (error: Error) => void };
  let sent: Sent[];

  /// The cache draws the spine, and every request waits for the test.
  async function renderWaiting(): Promise<void> {
    indexingCache.last = answer(...ROOT_LEVEL);
    sent = [];
    server.answer = () => new Promise((land, fail) => sent.push({ land, fail }));
    await render();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent.length, "the first request and one poll").toBe(2);
  }

  function docsState(): string | undefined {
    return (canvas.props!.nodes.find((n) => n.id === "directory:docs") as { indexState?: string } | undefined)
      ?.indexState;
  }

  test("an older request's answer does not replace a later one's", async () => {
    await renderWaiting();

    sent[1].land(answer(node("", 2), node("docs", 1, "indexing"), node("notes")));
    await settle();
    sent[0].land(answer(...ROOT_LEVEL));
    await settle();

    expect(docsState()).toBe("indexing");
  });

  test("an older request's failure leaves the spine a later answer drew", async () => {
    await renderWaiting();

    sent[1].land(answer(node("", 2), node("docs", 1, "indexing"), node("notes")));
    await settle();
    sent[0].fail(new Error("timed out"));
    await settle();

    expect(target.querySelector(".indexing-stub"), "no failure note").toBeNull();
    expect(docsState()).toBe("indexing");
  });

  test("a failure with no later answer is shown", async () => {
    await renderWaiting();

    sent[1].fail(new Error("timed out"));
    await settle();

    expect(target.querySelector(".indexing-stub")?.textContent).toContain("timed out");
  });
});

describe("a directory gone from the workspace", () => {
  /// A host that holds `docs` and `notes/deep` opened, and keeps what the
  /// slide writes back.
  function host(written: string[][]): Record<string, unknown> {
    let held = ["docs", "notes/deep"];
    return {
      get expandedIndexDirs() {
        return held;
      },
      set expandedIndexDirs(dirs: string[]) {
        written.push(dirs);
        held = dirs;
      },
    };
  }

  test("leaves the opened list once an answer lists its parent's level without it", async () => {
    const written: string[][] = [];
    server.answer = () => Promise.resolve(answer(node("", 1), node("notes", 1)));
    await render(host(written));

    // `notes/deep` waits under a closed directory, which no answer speaks for.
    expect(written).toEqual([["notes/deep"]]);
  });

  test("stays in the list while answers list it", async () => {
    const written: string[][] = [];
    server.answer = serveLevels;
    await render(host(written));
    await vi.advanceTimersByTimeAsync(6_000);

    expect(written).toEqual([]);
  });
});

describe("Details opened by a click on the Search slide", () => {
  function settling(): boolean {
    return target.querySelector(".indexing-row")!.classList.contains("details-settling");
  }

  beforeEach(() => {
    server.answer = serveLevels;
  });

  test("lets the pointer through and leaves the canvas its width for the length of a double-click", async () => {
    await render();
    canvas.props!.onSelect("directory:docs");
    await settle();

    expect(inspector.props).toMatchObject({ title: "docs", reserveSpace: false });
    expect(settling()).toBe(true);

    await vi.advanceTimersByTimeAsync(499);
    expect(inspector.props!.reserveSpace).toBe(false);
    expect(settling()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(inspector.props!.reserveSpace).toBe(true);
    expect(settling()).toBe(false);
  });

  test("keeps its room when the selection moves to another directory", async () => {
    await render();
    canvas.props!.onSelect("directory:docs");
    await vi.advanceTimersByTimeAsync(500);
    await settle();

    canvas.props!.onSelect("directory:notes");
    await settle();

    expect(inspector.props).toMatchObject({ title: "notes", reserveSpace: true });
    expect(settling()).toBe(false);
  });

  test("takes its room at once for a selection its host restored", async () => {
    await render({ selectedIndexId: "directory:docs" });

    expect(inspector.props).toMatchObject({ title: "docs", reserveSpace: true });
    expect(settling()).toBe(false);
  });
});

describe("the Search slide's hint", () => {
  function hint(): string | null {
    return target.querySelector(".indexing-hint")?.textContent?.trim() ?? null;
  }

  test("names the double-click while a listed directory holds directories", async () => {
    server.answer = serveLevels;
    await render();

    expect(hint()).toBe("double-click a directory to open it");
  });

  test("is not shown when no listed directory holds one", async () => {
    server.answer = () => Promise.resolve(answer(node("", 1), node("notes")));
    await render();

    expect(hint()).toBeNull();
  });
});
