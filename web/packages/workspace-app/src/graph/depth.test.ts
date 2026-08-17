import { describe, expect, it } from "vitest";
import { FS_GRAPH_DEPTH_MAX, graphDepthCap, shallowestFileDepth } from "./depth";
import type { FsGraphNode, GraphViewNode } from "../api/types";

function file(path: string): Extract<GraphViewNode, { kind: "file" }> {
  return { kind: "file", id: path, label: path, path };
}

function folder(path: string): Extract<GraphViewNode, { kind: "folder" }> {
  return { kind: "folder", id: path, label: path, path, files: 0, code: 0 };
}

function media(path: string): Extract<GraphViewNode, { kind: "media" }> {
  return { kind: "media", id: path, label: path, path };
}

function fsNode(path: string): Pick<FsGraphNode, "path"> {
  return { path };
}

describe("graphDepthCap", () => {
  it("pins file scopes to depth 1", () => {
    expect(graphDepthCap({ scope: { kind: "file" }, nodes: [] })).toBe(1);
  });

  it("caps group scopes at the number of files up to the hard max", () => {
    expect(
      graphDepthCap({
        scope: { kind: "group", paths: ["a.md", "b.md", "c.md"] },
        nodes: [],
      }),
    ).toBe(3);
    expect(
      graphDepthCap({
        scope: {
          kind: "group",
          paths: Array.from({ length: 20 }, (_, i) => `${i}.md`),
        },
        nodes: [],
      }),
    ).toBe(10);
  });

  it("derives directory depth from loaded content graph file paths", () => {
    expect(
      graphDepthCap({
        scope: { kind: "dir", path: "notes" },
        nodes: [
          file("notes/today.md"),
          file("notes/projects/chan/todo.md"),
          file("outside/deep/file.md"),
        ],
      }),
    ).toBe(3);
  });

  it("derives directory depth from the loaded fs graph and honors truncation", () => {
    expect(
      graphDepthCap({
        scope: { kind: "dir", path: "notes" },
        nodes: [],
        fsGraph: {
          truncated: false,
          nodes: [
            fsNode("notes"),
            fsNode("notes/projects"),
            fsNode("notes/projects/chan/todo.md"),
          ],
        },
      }),
    ).toBe(3);
    expect(
      graphDepthCap({
        scope: { kind: "dir", path: "notes" },
        nodes: [],
        fsGraph: { truncated: true, nodes: [fsNode("notes/projects")] },
      }),
    ).toBe(FS_GRAPH_DEPTH_MAX);
  });

  it("uses the workspace fs graph probe for workspace and global scopes", () => {
    expect(
      graphDepthCap({
        scope: { kind: "workspace" },
        nodes: [],
        fsGraph: {
          truncated: false,
          nodes: [fsNode("a.md"), fsNode("notes/projects/chan/todo.md")],
        },
      }),
    ).toBe(4);
    expect(
      graphDepthCap({
        scope: { kind: "global" },
        nodes: [],
        fsGraph: { truncated: true, nodes: [fsNode("notes/projects")] },
      }),
    ).toBe(FS_GRAPH_DEPTH_MAX);
  });

  it("keeps tag and git repo scopes on the hard max", () => {
    expect(graphDepthCap({ scope: { kind: "tag" }, nodes: [] })).toBe(10);
    expect(graphDepthCap({ scope: { kind: "git_repo" }, nodes: [] })).toBe(10);
  });

  // The depth slider can snap back to 1 when the cap is derived
  // from the fs-graph LOADED AT THE CURRENT DEPTH. At depth 1 only
  // the depth-1 layer is loaded, so the cap collapses to 1 even
  // when deeper structure exists. These cases prove the cap depends
  // on WHICH fs-graph is fed in: a shallow loaded slice caps at 1,
  // but a full-depth probe of the same directory exposes the real
  // reachable depth. GraphPanel feeds `graphDepthCap` the
  // full-depth `dirDepthProbe` for a dir scope.
  it("caps a dir at 1 from a depth-1 loaded slice but at the true depth from a full-depth probe", () => {
    const dir = { kind: "dir", path: "journals" } as const;
    // Slice loaded at depth 1: only the directory's depth-1 child dir.
    const shallowSlice = {
      truncated: false,
      nodes: [fsNode("journals"), fsNode("journals/year-1")],
    };
    expect(graphDepthCap({ scope: dir, nodes: [], fsGraph: shallowSlice })).toBe(1);
    // Full-depth probe of the same dir reaches 3 levels deep
    // (relative depth 3 from `journals`).
    const fullProbe = {
      truncated: false,
      nodes: [
        fsNode("journals"),
        fsNode("journals/year-1"),
        fsNode("journals/year-1/month-1"),
        fsNode("journals/year-1/month-1/entry.md"),
      ],
    };
    expect(graphDepthCap({ scope: dir, nodes: [], fsGraph: fullProbe })).toBe(3);
  });
});

describe("shallowestFileDepth", () => {
  it("is 1 when the directory holds files among its immediate children", () => {
    expect(
      shallowestFileDepth("notes", [
        folder("notes/sub"),
        file("notes/a.md"),
        file("notes/sub/deep.md"),
      ]),
    ).toBe(1);
  });

  it("reaches past directory-only levels to the first file below them", () => {
    // The case "Graph from here" comes up empty on: every immediate child
    // is a directory, so a one-level view has no file in it at all.
    expect(
      shallowestFileDepth("crates", [
        folder("crates/one"),
        folder("crates/two"),
        file("crates/one/lib.rs"),
        file("crates/two/deeper/mod.rs"),
      ]),
    ).toBe(2);
  });

  it("is 0 for a directory whose subtree holds no file", () => {
    expect(shallowestFileDepth("empty", [folder("empty/sub")])).toBe(0);
  });

  it("ignores files outside the scope root", () => {
    // Directory scope seeds file nodes workspace-wide, so out-of-prefix
    // paths reach this and must not decide the depth.
    expect(
      shallowestFileDepth("notes", [file("elsewhere.md"), file("notes/x/y.md")]),
    ).toBe(2);
    expect(shallowestFileDepth("notes", [file("elsewhere.md")])).toBe(0);
  });

  it("counts media files as content", () => {
    expect(shallowestFileDepth("assets", [media("assets/logo.png")])).toBe(1);
  });
});
