// @vitest-environment jsdom

// The walker forces the parse through the viewport before it walks.
// `syntaxTree(state)` is lazy and budgeted: past the initial parse it can hand
// back a tree whose visible list block is not parsed yet, so `- foo` still
// reads as a paragraph and renders a raw marker until an unrelated recompute.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { afterEach, describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { decorationWalker, type TokenContext } from "./walker";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

describe("decoration walker forces the parse for the viewport", () => {
  test("decorates a list in the viewport that the lazy parse has not reached", () => {
    // Long prose lines, so the initial lazy parse covers only the first few
    // while the viewport reaches much further down.
    const prose = `${"lorem ipsum ".repeat(20)}\n`;
    const doc = `${prose.repeat(30)}\n- a bullet past the lazy parse\n\n${prose.repeat(30)}`;
    const bullet = doc.indexOf("- a bullet");

    const lazyEnd = syntaxTree(EditorState.create({ doc, extensions: [chanMarkdown()] })).length;
    expect(bullet, "the bullet lies past the lazily parsed prefix").toBeGreaterThan(lazyEnd);

    const hits = new Set<number>();
    const walker = decorationWalker({
      BulletList: (ctx: TokenContext) => hits.add(ctx.node.from),
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [chanMarkdown(), walker] }),
    });
    views.push(view);

    expect(view.viewport.to, "the bullet is inside the walked viewport").toBeGreaterThan(bullet);
    expect(hits.has(bullet)).toBe(true);
  });

  test("decorates at least every viewport list the lazy tree exposes", () => {
    const walkerHits = new Set<number>();
    const walker = decorationWalker({
      BulletList: (ctx: TokenContext) => walkerHits.add(ctx.node.from),
    });
    const block = "prose paragraph line\n".repeat(40) + "- a bullet item\n";
    const doc = block.repeat(100);
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [chanMarkdown(), walker] }),
    });
    views.push(view);

    const { from, to } = view.viewport;
    const lazyBullets = new Set<number>();
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(n) {
        if (n.name === "BulletList") lazyBullets.add(n.from);
      },
    });

    for (const pos of lazyBullets) expect(walkerHits.has(pos)).toBe(true);
  });
});
