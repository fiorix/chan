// @vitest-environment jsdom
//
// The wiki link bubble: `[[query` lists the graph's link targets (files and
// headings) beside workspace paths completed from the file tree, `#` switches
// to a target's headings and `^` to its blocks, and a commit writes relative
// markdown, or a wiki link in a file that already uses them. Inside an
// existing `[label](url)` slot it searches the URL's basename, fills the slot
// with a bare path, and offers to open the link already there.

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import type { LinkTarget, TreeEntry } from "../../api/types";
import { openWikiBubble, type WikiBubbleOpts } from "./wiki";
import { json, recordRequests, stopRecordingRequests } from "../../__tests__/fetch";

// CodeMirror measures text ranges to place the bubble; jsdom has no layout.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

function target(path: string, over: Partial<LinkTarget> = {}): LinkTarget {
  return { kind: "File", path, title: null, heading: null, anchor: null, level: null, mtime: 1, ...over };
}

function entry(path: string): TreeEntry {
  return { path, is_dir: false, mtime: 1, size: 1 } as TreeEntry;
}

let views: EditorView[] = [];

beforeEach(() => {
  vi.spyOn(api, "linkTargets").mockResolvedValue([]);
  vi.spyOn(api, "list").mockResolvedValue([]);
});

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/// Open the bubble over `doc`, triggered by the text from `start` to the end.
function open(doc: string, start: number, over: Partial<WikiBubbleOpts> = {}) {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ state: EditorState.create({ doc }), parent });
  views.push(view);
  const handle = openWikiBubble({
    view,
    triggerStart: start,
    triggerEnd: doc.length,
    initialQuery: doc.slice(start).replace(/^\[\[/, ""),
    prefix: null,
    fromPath: "notes/here.md",
    onDismiss: () => {},
    ...over,
  });
  const key = (key: string, init: KeyboardEventInit = {}) =>
    handle.handleKey(new KeyboardEvent("keydown", { key, ...init }));
  return { view, handle, key };
}

function rows(): string[] {
  return [...document.querySelectorAll(".md-bubble-row")].map((row) => row.textContent ?? "");
}

function selectedRow(): number {
  return [...document.querySelectorAll(".md-bubble-row")].findIndex((row) =>
    row.classList.contains("md-bubble-row-selected"),
  );
}

describe("the link-target search", () => {
  test("is a GET of /api/link-targets with the query and a limit", async () => {
    vi.mocked(api.linkTargets).mockRestore();
    const hits = [target("notes/other.md")];
    const requests = recordRequests(() => json(hits));
    try {
      await expect(api.linkTargets("oth", 5)).resolves.toEqual(hits);
    } finally {
      stopRecordingRequests();
    }
    expect(requests).toMatchObject([{ method: "GET", path: "/api/link-targets" }]);
    expect(Object.fromEntries(requests[0]!.query)).toMatchObject({ q: "oth", limit: "5" });
  });
});

describe("the file picker", () => {
  test("lists the graph's link targets for the query, five at a time", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([
      target("notes/other.md", { title: "Other" }),
      target("notes/other.md", { kind: "Heading", heading: "Intro", anchor: "intro", level: 2 }),
    ]);
    open("see [[oth", 4);

    await vi.waitFor(() => expect(rows()).toEqual(["Other - notes/other.md", "H2Intro notes/other.md"]));
    expect(api.linkTargets).toHaveBeenCalledWith("oth", 5);
  });

  test("completes workspace paths beside the names, once per file", async () => {
    vi.mocked(api.list).mockResolvedValue([entry("docs/a.md"), entry("docs/b.md"), entry("notes/n.md")]);
    vi.mocked(api.linkTargets).mockResolvedValue([target("docs/a.md")]);
    open("[[docs/", 0);

    await vi.waitFor(() => expect(rows()).toEqual(["docs/a.md", "PATHdocs/b.md"]));
  });

  test("keeps the selection on a path row when the named results arrive after it", async () => {
    let answer: (hits: LinkTarget[]) => void = () => {};
    vi.mocked(api.linkTargets).mockReturnValue(new Promise((resolve) => (answer = resolve)));
    vi.mocked(api.list).mockResolvedValue([entry("docs/a.md"), entry("docs/b.md")]);
    const { key } = open("[[docs/", 0);
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    key("ArrowDown");
    answer([target("notes/docs.md")]);

    await vi.waitFor(() => expect(rows()).toHaveLength(3));
    expect(selectedRow()).toBe(1);
  });

  test("a pick writes a relative markdown link from the file being edited", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([target("notes/other.md")]);
    const { view, key } = open("see [[oth", 4);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    key("Enter");

    expect(view.state.doc.toString()).toBe("see [other](./other.md)");
  });

  test("a heading pick links to its anchor", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([
      target("docs/a b.md", { kind: "Heading", heading: "Intro", anchor: "intro", level: 2 }),
    ]);
    const { view, key } = open("see [[intr", 4);
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    key("Enter");

    expect(view.state.doc.toString()).toBe("see [a b](../docs/a%20b.md#intro)");
  });

  test("a file that already uses wiki links gets a wiki link", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([
      target("notes/other.md", { kind: "Heading", heading: "Intro", anchor: "intro", level: 2 }),
    ]);
    const doc = "[[old]] see [[intr";
    const { view, key } = open(doc, doc.indexOf("[[intr"));
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    key("Enter");

    expect(view.state.doc.toString()).toBe("[[old]] see [[notes/other.md#intro]]");
  });
});

