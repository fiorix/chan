import { describe, expect, test } from "vitest";

import { directoryNodeId } from "./canvasNodes";
import { FS_GRAPH_DEPTH_MAX } from "./depth";
import {
  closeToBudget,
  fitsBudget,
  depthStep,
  depthWithinBudget,
  graphNodeIds,
  openBelow,
  openedDepth,
  openedFor,
  openedForPath,
  selectedDirectory,
  selectionDepthCap,
  selectionOfScope,
  selectionReveal,
  type ViewEdge,
  type ViewNode,
} from "./selectionView";

// A workspace with two branches. Under notes/: a.md carries #t and links to
// b.md, b.md mentions @@alice, c.md refers to nothing, and daily/d.md
// carries #t. Under src/: main.rs, and x.md, which shares nothing with the
// notes but its language. README.md sits at the root.
const DIRS = ["notes", "notes/daily", "src"];
const FILES = ["README.md", "notes/a.md", "notes/b.md", "notes/c.md", "notes/daily/d.md", "src/main.rs", "src/x.md"];
const parentId = (path: string): string =>
  directoryNodeId(path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const nodes: ViewNode[] = [
  { id: "", kind: "folder", path: "" },
  ...DIRS.map((path) => ({ id: directoryNodeId(path), kind: "folder", path })),
  ...FILES.map((path) => ({ id: path, kind: "file", path })),
  { id: "#t", kind: "tag" },
  { id: "@@alice", kind: "mention" },
  { id: "language:Markdown", kind: "language" },
];
const edges: ViewEdge[] = [
  ...DIRS.map((path) => ({ source: parentId(path), target: directoryNodeId(path), kind: "contains" })),
  ...FILES.map((path) => ({ source: parentId(path), target: path, kind: "contains" })),
  { source: "notes/a.md", target: "#t", kind: "tag" },
  { source: "notes/daily/d.md", target: "#t", kind: "tag" },
  { source: "notes/a.md", target: "notes/b.md", kind: "link" },
  { source: "notes/b.md", target: "@@alice", kind: "mention" },
  ...FILES.filter((path) => path.endsWith(".md")).map((path) => ({
    source: "language:Markdown",
    target: path,
    kind: "language",
  })),
];

const META = ["#t", "@@alice", "language:Markdown"];
const ROOT_LEVEL = ["", "directory:notes", "directory:src", "README.md"];

/// The files and folders the graph includes, sorted: the meta nodes always
/// pass this stage and are left out of the comparison.
function shown(opened: Record<string, boolean>, selectedId: string | null, depth = 1): string[] {
  const ids = graphNodeIds({ nodes, edges, opened, selectedId, depth });
  for (const id of META) expect(ids.has(id), `${id} passes to the chips' stage`).toBe(true);
  return [...ids].filter((id) => !META.includes(id)).sort();
}

describe("the opened tree", () => {
  test("with nothing selected, draws the root's own level", () => {
    expect(shown({ "": true }, null)).toEqual([...ROOT_LEVEL].sort());
  });

  test("shows a file when every directory above it is opened", () => {
    expect(shown({ "": true, notes: true }, null)).toEqual(
      [...ROOT_LEVEL, "notes/a.md", "notes/b.md", "notes/c.md", "directory:notes/daily"].sort(),
    );
    expect(shown({ "": true, "notes/daily": true }, null), "daily is opened under a closed notes").toEqual(
      [...ROOT_LEVEL].sort(),
    );
  });
});

describe("a selection laid over the tree", () => {
  test("a tag reveals the files that carry it, each with its directories", () => {
    expect(shown({ "": true }, "#t")).toEqual(
      [...ROOT_LEVEL, "notes/a.md", "notes/daily/d.md", "directory:notes/daily"].sort(),
    );
  });

  test("a deeper selection follows references, not the tree and not the language", () => {
    const two = shown({ "": true }, "#t", 2);
    expect(two, "a.md links to b.md").toContain("notes/b.md");
    expect(two, "c.md is only a.md's sibling").not.toContain("notes/c.md");
    expect(two, "x.md only shares a.md's language").not.toContain("src/x.md");
    const reveal = selectionReveal(nodes, edges, "#t", 3);
    expect(reveal.has("@@alice"), "b.md mentions alice, three hops out").toBe(true);
    expect(reveal.has("language:Markdown")).toBe(false);
  });

  test("a file reveals what it refers to and what refers to it", () => {
    const reveal = selectionReveal(nodes, edges, "notes/b.md", 1);
    expect([...reveal].sort()).toEqual(["", "@@alice", "directory:notes", "notes/a.md", "notes/b.md"].sort());
  });

  test("a language reveals its files, one hop whatever the depth", () => {
    for (const depth of [1, 4]) {
      const ids = shown({ "": true }, "language:Markdown", depth);
      // README.md is both at the root's level and a Markdown file.
      const markdown = FILES.filter((p) => p.endsWith(".md") && p !== "README.md");
      expect(ids, `depth ${depth}`).toEqual([...ROOT_LEVEL, "directory:notes/daily", ...markdown].sort());
    }
  });

  test("a directory reveals itself with the directories above it, and nothing below", () => {
    expect([...selectionReveal(nodes, edges, "directory:notes/daily", 3)].sort()).toEqual(
      ["", "directory:notes", "directory:notes/daily"].sort(),
    );
  });

  test("a symlink reveals its target and a file its other names, as references do", () => {
    const linked: ViewEdge[] = [
      ...edges,
      { source: "README.md", target: "notes/daily/d.md", kind: "symlink" },
      { source: "src/main.rs", target: "notes/c.md", kind: "hardlink" },
    ];
    expect([...selectionReveal(nodes, linked, "README.md", 1)].sort()).toEqual(
      ["", "README.md", "directory:notes", "directory:notes/daily", "notes/daily/d.md"].sort(),
    );
    expect(selectionReveal(nodes, linked, "notes/daily/d.md", 1).has("README.md"), "and back").toBe(true);
    expect(selectionReveal(nodes, linked, "notes/c.md", 1).has("src/main.rs")).toBe(true);
  });

  test("an id no node has reveals nothing", () => {
    expect(selectionReveal(nodes, edges, "gone.md", 2).size).toBe(0);
    expect(shown({ "": true }, "gone.md")).toEqual([...ROOT_LEVEL].sort());
  });
});

describe("a directory's depth", () => {
  test("opens that many levels below it and leaves the other branches alone", () => {
    const start = { "": true, src: true };
    const one = openBelow(nodes, start, "notes", 1);
    expect(one).toEqual({ "": true, src: true, notes: true });
    const two = openBelow(nodes, one, "notes", 2);
    expect(two).toEqual({ "": true, src: true, notes: true, "notes/daily": true });
    expect(openBelow(nodes, two, "notes", 1), "back to one level closes daily").toEqual(one);
    expect(openBelow(nodes, two, "notes", 0), "zero closes the directory").toEqual(start);
  });

  test("opens the directories above it, so it shows", () => {
    expect(openBelow(nodes, { "": true }, "notes/daily", 1)).toEqual({
      "": true,
      notes: true,
      "notes/daily": true,
    });
  });

  test("on the root, closes everything past the depth and never the root", () => {
    const all = { "": true, notes: true, "notes/daily": true, src: true };
    expect(openBelow(nodes, all, "", 1)).toEqual({ "": true });
    expect(openBelow(nodes, all, "", 2)).toEqual({ "": true, notes: true, src: true });
    expect(openBelow(nodes, all, "", 0)).toEqual({ "": true });
  });

  test("is read back from the opened set", () => {
    expect(openedDepth(nodes, { "": true }, "notes")).toBe(0);
    expect(openedDepth(nodes, { "": true, notes: true }, "notes")).toBe(1);
    expect(openedDepth(nodes, { "": true, notes: true, "notes/daily": true }, "notes")).toBe(2);
    expect(openedDepth(nodes, { "": true }, ""), "the root is always opened").toBe(1);
    expect(openedDepth(nodes, { "": true, notes: true }, ""), "src is still closed").toBe(1);
    expect(openedDepth(nodes, { "": true, notes: true, src: true }, "")).toBe(2);
  });
});

describe("the depth's range follows the selected node", () => {
  test("a directory: the deepest level below it", () => {
    expect(selectionDepthCap(nodes, edges, "directory:notes")).toBe(2);
    expect(selectionDepthCap(nodes, edges, "directory:src")).toBe(1);
    expect(selectionDepthCap(nodes, edges, ""), "the root").toBe(3);
    expect(selectionDepthCap(nodes, edges, null), "nothing selected reads as the root").toBe(3);
  });

  test("a tag, mention or file: the hops its references run", () => {
    expect(selectionDepthCap(nodes, edges, "#t"), "files, then b.md, then alice").toBe(3);
    expect(selectionDepthCap(nodes, edges, "@@alice")).toBe(4);
    expect(selectionDepthCap(nodes, edges, "notes/c.md"), "no references, still 1").toBe(1);
  });

  test("a language: one", () => {
    expect(selectionDepthCap(nodes, edges, "language:Markdown")).toBe(1);
  });

  test("a directory deeper than the server's walk: held to its levels", () => {
    // A chain of 14 directories with a file at the bottom.
    const chain = Array.from({ length: 14 }, (_, i) => Array.from({ length: i + 1 }, (_, j) => `l${j}`).join("/"));
    const deep: ViewNode[] = [
      { id: "", kind: "folder", path: "" },
      ...chain.map((path) => ({ id: directoryNodeId(path), kind: "folder", path })),
      { id: `${chain.at(-1)}/leaf.md`, kind: "file", path: `${chain.at(-1)}/leaf.md` },
    ];
    expect(selectionDepthCap(deep, [], "")).toBe(FS_GRAPH_DEPTH_MAX);
    expect(selectionDepthCap(deep, [], directoryNodeId("l0/l1")), "13 levels below l0/l1").toBe(FS_GRAPH_DEPTH_MAX);
    expect(selectionDepthCap(deep, [], directoryNodeId(chain[9])), "four folders and the file below").toBe(5);
  });
});

describe("the drawn-node budget", () => {
  // Under the root: a/ with 3 folders of 4 files each, and b/ with 2 files.
  // Level 1 is a and b, level 2 the 3 folders and b's 2 files, level 3 the
  // 12 files.
  const tree: ViewNode[] = [{ id: "", kind: "folder", path: "" }];
  for (const dir of ["a", "b", "a/x", "a/y", "a/z"]) tree.push({ id: directoryNodeId(dir), kind: "folder", path: dir });
  for (const dir of ["a/x", "a/y", "a/z"]) {
    for (let i = 0; i < 4; i += 1) tree.push({ id: `${dir}/${i}.md`, kind: "file", path: `${dir}/${i}.md` });
  }
  for (const file of ["b/1.md", "b/2.md"]) tree.push({ id: file, kind: "file", path: file });
  // The root's own level (the root, a and b) always shows and is not
  // counted. Counted at each depth from the root: 0, then 5, then 5 + 12 = 17.
  const root = { "": true };

  test("a depth that fits is applied as asked", () => {
    expect(depthWithinBudget(tree, root, "", 3, 17)).toBe(3);
    expect(depthWithinBudget(tree, root, "", 2, 5)).toBe(2);
  });

  test("a depth past the budget stops at the deepest level that fits", () => {
    expect(depthWithinBudget(tree, root, "", 3, 16)).toBe(2);
    expect(depthWithinBudget(tree, root, "", 3, 4)).toBe(1);
  });

  test("the root's own level shows whatever it draws", () => {
    expect(depthWithinBudget(tree, root, "", 3, 0)).toBe(1);
    expect(depthWithinBudget(tree, root, "", 0, 0), "a closing depth is not raised").toBe(0);
  });

  test("a level is counted only once the folders above it are read", () => {
    // a/ and b/ are read, a/x, a/y and a/z are not: the third level waits
    // for them, at most two at a time.
    const read = (path: string): boolean => !path.startsWith("a/");
    expect(depthStep(tree, root, "", 3, 20, read, 2)).toEqual({ depth: 2, read: ["a/x", "a/y"], limited: false });
    expect(depthStep(tree, root, "", 3, 20, () => true, 2)).toEqual({ depth: 3, read: [], limited: false });
  });

  test("a level already past the budget is not read first", () => {
    // What is known of the third level, 12 notes on top of 5, already
    // passes 16, so its unread folders are not asked for.
    const read = (path: string): boolean => !path.startsWith("a/");
    expect(depthStep(tree, root, "", 3, 16, read, 2)).toEqual({ depth: 2, read: [], limited: true });
  });

  test("an unread directory is read before its first level opens", () => {
    expect(depthStep(tree, root, "a", 2, 20, (path) => path !== "a", 64)).toEqual({ depth: 0, read: ["a"], limited: false });
  });

  test("a first level past the budget does not open, and the root's always shows", () => {
    expect(depthStep(tree, root, "a", 2, 2, () => true, 64)).toEqual({ depth: 0, read: [], limited: true });
    expect(depthStep(tree, root, "", 2, 2, () => true, 64)).toEqual({ depth: 1, read: [], limited: true });
  });

  test("a tree that fits is left as it is", () => {
    expect(closeToBudget(tree, { "": true, a: true, "a/x": true }, 7, new Set(["a/x"]))).toBeNull();
  });

  test("a tree past the budget closes what grew, deepest level first", () => {
    // Open to a/x's notes: 5 + 4 = 9 counted, all of it grown under a.
    const opened = { "": true, a: true, b: true, "a/x": true };
    expect(closeToBudget(tree, opened, 8, new Set(["a"]))).toEqual({ "": true, a: true, b: true });
    expect(closeToBudget(tree, opened, 4, new Set(["a"]))).toEqual({ "": true, b: true });
  });

  test("the root's own level is not counted", () => {
    expect(closeToBudget(tree, { "": true }, 0, new Set([""]))).toBeNull();
    expect(closeToBudget(tree, { "": true, a: true }, 0, new Set(["a"]))).toEqual({ "": true });
  });

  test("the folders the change grew close, and the rest stays", () => {
    // a/x and b are open, 9 counted; a/x grew. Closing a/x alone leaves
    // a's three folders and b's two notes, 5.
    const opened = { "": true, a: true, b: true, "a/x": true };
    expect(closeToBudget(tree, opened, 7, new Set(["a/x"]))).toEqual({ "": true, a: true, b: true });
    // Had b grown, b closes and a/x stays: 3 + 4 = 7.
    expect(closeToBudget(tree, opened, 8, new Set(["b"]))).toEqual({ "": true, a: true, "a/x": true });
  });

  test("a folder that grew keeps its own level, its open subfolders closing first", () => {
    // a grew; a/x is open below it: 3 + 4 = 7 counted. Closing a/x leaves
    // a's own three folders.
    expect(closeToBudget(tree, { "": true, a: true, "a/x": true }, 6, new Set(["a"]))).toEqual({ "": true, a: true });
  });

  test("fitting is counted below the root's own level", () => {
    expect(fitsBudget(new Set(["", "a", "b", "a/x", "b/1.md"]), 2)).toBe(true);
    expect(fitsBudget(new Set(["", "a", "b", "a/x", "b/1.md"]), 1)).toBe(false);
  });

  test("what shows outside the directory counts against the budget", () => {
    // b is opened, so its two files show at every depth of a.
    const opened = { "": true, b: true };
    expect(depthWithinBudget(tree, opened, "a", 2, 16), "x, y, z, 12 files and b's 2 files is 17").toBe(1);
    expect(depthWithinBudget(tree, opened, "a", 2, 17)).toBe(2);
  });
});

describe("opening on a node", () => {
  test("a directory comes with the path down to it and its own children", () => {
    expect(openedFor(nodes, "directory:notes/daily")).toEqual({ "": true, notes: true, "notes/daily": true });
  });

  test("any other node opens only the root's level; the selection reveals the rest", () => {
    expect(openedFor(nodes, "#t")).toEqual({ "": true });
    expect(openedFor(nodes, "notes/daily/d.md")).toEqual({ "": true });
    expect(openedFor(nodes, null)).toEqual({ "": true });
  });

  test("the depth acts on a selected directory, on the root when nothing is selected", () => {
    expect(selectedDirectory(nodes, "directory:notes")).toBe("notes");
    expect(selectedDirectory(nodes, null)).toBe("");
    expect(selectedDirectory(nodes, "")).toBe("");
    expect(selectedDirectory(nodes, "#t")).toBeNull();
    expect(selectedDirectory(nodes, "notes/a.md")).toBeNull();
  });
});

describe("a tab scoped the old way", () => {
  test("reads as the node to select, and the directory to open for a directory scope", () => {
    expect(selectionOfScope("dir:notes/daily")).toEqual({ select: "notes/daily", dir: "notes/daily" });
    expect(selectionOfScope("file:notes/a.md")).toEqual({ select: "notes/a.md", dir: null });
    expect(selectionOfScope("contact:people/alice.md")).toEqual({ select: "people/alice.md", dir: null });
    expect(selectionOfScope("tag:#t")).toEqual({ select: "#t", dir: null });
    expect(selectionOfScope("mention:@@alice")).toEqual({ select: "@@alice", dir: null });
    expect(selectionOfScope("language:Rust"), "a language's node id keeps its prefix").toEqual({
      select: "language:Rust",
      dir: null,
    });
  });

  test("the workspace scope and an unknown shape read as no selection", () => {
    for (const scopeId of ["workspace", "global", "dir:", "git_repo:x", "", ":x"]) {
      expect(selectionOfScope(scopeId), scopeId).toBeNull();
    }
  });

  test("a directory's path opens without a loaded graph", () => {
    expect(openedForPath("notes/daily")).toEqual({ "": true, notes: true, "notes/daily": true });
    expect(openedForPath("")).toEqual({ "": true });
  });
});
