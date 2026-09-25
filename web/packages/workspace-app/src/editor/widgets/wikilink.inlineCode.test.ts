// @vitest-environment jsdom
//
// An inline `code` span whose text names a real workspace file is a
// Cmd/Ctrl-clickable internal link, and typing inside it re-points the target
// through the wiki picker. The detect decision and the picker's trigger are
// pure; the decoration, the click and the picker are driven in a mounted
// Wysiwyg editor with the link resolver stubbed.

import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const files = vi.hoisted(() => ({ existing: new Set<string>() }));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      resolveLink: vi.fn(async (target: string) => {
        if (!files.existing.has(target)) throw new Error("404 not found");
        return { path: target, kind: "file", is_dir: false };
      }),
    },
  };
});

import { codeSpanInternalTarget } from "./wikilink";
import { computeBubbleSpec } from "../bubbles/triggers";
import { chanMarkdown } from "../markdown/grammar";
import { installEditorDom, mountWysiwyg, settle, unmountWysiwygs } from "../../__tests__/wysiwyg";

installEditorDom();

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

describe("in the Wysiwyg editor", () => {
  const DOC = "see `pasta` and `npm install` and `gone`";

  beforeEach(() => {
    // The resolver caches each target's kind for the life of the module, so
    // every test serves the same files.
    files.existing = new Set(["notes/pasta"]);
  });

  afterEach(() => {
    unmountWysiwygs();
    document.body.innerHTML = "";
  });

  async function editor(onWikiClick = vi.fn()) {
    const mounted = await mountWysiwyg({ value: DOC, currentPath: "notes/a.md", onWikiClick });
    await settle(6);
    return { ...mounted, onWikiClick };
  }

  function links(root: HTMLElement): HTMLElement[] {
    return [...root.querySelectorAll<HTMLElement>(".cm-md-code-link")];
  }

  test("a span naming a real file becomes an editable link; a snippet or a missing file stays plain", async () => {
    const { content } = await editor();
    const found = links(content);
    expect(found.map((el) => [el.textContent, el.dataset.codeLinkTarget])).toEqual([["pasta", "notes/pasta"]]);
    expect(found[0]!.closest("[contenteditable='false']"), "a mark over the text, not a widget").toBeNull();
  });

  test("Cmd- or Ctrl-click opens it through onWikiClick; a plain click does not", async () => {
    const { content, onWikiClick } = await editor();
    const link = links(content)[0]!;
    const down = (init: MouseEventInit) =>
      link.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, ...init }));

    down({});
    expect(onWikiClick).not.toHaveBeenCalled();
    down({ ctrlKey: true });
    down({ metaKey: true });
    expect(onWikiClick).toHaveBeenCalledTimes(2);
    expect(onWikiClick).toHaveBeenLastCalledWith({
      target: "notes/pasta",
      label: "notes/pasta",
      anchor: "",
      wasAbs: false,
      openInNewPane: false,
    });
  });

  test("the caret inside the link opens the wiki picker; inside a snippet it does not", async () => {
    const { view } = await editor();
    view.dispatch({ selection: { anchor: DOC.indexOf("npm") + 2 } });
    await settle();
    expect(document.body.querySelector(".md-wiki-bubble")).toBeNull();

    view.dispatch({ selection: { anchor: DOC.indexOf("pasta") + 2 } });
    await settle();
    expect(document.body.querySelector(".md-wiki-bubble")).not.toBeNull();
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
