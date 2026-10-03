// @vitest-environment jsdom
//
// Targeted coverage for the fenced-code escape behavior. The trap
// these tests guard against: pressing ArrowDown / Mod-Enter at the
// last line of an unclosed fenced block at doc end appends an empty
// `\n`, but the new line still belongs to the (still-unclosed)
// fence, so the user can never get out - every keypress just grows
// the file with no escape.

import { describe, expect, test, afterEach, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { chanMarkdown } from "../markdown/grammar";
import { escapeFenceAtDocEnd, exitFenceAnywhere, toggleLink } from "./format";
import * as store from "../../state/store.svelte";

let host: HTMLDivElement;
let view: EditorView;

function mount(doc: string, caret: number): void {
  host = document.createElement("div");
  document.body.append(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caret },
      extensions: [chanMarkdown()],
    }),
    parent: host,
  });
  // Force a full parse so syntaxTree() returns a populated tree
  // synchronously inside the command. CM6 normally parses lazily as
  // the user types; in jsdom we don't get those incremental ticks.
  forceParsing(view, view.state.doc.length, 5000);
}

afterEach(() => {
  view?.destroy();
  host?.remove();
});

describe("escapeFenceAtDocEnd", () => {
  test("closed fence at doc end: caret on closer escapes with one extra newline", () => {
    const doc = "```\nfoo\n```";
    mount(doc, doc.length);
    expect(escapeFenceAtDocEnd(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nfoo\n```\n");
    // Caret on the new empty line.
    expect(view.state.selection.main.head).toBe(doc.length + 1);
  });

  test("unclosed fence at doc end: caret on last body line inserts a closer + new line", () => {
    const doc = "```\nfoo";
    mount(doc, doc.length);
    expect(escapeFenceAtDocEnd(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```\nfoo\n```\n");
    // Caret should land OUTSIDE the fence on the new empty line.
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  test("unclosed fence with language tag: closer is always plain ```", () => {
    const doc = "```python\nhello";
    mount(doc, doc.length);
    expect(escapeFenceAtDocEnd(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```python\nhello\n```\n");
  });

  test("not in a fence: returns false (key falls through)", () => {
    const doc = "hello world";
    mount(doc, doc.length);
    expect(escapeFenceAtDocEnd(view)).toBe(false);
    expect(view.state.doc.toString()).toBe("hello world");
  });

  test("caret on a body line that is not the doc's last line: falls through", () => {
    const doc = "```\nfoo\nbar\n```";
    mount(doc, 5); // caret on `foo`
    expect(escapeFenceAtDocEnd(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  test("regression: caret at start of closer line escapes (```sh / asdf / ```)", () => {
    // Caret at the very start of the closer line - the position
    // a user is in after typing the closer and clicking back into
    // it.
    const doc = "```sh\nasdf\n```";
    const closerLineStart = "```sh\nasdf\n".length;
    mount(doc, closerLineStart);
    expect(escapeFenceAtDocEnd(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```sh\nasdf\n```\n");
  });
});

describe("exitFenceAnywhere (Mod-Enter from inside any fenced block)", () => {
  test("closed fence at doc end, caret on body: appends a new line past the closer", () => {
    const doc = "```sh\nasdf\n```";
    mount(doc, "```sh\n".length); // caret at start of `asdf`
    expect(exitFenceAnywhere(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```sh\nasdf\n```\n");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  test("closed fence at doc end, caret on the closer line: still escapes (the user-reported case)", () => {
    const doc = "```sh\nasdf\n```";
    mount(doc, "```sh\nasdf\n".length); // caret at start of closer line
    expect(exitFenceAnywhere(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```sh\nasdf\n```\n");
  });

  test("closed fence MID-doc: appends a new line right after the closer", () => {
    const doc = "before\n```\nfoo\n```\nafter";
    mount(doc, "before\n```\n".length); // caret on `foo`
    expect(exitFenceAnywhere(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("before\n```\nfoo\n```\n\nafter");
  });

  test("unclosed fence at doc end: inserts closer + blank line", () => {
    const doc = "```python\nhello";
    mount(doc, doc.length);
    expect(exitFenceAnywhere(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```python\nhello\n```\n");
  });

  test("not inside a fence: returns false so Mod-Enter falls through", () => {
    const doc = "hello world";
    mount(doc, doc.length);
    expect(exitFenceAnywhere(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(doc);
  });

  test("caret on opener line of an unclosed fence: still escapes", () => {
    const doc = "```sh\nfoo\nbar";
    mount(doc, 3); // caret right after `\`\`\``
    expect(exitFenceAnywhere(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("```sh\nfoo\nbar\n```\n");
  });

  test("returns false on a non-empty selection (no accidental escape during drag-select)", () => {
    const doc = "```\nfoo\n```";
    mount(doc, 4);
    view.dispatch({ selection: { anchor: 4, head: 7 } });
    expect(exitFenceAnywhere(view)).toBe(false);
  });
});

describe("toggleLink prompts via the in-house modal, never window.prompt", () => {
  test("inserts the URL the in-house prompt resolves with", async () => {
    const doc = "hello world";
    mount(doc, 0);
    view.dispatch({ selection: { anchor: 0, head: 5 } }); // select "hello"
    const promptSpy = vi.spyOn(window, "prompt");
    const uiPromptSpy = vi
      .spyOn(store, "uiPrompt")
      .mockResolvedValue("https://example.com");

    await toggleLink(view);

    expect(promptSpy).not.toHaveBeenCalled();
    expect(uiPromptSpy).toHaveBeenCalledWith("URL");
    expect(view.state.doc.toString()).toBe("[hello](https://example.com) world");

    uiPromptSpy.mockRestore();
    promptSpy.mockRestore();
  });

  test("no-ops cleanly when the user cancels the in-house prompt", async () => {
    const doc = "hello";
    mount(doc, doc.length);
    const promptSpy = vi.spyOn(window, "prompt");
    const uiPromptSpy = vi.spyOn(store, "uiPrompt").mockResolvedValue(null);

    await toggleLink(view);

    expect(promptSpy).not.toHaveBeenCalled();
    expect(uiPromptSpy).toHaveBeenCalled();
    // Doc unchanged on cancel.
    expect(view.state.doc.toString()).toBe("hello");

    uiPromptSpy.mockRestore();
    promptSpy.mockRestore();
  });
});
