// @vitest-environment jsdom
//
// The one predicate every widget write goes through, and the rule that a
// new widget cannot quietly skip it.
//
// The enumeration reads the directory rather than a fixed list: a widget
// module added tomorrow is covered the moment it lands, which is the point
// of asserting it here instead of in a review.

import { describe, expect, test } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isWidgetWritable } from "./writable";

// Vite resolves `import.meta.glob` statically, so it must be referenced by
// its full property path on a literal `import.meta`; the set is fixed at
// transform time, which is what makes a widget module added later show up
// here without anyone remembering to add it.
const MODULES = import.meta.glob("./*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function view(lock: Extension[]): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: "- [ ] task", extensions: lock }),
  });
}

/// Every widget module with its source, excluding the tests and the
/// predicate itself.
function widgetModules(): [string, string][] {
  return Object.entries(MODULES)
    .map(([path, source]): [string, string] => [path.replace("./", ""), source])
    .filter(([name]) => !name.endsWith(".test.ts") && name !== "writable.ts")
    .sort(([a], [b]) => a.localeCompare(b));
}

/// The source of every `dispatch(...)` call in `text`, by matching the
/// call's parentheses, so a multi-line transaction spec is read whole.
function dispatchCalls(text: string): string[] {
  const calls: string[] = [];
  const marker = ".dispatch(";
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + 1)) {
    let depth = 0;
    let end = at + marker.length - 1;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    calls.push(text.slice(at, end + 1));
  }
  return calls;
}

describe("the widget write predicate", () => {
  test("a view locked with the editable facet is not writable", () => {
    expect(isWidgetWritable(view([EditorView.editable.of(false)]))).toBe(false);
  });

  test("a view locked with state readOnly is not writable, editable or not", () => {
    expect(isWidgetWritable(view([EditorState.readOnly.of(true)]))).toBe(false);
    expect(
      isWidgetWritable(
        view([EditorState.readOnly.of(true), EditorView.editable.of(true)]),
      ),
    ).toBe(false);
  });

  test("an ordinary editor is writable", () => {
    expect(isWidgetWritable(view([]))).toBe(true);
  });
});

describe("every widget that writes asks the predicate", () => {
  test("a module dispatching a document change imports it", () => {
    const offenders = widgetModules()
      .filter(([, source]) =>
        dispatchCalls(source).some((call) => call.includes("changes:")),
      )
      .filter(([, source]) => !source.includes('from "./writable"'))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  test("the enumeration sees the modules that do write", () => {
    // A guard on the guard: if the scan stopped finding writes, the test
    // above would pass over an empty set and prove nothing.
    const writers = widgetModules()
      .filter(([, source]) =>
        dispatchCalls(source).some((call) => call.includes("changes:")),
      )
      .map(([name]) => name);
    expect(writers).toEqual(["checkbox.ts", "date.ts", "image.ts"]);
  });
});
