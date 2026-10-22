// @vitest-environment jsdom
//
// TagInfoBody lists the documents that reference a tag, a mention or a date
// from the shared graph, which it loads when it mounts.

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../api/client", () => ({ api: { graphStream: vi.fn() } }));
vi.mock("../state/store.svelte", () => ({
  openGraphForMention: vi.fn(),
  openGraphForTag: vi.fn(),
}));

import TagInfoBody from "./TagInfoBody.svelte";
import { api } from "../api/client";
import type { GraphView, GraphViewNode } from "../api/types";
import { invalidateGraph } from "../state/graphData.svelte";

const mounted: Array<Record<string, unknown>> = [];

const tag = { kind: "tag", id: "#x", label: "#x" } as GraphViewNode;
const doc = { kind: "file", id: "notes/a.md", label: "a.md", path: "notes/a.md" } as GraphViewNode;
/// The whole graph: one document carrying the tag.
const whole = { nodes: [tag, doc], edges: [{ source: doc.id, target: tag.id, kind: "tag" }] } as unknown as GraphView;

/// Stream the shared graph's first batch, the nodes without their edges,
/// and hold the rest; the returned function completes the stream.
function holdFirstLoad(): (view: GraphView) => void {
  let finish!: (view: GraphView) => void;
  vi.mocked(api.graphStream).mockImplementation(async (_scope, opts) => {
    opts?.onNodes?.(whole.nodes, { nodes: whole.nodes, edges: [] });
    return new Promise<GraphView>((resolve) => {
      finish = resolve;
    });
  });
  return (view) => finish(view);
}

function render(props: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement("div");
  document.body.append(target);
  mounted.push(mount(TagInfoBody, { target, props: { nodeId: "#x", label: "#x", kind: "tag", ...props } }));
  return target;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await tick();
    await new Promise((r) => setTimeout(r, 0));
  }
}

afterEach(() => {
  for (const app of mounted.splice(0)) unmount(app);
  document.body.innerHTML = "";
  invalidateGraph();
  vi.clearAllMocks();
});

describe("the shared graph load", () => {
  test("a graph stream that keeps failing is started once", async () => {
    vi.mocked(api.graphStream).mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error("stream down")), 0)),
    );
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(TagInfoBody, { target, props: { nodeId: "#x", label: "#x", kind: "tag" } }));
    await settle();
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(1);
    expect(target.textContent).toContain("references unavailable: stream down");
  });

  test("an invalidated graph loads again while the body is shown", async () => {
    vi.mocked(api.graphStream).mockResolvedValue({ nodes: [], edges: [] });
    const target = document.createElement("div");
    document.body.append(target);
    mounted.push(mount(TagInfoBody, { target, props: { nodeId: "#x", label: "#x", kind: "tag" } }));
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(1);
    invalidateGraph();
    await settle();
    expect(api.graphStream).toHaveBeenCalledTimes(2);
  });
});

describe("what the body says while the shared graph's first load streams", () => {
  test("its references are loading, not absent, until the stream completes", async () => {
    const finish = holdFirstLoad();
    const target = render();
    await settle();

    expect(target.textContent).toContain("loading references...");
    expect(target.textContent).not.toContain("no documents reference this");

    finish(whole);
    await settle();
    expect(target.textContent).not.toContain("loading references...");
    expect(target.textContent).toContain("a.md");
  });

  test("the graph panel's own list shows while the shared load streams", async () => {
    holdFirstLoad();
    const target = render({ documentsOverride: [doc] });
    await settle();

    expect(target.textContent).not.toContain("loading references...");
    expect(target.textContent).toContain("a.md");
  });

  test("the graph panel's own list shows over a shared load's error", async () => {
    vi.mocked(api.graphStream).mockRejectedValue(new Error("stream down"));
    const target = render({ documentsOverride: [doc] });
    await settle();

    expect(target.textContent).not.toContain("references unavailable");
    expect(target.textContent).toContain("a.md");
  });
});
