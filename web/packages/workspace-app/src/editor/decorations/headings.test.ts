// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, test } from "vitest";
import { chanMarkdown } from "../markdown/grammar";
import { chanDecorations } from ".";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
});

function decoratedLine(doc: string, lineNumber: number): HTMLElement {
  const parent = document.body.appendChild(document.createElement("div"));
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, extensions: [chanMarkdown(), chanDecorations()] }),
  });
  views.push(view);
  expect(view.state.doc.toString()).toBe(doc);
  const line = parent.querySelectorAll<HTMLElement>(".cm-line")[lineNumber - 1];
  if (!line) throw new Error(`line ${lineNumber} was not rendered`);
  return line;
}

function headingClass(line: HTMLElement): string | undefined {
  return [...line.classList].find((name) => /^cm-md-h[1-6]$/.test(name));
}

describe("heading line decorations", () => {
  test.each(["4. #", "1. # foo", "- # foo", "- ## foo", "> # foo", "> ### foo", "> #"])(
    "keeps %s at body size with its hash visible",
    (source) => {
      const line = decoratedLine(`plain\n\n${source}`, 3);
      expect(headingClass(line)).toBeUndefined();
      expect(line.textContent).toContain("#");
    },
  );

  test.each(["#", "###", "#   "])("keeps an empty %s heading at body size", (source) => {
    const line = decoratedLine(`plain\n${source}`, 2);
    expect(headingClass(line)).toBeUndefined();
    expect(line.textContent).toContain("#");
  });

  test("styles a top-level heading", () => {
    const line = decoratedLine("plain\n# foo", 2);
    expect(headingClass(line)).toBe("cm-md-h1");
  });

  test.each([
    ["fenced", "plain\n```\n# foo\n```", 3],
    ["indented", "plain\n\n    # foo", 3],
  ])("keeps %s code out of heading styling", (_name, doc, lineNumber) => {
    const line = decoratedLine(doc, lineNumber);
    expect(headingClass(line)).toBeUndefined();
    expect(line.textContent).toContain("# foo");
  });
});
