// The demo stands in for the server, so it names an entry's parent by its own
// rule: `/` is the only separator, and a `\` is a character of a name. Here the
// client's rule is wrong on purpose, and the demo's listing and graph must not
// follow it.

import { describe, expect, test, vi } from "vitest";

vi.mock("../state/format", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/format")>();
  return {
    ...actual,
    parentDir: (path: string): string => {
      const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      return i === -1 ? "" : path.slice(0, i);
    },
  };
});

import type { MockWorkspaceData } from "./data";
import { DemoGraph } from "./graph";
import { MockWorkspaceStore } from "./store";

function fixture(): MockWorkspaceData {
  return {
    metadata: {
      workspaceRoot: "demo",
      label: "demo",
      generatedAt: 1_700_000_000_000,
      fileCount: 2,
      textCount: 2,
    },
    files: [
      { path: "c\\d.md", kind: "document", size: 1, mtime: 100, content: "c" },
      { path: "docs/a\\b.md", kind: "document", size: 1, mtime: 100, content: "a" },
    ],
  };
}

describe("the demo's parent rule under a client rule that cuts at a backslash", () => {
  test("the store lists a name holding a backslash under its directory", () => {
    const store = new MockWorkspaceStore(fixture());
    expect(store.list("").map((e) => e.path)).toEqual(["docs", "c\\d.md"]);
    expect(store.list("docs").map((e) => e.path)).toEqual(["docs/a\\b.md"]);
  });

  test("the graph hangs a name holding a backslash off its directory", () => {
    const view = new DemoGraph(new MockWorkspaceStore(fixture())).view();
    const contains = view.edges
      .filter((e) => e.kind === "contains")
      .map((e) => `${e.source} > ${e.target}`)
      .sort();
    expect(contains).toEqual([" > c\\d.md", " > directory:docs", "directory:docs > docs/a\\b.md"]);
  });
});
