import { describe, expect, test } from "vitest";
import type { IndexingStateNode, IndexingStateResponse } from "../api/types";
import {
  dirsAbove,
  drawnIndexingNodes,
  drawnOpenedDirs,
  sameIndexingState,
  withoutVanishedDirs,
} from "./indexingSpine";

function node(path: string, children_count = 0, state: IndexingStateNode["state"] = "indexed"): IndexingStateNode {
  return { path, state, children_count };
}

// root -> docs -> docs/api -> docs/api/v1, and notes -> notes/deep.
const tree = [
  node("", 2),
  node("docs", 1),
  node("docs/api", 1),
  node("docs/api/v1"),
  node("notes", 1),
  node("notes/deep"),
];

function drawn(opened: string[], nodes: IndexingStateNode[] = tree): string[] {
  return drawnIndexingNodes(nodes, opened).map((n) => n.path);
}

describe("the opened directories the slide asks for", () => {
  test("are the ones with every directory above them opened, sorted and listed once", () => {
    expect(drawnOpenedDirs([])).toEqual([]);
    expect(drawnOpenedDirs(["notes", "docs/api", "docs", "docs"])).toEqual(["docs", "docs/api", "notes"]);
  });

  test("leave out a directory kept opened under one that was closed", () => {
    expect(drawnOpenedDirs(["docs/api", "docs/api/v1", "notes"])).toEqual(["notes"]);
  });

  test("never name the root, which is always open", () => {
    expect(drawnOpenedDirs(["", "docs"])).toEqual(["docs"]);
  });
});

describe("the directories the slide draws from an answer", () => {
  test("are the root's level with nothing opened", () => {
    expect(drawn([])).toEqual(["", "docs", "notes"]);
  });

  test("gain the level of each opened directory", () => {
    expect(drawn(["docs"])).toEqual(["", "docs", "docs/api", "notes"]);
    expect(drawn(["docs", "docs/api", "notes"])).toEqual(tree.map((n) => n.path));
  });

  test("leave out what sits under a closed directory, though the answer lists it", () => {
    // `docs/api` stays in the list from before `docs` was closed.
    expect(drawn(["docs/api"])).toEqual(["", "docs", "notes"]);
  });

  test("keep a directory named for an Object member closed until it is opened", () => {
    const named = [node("", 1), node("constructor", 1), node("constructor/toString", 1), node("constructor/toString/x")];
    expect(drawn([], named)).toEqual(["", "constructor"]);
    expect(drawnOpenedDirs(["constructor/toString"])).toEqual([]);
    expect(drawn(["constructor"], named)).toEqual(["", "constructor", "constructor/toString"]);
  });
});

describe("the directories above a path", () => {
  test("run from the root's own directory down to the path's parent", () => {
    expect(dirsAbove("docs/api/v1")).toEqual(["docs", "docs/api"]);
    expect(dirsAbove("docs")).toEqual([]);
    expect(dirsAbove("")).toEqual([]);
  });

  test("keep a directory named for an Object member", () => {
    expect(dirsAbove("__proto__/constructor/x")).toEqual(["__proto__", "__proto__/constructor"]);
  });
});

describe("the opened list after an answer", () => {
  const opened = ["docs", "docs/api", "docs/api/v1", "notes", "old/kept"];

  test("is the list itself when the answer lists every directory asked for", () => {
    const asked = ["docs", "docs/api", "docs/api/v1", "notes"];
    expect(withoutVanishedDirs(opened, asked, tree)).toBe(opened);
  });

  test("loses a directory the answer no longer lists, with what was opened below it", () => {
    // docs/api is gone from disk: its parent's level is listed without it.
    const nodes = tree.filter((n) => !n.path.startsWith("docs/api"));
    const asked = ["docs", "docs/api", "docs/api/v1", "notes"];
    expect(withoutVanishedDirs(opened, asked, nodes)).toEqual(["docs", "notes", "old/kept"]);
  });

  test("keeps a directory that was not asked for, since no listed level could hold it", () => {
    // old/kept waits under a closed directory; the answer says nothing of it.
    expect(withoutVanishedDirs(opened, ["notes"], [node("", 1), node("notes", 1)])).toBe(opened);
  });

  test("is the list itself for an answer with no root, which lists no level", () => {
    expect(withoutVanishedDirs(opened, ["docs", "notes"], [])).toBe(opened);
  });

  test("does not take a sibling whose name starts with a lost directory's", () => {
    const list = ["doc", "docs", "docs/api"];
    const nodes = [node("", 1), node("docs", 1), node("docs/api")];
    expect(withoutVanishedDirs(list, ["doc", "docs"], nodes)).toEqual(["docs", "docs/api"]);
  });
});

describe("two answers", () => {
  const answer = (nodes: IndexingStateNode[]): IndexingStateResponse => ({ root: "/ws", nodes });

  test("are the same when they list the same directories in the same states", () => {
    expect(sameIndexingState(answer(tree), answer(tree.map((n) => ({ ...n }))))).toBe(true);
    expect(sameIndexingState(null, null)).toBe(true);
  });

  test("differ by a state, a directory, a count of directories held, the root, or one being absent", () => {
    const base = answer([node("", 1), node("docs")]);
    expect(sameIndexingState(base, answer([node("", 1), node("docs", 0, "indexing")]))).toBe(false);
    expect(sameIndexingState(base, answer([node("", 1), node("notes")]))).toBe(false);
    expect(sameIndexingState(base, answer([node("", 1), node("docs"), node("notes")]))).toBe(false);
    expect(sameIndexingState(base, answer([node("", 1), node("docs", 2)]))).toBe(false);
    expect(sameIndexingState(base, { ...base, root: "/other" })).toBe(false);
    expect(sameIndexingState(base, null)).toBe(false);
    expect(sameIndexingState(null, base)).toBe(false);
  });
});
