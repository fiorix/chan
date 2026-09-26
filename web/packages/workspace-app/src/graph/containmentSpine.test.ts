import { describe, expect, test } from "vitest";
import {
  ancestorClosure,
  containmentParents,
  containmentSpine,
  spineEdgeKey,
} from "./containmentSpine";

// Nested tree: root "" -> directory:projects -> directory:projects/deep ->
// projects/deep/notes.md, plus a @@mention meta-node with no contains edge.
const edges = [
  { source: "", target: "directory:projects", kind: "contains" },
  { source: "directory:projects", target: "directory:projects/deep", kind: "contains" },
  {
    source: "directory:projects/deep",
    target: "projects/deep/notes.md",
    kind: "contains",
  },
  // A link and a mention edge that must not be treated as containment.
  { source: "projects/deep/notes.md", target: "projects/alpha.md", kind: "link" },
  { source: "projects/deep/notes.md", target: "@@Bob", kind: "mention" },
];

describe("containment spine", () => {
  const parents = containmentParents(edges);

  test("a deep file lights its whole parent chain up to the root", () => {
    const { nodes, edges: spine } = containmentSpine("projects/deep/notes.md", parents);
    expect([...nodes].sort()).toEqual(
      ["", "directory:projects", "directory:projects/deep"].sort(),
    );
    expect(spine.has(spineEdgeKey("directory:projects/deep", "projects/deep/notes.md"))).toBe(true);
    expect(spine.has(spineEdgeKey("directory:projects", "directory:projects/deep"))).toBe(true);
    expect(spine.has(spineEdgeKey("", "directory:projects"))).toBe(true);
    expect(spine.size).toBe(3);
  });

  test("a directory node lights its own chain to the root", () => {
    const { nodes } = containmentSpine("directory:projects/deep", parents);
    expect([...nodes].sort()).toEqual(["", "directory:projects"].sort());
  });

  test("a mention meta-node has no spine", () => {
    const { nodes, edges: spine } = containmentSpine("@@Bob", parents);
    expect(nodes.size).toBe(0);
    expect(spine.size).toBe(0);
  });

  test("the workspace root has no spine", () => {
    const { nodes } = containmentSpine("", parents);
    expect(nodes.size).toBe(0);
  });

  test("only contains edges seed parents (link / mention ignored)", () => {
    expect(parents.get("projects/alpha.md")).toBeUndefined();
    expect(parents.get("@@Bob")).toBeUndefined();
  });

  test("a containment cycle cannot loop forever", () => {
    const looped = new Map<string, string>([
      ["a", "b"],
      ["b", "a"],
    ]);
    const { nodes } = containmentSpine("a", looped);
    // Walks a -> b, then stops (b's parent a is already seen).
    expect([...nodes]).toEqual(["b"]);
  });
});

describe("ancestor closure", () => {
  test("pulls a deep file's whole chain, with its edges listed root first", () => {
    // Root-first order is the slow one for an upward walk: each pass can
    // add only the parent of what the previous pass added.
    const visited = new Set(["projects/deep/notes.md"]);
    ancestorClosure(visited, edges);
    expect([...visited].sort()).toEqual(
      ["", "directory:projects", "directory:projects/deep", "projects/deep/notes.md"].sort(),
    );
  });

  test("walks only contains edges", () => {
    // notes.md links to alpha.md and mentions @@Bob; neither makes it a parent.
    const visited = new Set(["projects/alpha.md", "@@Bob"]);
    ancestorClosure(visited, edges);
    expect([...visited].sort()).toEqual(["@@Bob", "projects/alpha.md"]);
  });

  test("a containment cycle cannot loop forever", () => {
    const visited = new Set(["a"]);
    ancestorClosure(visited, [
      { source: "a", target: "b", kind: "contains" },
      { source: "b", target: "a", kind: "contains" },
    ]);
    expect([...visited].sort()).toEqual(["a", "b"]);
  });
});
