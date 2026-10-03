// @vitest-environment jsdom
//
// Locks in the ref-aware Link fix: `[[foo] bar](path)` (a `[label](url)` whose
// label carries a balanced inner bracket pair) must form a real outer link.
//
// Without RefAwareLink, @lezer/markdown greedily parses the inner `[foo]` as a
// shortcut-reference Link and the no-nested-links rule kills the enclosing
// `[..](path)`, leaving the whole construct as raw text (the four
// `linkMarks.length < 4` decoration guards then punt). The first block exercises
// the parser directly; the second mounts a live editor and asserts the
// decoration surface.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { InlineContext, parser as lezerParser, type InlineParser } from "@lezer/markdown";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "./grammar";
import { chanDecorations } from "../decorations";

const mdParser = chanMarkdown().language.parser;

type Child = { name: string; from: number; to: number };
type NodeInfo = { name: string; from: number; to: number; children: Child[] };

/// Collect every node named `name` in the configured parse tree, each with
/// its direct-child node names + ranges (label text is plain inline content,
/// so a clean `[label](url)` carries no child nodes beyond LinkMark + URL).
function nodesOf(doc: string, name: string): NodeInfo[] {
  const tree = mdParser.parse(doc);
  const out: NodeInfo[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.name === name) {
      const children: Child[] = [];
      const inner = cursor.node.cursor();
      if (inner.firstChild()) {
        do {
          children.push({ name: inner.name, from: inner.from, to: inner.to });
        } while (inner.nextSibling());
      }
      out.push({
        name: cursor.name,
        from: cursor.from,
        to: cursor.to,
        children,
      });
    }
  } while (cursor.next());
  return out;
}

function countChild(info: NodeInfo, name: string): number {
  return info.children.filter((c) => c.name === name).length;
}

function urlText(doc: string, info: NodeInfo): string | null {
  const url = info.children.find((c) => c.name === "URL");
  return url ? doc.slice(url.from, url.to) : null;
}

describe("RefAwareLink parser", () => {
  test("pinned Lezer exposes the link delimiter internals used by RefAwareLink", () => {
    let inspected = false;
    const probe: InlineParser = {
      name: "RefAwareLinkInternals",
      before: "LinkEnd",
      parse(cx, next, position) {
        if (next !== 93 || position !== 5) return -1;
        inspected = true;
        const parts = (cx as unknown as { parts?: unknown }).parts;
        expect(Array.isArray(parts), "InlineContext.parts must remain an array").toBe(true);
        const starts = (parts as Array<{ type?: unknown; from?: unknown; to?: unknown; side?: unknown } | null>)
          .filter((part) => part?.type === InlineContext.linkStart);
        expect(
          starts.map((part) => ({ from: part?.from, to: part?.to, side: part?.side })),
          "link delimiters in InlineContext.parts must retain their side field",
        ).toEqual([
          { from: 0, to: 1, side: 1 },
          { from: 1, to: 2, side: 1 },
        ]);
        return -1;
      },
    };

    lezerParser.configure({ parseInline: [probe] }).parse("[[foo] bar](path)");
    expect(inspected, "the parser must visit the inner closing bracket").toBe(true);
  });

  test("`[[foo] bar](path)` forms one 4-mark outer Link with URL `path`", () => {
    const doc = "[[foo] bar](path)";
    const links = nodesOf(doc, "Link");
    expect(links.length).toBe(1);
    const outer = links[0]!;
    expect(countChild(outer, "LinkMark")).toBe(4);
    expect(countChild(outer, "URL")).toBe(1);
    expect(urlText(doc, outer)).toBe("path");
  });

  test("`[label](path)` stays an unbroken 4-mark Link", () => {
    const doc = "[label](path)";
    const links = nodesOf(doc, "Link");
    expect(links.length).toBe(1);
    expect(countChild(links[0]!, "LinkMark")).toBe(4);
    expect(urlText(doc, links[0]!)).toBe("path");
  });

  test("`[text [nested](url) more](url2)` keeps nested-link semantics", () => {
    const doc = "[text [nested](url) more](url2)";
    const links = nodesOf(doc, "Link");
    // The inner `[nested](url)` link still forms.
    const inner = links.find((l) => urlText(doc, l) === "url");
    expect(inner).toBeTruthy();
    // The enclosing `[..](url2)` must NOT form a whole-string 4-mark link.
    const spanning = links.find(
      (l) =>
        l.from === 0 && l.to === doc.length && countChild(l, "LinkMark") === 4,
    );
    expect(spanning).toBeUndefined();
  });

  test("`[foo]` stays a 2-mark shortcut ref (no URL)", () => {
    const links = nodesOf("[foo]", "Link");
    expect(links.length).toBe(1);
    expect(countChild(links[0]!, "LinkMark")).toBe(2);
    expect(countChild(links[0]!, "URL")).toBe(0);
  });

  test("`[foo][bar]` stays a full reference link (carries a LinkLabel)", () => {
    const links = nodesOf("[foo][bar]", "Link");
    expect(links.some((l) => countChild(l, "LinkLabel") > 0)).toBe(true);
  });

  test("`[a [b] c]` does not become a 4-mark link", () => {
    const doc = "[a [b] c]";
    const links = nodesOf(doc, "Link");
    const fourMarkWithUrl = links.find(
      (l) => countChild(l, "LinkMark") === 4 && countChild(l, "URL") > 0,
    );
    expect(fourMarkWithUrl).toBeUndefined();
  });

  test("`![[foo] bar](img)` forms a 4-mark Image with URL `img`", () => {
    const doc = "![[foo] bar](img)";
    const images = nodesOf(doc, "Image");
    expect(images.length).toBe(1);
    expect(countChild(images[0]!, "LinkMark")).toBe(4);
    expect(urlText(doc, images[0]!)).toBe("img");
  });
});

describe("RefAwareLink decorations", () => {
  test("`[[foo] bar](https://example.com)` decorates as a link", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        // External URL: a relative path would route to the wikilink walker.
        doc: "[[foo] bar](https://example.com)",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    expect(parent.querySelector(".cm-md-link")).toBeTruthy();

    view.destroy();
    parent.remove();
  });

  test("`[a [b] c]` stays undecorated (no link)", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "[a [b] c]",
        extensions: [chanMarkdown(), chanDecorations()],
      }),
    });

    expect(parent.querySelector(".cm-md-link")).toBeNull();

    view.destroy();
    parent.remove();
  });
});
