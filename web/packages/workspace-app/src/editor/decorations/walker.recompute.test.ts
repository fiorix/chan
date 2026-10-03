// @vitest-environment jsdom

// The walker recomputes when the async parse completes. @codemirror/language's
// ParseWorker publishes the finished tree through an effects-only dispatch
// that sets none of docChanged / viewportChanged / selectionSet /
// geometryChanged, so a gate keyed only on those would leave decorations
// stale (raw markers) until the next interaction. The walker recomputes on
// a change of syntax-tree identity.
//
// We observe the recompute by counting handler invocations: each
// computeDecorations pass walks the viewport once and calls the handler
// per matching node, so a fresh pass bumps the counter.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree, forceParsing } from "@codemirror/language";
import { describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { decorationWalker, type TokenContext } from "./walker";

describe("decoration walker recompute", () => {
  test("recomputes when an effects-only transaction swaps the tree", () => {
    let walks = 0;
    const walker = decorationWalker({
      Paragraph: (_ctx: TokenContext) => {
        walks++;
      },
    });
    // Large enough that the initial in-budget parse stops short of EOF, so
    // forceParsing genuinely advances and swaps the tree instance.
    const doc = "prose paragraph line\n".repeat(4000) + "tail paragraph";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [chanMarkdown(), walker] }),
    });

    const treeAtMount = syntaxTree(view.state);
    const walksAtMount = walks;
    expect(walksAtMount).toBeGreaterThan(0);

    // Completing the parse dispatches an effects-only empty transaction
    // carrying the finished tree. Only the tree-identity trigger catches it.
    forceParsing(view, view.state.doc.length, 5000);
    expect(syntaxTree(view.state)).not.toBe(treeAtMount);
    expect(walks).toBeGreaterThan(walksAtMount);

    view.destroy();
    parent.remove();
  });
});
