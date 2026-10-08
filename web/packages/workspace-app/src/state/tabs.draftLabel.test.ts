// A draft's tab label. Two tabs that share a file name are told apart by
// their directories, and a draft's directory component holds the mark and
// the lifetime id; the label is built from the display path instead.

import { expect, test } from "vitest";

import { draftClientPath } from "../api/fileIdentity";
import { fileTab } from "../__tests__/tabs";
import { tabLabel, tabLabelInPane } from "./tabs.svelte";

const MARK = String.fromCharCode(0);

function draftTab(name: string, id: string) {
  return fileTab({ path: draftClientPath({ path: `${name}/draft.md`, draft_id: id }) });
}

test("a lone draft's label is its file name", () => {
  const draft = draftTab("untitled", "v1:abc");

  expect(tabLabel(draft), "the plain label").toBe("draft.md");
  expect(tabLabelInPane(draft, [draft]), "alone in its pane").toBe("draft.md");
});

test("two drafts that share a file name are told apart by their names", () => {
  const first = draftTab("untitled", "v1:abc");
  const second = draftTab("untitled-2", "v1:def");
  const tabs = [first, second];

  const labels = tabs.map((t) => tabLabelInPane(t, tabs));

  expect(labels.some((label) => label.includes(MARK)), "the mark in a label").toBe(false);
  expect(labels.some((label) => /abc|def/.test(label)), "a lifetime id in a label").toBe(false);
  expect(labels, "the labels").toEqual(["untitled/draft.md", "untitled-2/draft.md"]);
});

test("a draft beside a workspace file of the same name reads as a draft", () => {
  const draft = draftTab("untitled", "v1:abc");
  const note = fileTab({ path: "notes/draft.md" });
  const tabs = [draft, note];

  expect(tabLabelInPane(draft, tabs), "the draft").toBe("Drafts/[...]/draft.md");
  expect(tabLabelInPane(note, tabs), "the workspace file").toBe("notes/draft.md");
});

test("two lifetimes of one draft name show the same display path", () => {
  const old = draftTab("untitled", "v1:abc");
  const current = draftTab("untitled", "v1:def");
  const tabs = [old, current];

  expect(
    tabs.map((t) => tabLabelInPane(t, tabs)),
    "the labels",
  ).toEqual(["Drafts/untitled/draft.md", "Drafts/untitled/draft.md"]);
});
