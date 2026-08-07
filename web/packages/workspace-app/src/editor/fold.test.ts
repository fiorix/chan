// @vitest-environment jsdom
//
// Heading detection for the WYSIWYG fold gutter comes from the lezer syntax
// tree: a line is a heading iff the tree resolves it to ATXHeading1..6. The
// gutter marker, the fold service, and the gutter click all read the same two
// helpers (`headingLevelAt`, `headingFoldRange`), so these tests exercise the
// real decision directly rather than through `foldable()`, which also reports
// the markdown language's own foldNodeProp folding of fenced blocks and would
// conflate the two sources. Fenced code, tilde fences, indented fences, inline
// code and frontmatter must never be a heading; a real heading must, and its
// fold range must not be truncated by a fenced `#` comment.

import foldSrc from "./fold.ts?raw";
import formatSrc from "./commands/format.ts?raw";
import slidesSrc from "./slides.ts?raw";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "./markdown/grammar";
import { headingLevelAt, headingFoldRange } from "./fold";
import { setBlockKind, toggleBulletList } from "./commands/format";
import { firstSlideHeadingCaret } from "./slides";

function mkState(doc: string, parse = true): EditorState {
  const state = EditorState.create({ doc, extensions: [chanMarkdown()] });
  if (parse) ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/// 1-based number of the first line whose text exactly equals `text`.
function lineOf(state: EditorState, text: string): number {
  for (let n = 1; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text === text) return n;
  }
  throw new Error(`no line equal to ${JSON.stringify(text)}`);
}

/// The heading level the tree assigns to the line with the given text.
function levelOf(state: EditorState, text: string): number {
  return headingLevelAt(state, state.doc.line(lineOf(state, text)).from);
}

/// The fold range for the heading on the line with the given text. `budget`
/// passes through to the helper's parse budget when given.
function rangeOf(
  state: EditorState,
  text: string,
  budget?: number,
): { from: number; to: number } | "incomplete" | null {
  const line = state.doc.line(lineOf(state, text));
  return budget === undefined
    ? headingFoldRange(state, line.from)
    : headingFoldRange(state, line.from, budget);
}

/// Narrow a rangeOf result to a real range, failing the test otherwise.
function realRange(
  r: { from: number; to: number } | "incomplete" | null,
): { from: number; to: number } {
  expect(r).not.toBeNull();
  expect(r).not.toBe("incomplete");
  return r as { from: number; to: number };
}

function mkView(doc: string, selHead: number): { view: EditorView; parent: HTMLElement } {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: selHead },
      extensions: [chanMarkdown()],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return { view, parent };
}

describe("fold gutter: heading detection from the syntax tree", () => {
  test("1. a fenced `#` comment is not a heading; a real heading is", () => {
    const doc = ["# Real Heading", "", "```bash", "# install deps", "```"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "# install deps")).toBe(0);
    expect(levelOf(state, "# Real Heading")).toBe(1);
  });

  test("2. a `#` in a tilde fence is not a heading", () => {
    const doc = ["# Real Heading", "", "~~~bash", "# install deps", "~~~"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "# install deps")).toBe(0);
    expect(levelOf(state, "# Real Heading")).toBe(1);
  });

  test("3. a `#` inside an indented fence is not a heading, at either indentation", () => {
    // A top-level fence indented two spaces: a column-0 `#` inside it stays
    // fenced content. (Inside a LIST item a column-0 line would instead dedent
    // out of the list and become a real heading, per CommonMark.)
    const doc = ["intro", "  ```bash", "  # comment", "# comment col0", "  ```"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "  # comment")).toBe(0);
    expect(levelOf(state, "# comment col0")).toBe(0);
  });

  test("4. a `#` inside an inline code span is not a heading", () => {
    const doc = ["intro", "`# not a heading`", "outro"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "`# not a heading`")).toBe(0);
  });

  test("5. a frontmatter `#` comment is not a heading", () => {
    const doc = ["---", "# deck config", "chan:", "  kind: slides", "---", "# Title"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "# deck config")).toBe(0);
    expect(levelOf(state, "# Title")).toBe(1);
  });

  test("6. shebangs, spaceless `#`, and seven hashes are not headings", () => {
    const doc = [
      "#!/bin/bash",
      "#!/usr/bin/env bash",
      "#foo",
      "#",
      "####### seven",
      "```",
      "#!/bin/bash",
      "#foo",
      "```",
    ].join("\n");
    const state = mkState(doc);
    for (const t of ["#!/bin/bash", "#!/usr/bin/env bash", "#foo", "#", "####### seven"]) {
      expect(levelOf(state, t)).toBe(0);
    }
  });

  test("7. a real `#`/`##` heading in prose is a heading at its level", () => {
    const doc = ["# Real Heading", "body", "## Sub", "more"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "# Real Heading")).toBe(1);
    expect(levelOf(state, "## Sub")).toBe(2);
  });

  test("indented ATX headings up to three spaces now fold (recorded decision)", () => {
    const doc = ["  ## Indented", "body", "## Next"].join("\n");
    const state = mkState(doc);
    expect(levelOf(state, "  ## Indented")).toBe(2);
  });

  test("8. a real heading's fold is not truncated by a fenced `#` comment", () => {
    const doc = [
      "## Setup",
      "prose",
      "```bash",
      "# install deps",
      "```",
      "more prose",
      "## Next",
    ].join("\n");
    const state = mkState(doc);
    const range = realRange(rangeOf(state, "## Setup"));
    const next = state.doc.line(lineOf(state, "## Next"));
    expect(range.to).toBe(next.from - 1);
  });

  test("10. the doc-end fallback survives; a heading on the last line yields null", () => {
    const s1 = mkState(["intro", "## Last", "body line", "final body"].join("\n"));
    const r = realRange(rangeOf(s1, "## Last"));
    expect(r.to).toBe(s1.doc.length);
    // Completeness of the parse, not the size of the budget, is what admits
    // the doc-end fallback: with a zero budget on this fully parsed doc the
    // genuine last-section fold still comes back.
    expect(realRange(rangeOf(s1, "## Last", 0)).to).toBe(s1.doc.length);

    const s2 = mkState(["# Body", "text", "## OnLastLine"].join("\n"));
    expect(rangeOf(s2, "## OnLastLine")).toBeNull();
  });

  // The 4000-line filler puts `## Bottom` far past the initial in-budget
  // parse (which never covers more than the first 3000 characters at state
  // creation), so both cases below genuinely exercise the helper against an
  // unparsed tail rather than a warm tree.
  const FAR_TERMINATOR_DOC = `## Top\n${"prose paragraph line\n".repeat(4000)}## Bottom\ntail body`;

  test("11. a fold range reaches its terminator past the lazy-parse viewport", () => {
    // Do NOT pre-parse the whole doc: the helper must force the parse itself.
    // The budget is one it cannot exhaust on a document this size, so the
    // forced parse deterministically reaches the terminator; wall-clock load
    // can slow the run but cannot change the outcome.
    const state = mkState(FAR_TERMINATOR_DOC, false);
    const range = realRange(rangeOf(state, "## Top", 60_000));
    const bottom = state.doc.line(lineOf(state, "## Bottom"));
    expect(range.to).toBe(bottom.from - 1);
  });

  test("11b. an exhausted parse reports incomplete, never a doc-end range", () => {
    // A zero budget answers from the lazily parsed prefix only, which cannot
    // reach `## Bottom`; the helper must say so instead of returning the
    // doc-end fallback, which would be indistinguishable from a real
    // last-section fold and would swallow the unparsed sections.
    const state = mkState(FAR_TERMINATOR_DOC, false);
    expect(rangeOf(state, "## Top", 0)).toBe("incomplete");
  });
});

