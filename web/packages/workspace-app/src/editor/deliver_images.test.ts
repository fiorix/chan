import { describe, expect, test } from "vitest";

import { rewriteImagePathsForDelivery } from "./deliver_images";

// A pasted Rich Prompt image lands at `.Drafts/{name}/image.png` and is stored
// draft-file-relative (`./image.png`) so the editor preview renders it. The
// composer keeps that markdown; delivery replaces each ref with the bare
// ABSOLUTE on-disk path (+ one trailing space) the target reads: no `![]()`
// wrapper (a leading `!` runs as a shell history expansion), no `#w=N` hint, no
// alt, cwd-independent.
describe("rewriteImagePathsForDelivery", () => {
  const draft = ".Drafts/abc123/draft.md";
  const root = "/home/u/ws";

  test("delivers a draft-relative paste as a bare absolute path + trailing space", () => {
    const out = rewriteImagePathsForDelivery(
      "![](./image.png#w=250) describe this",
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/image.png describe this");
  });

  test("a prompt BEGINNING with an image delivers the path, not `![](`", () => {
    const out = rewriteImagePathsForDelivery("![](./shot.png#w=120)", draft, root);
    expect(out).toBe("/home/u/ws/.Drafts/abc123/shot.png ");
    expect(out).not.toContain("![");
    expect(out).not.toContain("#w=");
  });

  test("drops alt text (the wire is a path, not markdown)", () => {
    const out = rewriteImagePathsForDelivery(
      "![a diagram](./d.png#w=300) here",
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/d.png here");
  });

  test("collapses ref-then-no-space to a single separating space", () => {
    const out = rewriteImagePathsForDelivery("![](./x.png)done", draft, root);
    expect(out).toBe("/home/u/ws/.Drafts/abc123/x.png done");
  });

  test("delivers every ref in a multi-image prompt", () => {
    const out = rewriteImagePathsForDelivery(
      "![](./a.png#w=250)\nand\n![](./b.png#w=250)",
      draft,
      root,
    );
    expect(out).toBe(
      "/home/u/ws/.Drafts/abc123/a.png \nand\n/home/u/ws/.Drafts/abc123/b.png ",
    );
  });

  test("resolves a parent-relative ref out of a nested draft dir", () => {
    const out = rewriteImagePathsForDelivery(
      "![](../shared/logo.png#w=64) x",
      ".Drafts/x/y/draft.md",
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/x/shared/logo.png x");
  });

  test("decodes a percent-encoded name into the real on-disk path", () => {
    const out = rewriteImagePathsForDelivery(
      "![](./My%20Photo.png#w=250)",
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/My Photo.png ");
  });

  // ---- C2: robustness (regex -> parser) ----

  test("rewrites a ref after a tab-indented backtick run, which opens no fence", () => {
    const md = "\t```\n![](./y.png#w=1) real";
    expect(rewriteImagePathsForDelivery(md, draft, root)).toBe(
      "\t```\n/home/u/ws/.Drafts/abc123/y.png real",
    );
  });

  test("does NOT rewrite a ref inside a fenced code block", () => {
    const md = "before\n```\n![](./x.png#w=1)\n```\n![](./y.png#w=1) real";
    const out = rewriteImagePathsForDelivery(md, draft, root);
    expect(out).toBe(
      "before\n```\n![](./x.png#w=1)\n```\n/home/u/ws/.Drafts/abc123/y.png real",
    );
  });

  test("does NOT rewrite a ref inside inline code", () => {
    const md = "use `![](./x.png)` then ![](./y.png) go";
    const out = rewriteImagePathsForDelivery(md, draft, root);
    expect(out).toBe(
      "use `![](./x.png)` then /home/u/ws/.Drafts/abc123/y.png go",
    );
  });

  test("handles a parenthesis in the filename (balanced-paren dest)", () => {
    const out = rewriteImagePathsForDelivery(
      "![](./shot(1).png#w=100) k",
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/shot(1).png k");
  });

  test("a space in an unbracketed dest is a title boundary: left verbatim", () => {
    // Per CommonMark a raw space in a non-angle destination begins a title, so
    // `./my (photo).png` is not a resolvable path; leave the ref as written
    // rather than fabricate a wrong path. (Angle-bracket it to deliver a spaced
    // name, per the case above.)
    const md = "![](./my (photo).png#w=100) k";
    expect(rewriteImagePathsForDelivery(md, draft, root)).toBe(md);
  });

  test("drops a title and delivers just the path", () => {
    const out = rewriteImagePathsForDelivery(
      '![alt](./x.png "a title") k',
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/x.png k");
  });

  test("unwraps an angle-bracketed destination", () => {
    const out = rewriteImagePathsForDelivery(
      "![](<./my photo.png>) k",
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/my photo.png k");
  });

  test("handles a `]` inside the alt text (balanced brackets)", () => {
    const out = rewriteImagePathsForDelivery(
      "![a [x] b](./y.png#w=100) k",
      draft,
      root,
    );
    expect(out).toBe("/home/u/ws/.Drafts/abc123/y.png k");
  });

  test("leaves external refs untouched", () => {
    const md =
      "![](https://example.com/x.png) ![](data:image/png;base64,AAAA) ![](blob:abc)";
    expect(rewriteImagePathsForDelivery(md, draft, root)).toBe(md);
  });

  test("leaves non-image text untouched", () => {
    const md = "just some [a link](./note.md) and prose";
    expect(rewriteImagePathsForDelivery(md, draft, root)).toBe(md);
  });

  test("no-ops without a draft path or workspace root", () => {
    const md = "![](./image.png#w=250)";
    expect(rewriteImagePathsForDelivery(md, null, root)).toBe(md);
    expect(rewriteImagePathsForDelivery(md, draft, null)).toBe(md);
  });

  test("leaves a ref that escapes the workspace root untouched", () => {
    const out = rewriteImagePathsForDelivery(
      "![](../../../etc/passwd#w=1) x",
      ".Drafts/x/draft.md",
      root,
    );
    expect(out).toBe("![](../../../etc/passwd#w=1) x");
  });
});
