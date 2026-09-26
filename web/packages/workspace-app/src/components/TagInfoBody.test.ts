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
import { invalidateGraph } from "../state/graphData.svelte";

const mounted: Array<Record<string, unknown>> = [];

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
});
