import { describe, expect, it } from "vitest";

import {
  clientPathOf,
  displayPath,
  draftClientPath,
  draftDirOf,
  fileIdentityOf,
  inSameDraft,
  isDraftClientPath,
  persistedPath,
  revivedPath,
  showMarked,
  storageKeyPart,
} from "./fileIdentity";

const MARK = String.fromCharCode(0);

describe("a draft's identity inside its client path", () => {
  const primary = { root: "draft" as const, path: "untitled/draft.md", draft_id: "v1:a/b%c" };

  it("round-trips an identity whose id holds a slash, a percent and a colon", () => {
    const path = clientPathOf(primary);
    expect(isDraftClientPath(path), "a draft path is marked").toBe(true);
    expect(fileIdentityOf(path), "the identity read back").toEqual(primary);
  });

  it("keeps the draft's directory as one component", () => {
    const path = draftClientPath(primary);
    expect(path.split("/").length, "components of untitled/draft.md").toBe(2);
    expect(draftDirOf(path), "the directory of the primary").toBe(path.split("/")[0]);
    expect(draftDirOf(`${draftDirOf(path)}/image.png`), "a sibling's directory").toBe(
      draftDirOf(path),
    );
  });

  it("never equals a workspace path of the same spelling", () => {
    const path = draftClientPath(primary);
    expect(path, "against the user's untitled/draft.md").not.toBe("untitled/draft.md");
    expect(isDraftClientPath("untitled/draft.md"), "a workspace path").toBe(false);
    expect(fileIdentityOf("untitled/draft.md"), "a workspace identity").toEqual({
      root: "workspace",
      path: "untitled/draft.md",
    });
    expect(draftDirOf("untitled/draft.md"), "a workspace path has no draft directory").toBeNull();
  });

  it("tells two lifetimes of one name apart", () => {
    const first = draftClientPath({ path: "untitled/draft.md", draft_id: "id-1" });
    const second = draftClientPath({ path: "untitled/draft.md", draft_id: "id-2" });
    expect(first, "a reused name under a new id").not.toBe(second);
    expect(inSameDraft(first, second), "two lifetimes").toBe(false);
    expect(
      inSameDraft(first, draftClientPath({ path: "untitled/image.png", draft_id: "id-1" })),
      "two files of one lifetime",
    ).toBe(true);
    expect(inSameDraft("untitled/draft.md", "untitled/image.png"), "two workspace files").toBe(
      false,
    );
  });

  it("refuses a marked string that is not a whole draft path", () => {
    for (const damaged of [MARK, `${MARK}id`, `${MARK}:untitled/draft.md`, `${MARK}id:`]) {
      expect(() => fileIdentityOf(damaged), JSON.stringify(damaged)).toThrow("malformed draft path");
    }
    expect(() => clientPathOf({ root: "draft", path: "untitled/draft.md" }), "no id").toThrow(
      "draft_id",
    );
  });
});

describe("what leaves memory in place of a draft's client path", () => {
  const path = draftClientPath({ path: "untitled/draft.md", draft_id: "v1:abc" });

  it("displays a draft under Drafts and a workspace path as it is", () => {
    expect(displayPath(path), "a draft").toBe("Drafts/untitled/draft.md");
    expect(displayPath("notes/a.md"), "a workspace path").toBe("notes/a.md");
    expect(displayPath(path), "no mark shown").not.toContain(MARK);
    expect(displayPath(path), "no id shown").not.toContain("abc");
  });

  it("rewrites a marked path inside a sentence", () => {
    const shown = showMarked(`${path} was not saved; ${path} stays open`);
    expect(shown, "both occurrences").toBe(
      "Drafts/untitled/draft.md was not saved; Drafts/untitled/draft.md stays open",
    );
    expect(showMarked("notes/a.md was saved"), "a sentence with no mark").toBe(
      "notes/a.md was saved",
    );
    expect(showMarked(`lost ${MARK}`), "a stray mark").not.toContain(MARK);
  });

  it("persists the server's path with the lifetime id and restores the same path", () => {
    const saved = persistedPath(path);
    expect(saved, "a draft's saved form").toEqual({ p: "untitled/draft.md", d: "v1:abc" });
    expect(JSON.stringify(saved), "the saved text").not.toContain("u0000");
    expect(revivedPath(saved), "restored").toBe(path);
    expect(persistedPath("notes/a.md"), "a workspace path's saved form").toEqual({ p: "notes/a.md" });
    expect(revivedPath({ p: "notes/a.md" }), "a workspace path restored").toBe("notes/a.md");
  });

  it("restores nothing from a saved path that holds the mark", () => {
    expect(revivedPath({ p: path }), "a workspace-typed entry").toBeNull();
    expect(revivedPath({ p: path, d: "v1:abc" }), "a draft-typed entry").toBeNull();
  });

  it("names a draft in a storage key without the mark", () => {
    const draft = storageKeyPart(path);
    expect(draft.draft, "a draft's key is flagged").toBe(true);
    expect(draft.part, "no mark in the key").not.toContain(MARK);
    expect(draft.part, "the key's part").toBe("v1%3Aabc:untitled/draft.md");
    expect(storageKeyPart("notes/a.md"), "a workspace path's part").toEqual({
      draft: false,
      part: "notes/a.md",
    });
  });
});
