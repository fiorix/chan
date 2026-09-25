import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { describe, expect, test } from "vitest";
import { codeSpanInternalTarget } from "./widgets/wikilink";
import { computeBubbleSpec } from "./bubbles/triggers";
import { chanMarkdown } from "./markdown/grammar";
import wikilink from "./widgets/wikilink.ts?raw";
import wysiwyg from "./Wysiwyg.svelte?raw";

/// A parsed (markdown) editor state with the caret at `pos`. ensureSyntaxTree
/// forces a synchronous parse so computeBubbleSpec's syntaxTree() lookup sees
/// the InlineCode / FencedCode nodes - no view mount, no DOM.
function stateAt(doc: string, pos: number): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor: pos },
    extensions: [chanMarkdown()],
  });
  ensureSyntaxTree(state, doc.length, 10000);
  return state;
}

// An inline `code` span whose text resolves to a real workspace file renders
// as a Cmd/Ctrl-clickable internal link (detect + open, single match).

describe("codeSpanInternalTarget (the detect decision)", () => {
  test("skips code containing whitespace (a snippet, not a path)", () => {
    expect(codeSpanInternalTarget("npm install", "notes/a.md")).toBeNull();
    expect(codeSpanInternalTarget("const x = 5", "notes/a.md")).toBeNull();
  });

  test("skips external / anchor-only / empty strings", () => {
    expect(codeSpanInternalTarget("http://example.com", "notes/a.md")).toBeNull();
    expect(codeSpanInternalTarget("#section", "notes/a.md")).toBeNull();
    expect(codeSpanInternalTarget("", "notes/a.md")).toBeNull();
  });

  test("resolves a bare stem against the editing file's directory", () => {
    expect(codeSpanInternalTarget("pasta", "notes/a.md")).toBe("notes/pasta");
  });

  test("resolves a workspace-rooted path (leading slash)", () => {
    expect(codeSpanInternalTarget("/guide", "notes/a.md")).toBe("guide");
  });

  test("resolves with no editing file (workspace-relative)", () => {
    expect(codeSpanInternalTarget("pasta", null)).toBe("pasta");
  });

  test("skips the current file by its stem (no self link)", () => {
    // `a` in notes/a.md normalizes to notes/a == the stem of the current file.
    expect(codeSpanInternalTarget("a", "notes/a.md")).toBeNull();
  });
});

describe("inline-code link decoration + open wiring", () => {
  test("decorates only a resolved real file, as a non-atomic data-carrying mark", () => {
    // The detect decoration and the in-place change trigger share ONE gate
    // (codeSpanInternalTarget + getKind === "file"), so both agree on which
    // spans are links.
    expect(wikilink).toMatch(/export function inlineCodeLinkTarget\(/);
    expect(wikilink).toMatch(/if \(getKind\(target\) !== "file"\) return null;/);
    expect(wikilink).toMatch(
      /const target = inlineCodeLinkTarget\(text, currentPath\);/,
    );
    expect(wikilink).toMatch(
      /class: "cm-md-code-link",\s*attributes: \{ "data-code-link-target": target \},/,
    );
    // Non-atomic: a Decoration.mark, never the atomic wiki-pill replace widget.
    expect(wikilink).toMatch(/function codeLinkMark\(target: string\): Decoration \{\s*return Decoration\.mark\(/);
  });

  test("the ViewPlugin re-runs on the shared kind-resolve broadcast", () => {
    expect(wikilink).toMatch(/export function inlineCodeLinkDecorations\(/);
    expect(wikilink).toMatch(
      /update\(u: ViewUpdate\): void \{[\s\S]*?e\.is\(kindResolvedEffect\)[\s\S]*?scanInlineCodeLinks\(u\.view/,
    );
  });

  test("Cmd/Ctrl-click opens via onWikiClick using the mark's data attribute", () => {
    expect(wikilink).toMatch(
      /export function inlineCodeLinkClickHandler\([\s\S]*?if \(!\(event\.metaKey \|\| event\.ctrlKey\)\) return false;[\s\S]*?closest\(\s*"\.cm-md-code-link",\s*\)[\s\S]*?dataset\.codeLinkTarget;[\s\S]*?opts\.onWikiClick\(\{/,
    );
  });

  test("Wysiwyg wires both the decorator and the Cmd/Ctrl-click opener", () => {
    expect(wysiwyg).toMatch(/inlineCodeLinkClickHandler\(\{\s*onWikiClick,/);
    expect(wysiwyg).toMatch(/inlineCodeLinkDecorations\(\{\s*onWikiClick,/);
  });

  test("Wysiwyg wires the inline-code change resolution gate", () => {
    expect(wysiwyg).toMatch(
      /isInlineCodeFileLink:\s*\(text, path\) =>\s*inlineCodeLinkTarget\(text, path\) !== null,/,
    );
  });
});

// Typing inside a recognized inline `code` file link opens the wiki picker in
// "code" mode so the target can be re-pointed in place. The picker only OPENS
// on a resolved file (the injected gate); once armed it stays open structurally
// while the user edits the token through non-resolving intermediates.
describe("inline-code link change carve-out (computeBubbleSpec)", () => {
  // `notes/foo` wrapped in backticks: backtick(0) content[1..10] backtick(10).
  const DOC = "`notes/foo`";

  test("an armed region opens a code-mode wiki spec over the token", () => {
    const spec = computeBubbleSpec(stateAt(DOC, 10), {
      getCurrentPath: () => "notes/a.md",
      armedInlineCode: { from: 1, to: 10 },
    });
    expect(spec).toMatchObject({
      kind: "wiki",
      triggerStart: 1,
      triggerEnd: 10,
      query: "notes/foo",
      templateMode: "code",
      origin: "inline-code",
    });
  });

  test("the query is the token up to the caret while editing inside", () => {
    const spec = computeBubbleSpec(stateAt(DOC, 4), {
      armedInlineCode: { from: 1, to: 10 },
    });
    expect(spec?.origin).toBe("inline-code");
    expect(spec?.query).toBe("not");
  });

  test("opens fresh only when the token resolves to a real file", () => {
    // A snippet (gate false) stays plain code; a real file (gate true) arms it.
    const snippet = computeBubbleSpec(stateAt("`npm`", 4), {
      isInlineCodeFileLink: () => false,
    });
    expect(snippet).toBeNull();
    const fileLink = computeBubbleSpec(stateAt(DOC, 10), {
      getCurrentPath: () => "notes/a.md",
      isInlineCodeFileLink: () => true,
    });
    expect(fileLink?.origin).toBe("inline-code");
  });

  test("a whitespace token (a code snippet) never arms the picker", () => {
    const spec = computeBubbleSpec(stateAt("`a b`", 4), {
      armedInlineCode: { from: 1, to: 4 },
      isInlineCodeFileLink: () => true,
    });
    expect(spec).toBeNull();
  });

  test("a fenced code block stays skipped (no change picker)", () => {
    const spec = computeBubbleSpec(stateAt("```\nnotes/foo\n```", 6), {
      armedInlineCode: { from: 4, to: 13 },
      isInlineCodeFileLink: () => true,
    });
    expect(spec).toBeNull();
  });
});
