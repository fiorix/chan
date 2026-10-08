// @vitest-environment jsdom
//
// Which paths a workspace window treats as a draft's. A draft is kept outside
// the workspace and reaches the client as a marked path carrying its lifetime
// id, so the mark alone decides: no directory of the workspace is the drafts
// directory, and a folder named `.Drafts` is an ordinary folder. A standalone
// window's rule, a directory of the machine, is pinned in
// standaloneBootstrap.test.ts.

import { describe, expect, test } from "vitest";
import { draftClientPath } from "../api/fileIdentity";
import { draftsDir, isDraftPath } from "./workspace.svelte";

describe("a workspace window", () => {
  test("a draft's client path is a draft path, its primary and its other files alike", () => {
    expect(isDraftPath(draftClientPath({ path: "untitled/draft.md", draft_id: "life-1" }))).toBe(true);
    expect(isDraftPath(draftClientPath({ path: "untitled/image.png", draft_id: "life-1" }))).toBe(true);
  });

  test("a workspace file at a draft's server path is not a draft", () => {
    expect(isDraftPath("untitled/draft.md")).toBe(false);
  });

  test("a folder named .Drafts is an ordinary folder", () => {
    expect(isDraftPath(".Drafts")).toBe(false);
    expect(isDraftPath(".Drafts/untitled/draft.md")).toBe(false);
  });

  test("no directory of the workspace is the drafts directory", () => {
    expect(draftsDir()).toBe(null);
  });
});
