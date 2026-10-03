// @vitest-environment jsdom

// The walker walks a tree that reaches the end of the viewport.
// `syntaxTree(state)` is lazy and budgeted: it can hand back a tree that stops
// short of a visible list block, so `- foo` renders a raw marker until an
// unrelated recompute. The walker forces the parse through the viewport then,
// and only then: a tree that already reaches past the viewport is the parse of
// every visible line, and parsing again would cost a whole pass over a block
// that outruns the viewport.

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { afterEach, describe, expect, test, vi } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { decorationWalker, type TokenContext } from "./walker";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(doc: string, extensions: Extension[]): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc, extensions }) });
  views.push(view);
  return view;
}

/// Every reading of the clock is 30 ms after the last, so a parser step
/// outlasts the 20 ms a state update gives the parse. The step that takes a
/// paragraph takes it whole, so the update leaves a tree that reaches the
/// paragraph's end although its parse did not finish in time.
function slowClock(): void {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => (now += 30));
}

/// The positions in `from..to` where a whole parse of `doc` has a `name` node.
function wholeParse(doc: string, name: string, from: number, to: number): number[] {
  const at: number[] = [];
  chanMarkdown().language.parser.parse(doc).iterate({
    from,
    to,
    enter(node) {
      if (node.name === name) at.push(node.from);
    },
  });
  return at;
}

/// One paragraph of a thousand lines, which outruns the viewport.
const LONG_PARAGRAPH = Array.from({ length: 1000 }, () => "a line with **strong** text").join("\n");

/// A view over `LONG_PARAGRAPH` on the slow clock, with the count of the
/// parses the language starts and the positions the walker's handlers saw.
function longParagraphView(): {
  view: EditorView;
  starts: { mock: { calls: unknown[][] }; mockClear(): unknown };
  strong: number[];
  lists: number[];
} {
  slowClock();
  const support = chanMarkdown();
  const starts = vi.spyOn(support.language.parser, "createParse");
  const strong: number[] = [];
  const lists: number[] = [];
  const walker = decorationWalker({
    StrongEmphasis: (ctx: TokenContext) => strong.push(ctx.node.from),
    BulletList: (ctx: TokenContext) => lists.push(ctx.node.from),
  });
  const view = mount(LONG_PARAGRAPH, [support, walker]);
  expect(view.viewport.to, "the paragraph outruns the viewport").toBeLessThan(LONG_PARAGRAPH.length);
  expect(syntaxTree(view.state).length, "the tree in hand reaches past the viewport").toBeGreaterThanOrEqual(
    view.viewport.to,
  );
  return { view, starts, strong, lists };
}

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

  test("decorates a list marker typed at a line start past the lazily parsed prefix, in the same update", () => {
    const prose = `${"lorem ipsum ".repeat(20)}\n`;
    const doc = `${prose.repeat(30)}\na line past the lazy parse\n\n${prose.repeat(30)}`;
    const line = doc.indexOf("a line past");
    const lazyEnd = syntaxTree(EditorState.create({ doc, extensions: [chanMarkdown()] })).length;
    expect(line, "the line lies past the lazily parsed prefix").toBeGreaterThan(lazyEnd);

    const hits: number[] = [];
    const view = mount(doc, [
      chanMarkdown(),
      decorationWalker({ BulletList: (ctx: TokenContext) => hits.push(ctx.node.from) }),
    ]);
    expect(view.viewport.to, "the line is inside the walked viewport").toBeGreaterThan(line);
    expect(hits, "no list before the marker").toEqual([]);

    view.dispatch({ changes: { from: line, insert: "- " } });
    expect(hits).toContain(line);
  });

  test("decorates a list below the viewport when it scrolls in", () => {
    const prose = "prose paragraph line\n\n";
    const doc = `${prose.repeat(400)}- a bullet far down\n\n${prose.repeat(400)}`;
    const bullet = doc.indexOf("- a bullet");

    const hits: number[] = [];
    const view = mount(doc, [
      chanMarkdown(),
      decorationWalker({ BulletList: (ctx: TokenContext) => hits.push(ctx.node.from) }),
    ]);
    expect(view.viewport.to, "the bullet starts below the viewport").toBeLessThan(bullet);
    expect(syntaxTree(view.state).length, "and past the tree in hand").toBeLessThan(bullet);
    expect(hits).toEqual([]);

    view.dispatch({ effects: EditorView.scrollIntoView(bullet) });
    expect(
      view.viewport.from <= bullet && bullet <= view.viewport.to,
      "the bullet scrolled into the viewport",
    ).toBe(true);
    expect(hits).toContain(bullet);
  });

  test("forces no parse when the tree in hand reaches past the viewport", () => {
    const { view, starts, strong } = longParagraphView();
    // The state's own parse, and none forced by the walker.
    expect(starts.mock.calls.length, "parses started at the mount").toBe(1);

    starts.mockClear();
    strong.length = 0;
    const key = view.state.doc.line(3).to;
    view.dispatch({ changes: { from: key, insert: "x" } });

    expect(starts.mock.calls.length, "parses started by the key").toBe(1);
    const { from, to } = view.viewport;
    expect(strong).toEqual(wholeParse(view.state.doc.toString(), "StrongEmphasis", from, to));
    expect(strong.length, "the viewport holds strong text").toBeGreaterThan(0);
  });

  test("decorates an edit that changes the block's kind at once, with no parse forced", () => {
    const { view, starts, strong, lists } = longParagraphView();
    starts.mockClear();
    strong.length = 0;
    // A list marker at the paragraph's first line makes the whole of it a
    // list item.
    view.dispatch({ changes: { from: 0, insert: "- " } });

    expect(starts.mock.calls.length, "parses started by the key").toBe(1);
    expect(lists).toEqual([0]);
    const { from, to } = view.viewport;
    expect(strong).toEqual(wholeParse(view.state.doc.toString(), "StrongEmphasis", from, to));
  });

  test("decorates a list marker typed mid-paragraph at once, though the state's parse stopped at it", () => {
    const { view, strong, lists } = longParagraphView();
    strong.length = 0;
    const marker = view.state.doc.line(5).from;
    view.dispatch({ changes: { from: marker, insert: "- " } });

    // The step that outlasts the update's budget takes the paragraph above
    // the marker, so the tree in hand ends where the list begins.
    expect(syntaxTree(view.state).length, "the tree in hand stops short of the viewport").toBeLessThan(
      view.viewport.to,
    );
    expect(lists).toEqual([marker]);
    const { from, to } = view.viewport;
    expect(strong).toEqual(wholeParse(view.state.doc.toString(), "StrongEmphasis", from, to));
  });
});
