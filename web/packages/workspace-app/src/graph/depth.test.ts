import { describe, expect, it } from "vitest";
import { shallowestFileDepth } from "./depth";
import type { GraphViewNode } from "../api/types";

function file(path: string): Extract<GraphViewNode, { kind: "file" }> {
  return { kind: "file", id: path, label: path, path };
}

function folder(path: string): Extract<GraphViewNode, { kind: "folder" }> {
  return { kind: "folder", id: path, label: path, path, files: 0, code: 0 };
}

function media(path: string): Extract<GraphViewNode, { kind: "media" }> {
  return { kind: "media", id: path, label: path, path };
}

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
