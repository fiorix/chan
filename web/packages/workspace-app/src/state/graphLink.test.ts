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
    mode: "semantic",
    scopeId: "workspace",
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

  it("round-trips a directory-scoped graph with a selected node", () => {
    const t = tab({
      mode: "semantic",
      scopeId: "dir:crates/gateway-common",
      depth: 3,
      selectedNodeId: "directory:crates/gateway-common",
    });
    const link = graphLinkFor(t);
    expect(link.startsWith(GRAPH_LINK_PREFIX)).toBe(true);
    const parsed = parseGraphLink(link);
    expect(parsed).not.toBeNull();
    expect(parsed?.scopeId).toBe("dir:crates/gateway-common");
    expect(parsed?.depth).toBe(3);
    expect(parsed?.mode).toBe("semantic");
    expect(parsed?.selectedNodeId).toBe("directory:crates/gateway-common");
    expect(parsed?.filters).toEqual(t.filters);
  });

  it("round-trips filesystem + language modes and a non-default filter set", () => {
    const fs = parseGraphLink(
      graphLinkFor(tab({ mode: "filesystem", scopeId: "file:notes/a.md" })),
    );
    expect(fs?.mode).toBe("filesystem");
    expect(fs?.scopeId).toBe("file:notes/a.md");

    const lang = parseGraphLink(
      graphLinkFor(tab({ mode: "language", scopeId: "language:Rust", depth: 0 })),
    );
    expect(lang?.mode).toBe("language");

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

  it("encodes tag scopes (with '#') and paths safely", () => {
    const parsed = parseGraphLink(
      graphLinkFor(tab({ scopeId: "tag:#infra", selectedNodeId: "#infra" })),
    );
    expect(parsed?.scopeId).toBe("tag:#infra");
    expect(parsed?.selectedNodeId).toBe("#infra");
  });

  it("rejects non-graph links and missing scope", () => {
    expect(parseGraphLink("https://example.com")).toBeNull();
    expect(parseGraphLink("[[notes/a.md]]")).toBeNull();
    expect(parseGraphLink("chan://graph?d=2&m=s")).toBeNull();
    expect(parseGraphLink("")).toBeNull();
  });

  it("defaults depth=1 and mode=semantic when omitted", () => {
    const parsed = parseGraphLink(`${GRAPH_LINK_PREFIX}s=workspace`);
    expect(parsed?.scopeId).toBe("workspace");
    expect(parsed?.depth).toBe(1);
    expect(parsed?.mode).toBe("semantic");
    expect(parsed?.selectedNodeId).toBeNull();
  });
});
