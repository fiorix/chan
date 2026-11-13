// "Copy link to graph": the graph command serializes a tab to
// a `chan://graph?...` link that, pasted into a markdown file, reopens
// the same view on click. Lock the serialize <-> parse round-trip so the
// scope / depth / mode / filters / selection survive intact.
import { describe, expect, it } from "vitest";

import {
  GRAPH_LINK_PREFIX,
  graphLinkFor,
  parseGraphLink,
  type GraphTab,
} from "./tabs.svelte";

function tab(overrides: Partial<GraphTab>): GraphTab {
  return {
    kind: "graph",
    id: "graph-1",
    title: "graph",
    depth: 1,
    expanded: { "": true },
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
    ...overrides,
  };
}

describe("graph link serialization", () => {
  it("carries the opened directories and a selection of the workspace's own node", () => {
    const t = tab({
      expanded: { "": true, notes: true, "notes/a, b": true },
      // The root's node id is the empty string.
      selectedNodeId: "",
    });
    const parsed = parseGraphLink(graphLinkFor(t));
    expect(parsed?.expanded).toEqual({ "": true, notes: true, "notes/a, b": true });
    expect(parsed?.selectedNodeId).toBe("");
  });

  it("reads a link with no opened directories as the root's own level, and no selection as none", () => {
    const parsed = parseGraphLink(`${GRAPH_LINK_PREFIX}s=workspace`);
    expect(parsed?.expanded).toEqual({ "": true });
    expect(parsed?.selectedNodeId).toBeNull();
  });

  it("round-trips the depth, the selection, the opened directories and the filters", () => {
    const t = tab({
      depth: 3,
      selectedNodeId: "directory:crates/gateway-common",
      expanded: { "": true, crates: true, "crates/gateway-common": true },
    });
    const link = graphLinkFor(t);
    expect(link.startsWith(GRAPH_LINK_PREFIX)).toBe(true);
    const parsed = parseGraphLink(link);
    expect(parsed).toEqual({
      depth: 3,
      selectedNodeId: "directory:crates/gateway-common",
      expanded: t.expanded,
      filters: t.filters,
    });
  });

  it("round-trips a non-default filter set", () => {
    const filtered = tab({
      filters: {
        link: true,
        tag: false,
        mention: false,
        language: true,
        img: false,
        folder: true,
        markdown: true,
        source: false,
      },
    });
    expect(parseGraphLink(graphLinkFor(filtered))?.filters).toEqual(
      filtered.filters,
    );
  });

  it("encodes a tag (with '#') safely", () => {
    const parsed = parseGraphLink(graphLinkFor(tab({ selectedNodeId: "#infra" })));
    expect(parsed?.selectedNodeId).toBe("#infra");
  });

  it("reads a link that names a scope of its own as the workspace with that node selected", () => {
    // Links as notes hold them from when a graph could be scoped to a node,
    // or be the filesystem's or a language's graph (`m=f`, `m=l`).
    const read = (query: string) => parseGraphLink(`${GRAPH_LINK_PREFIX}${query}`);

    expect(read("s=dir%3Acrates%2Fgateway-common&d=3&m=s")).toMatchObject({
      depth: 3,
      selectedNodeId: "crates/gateway-common",
      expanded: { "": true, crates: true, "crates/gateway-common": true },
    });
    expect(read("s=tag%3A%23infra&m=s")?.selectedNodeId).toBe("#infra");
    expect(read("s=file%3Anotes%2Fa.md&m=f")).toMatchObject({
      selectedNodeId: "notes/a.md",
      expanded: { "": true },
    });
    expect(read("s=language%3ARust&m=l&d=0")).toMatchObject({ depth: 1, selectedNodeId: "language:Rust" });
    // The node the link itself selects wins over its scope's.
    expect(read("s=tag%3A%23infra&m=s&n=notes%2Fa.md")?.selectedNodeId).toBe("notes/a.md");
  });

  it("still writes the scope and mode a link is refused without", () => {
    const params = new URLSearchParams(graphLinkFor(tab({})).slice(GRAPH_LINK_PREFIX.length));
    expect(params.get("s")).toBe("workspace");
    expect(params.get("m")).toBe("s");
  });

  it("rejects non-graph links and a link with no scope", () => {
    expect(parseGraphLink("https://example.com")).toBeNull();
    expect(parseGraphLink("[[notes/a.md]]")).toBeNull();
    expect(parseGraphLink("chan://graph?d=2&m=s")).toBeNull();
    expect(parseGraphLink("")).toBeNull();
  });

  it("defaults depth=1 and no selection when omitted", () => {
    expect(parseGraphLink(`${GRAPH_LINK_PREFIX}s=workspace`)).toMatchObject({ depth: 1, selectedNodeId: null });
  });
});