describe("the heading and block pickers", () => {
  test("# lists the target's headings and links to the one picked", async () => {
    vi.spyOn(api, "headings").mockResolvedValue([
      { level: 1, text: "Other", anchor: "other" },
      { level: 2, text: "Intro", anchor: "intro" },
    ] as never);
    const { view, key } = open("see [[notes/other.md#int", 4);

    await vi.waitFor(() => expect(rows()).toEqual(["H2Intro"]));
    expect(api.headings).toHaveBeenCalledWith("notes/other.md");
    key("Enter");
    expect(view.state.doc.toString()).toBe("see [other](./other.md#intro)");
  });

  test("^ lists the target's blocks and anchors the one picked before linking it", async () => {
    vi.spyOn(api, "read").mockResolvedValue({
      path: "notes/other.md",
      content: "First paragraph.\n\nSecond paragraph.\n",
      mtime: 1,
      mtime_ns: "1",
      authority_version: 1,
    } as never);
    const write = vi.spyOn(api, "write").mockResolvedValue({ mtime: 2 } as never);
    const { view, key } = open("see [[notes/other.md^Second", 4);

    await vi.waitFor(() => expect(rows()).toEqual(["BLKSecond paragraph."]));
    key("Enter");

    await vi.waitFor(() => expect(view.state.doc.toString()).toMatch(/^see \[other\]\(\.\/other\.md#\^[\w-]+\)$/));
    const id = /#\^([\w-]+)\)$/.exec(view.state.doc.toString())![1];
    expect(write).toHaveBeenCalledWith(
      "notes/other.md",
      `First paragraph.\n\nSecond paragraph. ^${id}\n`,
      "1",
      1,
      1,
    );
  });
});

describe("inside an existing link's URL", () => {
  const doc = "see [x](../../team-x/bootstrap.md#setup)";
  const start = doc.indexOf("../");

  test("searches the linked file's basename, not the verbatim path", async () => {
    open(doc, start, { templateMode: "raw", initialQuery: doc.slice(start, -1) });

    await vi.waitFor(() => expect(api.linkTargets).toHaveBeenCalledWith("bootstrap.md", 5));
  });

  test("a pick fills the slot with a bare relative path", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([target("notes/other.md")]);
    const slot = "see [x](old.md";
    const at = slot.indexOf("old.md");
    const { view, key } = open(slot, at, { templateMode: "raw", initialQuery: "old.md" });
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    key("Enter");

    expect(view.state.doc.toString()).toBe("see [x](./other.md");
  });

  test("offers to open the link already there, and opening it leaves the text alone", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([target("notes/other.md")]);
    const onOpenLink = vi.fn();
    const slot = "see [x](other.md#intro";
    const at = slot.indexOf("other.md");
    const { view, key } = open(slot, at, { templateMode: "raw", initialQuery: "other.md#intro", onOpenLink });
    await vi.waitFor(() => expect(rows()).toEqual(["OPENother.md#intro", "notes/other.md"]));
    key("Enter");

    expect(onOpenLink).toHaveBeenCalledWith("notes/other.md", "intro");
    expect(view.state.doc.toString()).toBe(slot);
  });

  test("Mod+Enter opens the selected row instead of filling the slot", async () => {
    vi.mocked(api.linkTargets).mockResolvedValue([target("notes/other.md")]);
    const onOpenLink = vi.fn();
    const slot = "see [x](other.md";
    const at = slot.indexOf("other.md");
    const { view, key } = open(slot, at, { templateMode: "raw", initialQuery: "other.md", onOpenLink });
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    key("ArrowDown");
    key("Enter", { ctrlKey: true });

    expect(onOpenLink).toHaveBeenCalledWith("notes/other.md", null);
    expect(view.state.doc.toString()).toBe(slot);
  });
});
