// @vitest-environment jsdom
//
// The image widget installs two document-level listeners the first time it
// renders in a view, and both close over that view. A document listener
// that outlives its view keeps the view, its state and its detached DOM
// alive and keeps answering events, and one that does not ask where the
// event came from answers for a view the user is not typing in.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { chanMarkdown } from "../markdown/grammar";
import { imageDecorations } from "./image";

const DOC = "![a](b.png)";

/// Document listeners of the two types the image widget installs, recorded
/// as (type, callback) pairs so a removal can be matched to its addition.
type Registration = [string, unknown];

const WATCHED = new Set(["mousedown", "keydown"]);

let added: Registration[] = [];
let removed: Registration[] = [];
const views: EditorView[] = [];
const hosts: HTMLElement[] = [];

function mount(doc = DOC): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [chanMarkdown(), imageDecorations({ getCurrentPath: () => null })],
    }),
    parent: host,
  });
  views.push(view);
  return view;
}

/// Document listeners this view installed and has not removed.
function outstanding(): Registration[] {
  const open = [...added];
  for (const [type, fn] of removed) {
    const i = open.findIndex(([t, f]) => t === type && f === fn);
    if (i >= 0) open.splice(i, 1);
  }
  return open;
}

beforeEach(() => {
  added = [];
  removed = [];
  vi.spyOn(document, "addEventListener").mockImplementation(function (
    this: Document,
    type: string,
    fn: unknown,
    opts?: unknown,
  ) {
    if (WATCHED.has(type)) added.push([type, fn]);
    return EventTarget.prototype.addEventListener.call(
      this,
      type,
      fn as EventListener,
      opts as AddEventListenerOptions,
    );
  } as typeof document.addEventListener);
  vi.spyOn(document, "removeEventListener").mockImplementation(function (
    this: Document,
    type: string,
    fn: unknown,
    opts?: unknown,
  ) {
    if (WATCHED.has(type)) removed.push([type, fn]);
    return EventTarget.prototype.removeEventListener.call(
      this,
      type,
      fn as EventListener,
      opts as EventListenerOptions,
    );
  } as typeof document.removeEventListener);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const view of views.splice(0)) view.destroy();
  for (const host of hosts.splice(0)) host.remove();
  document.body.innerHTML = "";
});

describe("the document listeners belong to their view", () => {
  test("a rendered image installs a click-outside and a key listener", () => {
    mount();
    expect(outstanding().map(([type]) => type).sort()).toEqual([
      "keydown",
      "mousedown",
    ]);
  });

  test("destroying the view removes them", () => {
    const view = mount();
    expect(outstanding()).toHaveLength(2);
    view.destroy();
    expect(outstanding()).toEqual([]);
  });

  test("a key in one view never moves another view's selection", () => {
    const a = mount();
    const b = mount();
    const wrap = a.dom.querySelector<HTMLElement>(".cm-md-image-wrap")!;
    wrap.dataset.selected = "true";
    const before = a.state.selection.main.head;
    b.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(a.state.selection.main.head).toBe(before);
    expect(wrap.dataset.selected).toBe("true");
  });
});
