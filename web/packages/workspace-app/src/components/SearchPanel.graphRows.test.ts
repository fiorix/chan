// @vitest-environment jsdom
//
// The search panel's tag and mention rows read the shared graph. Over a
// partial view, a first load still streaming or one that failed, it offers
// none, as before any view exists; a complete answer brings them.

import { mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
      searchContent: vi.fn(async () => ({ hits: [], readiness: { state: "ready" } })),
      reportFile: vi.fn(async () => null),
      graphStream: vi.fn(),
    },
  };
});

import { api } from "../api/client";
import type { GraphView } from "../api/types";
import { graphData, invalidateGraph, reloadGraph } from "../state/graphData.svelte";
import { searchPanel } from "../state/store.svelte";
import SearchPanel from "./SearchPanel.svelte";

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView = () => {};
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
    dispatchEvent: () => false,
  }),
});

/// One document carrying a tag and a mention that the query matches.
const whole = {
  nodes: [
    { kind: "file", id: "a.md", label: "a", path: "a.md" },
    { kind: "tag", id: "#grfprt", label: "#grfprt" },
    { kind: "mention", id: "@@Grfprt", label: "@@Grfprt" },
  ],
  edges: [
    { source: "a.md", target: "#grfprt", kind: "tag" },
    { source: "a.md", target: "@@Grfprt", kind: "mention" },
  ],
} as unknown as GraphView;

let view: Record<string, unknown> | null = null;
let target: HTMLElement;

beforeEach(async () => {
  invalidateGraph();
  // The panel's first load streams the whole graph as one batch and then
  // fails, which keeps that batch as a partial view.
  vi.mocked(api.graphStream).mockImplementation(async (_scope, opts) => {
    opts?.onNodes?.(whole.nodes, whole);
    throw new Error("stream down");
  });
  searchPanel.open = true;
  searchPanel.query = "";
  target = document.createElement("div");
  document.body.append(target);
  view = mount(SearchPanel, { target });
  await settle();
});

afterEach(() => {
  if (view) unmount(view);
  view = null;
  document.body.innerHTML = "";
  searchPanel.open = false;
  searchPanel.query = "";
  invalidateGraph();
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function search(text: string): Promise<void> {
  const input = target.querySelector("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
}

function rowLabels(): string[] {
  return [...target.querySelectorAll(".row1 .path")].map((el) => el.textContent?.trim() ?? "");
}

/// A complete answer replaces the failed load's partial view.
async function completeTheGraph(): Promise<void> {
  vi.mocked(api.graphStream).mockResolvedValue(whole);
  await reloadGraph();
  await settle();
}

describe("the graph rows over a failed first load's partial view", () => {
  test("no tag row until a complete answer", async () => {
    expect(graphData.partial, "the failed load kept a partial view").toBe(true);
    await search("grfprt");
    expect(rowLabels()).not.toContain("#grfprt");

    await completeTheGraph();
    expect(rowLabels()).toContain("#grfprt");
  });

  test("no mention row until a complete answer", async () => {
    expect(graphData.partial, "the failed load kept a partial view").toBe(true);
    await search("grfprt");
    expect(rowLabels()).not.toContain("@@Grfprt");

    await completeTheGraph();
    expect(rowLabels()).toContain("@@Grfprt");
  });
});