describe("formatting chords leave fenced comments alone", () => {
  test("12. bullet and h2 chords no-op inside a fence, still rewrite a real heading", () => {
    const doc = ["# Real Heading", "", "```bash", "# install deps", "```"].join("\n");

    const fencedHead = doc.indexOf("# install deps") + 2;
    for (const chord of [
      (v: EditorView) => setBlockKind(v, "h2"),
      (v: EditorView) => toggleBulletList(v),
    ]) {
      const { view, parent } = mkView(doc, fencedHead);
      const before = view.state.doc.toString();
      chord(view);
      expect(view.state.doc.toString()).toBe(before);
      view.destroy();
      parent.remove();
    }

    const realHead = doc.indexOf("# Real Heading") + 2;
    {
      const { view, parent } = mkView(doc, realHead);
      setBlockKind(view, "h2");
      expect(view.state.doc.lineAt(realHead).text).toBe("## Real Heading");
      view.destroy();
      parent.remove();
    }
    {
      const { view, parent } = mkView(doc, realHead);
      toggleBulletList(view);
      expect(view.state.doc.lineAt(realHead).text.startsWith("- ")).toBe(true);
      view.destroy();
      parent.remove();
    }
  });
});

describe("firstSlideHeadingCaret skips a fenced comment", () => {
  test("13. the caret lands on the real title, not a fenced `#`", () => {
    const source = [
      "---",
      "chan:",
      "  kind: slides",
      "---",
      "```",
      "# not a title",
      "```",
      "# Slide 1",
      "body",
    ].join("\n");
    const caret = firstSlideHeadingCaret(source);
    expect(caret).toBe(source.indexOf("# Slide 1") + "# Slide 1".length);
  });
});

describe("structural guarantees (source pins)", () => {
  test("fold.ts decides headings from the tree, not a raw-line regex", () => {
    expect(foldSrc).not.toMatch(/HEADING_RE/);
    expect(foldSrc).toMatch(/ATXHeading/);
  });

  test("9. the service and the click handler share one fold-range walk", () => {
    const calls = foldSrc.match(/headingFoldRange\(/g) ?? [];
    // definition + service call + click call
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  test("11 (pin). the forward walk forces the parse past the viewport", () => {
    expect(foldSrc).toMatch(/ensureSyntaxTree\(/);
  });

  test("11b (pin). both consumers map incomplete to no fold", () => {
    // The service adapter (foldService's contract is `{from,to} | null`) and
    // the gutter click must both refuse to fold on an incomplete answer.
    expect(foldSrc).toMatch(/range === "incomplete" \? null : range/);
    expect(foldSrc).toMatch(/range === "incomplete" \|\| !range/);
  });

  test("12 (pin). both formatting chords guard on a code node", () => {
    const guards = formatSrc.match(/caretInsideCode\(/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  test("13 (pin). firstSlideHeadingCaret tracks fences", () => {
    expect(slidesSrc).toMatch(/inFence/);
  });
});
