import { describe, expect, test, vi } from "vitest";

import { draftClientPath } from "../api/fileIdentity";
import {
  draftImagesForDelivery,
  resolveDraftImagePaths,
  rewriteImagePathsForDelivery,
} from "./deliver_images";

// A pasted Rich Prompt image lands beside the prompt's file and is stored
// file-relative (`./image.png`) so the editor preview renders it. The
// composer keeps that markdown; delivery replaces each ref with the bare
// ABSOLUTE on-disk path (+ one trailing space) the target reads: no `![]()`
// wrapper (a leading `!` runs as a shell history expansion), no `#w=N` hint, no
// alt, cwd-independent. The cases below run on a file under the root, here
// in a folder named `.Drafts`; a workspace's draft has cases of its own after
// them.
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

  // ---- robustness ----

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

// A workspace's draft is kept outside the root, where only the server knows.
// Its images are delivered by the paths the server gives for them, asked for
// by the client path each ref resolves to.
describe("a workspace draft's images", () => {
  const draft = draftClientPath({ path: "rp/draft.md", draft_id: "life-rp" });
  const shot = draftClientPath({ path: "rp/shot.png", draft_id: "life-rp" });
  const scan = draftClientPath({ path: "rp/scan.png", draft_id: "life-rp" });
  const root = "/home/me/ws";
  const onServer = (name: string) => `/home/me/.chan/workspaces/k/Drafts/rp/${name}`;

  test("are found for the question to the server: each once, and nothing external, in code or under the root", () => {
    const text =
      "a ![](shot.png) b ![alt](./shot.png#w=200) c ![](https://x.test/y.png) `![](code.png)` ![](/notes/pic.png) ![](scan.png)";

    expect(draftImagesForDelivery(text, draft)).toEqual([shot, scan]);
    expect(draftImagesForDelivery("no image here", draft)).toEqual([]);
    expect(draftImagesForDelivery("![](shot.png)", "notes/a.md"), "a workspace file's refs").toEqual([]);
    expect(draftImagesForDelivery("![](shot.png)", null)).toEqual([]);
  });

  test("are delivered by the server's path, and a workspace image beside them by the root's", () => {
    const out = rewriteImagePathsForDelivery(
      "see ![](shot.png) and ![](/notes/pic.png)",
      draft,
      root,
      new Map([[shot, onServer("shot.png")]]),
    );

    expect(out).toBe(`see ${onServer("shot.png")} and ${root}/notes/pic.png `);
  });

  test("are left as written when the server gave no path for them", () => {
    expect(rewriteImagePathsForDelivery("see ![](shot.png) now", draft, root)).toBe("see ![](shot.png) now");
    expect(
      rewriteImagePathsForDelivery("![](shot.png) ![](scan.png)", draft, root, new Map([[scan, onServer("scan.png")]])),
    ).toBe(`![](shot.png) ${onServer("scan.png")} `);
  });

  test("paths are asked for in one question and answered by client path", async () => {
    const ask = vi.fn(async (paths: string[]) => paths.map((path) => onServer(path.endsWith("shot.png") ? "shot.png" : "scan.png")));

    const paths = await resolveDraftImagePaths([shot, scan], ask);

    expect(ask.mock.calls).toEqual([[[shot, scan]]]);
    expect([...paths]).toEqual([
      [shot, onServer("shot.png")],
      [scan, onServer("scan.png")],
    ]);
  });

  test("after a refusal of the whole question each is asked for alone, and a refused one has no path", async () => {
    const ask = vi.fn(async (paths: string[]) => {
      if (paths.length > 1 || paths[0] === shot) throw new Error("draft_stale");
      return [onServer("scan.png")];
    });

    const paths = await resolveDraftImagePaths([shot, scan], ask);

    expect(ask.mock.calls).toEqual([[[shot, scan]], [[shot]], [[scan]]]);
    expect([...paths]).toEqual([[scan, onServer("scan.png")]]);
  });

  test("no question is asked for no image", async () => {
    const ask = vi.fn(async () => []);

    expect([...(await resolveDraftImagePaths([], ask))]).toEqual([]);
    expect(ask).not.toHaveBeenCalled();
  });
});
